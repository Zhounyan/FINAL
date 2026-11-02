-- ============================================================================
-- Fix: hosted Supabase loads the `safeupdate` extension for API sessions, which
-- rejects UPDATE/DELETE statements without a WHERE clause. The initial setup
-- updated the singleton setup_state row without one, so setup failed (and the
-- edge function rolled the account back). Add an explicit WHERE clause.
-- ============================================================================
create or replace function public.complete_initial_setup(p_user_id uuid, p_email text, p_full_name text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_inserted boolean;
begin
  if exists (select 1 from public.profiles where role = 'admin') then
    raise exception 'Initial setup has already been completed.' using errcode = '42501';
  end if;

  insert into public.setup_state (singleton) values (true)
  on conflict (singleton) do nothing
  returning true into v_inserted;

  if v_inserted is null then
    raise exception 'Initial setup has already been completed.' using errcode = '42501';
  end if;

  insert into public.profiles (id, email, full_name, role, is_active)
  values (p_user_id, lower(btrim(p_email)), btrim(p_full_name), 'admin', true);

  update public.setup_state set admin_id = p_user_id where singleton;

  insert into public.activity_logs (user_id, user_name, action, entity_type, entity_id, summary)
  values (p_user_id, btrim(p_full_name), 'setup', 'system', null, 'Initial administrator account created');
end
$$;

revoke execute on function public.complete_initial_setup(uuid, text, text) from public, anon, authenticated;
grant execute on function public.complete_initial_setup(uuid, text, text) to service_role;
