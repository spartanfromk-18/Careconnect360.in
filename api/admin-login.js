import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { assertAdminAllowlistConfigured, isAdminIpAllowed, extractIP, setCorsHeaders } from './security-utils.js';
import { makeLogger, captureException } from '../lib/logger.js';

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;

if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('CRITICAL: JWT_SECRET must be at least 32 characters.');
if (!ADMIN_PASSWORD_HASH) throw new Error('CRITICAL: ADMIN_PASSWORD_HASH must be defined.');
if (!process.env.ALLOWED_ORIGIN) throw new Error('CRITICAL: ALLOWED_ORIGIN must be explicitly defined.');
assertAdminAllowlistConfigured();

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const loginLimiter = new Ratelimit({
  redis: redis,
  limiter: Ratelimit.slidingWindow(5, "5 m"),
});

const log = makeLogger('admin-login');

export default async function handler(req, res) {
  const reqOrigin = req.headers['origin'] || '';
  setCorsHeaders(res, reqOrigin, { allowHeaders: 'Content-Type' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  try {
    if (!isAdminIpAllowed(req.headers)) return res.status(403).json({ error: 'Access denied.' });

    const rawIp = extractIP(req.headers);
    if (rawIp === 'invalid') return res.status(400).json({ error: 'Invalid request source.' });
    const ipKey = crypto.createHash('sha256').update(rawIp).digest('hex').slice(0, 16);

    // Fail-open rate limiting: a Redis outage must not lock out legitimate admins.
    // bcrypt verification and the IP allowlist still gate every attempt.
    try {
      const { success } = await loginLimiter.limit(ipKey);
      if (!success) {
        log({ event: 'RATE_LIMIT_EXCEEDED', ipKey }, 'WARN');
        return res.status(429).json({ error: 'Too many login attempts. Please wait 5 minutes.' });
      }
    } catch (redisError) {
      log({ event: 'RATE_LIMIT_BYPASS', error: redisError.message, ipKey }, 'WARN');
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

    const password = body.password;
    if (!(await bcrypt.compare(password, ADMIN_PASSWORD_HASH))) {
      log({ event: 'AUTH_FAILED', ipKey }, 'WARN');
      return res.status(401).json({ error: 'Authentication failed. Incorrect credentials.' });
    }

    const token = jwt.sign({ role: 'admin', jti: crypto.randomUUID() }, JWT_SECRET, { expiresIn: '12h', algorithm: 'HS256', issuer: 'careconnect360' });

    log({ event: 'AUTH_SUCCESS', ipKey }, 'INFO');
    
    // Send token in body for client-side sessionStorage (matching login.html expectation)
    return res.status(200).json({ 
      ok: true, 
      token: token, 
      expiresIn: 12 * 60 * 60 
    });
  } catch (error) {
    log({ event: 'UNHANDLED_ERROR', error: error.message }, 'ERROR');
    captureException(error, { event: 'UNHANDLED_ERROR' });
    return res.status(500).json({ error: 'An internal error occurred.' });
  }
}