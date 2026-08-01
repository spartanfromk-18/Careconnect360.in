import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';
import { isTokenBlocked } from '../lib/redis-blocklist.js';
import { makeLogger, captureException } from '../lib/logger.js';
import { assertAdminAllowlistConfigured, isAdminIpAllowed, setCorsHeaders } from './security-utils.js';

const JWT_SECRET = process.env.JWT_SECRET;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('CRITICAL: JWT_SECRET must be at least 32 characters.');
if (!ALLOWED_ORIGIN) throw new Error('CRITICAL: ALLOWED_ORIGIN must be explicitly defined.');
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('CRITICAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be defined.');
assertAdminAllowlistConfigured();

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const log = makeLogger('admin-verify');

const sanitizeOffset = (value) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || Number.isNaN(n) || n < 0) return 0;
  return n;
};

export default async function handler(req, res) {
  const reqOrigin = req.headers['origin'] || '';
  setCorsHeaders(res, reqOrigin, { allowHeaders: 'Content-Type, Authorization' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  if (!isAdminIpAllowed(req.headers)) {
    log({ event: 'IP_DENIED' }, 'WARN');
    return res.status(403).json({ error: 'Access denied.' });
  }

  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing authorization header.' });
  const token = authHeader.slice(7);

  let session;
  try {
    session = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], issuer: 'careconnect360' });
    if (session.role !== 'admin') return res.status(403).json({ error: 'Insufficient privileges.' });
  } catch {
    return res.status(401).json({ error: 'Session expired or invalid.' });
  }

  if (await isTokenBlocked(session.jti)) {
    log({ event: 'BLOCKED_TOKEN_USED', jti: session.jti }, 'WARN');
    return res.status(401).json({ error: 'Session has been revoked.' });
  }

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Malformed request payload.' }); }

  const limit = Math.min(100, Math.max(1, Number.parseInt(body.limit, 10) || 50));
  const offsets = body.offsets || {};
  const cleanOffsets = {
    bookings: sanitizeOffset(offsets.bookings),
    callbacks: sanitizeOffset(offsets.callbacks),
    applications: sanitizeOffset(offsets.applications),
    payments: sanitizeOffset(offsets.payments),
  };

  try {
    const { data, error } = await supabase.rpc('admin_dashboard_data', {
      p_limit: limit,
      p_bookings_offset: cleanOffsets.bookings,
      p_callbacks_offset: cleanOffsets.callbacks,
      p_applications_offset: cleanOffsets.applications,
      p_payments_offset: cleanOffsets.payments,
    });

    if (error) throw new Error(`RPC admin_dashboard_data failed: ${error.message}`);

    const nextOffset = (arr, currentOffset) =>
      arr.length === limit ? currentOffset + limit : null;

    return res.status(200).json({
      ok: true,
      bookings: data.bookings,
      callbacks: data.callbacks,
      applications: data.applications,
      payments: data.payments,
      pagination: {
        limit,
        offsets: {
          bookings: nextOffset(data.bookings, cleanOffsets.bookings),
          callbacks: nextOffset(data.callbacks, cleanOffsets.callbacks),
          applications: nextOffset(data.applications, cleanOffsets.applications),
          payments: nextOffset(data.payments, cleanOffsets.payments),
        }
      }
    });
  } catch (error) {
    log({ event: 'HANDLER_ERROR', error: error.message }, 'ERROR');
    captureException(error, { event: 'HANDLER_ERROR' });
    return res.status(500).json({ error: 'Internal server error.' });
  }
}
