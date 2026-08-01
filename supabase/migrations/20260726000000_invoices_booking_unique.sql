-- ============================================================================
-- Zero-failure data sync: enforce one invoice per booking.
--
-- Both /api/webhook-razorpay (payment.captured) and /api/submit can create the
-- invoice for a confirmed booking (they race). Without a uniqueness guarantee on
-- invoices.booking_id a double-creation race could insert duplicate invoices.
-- This migration dedupes any pre-existing rows and then enforces uniqueness so
-- both writers can safely use ON CONFLICT (booking_id) DO NOTHING.
-- Additive migration — never edit prior migrations.
-- ============================================================================

-- 1. Dedupe: keep the lowest id per booking, drop any older duplicates.
DELETE FROM public.invoices a
USING public.invoices b
WHERE a.booking_id = b.booking_id
  AND a.id > b.id;

-- 2. Enforce the invariant going forward.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_booking_id_key ON public.invoices (booking_id);
