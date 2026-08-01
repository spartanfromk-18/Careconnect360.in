import crypto from 'crypto';
import Razorpay from 'razorpay';
import { hashPII, extractIP } from './security-utils.js';
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { createClient } from '@supabase/supabase-js';
import { makeLogger, captureException } from '../lib/logger.js';
import { sendBookingConfirmation, sendNewBookingAlert, sendCallbackAlert, sendApplicationReceived } from '../lib/email.js';

const REQUIRED_ENV = [
  'ALLOWED_ORIGIN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'RESEND_API_KEY', 'ADMIN_EMAIL', 'SENDER_EMAIL'
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) throw new Error(`[submit] FATAL: missing ${key}`);
}

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

const ALLOWED_PREVIEW_ORIGINS = (process.env.ALLOWED_PREVIEW_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const setCors = (res, reqOrigin) => {
  const isAllowed = reqOrigin === process.env.ALLOWED_ORIGIN || ALLOWED_PREVIEW_ORIGINS.includes(reqOrigin);
  if (isAllowed && reqOrigin) {
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Idempotency-Key');
  res.setHeader('Vary', 'Origin');
};

// [RESTORED] Resolves a logged-in customer's booking to their profile
const getBearerToken = req => {
  const authorization = req.headers['authorization'] || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
};

export default async function handler(req, res) {
  const reqOrigin = req.headers['origin'] || '';
  setCors(res, reqOrigin);
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
        payment = await razorpay.payments.fetch(payment_id); 
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
        await redis.del(`payment_used:${payment_id}`);
        return res.status(402).json({ error: 'Payment amount mismatch.' });
      }
      if (payment.currency !== 'INR') {
        await redis.del(`payment_used:${payment_id}`);
        return res.status(402).json({ error: 'Invalid currency.' });
      }

      try {
        const { data: inserted, error } = await supabase.from('bookings').insert({
          name, phone, email,
          care_type: sanitize(body.care_type || ''),
          service, location: sanitize(body.location || ''),
          scheduled_date: date || null, scheduled_time: sanitize(body.time || ''),
          notes: message, status: 'confirmed', payment_id,
          customer_id: customerId, amount_paise: payment.amount,
          created_at: new Date().toISOString()
        }).select('id').single();

        if (error) throw new Error(`Supabase insert failed: ${error.message}`);

        // Belt-and-braces for the payment.captured webhook race: if the webhook
        // already processed this payment BEFORE this booking row existed, it
        // could not create the invoice. Ensure exactly one invoice exists here
        // (unique index on invoices.booking_id makes the upsert idempotent).
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

      Promise.allSettled([
        sendBookingConfirmation({ name, email, phone }),
        sendNewBookingAlert({ name, phone, service })
      ]);

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

      Promise.allSettled([sendCallbackAlert({ name, phone })]);
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

      Promise.allSettled([sendApplicationReceived({ firstName, email })]);
      return res.status(200).json({ ok: true });
    }
  } catch (error) {
    log({ event: 'UNHANDLED_ERROR', error: error.message, ...logContext }, 'ERROR');
    captureException(error, { event: 'UNHANDLED_ERROR', ...logContext });
    return res.status(500).json({ error: 'An internal error occurred.' });
  }
}