-- ============================================================================
-- INVPORTIQ — Backup & Restore
--
-- * backup_runs        history of every backup attempt (manual, scheduled,
--                      safety, uploaded). Admin read-only; written only by the
--                      backup edge functions (service role).
-- * backup_settings    automatic-backup schedule (default Sunday 00:00, store
--                      time zone, keep 12) and the restore lock.
-- * backup_private     schema NOT exposed to the API: the cron token.
-- * backup_export_snapshot()  ONE SQL statement over every public table →
--                      a consistent snapshot; new tables are picked up
--                      automatically. backup_* tables are excluded.
-- * backup_restore_apply()    replaces all backed-up tables in ONE transaction,
--                      re-checks every foreign key and the stock ledger, and
--                      rolls back completely on any problem.
-- * Weekly scheduler: pg_cron calls the backup-scheduler edge function hourly;
--   the function decides whether this week's slot is due (no duplicates).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.backup_settings (
  singleton              boolean primary key default true check (singleton),
  auto_enabled           boolean not null default true,
  day_of_week            smallint not null default 0 check (day_of_week between 0 and 6),   -- 0 = Sunday
  hour_of_day            smallint not null default 0 check (hour_of_day between 0 and 23),  -- 0 = 12:00 AM
  retention_count        smallint not null default 12 check (retention_count between 1 and 104),
  scheduler_url          text,          -- edge function URL called by pg_cron (no secrets)
  restore_in_progress    uuid,          -- backup being restored (protected from deletion)
  restore_started_at     timestamptz,
  updated_at             timestamptz not null default now(),
  updated_by             uuid           -- no FK: restores must never be blocked by this table
);
insert into public.backup_settings (singleton) values (true) on conflict do nothing;

create table if not exists public.backup_runs (
  id                  uuid primary key default gen_random_uuid(),
  trigger             text not null check (trigger in ('manual', 'scheduled', 'safety', 'uploaded')),
  status              text not null default 'running' check (status in ('running', 'success', 'failed')),
  stage               text,
  schedule_slot       timestamptz,     -- the weekly slot a scheduled backup belongs to
  attempt             smallint not null default 1,
  filename            text,
  storage_path        text,
  size_bytes          bigint,
  sha256              text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  table_count         integer,
  record_count        bigint,
  file_count          integer,
  profile_photo_count integer,
  auth_user_count     integer,
  schema_signature    text,
  format_version      smallint,
  encryption_key_id   text,
  details             jsonb,           -- per-table counts and other metadata (no secrets)
  error               text,
  created_by          uuid,            -- no FK (see above); null = automatic scheduler
  created_by_name     text not null,
  created_at          timestamptz not null default now(),
  finished_at         timestamptz,
  last_restored_at    timestamptz
);
create index if not exists backup_runs_created_idx on public.backup_runs (created_at desc);
-- Duplicate prevention: one live (running or successful) scheduled backup per weekly slot.
create unique index if not exists backup_runs_one_per_slot
  on public.backup_runs (schedule_slot)
  where trigger = 'scheduled' and status in ('running', 'success');

