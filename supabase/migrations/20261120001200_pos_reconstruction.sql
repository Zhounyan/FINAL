-- ============================================================================
-- INVPORTIQ POS reconstruction — part 2 of 2.
--   * Two roles: Administrator + any number of Cashiers (owners retired)
--   * Usernames for cashier sign-in
--   * Products: barcode, default supplier, image
--   * POS sales: payment method, amount received, change, discount,
--     transaction number, invoice number, void with stock return
--   * Stock-in / stock-out reference numbers, new stock-out reasons
--   * Row level security: cashiers only see their own sales
--   * Six reports (sales + stock management × daily/weekly/monthly),
--     dashboards and fast POS product search
-- Requires 20261120001100_pos_roles_and_types.sql to have been applied first.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Accounts
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists username text;
alter table public.profiles drop constraint if exists profiles_username_chk;
alter table public.profiles add constraint profiles_username_chk
  check (username is null or username ~ '^[a-z0-9][a-z0-9._-]{2,31}$');
create unique index if not exists profiles_username_key on public.profiles (lower(username)) where username is not null;

-- Retire owner accounts: they keep their history but can no longer sign in.
do $$
declare
  v_id uuid;
begin
  for v_id in select id from public.profiles where role = 'owner' and is_active loop
    update public.profiles set is_active = false where id = v_id;
    perform public.admin_revoke_sessions(v_id);
    insert into public.activity_logs (user_id, user_name, action, entity_type, entity_id, summary)
    values (null, 'System', 'user_deactivated', 'profiles', v_id::text,
            'Owner role retired: account deactivated (history kept)');
  end loop;
  -- Block sign-in at the Auth level as well (hosted Supabase).
  if exists (select 1 from information_schema.columns
              where table_schema = 'auth' and table_name = 'users' and column_name = 'banned_until') then
    execute $q$update auth.users set banned_until = now() + interval '100 years'
               where id in (select id from public.profiles where role = 'owner')$q$;
  end if;
end $$;

alter table public.profiles drop constraint if exists profiles_owner_retired_chk;
alter table public.profiles add constraint profiles_owner_retired_chk check (role <> 'owner' or not is_active);

-- Cashiers no longer add products (Administrator only); the flag is kept for history.
update public.profiles set can_add_products = false where can_add_products;

create or replace function public.update_my_profile(p_full_name text, p_phone text default null)
returns public.profiles
language plpgsql security definer set search_path = ''
as $$
declare
  v_me public.profiles;
begin
  perform public.require_role('admin', 'cashier');
  if char_length(btrim(coalesce(p_full_name, ''))) < 2 then
    raise exception 'Full name is required.' using errcode = '22023';
  end if;
  update public.profiles
     set full_name = btrim(p_full_name),
         phone = nullif(btrim(coalesce(p_phone, '')), '')
   where id = auth.uid()
   returning * into v_me;
  perform public.log_activity('update', 'profiles', v_me.id::text, 'Updated own profile', null);
  return v_me;
end
$$;

create or replace function public.update_my_avatar(p_avatar text)
returns public.profiles
language plpgsql security definer set search_path = ''
as $$
declare
  v_me public.profiles;
  v_avatar text := nullif(btrim(coalesce(p_avatar, '')), '');
begin
  perform public.require_role('admin', 'cashier');
  if v_avatar is not null and (
       v_avatar !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$'
       or char_length(v_avatar) > 400000) then
    raise exception 'The photo must be a JPEG, PNG or WebP image under 300 KB.' using errcode = '22023';
  end if;
  update public.profiles set avatar_url = v_avatar where id = auth.uid() returning * into v_me;
  perform public.log_activity('update', 'profiles', v_me.id::text,
    case when v_avatar is null then 'Removed profile photo' else 'Updated profile photo' end, null);
  return v_me;
end
$$;

-- Sign-out is audited (sign-in is recorded by the auth-login Edge Function).
create or replace function public.log_logout()
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is not null then
    perform public.log_activity('logout', 'profiles', auth.uid()::text, 'Signed out', null);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Settings for the POS and invoices
-- ---------------------------------------------------------------------------
insert into public.system_settings (key, value) values
  ('payment_methods', '["cash", "gcash", "maya"]'),
  ('cashier_max_discount_pct', '0'),
  ('invoice_footer', '"Thank you for shopping at Bill Store!"'),
  ('store_tin', '""')
on conflict (key) do nothing;

create or replace function public.update_setting(p_key text, p_value jsonb)
returns public.system_settings
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.system_settings;
begin
  perform public.require_role('admin');
  if p_key not in ('store_name', 'store_address', 'store_contact', 'currency', 'timezone', 'default_min_stock',
                   'payment_methods', 'cashier_max_discount_pct', 'invoice_footer', 'store_tin') then
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
  if p_key = 'payment_methods' then
    if jsonb_typeof(p_value) <> 'array'
       or exists (select 1 from jsonb_array_elements_text(p_value) m
                   where m not in ('cash', 'gcash', 'maya', 'card', 'bank_transfer', 'other'))
       or not (p_value ? 'cash') then
      raise exception 'Payment methods must include Cash and may add GCash, Maya, Card, Bank Transfer or Other.'
        using errcode = '22023';
    end if;
  end if;
  if p_key = 'cashier_max_discount_pct'
     and (jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}')::numeric not between 0 and 100) then
    raise exception 'Cashier discount limit must be between 0 and 100 percent.' using errcode = '22023';
  end if;
  if p_key in ('invoice_footer', 'store_tin', 'store_address', 'store_contact')
     and char_length(coalesce(p_value #>> '{}', '')) > 300 then
    raise exception 'The value is too long (300 characters at most).' using errcode = '22023';
  end if;

  update public.system_settings
     set value = p_value, updated_at = now(), updated_by = auth.uid()
   where key = p_key
   returning * into v_row;
  return v_row;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Products: barcode, default supplier, image
-- ---------------------------------------------------------------------------
alter table public.products add column if not exists barcode text;
alter table public.products add column if not exists supplier_id bigint references public.suppliers (id) on delete set null;
alter table public.products add column if not exists image_url text;
alter table public.products drop constraint if exists products_barcode_chk;
alter table public.products add constraint products_barcode_chk
  check (barcode is null or barcode ~ '^[A-Za-z0-9._-]{3,64}$');
alter table public.products drop constraint if exists products_image_chk;
alter table public.products add constraint products_image_chk check (
  image_url is null
  or (image_url ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' and char_length(image_url) <= 400000));
create unique index if not exists products_barcode_key on public.products (lower(barcode)) where barcode is not null;
create index if not exists products_active_name_idx on public.products (lower(name)) where not is_archived;
create index if not exists products_supplier_idx on public.products (supplier_id) where supplier_id is not null;

-- Fast partial-name search for large catalogues (pg_trgm), when available.
do $$
begin
  create extension if not exists pg_trgm with schema extensions;
exception when others then
  begin
    create extension if not exists pg_trgm;
  exception when others then
    raise notice 'pg_trgm not available (%); falling back to b-tree indexes', sqlerrm;
  end;
end $$;
do $$
declare
  v_ops text;
begin
  select quote_ident(n.nspname) || '.gin_trgm_ops' into v_ops
    from pg_opclass o join pg_namespace n on n.oid = o.opcnamespace
   where o.opcname = 'gin_trgm_ops' limit 1;
  if v_ops is not null then
    execute format('create index if not exists products_name_trgm_idx on public.products using gin (name %s)', v_ops);
    execute format('create index if not exists products_sku_trgm_idx on public.products using gin (sku %s)', v_ops);
  end if;
end $$;

-- Audit rows without embedding large images.
create or replace function public.tg_audit_row()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old)) - 'image_url' - 'avatar_url';
  v_label text := coalesce(v_row ->> 'name', v_row ->> 'full_name', v_row ->> 'key', v_row ->> 'id');
  v_changes jsonb;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key,
             case when n.key = 'image_url' then jsonb_build_object('from', o.value is not null and o.value <> 'null'::jsonb,
                                                                    'to', n.value is not null and n.value <> 'null'::jsonb)
                  else jsonb_build_object('from', o.value, 'to', n.value) end)
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

create or replace function public.normalize_barcode(p text)
returns text
language sql immutable
as $$ select nullif(btrim(coalesce(p, '')), '') $$;

drop function if exists public.create_product(text, text, bigint, text, numeric, numeric, integer, text, integer, bigint);
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
  p_supplier_id bigint default null,
  p_barcode text default null,
  p_image_url text default null)
