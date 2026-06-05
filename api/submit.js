/**
 * POST /api/submit
 * Handles: booking | callback | application form submissions.
 * Writes to Airtable, sends email via Resend.
 *
 * Security hardening:
 *  - CORS locked to ALLOWED_ORIGIN env var
 *  - Input sanitisation (strip HTML, truncate)
 *  - Per-IP rate limiting (5 req / 10 min) via in-memory store
 *    (Vercel serverless: each instance is isolated; for true global
 *     rate-limiting use Upstash Redis — instructions in README)
 *  - No secrets ever exposed to client
 *  - All env vars validated at cold-start
 */

'use strict';

const crypto = require('crypto');

/* ── Environment validation ───────────────────────────────────── */
const REQUIRED_ENV = [
  'AIRTABLE_API_KEY',
  'AIRTABLE_BASE_ID',
  'AIRTABLE_BOOKINGS_TABLE',
  'AIRTABLE_CALLBACKS_TABLE',
  'AIRTABLE_APPS_TABLE',
  'RESEND_API_KEY',
  'ADMIN_EMAIL',
  'ALLOWED_ORIGIN',
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[submit] FATAL: missing env var ${key}`);
  }
}

/* ── Rate limiter (in-memory, per serverless instance) ────────── */
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX       = 5;               // requests per window
const rateLimitMap         = new Map();

function getRateLimitKey(rawIp) {
  // Hash IP so we never log/store raw addresses
  return crypto.createHash('sha256').update(rawIp || 'unknown').digest('hex').slice(0, 16);
}

function isRateLimited(ipKey) {
  const now    = Date.now();
  const record = rateLimitMap.get(ipKey);

  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ipKey, { count: 1, windowStart: now });
    return false;
  }
  if (record.count >= RATE_LIMIT_MAX) return true;
  record.count += 1;
  return false;
}

/* ── CORS helper ──────────────────────────────────────────────── */
function setCorsHeaders(res, reqOrigin) {
  const allowed = process.env.ALLOWED_ORIGIN || '';
  const origin  = reqOrigin === allowed ? allowed : '';

  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

/* ── Input sanitiser ──────────────────────────────────────────── */
function sanitize(value, maxLen = 500) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[<>"'`]/g, '')   // strip HTML-injectable chars
    .replace(/\r?\n/g, ' ')    // flatten newlines in single-line fields
    .trim()
    .slice(0, maxLen);
}

function sanitizeLong(value, maxLen = 2000) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[<>"'`]/g, '')
    .trim()
    .slice(0, maxLen);
}

/* ── Airtable write ───────────────────────────────────────────── */
async function writeAirtable(tableName, fields) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  const apiKey = process.env.AIRTABLE_API_KEY;

  const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;
  const res  = await fetch(url, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Airtable error ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/* ── Resend email ─────────────────────────────────────────────── */
async function sendEmail(subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:    'CareConnect <noreply@careconnect360.in>',
      to:      [process.env.ADMIN_EMAIL],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Non-fatal: log but don't fail the user request
    console.error(`[submit] Resend error ${res.status}: ${text.slice(0, 200)}`);
  }
}

/* ── Email templates ──────────────────────────────────────────── */
function bookingEmailHtml(d) {
  return `
<h2>New Booking — CareConnect</h2>
<table cellpadding="8" border="1" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
  <tr><th>Patient Name</th>  <td>${d.name}</td></tr>
  <tr><th>Care Type</th>     <td>${d.care_type}</td></tr>
  <tr><th>Service</th>       <td>${d.service}</td></tr>
  <tr><th>Location</th>      <td>${d.location}</td></tr>
  <tr><th>Preferred Date</th><td>${d.date}</td></tr>
  <tr><th>Preferred Time</th><td>${d.time}</td></tr>
  <tr><th>Notes</th>         <td>${d.notes || '—'}</td></tr>
</table>`;
}

function callbackEmailHtml(d) {
  return `
<h2>New Callback Request — CareConnect</h2>
<table cellpadding="8" border="1" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
  <tr><th>Name</th>           <td>${d.name}</td></tr>
  <tr><th>Phone</th>          <td>${d.phone}</td></tr>
  <tr><th>Preferred Time</th> <td>${d.preferred_time}</td></tr>
</table>`;
}

