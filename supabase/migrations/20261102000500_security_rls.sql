-- ============================================================================
-- INVPORTIQ — Row Level Security & privileges
--   owner : read-only access to business data and reports
--   admin : full management (writes to inventory still go through RPCs)
--   staff : operational reads + permitted stock operations via RPCs
-- Inventory tables (products.current_stock, stock_movements, sales, sale_items)
-- are never writable directly by API roles; only SECURITY DEFINER RPCs that
-- enforce the role checks and the ledger can change them.
-- ============================================================================

alter table public.profiles         enable row level security;
alter table public.setup_state      enable row level security;
alter table public.auth_lockouts    enable row level security;
alter table public.system_settings  enable row level security;
alter table public.categories       enable row level security;
alter table public.products         enable row level security;
alter table public.customers        enable row level security;
alter table public.suppliers        enable row level security;
alter table public.sales            enable row level security;
alter table public.sale_items       enable row level security;
alter table public.stock_movements  enable row level security;
alter table public.activity_logs    enable row level security;

-- ---------------------------------------------------------------------------
-- Table privileges: start from nothing, then grant precisely.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.profiles, public.system_settings, public.categories, public.products,
                public.customers, public.suppliers, public.sales, public.sale_items,
                public.stock_movements, public.activity_logs,
                public.product_overview, public.customer_overview, public.supplier_overview
  to authenticated;

-- Direct writes only where RLS restricts them to admins and no ledger is involved.
grant insert, update on public.categories to authenticated;
grant insert, update on public.customers to authenticated;
grant insert, update on public.suppliers to authenticated;

-- Column-level protection: archive flags are toggled via the delete_* RPCs only.
revoke update on public.customers, public.suppliers from authenticated;
grant update (full_name, contact_number, email, address, is_archived) on public.customers to authenticated;
grant update (name, contact_person, contact_number, email, address, is_archived) on public.suppliers to authenticated;
revoke update on public.categories from authenticated;
grant update (name, description) on public.categories to authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

-- profiles: everyone sees their own row; admins see and manage all (writes via edge functions)
create policy profiles_select_self on public.profiles
  for select to authenticated using (id = auth.uid());
create policy profiles_select_admin on public.profiles
  for select to authenticated using (public.has_role('admin'));

-- settings: readable by any active user
create policy settings_select on public.system_settings
  for select to authenticated using (public.is_active_user());

-- categories
create policy categories_select on public.categories
  for select to authenticated using (public.is_active_user());
create policy categories_insert_admin on public.categories
  for insert to authenticated with check (public.has_role('admin'));
create policy categories_update_admin on public.categories
  for update to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));

-- products (writes via create_product / update_product / delete_product RPCs)
create policy products_select on public.products
  for select to authenticated using (public.is_active_user());

-- customers
create policy customers_select on public.customers
  for select to authenticated using (public.is_active_user());
create policy customers_insert_admin on public.customers
  for insert to authenticated with check (public.has_role('admin'));
create policy customers_update_admin on public.customers
  for update to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));

-- suppliers
create policy suppliers_select on public.suppliers
  for select to authenticated using (public.is_active_user());
create policy suppliers_insert_admin on public.suppliers
  for insert to authenticated with check (public.has_role('admin'));
create policy suppliers_update_admin on public.suppliers
  for update to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));

-- ledger & sales: read-only for every active role
create policy stock_movements_select on public.stock_movements
  for select to authenticated using (public.is_active_user());
create policy sales_select on public.sales
  for select to authenticated using (public.is_active_user());
create policy sale_items_select on public.sale_items
  for select to authenticated using (public.is_active_user());

-- activity logs: admin (full audit) and owner (monitoring); staff see their own
create policy activity_logs_select_admin_owner on public.activity_logs
  for select to authenticated using (public.has_role('admin', 'owner'));
create policy activity_logs_select_self on public.activity_logs
  for select to authenticated using (user_id = auth.uid() and public.is_active_user());

-- setup_state / auth_lockouts: no policies => no API access (service role bypasses RLS)

-- ---------------------------------------------------------------------------
-- Function privileges: deny by default, then allow per function.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

-- anonymous: only the setup probe
grant execute on function public.setup_status() to anon, authenticated;

-- helpers used inside RLS policies / views
grant execute on function public.current_app_role() to authenticated;
grant execute on function public.has_role(public.app_role[]) to authenticated;
grant execute on function public.is_active_user() to authenticated;
grant execute on function public.store_timezone() to authenticated;

-- business operations (each enforces its own role check)
grant execute on function public.update_my_profile(text, text) to authenticated;
grant execute on function public.update_setting(text, jsonb) to authenticated;
grant execute on function public.create_product(text, text, bigint, text, numeric, numeric, integer, text, integer, bigint) to authenticated;
grant execute on function public.update_product(bigint, text, text, bigint, text, numeric, numeric, integer, text) to authenticated;
grant execute on function public.delete_product(bigint) to authenticated;
grant execute on function public.restore_product(bigint) to authenticated;
grant execute on function public.delete_category(bigint) to authenticated;
grant execute on function public.delete_customer(bigint) to authenticated;
grant execute on function public.delete_supplier(bigint) to authenticated;
grant execute on function public.record_stock_in(bigint, integer, bigint, text, text, numeric) to authenticated;
grant execute on function public.record_stock_out(bigint, integer, public.movement_type, bigint, text, text) to authenticated;
grant execute on function public.record_sale(jsonb, bigint, text, text, uuid) to authenticated;
grant execute on function public.record_adjustment(bigint, text, integer, integer, text) to authenticated;
grant execute on function public.reverse_movement(bigint, text) to authenticated;

-- reporting
grant execute on function public.stock_movement_summary(date, date, text, bigint, bigint) to authenticated;
grant execute on function public.stock_movement_breakdown(date, date, text, bigint, bigint) to authenticated;
grant execute on function public.list_movements(date, date, bigint, bigint, public.movement_type[], text, integer, integer) to authenticated;
grant execute on function public.dashboard_stats(integer) to authenticated;

-- trusted server-side only (edge functions using the service role key)
grant execute on all functions in schema public to service_role;

-- Future functions are not executable by API roles unless granted explicitly.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: push ledger/master-data changes so dashboards refresh automatically
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.stock_movements, public.products,
      public.customers, public.suppliers, public.categories;
  end if;
end $$;
