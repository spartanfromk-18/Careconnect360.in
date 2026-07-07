 /**
 * @fileoverview Enterprise-grade Razorpay Webhook Handler for CareConnect360.
 * Handles payment events, ensures idempotency via Upstash Redis (primary layer)
 * + Supabase unique constraint (secondary layer), updates Postgres, generates
 * invoices on payment.captured, and triggers transactional emails via Resend.
 */
import crypto from 'crypto';
import { Redis } from "@upstash/redis";
import { createClient } from '@supabase/supabase-js';

/* ── Environment Validation (Fail Fast) ──────────────────────── */
const REQUIRED_ENV = [
  'RAZORPAY_WEBHOOK_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'RESEND_API_KEY', 'ADMIN_EMAIL',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) throw new Error(`[webhook] FATAL: missing ${key}`);
}

/* ── Client Initialization ────────────────────────────────────── */
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Service role key bypasses RLS intentionally — this is a trusted server context.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Verifies the HMAC-SHA256 signature safely.
 * Prevents RangeError crash on buffer length mismatch.
 */
function verifySignature(rawBody, signature) {
  try {
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
    const sigBuf = Buffer.from(signature || '');
    const expBuf = Buffer.from(expected);
    return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

function logEvent(data, level = 'INFO') {
  console.log(JSON.stringify({ level, timestamp: new Date().toISOString(), source: 'webhook-razorpay', ...data }));
}

/**
 * Writes/updates the payment record in Supabase.
 * Uses upsert on webhook_event_id as a DB-level idempotency guard,
 * layered UNDER the Redis check in the main handler (Redis runs first).
 * Returns the resolved booking_id (or null if no matching booking found —
 * expected for callback/application-only flows that never touch payments).
 */
async function syncToSupabase(payload, eventType) {
  const payment = payload.payload.payment?.entity || {};
  const refund = payload.payload.refund?.entity || {};
  const paymentId = payment.id || refund.payment_id || 'unknown';
  const orderId = payment.order_id || 'unknown';
  const amount = payment.amount || refund.amount || 0; // paise, no conversion — confirmed unit for this table
  const currency = payment.currency || 'INR';
  const notes = payment.notes || {};

  const statusMap = {
    'payment.captured': 'captured', 'payment.failed': 'failed',
    'payment.authorized': 'authorized', 'order.paid': 'captured',
    'refund.created': 'refunded', 'refund.processed': 'refunded'
  };

  // Resolve booking_id via payment_id — the confirmed real join key.
  // (booking_ref/notes.booking_ref is NOT used — it's populated client-side
  // but never persisted to the bookings table, so it can't be joined on.)
  let bookingId = null;
  if (paymentId !== 'unknown') {
    const { data: bookingRow, error: lookupErr } = await supabase
      .from('bookings')
      .select('id')
      .eq('payment_id', paymentId)
      .maybeSingle();
    if (lookupErr) {
      logEvent({ message: 'Booking lookup failed', error: lookupErr.message, paymentId }, 'ERROR');
    } else if (bookingRow) {
      bookingId = bookingRow.id;
    }
  }

  const fields = {
    payment_id: paymentId,
    webhook_event_id: payload.id,
    booking_id: bookingId,
    order_id: orderId,
    event_type: eventType,
    amount_paise: amount,
    currency: currency,
    status: statusMap[eventType] || 'unknown',
    customer_email: notes.customerEmail || '',
    customer_phone: notes.customerPhone || '',
    customer_name: notes.name || '',
    razorpay_notes: notes,
  };

  const { error: upsertErr } = await supabase
    .from('payments')
    .upsert(fields, { onConflict: 'webhook_event_id', ignoreDuplicates: true });

  if (upsertErr) throw new Error(`Supabase payment upsert failed: ${upsertErr.message}`);

  // Move the booking to 'confirmed' and generate an invoice — only on
  // a real capture event, and only if we actually resolved a booking.
  if (eventType === 'payment.captured' && bookingId) {
    const { error: statusErr } = await supabase
      .from('bookings')
      .update({ status: 'confirmed', updated_at: new Date().toISOString() })
      .eq('id', bookingId);
    if (statusErr) logEvent({ message: 'Booking status update failed', error: statusErr.message, bookingId }, 'ERROR');

    const { data: existingInvoice } = await supabase
      .from('invoices')
      .select('id')
      .eq('booking_id', bookingId)
      .maybeSingle();

    if (!existingInvoice) {
      const { error: invErr } = await supabase.from('invoices').insert({
        booking_id: bookingId,
        customer_id: null, // populated once customer auth (Phase 6) links bookings to a profile
        subtotal_paise: amount,
        tax_paise: 0,
        total_paise: amount,
        status: 'issued',
      });
      if (invErr) logEvent({ message: 'Invoice insert failed', error: invErr.message, bookingId }, 'ERROR');
    }
  }

  return bookingId;
}

async function sendEmail(to, subject, html) {
  if (!to) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'CareConnect <noreply@careconnect360.in>', to: [to], subject, html })
  });
  if (!res.ok) throw new Error(`Resend failed: ${await res.text()}`);
}

