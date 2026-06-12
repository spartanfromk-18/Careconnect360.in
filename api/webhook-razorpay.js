/**
 * @fileoverview Enterprise-grade Razorpay Webhook Handler for CareConnect360.
 * Handles payment events, ensures idempotency via Upstash Redis,
 * updates Airtable, and triggers transactional emails via Resend.
 * 
 * @author Jarvis (Senior Payments Infrastructure Engineer)
 * @version 2.0.0
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

/* ── Redis Initialization (For Idempotency) ─────────────────── */
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/**
 * Verifies the HMAC-SHA256 signature of the webhook payload.
 * @param {string} rawBody - The raw request body string.
 * @param {string} signature - The X-Razorpay-Signature header value.
 * @returns {boolean} True if valid, false otherwise.
 */
function verifySignature(rawBody, signature) {
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * Logs structured event data to Vercel function logs.
 * @param {Object} data - The event data to log.
 * @param {string} level - Log level (INFO, ERROR, WARN).
 */
function logEvent(data, level = 'INFO') {
  console.log(JSON.stringify({ level, timestamp: new Date().toISOString(), ...data }));
}

/**
 * Writes or updates a payment record in Airtable.
 * @param {Object} payload - The parsed webhook payload.
 * @param {string} eventType - The Razorpay event type.
 */
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
    CustomerEmail: notes.email || '', CustomerPhone: notes.phone || '',
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

/**
 * Sends a transactional email via Resend.
 * @param {string} to - Recipient email.
 * @param {string} subject - Email subject.
 * @param {string} html - HTML body.
 */
async function sendEmail(to, subject, html) {
  if (!to) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'CareConnect <noreply@careconnect360.in>', to: [to], subject, html })
  });
  if (!res.ok) throw new Error(`Resend failed: ${await res.text()}`);
}

/**
 * Generates HTML email templates.
 * @param {string} type - Template type.
 * @param {Object} data - Template data.
 * @returns {{subject: string, html: string, to: string}}
 */
function getEmailTemplate(type, data) {
  const baseStyle = `font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;`;
  
  if (type === 'captured') {
    return {
      to: data.email,
      subject: `✅ Your CareConnect booking is confirmed — ${data.orderId}`,
      html: `<div style="${baseStyle}"><h2>Booking Confirmed!</h2><p>Hi ${data.name || 'there'},</p><p>We have successfully received your payment of <strong>₹${data.amount / 100}</strong> for Order <strong>${data.orderId}</strong>.</p><p>Our care coordinator will contact you within 2 hours to finalize your nursing schedule.</p><p>Support: support@careconnect360.in</p></div>`
    };
  }
  if (type === 'failed') {
    return {
      to: process.env.ADMIN_EMAIL,
      subject: `⚠️ Payment Failed — ${data.paymentId}`,
      html: `<div style="${baseStyle}"><h2>Payment Failure Alert</h2><p><strong>Payment ID:</strong> ${data.paymentId}</p><p><strong>Error:</strong> ${data.errorCode} - ${data.errorDesc}</p><p><strong>Customer:</strong> ${data.email || 'N/A'} / ${data.phone || 'N/A'}</p><p>Please follow up manually.</p></div>`
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

  // 1. Extract Raw Body (Vercel Node.js specific workaround)
  let rawBody = '';
  if (typeof req.body === 'string') rawBody = req.body;
  else if (Buffer.isBuffer(req.body)) rawBody = req.body.toString('utf8');
  else if (typeof req.body === 'object' && req.body !== null) rawBody = JSON.stringify(req.body);
  else return res.status(400).json({ error: 'Invalid payload' });

  const signature = req.headers['x-razorpay-signature'];
  if (!signature || !verifySignature(rawBody, signature)) {
    return res.status(400).json({ error: 'Invalid signature' }); // Never return 401
  }

  const payload = JSON.parse(rawBody);
  const eventId = payload.id;
  const eventType = payload.event;
  const payment = payload.payload.payment?.entity || {};
  
  const logData = { eventId, eventType, paymentId: payment.id, orderId: payment.order_id, amount: payment.amount, currency: payment.currency };

  // 2. Idempotency Check via Upstash Redis
  const isDuplicate = await redis.get(`webhook:event:${eventId}`);
  if (isDuplicate) {
    logEvent({ ...logData, message: 'Duplicate webhook ignored' }, 'INFO');
    return res.status(200).json({ ok: true });
  }
  await redis.set(`webhook:event:${eventId}`, '1', { ex: 86400 }); // 24h TTL

  // 3. Execute Heavy Work Asynchronously (Graceful Degradation)
  const tasks = [];
  tasks.push(syncToAirtable(payload, eventType).catch(err => logEvent({ ...logData, error: err.message }, 'ERROR')));

  let template = null;
  if (eventType === 'payment.captured' || eventType === 'order.paid') {
    template = getEmailTemplate('captured', { ...payment.notes, orderId: payment.order_id, amount: payment.amount });
  } else if (eventType === 'payment.failed') {
    template = getEmailTemplate('failed', { ...payment, errorDesc: payment.error_description, errorCode: payment.error_code });
  } else if (eventType === 'refund.processed') {
    template = getEmailTemplate('refund', payload.payload.refund?.entity || {});
  }

  if (template) {
    tasks.push(sendEmail(template.to, template.subject, template.html).catch(err => logEvent({ ...logData, error: err.message }, 'ERROR')));
  }

  // Wait for all tasks to finish or fail independently before responding
  await Promise.allSettled(tasks);

  logEvent(logData, 'INFO');
  return res.status(200).json({ ok: true });
}