-- ============================================================================
-- TASK-004: Deny non-service-role writes on bookings; deny anon on payments.
-- Additive migration — never edit prior migrations.
-- ============================================================================

-- 1. bookings: block INSERT/UPDATE/DELETE for everyone except service_role.
--    (service_role bypasses RLS by default, so submit.js / webhook still work.)
CREATE POLICY "Deny non-service-role INSERT on bookings"
  ON public.bookings
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (false);

CREATE POLICY "Deny non-service-role UPDATE on bookings"
  ON public.bookings
  FOR UPDATE
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Deny non-service-role DELETE on bookings"
  ON public.bookings
  FOR DELETE
  TO anon, authenticated
  USING (false);

-- 2. payments: explicit deny-all-anon policy (RLS was enabled with zero policies;
--    this closes the undocumented trap).
CREATE POLICY "Deny anon all operations on payments"
  ON public.payments
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);