returns public.products
language plpgsql security definer set search_path = ''
as $$
declare
  v_product public.products;
  v_barcode text := public.normalize_barcode(p_barcode);
begin
  perform public.require_role('admin');
  if coalesce(p_opening_stock, 0) < 0 then
    raise exception 'Opening stock cannot be negative.' using errcode = '22023';
  end if;
  if coalesce(p_selling_price, 0) < 0 or coalesce(p_purchase_price, 0) < 0 then
    raise exception 'Prices cannot be negative.' using errcode = '22023';
  end if;
  if exists (select 1 from public.products where lower(btrim(sku)) = lower(btrim(p_sku))) then
    raise exception 'A product with SKU / product code "%" already exists.', btrim(p_sku) using errcode = '23505';
  end if;
  if v_barcode is not null and exists (select 1 from public.products where lower(barcode) = lower(v_barcode)) then
    raise exception 'A product with barcode "%" already exists.', v_barcode using errcode = '23505';
  end if;

  insert into public.products
    (sku, name, category_id, description, unit, purchase_price, selling_price, min_stock_level,
     barcode, supplier_id, image_url)
  values
    (btrim(p_sku), btrim(p_name), p_category_id, nullif(btrim(coalesce(p_description, '')), ''),
     coalesce(nullif(btrim(p_unit), ''), 'pc'), coalesce(p_purchase_price, 0), coalesce(p_selling_price, 0),
     coalesce(p_min_stock_level, 0), v_barcode, p_supplier_id, nullif(btrim(coalesce(p_image_url, '')), ''))
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

drop function if exists public.update_product(bigint, text, text, bigint, text, numeric, numeric, integer, text);
create or replace function public.update_product(
  p_id bigint,
  p_sku text,
  p_name text,
  p_category_id bigint,
  p_unit text,
  p_purchase_price numeric,
  p_selling_price numeric,
  p_min_stock_level integer,
  p_description text default null,
  p_barcode text default null,
  p_supplier_id bigint default null,
  p_image_url text default null,
  p_keep_image boolean default true)
returns public.products
language plpgsql security definer set search_path = ''
as $$
declare
  v_old public.products;
  v_new public.products;
  v_barcode text := public.normalize_barcode(p_barcode);
begin
  perform public.require_role('admin');
  select * into v_old from public.products where id = p_id for update;
  if v_old.id is null then
    raise exception 'Product not found.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.products where lower(btrim(sku)) = lower(btrim(p_sku)) and id <> p_id) then
    raise exception 'A product with SKU / product code "%" already exists.', btrim(p_sku) using errcode = '23505';
  end if;
  if v_barcode is not null
     and exists (select 1 from public.products where lower(barcode) = lower(v_barcode) and id <> p_id) then
    raise exception 'A product with barcode "%" already exists.', v_barcode using errcode = '23505';
  end if;
  if not exists (select 1 from public.categories where id = p_category_id) then
    raise exception 'Category not found.' using errcode = '23503';
  end if;

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
         description = nullif(btrim(coalesce(p_description, '')), ''),
         barcode = v_barcode,
         supplier_id = p_supplier_id,
         image_url = case when coalesce(p_keep_image, true) then image_url
                          else nullif(btrim(coalesce(p_image_url, '')), '') end
   where id = p_id
   returning * into v_new;

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

-- Product list read model (new columns appended at the end).
drop view if exists public.product_overview;
create view public.product_overview with (security_invoker = true) as
select
  p.id, p.sku, p.name, p.category_id, c.name as category_name, p.description, p.unit,
  p.purchase_price, p.selling_price, p.current_stock, p.min_stock_level, p.is_archived,
  p.created_at, p.updated_at, p.created_by,
  case
    when p.current_stock = 0 then 'out'
    when p.current_stock <= p.min_stock_level then 'low'
    else 'ok'
  end as stock_status,
  (p.current_stock * p.purchase_price)::numeric(14,2) as stock_value,
  p.barcode, p.supplier_id, s.name as supplier_name, (p.image_url is not null) as has_image
from public.products p
join public.categories c on c.id = p.category_id
left join public.suppliers s on s.id = p.supplier_id;
grant select on public.product_overview to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Stock ledger: reference numbers and new movement kinds
-- ---------------------------------------------------------------------------
alter table public.stock_movements drop constraint if exists stock_movements_sign_chk;
alter table public.stock_movements add constraint stock_movements_sign_chk check (
  case movement_type
    when 'stock_in' then quantity_change > 0
    when 'sale' then quantity_change < 0
    when 'sale_void' then quantity_change > 0
    when 'damaged' then quantity_change < 0
    when 'expired' then quantity_change < 0
    when 'lost' then quantity_change < 0
    when 'internal_use' then quantity_change < 0
    when 'other_out' then quantity_change < 0
    else true
  end);
alter table public.stock_movements drop constraint if exists stock_movements_sale_link_chk;
alter table public.stock_movements add constraint stock_movements_sale_link_chk
  check ((movement_type in ('sale', 'sale_void')) = (sale_id is not null));

-- Unique, human-readable reference for every movement: IN-000123, OUT-000124, ...
alter table public.stock_movements add column if not exists movement_no text generated always as (
  case
    when movement_type = 'stock_in' then 'IN-'
    when movement_type = 'sale' then 'SAL-'
    when movement_type = 'sale_void' then 'VOID-'
    when movement_type in ('adjustment', 'reclassify') then 'ADJ-'
    else 'OUT-'
  end || lpad(id::text, 6, '0')) stored;
create unique index if not exists stock_movements_movement_no_key on public.stock_movements (movement_no);
create index if not exists stock_movements_user_idx on public.stock_movements (created_by, occurred_at desc);

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
  perform public.require_role('admin');
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity received must be greater than zero.' using errcode = '22023';
  end if;
  if p_unit_cost is not null and p_unit_cost < 0 then
    raise exception 'Unit cost cannot be negative.' using errcode = '22023';
  end if;
  if p_supplier_id is not null and not exists (select 1 from public.suppliers where id = p_supplier_id) then
    raise exception 'Supplier not found.' using errcode = '23503';
  end if;
  if exists (select 1 from public.products where id = p_product_id and is_archived) then
    raise exception 'This product is archived. Restore it before receiving stock.' using errcode = 'P0001';
  end if;

  insert into public.stock_movements
    (movement_type, product_id, product_name, product_sku, category_id, category_name,
     quantity_change, quantity_before, quantity_after, unit_cost, supplier_id, reference_no, reason, created_by_name)
  values
    ('stock_in', p_product_id, '', '', 0, '', p_quantity, 0, 0, p_unit_cost, p_supplier_id,
     nullif(btrim(coalesce(p_reference_no, '')), ''), nullif(btrim(coalesce(p_reason, '')), ''), '')
  returning * into v_row;

  perform public.log_activity('stock_in', 'stock_movements', v_row.id::text,
    format('Stock-In %s: +%s %s (%s → %s)', v_row.movement_no, p_quantity, v_row.product_name,
           v_row.quantity_before, v_row.quantity_after),
    jsonb_build_object('movement_no', v_row.movement_no, 'product_id', p_product_id, 'quantity', p_quantity,
                       'supplier_id', p_supplier_id, 'reference_no', v_row.reference_no));
  return v_row;
end
$$;

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
  perform public.require_role('admin');
  if p_movement_type not in ('damaged', 'expired', 'lost', 'internal_use', 'other_out') then
    raise exception 'Choose a stock-out reason: damaged, expired, missing/lost, internal use or other. Sales are recorded in the POS.'
      using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity released must be greater than zero.' using errcode = '22023';
  end if;
  if p_movement_type = 'other_out' and nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Remarks are required when the reason is "Other".' using errcode = '22023';
  end if;

  insert into public.stock_movements
    (movement_type, product_id, product_name, product_sku, category_id, category_name,
     quantity_change, quantity_before, quantity_after, customer_id, reference_no, reason, created_by_name)
  values
    (p_movement_type, p_product_id, '', '', 0, '', -p_quantity, 0, 0, p_customer_id,
     nullif(btrim(coalesce(p_reference_no, '')), ''), nullif(btrim(coalesce(p_reason, '')), ''), '')
  returning * into v_row;

  perform public.log_activity('stock_out', 'stock_movements', v_row.id::text,
    format('Stock-Out %s (%s): -%s %s (%s → %s)', v_row.movement_no, replace(p_movement_type::text, '_', ' '),
           p_quantity, v_row.product_name, v_row.quantity_before, v_row.quantity_after),
    jsonb_build_object('movement_no', v_row.movement_no, 'product_id', p_product_id, 'quantity', p_quantity,
                       'type', p_movement_type));
  return v_row;
