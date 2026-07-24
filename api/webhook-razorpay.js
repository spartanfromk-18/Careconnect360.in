 // CRITICAL: Must be at the absolute top level of the module for Vercel to parse it
export const config = {
  api: { bodyParser: false },
};

import crypto from 'crypto';
import getRawBody from 'raw-body';
import { Redis } from "@upstash/redis";
import { createClient } from '@supabase/supabase-js';

const REQUIRED_ENV = ['RAZORPAY_WEBHOOK_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'ADMIN_EMAIL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
for (const key of REQUIRED_ENV) {
    if (!process.env[key]) throw new Error(`[webhook] FATAL: missing ${key}`);
}

const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const verifySignature = (rawBody, signature) => {
    try {
        const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
        const sigBuf = Buffer.from(signature || '');
        const expBuf = Buffer.from(expected);
        return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
    } catch { return false; }
};

const logEvent = (data, level = 'INFO') => console.log(JSON.stringify({ level, timestamp: new Date().toISOString(), source: 'webhook-razorpay', ...data }));

async function syncToSupabase(payload, eventType) {
    const payment = payload.payload.payment?.entity || {};
    const refund = payload.payload.refund?.entity || {};
    const paymentId = payment.id || refund.payment_id || 'unknown';
    const orderId = payment.order_id || 'unknown';
    const amount = payment.amount || refund.amount || 0;
    const currency = payment.currency || 'INR';
    const notes = payment.notes || {};
    const statusMap = { 'payment.captured': 'captured', 'payment.failed': 'failed', 'payment.authorized': 'authorized', 'order.paid': 'captured', 'refund.created': 'refunded', 'refund.processed': 'refunded' };
    
    let bookingId = null;
    let customerId = null;
    if (paymentId !== 'unknown') {
        const { data: bookingRow, error: lookupErr } = await supabase.from('bookings').select('id, customer_id').eq('payment_id', paymentId).maybeSingle();
        if (lookupErr) logEvent({ message: 'Booking lookup failed', error: lookupErr.message, paymentId }, 'ERROR');
        else if (bookingRow) { bookingId = bookingRow.id; customerId = bookingRow.customer_id || null; }
    }

    const fields = { payment_id: paymentId, webhook_event_id: payload.id, booking_id: bookingId, order_id: orderId, event_type: eventType, amount_paise: amount, currency: currency, status: statusMap[eventType] || 'unknown', customer_email: notes.customerEmail || '', customer_phone: notes.customerPhone || '', customer_name: notes.name || '', razorpay_notes: notes };
    
    const { error: upsertErr } = await supabase.from('payments').upsert(fields, { onConflict: 'webhook_event_id', ignoreDuplicates: true });
    if (upsertErr) throw new Error(`Supabase payment upsert failed: ${upsertErr.message}`);

    if (eventType === 'payment.captured' && bookingId) {
        const [statusResult, { data: existingInvoice }] = await Promise.all([
            supabase.from('bookings').update({ status: 'confirmed', updated_at: new Date().toISOString() }).eq('id', bookingId),
            supabase.from('invoices').select('id').eq('booking_id', bookingId).maybeSingle()
        ]);
        if (statusResult.error) logEvent({ message: 'Booking status update failed', error: statusResult.error.message, bookingId }, 'ERROR');
        if (!existingInvoice) {
            const { error: invErr } = await supabase.from('invoices').insert({ booking_id: bookingId, customer_id: customerId, subtotal_paise: amount, tax_paise: 0, total_paise: amount, status: 'issued' });
            if (invErr) logEvent({ message: 'Invoice insert failed', error: invErr.message, bookingId }, 'ERROR');
        }
    }
    return bookingId;
}

async function sendEmail(to, subject, html) {
    if (!to) return;
    const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'CareConnect <noreply@careconnect360.in>', to: [to], subject, html }) });
    if (!res.ok) throw new Error(`Resend failed: ${await res.text()}`);
}

function getEmailTemplate(type, data) {
    const baseStyle = `font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;`;
    if (type === 'failed') return { to: process.env.ADMIN_EMAIL, subject: `⚠️ Payment Failed — ${data.paymentId}`, html: `<div style="${baseStyle}"><h2>Payment Failure Alert</h2><p><strong>Payment ID:</strong> ${data.paymentId}</p><p><strong>Error:</strong> ${data.errorCode} - ${data.errorDesc}</p></div>` };
    if (type === 'refund') return { to: process.env.ADMIN_EMAIL, subject: `↩️ Refund Processed — ${data.paymentId}`, html: `<div style="${baseStyle}"><h2>Refund Notification</h2><p>A refund of <strong>₹${data.amount / 100}</strong> has been processed for Payment ID: ${data.paymentId}.</p></div>` };
    return null;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    let rawBody;
    try { rawBody = await getRawBody(req); } 
    catch (err) { return res.status(400).json({ error: 'Invalid payload stream' }); }

    const signature = req.headers['x-razorpay-signature'];
    if (!signature || !verifySignature(rawBody.toString('utf8'), signature)) {
        return res.status(400).json({ error: 'Invalid signature' });
    }

    let payload;
    try {
        payload = JSON.parse(rawBody.toString('utf8'));
    } catch (parseErr) {
        logEvent({ message: 'Invalid JSON payload', error: parseErr.message }, 'ERROR');
        return res.status(400).json({ error: 'Invalid JSON payload' });
    }
    const eventId = payload.id;
    const eventType = payload.event;
    const payment = payload.payload.payment?.entity || {};
    const logData = { eventId, eventType, paymentId: payment.id, orderId: payment.order_id, amount: payment.amount, currency: payment.currency };

    let isDuplicate;
    try {
        const result = await redis.set(`webhook:event:${eventId}`, '1', { nx: true, ex: 86400 });
        isDuplicate = !result;
    } catch (redisErr) {
        logEvent({ ...logData, error: 'Redis idempotency check failed, proceeding with caution', message: redisErr.message }, 'WARN');
        isDuplicate = false; // Fail-open: Supabase upsert onConflict will catch duplicates if Redis is down
    }

    if (isDuplicate) {
        logEvent({ ...logData, message: 'Duplicate webhook ignored' }, 'INFO');
        return res.status(200).json({ ok: true });
    }

    let template = null;
    if (eventType === 'payment.failed') template = getEmailTemplate('failed', { ...payment, errorDesc: payment.error_description, errorCode: payment.error_code });
    else if (eventType === 'refund.processed') template = getEmailTemplate('refund', payload.payload.refund?.entity || {});
    // NOTE: 'refund.created' is handled in syncToSupabase (statusMap) but does NOT send an email here.
    // Decision needed: should 'refund.created' also trigger an admin notification?

    try {
        await syncToSupabase(payload, eventType);
        logEvent({ ...logData, message: 'Supabase ledger synced successfully' }, 'INFO');
    } catch (err) {
        logEvent({ ...logData, error: `CRITICAL LEDGER FAILURE: ${err.message}` }, 'ERROR');
        return res.status(500).json({ error: 'Ledger sync failed, retrying later' });
    }

    if (template) {
        sendEmail(template.to, template.subject, template.html)
            .then(() => logEvent({ ...logData, message: 'Admin alert email sent' }, 'INFO'))
            .catch(err => logEvent({ ...logData, error: `Email failed: ${err.message}` }, 'WARN'));
    }

    logEvent(logData, 'INFO');
    return res.status(200).json({ ok: true });
}