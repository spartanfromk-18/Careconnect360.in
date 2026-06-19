 /**
POST /api/admin-login
Enterprise-grade authentication using Bcrypt and Upstash Rate Limiting.
*/
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs'; 
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/* ── Environment validation ──────────────────────────────────── */
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH; 
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('CRITICAL: JWT_SECRET must be at least 32 characters.');
if (!ADMIN_PASSWORD_HASH) throw new Error('CRITICAL: ADMIN_PASSWORD_HASH must be defined.');

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

/* ── Rate limiter ────────────────────────────────────────────── */
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const loginLimiter = new Ratelimit({
  redis: redis,
  limiter: Ratelimit.slidingWindow(5, "5 m"),
});

function setCorsHeaders(res, reqOrigin) {
  if (ALLOWED_ORIGIN && reqOrigin === ALLOWED_ORIGIN) res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

function logEvent(data, level = 'INFO') {
  console.log(JSON.stringify({ level, timestamp: new Date().toISOString(), source: 'admin-login', ...data }));
}

/* ── Main handler ────────────────────────────────────────────── */
export default async function handler(req, res) {
  const reqOrigin = req.headers['origin'] || '';
  setCorsHeaders(res, reqOrigin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  
  if (!isIpAllowed(req)) {                                     
    return res.status(403).json({ error: 'Access denied.' });  
  }    

  const rawIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  const ipKey = crypto.createHash('sha256').update(rawIp).digest('hex').slice(0, 16);
  
  const { success } = await loginLimiter.limit(ipKey);
  if (!success) {
    logEvent({ event: 'RATE_LIMIT_EXCEEDED', ipKey }, 'WARN');
    return res.status(429).json({ error: 'Too many login attempts. Please wait 5 minutes.' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Malformed request payload.' });
  }

  if (!body || typeof body.password !== 'string') {
    return res.status(400).json({ error: 'Malformed request payload.' });
  }

  // [FIX] Removed .trim() to support passwords with intentional leading/trailing whitespace
  const password = body.password; 
  
  const isMatch = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  if (!isMatch) {
    logEvent({ event: 'AUTH_FAILED', ipKey }, 'WARN');
    return res.status(401).json({ error: 'Authentication failed. Incorrect credentials.' });
  }

  const token = jwt.sign(
  { role: 'admin', jti: crypto.randomUUID() },
  JWT_SECRET,
  { expiresIn: '12h', algorithm: 'HS256', issuer: 'careconnect360' }
);
  
  logEvent({ event: 'AUTH_SUCCESS', ipKey }, 'INFO');
  return res.status(200).json({ ok: true, token });
}