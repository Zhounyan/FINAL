-- ============================================================================
-- INVPORTIQ — Business operations (RPC)
-- Every inventory change runs in a single transaction and is written to the
-- immutable stock_movements ledger; products.current_stock follows the ledger.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Initial setup / account helpers
-- ---------------------------------------------------------------------------

-- Public (anon) probe used by the login page to decide whether to show setup.
create or replace function public.setup_status()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'setup_required', not exists (select 1 from public.setup_state),
    'store_name', coalesce((select value #>> '{}' from public.system_settings where key = 'store_name'), 'Bill Store'))
$$;

-- Called ONLY by the initial-setup edge function (service role).
-- The singleton primary key makes this atomic: a second caller always fails.
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

  update public.setup_state set admin_id = p_user_id;

  insert into public.activity_logs (user_id, user_name, action, entity_type, entity_id, summary)
  values (p_user_id, btrim(p_full_name), 'setup', 'system', null, 'Initial administrator account created');
end
$$;

-- Service role: revoke all refresh sessions of a user (password reset / deactivation).
create or replace function public.admin_revoke_sessions(p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  delete from auth.sessions where user_id = p_user_id;
end
$$;

-- Service role: brute-force protection for the login edge function.
create or replace function public.login_guard(p_email text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'locked', coalesce(l.locked_until > now(), false),
    'locked_until', l.locked_until,
    'failed_count', coalesce(l.failed_count, 0))
  from (select 1) d
  left join public.auth_lockouts l on l.email = lower(btrim(p_email))
$$;

create or replace function public.login_record(p_email text, p_success boolean, p_user_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_email text := lower(btrim(p_email));
  v_row public.auth_lockouts;
  c_max_attempts constant int := 5;
  c_lock_minutes constant int := 15;
begin
  if p_success then
    delete from public.auth_lockouts where email = v_email;
    if p_user_id is not null then
      update public.profiles set last_login_at = now() where id = p_user_id;
      insert into public.activity_logs (user_id, user_name, action, entity_type, entity_id, summary)
      select p.id, p.full_name, 'login', 'auth', p.id::text, 'Signed in' from public.profiles p where p.id = p_user_id;
    end if;
    return jsonb_build_object('locked', false);
  end if;

  insert into public.auth_lockouts as l (email, failed_count, last_failed_at)
  values (v_email, 1, now())
  on conflict (email) do update
    set failed_count = case
          when l.locked_until is not null and l.locked_until <= now() then 1   -- previous lock expired
          when l.last_failed_at < now() - make_interval(mins => c_lock_minutes) then 1
          else l.failed_count + 1 end,
        locked_until = case when l.locked_until <= now() then null else l.locked_until end,
        last_failed_at = now()
  returning * into v_row;

  if v_row.failed_count >= c_max_attempts then
    update public.auth_lockouts
       set locked_until = now() + make_interval(mins => c_lock_minutes)
     where email = v_email
     returning * into v_row;
  end if;

  return jsonb_build_object(
    'locked', coalesce(v_row.locked_until > now(), false),
    'locked_until', v_row.locked_until,
    'remaining_attempts', greatest(c_max_attempts - v_row.failed_count, 0));
end
$$;

-- Any active user: update own non-privileged profile fields.
create or replace function public.update_my_profile(p_full_name text, p_phone text default null)
returns public.profiles
language plpgsql security definer set search_path = ''
as $$
declare
  v_me public.profiles;
begin
  perform public.require_role('owner', 'admin', 'staff');
  update public.profiles
     set full_name = btrim(p_full_name),
         phone = nullif(btrim(coalesce(p_phone, '')), '')
   where id = auth.uid()
   returning * into v_me;
  perform public.log_activity('update', 'profiles', v_me.id::text, 'Updated own profile', null);
  return v_me;
end
$$;

-- Admin: change store settings with validation.
create or replace function public.update_setting(p_key text, p_value jsonb)
returns public.system_settings
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.system_settings;
begin
  perform public.require_role('admin');
  if p_key not in ('store_name', 'store_address', 'store_contact', 'currency', 'timezone', 'default_min_stock') then
    raise exception 'Unknown setting "%".', p_key using errcode = '22023';
  end if;
  if p_key = 'timezone' and not exists (select 1 from pg_catalog.pg_timezone_names where name = p_value #>> '{}') then
    raise exception 'Invalid time zone "%".', p_value #>> '{}' using errcode = '22023';
  end if;
  if p_key = 'default_min_stock' and (jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}')::numeric < 0) then
    raise exception 'Default minimum stock must be a non-negative number.' using errcode = '22023';
  end if;
  if p_key = 'store_name' and char_length(btrim(p_value #>> '{}')) < 2 then
    raise exception 'Store name is required.' using errcode = '22023';
  end if;

  update public.system_settings
     set value = p_value, updated_at = now(), updated_by = auth.uid()
   where key = p_key
   returning * into v_row;
  return v_row;
end
$$;

-- ---------------------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------------------
create or replace function public.create_product(
  p_sku text,
  p_name text,
  p_category_id bigint,
  p_unit text default 'pc',
  p_purchase_price numeric default 0,
  p_selling_price numeric default 0,
  p_min_stock_level integer default 0,
  p_description text default null,
  p_opening_stock integer default 0,
  p_supplier_id bigint default null)
returns public.products
language plpgsql security definer set search_path = ''
as $$
declare
  v_me public.profiles;
  v_product public.products;
begin
  v_me := public.require_role('admin', 'staff');
  if v_me.role = 'staff' and not v_me.can_add_products then
    raise exception 'Your account is not authorised to add products.' using errcode = '42501';
  end if;
  if coalesce(p_opening_stock, 0) < 0 then
    raise exception 'Opening stock cannot be negative.' using errcode = '22023';
  end if;
  if exists (select 1 from public.products where lower(btrim(sku)) = lower(btrim(p_sku))) then
    raise exception 'A product with SKU/Barcode "%" already exists.', btrim(p_sku) using errcode = '23505';
  end if;

  insert into public.products
    (sku, name, category_id, description, unit, purchase_price, selling_price, min_stock_level)
  values
    (btrim(p_sku), btrim(p_name), p_category_id, nullif(btrim(coalesce(p_description, '')), ''),
     coalesce(nullif(btrim(p_unit), ''), 'pc'), coalesce(p_purchase_price, 0), coalesce(p_selling_price, 0),
     coalesce(p_min_stock_level, 0))
  returning * into v_product;

  if coalesce(p_opening_stock, 0) > 0 then
    insert into public.stock_movements
      (movement_type, product_id, product_name, product_sku, category_id, category_name,
       quantity_change, quantity_before, quantity_after, unit_cost, supplier_id, reason, created_by_name)
    values
      ('stock_in', v_product.id, '', '', v_product.category_id, '', p_opening_stock, 0, 0,
       v_product.purchase_price, p_supplier_id, 'Opening stock', '');
    select * into v_product from public.products where id = v_product.id;
  end if;
  return v_product;
end
$$;

create or replace function public.update_product(
  p_id bigint,
  p_sku text,
  p_name text,
  p_category_id bigint,
  p_unit text,
  p_purchase_price numeric,
  p_selling_price numeric,
  p_min_stock_level integer,
  p_description text default null)
returns public.products
language plpgsql security definer set search_path = ''
as $$
declare
  v_old public.products;
  v_new public.products;
begin
  perform public.require_role('admin');
  select * into v_old from public.products where id = p_id for update;
  if v_old.id is null then
    raise exception 'Product not found.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.products where lower(btrim(sku)) = lower(btrim(p_sku)) and id <> p_id) then
    raise exception 'A product with SKU/Barcode "%" already exists.', btrim(p_sku) using errcode = '23505';
  end if;
  if not exists (select 1 from public.categories where id = p_category_id) then
    raise exception 'Category not found.' using errcode = '23503';
  end if;

  -- Category transfer: move the on-hand quantity out of the old category …
  if p_category_id <> v_old.category_id and v_old.current_stock > 0 then
    insert into public.stock_movements
      (movement_type, product_id, product_name, product_sku, category_id, category_name,
       quantity_change, quantity_before, quantity_after, reason, created_by_name)
    values ('reclassify', p_id, '', '', v_old.category_id, '', -v_old.current_stock, 0, 0,
            'Category transfer (out)', '');
  end if;

  update public.products
     set sku = btrim(p_sku),
         name = btrim(p_name),
         category_id = p_category_id,
         unit = coalesce(nullif(btrim(p_unit), ''), 'pc'),
         purchase_price = coalesce(p_purchase_price, 0),
         selling_price = coalesce(p_selling_price, 0),
         min_stock_level = coalesce(p_min_stock_level, 0),
         description = nullif(btrim(coalesce(p_description, '')), '')
   where id = p_id
   returning * into v_new;

  -- … and into the new one. Net effect on the product: zero.
  if p_category_id <> v_old.category_id and v_old.current_stock > 0 then
    insert into public.stock_movements
      (movement_type, product_id, product_name, product_sku, category_id, category_name,
       quantity_change, quantity_before, quantity_after, reason, created_by_name)
    values ('reclassify', p_id, '', '', p_category_id, '', v_old.current_stock, 0, 0,
            'Category transfer (in)', '');
    select * into v_new from public.products where id = p_id;
  end if;
  return v_new;
end
$$;

-- Safeguarded delete: products with history are archived, never destroyed.
create or replace function public.delete_product(p_id bigint)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_product public.products;
begin
  perform public.require_role('admin');
  select * into v_product from public.products where id = p_id for update;
  if v_product.id is null then
    raise exception 'Product not found.' using errcode = 'P0002';
  end if;
  if v_product.current_stock > 0 then
    raise exception '"%" still has % % in stock. Record a stock-out or adjustment to zero before removing it.',
      v_product.name, v_product.current_stock, v_product.unit using errcode = 'P0001';
  end if;
  if exists (select 1 from public.stock_movements where product_id = p_id)
     or exists (select 1 from public.sale_items where product_id = p_id) then
    update public.products set is_archived = true where id = p_id;
    return 'archived';
  end if;
  delete from public.products where id = p_id;
  return 'deleted';
end
$$;

create or replace function public.restore_product(p_id bigint)
returns public.products
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.products;
begin
  perform public.require_role('admin');
  update public.products set is_archived = false where id = p_id returning * into v_row;
  if v_row.id is null then
    raise exception 'Product not found.' using errcode = 'P0002';
  end if;
  return v_row;
end
$$;

-- ---------------------------------------------------------------------------
-- Categories, customers, suppliers — safeguarded deletes
-- ---------------------------------------------------------------------------
create or replace function public.delete_category(p_id bigint)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform public.require_role('admin');
  select count(*) into v_count from public.products where category_id = p_id;
  if v_count > 0 then
    raise exception 'This category still contains % product(s). Move them to another category first.', v_count
      using errcode = 'P0001';
  end if;
  if exists (select 1 from public.stock_movements where category_id = p_id) then
    raise exception 'This category appears in historical stock movements and must be kept for accurate reports.'
      using errcode = 'P0001';
  end if;
  delete from public.categories where id = p_id;
  if not found then
    raise exception 'Category not found.' using errcode = 'P0002';
  end if;
  return 'deleted';
end
$$;

create or replace function public.delete_customer(p_id bigint)
returns text
language plpgsql security definer set search_path = ''
as $$
begin
  perform public.require_role('admin');
  if not exists (select 1 from public.customers where id = p_id) then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.sales where customer_id = p_id)
     or exists (select 1 from public.stock_movements where customer_id = p_id) then
    update public.customers set is_archived = true where id = p_id;
    return 'archived';
  end if;
  delete from public.customers where id = p_id;
  return 'deleted';
end
$$;

create or replace function public.delete_supplier(p_id bigint)
returns text
language plpgsql security definer set search_path = ''
as $$
begin
  perform public.require_role('admin');
  if not exists (select 1 from public.suppliers where id = p_id) then
    raise exception 'Supplier not found.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.stock_movements where supplier_id = p_id) then
    update public.suppliers set is_archived = true where id = p_id;
    return 'archived';
  end if;
  delete from public.suppliers where id = p_id;
  return 'deleted';
end
$$;

-- ---------------------------------------------------------------------------
-- Stock operations
-- ---------------------------------------------------------------------------
create or replace function public.record_stock_in(
  p_product_id bigint,
  p_quantity integer,
  p_supplier_id bigint default null,
  p_reference_no text default null,
  p_reason text default null,
  p_unit_cost numeric default null)
returns public.stock_movements
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.stock_movements;
begin
  perform public.require_role('admin', 'staff');
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity received must be greater than zero.' using errcode = '22023';
  end if;
  if exists (select 1 from public.products where id = p_product_id and is_archived) then
    raise exception 'This product is archived. Restore it before recording stock.' using errcode = 'P0001';
  end if;

  insert into public.stock_movements
    (movement_type, product_id, product_name, product_sku, category_id, category_name,
     quantity_change, quantity_before, quantity_after, unit_cost, supplier_id, reference_no, reason, created_by_name)
  values
    ('stock_in', p_product_id, '', '', 0, '', p_quantity, 0, 0, p_unit_cost, p_supplier_id,
     nullif(btrim(coalesce(p_reference_no, '')), ''), nullif(btrim(coalesce(p_reason, '')), ''), '')
  returning * into v_row;

  perform public.log_activity('stock_in', 'stock_movements', v_row.id::text,
    format('Stock in: +%s %s', p_quantity, v_row.product_name),
    jsonb_build_object('product_id', p_product_id, 'quantity', p_quantity, 'reference_no', v_row.reference_no));
  return v_row;
end
$$;

-- Non-sale stock out: damaged, lost or other authorised releases.
create or replace function public.record_stock_out(
  p_product_id bigint,
  p_quantity integer,
  p_movement_type public.movement_type,
  p_customer_id bigint default null,
  p_reference_no text default null,
  p_reason text default null)
returns public.stock_movements
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.stock_movements;
begin
  perform public.require_role('admin', 'staff');
  if p_movement_type not in ('damaged', 'lost', 'other_out') then
    raise exception 'Use Record Sale for sold items. Stock-out type must be damaged, lost or other.'
      using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity released must be greater than zero.' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required for damaged, lost or other stock-out.' using errcode = '22023';
  end if;

  insert into public.stock_movements
    (movement_type, product_id, product_name, product_sku, category_id, category_name,
     quantity_change, quantity_before, quantity_after, customer_id, reference_no, reason, created_by_name)
  values
    (p_movement_type, p_product_id, '', '', 0, '', -p_quantity, 0, 0, p_customer_id,
     nullif(btrim(coalesce(p_reference_no, '')), ''), btrim(p_reason), '')
  returning * into v_row;

  perform public.log_activity('stock_out', 'stock_movements', v_row.id::text,
    format('Stock out (%s): -%s %s', replace(p_movement_type::text, '_', ' '), p_quantity, v_row.product_name),
    jsonb_build_object('product_id', p_product_id, 'quantity', p_quantity, 'type', p_movement_type));
  return v_row;
end
$$;

-- A sale and its stock deductions are one atomic transaction.
-- p_items: [{"product_id": 1, "quantity": 2}, ...]  (prices come from the product record)
create or replace function public.record_sale(
  p_items jsonb,
  p_customer_id bigint default null,
  p_reference_no text default null,
  p_notes text default null,
  p_client_request_id uuid default null)
returns public.sales
language plpgsql security definer set search_path = ''
as $$
declare
  v_me public.profiles;
  v_sale public.sales;
  v_item record;
  v_ref text;
  v_customer_name text;
begin
  v_me := public.require_role('admin', 'staff');

  -- Idempotency: a retried submission returns the original sale instead of selling twice.
  if p_client_request_id is not null then
    select * into v_sale from public.sales where client_request_id = p_client_request_id;
    if v_sale.id is not null then
      return v_sale;
    end if;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale must contain at least one item.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) e
              where (e ->> 'product_id') is null or coalesce((e ->> 'quantity')::int, 0) <= 0) then
    raise exception 'Every sale item needs a product and a quantity greater than zero.' using errcode = '22023';
  end if;

  if p_customer_id is not null then
    select full_name into v_customer_name from public.customers where id = p_customer_id and not is_archived;
    if v_customer_name is null then
      raise exception 'Customer not found.' using errcode = '23503';
    end if;
  end if;

  v_ref := nullif(btrim(coalesce(p_reference_no, '')), '');
  if v_ref is null then
    v_ref := 'SO-' || to_char(now() at time zone public.store_timezone(), 'YYYYMMDD-HH24MISS') || '-'
             || lpad((floor(random() * 10000))::int::text, 4, '0');
  end if;
  if exists (select 1 from public.sales where lower(btrim(reference_no)) = lower(v_ref)) then
    raise exception 'Sale reference "%" has already been recorded.', v_ref using errcode = '23505';
  end if;

  -- Merge duplicate lines, lock products in id order (deadlock-safe), validate.
  create temporary table if not exists pg_temp.sale_lines (
    product_id bigint primary key, quantity int, unit_price numeric(12,2)) on commit drop;
  truncate pg_temp.sale_lines;
  insert into pg_temp.sale_lines (product_id, quantity)
  select (e ->> 'product_id')::bigint, sum((e ->> 'quantity')::int)
    from jsonb_array_elements(p_items) e
   group by 1;

  select l.product_id into v_item
    from pg_temp.sale_lines l
   where not exists (select 1 from public.products p where p.id = l.product_id)
   limit 1;
  if found then
    raise exception 'Product % does not exist.', v_item.product_id using errcode = '23503';
  end if;

  for v_item in
    select l.product_id, l.quantity, p.name, p.selling_price, p.current_stock, p.unit, p.is_archived
      from pg_temp.sale_lines l
      join public.products p on p.id = l.product_id
     order by l.product_id
       for update of p
  loop
    if v_item.is_archived then
      raise exception '"%" is archived and cannot be sold.', v_item.name using errcode = 'P0001';
    end if;
    if v_item.current_stock < v_item.quantity then
      raise exception 'Insufficient stock for "%": % % available, % requested.',
        v_item.name, v_item.current_stock, v_item.unit, v_item.quantity
        using errcode = 'P0001', hint = 'insufficient_stock';
    end if;
    update pg_temp.sale_lines set unit_price = v_item.selling_price where product_id = v_item.product_id;
  end loop;

  insert into public.sales
    (reference_no, client_request_id, customer_id, customer_name, item_count, total_quantity,
     total_amount, notes, created_by, created_by_name)
  select v_ref, p_client_request_id, p_customer_id, v_customer_name, count(*), sum(quantity),
         sum(quantity * unit_price), nullif(btrim(coalesce(p_notes, '')), ''), v_me.id, v_me.full_name
    from pg_temp.sale_lines
  returning * into v_sale;

  insert into public.sale_items (sale_id, product_id, product_name, product_sku, quantity, unit_price)
  select v_sale.id, l.product_id, p.name, p.sku, l.quantity, l.unit_price
    from pg_temp.sale_lines l join public.products p on p.id = l.product_id;

  -- Exactly one ledger entry per sold line — the sale is never counted twice.
  insert into public.stock_movements
    (movement_type, product_id, product_name, product_sku, category_id, category_name,
     quantity_change, quantity_before, quantity_after, unit_price, customer_id, sale_id,
     reference_no, reason, created_by_name)
  select 'sale', l.product_id, '', '', 0, '', -l.quantity, 0, 0, l.unit_price, p_customer_id, v_sale.id,
         v_ref, 'Sale', ''
    from pg_temp.sale_lines l
   order by l.product_id;

  perform public.log_activity('sale', 'sales', v_sale.id::text,
    format('Sale %s: %s item(s), total %s', v_ref, v_sale.item_count, v_sale.total_amount),
    jsonb_build_object('reference_no', v_ref, 'total_amount', v_sale.total_amount));
  return v_sale;
end
$$;

-- Authorised correction. Either set the counted quantity or apply a +/- change.
create or replace function public.record_adjustment(
  p_product_id bigint,
  p_reason text,
  p_new_quantity integer default null,
  p_change integer default null,
  p_reference_no text default null)
returns public.stock_movements
language plpgsql security definer set search_path = ''
as $$
declare
  v_current int;
  v_change int;
  v_row public.stock_movements;
begin
  perform public.require_role('admin');
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'An adjustment reason is required.' using errcode = '22023';
  end if;
  if (p_new_quantity is null) = (p_change is null) then
    raise exception 'Provide either the new counted quantity or the adjustment quantity.' using errcode = '22023';
  end if;
  select current_stock into v_current from public.products where id = p_product_id for update;
  if v_current is null then
    raise exception 'Product not found.' using errcode = 'P0002';
  end if;
  if p_new_quantity is not null and p_new_quantity < 0 then
    raise exception 'New quantity cannot be negative.' using errcode = '22023';
  end if;
  v_change := coalesce(p_change, p_new_quantity - v_current);
  if v_change = 0 then
    raise exception 'The adjustment does not change the stock quantity.' using errcode = '22023';
  end if;

  insert into public.stock_movements
    (movement_type, product_id, product_name, product_sku, category_id, category_name,
     quantity_change, quantity_before, quantity_after, reference_no, reason, created_by_name)
  values
    ('adjustment', p_product_id, '', '', 0, '', v_change, 0, 0,
     nullif(btrim(coalesce(p_reference_no, '')), ''), btrim(p_reason), '')
  returning * into v_row;

  perform public.log_activity('adjustment', 'stock_movements', v_row.id::text,
    format('Adjustment: %s → %s (%s%s) %s', v_row.quantity_before, v_row.quantity_after,
      case when v_change > 0 then '+' else '' end, v_change, v_row.product_name),
    jsonb_build_object('product_id', p_product_id, 'previous', v_row.quantity_before,
      'change', v_change, 'new', v_row.quantity_after, 'reason', v_row.reason));
  return v_row;
end
$$;

-- Admin audit policy: an erroneous entry is never edited — it is reversed.
create or replace function public.reverse_movement(p_movement_id bigint, p_reason text)
returns public.stock_movements
language plpgsql security definer set search_path = ''
as $$
declare
  v_orig public.stock_movements;
  v_row public.stock_movements;
begin
  perform public.require_role('admin');
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required to reverse a movement.' using errcode = '22023';
  end if;
  select * into v_orig from public.stock_movements where id = p_movement_id;
  if v_orig.id is null then
    raise exception 'Movement not found.' using errcode = 'P0002';
  end if;
  if v_orig.movement_type in ('sale', 'reclassify') then
    raise exception 'Sales and category transfers cannot be reversed here. Record a stock-in (customer return) or adjustment instead.'
      using errcode = 'P0001';
  end if;
  if v_orig.reverses_movement_id is not null then
    raise exception 'This entry is itself a reversal and cannot be reversed again.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.stock_movements where reverses_movement_id = p_movement_id) then
    raise exception 'This movement has already been reversed.' using errcode = '23505';
  end if;

  insert into public.stock_movements
    (movement_type, product_id, product_name, product_sku, category_id, category_name,
     quantity_change, quantity_before, quantity_after, reverses_movement_id, reference_no, reason, created_by_name)
  values
    ('adjustment', v_orig.product_id, '', '', 0, '', -v_orig.quantity_change, 0, 0, v_orig.id,
     v_orig.reference_no, format('Reversal of #%s: %s', v_orig.id, btrim(p_reason)), '')
  returning * into v_row;

  perform public.log_activity('reverse', 'stock_movements', v_row.id::text,
    format('Reversed movement #%s (%s %s)', v_orig.id, v_orig.movement_type, v_orig.product_name),
    jsonb_build_object('reversed_id', v_orig.id, 'reason', p_reason));
  return v_row;
end
$$;
