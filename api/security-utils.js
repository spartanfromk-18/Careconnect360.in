// Security utility functions for API handlers
import crypto from 'crypto';
import net from 'net';

const CONFIG = {
  AMOUNT_LIMITS: { MIN: 1, MAX: 500000 },
  ALLOWED_CURRENCIES: ['INR', 'USD', 'EUR', 'GBP'],
};

export const hashPII = (data) => {
  return crypto.createHash('sha256').update(String(data || '')).digest('hex').slice(0, 16);
};

export const extractIP = (headers) => {
  // Vercel's edge appends the real client IP as the LAST entry of x-forwarded-for,
  // after any client-supplied values — so the right-most value is the trusted one
  // for requests flowing through Vercel. If this deployment ever moves off Vercel
  // or is fronted by a proxy that does not sanitize XFF, this logic MUST be
  // revisited (use the immediate TCP peer / trust-proxy semantics instead).
  const xff = headers['x-forwarded-for'];
  if (!xff) return 'invalid';
  const rawIp = xff.split(',').pop()?.trim() || '';
  if (!net.isIP(rawIp)) return 'invalid';
  return rawIp;
};

const ADMIN_ALLOWED_IPS = (process.env.ADMIN_ALLOWED_IPS || '').split(',').map(ip => ip.trim()).filter(Boolean);

export const assertAdminAllowlistConfigured = () => {
  if (ADMIN_ALLOWED_IPS.length === 0) {
    throw new Error('CRITICAL: ADMIN_ALLOWED_IPS must be explicitly defined for admin endpoints.');
  }
  return ADMIN_ALLOWED_IPS;
};

export const isAdminIpAllowed = (headers) => {
  if (ADMIN_ALLOWED_IPS.includes('*')) return true;
  const ip = extractIP(headers);
  if (ip === 'invalid') return false;
  return ADMIN_ALLOWED_IPS.includes(ip);
};

export const getPreviewOrigins = () => (process.env.ALLOWED_PREVIEW_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

export const isAllowedOrigin = (origin) => {
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  return Boolean(origin) && (origin === allowedOrigin || getPreviewOrigins().includes(origin));
};

export const setCorsHeaders = (res, reqOrigin, { methods = 'POST, OPTIONS', allowHeaders = 'Content-Type' } = {}) => {
  if (isAllowedOrigin(reqOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
  }
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', allowHeaders);
  res.setHeader('Vary', 'Origin');
};

export const validateAmount = (amount) => {
  const numAmount = Number(amount);
  if (isNaN(numAmount) || numAmount < CONFIG.AMOUNT_LIMITS.MIN || numAmount > CONFIG.AMOUNT_LIMITS.MAX) {
    throw new Error(`Amount must be between ${CONFIG.AMOUNT_LIMITS.MIN} and ${CONFIG.AMOUNT_LIMITS.MAX}`);
  }
  return numAmount;
};

export const validateCurrency = (currency) => {
  if (typeof currency !== 'string') throw new Error(`Invalid currency type: expected string, got ${typeof currency}`);
  const validatedCurrency = currency.toUpperCase() || 'INR';
  if (!CONFIG.ALLOWED_CURRENCIES.includes(validatedCurrency)) {
    throw new Error(`Unsupported currency: ${currency}`);
  }
  return validatedCurrency;
};

export const generateRequestId = () => {
  return `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
};

export const withTimeout = (promise, ms = 5000, label = 'operation') => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
};

export default {
  hashPII,
  extractIP,
  validateAmount,
  validateCurrency,
  generateRequestId,
  withTimeout,
  assertAdminAllowlistConfigured,
  isAdminIpAllowed,
  getPreviewOrigins,
  isAllowedOrigin,
  setCorsHeaders,
};