end
$$;

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
  if v_orig.movement_type in ('sale', 'sale_void', 'reclassify') then
    raise exception 'Sales are corrected by voiding the transaction in Sales Transactions; category transfers cannot be reversed.'
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
     v_orig.movement_no, format('Reversal of %s: %s', v_orig.movement_no, btrim(p_reason)), '')
  returning * into v_row;

  perform public.log_activity('reverse', 'stock_movements', v_row.id::text,
    format('Reversed %s (%s %s)', v_orig.movement_no, v_orig.movement_type, v_orig.product_name),
    jsonb_build_object('reversed_id', v_orig.id, 'reason', p_reason));
  return v_row;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Sales: payments, discounts, invoice numbers, void
-- ---------------------------------------------------------------------------
create sequence if not exists public.sale_txn_seq;
revoke all on sequence public.sale_txn_seq from anon, authenticated;

alter table public.sales add column if not exists discount_amount numeric(14,2) not null default 0;
alter table public.sales add column if not exists payment_method text not null default 'cash';
alter table public.sales add column if not exists payment_reference text;
alter table public.sales add column if not exists amount_received numeric(14,2);
alter table public.sales add column if not exists change_amount numeric(14,2) not null default 0;
alter table public.sales add column if not exists status text not null default 'completed';
alter table public.sales add column if not exists payment_status text not null default 'paid';
alter table public.sales add column if not exists voided_at timestamptz;
alter table public.sales add column if not exists voided_by uuid references public.profiles (id) on delete set null;
alter table public.sales add column if not exists voided_by_name text;
alter table public.sales add column if not exists void_reason text;
alter table public.sales add column if not exists subtotal numeric(14,2)
  generated always as (total_amount + discount_amount) stored;
alter table public.sales add column if not exists invoice_no text
  generated always as ('INV-' || lpad(id::text, 6, '0')) stored;

alter table public.sales drop constraint if exists sales_pos_chk;
alter table public.sales add constraint sales_pos_chk check (
  discount_amount >= 0
  and change_amount >= 0
  and (amount_received is null or amount_received >= 0)
  and payment_method ~ '^[a-z_]{2,30}$'
  and (payment_reference is null or char_length(payment_reference) <= 80)
  and status in ('completed', 'voided')
  and payment_status in ('paid', 'refunded')
  and ((status = 'voided') = (voided_at is not null))
  and (void_reason is null or char_length(void_reason) <= 500));
create unique index if not exists sales_invoice_no_key on public.sales (invoice_no);
create index if not exists sales_cashier_idx on public.sales (created_by, sold_at desc);
create index if not exists sales_status_idx on public.sales (status, sold_at desc);
create index if not exists sales_payment_idx on public.sales (payment_method, sold_at desc);

-- Sales stay permanent. The only allowed change is the void stamp, written by void_sale().
drop trigger if exists sales_immutable on public.sales;
create or replace function public.tg_sales_guard()
returns trigger
language plpgsql
as $$
declare
  -- generated columns (subtotal, invoice_no) are not yet computed in BEFORE triggers
  c_void_cols text[] := array['status', 'payment_status', 'voided_at', 'voided_by', 'voided_by_name', 'void_reason',
                              'subtotal', 'invoice_no'];
begin
  if tg_op = 'DELETE' then
    raise exception 'sales records are permanent audit history and cannot be deleted. Void the transaction instead.'
      using errcode = '42501';
  end if;
  if coalesce(current_setting('invportiq.sale_void', true), '') <> 'on'
     or (to_jsonb(new) - c_void_cols) is distinct from (to_jsonb(old) - c_void_cols) then
    raise exception 'sales records are permanent audit history and cannot be updated. Void the transaction instead.'
      using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger sales_guard before update or delete on public.sales
  for each row execute function public.tg_sales_guard();

