-- ============================================================================
-- Profile photos. The browser crops and resizes the picture to a small square
-- JPEG/PNG/WebP before upload, so it is stored directly on the profile as a
-- data URL (a few tens of KB). Users can only set or remove their own photo.
-- ============================================================================
alter table public.profiles
  add column if not exists avatar_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_avatar_url_chk') then
    alter table public.profiles add constraint profiles_avatar_url_chk check (
      avatar_url is null
      or (avatar_url ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' and char_length(avatar_url) <= 400000));
  end if;
end $$;

create or replace function public.update_my_avatar(p_avatar text)
returns public.profiles
language plpgsql security definer set search_path = ''
as $$
declare
  v_me public.profiles;
  v_avatar text := nullif(btrim(coalesce(p_avatar, '')), '');
begin
  perform public.require_role('owner', 'admin', 'staff');
  if v_avatar is not null and (
       v_avatar !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$'
       or char_length(v_avatar) > 400000) then
    raise exception 'The photo must be a JPEG, PNG or WebP image under 300 KB.' using errcode = '22023';
  end if;

  update public.profiles
     set avatar_url = v_avatar
   where id = auth.uid()
   returning * into v_me;

  perform public.log_activity('update', 'profiles', v_me.id::text,
    case when v_avatar is null then 'Removed profile photo' else 'Updated profile photo' end, null);
  return v_me;
end
$$;

revoke execute on function public.update_my_avatar(text) from public, anon;
grant execute on function public.update_my_avatar(text) to authenticated, service_role;

-- Permanent account deletion also erases the profile photo.
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
           avatar_url = null,
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

notify pgrst, 'reload schema';
