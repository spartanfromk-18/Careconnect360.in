 /**
 * POST /api/admin-login
 * Hardened, zero-dependency serverless authentication gateway.
 */

'use strict';

const crypto = require('crypto');

// Enforce strict runtime constraints on configuration variables
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('CRITICAL: JWT_SECRET must be defined and contain at least 32 characters.');
}
if (!ADMIN_PASSWORD) {
  throw new Error('CRITICAL: ADMIN_PASSWORD must be explicitly defined.');
}

function setCorsHeaders(res, reqOrigin) {
  // Prevent empty origin or missing environment configuration bypasses
  if (ALLOWED_ORIGIN && reqOrigin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

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

module.exports = async function handler(req, res) {
  const reqOrigin = req.headers['origin'] || '';
  setCorsHeaders(res, reqOrigin);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  // Leverage Vercel's native pre-parsed body context securely
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!body || typeof body.password !== 'string') {
    return res.status(400).json({ error: 'Malformed request payload.' });
  }

  const password = body.password.trim();
  if (!safeCompare(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Authentication failed. Incorrect credentials.' });
  }

  // Generate highly secure tokens with standard HMAC-SHA256 signatures
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + (12 * 60 * 60); // 12-hour expiration window
  const payload = Buffer.from(JSON.stringify({ role: 'admin', exp })).toString('base64url');
  
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return res.status(200).json({ ok: true, token: `${header}.${payload}.${signature}` });
};
