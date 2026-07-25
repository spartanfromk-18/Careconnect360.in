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
  // ponytail: .pop() reads the LAST entry (Vercel-appended, trustworthy), not the first (attacker-controlled)
  const rawIp = headers['x-forwarded-for']?.split(',').pop()?.trim() || 'unknown';
  // ponytail: net.isIP handles both IPv4 and IPv6 — replaces the old IPv4-only regex
  if (rawIp !== 'unknown' && !net.isIP(rawIp)) {
    return 'invalid';
  }
  return rawIp;
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

export default {
  hashPII,
  extractIP,
  validateAmount,
  validateCurrency,
  generateRequestId,
};
