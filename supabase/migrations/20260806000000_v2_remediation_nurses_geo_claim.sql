-- V2 Remediation Migration: Nurse Geo Columns + Atomic claim_booking RPC
-- ============================================================================
-- 1. Nurses geo columns (used by findAvailableNurses geo matching)
-- 2. claim_booking() — single-statement atomic nurse assignment that prevents
--    BOTH same-booking double-accept AND cross-booking nurse double-booking.
-- 3. Supporting indexes.
-- ============================================================================

-- 1. Geo columns ---------------------------------------------------------------
ALTER TABLE public.nurses
  ADD COLUMN IF NOT EXISTS city text;

ALTER TABLE public.nurses
  ADD COLUMN IF NOT EXISTS pincode text;

COMMENT ON COLUMN public.nurses.city IS
  'City / primary service area. Populated from the nurse application or admin.';
COMMENT ON COLUMN public.nurses.pincode IS
  'Primary service PIN code (6 digits). Used by nurse dispatch geo matching.';

-- 2. claim_booking() -------------------------------------------------------------
-- Atomic claim for the race-condition-safe nurse assignment flow:
--   UPDATE bookings SET status='assigned', nurse_id=p_nurse
--   WHERE id = p_booking AND status = 'paid_unassigned'
--   AND the nurse is not already assigned/confirmed/in_progress for the same slot.
-- Single statement => plain UPDATE row locking => two concurrent claims for the
-- same booking serialize; the second matches 0 rows. Cross-booking claims by
-- the same nurse in the same slot are rejected by the NOT EXISTS guard.
create or replace function public.claim_booking(p_booking uuid, p_nurse uuid)
returns setof public.bookings
language sql
volatile
security definer
set search_path = public
as $$
  update public.bookings b
  set status = 'assigned',
      nurse_id = p_nurse,
      updated_at = now()
  where b.id = p_booking
    and b.status = 'paid_unassigned'
    and not exists (
      select 1
      from public.bookings b2
      where b2.nurse_id = p_nurse
        and b2.id <> p_booking
        and b2.scheduled_date = b.scheduled_date
        and b2.scheduled_time = b.scheduled_time
        and b2.status in ('assigned', 'confirmed', 'in_progress')
    )
  returning *;
$$;

revoke execute on function public.claim_booking(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_booking(uuid, uuid) to service_role;

-- 3. Indexes -------------------------------------------------------------------
-- Nurse geo dispatch lookup
CREATE INDEX IF NOT EXISTS idx_nurses_status_city
  ON public.nurses (status, city);

CREATE INDEX IF NOT EXISTS idx_nurses_status_pincode
  ON public.nurses (status, pincode);

-- Time-slot conflict guard in findAvailableNurses + claim_booking NOT EXISTS
CREATE INDEX IF NOT EXISTS idx_bookings_nurse_slot
  ON public.bookings (nurse_id, scheduled_date, scheduled_time)
  WHERE status = ANY (ARRAY['assigned'::text, 'confirmed'::text, 'in_progress'::text]);