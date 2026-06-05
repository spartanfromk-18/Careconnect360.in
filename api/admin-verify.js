/**
 * POST /api/admin-verify
 * Verifies the Bearer JWT, then fetches all Airtable records
 * (Bookings, Callbacks, Applications) and returns them to the admin dashboard.
 *
 * Auth:   Authorization: Bearer <jwt>
 * Secret: process.env.JWT_SECRET — NEVER hardcoded.
 */

'use strict';

const crypto = require('crypto');

/* ── Env validation ─────────────────────────────────────────────── */
const REQUIRED = [
  'JWT_SECRET',
  'AIRTABLE_API_KEY',
  'AIRTABLE_BASE_ID',
  'AIRTABLE_BOOKINGS_TABLE',
  'AIRTABLE_CALLBACKS_TABLE',
  'AIRTABLE_APPS_TABLE',
];
for (const key of REQUIRED) {
  if (!process.env[key]) console.error(`[admin-verify] FATAL: missing env var ${key}`);
}

/* ── CORS ───────────────────────────────────────────────────────── */
function setCorsHeaders(res, reqOrigin) {
  const allowed = process.env.ALLOWED_ORIGIN || '';
  if (reqOrigin === allowed) {
    res.setHeader('Access-Control-Allow-Origin', allowed);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

/* ── JWT verification (HMAC-SHA256, no external lib) ────────────── */
function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function base64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function verifyJWT(token, secret) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) return null;

  const [headerB64, bodyB64, sigB64] = parts;
  const signing  = `${headerB64}.${bodyB64}`;
  const expected = base64url(
    crypto.createHmac('sha256', secret).update(signing).digest()
  );

  // Timing-safe signature comparison
  const expBuf = Buffer.from(expected, 'utf8');
  const sigBuf = Buffer.from(sigB64,   'utf8');
  if (expBuf.length !== sigBuf.length) return null;
  if (!crypto.timingSafeEqual(expBuf, sigBuf)) return null;

  let payload;
  try {
    payload = JSON.parse(base64urlDecode(bodyB64));
  } catch {
    return null;
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return null;
  if (payload.role !== 'admin')          return null;

  return payload;
}

/* ── Airtable fetch (all records, handling pagination) ──────────── */
async function fetchAllRecords(tableName) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  const apiKey = process.env.AIRTABLE_API_KEY;
  const records = [];
  let offset    = null;

  do {
    const url = new URL(
      `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`
    );
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('sort[0][field]',     'Timestamp');
    url.searchParams.set('sort[0][direction]', 'desc');
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Airtable error ${res.status} on ${tableName}: ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    (json.records || []).forEach(r => records.push(r.fields));
    offset = json.offset || null;
  } while (offset);

  return records;
}

/* ── Handler ─────────────────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  const reqOrigin = req.headers['origin'] || '';
  setCorsHeaders(res, reqOrigin);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed.' });

  // Extract Bearer token
  const authHeader = req.headers['authorization'] || '';
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'No token provided.' });
  }

  const payload = verifyJWT(token, process.env.JWT_SECRET || '');
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }

  // Fetch all data in parallel
  try {
    const [bookings, callbacks, applications] = await Promise.all([
      fetchAllRecords(process.env.AIRTABLE_BOOKINGS_TABLE),
      fetchAllRecords(process.env.AIRTABLE_CALLBACKS_TABLE),
      fetchAllRecords(process.env.AIRTABLE_APPS_TABLE),
    ]);

    return res.status(200).json({ ok: true, bookings, callbacks, applications });
  } catch (err) {
    console.error('[admin-verify] Airtable fetch error:', err.message);
    return res.status(500).json({ error: 'Failed to load dashboard data. Please try again.' });
  }
};
