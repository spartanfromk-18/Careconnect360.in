// Live Web Patch: Hardened Order Creation Node
// File: api/create-order.js
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import SecurityUtils, { setCorsHeaders, withTimeout } from './security-utils.js';
import { makeLogger, captureException } from '../lib/logger.js';

const REQUIRED_ENV = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'ALLOWED_ORIGIN'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) throw new Error(`[create-order] CRITICAL: Missing ${key}`);
}

const CONFIG = {
  RATE_LIMITS: { STANDARD: { requests: 5, window: '5 m' } },
  // PRICE LOCK: the booking fee is fixed server-side at ₹500 (50000 paise).
  // The client NEVER gets to influence the order amount or currency.
  EXPECTED_BOOKING_FEE_PAISE: 50000,
  EXPECTED_CURRENCY: 'INR',
  IDEMPOTENCY_TTL: 86400,
};

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ratelimit = new Ratelimit({ 
  redis, 
  limiter: Ratelimit.slidingWindow(CONFIG.RATE_LIMITS.STANDARD.requests, CONFIG.RATE_LIMITS.STANDARD.window) 
});

const log = makeLogger('create-order');

export default async function handler(req, res) {
  const requestId = SecurityUtils.generateRequestId();
  setCorsHeaders(res, req.headers['origin'] || '', { allowHeaders: 'Content-Type, Authorization, X-Idempotency-Key' });
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', requestId });

  try {
    const rawIp = SecurityUtils.extractIP(req.headers);
    if (rawIp === 'invalid') return res.status(400).json({ error: 'Invalid request source', requestId });
    
    const ipKey = SecurityUtils.hashPII(rawIp);
    const idempotencyKey = req.headers['x-idempotency-key'];

    if (idempotencyKey) {
      const existingOrder = await redis.get(`idempotency:${idempotencyKey}`);
      if (existingOrder) return res.status(200).json(JSON.parse(existingOrder));
    }

    const { success, reset } = await ratelimit.limit(ipKey);
    if (!success) return res.status(429).json({ 
      error: 'Too many payment requests.', 
      requestId, 
      retryAfter: Math.ceil((reset - Date.now()) / 1000) 
    });

    let body;
    try { body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}'); } 
    catch { return res.status(400).json({ error: 'Malformed JSON payload', requestId }); }

    const { amount, currency, receiptId, customer } = body;

    // PRICE LOCK (server-side pricing integrity): the order amount and
    // currency are hardcoded server-side and NEVER derived from the client.
    // Payloads attempting to inject a custom price or currency are rejected
    // outright. A legacy client echoing amount: 500 (rupees = 50000 paise)
    // remains accepted for backward compatibility.
    if (amount !== undefined && amount !== null && Number(amount) * 100 !== CONFIG.EXPECTED_BOOKING_FEE_PAISE) {
      return res.status(400).json({ error: 'Price override rejected: booking fee is fixed at ₹500.', requestId });
    }
    if (currency !== undefined && currency !== null && String(currency).toUpperCase() !== CONFIG.EXPECTED_CURRENCY) {
      return res.status(400).json({ error: 'Currency override rejected: only INR is supported.', requestId });
    }

    const finalReceiptId = receiptId || `CC360_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const orderOptions = {
      amount: CONFIG.EXPECTED_BOOKING_FEE_PAISE,
      currency: CONFIG.EXPECTED_CURRENCY,
      receipt: finalReceiptId,
      payment_capture: 1,
      notes: {
        requestId,
        platform: 'CareConnect360',
        ...(customer?.email ? { customerEmail: customer.email } : {}),
        ...(customer?.phone ? { customerPhone: customer.phone } : {}),
        ...(customer?.name ? { name: customer.name } : {})
      }
    };

    const order = await withTimeout(5000, razorpay.orders.create(orderOptions), 'razorpay.orders.create');

    const responseData = { 
      ok: true, 
      orderId: order.id, 
      amount: order.amount, 
      currency: order.currency, 
      keyId: process.env.RAZORPAY_KEY_ID, 
      receiptId: finalReceiptId,
      requestId 
    };

    if (idempotencyKey) {
      await redis.setex(`idempotency:${idempotencyKey}`, CONFIG.IDEMPOTENCY_TTL, JSON.stringify(responseData));
    }

    return res.status(200).json(responseData);
  } catch (error) {
    log({ event: 'ORDER_CREATION_FAILED', error: error.message, requestId }, 'ERROR');
    captureException(error, { event: 'ORDER_CREATION_FAILED', requestId });
    return res.status(500).json({ error: 'Payment initialization failed.', requestId });
  }
}