drop function if exists public.record_sale(jsonb, bigint, text, text, uuid);
create or replace function public.record_sale(
  p_items jsonb,
  p_payment_method text default 'cash',
  p_amount_received numeric default null,
  p_discount numeric default 0,
  p_customer_id bigint default null,
  p_customer_name text default null,
  p_payment_reference text default null,
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
  v_method text := lower(btrim(coalesce(p_payment_method, 'cash')));
  v_subtotal numeric(14,2);
  v_discount numeric(14,2) := round(coalesce(p_discount, 0), 2);
  v_total numeric(14,2);
  v_received numeric(14,2);
  v_max_pct numeric;
begin
  v_me := public.require_role('admin', 'cashier');

  -- Idempotency: a retried or double-clicked submission returns the original sale.
  if p_client_request_id is not null then
    select * into v_sale from public.sales where client_request_id = p_client_request_id;
    if v_sale.id is not null then
      if v_sale.created_by is distinct from v_me.id then
        raise exception 'This transaction belongs to another cashier.' using errcode = '42501';
      end if;
      return v_sale;
    end if;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one product to the sale.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 500 then
    raise exception 'A sale can contain at most 500 lines.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) e
              where jsonb_typeof(e -> 'product_id') <> 'number' or jsonb_typeof(e -> 'quantity') <> 'number'
                 or (e ->> 'quantity')::numeric <> trunc((e ->> 'quantity')::numeric)
                 or (e ->> 'quantity')::numeric <= 0 or (e ->> 'quantity')::numeric > 100000) then
    raise exception 'Every item needs a product and a whole-number quantity greater than zero.' using errcode = '22023';
  end if;

  if v_method <> 'cash' and not exists (
       select 1 from public.system_settings s, jsonb_array_elements_text(s.value) m
        where s.key = 'payment_methods' and m = v_method) then
    raise exception 'The payment method "%" is not enabled.', v_method using errcode = '22023';
  end if;

  if p_customer_id is not null then
    select full_name into v_customer_name from public.customers where id = p_customer_id and not is_archived;
    if v_customer_name is null then
      raise exception 'Customer not found.' using errcode = '23503';
    end if;
  else
    v_customer_name := nullif(btrim(coalesce(p_customer_name, '')), '');
    if char_length(v_customer_name) > 120 then
      raise exception 'Customer name is too long.' using errcode = '22023';
    end if;
  end if;

  -- Merge duplicate lines, lock products in id order (deadlock-safe), validate stock.
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
    raise exception 'A product in the cart no longer exists. Remove it and try again.' using errcode = '23503';
  end if;

  for v_item in
    select l.product_id, l.quantity, p.name, p.selling_price, p.current_stock, p.unit, p.is_archived
      from pg_temp.sale_lines l
      join public.products p on p.id = l.product_id
     order by l.product_id
       for update of p
  loop
    if v_item.is_archived then
      raise exception '"%" is no longer sold. Remove it from the cart.', v_item.name using errcode = 'P0001';
    end if;
    if v_item.current_stock < v_item.quantity then
      raise exception 'Not enough stock for "%": only % % left, % in the cart.',
        v_item.name, v_item.current_stock, v_item.unit, v_item.quantity
        using errcode = 'P0001', hint = 'insufficient_stock';
    end if;
    update pg_temp.sale_lines set unit_price = v_item.selling_price where product_id = v_item.product_id;
  end loop;

  select sum(quantity * unit_price) into v_subtotal from pg_temp.sale_lines;
  if v_discount < 0 or v_discount > v_subtotal then
    raise exception 'The discount must be between 0 and the subtotal.' using errcode = '22023';
  end if;
  if v_discount > 0 and v_me.role = 'cashier' then
    select coalesce((value #>> '{}')::numeric, 0) into v_max_pct
      from public.system_settings where key = 'cashier_max_discount_pct';
    if v_discount > round(v_subtotal * coalesce(v_max_pct, 0) / 100, 2) then
      raise exception 'This discount needs the Administrator (cashier limit: % percent).', coalesce(v_max_pct, 0)
        using errcode = '42501';
    end if;
  end if;
  v_total := v_subtotal - v_discount;

  if v_method = 'cash' then
    v_received := round(coalesce(p_amount_received, -1), 2);
    if v_received < v_total then
      raise exception 'Amount received is less than the total amount.' using errcode = '22023';
    end if;
  else
    v_received := v_total;
  end if;

  v_ref := 'TXN-' || to_char(now() at time zone public.store_timezone(), 'YYYYMMDD') || '-'
           || lpad(nextval('public.sale_txn_seq')::text, 5, '0');

  insert into public.sales
    (reference_no, client_request_id, customer_id, customer_name, item_count, total_quantity,
     total_amount, discount_amount, payment_method, payment_reference, amount_received, change_amount,
     notes, created_by, created_by_name)
  select v_ref, p_client_request_id, p_customer_id, v_customer_name, count(*), sum(quantity),
         v_total, v_discount, v_method, nullif(btrim(coalesce(p_payment_reference, '')), ''),
         v_received, v_received - v_total,
         nullif(btrim(coalesce(p_notes, '')), ''), v_me.id, v_me.full_name
    from pg_temp.sale_lines
  returning * into v_sale;

  insert into public.sale_items (sale_id, product_id, product_name, product_sku, quantity, unit_price)
  select v_sale.id, l.product_id, p.name, p.sku, l.quantity, l.unit_price
    from pg_temp.sale_lines l join public.products p on p.id = l.product_id;

  insert into public.stock_movements
    (movement_type, product_id, product_name, product_sku, category_id, category_name,
     quantity_change, quantity_before, quantity_after, unit_price, customer_id, sale_id,
     reference_no, reason, created_by_name)
  select 'sale', l.product_id, '', '', 0, '', -l.quantity, 0, 0, l.unit_price, p_customer_id, v_sale.id,
         v_ref, 'Sale ' || v_sale.invoice_no, ''
    from pg_temp.sale_lines l
   order by l.product_id;

  perform public.log_activity('sale', 'sales', v_sale.id::text,
    format('Sale %s: %s item(s), total %s (%s)', v_ref, v_sale.item_count, v_sale.total_amount, v_method),
    jsonb_build_object('reference_no', v_ref, 'invoice_no', v_sale.invoice_no, 'total_amount', v_sale.total_amount,
                       'discount', v_discount, 'payment_method', v_method));
  perform public.log_activity('invoice_generated', 'sales', v_sale.id::text,
    format('Invoice %s generated for %s', v_sale.invoice_no, v_ref), null);
  return v_sale;
end
$$;

-- Administrator: void (cancel) a completed sale. Stock is returned through the
-- ledger; the sale and its invoice stay on record, clearly marked VOID.
create or replace function public.void_sale(p_sale_id bigint, p_reason text)
returns public.sales
language plpgsql security definer set search_path = ''
as $$
declare
  v_me public.profiles;
  v_sale public.sales;
begin
  v_me := public.require_role('admin');
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required to void a transaction.' using errcode = '22023';
  end if;
  select * into v_sale from public.sales where id = p_sale_id for update;
  if v_sale.id is null then
    raise exception 'Transaction not found.' using errcode = 'P0002';
  end if;
  if v_sale.status = 'voided' then
    raise exception 'This transaction has already been voided.' using errcode = '23505';
  end if;

  perform set_config('invportiq.sale_void', 'on', true);
  update public.sales
     set status = 'voided', payment_status = 'refunded', voided_at = now(),
         voided_by = v_me.id, voided_by_name = v_me.full_name, void_reason = btrim(p_reason)
   where id = p_sale_id
   returning * into v_sale;
  perform set_config('invportiq.sale_void', 'off', true);

  insert into public.stock_movements
    (movement_type, product_id, product_name, product_sku, category_id, category_name,
     quantity_change, quantity_before, quantity_after, unit_price, customer_id, sale_id,
     reference_no, reason, created_by_name)
  select 'sale_void', i.product_id, '', '', 0, '', i.quantity, 0, 0, i.unit_price, v_sale.customer_id, v_sale.id,
         v_sale.reference_no, 'Void of ' || v_sale.invoice_no || ': ' || btrim(p_reason), ''
    from public.sale_items i
   where i.sale_id = p_sale_id
   order by i.product_id;

  perform public.log_activity('sale_voided', 'sales', v_sale.id::text,
    format('Voided %s / %s (%s): %s', v_sale.reference_no, v_sale.invoice_no, v_sale.total_amount, btrim(p_reason)),
    jsonb_build_object('reference_no', v_sale.reference_no, 'invoice_no', v_sale.invoice_no,
                       'total_amount', v_sale.total_amount));
  return v_sale;
end
$$;

-- Printing / exporting an invoice is audited. Cashiers may only use their own invoices.
create or replace function public.log_invoice_action(p_sale_id bigint, p_action text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_me public.profiles;
  v_sale public.sales;
begin
  v_me := public.require_role('admin', 'cashier');
  if p_action not in ('printed', 'exported_pdf', 'exported_docx') then
    raise exception 'Unknown invoice action.' using errcode = '22023';
  end if;
  select * into v_sale from public.sales where id = p_sale_id;
  if v_sale.id is null or (v_me.role = 'cashier' and v_sale.created_by is distinct from v_me.id) then
    raise exception 'Invoice not found.' using errcode = 'P0002';
  end if;
  perform public.log_activity('invoice_' || p_action, 'sales', v_sale.id::text,
    format('Invoice %s %s', v_sale.invoice_no, replace(p_action, '_', ' ')), null);
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Row level security for two roles
-- ---------------------------------------------------------------------------
drop policy if exists sales_select on public.sales;
drop policy if exists sales_select_admin on public.sales;
drop policy if exists sales_select_own on public.sales;
create policy sales_select_admin on public.sales
  for select to authenticated using (public.has_role('admin'));
create policy sales_select_own on public.sales
  for select to authenticated using (created_by = auth.uid() and public.is_active_user());

drop policy if exists sale_items_select on public.sale_items;
create policy sale_items_select on public.sale_items
  for select to authenticated using (exists (select 1 from public.sales s where s.id = sale_id));

drop policy if exists stock_movements_select on public.stock_movements;
create policy stock_movements_select on public.stock_movements
  for select to authenticated using (public.has_role('admin'));

drop policy if exists suppliers_select on public.suppliers;
create policy suppliers_select on public.suppliers
  for select to authenticated using (public.has_role('admin'));

drop policy if exists activity_logs_select_admin_owner on public.activity_logs;
drop policy if exists activity_logs_select_admin on public.activity_logs;
create policy activity_logs_select_admin on public.activity_logs
  for select to authenticated using (public.has_role('admin'));

-- ---------------------------------------------------------------------------
-- 7. POS product search (database-backed, paged — never loads the whole catalogue)
-- ---------------------------------------------------------------------------
create or replace function public.pos_search_products(
  p_query text default null,
  p_category_id bigint default null,
  p_sort text default 'relevance',
  p_in_stock_only boolean default false,
  p_limit integer default 24,
  p_offset integer default 0)
returns table (
  id bigint, sku text, barcode text, name text, category_id bigint, category_name text, unit text,
  selling_price numeric, current_stock integer, min_stock_level integer, image_url text, total_count bigint)
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
  v_like text;
begin
  if not public.is_active_user() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;
  v_like := '%' || replace(replace(replace(coalesce(v_q, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return query
  select p.id, p.sku, p.barcode, p.name, p.category_id, c.name, p.unit, p.selling_price, p.current_stock,
         p.min_stock_level, p.image_url, count(*) over ()
    from public.products p
    join public.categories c on c.id = p.category_id
   where not p.is_archived
     and (p_category_id is null or p.category_id = p_category_id)
     and (not coalesce(p_in_stock_only, false) or p.current_stock > 0)
     and (v_q is null
          or p.name ilike v_like
          or p.sku ilike v_like
          or lower(p.barcode) = lower(v_q)
          or c.name ilike v_like)
   order by
     case when v_q is not null and (lower(p.sku) = lower(v_q) or lower(p.barcode) = lower(v_q)) then 0
          when v_q is not null and p.name ilike replace(v_like, '%', '') || '%' then 1 else 2 end
       * (case when p_sort = 'relevance' or p_sort is null then 1 else 0 end),
     case when p_sort = 'price_asc' then p.selling_price end asc,
     case when p_sort = 'price_desc' then p.selling_price end desc,
     case when p_sort = 'stock_desc' then p.current_stock end desc,
     case when p_sort = 'newest' then p.id end desc,
     lower(p.name), p.id
   limit least(greatest(coalesce(p_limit, 24), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end
$$;

-- Exact lookup for barcode scanners (scanner types the code and presses Enter).
create or replace function public.pos_lookup_code(p_code text)
returns table (
  id bigint, sku text, barcode text, name text, category_id bigint, category_name text, unit text,
  selling_price numeric, current_stock integer, min_stock_level integer, image_url text, total_count bigint)
language sql stable security invoker set search_path = ''
as $$
  select p.id, p.sku, p.barcode, p.name, p.category_id, c.name, p.unit, p.selling_price, p.current_stock,
         p.min_stock_level, p.image_url, 1::bigint
    from public.products p
    join public.categories c on c.id = p.category_id
   where not p.is_archived
     and public.is_active_user()
     and (lower(p.barcode) = lower(btrim(p_code)) or lower(p.sku) = lower(btrim(p_code)))
   order by (lower(p.barcode) = lower(btrim(p_code))) desc nulls last
   limit 1
$$;

-- ---------------------------------------------------------------------------
-- 8. Sales transaction list (RLS: cashiers automatically see only their own)
-- ---------------------------------------------------------------------------
create or replace function public.list_sales(
  p_from date default null,
  p_to date default null,
  p_search text default null,
  p_cashier_id uuid default null,
  p_payment_method text default null,
  p_status text default null,
  p_sort text default 'newest',
  p_limit integer default 25,
  p_offset integer default 0)
returns table (
  id bigint, reference_no text, invoice_no text, sold_at timestamptz, customer_name text,
  item_count integer, total_quantity integer, subtotal numeric, discount_amount numeric, total_amount numeric,
  payment_method text, payment_reference text, amount_received numeric, change_amount numeric,
  status text, payment_status text, created_by uuid, created_by_name text, voided_at timestamptz,
  voided_by_name text, void_reason text, total_count bigint)
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_tz text := public.store_timezone();
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if not public.is_active_user() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;
  return query
  select s.id, s.reference_no, s.invoice_no, s.sold_at, s.customer_name, s.item_count, s.total_quantity,
         s.subtotal, s.discount_amount, s.total_amount, s.payment_method, s.payment_reference, s.amount_received,
         s.change_amount, s.status, s.payment_status, s.created_by, s.created_by_name, s.voided_at,
         s.voided_by_name, s.void_reason, count(*) over ()
    from public.sales s
   where (p_from is null or s.sold_at >= (p_from::timestamp at time zone v_tz))
     and (p_to is null or s.sold_at < ((p_to + 1)::timestamp at time zone v_tz))
     and (p_cashier_id is null or s.created_by = p_cashier_id)
     and (p_payment_method is null or s.payment_method = p_payment_method)
     and (p_status is null or s.status = p_status)
     and (v_q is null
          or s.reference_no ilike '%' || v_q || '%'
          or s.invoice_no ilike '%' || v_q || '%'
          or s.customer_name ilike '%' || v_q || '%'
          or s.created_by_name ilike '%' || v_q || '%'
          or exists (select 1 from public.sale_items i
                      where i.sale_id = s.id and (i.product_name ilike '%' || v_q || '%' or i.product_sku ilike '%' || v_q || '%')))
   order by
     case when p_sort = 'amount_desc' then s.total_amount end desc,
     case when p_sort = 'amount_asc' then s.total_amount end asc,
     case when p_sort = 'oldest' then s.sold_at end asc,
     s.sold_at desc, s.id desc
   limit least(greatest(coalesce(p_limit, 25), 1), 5000)
  offset greatest(coalesce(p_offset, 0), 0);
end
$$;

-- ---------------------------------------------------------------------------
-- 9. Sales report (daily / weekly / monthly) — completed sales only
-- ---------------------------------------------------------------------------
create or replace function public.sales_report(p_from date, p_to date)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_tz text := public.store_timezone();
  v_start timestamptz;
  v_end timestamptz;
  v_result jsonb;
begin
  if not public.has_role('admin') then
    raise exception 'You do not have permission to view reports.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Invalid reporting period.' using errcode = '22023';
  end if;
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;

  with s as (
    select * from public.sales where sold_at >= v_start and sold_at < v_end
  ), c as (
    select * from s where status = 'completed'
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'timezone', v_tz,
    'totals', (select jsonb_build_object(
                 'transactions', count(*),
                 'items_sold', coalesce(sum(total_quantity), 0),
                 'gross_sales', coalesce(sum(subtotal), 0),
                 'discounts', coalesce(sum(discount_amount), 0),
                 'net_sales', coalesce(sum(total_amount), 0),
                 'average_sale', coalesce(round(avg(total_amount), 2), 0)) from c),
    'voided', (select jsonb_build_object('transactions', count(*), 'amount', coalesce(sum(total_amount), 0)) from s
                where status = 'voided'),
    'by_cashier', (select coalesce(jsonb_agg(x order by x.net_sales desc), '[]'::jsonb) from (
                     select created_by as cashier_id, created_by_name as cashier_name, count(*) as transactions,
                            sum(total_quantity) as items_sold, sum(total_amount) as net_sales
                       from c group by created_by, created_by_name) x),
    'by_payment', (select coalesce(jsonb_agg(x order by x.net_sales desc), '[]'::jsonb) from (
                     select payment_method, count(*) as transactions, sum(total_amount) as net_sales
                       from c group by payment_method) x),
    'best_sellers', (select coalesce(jsonb_agg(x order by x.quantity desc, x.amount desc), '[]'::jsonb) from (
                       select i.product_id, max(i.product_name) as product_name, max(i.product_sku) as product_sku,
                              sum(i.quantity) as quantity, sum(i.line_total) as amount, count(distinct i.sale_id) as transactions
                         from public.sale_items i join c on c.id = i.sale_id
                        group by i.product_id
                        order by sum(i.quantity) desc, sum(i.line_total) desc
                        limit 10) x),
    'by_day', (select coalesce(jsonb_agg(x order by x.day), '[]'::jsonb) from (
                 select d::date as day,
                        count(c.id) as transactions,
                        coalesce(sum(c.total_amount), 0) as net_sales,
                        coalesce(sum(c.total_quantity), 0) as items_sold
                   from generate_series(p_from, p_to, interval '1 day') d
                   left join c on (c.sold_at at time zone v_tz)::date = d::date
                  group by d) x),
    'by_hour', (select coalesce(jsonb_agg(x order by x.hour), '[]'::jsonb) from (
                  select h as hour, count(c.id) as transactions, coalesce(sum(c.total_amount), 0) as net_sales
                    from generate_series(0, 23) h
                    left join c on extract(hour from c.sold_at at time zone v_tz)::int = h
                   group by h) x),
    'monthly_trend', (select coalesce(jsonb_agg(x order by x.month), '[]'::jsonb) from (
                        select m::date as month,
                               (select count(*) from public.sales t
                                 where t.status = 'completed'
                                   and t.sold_at >= (m::timestamp at time zone v_tz)
                                   and t.sold_at < ((m + interval '1 month')::timestamp at time zone v_tz)) as transactions,
                               (select coalesce(sum(t.total_amount), 0) from public.sales t
                                 where t.status = 'completed'
                                   and t.sold_at >= (m::timestamp at time zone v_tz)
                                   and t.sold_at < ((m + interval '1 month')::timestamp at time zone v_tz)) as net_sales
                          from generate_series(date_trunc('month', p_to::timestamp) - interval '11 months',
                                               date_trunc('month', p_to::timestamp), interval '1 month') m) x)
  ) into v_result;
  return v_result;
end
$$;

-- ---------------------------------------------------------------------------
-- 10. Stock management report (daily / weekly / monthly)
-- ---------------------------------------------------------------------------
create or replace function public.stock_report(
  p_from date,
  p_to date,
  p_product_id bigint default null,
  p_types public.movement_type[] default null)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_tz text := public.store_timezone();
  v_start timestamptz;
  v_end timestamptz;
  v_result jsonb;
begin
  if not public.has_role('admin') then
    raise exception 'You do not have permission to view reports.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Invalid reporting period.' using errcode = '22023';
  end if;
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;

  with m as (
    select * from public.stock_movements sm
     where sm.occurred_at >= v_start and sm.occurred_at < v_end
       and (p_product_id is null or sm.product_id = p_product_id)
       and (p_types is null or cardinality(p_types) = 0 or sm.movement_type = any (p_types))
       and sm.movement_type <> 'reclassify'
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'timezone', v_tz,
    'totals', (select jsonb_build_object(
                 'stock_in_qty', coalesce(sum(quantity_change) filter (where movement_type = 'stock_in'), 0),
                 'stock_in_count', count(*) filter (where movement_type = 'stock_in'),
                 'stock_out_qty', coalesce(-sum(quantity_change) filter (where movement_type in ('damaged', 'expired', 'lost', 'internal_use', 'other_out')), 0),
                 'stock_out_count', count(*) filter (where movement_type in ('damaged', 'expired', 'lost', 'internal_use', 'other_out')),
                 'sales_qty', coalesce(-sum(quantity_change) filter (where movement_type = 'sale'), 0),
                 'sales_count', count(*) filter (where movement_type = 'sale'),
                 'returned_qty', coalesce(sum(quantity_change) filter (where movement_type = 'sale_void'), 0),
                 'returned_count', count(*) filter (where movement_type = 'sale_void'),
                 'adjustment_net', coalesce(sum(quantity_change) filter (where movement_type = 'adjustment'), 0),
                 'adjustment_count', count(*) filter (where movement_type = 'adjustment'),
                 'movements', count(*)) from m),
    'products_received', (select coalesce(jsonb_agg(x order by x.quantity desc), '[]'::jsonb) from (
                            select product_id, max(product_name) as product_name, max(product_sku) as product_sku,
                                   sum(quantity_change) as quantity, count(*) as entries,
                                   coalesce(sum(quantity_change * coalesce(unit_cost, 0)), 0) as cost
                              from m where movement_type = 'stock_in' group by product_id) x),
    'products_released', (select coalesce(jsonb_agg(x order by x.quantity desc), '[]'::jsonb) from (
                            select product_id, max(product_name) as product_name, max(product_sku) as product_sku,
                                   movement_type::text as reason, -sum(quantity_change) as quantity, count(*) as entries
                              from m where movement_type in ('damaged', 'expired', 'lost', 'internal_use', 'other_out')
                             group by product_id, movement_type) x),
    'by_day', (select coalesce(jsonb_agg(x order by x.day), '[]'::jsonb) from (
                 select d::date as day,
                        coalesce(sum(m.quantity_change) filter (where m.movement_type = 'stock_in'), 0) as stock_in,
                        coalesce(-sum(m.quantity_change) filter (where m.movement_type in ('damaged', 'expired', 'lost', 'internal_use', 'other_out')), 0) as stock_out,
                        coalesce(-sum(m.quantity_change) filter (where m.movement_type = 'sale'), 0) as sold,
                        coalesce(sum(m.quantity_change) filter (where m.movement_type = 'sale_void'), 0) as returned,
                        coalesce(sum(m.quantity_change) filter (where m.movement_type = 'adjustment'), 0) as adjustments,
                        count(m.id) as movements
                   from generate_series(p_from, p_to, interval '1 day') d
                   left join m on (m.occurred_at at time zone v_tz)::date = d::date
                  group by d) x),
    'by_user', (select coalesce(jsonb_agg(x order by x.movements desc), '[]'::jsonb) from (
                  select created_by_name as user_name, count(*) as movements,
                         coalesce(sum(quantity_change) filter (where movement_type = 'stock_in'), 0) as stock_in,
                         coalesce(-sum(quantity_change) filter (where movement_type in ('damaged', 'expired', 'lost', 'internal_use', 'other_out')), 0) as stock_out,
                         coalesce(-sum(quantity_change) filter (where movement_type = 'sale'), 0) as sold
                    from m group by created_by_name) x),
    'monthly_trend', (select coalesce(jsonb_agg(x order by x.month), '[]'::jsonb) from (
                        select mo::date as month,
                               coalesce(sum(sm.quantity_change) filter (where sm.movement_type = 'stock_in'), 0) as stock_in,
                               coalesce(-sum(sm.quantity_change) filter (where sm.movement_type in ('damaged', 'expired', 'lost', 'internal_use', 'other_out')), 0) as stock_out,
                               coalesce(-sum(sm.quantity_change) filter (where sm.movement_type = 'sale'), 0) as sold
                          from generate_series(date_trunc('month', p_to::timestamp) - interval '11 months',
                                               date_trunc('month', p_to::timestamp), interval '1 month') mo
                          left join public.stock_movements sm
                            on sm.occurred_at >= (mo::timestamp at time zone v_tz)
                           and sm.occurred_at < ((mo + interval '1 month')::timestamp at time zone v_tz)
                           and (p_product_id is null or sm.product_id = p_product_id)
                         group by mo) x)
  ) into v_result;
  return v_result;
end
$$;

-- Movement history with movement numbers and sorting.
drop function if exists public.list_movements(date, date, bigint, bigint, public.movement_type[], text, integer, integer);
create or replace function public.list_movements(
  p_from date,
  p_to date,
  p_category_id bigint default null,
  p_product_id bigint default null,
  p_types public.movement_type[] default null,
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0,
  p_sort text default 'newest')
returns table (
  id bigint,
  movement_no text,
  movement_type public.movement_type,
  product_id bigint,
  product_name text,
  product_sku text,
  category_id bigint,
  category_name text,
  quantity_change integer,
  quantity_before integer,
  quantity_after integer,
  unit_cost numeric,
  unit_price numeric,
  supplier_id bigint,
  supplier_name text,
  customer_id bigint,
  customer_name text,
  sale_id bigint,
  reverses_movement_id bigint,
  reversed_by_id bigint,
  reference_no text,
  reason text,
  occurred_at timestamptz,
  created_by_name text,
  total_count bigint)
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_tz text := public.store_timezone();
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if not public.is_active_user() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Invalid reporting period.' using errcode = '22023';
  end if;

  return query
  select m.id, m.movement_no, m.movement_type, m.product_id, m.product_name, m.product_sku, m.category_id,
         m.category_name, m.quantity_change, m.quantity_before, m.quantity_after, m.unit_cost, m.unit_price,
         m.supplier_id, s.name, m.customer_id, c.full_name, m.sale_id, m.reverses_movement_id,
         r.id, m.reference_no, m.reason, m.occurred_at, m.created_by_name,
         count(*) over ()
    from public.stock_movements m
    left join public.suppliers s on s.id = m.supplier_id
    left join public.customers c on c.id = m.customer_id
    left join public.stock_movements r on r.reverses_movement_id = m.id
   where m.occurred_at >= (p_from::timestamp at time zone v_tz)
     and m.occurred_at <  ((p_to + 1)::timestamp at time zone v_tz)
     and (p_category_id is null or m.category_id = p_category_id)
     and (p_product_id is null or m.product_id = p_product_id)
     and (p_types is null or cardinality(p_types) = 0 or m.movement_type = any (p_types))
     and (v_search is null
          or m.product_name ilike '%' || v_search || '%'
          or m.product_sku ilike '%' || v_search || '%'
          or m.movement_no ilike '%' || v_search || '%'
          or m.reference_no ilike '%' || v_search || '%'
          or m.reason ilike '%' || v_search || '%'
          or m.created_by_name ilike '%' || v_search || '%')
   order by
     case when p_sort = 'oldest' then m.occurred_at end asc,
     case when p_sort = 'oldest' then m.id end asc,
     case when p_sort = 'quantity' then abs(m.quantity_change) end desc,
     m.occurred_at desc, m.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 5000)
  offset greatest(coalesce(p_offset, 0), 0);
end
$$;

-- ---------------------------------------------------------------------------
-- 11. Dashboards
-- ---------------------------------------------------------------------------
create or replace function public.admin_dashboard()
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_tz text := public.store_timezone();
  v_today date := (now() at time zone public.store_timezone())::date;
  v_week_start date := date_trunc('week', (now() at time zone public.store_timezone()))::date;
  v_month_start date := date_trunc('month', (now() at time zone public.store_timezone()))::date;
  v_result jsonb;
begin
  if not public.has_role('admin') then
    raise exception 'You do not have permission to view the administrator dashboard.' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'today', v_today, 'timezone', v_tz,
    'sales_today', (select jsonb_build_object('amount', coalesce(sum(total_amount), 0), 'transactions', count(*))
                      from public.sales where status = 'completed' and sold_at >= (v_today::timestamp at time zone v_tz)),
    'sales_week', (select jsonb_build_object('amount', coalesce(sum(total_amount), 0), 'transactions', count(*))
                     from public.sales where status = 'completed' and sold_at >= (v_week_start::timestamp at time zone v_tz)),
    'sales_month', (select jsonb_build_object('amount', coalesce(sum(total_amount), 0), 'transactions', count(*))
                      from public.sales where status = 'completed' and sold_at >= (v_month_start::timestamp at time zone v_tz)),
    'total_transactions', (select count(*) from public.sales where status = 'completed'),
    'total_products', (select count(*) from public.products where not is_archived),
    'total_quantity', (select coalesce(sum(current_stock), 0) from public.products where not is_archived),
    'low_stock', (select count(*) from public.products
                   where not is_archived and current_stock > 0 and current_stock <= min_stock_level),
    'out_of_stock', (select count(*) from public.products where not is_archived and current_stock = 0),
    'stock_in_today', (select jsonb_build_object('quantity', coalesce(sum(quantity_change), 0), 'entries', count(*))
                         from public.stock_movements where movement_type = 'stock_in'
                          and occurred_at >= (v_today::timestamp at time zone v_tz)),
    'stock_out_today', (select jsonb_build_object('quantity', coalesce(-sum(quantity_change), 0), 'entries', count(*))
                          from public.stock_movements
                         where movement_type in ('damaged', 'expired', 'lost', 'internal_use', 'other_out')
                           and occurred_at >= (v_today::timestamp at time zone v_tz)),
    'daily_sales', (select coalesce(jsonb_agg(x order by x.day), '[]'::jsonb) from (
                      select d::date as day, coalesce(sum(s.total_amount), 0) as amount, count(s.id) as transactions
                        from generate_series(v_today - 13, v_today, interval '1 day') d
                        left join public.sales s on s.status = 'completed'
                         and (s.sold_at at time zone v_tz)::date = d::date
                       group by d) x),
    'weekly_sales', (select coalesce(jsonb_agg(x order by x.week), '[]'::jsonb) from (
                       select w::date as week, coalesce(sum(s.total_amount), 0) as amount, count(s.id) as transactions
                         from generate_series(v_week_start - 49, v_week_start, interval '7 days') w
                         left join public.sales s on s.status = 'completed'
                          and s.sold_at >= (w::timestamp at time zone v_tz)
                          and s.sold_at < ((w + interval '7 days')::timestamp at time zone v_tz)
                        group by w) x),
    'monthly_sales', (select coalesce(jsonb_agg(x order by x.month), '[]'::jsonb) from (
                        select mo::date as month, coalesce(sum(s.total_amount), 0) as amount, count(s.id) as transactions
                          from generate_series(v_month_start - interval '11 months', v_month_start, interval '1 month') mo
                          left join public.sales s on s.status = 'completed'
                           and s.sold_at >= (mo::timestamp at time zone v_tz)
                           and s.sold_at < ((mo + interval '1 month')::timestamp at time zone v_tz)
                         group by mo) x),
    'best_sellers', (select coalesce(jsonb_agg(x order by x.quantity desc), '[]'::jsonb) from (
                       select i.product_id, max(i.product_name) as product_name, sum(i.quantity) as quantity,
                              sum(i.line_total) as amount
                         from public.sale_items i join public.sales s on s.id = i.sale_id
                        where s.status = 'completed' and s.sold_at >= (v_month_start::timestamp at time zone v_tz)
                        group by i.product_id order by sum(i.quantity) desc limit 5) x),
    'recent_sales', (select coalesce(jsonb_agg(x order by x.sold_at desc), '[]'::jsonb) from (
                       select id, reference_no, invoice_no, sold_at, total_amount, payment_method, status, created_by_name
                         from public.sales order by sold_at desc, id desc limit 8) x),
    'recent_movements', (select coalesce(jsonb_agg(x order by x.occurred_at desc), '[]'::jsonb) from (
                           select id, movement_no, movement_type, product_name, quantity_change, quantity_after,
                                  occurred_at, created_by_name
                             from public.stock_movements where movement_type <> 'reclassify'
                            order by occurred_at desc, id desc limit 8) x),
    'cashier_activity', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
                           select l.id, l.user_name, l.action, l.summary, l.created_at
                             from public.activity_logs l
                             join public.profiles p on p.id = l.user_id and p.role = 'cashier'
                            order by l.created_at desc, l.id desc limit 8) x),
    'stock_alerts', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
                       select p.id, p.name, p.sku, p.current_stock, p.min_stock_level, p.unit,
                              case when p.current_stock = 0 then 'out' else 'low' end as status
                         from public.products p
                        where not p.is_archived and p.current_stock <= p.min_stock_level
                        order by p.current_stock, p.name limit 8) x)
  ) into v_result;
  return v_result;
end
$$;

-- Cashier: only their own figures (any signed-in user can call it for themselves).
create or replace function public.my_dashboard()
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_tz text := public.store_timezone();
  v_today date := (now() at time zone public.store_timezone())::date;
  v_me uuid := auth.uid();
  v_result jsonb;
begin
  if not public.is_active_user() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'today', v_today,
    'sales_today', (select jsonb_build_object('amount', coalesce(sum(total_amount), 0), 'transactions', count(*),
                                              'items_sold', coalesce(sum(total_quantity), 0))
                      from public.sales where created_by = v_me and status = 'completed'
                       and sold_at >= (v_today::timestamp at time zone v_tz)),
    'voided_today', (select count(*) from public.sales where created_by = v_me and status = 'voided'
                      and sold_at >= (v_today::timestamp at time zone v_tz)),
    'by_payment', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
                     select payment_method, count(*) as transactions, sum(total_amount) as amount
                       from public.sales where created_by = v_me and status = 'completed'
                        and sold_at >= (v_today::timestamp at time zone v_tz)
                      group by payment_method) x),
    'available_products', (select count(*) from public.products where not is_archived and current_stock > 0),
    'low_stock', (select count(*) from public.products
                   where not is_archived and current_stock > 0 and current_stock <= min_stock_level),
    'out_of_stock', (select count(*) from public.products where not is_archived and current_stock = 0),
    'recent_sales', (select coalesce(jsonb_agg(x order by x.sold_at desc), '[]'::jsonb) from (
                       select id, reference_no, invoice_no, sold_at, total_amount, payment_method, status
                         from public.sales where created_by = v_me
                        order by sold_at desc, id desc limit 8) x)
  ) into v_result;
  return v_result;