create schema if not exists backup_private;
revoke all on schema backup_private from public;
create table if not exists backup_private.cron_secret (
  singleton boolean primary key default true check (singleton),
  token     text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Privileges & RLS: Admin may read; nobody writes through the API.
-- ---------------------------------------------------------------------------
alter table public.backup_settings enable row level security;
alter table public.backup_runs enable row level security;
revoke all on public.backup_settings, public.backup_runs from anon, authenticated;
grant select on public.backup_settings, public.backup_runs to authenticated;
grant all on public.backup_settings, public.backup_runs to service_role;

drop policy if exists backup_settings_admin_read on public.backup_settings;
create policy backup_settings_admin_read on public.backup_settings
  for select to authenticated using (public.has_role('admin'));
drop policy if exists backup_runs_admin_read on public.backup_runs;
create policy backup_runs_admin_read on public.backup_runs
  for select to authenticated using (public.has_role('admin'));

-- ---------------------------------------------------------------------------
-- Which tables are backed up: every base table in "public" except backup_*.
-- ---------------------------------------------------------------------------
create or replace function public.backup_table_list()
returns text[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(c.relname::text order by c.relname), '{}')
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname not like 'backup\_%'
$$;

-- Column signature used for compatibility checks between a backup and this database.
create or replace function public.backup_schema_info()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'tables', (
      select coalesce(jsonb_object_agg(t, cols), '{}')
        from (
          select c.relname::text as t,
                 jsonb_agg(jsonb_build_object(
                   'name', a.attname,
                   'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
                   'not_null', a.attnotnull,
                   'generated', a.attgenerated <> '',
                   'identity', a.attidentity <> '',
                   'default', pg_catalog.pg_get_expr(d.adbin, d.adrelid)) order by a.attnum) as cols
            from pg_catalog.pg_class c
            join pg_catalog.pg_namespace n on n.oid = c.relnamespace
            join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
            left join pg_catalog.pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
           where n.nspname = 'public' and c.relname = any (public.backup_table_list())
           group by c.relname) s),
    'constraints', (
      select coalesce(jsonb_agg(jsonb_build_object('table', cl.relname, 'name', co.conname, 'definition', pg_catalog.pg_get_constraintdef(co.oid)) order by cl.relname, co.conname), '[]')
        from pg_catalog.pg_constraint co
        join pg_catalog.pg_class cl on cl.oid = co.conrelid
        join pg_catalog.pg_namespace n on n.oid = cl.relnamespace
       where n.nspname = 'public' and cl.relname = any (public.backup_table_list())),
    'indexes', (
      select coalesce(jsonb_agg(jsonb_build_object('table', tablename, 'name', indexname, 'definition', indexdef) order by tablename, indexname), '[]')
        from pg_catalog.pg_indexes where schemaname = 'public' and tablename = any (public.backup_table_list())),
    'triggers', (
      select coalesce(jsonb_agg(jsonb_build_object('table', c.relname, 'name', tg.tgname, 'definition', pg_catalog.pg_get_triggerdef(tg.oid)) order by c.relname, tg.tgname), '[]')
        from pg_catalog.pg_trigger tg
        join pg_catalog.pg_class c on c.oid = tg.tgrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and not tg.tgisinternal),
    'policies', (
      select coalesce(jsonb_agg(jsonb_build_object('table', tablename, 'name', policyname, 'command', cmd, 'roles', roles, 'using', qual, 'check', with_check) order by tablename, policyname), '[]')
        from pg_catalog.pg_policies where schemaname = 'public'),
    'functions', (
      select coalesce(jsonb_agg(jsonb_build_object('name', p.proname, 'arguments', pg_catalog.pg_get_function_identity_arguments(p.oid), 'definition', pg_catalog.pg_get_functiondef(p.oid)) order by p.proname), '[]')
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f')
  )
$$;

-- ---------------------------------------------------------------------------
-- Consistent export: one dynamically built statement => one snapshot.
-- ---------------------------------------------------------------------------
create or replace function public.backup_export_snapshot()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_sql text;
  v_result jsonb;
begin
  select 'select jsonb_build_object(''tables'', ' ||
         coalesce(string_agg(
           format('jsonb_build_object(%L, (select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from public.%I x))', t, t),
           ' || '), '''{}''::jsonb') ||
         ', ''auth_users'', (select coalesce(jsonb_agg(jsonb_build_object(''id'', u.id, ''email'', u.email, ''created_at'', u.created_at) order by u.created_at), ''[]''::jsonb) from auth.users u)' ||
         ', ''snapshot_at'', now())'
    into v_sql
    from unnest(public.backup_table_list()) as t;
  execute v_sql into v_result;
  return v_result;
end
$$;

-- ---------------------------------------------------------------------------
-- Transactional restore. p_tables = {"table_name": [rows...], ...}
-- ---------------------------------------------------------------------------
create or replace function public.backup_restore_apply(p_tables jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_allowed text[] := public.backup_table_list();
  v_tables text[];
  v_order text[] := '{}';
  v_remaining text[];
  v_progress boolean;
  t text;
  v_cols text;
  v_counts jsonb := '{}';
  v_fk record;
  v_bad bigint;
  v_cond text;
  v_join text;
  v_col record;
  v_max bigint;
begin
  if p_tables is null or jsonb_typeof(p_tables) <> 'object' then
    raise exception 'Restore data must be an object of tables.' using errcode = '22023';
  end if;
  select array_agg(k order by k) into v_tables from jsonb_object_keys(p_tables) k;
  if v_tables is null then
    raise exception 'The backup contains no tables.' using errcode = '22023';
  end if;
  foreach t in array v_tables loop
    if not t = any (v_allowed) then
      raise exception 'Table "%" in the backup does not exist in this database or is protected.', t using errcode = '22023';
    end if;
    if jsonb_typeof(p_tables -> t) <> 'array' then
      raise exception 'Table "%" data is not a list of rows.', t using errcode = '22023';
    end if;
  end loop;

  -- Insert order: parents before children (self-references are checked at statement end).
  v_remaining := v_tables;
  while cardinality(v_remaining) > 0 loop
    v_progress := false;
    foreach t in array v_remaining loop
      if not exists (
        select 1 from pg_catalog.pg_constraint co
         where co.contype = 'f'
           and co.conrelid = format('public.%I', t)::regclass
           and co.confrelid <> co.conrelid
           and (select c.relname::text from pg_catalog.pg_class c where c.oid = co.confrelid) = any (v_remaining)) then
        v_order := v_order || t;
        v_remaining := array_remove(v_remaining, t);
        v_progress := true;
      end if;
    end loop;
    if not v_progress then
      raise exception 'Circular table dependencies prevent the restore: %', v_remaining using errcode = 'P0001';
    end if;
  end loop;

  -- User triggers (ledger guards, immutability, audit) are switched off for the
  -- restore only. ALTER TABLE is transactional: any error re-enables them.
  foreach t in array v_order loop
    execute format('alter table public.%I disable trigger user', t);
  end loop;

  execute 'truncate table ' || (select string_agg(format('public.%I', x), ', ') from unnest(v_order) x);

  foreach t in array v_order loop
    if jsonb_array_length(p_tables -> t) > 0 then
      -- only columns present in the backup and storable (not generated)
      select string_agg(format('%I', a.attname), ', ' order by a.attnum)
        into v_cols
        from pg_catalog.pg_attribute a
       where a.attrelid = format('public.%I', t)::regclass
         and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
         and (p_tables -> t -> 0) ? a.attname;
      begin
        execute format('insert into public.%I (%s) overriding system value select %s from jsonb_populate_recordset(null::public.%I, $1)',
                       t, v_cols, v_cols, t)
          using p_tables -> t;
      exception
        when foreign_key_violation then
          raise exception 'Restore rejected: rows in % break relationship (%).', t, sqlerrm using errcode = '23503';
        when unique_violation or not_null_violation or check_violation or invalid_text_representation or datatype_mismatch then
          raise exception 'Restore rejected: table % contains invalid data (%).', t, sqlerrm using errcode = '22023';
      end;
    end if;
    -- identity sequences continue after the restored ids
    for v_col in
      select a.attname from pg_catalog.pg_attribute a
       where a.attrelid = format('public.%I', t)::regclass and a.attidentity <> '' and not a.attisdropped
    loop
      execute format('select max(%I)::bigint from public.%I', v_col.attname, t) into v_max;
      perform pg_catalog.setval(pg_catalog.pg_get_serial_sequence(format('public.%I', t), v_col.attname), coalesce(v_max, 0) + 1, false);
    end loop;
    execute format('select count(*) from public.%I', t) into v_max;
    v_counts := v_counts || jsonb_build_object(t, v_max);
  end loop;

  foreach t in array v_order loop
    execute format('alter table public.%I enable trigger user', t);
  end loop;

  -- Verify every foreign key between restored rows (RI checks ran during insert;
  -- this re-check also covers rows inserted while user triggers were off).
  for v_fk in
    select co.conname, co.conrelid::regclass::text as child, co.confrelid::regclass::text as parent, co.conkey, co.confkey
      from pg_catalog.pg_constraint co
      join pg_catalog.pg_class c on c.oid = co.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where co.contype = 'f' and n.nspname = 'public' and c.relname::text = any (v_order)
  loop
    select string_agg(format('ch.%I is not null', a.attname), ' and '),
           string_agg(format('p.%I = ch.%I', pa.attname, a.attname), ' and ')
      into v_cond, v_join
      from unnest(v_fk.conkey, v_fk.confkey) as k(child_col, parent_col)
      join pg_catalog.pg_attribute a on a.attrelid = v_fk.child::regclass and a.attnum = k.child_col
      join pg_catalog.pg_attribute pa on pa.attrelid = v_fk.parent::regclass and pa.attnum = k.parent_col;
    execute format('select count(*) from %s ch where %s and not exists (select 1 from %s p where %s)',
                   v_fk.child, v_cond, v_fk.parent, v_join) into v_bad;
    if v_bad > 0 then
      raise exception 'Restore rejected: % row(s) in % break relationship %.', v_bad, v_fk.child, v_fk.conname using errcode = '23503';
    end if;
  end loop;

  -- Inventory ledger must still balance.
  if 'products' = any (v_order) and 'stock_movements' = any (v_order) then
    select count(*) into v_bad
      from public.products p
     where p.current_stock <> coalesce((select sum(m.quantity_change) from public.stock_movements m where m.product_id = p.id), 0);
    if v_bad > 0 then
      raise exception 'Restore rejected: % product(s) have stock that does not match the movement ledger.', v_bad using errcode = 'P0001';
    end if;
  end if;

  return jsonb_build_object(
    'tables', v_counts,
    'restored_order', to_jsonb(v_order),
    'profiles_without_login', (
      case when 'profiles' = any (v_order) then
        (select count(*) from public.profiles pr where pr.deleted_at is null and not exists (select 1 from auth.users u where u.id = pr.id))
      else 0 end));
end
$$;

-- Scheduled backups that are older than the newest N successful ones (retention).
create or replace function public.backup_retention_candidates(p_keep integer)
returns setof public.backup_runs
language sql stable security definer set search_path = ''
as $$
  select r.*
    from public.backup_runs r
   where r.trigger = 'scheduled' and r.status = 'success'
     and r.id is distinct from (select s.restore_in_progress from public.backup_settings s)
     and r.id not in (
       select x.id from public.backup_runs x
        where x.trigger = 'scheduled' and x.status = 'success'
        order by x.created_at desc
        limit greatest(p_keep, 1))
   order by r.created_at
$$;

-- Admin: change the automatic backup schedule.
create or replace function public.backup_update_settings(p_enabled boolean, p_day smallint, p_hour smallint, p_retention smallint)
returns public.backup_settings
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.backup_settings;
  v_old public.backup_settings;
begin
  perform public.require_role('admin');
  select * into v_old from public.backup_settings where singleton;
  update public.backup_settings
     set auto_enabled = coalesce(p_enabled, auto_enabled),
         day_of_week = coalesce(p_day, day_of_week),
         hour_of_day = coalesce(p_hour, hour_of_day),
         retention_count = coalesce(p_retention, retention_count),
         updated_at = now(),
         updated_by = auth.uid()
   where singleton
   returning * into v_row;
  perform public.log_activity('backup_settings_changed', 'backup_settings', null,
    format('Automatic backup %s · day %s · hour %s · keep %s',
           case when v_row.auto_enabled then 'enabled' else 'disabled' end, v_row.day_of_week, v_row.hour_of_day, v_row.retention_count),
    jsonb_build_object('from', jsonb_build_object('enabled', v_old.auto_enabled, 'day', v_old.day_of_week, 'hour', v_old.hour_of_day, 'retention', v_old.retention_count),
                       'to', jsonb_build_object('enabled', v_row.auto_enabled, 'day', v_row.day_of_week, 'hour', v_row.hour_of_day, 'retention', v_row.retention_count)));
  return v_row;
end
$$;

-- Admin: install / refresh the hourly pg_cron job that calls the scheduler function.
create or replace function public.backup_install_scheduler(p_functions_base_url text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_url text := rtrim(btrim(coalesce(p_functions_base_url, '')), '/') || '/functions/v1/backup-scheduler';
  v_cmd text;
begin
  perform public.require_role('admin');
  if v_url !~ '^https?://[A-Za-z0-9.:-]+/functions/v1/backup-scheduler$' then
    raise exception 'Invalid project URL.' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net') then
    raise exception 'Enable the pg_cron and pg_net extensions first (Database → Extensions).' using errcode = 'P0001';
  end if;
  insert into backup_private.cron_secret (singleton) values (true) on conflict do nothing;
  update public.backup_settings set scheduler_url = v_url, updated_at = now(), updated_by = auth.uid() where singleton;

  -- The command reads the token at run time; the token itself never appears in the job text.
  v_cmd := format($c$select net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'x-backup-cron-token', (select token from backup_private.cron_secret where singleton)), body := '{"source":"pg_cron"}'::jsonb, timeout_milliseconds := 120000)$c$, v_url);
  execute format('select cron.schedule(%L, %L, %L)', 'invportiq-weekly-backup-check', '7 * * * *', v_cmd);

  perform public.log_activity('backup_scheduler_installed', 'backup_settings', null, 'Installed the automatic backup scheduler (hourly check)', null);
  return jsonb_build_object('installed', true, 'url', v_url, 'schedule', '7 * * * *');
end
$$;

-- Admin: is the scheduler job installed?
create or replace function public.backup_scheduler_status()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_installed boolean := false;
  v_active boolean := false;
begin
  perform public.require_role('admin');
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    execute $q$select exists (select 1 from cron.job where jobname = 'invportiq-weekly-backup-check'),
                      coalesce((select active from cron.job where jobname = 'invportiq-weekly-backup-check'), false)$q$
      into v_installed, v_active;
  end if;
  return jsonb_build_object(
    'pg_cron', exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron'),
    'pg_net', exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net'),
    'installed', v_installed,
    'active', v_active);
end
$$;

-- Service role: verify the token sent by the cron job.
create or replace function public.backup_check_cron_token(p_token text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from backup_private.cron_secret s where s.singleton and s.token = p_token and length(p_token) >= 32)
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------
revoke execute on function public.backup_table_list() from public, anon, authenticated;
revoke execute on function public.backup_schema_info() from public, anon, authenticated;
revoke execute on function public.backup_export_snapshot() from public, anon, authenticated;
revoke execute on function public.backup_restore_apply(jsonb) from public, anon, authenticated;
revoke execute on function public.backup_retention_candidates(integer) from public, anon, authenticated;
revoke execute on function public.backup_check_cron_token(text) from public, anon, authenticated;
revoke execute on function public.backup_update_settings(boolean, smallint, smallint, smallint) from public, anon;
revoke execute on function public.backup_install_scheduler(text) from public, anon;
revoke execute on function public.backup_scheduler_status() from public, anon;
grant execute on function public.backup_table_list(), public.backup_schema_info(), public.backup_export_snapshot(),
  public.backup_restore_apply(jsonb), public.backup_retention_candidates(integer), public.backup_check_cron_token(text) to service_role;
grant execute on function public.backup_update_settings(boolean, smallint, smallint, smallint), public.backup_install_scheduler(text),
  public.backup_scheduler_status() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Private Storage bucket for encrypted archives (hosted Supabase only).
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_catalog.pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'storage' and c.relname = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('backups', 'backups', false, 104857600)
    on conflict (id) do update set public = false;
  end if;
end $$;

-- Enable the scheduler extensions where the platform allows it (ignored elsewhere).
do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'pg_cron not enabled automatically: %', sqlerrm;
end $$;
do $$
begin
  create extension if not exists pg_net with schema extensions;
exception when others then
  raise notice 'pg_net not enabled automatically: %', sqlerrm;
end $$;

notify pgrst, 'reload schema';
