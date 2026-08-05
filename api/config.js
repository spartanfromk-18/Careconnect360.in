/**
 * GET /api/config
 * Serves the browser-safe Supabase connection details (URL + ANON key) to
 * static pages. The anon key is a PUBLISHABLE key by design — it must sit in
 * the client so RLS can enforce row-level isolation. Keeping it behind this
 * endpoint means the real key never lives in a static file or git history.
 */
import { setCorsHeaders } from './security-utils.js';

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) throw new Error(`[config] FATAL: missing ${key}`);
}

export default async function handler(req, res) {
  const reqOrigin = req.headers['origin'] || '';
  setCorsHeaders(res, reqOrigin, { methods: 'GET, OPTIONS', allowHeaders: 'Content-Type' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    googleAuthEnabled: true,
  });
}
