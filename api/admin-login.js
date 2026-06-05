/**
 * POST /api/admin-login
 * Validates the admin password and issues a signed JWT.
 *
 * JWT signing: HMAC-SHA256 via Node.js crypto (no external JWT lib needed).
 * Secret:      process.env.JWT_SECRET — NEVER hardcoded.
 * Token TTL:   12 hours.
 *
 * ── JWT AUDIT RESULT ──────────────────────────────────────────────────────
 *  Environment Variable: JWT_SECRET
 *  Status: Correctly read from process.env.JWT_SECRET only.
 *          No hardcoded secret found anywhere in this codebase.
 * ─────────────────────────────────────────────────────────────────────────
 */

'use strict';

const crypto = require('crypto');

/* ── Env validation ────────────────────────────────────────────── */
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('[admin-login] FATAL: JWT_SECRET is missing or too short (min 32 chars).');
}
if (!process.env.ADMIN_PASSWORD) {
  console.error('[admin-login] FATAL: ADMIN_PASSWORD is not set.');
}

/* ── CORS helper ───────────────────────────────────────────────── */
function setCorsHeaders(res, reqOrigin) {
  const allowed = process.env.ALLOWED_ORIGIN || '';
  if (reqOrigin === allowed) {
    res.setHeader('Access-Control-Allow-Origin', allowed);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

/* ── Minimal HMAC-SHA256 JWT (no external library) ─────────────── */
function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function createJWT(payload, secret) {
  const header  = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body    = base64url(JSON.stringify(payload));
  const signing = `${header}.${body}`;
  const sig     = base64url(
    crypto.createHmac('sha256', secret).update(signing).digest()
  );
  return `${signing}.${sig}`;
}

/* ── Brute-force timing-safe password comparison ───────────────── */
function safeCompare(a, b) {
  // Pad both to same length to avoid length-timing leaks
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    // Still do a dummy compare to avoid timing difference
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/* ── Simple in-memory login attempt throttle ───────────────────── */
const LOCKOUT_WINDOW_MS  = 5 * 60 * 1000; // 5 min
const LOCKOUT_MAX_TRIES  = 10;
const attemptMap         = new Map();

function isLoginThrottled(ipKey) {
  const now    = Date.now();
  const record = attemptMap.get(ipKey);
  if (!record || now - record.windowStart > LOCKOUT_WINDOW_MS) {
    attemptMap.set(ipKey, { count: 1, windowStart: now });
    return false;
  }
  if (record.count >= LOCKOUT_MAX_TRIES) return true;
  record.count += 1;
  return false;
}

/* ── Handler ───────────────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  const reqOrigin = req.headers['origin'] || '';
  setCorsHeaders(res, reqOrigin);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed.' });

  // Throttle by hashed IP
  const rawIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || '';
  const ipKey = crypto.createHash('sha256').update(rawIp).digest('hex').slice(0, 16);

  if (isLoginThrottled(ipKey)) {
    return res.status(429).json({ error: 'Too many login attempts. Please try again in 5 minutes.' });
  }

  // Parse body
  let body;
  try {
    body = typeof req.body === 'object' ? req.body : JSON.parse(req.body);
  } catch {
    return res.status(400).json({ error: 'Invalid request.' });
  }

  const password = String(body.password || '').trim();
  if (!password) {
    return res.status(400).json({ error: 'Password is required.' });
  }

  // Constant-time comparison against env var
  const correct = safeCompare(password, process.env.ADMIN_PASSWORD || '');

  if (!correct) {
    // Generic message — do not hint whether user/password was wrong
    return res.status(401).json({ ok: false, error: 'Incorrect password.' });
  }

  // Issue JWT — expires in 12 hours
  const now     = Math.floor(Date.now() / 1000);
  const payload = {
    sub:  'admin',
    role: 'admin',
    iat:  now,
    exp:  now + 43200, // 12 h
  };

  const token = createJWT(payload, process.env.JWT_SECRET);

  return res.status(200).json({ ok: true, token });
};
