 /**
 * POST /api/admin-verify
 * Secure verification routing utilizing structural parallel fetching optimizations.
 */

'use strict';

const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

function verifyJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    
    // Explicitly validate signature against tampering attempts
    const validSignature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');

    if (!crypto.timingSafeEqual(Buffer.from(signatureB64), Buffer.from(validSignature))) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;

    return payload;
  } catch {
    return null;
  }
}

// Optimized pagination that minimizes network overhead
async function fetchAllRecords(tableName) {
  if (!tableName) return [];
  
  let records = [];
  let offset = null;
  const baseUrl = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`;

  do {
    const url = offset ? `${baseUrl}?offset=${offset}` : baseUrl;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` }
    });

    if (!response.ok) {
      throw new Error(`Airtable dynamic synchronization failed for table: ${tableName}`);
    }

    const data = await response.json();
    if (data.records) {
      records.push(...data.records.map(r => r.fields));
    }
    offset = data.offset || null;
  } while (offset);

  return records;
}

module.exports = async function handler(req, res) {
  const reqOrigin = req.headers['origin'] || '';
  
  if (ALLOWED_ORIGIN && reqOrigin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed authorization header.' });
  }

  const token = authHeader.slice(7);
  const session = verifyJWT(token);
  if (!session) {
    return res.status(401).json({ error: 'Session has expired or token is invalid.' });
  }

  try {
    // Fetch records concurrently to reduce total response latency
    const [bookings, callbacks, applications] = await Promise.all([
      fetchAllRecords(process.env.AIRTABLE_BOOKINGS_TABLE),
      fetchAllRecords(process.env.AIRTABLE_CALLBACKS_TABLE),
      fetchAllRecords(process.env.AIRTABLE_APPS_TABLE),
    ]);

    return res.status(200).json({ ok: true, bookings, callbacks, applications });
  } catch (error) {
    console.error('[admin-verify Fatal Build Error]:', error.message);
    return res.status(500).json({ error: 'Internal pipeline synchronization failure.' });
  }
};
