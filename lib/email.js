import { makeLogger } from './logger.js';

if (!process.env.SENDER_EMAIL) {
  throw new Error('CRITICAL: SENDER_EMAIL must be defined.');
}

const log = makeLogger('email');

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BASE_STYLE = 'font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;';

const senderFrom = () => {
  const sender = process.env.SENDER_EMAIL;
  return sender.includes('<') ? sender : `CareConnect <${sender}>`;
};

export async function sendEmail({ to, subject, html }) {
  if (!to) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: senderFrom(), to: [to], subject, html }),
  });
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
