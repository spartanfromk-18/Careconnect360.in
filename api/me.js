/**
 * GET /api/me
 * Server-side verification of the caller's Supabase session (Bearer access
 * token). Returns the authenticated user plus their profile row. Used by
 * client pages as a trust anchor for role-based routing — the DB (RLS) is
 * still the source of truth for data access.
 */
import { createClient } from '@supabase/supabase-js';
import { setCorsHeaders } from './security-utils.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('CRITICAL: SUPABASE_URL and SUPABASE_ANON_KEY must be defined.');
}

export default async function handler(req, res) {
  const reqOrigin = req.headers['origin'] || '';
  setCorsHeaders(res, reqOrigin, { methods: 'GET, OPTIONS', allowHeaders: 'Content-Type, Authorization' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing session token.' });
  }
  const accessToken = authHeader.slice(7);

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  const { data: { user }, error: userErr } = await supabase.auth.getUser(accessToken);
  if (userErr || !user) return res.status(401).json({ error: 'Invalid or expired session.' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, full_name, avatar_url, email')
    .eq('id', user.id)
    .maybeSingle();

  return res.status(200).json({
    ok: true,
    user: { id: user.id, email: user.email },
    profile: profile || null,
  });
}
