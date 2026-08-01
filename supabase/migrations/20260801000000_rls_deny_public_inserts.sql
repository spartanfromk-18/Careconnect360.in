-- ============================================================================
-- TASK-SESSION1: Close residual public INSERT policies on applications/callbacks.
--
-- Baseline (20260718084120_remote_schema.sql) permits anonymous INSERT with
-- WITH CHECK (true) on both tables. These rows are produced exclusively by
-- api/submit.js running as service_role, which bypasses RLS regardless. There
-- is no legitimate client-side (anon/authenticated) write path, so block it.
-- Additive migration — never edit prior migrations.
-- ============================================================================

CREATE POLICY "Deny non-service-role INSERT on applications"
  ON public.applications
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (false);

CREATE POLICY "Deny non-service-role INSERT on callbacks"
  ON public.callbacks
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (false);
