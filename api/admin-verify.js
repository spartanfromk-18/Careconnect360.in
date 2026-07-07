 import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';

const JWT_SECRET = process.env.JWT_SECRET;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('CRITICAL: JWT_SECRET must be at least 32 characters.');
if (!ALLOWED_ORIGIN) throw new Error('CRITICAL: ALLOWED_ORIGIN must be explicitly defined.');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('CRITICAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be defined.');
}

// Service role key bypasses RLS — same trust boundary as the JWT admin check below.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ── IP Allowlist ─────────────────────────────────────────────── */
const ADMIN_ALLOWED_IPS = (process.env.ADMIN_ALLOWED_IPS || '')
  .split(',')
  .map(ip => ip.trim())
  .filter(Boolean);

function isIpAllowed(req) {
  if (ADMIN_ALLOWED_IPS.length === 0) return true;
  const rawIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || '';
  return ADMIN_ALLOWED_IPS.includes(rawIp);
}

function setCorsHeaders(res, reqOrigin) {
  if (reqOrigin === ALLOWED_ORIGIN) res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

/**
 * Fetches a page of records from a Supabase table with basic offset pagination.
 * Mirrors the shape of the original Airtable fetchRecords() so the response
 * contract to the admin dashboard frontend doesn't need to change.
 */
async function fetchRecords(tableName, limit = 50, offset = 0) {
  const { data, error, count } = await supabase
    .from(tableName)
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`Supabase fetch failed for ${tableName}: ${error.message}`);

  const nextOffset = (offset + limit < (count ?? 0)) ? offset + limit : null;
  return { records: data || [], nextOffset };
}

export default async function handler(req, res) {
  const reqOrigin = req.headers['origin'] || '';
  setCorsHeaders(res, reqOrigin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  if (!isIpAllowed(req)) {
    return res.status(403).json({ error: 'Access denied.' });
  }

  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing authorization header.' });

  const token = authHeader.slice(7);
  try {
    const session = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], issuer: 'careconnect360' });
    if (session.role !== 'admin') return res.status(403).json({ error: 'Insufficient privileges.' });
  } catch {
    return res.status(401).json({ error: 'Session expired or invalid.' });
  }

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Malformed request payload.' }); }

  const limit = Math.min(100, Math.max(1, parseInt(body.limit) || 50));

  // Offsets are now plain integers per table, replacing Airtable's opaque
  // pagination tokens — the frontend should pass back the nextOffset values
  // it received, same field names as before.
  const offsets = body.offsets || {};

  try {
    const [bookingsData, callbacksData, applicationsData, paymentsData] = await Promise.all([
      fetchRecords('bookings', limit, offsets.bookings || 0),
      fetchRecords('callbacks', limit, offsets.callbacks || 0),
      fetchRecords('applications', limit, offsets.applications || 0),
      fetchRecords('payments', limit, offsets.payments || 0), // NEW — original never surfaced this table
    ]);

    return res.status(200).json({
      ok: true,
      bookings: bookingsData.records,
      callbacks: callbacksData.records,
      applications: applicationsData.records,
      payments: paymentsData.records,
      pagination: {
        limit,
        offsets: {
          bookings: bookingsData.nextOffset,
          callbacks: callbacksData.nextOffset,
          applications: applicationsData.nextOffset,
          payments: paymentsData.nextOffset,
        }
      }
    });
  } catch (error) {
    console.error('[admin-verify] Handler error:', error.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}