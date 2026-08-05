import crypto from 'crypto';
import Razorpay from 'razorpay';
import jwt from 'jsonwebtoken';
import { hashPII, extractIP, setCorsHeaders, assertJwtSecretConfigured } from './security-utils.js';
import { withTimeout } from '../lib/timeout.js';
import { findAvailableNurses } from '../lib/queries.js';
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { createClient } from '@supabase/supabase-js';
import { makeLogger, captureException } from '../lib/logger.js';
import {
  sendNewBookingAlert,
  sendCallbackAlert, sendApplicationReceived,
  sendPatientReceipt, sendNurseDispatchRequest, scrubbedLocation
} from '../lib/email.js';

const REQUIRED_ENV = [
  'ALLOWED_ORIGIN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'RESEND_API_KEY', 'ADMIN_EMAIL', 'SENDER_EMAIL', 'JWT_SECRET'
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) throw new Error(`[submit] FATAL: missing ${key}`);
}

// Unified startup guard: JWT_SECRET must exist and be at least 32 chars.
assertJwtSecretConfigured();

const EXPECTED_BOOKING_FEE_PAISE = 50000;
const SUPPORTED_TYPES = ['booking', 'callback', 'application'];

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const limiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, '5 m'),
});

// Supabase client (service role key bypasses RLS — server-side only)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const sanitize = str => typeof str !== 'string' ? '' : str.replace(/[<>"'&]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' })[c]).trim();

const log = makeLogger('submit');

// Refund pathway for CAPTURED payments that fail post-capture validation
// (amount/currency mismatch). Money is already with Razorpay at this point,
// so a full refund is initiated before the request is rejected — the customer
// is never left holding a captured charge for a booking that will not exist.
// Deletes the payment_used claim so the payment_id can never be replayed.
const refundCapturedPayment = async (paymentId, amountPaise, ctx, reason) => {
  await redis.del(`payment_used:${paymentId}`);
  try {
    await withTimeout(5000, razorpay.payments.refund(paymentId, { amount: amountPaise }), 'razorpay.payments.refund');
    log({ event: 'AUTO_REFUND_SUCCESS', payment_id: paymentId, amount_paise: amountPaise, reason, ...ctx }, 'INFO');
  } catch (refundErr) {
    log({ event: 'AUTO_REFUND_FAILED', payment_id: paymentId, amount_paise: amountPaise, reason, error: refundErr.message, ...ctx }, 'CRITICAL');
    captureException(refundErr, { event: 'AUTO_REFUND_FAILED', payment_id: paymentId, amount_paise: amountPaise, reason, ...ctx });
  }
};

// [RESTORED] Resolves a logged-in customer's booking to their profile
const getBearerToken = req => {
  const authorization = req.headers['authorization'] || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
};

