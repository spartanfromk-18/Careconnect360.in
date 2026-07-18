-- supabase/migrations/0002_hardening.sql
-- Applied on top of 20260718084120_remote_schema.sql (your real, pulled baseline).

-- ============================================================================
-- 1. CRITICAL: close the profile role-escalation gap.
-- ============================================================================
create or replace function public.prevent_self_role_escalation()
returns trigger as $$
begin
  if new.role is distinct from old.role and auth.role() <> 'service_role' then
    raise exception 'Only service-role callers may change profile role';
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_prevent_self_role_escalation on public.profiles;
create trigger trg_prevent_self_role_escalation
  before update on public.profiles
  for each row execute function public.prevent_self_role_escalation();

-- ============================================================================
-- 2. Dedupe redundant RLS policies.
-- ============================================================================
drop policy if exists "Patients can view own bookings" on public.bookings;
drop policy if exists "Patients can view own invoices" on public.invoices;

-- ============================================================================
-- 3. Dedupe redundant index on bookings.payment_id
-- ============================================================================
drop index if exists idx_bookings_payment;

-- ============================================================================
-- 4. Admin dashboard RPC
-- ============================================================================
create or replace function public.admin_dashboard_data(
  p_limit integer default 50,
  p_bookings_offset integer default 0,
  p_callbacks_offset integer default 0,
  p_applications_offset integer default 0,
  p_payments_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'bookings', (
      select coalesce(jsonb_agg(b), '[]'::jsonb)
      from (select * from public.bookings order by created_at desc limit p_limit offset p_bookings_offset) b
    ),
    'callbacks', (
      select coalesce(jsonb_agg(c), '[]'::jsonb)
      from (select * from public.callbacks order by created_at desc limit p_limit offset p_callbacks_offset) c
    ),
    'applications', (
      select coalesce(jsonb_agg(a), '[]'::jsonb)
      from (select * from public.applications order by created_at desc limit p_limit offset p_applications_offset) a
    ),
    'payments', (
      select coalesce(jsonb_agg(p), '[]'::jsonb)
      from (select * from public.payments order by created_at desc limit p_limit offset p_payments_offset) p
    )
  ) into result;

  return result;
end;
$$;

revoke execute on function public.admin_dashboard_data from public, anon, authenticated;
grant execute on function public.admin_dashboard_data to service_role;
