-- ============================================================================
-- TASK-SESSION1: Close residual public INSERT policies on applications/callbacks.
--
-- Baseline (20260718084120_remote_schema.sql) permits anonymous INSERT with
-- WITH CHECK (true) on both tables. These rows are produced exclusively by
-- api/submit.js running as service_role, which bypasses RLS regardless. There
-- is no legitimate client-side (anon/authenticated) write path, so block it.
--
-- IMPORTANT: RLS permissive policies are OR'ed together, so merely ADDING a
-- deny-style policy (WITH CHECK (false)) does NOT revoke the existing
-- "Public can submit *" grant — anon/authenticated could still INSERT. The
-- permissive baseline policies must be DROPPED. The WITH CHECK (false)
-- policies below then remain as the only INSERT policies and deny everyone
-- who does not bypass RLS (service_role bypasses regardless).
-- Additive migration — never edit prior migrations.
-- ============================================================================

DROP POLICY IF EXISTS "Public can submit applications" ON public.applications;
DROP POLICY IF EXISTS "Public can submit callbacks" ON public.callbacks;

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
