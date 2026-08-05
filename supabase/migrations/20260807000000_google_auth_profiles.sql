-- Google OAuth Profile Provisioning Migration
-- ============================================================================
-- 1. Add email + updated_at to profiles (Google returns email in the token).
-- 2. Upgrade handle_new_user to an UPSERT so returning Google users have
--    full_name / avatar_url / email refreshed on every login (previously it
--    was INSERT-only, so re-logins never updated stale profile data).
-- 3. Guarantee the trigger exists idempotently (safe to re-run).
-- ============================================================================

-- 1. New columns ----------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS email text;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone;

-- 2. Upgrade the provisioning function ------------------------------------------
-- SECURITY DEFINER: runs as the table owner, bypasses RLS for the insert.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, avatar_url, email, updated_at)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name',
      new.raw_user_meta_data->>'email'
    ),
    coalesce(
      new.raw_user_meta_data->>'avatar_url',
      new.raw_user_meta_data->>'picture'
    ),
    new.email,
    now()
  )
  on conflict (id) do update
    set full_name = excluded.full_name,
        avatar_url = excluded.avatar_url,
        email = excluded.email,
        updated_at = excluded.updated_at;
  return new;
end;
$$;

-- 3. Recreate the trigger idempotently ------------------------------------------
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 4. Ensure profile RLS self-service policies exist (idempotent) -----------------
drop policy if exists "users view own profile" on public.profiles;
create policy "users view own profile"
  on public.profiles for select
  using ((auth.uid() = id));

drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile"
  on public.profiles for update
  using ((auth.uid() = id))
  with check ((auth.uid() = id));

-- 5. Prevent role self-escalation even through the Google flow -------------------
-- (Re-declared here for completeness; the hardening migration defines the same
--  trigger — this is a no-op if already present.)
drop trigger if exists trg_prevent_self_role_escalation on public.profiles;
create trigger trg_prevent_self_role_escalation
  before update on public.profiles
  for each row execute function public.prevent_self_role_escalation();