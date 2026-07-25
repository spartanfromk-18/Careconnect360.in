-- ============================================================================
-- TASK-011: Allow nurses to SELECT their own record via RLS.
-- nurses table has RLS enabled but no direct SELECT policy — anon/authenticated
-- can't read any rows without this. service_role bypasses RLS, unaffected.
-- Additive migration — never edit prior migrations.
-- ============================================================================

CREATE POLICY "nurses view own record"
  ON public.nurses
  FOR SELECT
  TO authenticated
  USING (profile_id = auth.uid());
