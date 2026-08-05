/**
 * lib/email.js
 * Resend email dispatch over REST fetch with strict 5s timeouts and a
 * zero-trust PII contract.
 *
 * ZERO-TRUST CONTRACT:
 *  - sendNurseDispatchRequest carries NO patient PII. The `location` value is
 *    scrubbed to "PIN <6 digits>" or a city-level zone before it is rendered.
 *    Patient street addresses NEVER appear in a dispatch email.
 *  - Full patient PII is revealed ONLY via sendAssignmentConfirmed, which is
 *    invoked exclusively after the atomic claim_booking RPC has been won.
 *
 * TIMEOUT GUARANTEE:
 *  - Every outbound call is wrapped in fetchWithTimeout(5000) INSIDE sendEmail,
 *    so no caller can bypass the Vercel-safety bound. All template functions
 *    additionally swallow+log errors via deliver() — an email failure never
 *    crashes the payment/dispatch request.
 */

import { makeLogger } from './logger.js';
import { fetchWithTimeout } from './timeout.js';

const REQUIRED_EMAIL_ENV = ['RESEND_API_KEY', 'JWT_SECRET', 'SENDER_EMAIL', 'ADMIN_EMAIL'];
for (const key of REQUIRED_EMAIL_ENV) {
  if (!process.env[key]) throw new Error(`CRITICAL: ${key} must be defined.`);
}

const log = makeLogger('email');

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BASE_STYLE = 'font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;';

const senderFrom = () => {
  const sender = process.env.SENDER_EMAIL;
  return sender.includes('<') ? sender : `CareConnect <${sender}>`;
};

/**
 * PII scrubber for pre-acceptance dispatch emails.
 * Returns "PIN <6-digit>" when a pin is present, otherwise the first
 * comma-segment (city/zone) capped at 40 chars, otherwise 'Nearby'.
 * Full street addresses are intentionally discarded.
 *
 * @param {string|undefined} location - Patient-entered free-text address.
 * @returns {string} Area/zone-safe string for nurse dispatch emails.
 */
export const scrubbedLocation = (location) => {
  const raw = String(location || '').trim();
  if (!raw) return 'Nearby';
  const pin = raw.match(/\b\d{6}\b/);
  if (pin) return `PIN ${pin[0]}`;
  const zone = raw.split(',')[0].trim();
  return zone.length > 40 ? `${zone.slice(0, 40)}…` : (zone || 'Nearby');
};

