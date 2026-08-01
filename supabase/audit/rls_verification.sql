-- ============================================================================
-- CareConnect360 — RLS Post-Deployment Verification
-- Run against the LIVE Supabase database, e.g.:
--   supabase db execute --db-url "$DATABASE_URL" --file supabase/audit/rls_verification.sql
-- or via psql:
--   psql "$DATABASE_URL" -f supabase/audit/rls_verification.sql
--
-- Verifies:
--   1. Row Level Security is ENABLED on every public table.
--   2. No table is left with zero policies (unintentional blanket allow).
--   3. Every RLS policy is enumerated for review.
--   4. DML privileges granted to anon/authenticated are consistent with the
--      intended posture (RLS cannot protect what the role cannot even reach;
--      conversely, RLS only applies to roles that hold table privileges).
-- ============================================================================

\echo '===== 1. RLS ENABLEMENT PER TABLE (public schema) ====='
select
  c.relname                                        as table_name,
  c.relrowsecurity                                 as rls_enabled,
  c.relforcerowsecurity                            as rls_forced,
  coalesce(p.policy_count, 0)                      as policy_count
from pg_class c
left join lateral (
  select count(*) as policy_count
  from pg_policies pol
  where pol.schemaname = 'public'
    and pol.tablename  = c.relname
) p on true
where c.relkind = 'r'
  and c.relnamespace = 'pg_namespace'::regnamespace
  and c.relname not like 'pg_%'
order by c.relname;

\echo ''
\echo '===== 1b. ANY TABLE WITH RLS DISABLED? (must return ZERO rows) ====='
select
  c.relname as table_name
from pg_class c
where c.relkind = 'r'
  and c.relnamespace = 'public'::regnamespace
  and not c.relrowsecurity
  and c.relname not like 'pg_%'
order by c.relname;

\echo ''
\echo '===== 2. ALL RLS POLICIES (public schema) ====='
select
  tablename,
  policyname,
  cmd                                   as command,
  roles,
  qual                                  as using_expression,
  with_check
from pg_policies
where schemaname = 'public'
order by tablename, cmd, policyname;

\echo ''
\echo '===== 3. TABLES WITH RLS ENABLED BUT ZERO POLICIES (deny-all trap) ====='
-- Note: RLS with zero policies denies everything (except roles that bypass
-- RLS, e.g. service_role). This is SAFE but should be a deliberate choice.
select
  c.relname as table_name
from pg_class c
where c.relkind = 'r'
  and c.relnamespace = 'public'::regnamespace
  and c.relrowsecurity
  and not exists (
    select 1 from pg_policies pol
    where pol.schemaname = 'public' and pol.tablename = c.relname
  )
order by c.relname;

\echo ''
\echo '===== 4. TABLE PRIVILEGES GRANTED TO anon / authenticated / service_role ====='
-- RLS only gates rows for roles that have DML privileges. If a role has NO
-- SELECT/INSERT/UPDATE/DELETE grant, RLS policies for that role are moot.
-- Expected posture: anon/authenticated have no DML grants except where the
-- app deliberately reads client-side (e.g. authenticated SELECT on bookings,
-- profiles, invoices, nurses-own-record). Confirm each intentional grant.
select
  table_name,
  grantee,
  string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated', 'service_role')
group by table_name, grantee
order by table_name, grantee;

\echo ''
\echo '===== 5. SECURITY DEFINER FUNCTIONS (bypass RLS as owner — audit each) ====='
select
  p.proname                              as function_name,
  pg_get_userbyid(p.proowner)            as owner,
  p.prosecdef                            as security_definer,
  pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
order by p.proname;

\echo ''
\echo '===== 6. EXECUTE GRANTS ON SECURITY DEFINER FUNCTIONS ====='
-- e.g. admin_dashboard_data must be executable ONLY by service_role.
select
  p.proname as function_name,
  g.grantee,
  g.privilege_type
from information_schema.routine_privileges g
join pg_proc p on p.proname = g.routine_name
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
order by p.proname, g.grantee;

\echo ''
\echo '===== RLS VERIFICATION COMPLETE ====='
