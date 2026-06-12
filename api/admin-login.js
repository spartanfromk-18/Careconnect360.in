 /**
 * POST /api/admin-login
 * Enterprise-grade authentication using Bcrypt and Upstash Rate Limiting.
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs'; // <-- NEW: Bcrypt for password hashing
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/* ── Environment validation ──────────────────────────────────── */
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH; // <-- Renamed for clarity
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('CRITICAL: JWT_SECRET must be at least 32 characters.');
}
if (!ADMIN_PASSWORD_HASH) {
  throw new Error('CRITICAL: ADMIN_PASSWORD_HASH must be defined.');
}

/* ── Rate limiter ────────────────────────────────────────────── */
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const loginLimiter = new Ratelimit({
  redis: redis,
  limiter: Ratelimit.slidingWindow(5, "5 m"),
});

/* ── CORS helper ─────────────────────────────────────────────── */
function setCorsHeaders(res, reqOrigin) {
  if (ALLOWED_ORIGIN && reqOrigin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

/* ── Main handler ────────────────────────────────────────────── */
export default async function handler(req, res) {
  const reqOrigin = req.headers['origin'] || '';
  setCorsHeaders(res, reqOrigin);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  // 1. Rate Limiting
  const rawIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  const ipKey = crypto.createHash('sha256').update(rawIp).digest('hex').slice(0, 16);
  
  const { success } = await loginLimiter.limit(ipKey);
  if (!success) {
    return res.status(429).json({ error: 'Too many login attempts. Please wait 5 minutes.' });
  }

  // 2. Parse Body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Malformed request payload.' });
  }

  if (!body || typeof body.password !== 'string') {
    return res.status(400).json({ error: 'Malformed request payload.' });
  }

  // 3. Bcrypt Verification (The Secure Way)
  const password = body.password.trim();
  
  // bcrypt.compare automatically handles the salt and timing-safe comparison!
  const isMatch = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);

  if (!isMatch) {
    return res.status(401).json({ error: 'Authentication failed. Incorrect credentials.' });
  }

  // 4. Generate JWT
  const token = jwt.sign(
    { role: 'admin' },
    JWT_SECRET,
    { expiresIn: '12h', algorithm: 'HS256', issuer: 'careconnect360' }
  );

  return res.status(200).json({ ok: true, token });
}