end
$$;

-- Ledger summaries: expired / internal-use count as other stock-out; voided sales
-- return stock as an adjustment line, so Ending = Beginning + In - Sold - Other +/- Adj still holds.
create or replace function public.stock_movement_summary(
  p_from date,
  p_to date,
  p_bucket text default 'day',
  p_category_id bigint default null,
  p_product_id bigint default null)
returns table (
  period_start date,
  period_end date,
  beginning_stock bigint,
  stock_in bigint,
  stock_sold bigint,
  other_out bigint,
  adjustments bigint,
  ending_stock bigint,
  movement_count bigint)
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_tz text := public.store_timezone();
  v_opening bigint;
begin
  if not public.is_active_user() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;
  if p_bucket not in ('day', 'month') then
    raise exception 'Bucket must be "day" or "month".' using errcode = '22023';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Invalid reporting period.' using errcode = '22023';
  end if;
  if p_to - p_from > 3700 then
    raise exception 'Reporting period is too long (maximum 10 years).' using errcode = '22023';
  end if;

  select coalesce(sum(m.quantity_change), 0) into v_opening
    from public.stock_movements m
   where m.occurred_at < (p_from::timestamp at time zone v_tz)
     and (p_category_id is null or m.category_id = p_category_id)
     and (p_product_id is null or m.product_id = p_product_id);

  return query
  with buckets as (
    select greatest(g::date, p_from) as b_start,
           least((g + ('1 ' || p_bucket)::interval)::date - 1, p_to) as b_end
      from generate_series(date_trunc(p_bucket, p_from::timestamp), p_to::timestamp,
                           ('1 ' || p_bucket)::interval) g
  ),
  agg as (
    select b.b_start, b.b_end,
           coalesce(sum(m.quantity_change) filter (where m.movement_type = 'stock_in'), 0)::bigint as s_in,
           coalesce(-sum(m.quantity_change) filter (where m.movement_type = 'sale'), 0)::bigint as s_sold,
           coalesce(-sum(m.quantity_change) filter (where m.movement_type in ('damaged', 'expired', 'lost', 'internal_use', 'other_out')), 0)::bigint as s_other,
           coalesce(sum(m.quantity_change) filter (where m.movement_type in ('adjustment', 'reclassify', 'sale_void')), 0)::bigint as s_adj,
           coalesce(sum(m.quantity_change), 0)::bigint as s_net,
           count(m.id)::bigint as s_count
      from buckets b
      left join public.stock_movements m
        on m.occurred_at >= (b.b_start::timestamp at time zone v_tz)
       and m.occurred_at <  ((b.b_end + 1)::timestamp at time zone v_tz)
       and (p_category_id is null or m.category_id = p_category_id)
       and (p_product_id is null or m.product_id = p_product_id)
     group by b.b_start, b.b_end
  )
  select a.b_start, a.b_end,
         (v_opening + coalesce(sum(a.s_net) over w_prev, 0))::bigint,
         a.s_in, a.s_sold, a.s_other, a.s_adj,
         (v_opening + sum(a.s_net) over w_incl)::bigint,
         a.s_count
    from agg a
  window w_prev as (order by a.b_start rows between unbounded preceding and 1 preceding),
         w_incl as (order by a.b_start rows between unbounded preceding and current row)
   order by a.b_start;
