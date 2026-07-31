import jwt from 'jsonwebtoken';
import { blocklistToken } from '../lib/redis-blocklist.js';
import { makeLogger } from '../lib/logger.js';
import { assertAdminAllowlistConfigured, isAdminIpAllowed, setCorsHeaders } from './security-utils.js';

const JWT_SECRET = process.env.JWT_SECRET;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('CRITICAL: JWT_SECRET must be at least 32 characters.');
if (!ALLOWED_ORIGIN) throw new Error('CRITICAL: ALLOWED_ORIGIN must be explicitly defined.');
assertAdminAllowlistConfigured();

const log = makeLogger('admin-logout');

export default async function handler(req, res) {
  const reqOrigin = req.headers['origin'] || '';
  setCorsHeaders(res, reqOrigin, { allowHeaders: 'Content-Type, Authorization' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  if (!isAdminIpAllowed(req.headers)) return res.status(403).json({ error: 'Access denied.' });

  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header.' });
  }
  const token = authHeader.slice(7);

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], issuer: 'careconnect360' });
  } catch {
    return res.status(401).json({ error: 'Session expired or invalid.' });
  }

  const remainingSeconds = decoded.exp ? decoded.exp - Math.floor(Date.now() / 1000) : 12 * 60 * 60;
  try {
    await blocklistToken(decoded.jti, remainingSeconds);
    log({ event: 'TOKEN_REVOKED', jti: decoded.jti }, 'INFO');
  } catch (err) {
    log({ event: 'REVOCATION_FAILED', jti: decoded.jti, error: err.message }, 'CRITICAL');
    return res.status(503).json({ error: 'Logout could not be confirmed. Please try again.' });
  }

  return res.status(200).json({ ok: true, message: 'Logged out successfully.' });
}
