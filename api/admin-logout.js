 import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

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

if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('CRITICAL: JWT_SECRET must be at least 32 characters.');
if (!ALLOWED_ORIGIN) throw new Error('CRITICAL: ALLOWED_ORIGIN must be explicitly defined.');

function setCorsHeaders(res, reqOrigin) {
  if (reqOrigin === ALLOWED_ORIGIN) res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
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
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header.' });
  }

  const token = authHeader.slice(7);
  try {
    jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], issuer: 'careconnect360' });
  } catch {
    return res.status(401).json({ error: 'Session expired or invalid.' });
  }

  // Stateless JWT — server has nothing to revoke.
  // Client is responsible for discarding the token after this call.
  return res.status(200).json({ ok: true, message: 'Logged out successfully.' });
}