end
$$;

create or replace function public.stock_movement_breakdown(
  p_from date,
  p_to date,
  p_group text default 'product',
  p_category_id bigint default null,
  p_product_id bigint default null)
returns table (
  group_id bigint,
  group_name text,
  sku text,
  category_name text,
  unit text,
  beginning_stock bigint,
  stock_in bigint,
  stock_sold bigint,
  other_out bigint,
  adjustments bigint,
  ending_stock bigint,
  movement_count bigint)
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_tz text := public.store_timezone();
  v_start timestamptz := p_from::timestamp at time zone public.store_timezone();
  v_end timestamptz := (p_to + 1)::timestamp at time zone public.store_timezone();
begin
  if not public.is_active_user() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;
  if p_group not in ('product', 'category') then
    raise exception 'Group must be "product" or "category".' using errcode = '22023';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Invalid reporting period.' using errcode = '22023';
  end if;

  return query
  with m as (
    select case when p_group = 'product' then sm.product_id else sm.category_id end as gid,
           sm.movement_type, sm.quantity_change, sm.occurred_at
      from public.stock_movements sm
     where sm.occurred_at < v_end
       and (p_category_id is null or sm.category_id = p_category_id)
       and (p_product_id is null or sm.product_id = p_product_id)
  ),
  agg as (
    select m.gid,
           coalesce(sum(m.quantity_change) filter (where m.occurred_at < v_start), 0)::bigint as s_begin,
           coalesce(sum(m.quantity_change) filter (where m.occurred_at >= v_start and m.movement_type = 'stock_in'), 0)::bigint as s_in,
           coalesce(-sum(m.quantity_change) filter (where m.occurred_at >= v_start and m.movement_type = 'sale'), 0)::bigint as s_sold,
           coalesce(-sum(m.quantity_change) filter (where m.occurred_at >= v_start and m.movement_type in ('damaged', 'expired', 'lost', 'internal_use', 'other_out')), 0)::bigint as s_other,
           coalesce(sum(m.quantity_change) filter (where m.occurred_at >= v_start and m.movement_type in ('adjustment', 'reclassify', 'sale_void')), 0)::bigint as s_adj,
           coalesce(sum(m.quantity_change), 0)::bigint as s_end,
           count(*) filter (where m.occurred_at >= v_start)::bigint as s_count
      from m group by m.gid
  ),
  groups as (
    select p.id as gid, p.name::text as gname, p.sku::text as gsku, c.name::text as gcat, p.unit::text as gunit
      from public.products p join public.categories c on c.id = p.category_id
     where p_group = 'product'
       and (p_product_id is null or p.id = p_product_id)
       and (p_category_id is null or p.category_id = p_category_id
            or exists (select 1 from agg where agg.gid = p.id))
       and p.created_at < v_end
    union all
    select c.id, c.name::text, null::text, c.name::text, null::text
      from public.categories c
     where p_group = 'category'
       and (p_category_id is null or c.id = p_category_id)
       and (c.created_at < v_end or exists (select 1 from agg where agg.gid = c.id))
  )
  select g.gid, g.gname, g.gsku, g.gcat, g.gunit,
         coalesce(a.s_begin, 0), coalesce(a.s_in, 0), coalesce(a.s_sold, 0), coalesce(a.s_other, 0),
         coalesce(a.s_adj, 0), coalesce(a.s_end, 0), coalesce(a.s_count, 0)
    from groups g
    left join agg a on a.gid = g.gid
   order by g.gname;