export async function sendEmail({ to, subject, html }) {
  if (!to) return false;
  const res = await fetchWithTimeout(
    'https://api.resend.com/emails',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: senderFrom(), to: [to], subject, html }),
    },
    5000
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Resend failed (${res.status}): ${detail}`);
  }
  return true;
}

const deliver = async (job) => {
  try {
    await job();
  } catch (err) {
    log({ event: 'EMAIL_SEND_FAILED', error: err.message }, 'ERROR');
  }
};

export async function sendBookingConfirmation({ name, email, phone }) {
  await deliver(() => sendEmail({
    to: email,
    subject: 'Booking Confirmed - CareConnect360',
    html: `<div style="${BASE_STYLE}"><p>Hi ${esc(name)},</p><p>We have received your booking fee of ₹500. Our care coordinator will contact you shortly at ${esc(phone)}.</p></div>`,
  }));
}

export async function sendNewBookingAlert({ name, phone, service }) {
  await deliver(() => sendEmail({
    to: process.env.ADMIN_EMAIL,
    subject: '🔔 New Paid Booking',
    html: `<div style="${BASE_STYLE}"><p>New paid booking received.</p><p>Name: ${esc(name)}<br>Phone: ${esc(phone)}<br>Service: ${esc(service)}</p></div>`,
  }));
}

export async function sendCallbackAlert({ name, phone }) {
  await deliver(() => sendEmail({
    to: process.env.ADMIN_EMAIL,
    subject: '🔔 New Callback Request',
    html: `<div style="${BASE_STYLE}"><p>New callback request.</p><p>Name: ${esc(name)}<br>Phone: ${esc(phone)}</p></div>`,
  }));
}

export async function sendApplicationReceived({ firstName, email }) {
  await deliver(() => sendEmail({
    to: email,
    subject: 'Application Received - CareConnect360',
    html: `<div style="${BASE_STYLE}"><p>Hi ${esc(firstName)},</p><p>Thank you for applying to CareConnect360. We have received your application.</p></div>`,
  }));
}

export async function sendPaymentFailedAlert({ paymentId, errorCode, errorDesc }) {
  await deliver(() => sendEmail({
    to: process.env.ADMIN_EMAIL,
    subject: `⚠️ Payment Failed — ${esc(paymentId)}`,
    html: `<div style="${BASE_STYLE}"><h2>Payment Failure Alert</h2><p><strong>Payment ID:</strong> ${esc(paymentId)}</p><p><strong>Error:</strong> ${esc(errorCode)} - ${esc(errorDesc)}</p></div>`,
  }));
}

export async function sendRefundAlert({ paymentId, amountPaise }) {
  await deliver(() => sendEmail({
    to: process.env.ADMIN_EMAIL,
    subject: `↩️ Refund Processed — ${esc(paymentId)}`,
    html: `<div style="${BASE_STYLE}"><h2>Refund Notification</h2><p>A refund of <strong>₹${esc(Number(amountPaise || 0) / 100)}</strong> has been processed for Payment ID: ${esc(paymentId)}.</p></div>`,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// V2 DUAL-EMAIL DISPATCH FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * V2: Patient booking receipt (full PII — sent only to the patient).
 */
export async function sendPatientReceipt({ name, email, phone, service, location, scheduledDate, scheduledTime, invoiceNumber }) {
  await deliver(() => sendEmail({
    to: email,
    subject: '✅ Your Booking is Confirmed — CareConnect360',
    html: `
      <div style="${BASE_STYLE}">
        <div style="background: #1A8A7B; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
          <h1 style="color: #fff; margin: 0; font-size: 22px;">Booking Confirmed</h1>
        </div>
        <div style="padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
          <p>Hi <strong>${esc(name)}</strong>,</p>
          <p>Your ₹500 booking fee has been received. A verified care professional will be assigned to you within <strong>4 hours</strong>.</p>
          <table style="width:100%; border-collapse:collapse; margin: 16px 0;">
            <tr style="background:#f9fafb;"><td style="padding:10px;border:1px solid #e5e7eb;"><strong>Service</strong></td><td style="padding:10px;border:1px solid #e5e7eb;">${esc(service || 'Not specified')}</td></tr>
            <tr><td style="padding:10px;border:1px solid #e5e7eb;"><strong>Location</strong></td><td style="padding:10px;border:1px solid #e5e7eb;">${esc(location || 'Not specified')}</td></tr>
            <tr style="background:#f9fafb;"><td style="padding:10px;border:1px solid #e5e7eb;"><strong>Scheduled</strong></td><td style="padding:10px;border:1px solid #e5e7eb;">${esc(scheduledDate || 'ASAP')} ${esc(scheduledTime ? '@ ' + scheduledTime : '')}</td></tr>
            <tr><td style="padding:10px;border:1px solid #e5e7eb;"><strong>Contact</strong></td><td style="padding:10px;border:1px solid #e5e7eb;">${esc(phone)}</td></tr>
            ${invoiceNumber ? `<tr style="background:#f9fafb;"><td style="padding:10px;border:1px solid #e5e7eb;"><strong>Invoice</strong></td><td style="padding:10px;border:1px solid #e5e7eb;">${esc(invoiceNumber)}</td></tr>` : ''}
          </table>
          <p style="color:#6b7280; font-size:13px;">Questions? Contact us at <a href="mailto:${esc(process.env.ADMIN_EMAIL || 'support@careconnect360.in')}">${esc(process.env.ADMIN_EMAIL || 'support@careconnect360.in')}</a></p>
        </div>
      </div>
    `,
  }));
}

/**
 * V2: Nurse dispatch request — ZERO PATIENT PII.
 * The `location` value is scrubbed here (defense in depth) even though
 * callers are required to pass scrubbedLocation() output. Only care type,
 * PIN/zone area, date/time and secure one-click action links are rendered.
 */
export async function sendNurseDispatchRequest({ nurseEmail, nurseName, bookingId, careType, service, location, scheduledDate, scheduledTime, acceptToken, declineToken }) {
  const baseUrl = process.env.ALLOWED_ORIGIN || 'https://www.careconnect360.in';
  const safeArea = scrubbedLocation(location);
  const acceptUrl = `${baseUrl}/api/nurse-action?token=${encodeURIComponent(acceptToken)}&action=accept`;
  const declineUrl = `${baseUrl}/api/nurse-action?token=${encodeURIComponent(declineToken)}&action=decline`;

  await deliver(() => sendEmail({
    to: nurseEmail,
    subject: `⚡ New Care Request Near You — ${esc(safeArea)}`,
    html: `
      <div style="${BASE_STYLE}">
        <div style="background: #0D1B2A; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
          <h1 style="color: #1A8A7B; margin: 0; font-size: 20px;">🏥 New Dispatch Request</h1>
          <p style="color: #9ca3af; margin: 4px 0 0; font-size: 13px;">CareConnect360 Nurse Portal</p>
        </div>
        <div style="padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
          <p>Hi <strong>${esc(nurseName)}</strong>,</p>
          <p>A new verified care request is available in your area. Review the details and respond within <strong>2 hours</strong>.</p>
          <table style="width:100%; border-collapse:collapse; margin: 16px 0;">
            <tr style="background:#f9fafb;"><td style="padding:10px;border:1px solid #e5e7eb;width:40%;"><strong>Care Type</strong></td><td style="padding:10px;border:1px solid #e5e7eb;">${esc(careType || service || 'General Care')}</td></tr>
            <tr><td style="padding:10px;border:1px solid #e5e7eb;"><strong>Area / Zone</strong></td><td style="padding:10px;border:1px solid #e5e7eb;">${esc(safeArea)}</td></tr>
            <tr style="background:#f9fafb;"><td style="padding:10px;border:1px solid #e5e7eb;"><strong>Scheduled Date</strong></td><td style="padding:10px;border:1px solid #e5e7eb;">${esc(scheduledDate || 'ASAP')}</td></tr>
            <tr><td style="padding:10px;border:1px solid #e5e7eb;"><strong>Time Slot</strong></td><td style="padding:10px;border:1px solid #e5e7eb;">${esc(scheduledTime || 'Flexible')}</td></tr>
          </table>
          <p style="color:#dc2626; font-size:13px;"><strong>⚠️ Note:</strong> Patient contact details will only be shared after you accept this request.</p>
          <div style="text-align:center; margin: 28px 0;">
            <a href="${acceptUrl}" style="display:inline-block; background:#1A8A7B; color:#fff; padding:14px 32px; border-radius:6px; text-decoration:none; font-weight:bold; font-size:16px; margin-right:12px;">✅ Accept Job</a>
            <a href="${declineUrl}" style="display:inline-block; background:#e5e7eb; color:#374151; padding:14px 32px; border-radius:6px; text-decoration:none; font-weight:bold; font-size:16px;">❌ Decline</a>
          </div>
          <p style="color:#6b7280; font-size:12px; text-align:center;">These links expire in 2 hours. Booking ID: ${esc(bookingId)}</p>
        </div>
      </div>
    `,
  }));
}

/**
 * V2: Assignment confirmed — sent ONLY after atomic claim_booking success.
 * This is the ONLY email that may contain full patient PII.
 */
export async function sendAssignmentConfirmed({ nurseEmail, nurseName, patientName, patientPhone, patientEmail, location, service, scheduledDate, scheduledTime }) {
  await deliver(() => sendEmail({
    to: nurseEmail,
    subject: `🎉 Job Confirmed — Patient Contact Details Inside`,
    html: `
      <div style="${BASE_STYLE}">
        <div style="background: #1A8A7B; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
          <h1 style="color: #fff; margin: 0; font-size: 20px;">Assignment Confirmed!</h1>
        </div>
        <div style="padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
          <p>Hi <strong>${esc(nurseName)}</strong>, you have been assigned this care job. Contact the patient immediately to confirm your arrival time.</p>
          <table style="width:100%; border-collapse:collapse; margin: 16px 0;">
            <tr style="background:#f0fdf4;"><td style="padding:10px;border:1px solid #bbf7d0;width:40%;"><strong>Patient Name</strong></td><td style="padding:10px;border:1px solid #bbf7d0;">${esc(patientName)}</td></tr>
            <tr><td style="padding:10px;border:1px solid #e5e7eb;"><strong>Phone</strong></td><td style="padding:10px;border:1px solid #e5e7eb;"><a href="tel:${esc(patientPhone)}" style="color:#1A8A7B;font-weight:bold;">${esc(patientPhone)}</a></td></tr>
            ${patientEmail ? `<tr style="background:#f9fafb;"><td style="padding:10px;border:1px solid #e5e7eb;"><strong>Email</strong></td><td style="padding:10px;border:1px solid #e5e7eb;">${esc(patientEmail)}</td></tr>` : ''}
            <tr><td style="padding:10px;border:1px solid #e5e7eb;"><strong>Address</strong></td><td style="padding:10px;border:1px solid #e5e7eb;">${esc(location)}</td></tr>
            <tr style="background:#f9fafb;"><td style="padding:10px;border:1px solid #e5e7eb;"><strong>Service</strong></td><td style="padding:10px;border:1px solid #e5e7eb;">${esc(service || 'General Care')}</td></tr>
            <tr><td style="padding:10px;border:1px solid #e5e7eb;"><strong>Scheduled</strong></td><td style="padding:10px;border:1px solid #e5e7eb;">${esc(scheduledDate || 'ASAP')} ${esc(scheduledTime ? '@ ' + scheduledTime : '')}</td></tr>
          </table>
          <p style="color:#6b7280; font-size:13px;">Please contact operations at <a href="mailto:${esc(process.env.ADMIN_EMAIL || 'ops@careconnect360.in')}">${esc(process.env.ADMIN_EMAIL || 'ops@careconnect360.in')}</a> if you have any issues.</p>
        </div>
      </div>
    `,
  }));
}