function applicationEmailHtml(d) {
  return `
<h2>New Nurse Application — CareConnect</h2>
<table cellpadding="8" border="1" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
  <tr><th>Name</th>         <td>${d.first_name} ${d.last_name}</td></tr>
  <tr><th>Email</th>        <td>${d.email}</td></tr>
  <tr><th>Phone</th>        <td>${d.phone}</td></tr>
  <tr><th>INC / Reg No.</th><td>${d.mnc_registration}</td></tr>
  <tr><th>Experience</th>   <td>${d.experience} yrs</td></tr>
  <tr><th>Speciality</th>   <td>${d.speciality}</td></tr>
  <tr><th>Message</th>      <td>${d.message || '—'}</td></tr>
</table>`;
}

/* ── Main handler ─────────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  const reqOrigin = req.headers['origin'] || '';
  setCorsHeaders(res, reqOrigin);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  // Rate limiting
  const rawIp  = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || '';
  const ipKey  = getRateLimitKey(rawIp);
  if (isRateLimited(ipKey)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a few minutes before trying again.' });
  }

  // Parse body
  let body;
  try {
    body = typeof req.body === 'object' ? req.body : JSON.parse(req.body);
  } catch {
    return res.status(400).json({ error: 'Invalid request format.' });
  }

  const formType = sanitize(body.type);
  const ts       = new Date().toISOString();

  try {
    /* ── BOOKING ── */
    if (formType === 'booking') {
      const name      = sanitize(body.name);
      const care_type = sanitize(body.care_type);
      const service   = sanitize(body.service);
      const location  = sanitize(body.location);
      const date      = sanitize(body.date);
      const time      = sanitize(body.time);
      const notes     = sanitizeLong(body.notes);

      if (!name || !care_type || !location || !date || !time) {
        return res.status(422).json({ error: 'Required booking fields are missing.' });
      }

      await writeAirtable(process.env.AIRTABLE_BOOKINGS_TABLE, {
        Name: name, CareType: care_type, Service: service,
        Location: location, Date: date, Time: time,
        Notes: notes, Timestamp: ts,
      });

      await sendEmail(
        `📅 New Booking: ${name}`,
        bookingEmailHtml({ name, care_type, service, location, date, time, notes })
      );

      return res.status(200).json({ ok: true });
    }

    /* ── CALLBACK ── */
    if (formType === 'callback') {
      const name           = sanitize(body.name);
      const phone          = sanitize(body.phone);
      const preferred_time = sanitize(body.preferred_time);

      if (!name || !phone) {
        return res.status(422).json({ error: 'Name and phone are required for callback requests.' });
      }

      await writeAirtable(process.env.AIRTABLE_CALLBACKS_TABLE, {
        Name: name, Phone: phone, PreferredTime: preferred_time, Timestamp: ts,
      });

      await sendEmail(
        `📞 New Callback Request: ${name}`,
        callbackEmailHtml({ name, phone, preferred_time })
      );

      return res.status(200).json({ ok: true });
    }

    /* ── APPLICATION ── */
    if (formType === 'application') {
      const first_name      = sanitize(body.first_name);
      const last_name       = sanitize(body.last_name);
      const email           = sanitize(body.email);
      const phone           = sanitize(body.phone);
      const mnc_registration = sanitize(body.mnc_registration);
      const experience      = sanitize(body.experience);
      const speciality      = sanitize(body.speciality);
      const message         = sanitizeLong(body.message);

      if (!first_name || !last_name || !email || !phone) {
        return res.status(422).json({ error: 'Required application fields are missing.' });
      }

      // Basic email format check server-side
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(422).json({ error: 'Invalid email address.' });
      }

      await writeAirtable(process.env.AIRTABLE_APPS_TABLE, {
        FirstName: first_name, LastName: last_name, Email: email,
        Phone: phone, MNC_Registration: mnc_registration,
        Experience: experience, Speciality: speciality,
        Message: message, Timestamp: ts,
      });

      await sendEmail(
        `👩‍⚕️ New Nurse Application: ${first_name} ${last_name}`,
        applicationEmailHtml({ first_name, last_name, email, phone, mnc_registration, experience, speciality, message })
      );

      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown form type.' });

  } catch (err) {
    console.error('[submit] Handler error:', err.message);
    return res.status(500).json({ error: 'An internal error occurred. Please try again later.' });
  }
};
