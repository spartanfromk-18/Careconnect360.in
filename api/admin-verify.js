 /**
POST /api/admin-verify
Secure verification routing with standardized JWT and independent multi-table pagination.
*/
import jwt from 'jsonwebtoken';

/* ── Environment validation (Fail Fast) ──────────────────────── */
const JWT_SECRET = process.env.JWT_SECRET;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('CRITICAL: JWT_SECRET must be defined and contain at least 32 characters.');
}
if (!ALLOWED_ORIGIN) {
  throw new Error('CRITICAL: ALLOWED_ORIGIN must be explicitly defined.');
}

/* ── CORS helper ──────────────────────────────────────────────── */
function setCorsHeaders(res, reqOrigin) {
  if (reqOrigin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

/* ── Safe Airtable Fetch with Pagination ─────────────────────── */
async function fetchRecords(tableName, limit = 50, offsetToken = null) {
  if (!tableName) return { records: [], nextOffset: null };
  const baseUrl = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`;
  const url = offsetToken
    ? `${baseUrl}?pageSize=${limit}&offset=${offsetToken}`
    : `${baseUrl}?pageSize=${limit}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` }
  });
  if (!response.ok) throw new Error(`Airtable fetch failed for ${tableName}`);
  
  const data = await response.json();
  return {
    records: data.records ? data.records.map(r => ({ id: r.id, ...r.fields })) : [],
    nextOffset: data.offset || null
  };
}

function logEvent(data, level = 'INFO') {
  console.log(JSON.stringify({ level, timestamp: new Date().toISOString(), source: 'admin-verify', ...data }));
}

/* ── Main handler ─────────────────────────────────────────────── */
export default async function handler(req, res) {
  const reqOrigin = req.headers['origin'] || '';
  setCorsHeaders(res, reqOrigin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  // 1. Authentication
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed authorization header.' });
  }

  const token = authHeader.slice(7);
  try {
    const session = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], issuer: 'careconnect360' });
    if (session.role !== 'admin') {
      return res.status(403).json({ error: 'Insufficient privileges.' });
    }
  } catch (err) {
    return res.status(401).json({ error: 'Session has expired or token is invalid.' });
  }

  // 2. Parse Pagination Parameters
  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Malformed request payload.' });
  }

  const limit = Math.min(100, Math.max(1, parseInt(body.limit) || 50)); 
  // [CRITICAL FIX] Independent offsets for each Airtable table
  const offsets = body.offsets || {}; 

  try {
    // 3. Fetch paginated records concurrently
    const [bookingsData, callbacksData, applicationsData] = await Promise.all([
      fetchRecords(process.env.AIRTABLE_BOOKINGS_TABLE, limit, offsets.bookings || null),
      fetchRecords(process.env.AIRTABLE_CALLBACKS_TABLE, limit, offsets.callbacks || null),
      fetchRecords(process.env.AIRTABLE_APPS_TABLE, limit, offsets.applications || null),
    ]);

    return res.status(200).json({ 
      ok: true, 
      bookings: bookingsData.records,
      callbacks: callbacksData.records,
      applications: applicationsData.records,
      pagination: {
        limit,
        offsets: {
          bookings: bookingsData.nextOffset,
          callbacks: callbacksData.nextOffset,
          applications: applicationsData.nextOffset
        }
      }
    });
  } catch (error) {
    logEvent({ error: error.message }, 'ERROR');
    return res.status(500).json({ error: 'Internal server error.' });
  }
}