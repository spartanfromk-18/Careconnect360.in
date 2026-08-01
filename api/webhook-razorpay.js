// CRITICAL: Must be at the absolute top level of the module for Vercel to parse it
export const config = {
  api: { bodyParser: false },
};

import crypto from 'crypto';
import getRawBody from 'raw-body';
import { Redis } from "@upstash/redis";
import { createClient } from '@supabase/supabase-js';
import { makeLogger, captureException } from '../lib/logger.js';
import { sendPaymentFailedAlert, sendRefundAlert } from '../lib/email.js';

const REQUIRED_ENV = ['RAZORPAY_WEBHOOK_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'ADMIN_EMAIL', 'SENDER_EMAIL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
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

const log = makeLogger('webhook-razorpay');

async function findBooking(paymentId) {
    const { data: bookingRow, error: lookupErr } = await supabase.from('bookings').select('id, customer_id').eq('payment_id', paymentId).maybeSingle();
    if (lookupErr) throw new Error(`Booking lookup failed: ${lookupErr.message}`);
    return bookingRow || null;
}

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
        // payment.captured races with /api/submit inserting the booking row.
        // Retry the lookup with bounded backoff so invoices/linking are never
        // skipped when the webhook arrives before the booking lands in Supabase.
        // Total sleep is capped at 500ms to stay well under the 10s serverless ceiling.
        const attempts = eventType === 'payment.captured' ? 2 : 1;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            const bookingRow = await findBooking(paymentId);
            if (bookingRow) { bookingId = bookingRow.id; customerId = bookingRow.customer_id || null; break; }
            if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }

    const fields = { payment_id: paymentId, webhook_event_id: payload.id, booking_id: bookingId, order_id: orderId, event_type: eventType, amount_paise: amount, currency: currency, status: statusMap[eventType] || 'unknown', customer_email: notes.customerEmail || '', customer_phone: notes.customerPhone || '', customer_name: notes.name || '', razorpay_notes: notes };
    
    // NOTE: Razorpay emits MULTIPLE events per payment (authorized/captured/
    // order.paid/failed/refund.*), each with a distinct webhook_event_id while
    // the payments table ALSO enforces UNIQUE(payment_id). Targeting the event
    // id alone would 500 on the second distinct event (unique violation), so we
    // reconcile on payment_id instead — one canonical ledger row per payment,
    // latest event wins. Duplicate event replays are already deduped by the
    // Redis idempotency guard before we reach this point.
    const { error: upsertErr } = await supabase.from('payments').upsert(fields, { onConflict: 'payment_id', ignoreDuplicates: false });
    if (upsertErr) throw new Error(`Supabase payment upsert failed: ${upsertErr.message}`);

    if (eventType === 'payment.captured' && bookingId) {
        const [statusResult, { data: existingInvoice }, { data: paymentRow }] = await Promise.all([
            supabase.from('bookings').update({ status: 'confirmed', updated_at: new Date().toISOString() }).eq('id', bookingId),
            supabase.from('invoices').select('id').eq('booking_id', bookingId).maybeSingle(),
            supabase.from('payments').select('id').eq('payment_id', paymentId).maybeSingle()
        ]);
        if (statusResult.error) log({ message: 'Booking status update failed', error: statusResult.error.message, bookingId }, 'ERROR');
        if (!existingInvoice) {
            const { error: invErr } = await supabase.from('invoices').upsert(
                { booking_id: bookingId, customer_id: customerId, payment_id: paymentRow?.id || null, subtotal_paise: amount, tax_paise: 0, total_paise: amount, status: 'issued' },
                { onConflict: 'booking_id', ignoreDuplicates: true }
            );
            if (invErr) log({ message: 'Invoice insert failed', error: invErr.message, bookingId }, 'ERROR');
        }
    }
    return bookingId;
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
        log({ message: 'Invalid JSON payload', error: parseErr.message }, 'ERROR');
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
        log({ ...logData, error: 'Redis idempotency check failed, proceeding with caution', message: redisErr.message }, 'WARN');
        isDuplicate = false; // Fail-open: Supabase upsert onConflict will catch duplicates if Redis is down
    }

    if (isDuplicate) {
        log({ ...logData, message: 'Duplicate webhook ignored' }, 'INFO');
        return res.status(200).json({ ok: true });
    }

    const isPaymentFailed = eventType === 'payment.failed';
    const isRefundProcessed = eventType === 'refund.processed';
    // NOTE: 'refund.created' is handled in syncToSupabase (statusMap) but does NOT send an email here.
    // Decision needed: should 'refund.created' also trigger an admin notification?

    try {
        await syncToSupabase(payload, eventType);
        log({ ...logData, message: 'Supabase ledger synced successfully' }, 'INFO');
    } catch (err) {
        log({ ...logData, error: `CRITICAL LEDGER FAILURE: ${err.message}` }, 'ERROR');
        captureException(err, { event: 'LEDGER_SYNC_FAILED', ...logData });
        return res.status(500).json({ error: 'Ledger sync failed, retrying later' });
    }

    if (isPaymentFailed) {
        await Promise.allSettled([sendPaymentFailedAlert({ paymentId: payment.id, errorCode: payment.error_code, errorDesc: payment.error_description })]);
        log({ ...logData, message: 'Admin payment-failed alert dispatched' }, 'INFO');
    } else if (isRefundProcessed) {
        const refund = payload.payload.refund?.entity || {};
        await Promise.allSettled([sendRefundAlert({ paymentId: refund.payment_id || payment.id, amountPaise: refund.amount || 0 })]);
        log({ ...logData, message: 'Admin refund alert dispatched' }, 'INFO');
    }

    log(logData, 'INFO');
    return res.status(200).json({ ok: true });
}