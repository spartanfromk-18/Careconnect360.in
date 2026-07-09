 import crypto from 'crypto';
import Razorpay from 'razorpay';
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { createClient } from '@supabase/supabase-js';

const REQUIRED_ENV = [
  'ALLOWED_ORIGIN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'RESEND_API_KEY', 'ADMIN_EMAIL'
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

const hashPII = data => crypto.createHash('sha256').update(String(data || '')).digest('hex').slice(0, 16);

const sanitize = str => typeof str !== 'string' ? '' : str.replace(/[<>"'&]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' })[c]).trim();

const setCors = (res, reqOrigin) => {
  if (reqOrigin === process.env.ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
};

const sendResend = async (to, subject, html) => {
  if (!to) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'CareConnect <noreply@careconnect360.in>', to: [to], subject, html })
  });
  if (!res.ok) throw new Error(`Resend failed: ${await res.text()}`);
};

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

  const rawIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  const ipKey = hashPII(rawIp);
  const { success } = await limiter.limit(ipKey);
  if (!success) return res.status(429).json({ error: 'Too many requests. Try again in 5 minutes.' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } 
  catch { return res.status(400).json({ error: 'Malformed JSON payload.' }); }

  const { type, payment_id } = body;
  if (!type || !SUPPORTED_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid submission type.' });

  const name = sanitize(body.name || body.FullName || '');
  const email = sanitize(body.email || body.Email || '');
  const phone = sanitize(body.phone || body.Phone || '');
  const service = sanitize(body.service || body.Service || '');
  const date = sanitize(body.date || body.PreferredDate || '');
  const message = sanitize(body.message || body.Message || '');

  if (!name || !phone) return res.status(400).json({ error: 'Name and phone number are required.' });
  if (type !== 'callback' && !email) return res.status(400).json({ error: 'Email is required for this submission.' });

  const logContext = { ipKey, type, emailHash: hashPII(email), phoneHash: hashPII(phone) };

  try {
    if (type === 'booking') {
      if (!payment_id) return res.status(402).json({ error: 'Payment verification required.' });

      const claimed = await redis.set(`payment_used:${payment_id}`, '1', { nx: true, ex: 86400 });
      if (!claimed) {
        console.error('[submit] Payment ID replay attempt blocked:', payment_id, logContext);
        return res.status(409).json({ error: 'This payment has already been used for a booking.' });
      }

      let payment;
      try { payment = await razorpay.payments.fetch(payment_id); } 
      catch (err) {
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
        const { error } = await supabase.from('bookings').insert({
          name,
          service,
          phone,
          email,
          amount_paise: EXPECTED_BOOKING_FEE_PAISE,
          payment_id,
          created_at: new Date().toISOString()
        });

        if (error) throw new Error(`Supabase insert failed: ${error.message}`);
      } catch (dbError) {
        console.error('[submit] Database insert failed, releasing Redis lock:', dbError.message, logContext);
        await redis.del(`payment_used:${payment_id}`);
        throw dbError;
      }

      const customerHtml = `<p>Hi ${name},</p><p>We have received your booking fee of ₹500. Our care coordinator will contact you shortly at ${phone}.</p>`;
      const adminHtml = `<p>New paid booking received.</p><p>Name: ${name}<br>Phone: ${phone}<br>Service: ${service}</p>`;
      
      await Promise.allSettled([
        sendResend(email, 'Booking Confirmed - CareConnect360', customerHtml),
        sendResend(process.env.ADMIN_EMAIL, '🔔 New Paid Booking', adminHtml)
      ]);

      return res.status(200).json({ ok: true });
    }

    if (type === 'callback') {
      const { error } = await supabase.from('callbacks').insert({
        name: name,
        phone: phone,
        preferred_time: date,
        created_at: new Date().toISOString()
      });

      if (error) throw new Error(`Supabase callback insert failed: ${error.message}`);

      const adminHtml = `<p>New callback request.</p><p>Name: ${name}<br>Phone: ${phone}</p>`;
      await sendResend(process.env.ADMIN_EMAIL, '🔔 New Callback Request', adminHtml).catch(() => {});
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

      const applicantHtml = `<p>Hi ${firstName},</p><p>Thank you for applying to CareConnect360. We have received your application.</p>`;
      await sendResend(email, 'Application Received - CareConnect360', applicantHtml).catch(() => {});
      return res.status(200).json({ ok: true });
    }
  } catch (error) {
    console.error('[submit] Unhandled error:', error.message, logContext);
    return res.status(500).json({ error: 'An internal error occurred.' });
  }
}