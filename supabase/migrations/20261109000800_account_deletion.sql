-- ============================================================================
-- Account deletion with a 7-day recovery window (Admin only).
--   1. schedule_user_deletion: the account is disabled at once and marked for
--      deletion. It can be recovered for 7 days.
--   2. recover_user_account: undo within the 7 days.
--   3. After 7 days the account is permanently deleted: the sign-in (auth user)
--      is removed and personal details are erased. A "Deleted user" placeholder
--      row is kept so stock, sales and audit history stay complete (those
--      records already store the person's name at the time they were made).
-- The purge runs whenever an Admin opens User Management, and hourly if the
-- pg_cron extension is enabled in the project.
-- ============================================================================

alter table public.profiles
  add column if not exists deletion_scheduled_at timestamptz,
  add column if not exists deletion_prev_active boolean,
  add column if not exists deleted_at timestamptz;

-- Profiles must be able to outlive their sign-in so history keeps its links.
do $$
declare
  v_name text;
begin
  select conname into v_name
    from pg_constraint
   where conrelid = 'public.profiles'::regclass and contype = 'f'
     and confrelid = 'auth.users'::regclass;
  if v_name is not null then
    execute format('alter table public.profiles drop constraint %I', v_name);
  end if;
end $$;

create or replace function public.schedule_user_deletion(p_user_id uuid)
returns public.profiles
language plpgsql security definer set search_path = ''
as $$
declare
  v_target public.profiles;
begin
  perform public.require_role('admin');
  select * into v_target from public.profiles where id = p_user_id for update;
  if v_target.id is null or v_target.deleted_at is not null then
    raise exception 'Account not found.' using errcode = 'P0002';
  end if;
  if v_target.id = auth.uid() then
    raise exception 'You cannot delete your own account.' using errcode = 'P0001';
  end if;
  if v_target.role = 'admin' then
    raise exception 'Administrator accounts cannot be deleted.' using errcode = 'P0001';
  end if;
  if v_target.deletion_scheduled_at is not null then
    raise exception 'This account is already scheduled for deletion.' using errcode = 'P0001';
  end if;

  update public.profiles
     set deletion_scheduled_at = now(),
         deletion_prev_active = is_active,
         is_active = false
   where id = p_user_id
   returning * into v_target;

  -- Sign the person out everywhere (best effort; RLS already blocks inactive users).
  begin
    delete from auth.sessions where user_id = p_user_id;
  exception when others then
    null;
  end;

  perform public.log_activity('user_deletion_scheduled', 'profiles', p_user_id::text,
    format('Scheduled account %s (%s) for deletion on %s', v_target.full_name, v_target.email,
           to_char((now() + interval '7 days') at time zone public.store_timezone(), 'Mon DD, YYYY')),
    null);
  return v_target;
end
$$;

create or replace function public.recover_user_account(p_user_id uuid)
returns public.profiles
language plpgsql security definer set search_path = ''
as $$
declare
  v_target public.profiles;
begin
  perform public.require_role('admin');
  select * into v_target from public.profiles where id = p_user_id for update;
  if v_target.id is null or v_target.deleted_at is not null then
    raise exception 'This account has already been permanently deleted and cannot be recovered.' using errcode = 'P0002';
  end if;
  if v_target.deletion_scheduled_at is null then
    raise exception 'This account is not scheduled for deletion.' using errcode = 'P0001';
  end if;
  if v_target.deletion_scheduled_at <= now() - interval '7 days' then
    raise exception 'The 7-day recovery period for this account has ended.' using errcode = 'P0001';
  end if;

  update public.profiles
     set is_active = coalesce(deletion_prev_active, true),
         deletion_scheduled_at = null,
         deletion_prev_active = null
   where id = p_user_id
   returning * into v_target;

  perform public.log_activity('user_recovered', 'profiles', p_user_id::text,
    format('Recovered account %s (%s)', v_target.full_name, v_target.email), null);
  return v_target;
end
$$;

-- Internal: permanently delete accounts whose 7-day window has passed.
create or replace function public.purge_expired_user_deletions_internal()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.profiles;
  v_count integer := 0;
begin
  for v_row in
    select * from public.profiles
     where deletion_scheduled_at is not null
       and deleted_at is null
       and deletion_scheduled_at <= now() - interval '7 days'
     for update skip locked
  loop
    begin
      delete from auth.users where id = v_row.id;
    exception when others then
      raise warning 'Could not remove sign-in for %: %', v_row.id, sqlerrm;
    end;
    delete from public.auth_lockouts where email = lower(v_row.email);

    update public.profiles
       set email = 'deleted-' || v_row.id || '@deleted.invalid',
           full_name = 'Deleted user',
           phone = null,
           is_active = false,
           can_add_products = false,
           must_change_password = false,
           deleted_at = now()
     where id = v_row.id;

    insert into public.activity_logs (user_id, user_name, action, entity_type, entity_id, summary)
    values (null, 'System', 'user_deleted', 'profiles', v_row.id::text,
            format('Permanently deleted account %s (%s) after the 7-day recovery period', v_row.full_name, v_row.email));
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

-- Admin-callable wrapper (User Management calls it when opened).
create or replace function public.purge_expired_user_deletions()
returns integer
language plpgsql security definer set search_path = ''
as $$
begin
  perform public.require_role('admin');
  return public.purge_expired_user_deletions_internal();
end
$$;

revoke execute on function public.schedule_user_deletion(uuid) from public, anon;
revoke execute on function public.recover_user_account(uuid) from public, anon;
revoke execute on function public.purge_expired_user_deletions() from public, anon;
revoke execute on function public.purge_expired_user_deletions_internal() from public, anon, authenticated;
grant execute on function public.schedule_user_deletion(uuid) to authenticated, service_role;
grant execute on function public.recover_user_account(uuid) to authenticated, service_role;
grant execute on function public.purge_expired_user_deletions() to authenticated, service_role;
grant execute on function public.purge_expired_user_deletions_internal() to service_role;

-- Optional: run the purge hourly when pg_cron is enabled (Database -> Extensions).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('invportiq-purge-deleted-accounts', '17 * * * *',
                          'select public.purge_expired_user_deletions_internal()');
  end if;
exception when others then
  raise notice 'pg_cron schedule not created: %', sqlerrm;
end $$;

notify pgrst, 'reload schema';
