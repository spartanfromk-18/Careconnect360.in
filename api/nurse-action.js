/**
 * api/nurse-action.js
 * GET /api/nurse-action?token=<JWT>&action=accept|decline
 *
 * Zero-Trust Nurse Job Acceptance Handler:
 *  1. Validates short-lived signed JWT (exp: 2h)
 *  2. Performs atomic Supabase UPDATE to handle concurrent nurse clicks
 *  3. Reveals patient PII only to the winning nurse via sendAssignmentConfirmed
 *  4. Returns a clean, responsive HTML page for both outcomes (no JSON — linked directly from email)
 */

import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';
import { sendAssignmentConfirmed } from '../lib/email.js';
import { makeLogger, captureException } from '../lib/logger.js';

const REQUIRED_ENV = ['JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SENDER_EMAIL', 'RESEND_API_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) throw new Error(`[nurse-action] CRITICAL: Missing ${key}`);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const log = makeLogger('nurse-action');

// ─── HTML page builders ───────────────────────────────────────────────────────
const PAGE_STYLE = `
  font-family: 'Segoe UI', sans-serif; background: #f9fafb; min-height: 100vh;
  display: flex; align-items: center; justify-content: center; padding: 20px;
`;
const CARD_STYLE = `
  background: #fff; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.08);
  padding: 48px 40px; max-width: 480px; width: 100%; text-align: center;
`;

const htmlPage = ({ icon, title, color, message, sub }) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — CareConnect360</title>
</head>
<body style="${PAGE_STYLE}">
  <div style="${CARD_STYLE}">
    <div style="font-size: 56px; margin-bottom: 16px;">${icon}</div>
    <h1 style="color: ${color}; font-size: 22px; margin: 0 0 12px;">${title}</h1>
    <p style="color: #374151; font-size: 16px; line-height: 1.6; margin: 0 0 8px;">${message}</p>
    ${sub ? `<p style="color: #9ca3af; font-size: 13px; margin: 8px 0 0;">${sub}</p>` : ''}
    <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e5e7eb;">
      <img src="https://www.careconnect360.in/favicon.ico" alt="CareConnect360" style="height:28px; opacity:0.6;" onerror="this.style.display='none'" />
      <p style="color: #9ca3af; font-size: 12px; margin: 8px 0 0;">CareConnect360 — Verified At-Home Healthcare</p>
    </div>
  </div>
</body>
</html>`;

// ─── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Only GET requests — this endpoint is linked directly from email buttons
  if (req.method !== 'GET') return res.status(405).end();

  const { token, action } = req.query || {};

  if (!token || !['accept', 'decline'].includes(action)) {
    return res.status(400).send(htmlPage({
      icon: '⚠️',
      title: 'Invalid Request',
      color: '#dc2626',
      message: 'This link is invalid or malformed. Please contact operations.',
    }));
  }

  // ── 1. Validate JWT ─────────────────────────────────────────────────────────
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'careconnect360-dispatch',
    });
  } catch (err) {
    log({ event: 'DISPATCH_TOKEN_INVALID', error: err.message }, 'WARN');
    return res.status(401).send(htmlPage({
      icon: '⏰',
      title: 'Link Expired',
      color: '#d97706',
      message: 'This dispatch link has expired (2-hour window) or is invalid.',
      sub: 'If you believe this is an error, please contact the operations team.',
    }));
  }

  const { bookingId, nurseId } = decoded;

  if (!bookingId || !nurseId) {
    return res.status(400).send(htmlPage({
      icon: '⚠️',
      title: 'Invalid Token',
      color: '#dc2626',
      message: 'Token payload is incomplete. Please contact operations.',
    }));
  }

  // ── 2. Handle DECLINE ───────────────────────────────────────────────────────
  if (action === 'decline') {
    log({ event: 'JOB_DECLINED', bookingId, nurseId }, 'INFO');
    return res.status(200).send(htmlPage({
      icon: '🙏',
      title: 'Request Declined',
      color: '#6b7280',
      message: 'You have declined this job request. No further action is needed.',
      sub: 'Thank you for your response. The request will be offered to another care provider.',
    }));
  }

  // ── 3. Atomic Accept: race-condition-safe UPDATE ────────────────────────────
  // This single UPDATE is atomic: only succeeds when status = 'paid_unassigned'.
  // If another nurse already accepted, affected row count = 0.
  let acceptedBooking;
  try {
    const { data, error } = await supabase
      .from('bookings')
      .update({
        status: 'assigned',
        nurse_id: nurseId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', bookingId)
      .eq('status', 'paid_unassigned')   // ← atomic guard: only one nurse wins
      .select('id, name, phone, email, location, service, care_type, scheduled_date, scheduled_time')
      .maybeSingle();

    if (error) throw new Error(`Supabase atomic update failed: ${error.message}`);
    acceptedBooking = data;
  } catch (err) {
    log({ event: 'ATOMIC_ASSIGN_ERROR', bookingId, nurseId, error: err.message }, 'ERROR');
    captureException(err, { event: 'ATOMIC_ASSIGN_ERROR', bookingId, nurseId });
    return res.status(500).send(htmlPage({
      icon: '❌',
      title: 'System Error',
      color: '#dc2626',
      message: 'We encountered an error processing your acceptance. Please contact operations immediately.',
    }));
  }

  // ── 4. Race condition: another nurse won ────────────────────────────────────
  if (!acceptedBooking) {
    log({ event: 'JOB_ALREADY_ASSIGNED', bookingId, nurseId }, 'INFO');
    return res.status(200).send(htmlPage({
      icon: '🏃',
      title: 'Job Already Assigned',
      color: '#d97706',
      message: 'This care request has already been accepted by another care provider.',
      sub: 'Keep an eye on your inbox — more requests will be dispatched shortly.',
    }));
  }

  // ── 5. Winning nurse: fetch nurse details then reveal patient PII ────────────
  try {
    const { data: nurse, error: nurseErr } = await supabase
      .from('nurses')
      .select('first_name, last_name, email')
      .eq('id', nurseId)
      .single();

    if (nurseErr || !nurse?.email) throw new Error(`Nurse lookup failed: ${nurseErr?.message || 'no email'}`);

    const nurseName = `${nurse.first_name} ${nurse.last_name || ''}`.trim();

    // PII revealed here — only to the nurse who atomically claimed the job
    await sendAssignmentConfirmed({
      nurseEmail: nurse.email,
      nurseName,
      patientName: acceptedBooking.name,
      patientPhone: acceptedBooking.phone,
      patientEmail: acceptedBooking.email || null,
      location: acceptedBooking.location,
      service: acceptedBooking.service || acceptedBooking.care_type,
      scheduledDate: acceptedBooking.scheduled_date,
      scheduledTime: acceptedBooking.scheduled_time,
    });

    log({ event: 'JOB_ASSIGNED', bookingId, nurseId }, 'INFO');
  } catch (err) {
    // Booking is still assigned in DB — only email delivery failed. Log for manual follow-up.
    log({ event: 'ASSIGNMENT_EMAIL_FAILED', bookingId, nurseId, error: err.message }, 'ERROR');
    captureException(err, { event: 'ASSIGNMENT_EMAIL_FAILED', bookingId, nurseId });
    // Still show success page — ops team will be notified via Sentry/logs
  }

  return res.status(200).send(htmlPage({
    icon: '🎉',
    title: 'Job Confirmed!',
    color: '#1A8A7B',
    message: 'You have successfully accepted this care assignment. Patient contact details have been sent to your email.',
    sub: 'Please check your inbox and contact the patient to confirm your arrival time.',
  }));
}
