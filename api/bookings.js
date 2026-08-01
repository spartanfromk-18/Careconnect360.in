/**
 * GET /api/my-bookings
 * Returns the logged-in customer's bookings, with assigned nurse details
 * and invoice info joined in. Uses the CALLER'S session token (anon key +
 * Authorization header), NOT the service role key — this means Row Level
 * Security actually does the access control here. If a customer's token
 * is somehow used to request another customer's data, RLS blocks it at
 * the database, not in this code.
 */
import { createClient } from '@supabase/supabase-js';
import { makeLogger, captureException } from '../lib/logger.js';
import { setCorsHeaders } from './security-utils.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY; // publishable key, not service role
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('CRITICAL: SUPABASE_URL and SUPABASE_ANON_KEY must be defined.');
}

const log = makeLogger('bookings');

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

  // Client scoped to THIS request's user — critical: do not reuse a
  // module-level client here, or requests could leak sessions across
  // concurrent invocations in a serverless environment.
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } }
  });

  const { data: { user }, error: userErr } = await supabase.auth.getUser(accessToken);
  if (userErr || !user) return res.status(401).json({ error: 'Invalid or expired session.' });

  try {
    const { data, error } = await supabase
      .from('bookings')
      .select(`
        id, name, service, care_type, location, scheduled_date, scheduled_time,
        status, amount_paise, created_at,
        nurse:nurses ( first_name, last_name, speciality, phone ),
        invoice:invoices ( invoice_number, total_paise, status, issued_at )
      `)
      .eq('customer_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);

    return res.status(200).json({ ok: true, bookings: data });
  } catch (error) {
    log({ event: 'BOOKINGS_FETCH_FAILED', error: error.message }, 'ERROR');
    captureException(error, { event: 'BOOKINGS_FETCH_FAILED' });
    return res.status(500).json({ error: 'Could not load bookings.' });
  }
}