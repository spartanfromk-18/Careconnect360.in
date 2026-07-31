-- 20260727000000_rpc_admin_applications_full_columns.sql
-- Extend the applications select in admin_dashboard_data to include every
-- column rendered by admin.html (mnc_registration, experience, speciality,
-- city, message). The prior narrow-select migration dropped these, so the
-- dashboard rendered them as empty even when data existed.

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
      from (
        select created_at, name, care_type, service, location, scheduled_date, scheduled_time, notes
        from public.bookings
        order by created_at desc
        limit p_limit offset p_bookings_offset
      ) b
    ),
    'callbacks', (
      select coalesce(jsonb_agg(c), '[]'::jsonb)
      from (
        select created_at, name, phone, preferred_time
        from public.callbacks
        order by created_at desc
        limit p_limit offset p_callbacks_offset
      ) c
    ),
    'applications', (
      select coalesce(jsonb_agg(a), '[]'::jsonb)
      from (
        select created_at, first_name, last_name, email, phone, mnc_registration, experience, speciality, city, message
        from public.applications
        order by created_at desc
        limit p_limit offset p_applications_offset
      ) a
    ),
    'payments', (
      select coalesce(jsonb_agg(p), '[]'::jsonb)
      from (
        select payment_id, amount_paise, status, created_at
        from public.payments
        order by created_at desc
        limit p_limit offset p_payments_offset
      ) p
    )
  ) into result;

  return result;
end;
$$;

revoke execute on function public.admin_dashboard_data from public, anon, authenticated;
grant execute on function public.admin_dashboard_data to service_role;
