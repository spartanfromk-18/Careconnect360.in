-- V2 Dual-Email & Nurse Dispatch Schema Migration
-- Adds emails_dispatched flag, paid_unassigned status, and atomic assignment index.

-- 1. Widen the bookings status constraint to include 'paid_unassigned'
ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_status_check;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_status_check CHECK (
    status = ANY (ARRAY[
      'pending_payment'::text,
      'paid_unassigned'::text,
      'confirmed'::text,
      'assigned'::text,
      'in_progress'::text,
      'completed'::text,
      'cancelled'::text
    ])
  );

-- 2. Add emails_dispatched flag (idempotency guard for webhook retries)
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS emails_dispatched BOOLEAN NOT NULL DEFAULT false;

-- 3. Index for the atomic nurse assignment query
--    (WHERE id = booking_id AND status = 'paid_unassigned')
CREATE INDEX IF NOT EXISTS idx_bookings_unassigned
  ON public.bookings (id, status)
  WHERE status = 'paid_unassigned';

-- 4. Comment documentation
COMMENT ON COLUMN public.bookings.emails_dispatched IS
  'Set to true after patient receipt + nurse dispatch emails are sent. Prevents duplicate sends on Razorpay webhook retries.';
