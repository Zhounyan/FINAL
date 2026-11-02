-- ============================================================================
-- INVPORTIQ — Helper functions, ledger enforcement and audit triggers
-- All SECURITY DEFINER functions pin search_path = '' and fully qualify names.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Identity / role helpers
-- ---------------------------------------------------------------------------
create or replace function public.current_app_role()
returns public.app_role
language sql stable security definer set search_path = ''
as $$
  select p.role from public.profiles p where p.id = auth.uid() and p.is_active
$$;

create or replace function public.has_role(variadic p_roles public.app_role[])
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(public.current_app_role() = any (p_roles), false)
$$;

create or replace function public.is_active_user()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.current_app_role() is not null
$$;

-- Raises 42501 unless the caller is an active user holding one of the roles.
create or replace function public.require_role(variadic p_roles public.app_role[])
returns public.profiles
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_profile public.profiles;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if v_profile.id is null or not v_profile.is_active then
    raise exception 'Your account is not active or you are not signed in.' using errcode = '42501';
  end if;
  if not (v_profile.role = any (p_roles)) then
    raise exception 'You do not have permission to perform this action.' using errcode = '42501';
  end if;
  return v_profile;
end
$$;

create or replace function public.store_timezone()
returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select s.value #>> '{}' from public.system_settings s where s.key = 'timezone'),
    'Asia/Manila')
$$;

-- ---------------------------------------------------------------------------
-- Audit logging
-- ---------------------------------------------------------------------------
create or replace function public.log_activity(
  p_action text, p_entity_type text, p_entity_id text, p_summary text, p_details jsonb default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  insert into public.activity_logs (user_id, user_name, action, entity_type, entity_id, summary, details)
  values (
    v_uid,
    coalesce((select full_name from public.profiles where id = v_uid), 'System'),
    p_action, p_entity_type, p_entity_id, p_summary, p_details);
end
$$;

-- Generic row-level audit trigger for master data tables.
create or replace function public.tg_audit_row()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_label text := coalesce(v_row ->> 'name', v_row ->> 'full_name', v_row ->> 'key', v_row ->> 'id');
  v_changes jsonb;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_object('from', o.value, 'to', n.value))
      into v_changes
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
     where n.value is distinct from o.value and n.key not in ('updated_at', 'current_stock');
    if v_changes is null then
      return new;
    end if;
  end if;

  perform public.log_activity(
    case tg_op when 'INSERT' then 'create' when 'UPDATE' then 'update' else 'delete' end,
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'key'),
    initcap(tg_op) || ' ' || replace(tg_table_name, '_', ' ') || ': ' || coalesce(v_label, ''),
    case when tg_op = 'UPDATE' then v_changes else v_row end);
  return coalesce(new, old);
end
$$;

-- ---------------------------------------------------------------------------
-- Timestamps & authorship
-- ---------------------------------------------------------------------------
create or replace function public.tg_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create or replace function public.tg_set_created_by()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.created_by := coalesce(auth.uid(), new.created_by);
  new.created_at := now();
  new.updated_at := now();
  return new;
end
$$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.tg_touch_updated_at();
create trigger categories_touch before update on public.categories
  for each row execute function public.tg_touch_updated_at();
create trigger products_touch before update on public.products
  for each row execute function public.tg_touch_updated_at();
create trigger customers_touch before update on public.customers
  for each row execute function public.tg_touch_updated_at();
create trigger suppliers_touch before update on public.suppliers
  for each row execute function public.tg_touch_updated_at();

create trigger categories_created_by before insert on public.categories
  for each row execute function public.tg_set_created_by();
create trigger products_created_by before insert on public.products
  for each row execute function public.tg_set_created_by();
create trigger customers_created_by before insert on public.customers
  for each row execute function public.tg_set_created_by();
create trigger suppliers_created_by before insert on public.suppliers
  for each row execute function public.tg_set_created_by();

create trigger categories_audit after insert or update or delete on public.categories
  for each row execute function public.tg_audit_row();
create trigger products_audit after insert or update or delete on public.products
  for each row execute function public.tg_audit_row();
create trigger customers_audit after insert or update or delete on public.customers
  for each row execute function public.tg_audit_row();
create trigger suppliers_audit after insert or update or delete on public.suppliers
  for each row execute function public.tg_audit_row();
create trigger system_settings_audit after update on public.system_settings
  for each row execute function public.tg_audit_row();

-- ---------------------------------------------------------------------------
-- Ledger enforcement
-- ---------------------------------------------------------------------------

-- products.current_stock may only change as a consequence of a ledger insert.
create or replace function public.tg_products_guard_stock()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.current_stock <> 0 then
      raise exception 'Products start with zero stock; record opening stock through a Stock In movement.'
        using errcode = '23514';
    end if;
  elsif new.current_stock is distinct from old.current_stock
        and coalesce(current_setting('invportiq.ledger_write', true), '') <> 'on' then
    raise exception 'Stock quantities can only change through recorded stock movements.'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger products_guard_stock before insert or update on public.products
  for each row execute function public.tg_products_guard_stock();

-- Fill in balances and snapshots, lock the product row, validate availability.
create or replace function public.tg_stock_movements_before_insert()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_product public.products;
begin
  select * into v_product from public.products where id = new.product_id for update;
  if v_product.id is null then
    raise exception 'Product % does not exist.', new.product_id using errcode = '23503';
  end if;

  new.quantity_before := v_product.current_stock;
  new.quantity_after  := v_product.current_stock + new.quantity_change;
  if new.quantity_after < 0 then
    raise exception 'Insufficient stock for "%": % % available, % requested.',
      v_product.name, v_product.current_stock, v_product.unit, abs(new.quantity_change)
      using errcode = 'P0001', hint = 'insufficient_stock';
  end if;

  new.product_name := v_product.name;
  new.product_sku  := v_product.sku;
  if new.movement_type <> 'reclassify' or new.category_id is null then
    new.category_id := v_product.category_id;
  end if;
  select c.name into new.category_name from public.categories c where c.id = new.category_id;

  -- Server-side timestamps only: guarantees day N ending stock = day N+1 beginning.
  new.occurred_at := now();
  new.created_at  := now();
  new.created_by  := coalesce(auth.uid(), new.created_by);
  new.created_by_name := coalesce(
    (select p.full_name from public.profiles p where p.id = new.created_by),
    new.created_by_name, 'System');
  return new;
end
$$;

create or replace function public.tg_stock_movements_after_insert()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform set_config('invportiq.ledger_write', 'on', true);
  update public.products set current_stock = new.quantity_after where id = new.product_id;
  perform set_config('invportiq.ledger_write', 'off', true);
  return null;
end
$$;

create trigger stock_movements_before_insert before insert on public.stock_movements
  for each row execute function public.tg_stock_movements_before_insert();
create trigger stock_movements_after_insert after insert on public.stock_movements
  for each row execute function public.tg_stock_movements_after_insert();

-- Immutable history: movements, sales and sale items can never be edited or removed.
create or replace function public.tg_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% records are permanent audit history and cannot be %. Record a reversing adjustment instead.',
    replace(tg_table_name, '_', ' '), lower(tg_op) || 'd'
    using errcode = '42501';
end
$$;

create trigger stock_movements_immutable before update or delete on public.stock_movements
  for each row execute function public.tg_block_mutation();
create trigger sales_immutable before update or delete on public.sales
  for each row execute function public.tg_block_mutation();
create trigger sale_items_immutable before update or delete on public.sale_items
  for each row execute function public.tg_block_mutation();
create trigger stock_movements_no_truncate before truncate on public.stock_movements
  for each statement execute function public.tg_block_mutation();