function getEmailTemplate(type, data) {
  const baseStyle = `font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;`;

  if (type === 'failed') {
    return {
      to: process.env.ADMIN_EMAIL,
      subject: `⚠️ Payment Failed — ${data.paymentId}`,
      html: `<div style="${baseStyle}"><h2>Payment Failure Alert</h2><p><strong>Payment ID:</strong> ${data.paymentId}</p><p><strong>Error:</strong> ${data.errorCode} - ${data.errorDesc}</p><p>Please follow up manually.</p></div>`
    };
  }
  if (type === 'refund') {
    return {
      to: process.env.ADMIN_EMAIL,
      subject: `↩️ Refund Processed — ${data.paymentId}`,
      html: `<div style="${baseStyle}"><h2>Refund Notification</h2><p>A refund of <strong>₹${data.amount / 100}</strong> has been processed for Payment ID: ${data.paymentId}.</p></div>`
    };
  }
  return null;
}

/* ── Main Handler ─────────────────────────────────────────────── */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let rawBody = '';
  if (typeof req.body === 'string') rawBody = req.body;
  else if (Buffer.isBuffer(req.body)) rawBody = req.body.toString('utf8');
  else if (typeof req.body === 'object' && req.body !== null) rawBody = JSON.stringify(req.body);
  else return res.status(400).json({ error: 'Invalid payload' });

  const signature = req.headers['x-razorpay-signature'];
  if (!signature || !verifySignature(rawBody, signature)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const payload = JSON.parse(rawBody);
  const eventId = payload.id;
  const eventType = payload.event;
  const payment = payload.payload.payment?.entity || {};
  const logData = { eventId, eventType, paymentId: payment.id, orderId: payment.order_id, amount: payment.amount, currency: payment.currency };

  // PRIMARY idempotency layer — Redis, checked first, exactly as in the original code.
  const isDuplicate = await redis.set(`webhook:event:${eventId}`, '1', { nx: true, ex: 86400 });
  if (!isDuplicate) {
    logEvent({ ...logData, message: 'Duplicate webhook ignored' }, 'INFO');
    return res.status(200).json({ ok: true });
  }

  const tasks = [];
  tasks.push(syncToSupabase(payload, eventType).catch(err => logEvent({ ...logData, error: err.message }, 'ERROR')));

  let template = null;
  if (eventType === 'payment.failed') {
    template = getEmailTemplate('failed', { ...payment, errorDesc: payment.error_description, errorCode: payment.error_code });
  } else if (eventType === 'refund.processed') {
    template = getEmailTemplate('refund', payload.payload.refund?.entity || {});
  }

  if (template) {
    tasks.push(sendEmail(template.to, template.subject, template.html).catch(err => logEvent({ ...logData, error: err.message }, 'ERROR')));
  }

  await Promise.allSettled(tasks);
  logEvent(logData, 'INFO');
  return res.status(200).json({ ok: true });
}