 /**
 * POST /api/submit
 * Enterprise-grade form submission handler with server-side payment verification.
 * Fixes: [CRIT-1] Form handler logic, [CRIT-2] Server-side payment verification.
 * 
 * @security Rate Limiting, CORS, Server-Side Payment Verification, PII Hashing
 */

import crypto from 'crypto';
import Razorpay from 'razorpay';
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/* ── Environment Validation (Fail Fast) ──────────────────────── */
const REQUIRED_ENV = [
  'ALLOWED_ORIGIN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET',
  'AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID',
  'AIRTABLE_BOOKINGS_TABLE', 'AIRTABLE_CALLBACKS_TABLE', 'AIRTABLE_APPS_TABLE',
  'RESEND_API_KEY', 'ADMIN_EMAIL'
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) throw new Error(`[submit] FATAL: missing ${key}`);
}

/* ── Constants ───────────────────────────────────────────────── */
const EXPECTED_BOOKING_FEE_PAISE = 50000; // ₹500
const SUPPORTED_TYPES = ['booking', 'callback', 'application'];

/* ── Initialize Clients ──────────────────────────────────────── */
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

/* ── Helper Functions ────────────────────────────────────────── */

function hashPII(data) {
  return crypto.createHash('sha256').update(String(data || '')).digest('hex').slice(0, 16);
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'&]/g, c => ({ '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":"&#039;", '&':'&amp;' })[c]).trim();
}

function setCors(res, reqOrigin) {
  if (reqOrigin === process.env.ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

async function writeAirtable(tableName, fields) {
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable write failed: ${text}`);
  }
  return res.json();
}

async function sendResend(to, subject, html) {
  if (!to) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'CareConnect <noreply@careconnect360.in>',
      to: [to],
      subject,
      html
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend failed: ${text}`);
  }
}

/* ── Main Handler ────────────────────────────────────────────── */
export default async function handler(req, res) {
  const reqOrigin = req.headers['origin'] || '';
  setCors(res, reqOrigin);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  // 1. Rate Limiting
  const rawIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  const ipKey = hashPII(rawIp);
  
  const { success } = await limiter.limit(ipKey);
  if (!success) {
    return res.status(429).json({ error: 'Too many requests. Try again in 5 minutes.' });
  }

  // 2. Parse Body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Malformed JSON payload.' });
  }

  const { type, payment_id } = body;

  // 3. Validate Type
  if (!type || !SUPPORTED_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Invalid submission type.' });
  }

  // 4. Extract & Sanitize Fields (Mapping frontend FormData to safe strings)
  const name = sanitize(body.name || body.FullName || '');
  const email = sanitize(body.email || body.Email || '');
  const phone = sanitize(body.phone || body.Phone || '');
  const service = sanitize(body.service || body.Service || '');
  const date = sanitize(body.date || body.PreferredDate || '');
  const message = sanitize(body.message || body.Message || '');

  // 5. Basic Validation
  if (!name || !phone) {
    return res.status(400).json({ error: 'Name and phone number are required.' });
  }
  if (type !== 'callback' && !email) {
    return res.status(400).json({ error: 'Email is required for this submission.' });
  }

  const logContext = { ipKey, type, emailHash: hashPII(email), phoneHash: hashPII(phone) };

  try {
    // ── BOOKING FLOW (Requires Payment Verification) ───────────
    if (type === 'booking') {
      if (!payment_id) {
        return res.status(402).json({ error: 'Payment verification required.' });
      }

      // [CRIT-2] Server-side payment verification
      let payment;
      try {
        payment = await razorpay.payments.fetch(payment_id);
      } catch (err) {
        console.error('[submit] Razorpay fetch error:', err.message, logContext);
        return res.status(402).json({ error: 'Payment could not be verified.' });
      }

      // Strict Assertions
      if (payment.status !== 'captured') {
        console.error('[submit] Payment not captured:', payment.status, logContext);
        return res.status(402).json({ error: 'Payment was not successfully captured.' });
      }
      if (payment.amount !== EXPECTED_BOOKING_FEE_PAISE) {
        console.error('[submit] Amount mismatch:', payment.amount, logContext);
        return res.status(402).json({ error: 'Payment amount mismatch.' });
      }
      if (payment.currency !== 'INR') {
        return res.status(402).json({ error: 'Invalid currency.' });
      }

      // Write to Airtable
      await writeAirtable(process.env.AIRTABLE_BOOKINGS_TABLE, {
        Name: name, Phone: phone, Email: email, 
        CareType: sanitize(body.care_type || ''),
        Service: service, Location: sanitize(body.location || ''),
        Date: date, Time: sanitize(body.time || ''), Notes: message,
        Payment_Status: 'Confirmed - Paid',
        Payment_ID: payment_id,
        Amount_Paid: payment.amount / 100,
        Timestamp: new Date().toISOString()
      });

      // Send Emails (Promise.allSettled ensures one failure doesn't block the other)
      const customerHtml = `<p>Hi ${name},</p><p>We have received your booking fee of ₹500. Our care coordinator will contact you shortly at ${phone}.</p>`;
      const adminHtml = `<p>New paid booking received.</p><p>Name: ${name}<br>Phone: ${phone}<br>Service: ${service}</p>`;
      
      await Promise.allSettled([
        sendResend(email, 'Booking Confirmed - CareConnect360', customerHtml),
        sendResend(process.env.ADMIN_EMAIL, '🔔 New Paid Booking', adminHtml)
      ]);

      console.log('[submit] Booking success:', logContext);
      return res.status(200).json({ ok: true });
    }

    // ── CALLBACK FLOW ──────────────────────────────────────────
    if (type === 'callback') {
      await writeAirtable(process.env.AIRTABLE_CALLBACKS_TABLE, {
        Name: name, Phone: phone, PreferredTime: date,
        Timestamp: new Date().toISOString()
      });

      const adminHtml = `<p>New callback request.</p><p>Name: ${name}<br>Phone: ${phone}</p>`;
      await sendResend(process.env.ADMIN_EMAIL, '🔔 New Callback Request', adminHtml).catch(() => {});

      console.log('[submit] Callback success:', logContext);
      return res.status(200).json({ ok: true });
    }

    // ── APPLICATION FLOW ───────────────────────────────────────
    if (type === 'application') {
      const firstName = sanitize(body.first_name || body.FirstName || name.split(' ')[0] || '');
      const lastName = sanitize(body.last_name || body.LastName || name.split(' ').slice(1).join(' ') || '');
      const registration = sanitize(body.registration || body.MNC_Registration || '');
      const experience = sanitize(body.experience || body.Experience || '');
      const speciality = sanitize(body.speciality || body.Speciality || '');

      await writeAirtable(process.env.AIRTABLE_APPS_TABLE, {
        FirstName: firstName, LastName: lastName, Email: email, Phone: phone,
        MNC_Registration: registration, Experience: experience,
        Speciality: speciality, Message: message,
        Timestamp: new Date().toISOString()
      });

      const applicantHtml = `<p>Hi ${firstName},</p><p>Thank you for applying to CareConnect360. We have received your application and will review it shortly.</p>`;
      await sendResend(email, 'Application Received - CareConnect360', applicantHtml).catch(() => {});

      console.log('[submit] Application success:', logContext);
      return res.status(200).json({ ok: true });
    }

  } catch (error) {
    console.error('[submit] Unhandled error:', error.message, logContext);
    return res.status(500).json({ error: 'An internal error occurred. Please try again later.' });
  }
}