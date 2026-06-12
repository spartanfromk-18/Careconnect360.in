 /**
 * POST /api/admin-login
 * Enterprise-grade, secure serverless authentication gateway.
 * 
 * Security features:
 *  - Strict rate limiting via Upstash Redis (prevents brute force)
 *  - Timing-safe password comparison (prevents timing side-channel attacks)
 *  - Standardized JWT generation with 12-hour expiry
 *  - Fail-fast environment variable validation
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/* ── Environment validation (Fail Fast) ──────────────────────── */
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('CRITICAL: JWT_SECRET must be defined and contain at least 32 characters.');
}
if (!ADMIN_PASSWORD) {
  throw new Error('CRITICAL: ADMIN_PASSWORD must be explicitly defined.');
}
if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('CRITICAL: Upstash Redis credentials are missing.');
}

/* ── Rate limiter (Upstash Redis - Strict for Login) ─────────── */
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Strict limit: 5 attempts per 5 minutes per IP
const loginLimiter = new Ratelimit({
  redis: redis,
  limiter: Ratelimit.slidingWindow(5, "5 m"),
  analytics: true,
});

/* ── CORS helper ──────────────────────────────────────────────── */
function setCorsHeaders(res, reqOrigin) {
  if (ALLOWED_ORIGIN && reqOrigin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

/* ── Timing-safe password comparison ─────────────────────────── */
function safeCompare(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Run a dummy comparison to neutralize timing side-channels
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/* ── Main handler ─────────────────────────────────────────────── */
export default async function handler(req, res) {
  const reqOrigin = req.headers['origin'] || '';
  setCorsHeaders(res, reqOrigin);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  // 1. Rate Limiting (Distributed via Upstash)
  const rawIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  const ipKey = crypto.createHash('sha256').update(rawIp).digest('hex').slice(0, 16);
  
  const { success } = await loginLimiter.limit(ipKey);
  if (!success) {
    return res.status(429).json({ error: 'Too many login attempts. Please wait 5 minutes before trying again.' });
  }

  // 2. Safe Body Parsing
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Malformed request payload.' });
  }

  if (!body || typeof body.password !== 'string') {
    return res.status(400).json({ error: 'Malformed request payload.' });
  }

  // 3. Authentication
  const password = body.password.trim();
  if (!safeCompare(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Authentication failed. Incorrect credentials.' });
  }

  // 4. Generate Standardized JWT
  const token = jwt.sign(
    { role: 'admin' },
    JWT_SECRET,
    { 
      expiresIn: '12h', 
      algorithm: 'HS256',
      issuer: 'careconnect360'
    }
  );

  return res.status(200).json({ ok: true, token });
}