end
$$;

-- ---------------------------------------------------------------------------
-- 12. Function privileges
-- ---------------------------------------------------------------------------
revoke execute on function public.log_logout() from public, anon;
revoke execute on function public.void_sale(bigint, text) from public, anon;
revoke execute on function public.log_invoice_action(bigint, text) from public, anon;
revoke execute on function public.pos_search_products(text, bigint, text, boolean, integer, integer) from public, anon;
revoke execute on function public.pos_lookup_code(text) from public, anon;
revoke execute on function public.list_sales(date, date, text, uuid, text, text, text, integer, integer) from public, anon;
revoke execute on function public.sales_report(date, date) from public, anon;
revoke execute on function public.stock_report(date, date, bigint, public.movement_type[]) from public, anon;
revoke execute on function public.list_movements(date, date, bigint, bigint, public.movement_type[], text, integer, integer, text) from public, anon;
revoke execute on function public.admin_dashboard() from public, anon;
revoke execute on function public.my_dashboard() from public, anon;
revoke execute on function public.record_sale(jsonb, text, numeric, numeric, bigint, text, text, text, uuid) from public, anon;
revoke execute on function public.create_product(text, text, bigint, text, numeric, numeric, integer, text, integer, bigint, text, text) from public, anon;
revoke execute on function public.update_product(bigint, text, text, bigint, text, numeric, numeric, integer, text, text, bigint, text, boolean) from public, anon;
revoke execute on function public.normalize_barcode(text) from public, anon;

