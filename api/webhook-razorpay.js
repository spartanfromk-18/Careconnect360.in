 /**
@fileoverview Enterprise-grade Razorpay Webhook Handler for CareConnect360.
Handles payment events, ensures idempotency via Upstash Redis,
updates Airtable, and triggers transactional emails via Resend.
*/
import crypto from 'crypto';
import { Redis } from "@upstash/redis";

/* ── Environment Validation (Fail Fast) ──────────────────────── */
const REQUIRED_ENV = [
  'RAZORPAY_WEBHOOK_SECRET', 'AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID',
  'AIRTABLE_PAYMENTS_TABLE', 'RESEND_API_KEY', 'ADMIN_EMAIL',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) throw new Error(`[webhook] FATAL: missing ${key}`);
}

/* ── Redis Initialization ─────────────────── */
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/**
Verifies the HMAC-SHA256 signature safely.
[CRITICAL FIX] Prevents RangeError crash on buffer length mismatch.
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

async function syncToAirtable(payload, eventType) {
  const payment = payload.payload.payment?.entity || {};
  const refund = payload.payload.refund?.entity || {};
  const paymentId = payment.id || refund.payment_id || 'unknown';
  const orderId = payment.order_id || 'unknown';
  const amount = payment.amount || refund.amount || 0;
  const currency = payment.currency || 'INR';
  const notes = payment.notes || {};

  const statusMap = {
    'payment.captured': 'captured', 'payment.failed': 'failed',
    'payment.authorized': 'authorized', 'order.paid': 'captured',
    'refund.created': 'refunded', 'refund.processed': 'refunded'
  };

  const fields = {
    PaymentId: paymentId, OrderId: orderId, EventType: eventType,
    Amount: amount, Currency: currency, Status: statusMap[eventType] || 'unknown',
    CustomerEmail: notes.customerEmail || '', CustomerPhone: notes.customerPhone || '',
    CustomerName: notes.name || '', BookingRef: notes.booking_ref || '',
    RazorpayNotes: JSON.stringify(notes), Timestamp: new Date().toISOString(),
    WebhookEventId: payload.id
  };

  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_PAYMENTS_TABLE}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) throw new Error(`Airtable sync failed: ${await res.text()}`);
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
  
  // Note: 'captured' branch removed. submit.js handles customer confirmation synchronously.
  
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

  // [CRITICAL FIX] Atomic Idempotency Check (Fixes TOCTOU race condition)
  const isDuplicate = await redis.set(`webhook:event:${eventId}`, '1', { nx: true, ex: 86400 });
  if (!isDuplicate) {
    logEvent({ ...logData, message: 'Duplicate webhook ignored' }, 'INFO');
    return res.status(200).json({ ok: true });
  }

  const tasks = [];
  tasks.push(syncToAirtable(payload, eventType).catch(err => logEvent({ ...logData, error: err.message }, 'ERROR')));

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