export default async function handler(req, res) {
  const reqOrigin = req.headers['origin'] || '';
  setCorsHeaders(res, reqOrigin, { allowHeaders: 'Content-Type' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const rawIp = extractIP(req.headers);
  if (rawIp === 'invalid') {
    return res.status(400).json({ error: 'Invalid client IP address.' });
  }
  const ipKey = hashPII(rawIp);

  // Fail-Open Rate Limiting: If Upstash is down, we do not block patient care
  try {
    const { success } = await limiter.limit(ipKey);
    if (!success) return res.status(429).json({ error: 'Too many requests. Try again in 5 minutes.' });
  } catch (redisError) {
    log({ event: 'RATE_LIMIT_BYPASS', error: redisError.message, ipKey }, 'WARN');
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Malformed JSON payload.' });
  }

  const { type, payment_id } = body;
  if (!type || !SUPPORTED_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid submission type.' });

  const name = sanitize(body.name || body.FullName || '');
  const email = sanitize(body.email || body.Email || '');
  const phone = sanitize(body.phone || body.Phone || '');
  const service = sanitize(body.service || body.Service || '');
  const date = sanitize(body.date || body.PreferredDate || '');
  const preferredTime = sanitize(body.preferred_time || body.date || body.PreferredDate || '');
  const message = sanitize(body.message || body.Message || '');

  if (!name || !phone) return res.status(400).json({ error: 'Name and phone number are required.' });
  if (type !== 'callback' && !email) return res.status(400).json({ error: 'Email is required for this submission.' });

  const logContext = { ipKey, type, emailHash: hashPII(email), phoneHash: hashPII(phone) };

  try {
    if (type === 'booking') {
      if (!payment_id) return res.status(402).json({ error: 'Payment verification required.' });

      const { razorpay_order_id, razorpay_signature } = body;
      if (!razorpay_order_id || !razorpay_signature) {
        return res.status(402).json({ error: 'Missing Razorpay order or signature.' });
      }

      let expectedSig;
      try {
        const hmac = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
        hmac.update(`${razorpay_order_id}|${payment_id}`);
        expectedSig = hmac.digest('hex');
      } catch (hmacErr) {
        log({ event: 'HMAC_GENERATION_FAILED', error: hmacErr.message, ...logContext }, 'ERROR');
        return res.status(500).json({ error: 'Signature verification failed.' });
      }

      try {
        const sigBuf = Buffer.from(razorpay_signature, 'hex');
        const expectedBuf = Buffer.from(expectedSig, 'hex');
        if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
          log({ event: 'SIGNATURE_MISMATCH', payment_id, ...logContext }, 'WARN');
          return res.status(402).json({ error: 'Payment signature verification failed.' });
        }
      } catch (cmpErr) {
        log({ event: 'SIGNATURE_COMPARE_ERROR', error: cmpErr.message, ...logContext }, 'ERROR');
        return res.status(402).json({ error: 'Payment signature verification failed.' });
      }

      let customerId = null;
      const bearerToken = getBearerToken(req);
      if (bearerToken) {
        const { data, error } = await supabase.auth.getUser(bearerToken);
        if (!error && data?.user?.id) {
          customerId = data.user.id;
        }
      }

      const claimed = await redis.set(`payment_used:${payment_id}`, '1', { nx: true, ex: 86400 });
      if (!claimed) {
        log({ event: 'PAYMENT_REPLAY_BLOCKED', payment_id, ...logContext }, 'WARN');
        return res.status(409).json({ error: 'This payment has already been used for a booking.' });
      }

      let payment;
      try {
        payment = await withTimeout(5000, razorpay.payments.fetch(payment_id), 'razorpay.payments.fetch');
      } catch (err) {
        log({ event: 'PAYMENT_FETCH_FAILED', error: err.message, payment_id, ...logContext }, 'ERROR');
        captureException(err, { event: 'PAYMENT_FETCH_FAILED', payment_id, ...logContext });
        await redis.del(`payment_used:${payment_id}`);
        return res.status(402).json({ error: 'Payment could not be verified.' });
      }

      if (payment.status !== 'captured') {
        await redis.del(`payment_used:${payment_id}`);
        return res.status(402).json({ error: 'Payment was not successfully captured.' });
      }
      if (payment.amount !== EXPECTED_BOOKING_FEE_PAISE) {
        await refundCapturedPayment(payment_id, payment.amount, logContext, 'amount mismatch');
        return res.status(402).json({ error: 'Payment amount mismatch. Refund has been initiated.' });
      }
      if (payment.currency !== 'INR') {
        await refundCapturedPayment(payment_id, payment.amount, logContext, 'currency mismatch');
        return res.status(402).json({ error: 'Invalid currency. Refund has been initiated.' });
      }

      let insertedBookingId;
      try {
        const { data: inserted, error } = await supabase.from('bookings').insert({
          name, phone, email,
          care_type: sanitize(body.care_type || ''),
          service, location: sanitize(body.location || ''),
          scheduled_date: date || null, scheduled_time: sanitize(body.time || ''),
          notes: message,
          // V2: Start as paid_unassigned — transitions to 'assigned' when a nurse accepts
          status: 'paid_unassigned',
          payment_id,
          customer_id: customerId, amount_paise: payment.amount,
          emails_dispatched: false,
          created_at: new Date().toISOString()
        }).select('id').single();

        if (error) throw new Error(`Supabase insert failed: ${error.message}`);
        insertedBookingId = inserted.id;

        // Belt-and-braces for the payment.captured webhook race
        const { data: payRow } = await supabase.from('payments').select('id').eq('payment_id', payment_id).maybeSingle();
        const { error: invErr } = await supabase.from('invoices').upsert(
          { booking_id: inserted.id, customer_id: customerId, payment_id: payRow?.id || null, subtotal_paise: payment.amount, tax_paise: 0, total_paise: payment.amount, status: 'issued' },
          { onConflict: 'booking_id', ignoreDuplicates: true }
        );
        if (invErr) log({ event: 'INVOICE_INSERT_FAILED', error: invErr.message, payment_id, booking_id: inserted.id, ...logContext }, 'ERROR');
      } catch (dbError) {
        log({ event: 'DB_INSERT_FAILED', error: dbError.message, payment_id, ...logContext }, 'CRITICAL');
        captureException(dbError, { event: 'DB_INSERT_FAILED', payment_id, ...logContext });
        try {
          await razorpay.payments.refund(payment_id, { amount: payment.amount });
          log({ event: 'AUTO_REFUND_SUCCESS', payment_id }, 'INFO');
        } catch (refundErr) {
          log({ event: 'AUTO_REFUND_FAILED', payment_id, error: refundErr.message }, 'CRITICAL');
        }
        await redis.del(`payment_used:${payment_id}`);
        return res.status(500).json({ error: 'Booking failed. A full refund has been initiated.' });
      }

      // ── V2 DUAL-EMAIL DISPATCH ─────────────────────────────────────────────
      // ATOMIC claim-first idempotency: UPDATE ... WHERE emails_dispatched=false.
      // Exactly one invocation wins the claim; every other invocation (webhook
      // retry, double-submit) short-circuits with 200 and dispatches nothing.
      let dispatchClaimed = false;
      try {
        const { data: claimRow, error: claimErr } = await supabase
          .from('bookings')
          .update({ emails_dispatched: true })
          .eq('id', insertedBookingId)
          .eq('emails_dispatched', false)
          .select('id')
          .maybeSingle();
        if (claimErr) throw new Error(`Dispatch claim failed: ${claimErr.message}`);
        dispatchClaimed = Boolean(claimRow);
      } catch (claimError) {
        log({ event: 'DISPATCH_CLAIM_FAILED', error: claimError.message, booking_id: insertedBookingId, ...logContext }, 'ERROR');
        captureException(claimError, { event: 'DISPATCH_CLAIM_FAILED', booking_id: insertedBookingId, ...logContext });
        return res.status(500).json({ error: 'Booking created but dispatch could not be claimed.' });
      }

      if (!dispatchClaimed) {
        log({ event: 'DISPATCH_SKIPPED_IDEMPOTENT', booking_id: insertedBookingId }, 'INFO');
        return res.status(200).json({ ok: true });
      }

      // Locate available nurses — non-blocking if none found (falls back to admin alert)
      let candidateNurses = [];
      try {
        candidateNurses = await findAvailableNurses(supabase, {
          location: sanitize(body.location || ''),
          service,
          date: date || null,
          time: sanitize(body.time || ''),
        });
      } catch (qErr) {
        log({ event: 'NURSE_LOOKUP_FAILED', error: qErr.message, ...logContext }, 'WARN');
      }

      // Resolve the invoice number BEFORE dispatching so the patient receipt
      // renders the Invoice row (invoices.invoice_number is UNIQUE).
      let invoiceNumber = null;
      try {
        const { data: invoiceRow } = await supabase
          .from('invoices').select('invoice_number').eq('booking_id', insertedBookingId).maybeSingle();
        invoiceNumber = invoiceRow?.invoice_number || null;
      } catch (invErr) {
        log({ event: 'INVOICE_RESOLVE_FAILED', error: invErr.message, booking_id: insertedBookingId, ...logContext }, 'WARN');
      }

      // Unique short-lived token per nurse per booking (2h expiry).
      // JWT_SECRET is enforced in REQUIRED_ENV — dispatch can never silently
      // degrade to zero nurse emails.
      const nurseDispatchPromises = candidateNurses.map((nurse) => {
        const nurseName = `${nurse.first_name} ${nurse.last_name || ''}`.trim();
        const actionToken = jwt.sign(
          { bookingId: insertedBookingId, nurseId: nurse.id },
          process.env.JWT_SECRET,
          { expiresIn: '2h', algorithm: 'HS256', issuer: 'careconnect360-dispatch' }
        );
        return withTimeout(
          5000,
          sendNurseDispatchRequest({
            nurseEmail: nurse.email,
            nurseName,
            bookingId: insertedBookingId,
            careType: sanitize(body.care_type || ''),
            service,
            location: scrubbedLocation(body.location),  // PIN/zone ONLY — never the street address
            scheduledDate: date || null,
            scheduledTime: sanitize(body.time || ''),
            acceptToken: actionToken,
            declineToken: actionToken,  // Same JWT — action param distinguishes intent
          }),
          `sendNurseDispatch:${nurse.id}`
        );
      });

      // If no nurses matched, send admin alert as fallback
      const adminFallback = candidateNurses.length === 0
        ? withTimeout(5000, sendNewBookingAlert({ name, phone, service }), 'sendNewBookingAlert')
        : Promise.resolve();

      // Await ALL email dispatches fully before responding — Vercel lifecycle safe
      const results = await Promise.allSettled([
        withTimeout(5000, sendPatientReceipt({
          name, email, phone, service,
          location: sanitize(body.location || ''),
          scheduledDate: date || null,
          scheduledTime: sanitize(body.time || ''),
          invoiceNumber,
        }), 'sendPatientReceipt'),
        adminFallback,
        ...nurseDispatchPromises,
      ]);

      // Log any email delivery failures without throwing
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          log({ event: 'EMAIL_DISPATCH_FAILED', index: i, error: r.reason?.message, ...logContext }, 'WARN');
        }
      });

      log({ event: 'DISPATCH_COMPLETE', booking_id: insertedBookingId, nursesNotified: candidateNurses.length }, 'INFO');
      return res.status(200).json({ ok: true });
    }

    if (type === 'callback') {
      const { error } = await supabase.from('callbacks').insert({
        name,
        phone,
        preferred_time: preferredTime,
        created_at: new Date().toISOString()
      });

      if (error) throw new Error(`Supabase callback insert failed: ${error.message}`);

      await Promise.allSettled([sendCallbackAlert({ name, phone })]);
      return res.status(200).json({ ok: true });
    }

    if (type === 'application') {
      const firstName = sanitize(body.first_name || body.FirstName || name.split(' ')[0] || '');
      const lastName = sanitize(body.last_name || body.LastName || name.split(' ').slice(1).join(' ') || '');

      const { error } = await supabase.from('applications').insert({
        first_name: firstName,
        last_name: lastName,
        email,
        phone,
        mnc_registration: sanitize(body.registration || ''),
        experience: sanitize(body.experience || ''),
        speciality: sanitize(body.speciality || ''),
        city: sanitize(body.city || ''),
        message,
        status: 'submitted',
        created_at: new Date().toISOString()
      });

      if (error) throw new Error(`Supabase application insert failed: ${error.message}`);

      await Promise.allSettled([sendApplicationReceived({ firstName, email })]);
      return res.status(200).json({ ok: true });
    }
  } catch (error) {
    log({ event: 'UNHANDLED_ERROR', error: error.message, ...logContext }, 'ERROR');
    captureException(error, { event: 'UNHANDLED_ERROR', ...logContext });
    return res.status(500).json({ error: 'An internal error occurred.' });
  }
}