grant execute on function public.log_logout() to authenticated;
grant execute on function public.void_sale(bigint, text) to authenticated;
grant execute on function public.log_invoice_action(bigint, text) to authenticated;
grant execute on function public.pos_search_products(text, bigint, text, boolean, integer, integer) to authenticated;
grant execute on function public.pos_lookup_code(text) to authenticated;
grant execute on function public.list_sales(date, date, text, uuid, text, text, text, integer, integer) to authenticated;
grant execute on function public.sales_report(date, date) to authenticated;
grant execute on function public.stock_report(date, date, bigint, public.movement_type[]) to authenticated;
grant execute on function public.list_movements(date, date, bigint, bigint, public.movement_type[], text, integer, integer, text) to authenticated;
grant execute on function public.admin_dashboard() to authenticated;
grant execute on function public.my_dashboard() to authenticated;
grant execute on function public.record_sale(jsonb, text, numeric, numeric, bigint, text, text, text, uuid) to authenticated;
grant execute on function public.create_product(text, text, bigint, text, numeric, numeric, integer, text, integer, bigint, text, text) to authenticated;
grant execute on function public.update_product(bigint, text, text, bigint, text, numeric, numeric, integer, text, text, bigint, text, boolean) to authenticated;
grant execute on function public.normalize_barcode(text) to authenticated;
grant execute on all functions in schema public to service_role;
grant usage, select on sequence public.sale_txn_seq to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'sales') then
    alter publication supabase_realtime add table public.sales;
  end if;
end $$;

notify pgrst, 'reload schema';
