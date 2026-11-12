-- ============================================================================
-- INVPORTIQ database test suite.
-- Runs the real migrations' functions as the `anon` / `authenticated` /
-- `service_role` API roles with JWT claims — exactly how PostgREST calls them.
-- Run with: npm run test:db
-- ============================================================================
\set ON_ERROR_STOP 1
\set QUIET 1
set client_min_messages = notice;
\o /dev/null

create schema tests;
grant usage on schema tests to anon, authenticated, service_role;

create table tests.results (n serial, ok boolean, msg text);
grant all on tests.results to anon, authenticated, service_role;
grant all on sequence tests.results_n_seq to anon, authenticated, service_role;

create function tests.ok(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  insert into tests.results (ok, msg) values (coalesce(p_cond, false), p_msg);
  if coalesce(p_cond, false) then raise notice 'ok - %', p_msg;
  else raise warning 'NOT OK - %', p_msg; end if;
end $$;

create function tests.eq(p_got anyelement, p_want anyelement, p_msg text) returns void language plpgsql as $$
begin
  perform tests.ok(p_got is not distinct from p_want, p_msg || format(' (got %s, want %s)', p_got, p_want));
end $$;

-- Executes SQL and asserts it fails with a message containing p_fragment.
create function tests.throws(p_sql text, p_fragment text, p_msg text) returns void language plpgsql as $$
declare v_err text;
begin
  begin
    execute p_sql;
  exception when others then
    v_err := sqlerrm;
  end;
  perform tests.ok(v_err is not null and v_err ilike '%' || p_fragment || '%',
                   p_msg || coalesce(' [error: ' || v_err || ']', ' [no error raised]'));
end $$;

create function tests.as_user(p_uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, false);
$$;
grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Test fixture: rewrite timestamps of already-recorded movements (bypasses the
-- immutability trigger ONLY inside this test) so multi-day reports can be checked.
create function tests.set_time(p_ids bigint[], p_ts timestamptz) returns void language plpgsql security definer as $$
begin
  perform set_config('session_replication_role', 'replica', true);
  update public.stock_movements set occurred_at = p_ts where id = any (p_ids);
  -- keep fixtures realistic: a product always exists before its movements
  update public.products p set created_at = p_ts
   where p.created_at > p_ts and p.id in (select product_id from public.stock_movements where id = any (p_ids));
  perform set_config('session_replication_role', 'origin', true);
end $$;

-- ---------------------------------------------------------------------------
-- Fixture users
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@billstore.test'),
  ('00000000-0000-0000-0000-00000000000b', 'owner@billstore.test'),
  ('00000000-0000-0000-0000-00000000000c', 'staff@billstore.test'),
  ('00000000-0000-0000-0000-00000000000d', 'intruder@billstore.test');

-- ===========================================================================
-- 1. Anonymous access & one-time initial setup
-- ===========================================================================
set role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', false);
select tests.eq((public.setup_status() ->> 'setup_required')::boolean, true, 'setup required on a fresh database');
select tests.throws('select * from public.products', 'permission denied', 'anon cannot read products');
select tests.throws('select * from public.profiles', 'permission denied', 'anon cannot read profiles');
select tests.throws($$select public.record_stock_in(1, 5)$$, 'permission denied', 'anon cannot call stock RPCs');
select tests.throws($$select public.complete_initial_setup('00000000-0000-0000-0000-00000000000d', 'x@y.z', 'Intruder')$$,
  'permission denied', 'anon cannot complete initial setup directly');
reset role;

set role authenticated;
select tests.as_user('00000000-0000-0000-0000-00000000000d');
select tests.throws($$select public.complete_initial_setup('00000000-0000-0000-0000-00000000000d', 'x@y.z', 'Intruder')$$,
  'permission denied', 'authenticated users cannot complete initial setup directly');
reset role;

set role service_role;
select public.complete_initial_setup('00000000-0000-0000-0000-00000000000a', 'Admin@BillStore.test', 'Bill Admin');
select tests.throws($$select public.complete_initial_setup('00000000-0000-0000-0000-00000000000d', 'i@x.io', 'Intruder')$$,
  'already been completed', 'initial setup cannot run twice');
reset role;
select tests.eq((public.setup_status() ->> 'setup_required')::boolean, false, 'setup closed after first admin');
select tests.eq((select role::text from public.profiles where id = '00000000-0000-0000-0000-00000000000a'), 'admin', 'first account is admin');
select tests.eq((select email from public.profiles where id = '00000000-0000-0000-0000-00000000000a'), 'admin@billstore.test', 'email normalised');
select tests.eq((select count(*)::int from public.profiles where id = '00000000-0000-0000-0000-00000000000d'), 0, 'intruder got no profile');

-- Accounts created by the admin edge function (service role)
set role service_role;
insert into public.profiles (id, email, full_name, role, created_by) values
  ('00000000-0000-0000-0000-00000000000b', 'owner@billstore.test', 'Bill Owner', 'owner', '00000000-0000-0000-0000-00000000000a'),
  ('00000000-0000-0000-0000-00000000000c', 'staff@billstore.test', 'Sam Staff', 'staff', '00000000-0000-0000-0000-00000000000a');
reset role;

-- ===========================================================================
-- 2. Master data & RBAC
-- ===========================================================================
set role authenticated;
select tests.as_user('00000000-0000-0000-0000-00000000000a');
insert into public.categories (name) values ('Beverages'), ('Food Products'), ('Household Products'), ('Personal Care');
select tests.throws($$insert into public.categories (name) values ('beverages ')$$, 'duplicate', 'category names are unique (case/space-insensitive)');
insert into public.suppliers (name, contact_person, email) values ('Metro Distributors', 'Ana Cruz', 'ana@metro.test');
insert into public.suppliers (name) values ('Fresh Farms Supply');
insert into public.customers (full_name, contact_number) values ('Juan Dela Cruz', '09171234567');
insert into public.customers (full_name) values ('Maria Santos');
select tests.eq((select created_by from public.customers where full_name = 'Maria Santos'),
  '00000000-0000-0000-0000-00000000000a'::uuid, 'created_by stamped from JWT');
select tests.eq((select full_name from public.customers order by created_at desc, id desc limit 1), 'Maria Santos',
  'newest customer sorts first');

-- staff and owner cannot write master data
select tests.as_user('00000000-0000-0000-0000-00000000000c');
select tests.throws($$insert into public.customers (full_name) values ('Staff Made')$$, 'row-level security', 'staff cannot add customers');
select tests.throws($$insert into public.categories (name) values ('Snacks')$$, 'row-level security', 'staff cannot add categories');
select tests.as_user('00000000-0000-0000-0000-00000000000b');
select tests.throws($$insert into public.suppliers (name) values ('Owner Co')$$, 'row-level security', 'owner cannot add suppliers');
update public.customers set full_name = 'Hacked' where full_name = 'Juan Dela Cruz';
select tests.eq((select count(*)::int from public.customers where full_name = 'Hacked'), 0, 'owner update silently affects 0 rows');
select tests.throws($$delete from public.customers$$, 'permission denied', 'owner cannot delete customers');
select tests.eq((select count(*)::int from public.profiles), 1, 'owner sees only own profile');
select tests.as_user('00000000-0000-0000-0000-00000000000a');
select tests.eq((select count(*)::int from public.profiles), 3, 'admin sees all profiles');
select tests.throws($$update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-00000000000c'$$,
  'permission denied', 'profiles cannot be modified directly (role escalation blocked)');
select tests.as_user('00000000-0000-0000-0000-00000000000c');
select tests.throws($$update public.profiles set role = 'admin' where id = auth.uid()$$, 'permission denied', 'staff cannot self-promote');
select (public.update_my_profile('Samuel Staff', '0917')).full_name;
select tests.eq((select full_name from public.profiles where id = auth.uid()), 'Samuel Staff', 'staff can update own name');

-- ===========================================================================
-- 3. Products
-- ===========================================================================
select tests.as_user('00000000-0000-0000-0000-00000000000a');
select public.create_product('BEV-001', 'Cola 1L', (select id from public.categories where name = 'Beverages'),
  'bottle', 40, 55, 20, null, 300);
select public.create_product('BEV-002', 'Orange Juice', (select id from public.categories where name = 'Beverages'),
  'pack', 25, 35, 10, null, 150);
select public.create_product('FOOD-001', 'Rice 5kg', (select id from public.categories where name = 'Food Products'),
  'sack', 220, 260, 10, null, 50, (select id from public.suppliers where name = 'Metro Distributors'));
select tests.eq((select current_stock from public.products where sku = 'BEV-001'), 300, 'opening stock recorded via ledger');
select tests.eq((select count(*)::int from public.stock_movements where reason = 'Opening stock'), 3, 'one opening movement per product');
select tests.eq((select name from public.products order by created_at desc, id desc limit 1), 'Rice 5kg', 'newest product sorts first');
select tests.throws($$select public.create_product('bev-001 ', 'Dup', 1)$$, 'already exists', 'SKU unique (case-insensitive)');
select tests.throws($$select public.create_product('NEG', 'Neg', 1, 'pc', 0, 0, 0, null, -1)$$, 'cannot be negative', 'negative opening stock rejected');

-- staff product permission flag
select tests.as_user('00000000-0000-0000-0000-00000000000c');
select tests.throws($$select public.create_product('X-1', 'X', 1)$$, 'not authorised to add products', 'staff without flag cannot add products');
reset role;
update public.profiles set can_add_products = true where id = '00000000-0000-0000-0000-00000000000c';
set role authenticated;
select tests.as_user('00000000-0000-0000-0000-00000000000c');
select public.create_product('HH-001', 'Dish Soap', (select id from public.categories where name = 'Household Products'), 'bottle', 30, 45, 5);
select tests.eq((select current_stock from public.products where sku = 'HH-001'), 0, 'authorised staff added product (zero stock)');
select tests.throws($$select public.update_product(1, 'BEV-001', 'Renamed', 1, 'pc', 1, 1, 1)$$, 'permission', 'staff cannot edit products');
select tests.as_user('00000000-0000-0000-0000-00000000000b');
select tests.throws($$select public.create_product('O-1', 'Owner', 1)$$, 'permission', 'owner cannot add products');

-- direct stock tampering is impossible
select tests.as_user('00000000-0000-0000-0000-00000000000a');
select tests.throws($$update public.products set current_stock = 9999 where sku = 'BEV-001'$$, 'permission denied', 'API roles cannot update products directly');
reset role;
select tests.throws($$update public.products set current_stock = 9999 where sku = 'BEV-001'$$, 'only change through recorded stock movements',
  'even the database owner cannot bypass the ledger');
select tests.throws($$insert into public.products (sku, name, category_id, current_stock) values ('Z', 'Z', 1, 10)$$, 'start with zero stock',
  'products cannot be created with stock outside the ledger');
set role authenticated;
select tests.as_user('00000000-0000-0000-0000-00000000000a');
select tests.throws($$insert into public.stock_movements (movement_type, product_id, product_name, product_sku, category_id, category_name, quantity_change, quantity_before, quantity_after, created_by_name) values ('stock_in', 1, '', '', 1, '', 5, 0, 0, '')$$,
  'permission denied', 'API roles cannot insert ledger rows directly');

-- ===========================================================================
-- 4. Stock operations (Nov 1 2026 scenario from the specification)
-- Beginning 500 | In +150 | Sold -35 | Other -5 | Adj +5 | Ending 615
-- ===========================================================================
select tests.set_time((select array_agg(id) from public.stock_movements), '2026-10-31 09:00 Asia/Manila');

select public.record_stock_in((select id from public.products where sku = 'BEV-001'), 100,
  (select id from public.suppliers where name = 'Metro Distributors'), 'DR-1001', 'Weekly delivery', 40);
select tests.as_user('00000000-0000-0000-0000-00000000000c');   -- staff may receive stock
select public.record_stock_in((select id from public.products where sku = 'FOOD-001'), 50, null, 'DR-1002', null);
select tests.throws($$select public.record_stock_in(1, 0)$$, 'greater than zero', 'zero quantity rejected');
select tests.as_user('00000000-0000-0000-0000-00000000000b');
select tests.throws($$select public.record_stock_in(1, 5)$$, 'permission', 'owner cannot record stock in');

-- sale: two products, duplicate line for BEV-001 merged (12 + 8 = 20)
select tests.as_user('00000000-0000-0000-0000-00000000000c');
select (public.record_sale(
  jsonb_build_array(
    jsonb_build_object('product_id', (select id from public.products where sku = 'BEV-001'), 'quantity', 12),
    jsonb_build_object('product_id', (select id from public.products where sku = 'BEV-002'), 'quantity', 15),
    jsonb_build_object('product_id', (select id from public.products where sku = 'BEV-001'), 'quantity', 8)),
  (select id from public.customers where full_name = 'Juan Dela Cruz'), 'OR-0001', null,
  '11111111-1111-1111-1111-111111111111')).id;
select tests.eq((select total_quantity from public.sales where reference_no = 'OR-0001'), 35, 'sale totals 35 units');
select tests.eq((select total_amount from public.sales where reference_no = 'OR-0001'), 20 * 55 + 15 * 35.00, 'sale amount uses server prices');
select tests.eq((select count(*)::int from public.stock_movements where sale_id = (select id from public.sales where reference_no = 'OR-0001')),
  2, 'exactly one ledger entry per sold product');
-- idempotent retry (network retry / double click) does not sell twice
select public.record_sale(jsonb_build_array(jsonb_build_object('product_id', 1, 'quantity', 12)),
  null, 'OR-0001-RETRY', null, '11111111-1111-1111-1111-111111111111');
select tests.eq((select count(*)::int from public.sales), 1, 'retried sale with same request id is not recorded twice');
select tests.throws($$select public.record_sale('[{"product_id":1,"quantity":1}]', null, 'or-0001')$$, 'already been recorded',
  'duplicate sale reference rejected');
-- atomicity: one line short of stock => whole sale rejected, nothing written
select tests.throws($$select public.record_sale(jsonb_build_array(
    jsonb_build_object('product_id', (select id from public.products where sku = 'BEV-001'), 'quantity', 1),
    jsonb_build_object('product_id', (select id from public.products where sku = 'FOOD-001'), 'quantity', 100000)), null, 'OR-FAIL')$$,
  'Insufficient stock', 'oversell rejected');
select tests.eq((select count(*)::int from public.sales where reference_no = 'OR-FAIL'), 0, 'failed sale left no sale row');
select tests.eq((select current_stock from public.products where sku = 'BEV-001'), 380, 'failed sale left stock untouched (300+100-20)');
select tests.throws($$select public.record_sale('[]')$$, 'at least one item', 'empty sale rejected');
select tests.throws($$select public.record_sale('[{"product_id":999999,"quantity":1}]')$$, 'does not exist', 'unknown product rejected');

-- other stock out
select tests.throws($$select public.record_stock_out(3, 5, 'damaged', null, null, '  ')$$, 'reason is required', 'stock-out reason required');
select tests.throws($$select public.record_stock_out(3, 5, 'sale', null, null, 'x')$$, 'Use Record Sale', 'sale type not allowed in stock out');
select public.record_stock_out((select id from public.products where sku = 'FOOD-001'), 5, 'damaged', null, 'DMG-1', 'Torn sacks');

-- adjustment: admin only
select tests.throws($$select public.record_adjustment(2, 'count', 140)$$, 'permission', 'staff cannot adjust stock');
select tests.as_user('00000000-0000-0000-0000-00000000000a');
select tests.throws($$select public.record_adjustment(2, '', 140)$$, 'reason is required', 'adjustment reason required');
select tests.throws($$select public.record_adjustment(2, 'x', 140, 5)$$, 'either', 'adjustment needs exactly one mode');
select tests.throws($$select public.record_adjustment(2, 'x', 135)$$, 'does not change', 'no-op adjustment rejected');
select public.record_adjustment((select id from public.products where sku = 'BEV-002'), 'Physical count', 140);
select tests.eq((select array[quantity_before, quantity_change, quantity_after] from public.stock_movements
                  where movement_type = 'adjustment' order by id desc limit 1), array[135, 5, 140],
  'adjustment stores previous / change / new quantity');

select tests.set_time((select array_agg(id) from public.stock_movements where occurred_at > '2026-10-31 23:59 Asia/Manila'),
  '2026-11-01 10:00 Asia/Manila');
reset role;

-- ===========================================================================
-- 5. Day 2 (Nov 2): In +80, Sold -25 → 670 ; boundary check at 23:30 Nov 1 local
-- ===========================================================================
set role authenticated;
select tests.as_user('00000000-0000-0000-0000-00000000000a');
select public.record_stock_in((select id from public.products where sku = 'BEV-002'), 80, null, 'DR-1003', null);
select public.record_sale(jsonb_build_array(jsonb_build_object('product_id', (select id from public.products where sku = 'BEV-001'), 'quantity', 25)),
  null, 'OR-0002');
select tests.set_time((select array_agg(id) from public.stock_movements where occurred_at > '2026-11-01 23:59 Asia/Manila'),
  '2026-11-02 08:15 Asia/Manila');

select tests.eq(
  (select array[beginning_stock, stock_in, stock_sold, other_out, adjustments, ending_stock]
     from public.stock_movement_summary('2026-11-01', '2026-11-01', 'day')),
  array[500, 150, 35, 5, 5, 615]::bigint[], 'DAILY Nov 1 matches specification example (500/150/35/5/5/615)');
select tests.eq(
  (select array[beginning_stock, stock_in, stock_sold, other_out, adjustments, ending_stock]
     from public.stock_movement_summary('2026-11-02', '2026-11-02', 'day')),
  array[615, 80, 25, 0, 0, 670]::bigint[], 'DAILY Nov 2: beginning equals previous ending (615 → 670)');

-- weekly (ISO week Mon Oct 26 – Sun Nov 1) and a custom 7-day window
select tests.eq((select count(*)::int from public.stock_movement_summary('2026-10-26', '2026-11-01', 'day')), 7, 'WEEKLY returns 7 daily rows');
select tests.eq(
  (select array[min(beginning_stock) filter (where period_start = '2026-10-26'), sum(stock_in), sum(stock_sold),
                max(ending_stock) filter (where period_start = '2026-11-01')]::bigint[]
     from public.stock_movement_summary('2026-10-26', '2026-11-01', 'day')),
  array[0, 650, 35, 615]::bigint[], 'WEEKLY totals: begin 0, in 650, sold 35, end 615');

-- monthly (daily rows for November)
select tests.eq((select count(*)::int from public.stock_movement_summary('2026-11-01', '2026-11-30', 'day')), 30, 'MONTHLY returns 30 daily rows');
select tests.eq((select ending_stock from public.stock_movement_summary('2026-11-01', '2026-11-30', 'day') where period_start = '2026-11-30'),
  670::bigint, 'MONTHLY carries balance forward to month end');

-- yearly (monthly rows)
select tests.eq((select count(*)::int from public.stock_movement_summary('2026-01-01', '2026-12-31', 'month')), 12, 'YEARLY returns 12 monthly rows');
select tests.eq(
  (select array[beginning_stock, stock_in, stock_sold, other_out, adjustments, ending_stock]
     from public.stock_movement_summary('2026-01-01', '2026-12-31', 'month') where period_start = '2026-11-01'),
  array[500, 230, 60, 5, 5, 670]::bigint[], 'YEARLY November row aggregates both days');
select tests.eq((select ending_stock from public.stock_movement_summary('2026-01-01', '2026-12-31', 'month') where period_start = '2026-10-01'),
  500::bigint, 'YEARLY October ends at opening 500');

-- category & product filters
select tests.eq(
  (select array[beginning_stock, stock_in, stock_sold, other_out, adjustments, ending_stock]
     from public.stock_movement_summary('2026-11-01', '2026-11-01', 'day', (select id from public.categories where name = 'Beverages'))),
  array[450, 100, 35, 0, 5, 520]::bigint[], 'CATEGORY Beverages Nov 1 (450 → 520)');
select tests.eq(
  (select array[beginning_stock, stock_in, stock_sold, other_out, adjustments, ending_stock]
     from public.stock_movement_summary('2026-11-01', '2026-11-01', 'day', null, (select id from public.products where sku = 'FOOD-001'))),
  array[50, 50, 0, 5, 0, 95]::bigint[], 'PRODUCT Rice 5kg Nov 1 (50 → 95)');
select tests.eq(
  (select array[beginning_stock, stock_in, stock_sold, ending_stock]
     from public.stock_movement_summary('2026-11-01', '2026-11-02', 'day',
          (select id from public.categories where name = 'Beverages'), (select id from public.products where sku = 'BEV-001'))
    where period_start = '2026-11-02'),
  array[380, 0, 25, 355]::bigint[], 'CATEGORY + PRODUCT combined filter');

-- breakdowns
select tests.eq(
  (select array[beginning_stock, stock_in, stock_sold, ending_stock] from public.stock_movement_breakdown('2026-11-01', '2026-11-02', 'product')
    where sku = 'BEV-001'),
  array[300, 100, 45, 355]::bigint[], 'breakdown by product (Cola: 300 + 100 − 45 = 355)');
select tests.eq((select sum(ending_stock) from public.stock_movement_breakdown('2026-11-01', '2026-11-02', 'category')), 670::numeric,
  'breakdown by category sums to total inventory');

-- detailed list
select tests.eq((select count(*)::int from public.list_movements('2026-11-01', '2026-11-02', null, null, array['sale']::public.movement_type[])),
  3, 'list_movements filters by movement type');
select tests.eq((select max(total_count)::int from public.list_movements('2026-11-01', '2026-11-02', null, null, null, null, 2, 0)),
  8, 'list_movements returns total count with pagination');
select tests.eq((select count(*)::int from public.list_movements('2026-11-01', '2026-11-02', null, null, null, 'dr-100')), 3,
  'list_movements text search (reference)');

-- ===========================================================================
-- 6. Historical integrity: rename + recategorise must not rewrite history
-- ===========================================================================
select public.update_product((select id from public.products where sku = 'BEV-002'), 'BEV-002', 'Orange Juice 1L',
  (select id from public.categories where name = 'Food Products'), 'pack', 25, 36, 10);
select tests.eq((select count(*)::int from public.stock_movements where movement_type = 'reclassify'), 2, 'category change writes a transfer pair');
select tests.eq((select current_stock from public.products where sku = 'BEV-002'), 220, 'transfer leaves product stock unchanged');
select tests.eq(
  (select array[beginning_stock, stock_in, stock_sold, other_out, adjustments, ending_stock]
     from public.stock_movement_summary('2026-11-01', '2026-11-01', 'day', (select id from public.categories where name = 'Beverages'))),
  array[450, 100, 35, 0, 5, 520]::bigint[], 'Beverages history for Nov 1 unchanged after recategorisation');
select tests.eq((select ending_stock from public.stock_movement_summary('2026-11-01', current_date + 1, 'day') order by period_start desc limit 1),
  670::bigint, 'overall inventory unchanged by recategorisation');
select tests.eq((select product_name from public.stock_movements where reference_no = 'DR-1003'), 'Orange Juice',
  'movement keeps the product name at the time of the movement');

-- ===========================================================================
-- 7. Ledger invariants & immutability
-- ===========================================================================
reset role;
select tests.eq((select count(*)::int from public.products p
                  where p.current_stock <> coalesce((select sum(quantity_change) from public.stock_movements m where m.product_id = p.id), 0)),
  0, 'INVARIANT: every product stock equals the sum of its ledger');
select tests.eq((select count(*)::int from (
    select quantity_before, lag(quantity_after) over (partition by product_id order by id) as prev
      from public.stock_movements) x where prev is not null and prev <> quantity_before), 0,
  'INVARIANT: each movement starts where the previous one ended');
select tests.throws($$update public.stock_movements set quantity_change = 1 where id = 1$$, 'permanent audit history', 'movements cannot be edited');
select tests.throws($$delete from public.stock_movements where id = 1$$, 'permanent audit history', 'movements cannot be deleted');
select tests.throws($$delete from public.sales$$, 'permanent audit history', 'sales cannot be deleted');
select tests.throws($$truncate public.stock_movements cascade$$, 'permanent audit history', 'ledger cannot be truncated');

-- reversal policy
set role authenticated;
select tests.as_user('00000000-0000-0000-0000-00000000000a');
select public.reverse_movement((select id from public.stock_movements where reference_no = 'DMG-1'), 'Sacks were repairable');
select tests.eq((select current_stock from public.products where sku = 'FOOD-001'), 100, 'reversal restores damaged quantity');
select tests.throws($$select public.reverse_movement((select id from public.stock_movements where reference_no = 'DMG-1' and movement_type = 'damaged'), 'again')$$,
  'already been reversed', 'a movement can only be reversed once');
select tests.throws($$select public.reverse_movement((select min(id) from public.stock_movements where movement_type = 'sale'), 'x')$$,
  'cannot be reversed', 'sales cannot be reversed via reversal');
select tests.as_user('00000000-0000-0000-0000-00000000000c');
select tests.throws($$select public.reverse_movement(1, 'x')$$, 'permission', 'staff cannot reverse movements');

-- ===========================================================================
-- 8. Safeguarded deletes
-- ===========================================================================
select tests.as_user('00000000-0000-0000-0000-00000000000a');
select tests.throws($$select public.delete_product((select id from public.products where sku = 'BEV-001'))$$, 'still has',
  'cannot delete a product that has stock');
select tests.eq(public.delete_product((select id from public.products where sku = 'HH-001')), 'deleted', 'unused product is deleted');
select public.record_adjustment((select id from public.products where sku = 'FOOD-001'), 'Write-off for test', 0);
select tests.eq(public.delete_product((select id from public.products where sku = 'FOOD-001')), 'archived', 'product with history is archived');
select tests.throws($$select public.record_stock_in((select id from public.products where sku = 'FOOD-001'), 1)$$, 'archived',
  'archived product cannot receive stock');
select tests.eq((select is_archived from public.products where sku = 'FOOD-001'), true, 'archive flag set');
select tests.eq(public.delete_customer((select id from public.customers where full_name = 'Juan Dela Cruz')), 'archived', 'customer with sales archived');
select tests.eq(public.delete_customer((select id from public.customers where full_name = 'Maria Santos')), 'deleted', 'unused customer deleted');
select tests.eq(public.delete_supplier((select id from public.suppliers where name = 'Metro Distributors')), 'archived', 'supplier with deliveries archived');
select tests.eq(public.delete_supplier((select id from public.suppliers where name = 'Fresh Farms Supply')), 'deleted', 'unused supplier deleted');
select tests.throws($$select public.delete_category((select id from public.categories where name = 'Beverages'))$$, 'still contains',
  'category with products cannot be deleted');
select tests.eq(public.delete_category((select id from public.categories where name = 'Personal Care')), 'deleted', 'empty category deleted');

-- ===========================================================================
-- 9. Dashboard, reports & settings
-- ===========================================================================
select tests.as_user('00000000-0000-0000-0000-00000000000b');   -- owner (read-only) can view BI
select tests.eq((public.dashboard_stats() ->> 'total_quantity')::int, 575, 'dashboard total quantity from database (670 − 95 written off)');
select tests.eq((public.dashboard_stats() ->> 'total_customers')::int, 0, 'dashboard excludes archived customers');
select tests.ok(jsonb_array_length(public.dashboard_stats() -> 'trend') = 14, 'dashboard trend has 14 days');
select tests.eq((select sale_count from public.customer_overview where full_name = 'Juan Dela Cruz'), 1::bigint, 'customer report aggregates sales');
select tests.eq((select total_quantity from public.supplier_overview where name = 'Metro Distributors'), 150::bigint,
  'supplier report aggregates deliveries (50 opening + 100)');
select tests.eq((select stock_status from public.product_overview where sku = 'FOOD-001'), 'out', 'product overview flags out of stock');
select tests.ok((select count(*) from public.activity_logs) > 10, 'owner can read activity log');
select tests.throws($$select public.update_setting('store_name', '"Owner Store"')$$, 'permission', 'owner cannot change settings');
select tests.as_user('00000000-0000-0000-0000-00000000000a');
select tests.throws($$select public.update_setting('timezone', '"Mars/Base"')$$, 'Invalid time zone', 'invalid time zone rejected');
select public.update_setting('store_name', '"Bill Store"');
select tests.as_user('00000000-0000-0000-0000-00000000000c');
select tests.eq((select count(*)::int from public.activity_logs where user_id <> auth.uid()), 0, 'staff only see their own activity');
select tests.ok((select count(*) from public.activity_logs where action = 'sale') >= 1, 'sales are audit-logged');

-- ===========================================================================
-- 10. Deactivated accounts lose access immediately
-- ===========================================================================
reset role;
update public.profiles set is_active = false where id = '00000000-0000-0000-0000-00000000000c';
set role authenticated;
select tests.as_user('00000000-0000-0000-0000-00000000000c');
select tests.eq((select count(*)::int from public.products), 0, 'deactivated user sees no products');
select tests.throws($$select public.record_stock_in(1, 1)$$, 'not active', 'deactivated user cannot record stock');
select tests.throws($$select public.dashboard_stats()$$, 'Not authorised', 'deactivated user cannot load dashboard');
reset role;

-- ===========================================================================
-- 11. Brute-force lockout (service role, used by the auth-login edge function)
-- ===========================================================================
set role service_role;
select public.login_record('victim@billstore.test', false) from generate_series(1, 4);
select tests.eq((public.login_guard('victim@billstore.test') ->> 'locked')::boolean, false, '4 failures: not locked yet');
select tests.eq((public.login_record('Victim@BillStore.test', false) ->> 'locked')::boolean, true, '5th failure locks the account (case-insensitive)');
select tests.eq((public.login_guard('victim@billstore.test') ->> 'locked')::boolean, true, 'guard reports lock');
select public.login_record('victim@billstore.test', true);
select tests.eq((public.login_guard('victim@billstore.test') ->> 'failed_count')::int, 0, 'successful login clears counter');
reset role;
set role authenticated;
select tests.as_user('00000000-0000-0000-0000-00000000000a');
select tests.throws($$select public.login_guard('x')$$, 'permission denied', 'login guard not callable from the browser');
select tests.throws($$select public.admin_revoke_sessions('00000000-0000-0000-0000-00000000000c')$$, 'permission denied',
  'session revocation not callable from the browser');
reset role;

-- ===========================================================================
-- 11b. Deactivate / reactivate products
-- ===========================================================================
set role authenticated;
select tests.as_user('00000000-0000-0000-0000-00000000000a');
select public.set_product_active((select id from public.products where sku = 'BEV-002'), false);
select tests.eq((select is_archived from public.products where sku = 'BEV-002'), true, 'admin can deactivate a product that still has stock');
select tests.eq((select current_stock from public.products where sku = 'BEV-002'), 220, 'deactivation keeps the stock quantity');
select tests.throws($$select public.record_sale(jsonb_build_array(jsonb_build_object('product_id', (select id from public.products where sku = 'BEV-002'), 'quantity', 1)))$$,
  'archived', 'inactive product cannot be sold');
select tests.throws($$select public.record_stock_in((select id from public.products where sku = 'BEV-002'), 1)$$, 'archived', 'inactive product cannot be restocked');
select tests.ok((select count(*) from public.activity_logs where action = 'product_deactivated') = 1, 'deactivation is audit-logged');
select tests.as_user('00000000-0000-0000-0000-00000000000b');
select tests.throws($$select public.set_product_active(2, true)$$, 'permission', 'owner cannot reactivate products');
select tests.as_user('00000000-0000-0000-0000-00000000000a');
select public.set_product_active((select id from public.products where sku = 'BEV-002'), true);
select tests.eq((select is_archived from public.products where sku = 'BEV-002'), false, 'admin can reactivate a product');
select (public.record_stock_in((select id from public.products where sku = 'BEV-002'), 1, null, 'REACT-1', null)).id;
select tests.eq((select current_stock from public.products where sku = 'BEV-002'), 221, 'reactivated product accepts stock again');
reset role;

-- ===========================================================================
-- 12. Time-zone boundary: 23:30 Nov 1 Manila (= 15:30 UTC) belongs to Nov 1
-- ===========================================================================
set role authenticated;
select tests.as_user('00000000-0000-0000-0000-00000000000a');
select public.record_stock_in((select id from public.products where sku = 'BEV-001'), 1, null, 'LATE-1', null);
select tests.set_time(array[(select id from public.stock_movements where reference_no = 'LATE-1')], '2026-11-01 23:30 Asia/Manila');
select tests.eq((select stock_in from public.stock_movement_summary('2026-11-01', '2026-11-01', 'day')), 151::bigint,
  'late-evening local movement counted on its local day');
select tests.eq((select beginning_stock from public.stock_movement_summary('2026-11-02', '2026-11-02', 'day')), 616::bigint,
  'next day beginning reflects it');
reset role;

-- ===========================================================================
-- 13. Account deletion with a 7-day recovery window
-- ===========================================================================
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'temp1@billstore.test'),
  ('00000000-0000-0000-0000-0000000000e2', 'temp2@billstore.test');
insert into public.profiles (id, email, full_name, role) values
  ('00000000-0000-0000-0000-0000000000e1', 'temp1@billstore.test', 'Temp One', 'staff'),
  ('00000000-0000-0000-0000-0000000000e2', 'temp2@billstore.test', 'Temp Two', 'staff');
-- Temp One records stock, so their name is part of history
set role authenticated;
select tests.as_user('00000000-0000-0000-0000-0000000000e1');
select (public.record_stock_out((select id from public.products where sku = 'BEV-002'), 1, 'other_out', null, 'DEL-TEST', 'Sample')).id;
select tests.as_user('00000000-0000-0000-0000-00000000000b');
select tests.throws($$select public.schedule_user_deletion('00000000-0000-0000-0000-0000000000e1')$$, 'permission', 'owner cannot delete accounts');
select tests.as_user('00000000-0000-0000-0000-00000000000a');
select tests.throws($$select public.schedule_user_deletion('00000000-0000-0000-0000-00000000000a')$$, 'own account', 'admin cannot delete own account');
select public.schedule_user_deletion('00000000-0000-0000-0000-0000000000e1');
select public.schedule_user_deletion('00000000-0000-0000-0000-0000000000e2');
select tests.eq((select is_active from public.profiles where id = '00000000-0000-0000-0000-0000000000e1'), false, 'scheduled account is disabled immediately');
select tests.throws($$select public.schedule_user_deletion('00000000-0000-0000-0000-0000000000e1')$$, 'already scheduled', 'cannot schedule twice');
select tests.as_user('00000000-0000-0000-0000-0000000000e1');
select tests.throws($$select public.record_stock_in(1, 1)$$, 'not active', 'scheduled account cannot work');
select tests.as_user('00000000-0000-0000-0000-00000000000a');
select public.recover_user_account('00000000-0000-0000-0000-0000000000e2');
select tests.eq((select array[is_active::text, coalesce(deletion_scheduled_at::text, 'none')] from public.profiles where id = '00000000-0000-0000-0000-0000000000e2'),
  array['true', 'none'], 'recovered within 7 days: account active again');
select tests.eq(public.purge_expired_user_deletions(), 0, 'nothing is purged before 7 days');
reset role;
update public.profiles set deletion_scheduled_at = now() - interval '8 days' where id = '00000000-0000-0000-0000-0000000000e1';
set role authenticated;
select tests.as_user('00000000-0000-0000-0000-00000000000a');
select tests.throws($$select public.recover_user_account('00000000-0000-0000-0000-0000000000e1')$$, 'recovery period', 'cannot recover after 7 days');
select tests.eq(public.purge_expired_user_deletions(), 1, 'expired account is purged');
select tests.throws($$select public.recover_user_account('00000000-0000-0000-0000-0000000000e1')$$, 'permanently deleted', 'purged account cannot be recovered');
reset role;
select tests.eq((select count(*)::int from auth.users where id = '00000000-0000-0000-0000-0000000000e1'), 0, 'sign-in removed after purge');
select tests.eq((select full_name || '|' || email from public.profiles where id = '00000000-0000-0000-0000-0000000000e1'),
  'Deleted user|deleted-00000000-0000-0000-0000-0000000000e1@deleted.invalid', 'personal details erased');
select tests.eq((select created_by_name from public.stock_movements where reference_no = 'DEL-TEST'), 'Temp One', 'history keeps the name recorded at the time');
select tests.ok(exists (select 1 from public.activity_logs where action = 'user_deleted'), 'permanent deletion is audit-logged');

-- ===========================================================================
-- 14. Profile photos
-- ===========================================================================
set role authenticated;
select tests.as_user('00000000-0000-0000-0000-00000000000b');
select (public.update_my_avatar('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==')).id;
select tests.eq((select avatar_url from public.profiles where id = auth.uid()), 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==', 'user can set own photo');
select tests.throws($$select public.update_my_avatar('javascript:alert(1)')$$, 'JPEG, PNG or WebP', 'non-image values rejected');
select tests.throws($$select public.update_my_avatar('data:image/svg+xml;base64,PHN2Zz4=')$$, 'JPEG, PNG or WebP', 'SVG rejected');
select tests.throws($$select public.update_my_avatar('data:image/png;base64,' || repeat('A', 400001))$$, 'under 300 KB', 'oversized photo rejected');
select tests.throws($$update public.profiles set avatar_url = null where id = '00000000-0000-0000-0000-00000000000a'$$, 'permission denied', 'cannot change another user''s photo directly');
select (public.update_my_avatar(null)).id;
select tests.eq((select avatar_url from public.profiles where id = auth.uid()), null::text, 'user can remove own photo');
reset role;

-- ===========================================================================
-- 15. Backup & restore
-- ===========================================================================
reset role;
select tests.eq((select array_to_string(public.backup_table_list(), ',')),
  'activity_logs,auth_lockouts,categories,customers,products,profiles,sale_items,sales,setup_state,stock_movements,suppliers,system_settings',
  'backup covers all 12 application tables (and no backup_* tables)');
create table public.zz_future_table (id int primary key);
select tests.ok('zz_future_table' = any (public.backup_table_list()), 'tables added later are detected automatically');
drop table public.zz_future_table;

-- permissions
set role authenticated;
select tests.as_user('00000000-0000-0000-0000-00000000000a');
select tests.throws($$select public.backup_export_snapshot()$$, 'permission denied', 'browser users cannot export the database directly');
select tests.throws($$select public.backup_restore_apply('{}')$$, 'permission denied', 'browser users cannot call the restore function');
select tests.eq((select count(*)::int from public.backup_settings), 1, 'admin can read backup settings');
select (public.backup_update_settings(true, 0::smallint, 0::smallint, 12::smallint)).auto_enabled;
select tests.ok(exists (select 1 from public.activity_logs where action = 'backup_settings_changed'), 'settings changes are audit-logged');
select tests.as_user('00000000-0000-0000-0000-00000000000b');
select tests.eq((select count(*)::int from public.backup_settings), 0, 'owner cannot see backup settings');
select tests.throws($$select public.backup_update_settings(false, null, null, null)$$, 'permission', 'owner cannot change backup settings');
select tests.throws($$insert into public.backup_runs (trigger, created_by_name) values ('manual', 'x')$$, 'permission denied', 'nobody can write backup history through the API');
reset role;

-- consistent snapshot of every table
set role service_role;
create temp table bk_snapshot as select public.backup_export_snapshot() as snap;
reset role;
grant select on bk_snapshot to authenticated;
select tests.eq((select count(*)::int from jsonb_object_keys((select snap -> 'tables' from bk_snapshot))), 12, 'snapshot contains all 12 tables');
select tests.eq((select jsonb_array_length(snap -> 'tables' -> 'stock_movements') from bk_snapshot), (select count(*)::int from public.stock_movements), 'snapshot has every stock movement');
select tests.eq((select jsonb_array_length(snap -> 'tables' -> 'profiles') from bk_snapshot), (select count(*)::int from public.profiles), 'snapshot has every profile (incl. deleted-account placeholders)');
select tests.ok((select bool_and(u ? 'id' and not (u ? 'encrypted_password')) from bk_snapshot, jsonb_array_elements(snap -> 'auth_users') u), 'auth list has ids but never password hashes');

-- change data after the backup
insert into public.categories (name) values ('After Backup');
set role authenticated;
select tests.as_user('00000000-0000-0000-0000-00000000000a');
select (public.record_stock_in((select id from public.products where sku = 'BEV-001'), 7, null, 'AFTER-BK', null)).id;
reset role;
create temp table bk_before_counts as select (select count(*) from public.stock_movements) as movements, (select current_stock from public.products where sku = 'BEV-001') as cola;

-- a backup that breaks a relationship is rejected and nothing changes
set role service_role;
select tests.throws($$select public.backup_restore_apply(jsonb_set((select snap -> 'tables' from bk_snapshot), '{sale_items,0,product_id}', '999999'))$$,
  'break relationship', 'restore with a broken relationship is rejected');
select tests.throws($$select public.backup_restore_apply((select snap -> 'tables' from bk_snapshot) || jsonb_build_object('products',
    (select jsonb_agg(case when p ->> 'sku' = 'BEV-001' then jsonb_set(p, '{current_stock}', '1') else p end) from jsonb_array_elements((select snap -> 'tables' -> 'products' from bk_snapshot)) p)))$$,
  'does not match the movement ledger', 'restore whose stock does not match the ledger is rejected');
select tests.throws($$select public.backup_restore_apply('{"evil_table": []}')$$, 'does not exist', 'unknown tables are rejected');
reset role;
select tests.eq((select count(*) from public.stock_movements), (select movements from bk_before_counts), 'rejected restores left the data untouched');
select tests.ok(exists (select 1 from public.categories where name = 'After Backup'), 'rejected restores kept the newer category');

-- full restore
set role service_role;
create temp table bk_result as select public.backup_restore_apply((select snap -> 'tables' from bk_snapshot)) as r;
reset role;
select tests.eq((select (r -> 'tables' ->> 'stock_movements')::int from bk_result), (select jsonb_array_length(snap -> 'tables' -> 'stock_movements') from bk_snapshot), 'restore brings back exactly the backed-up movements');
select tests.ok(not exists (select 1 from public.categories where name = 'After Backup'), 'data created after the backup is gone after restore');
select tests.eq((select current_stock from public.products where sku = 'BEV-001'), (select cola from bk_before_counts) - 7, 'stock is back to the backed-up quantity');
select tests.eq((select count(*)::int from public.products p
                  where p.current_stock <> coalesce((select sum(quantity_change) from public.stock_movements m where m.product_id = p.id), 0)), 0,
  'ledger balances after restore');
select tests.eq((select count(*)::int from public.sale_items si where not exists (select 1 from public.sales s where s.id = si.sale_id)), 0, 'sale items still belong to their sales');
select tests.eq((select avatar_url from public.profiles where id = '00000000-0000-0000-0000-00000000000b'),
  (select p ->> 'avatar_url' from bk_snapshot, jsonb_array_elements(snap -> 'tables' -> 'profiles') p where p ->> 'id' = '00000000-0000-0000-0000-00000000000b'), 'profile photos restored');
select tests.throws($$delete from public.stock_movements where id = (select min(id) from public.stock_movements)$$, 'permanent audit history', 'ledger protection is active again after restore');
set role authenticated;
select tests.as_user('00000000-0000-0000-0000-00000000000a');
select tests.ok((public.record_stock_in((select id from public.products where sku = 'BEV-001'), 1, null, 'POST-RESTORE', null)).id > (select max((m ->> 'id')::bigint) from bk_snapshot, jsonb_array_elements(snap -> 'tables' -> 'stock_movements') m),
  'new records continue after the restored ids');
reset role;

-- scheduler duplicates & retention
insert into public.backup_runs (trigger, status, schedule_slot, created_by_name) values ('scheduled', 'running', '2026-11-08 00:00+08', 'Automatic scheduler');
select tests.throws($$insert into public.backup_runs (trigger, status, schedule_slot, created_by_name) values ('scheduled', 'running', '2026-11-08 00:00+08', 'Automatic scheduler')$$,
  'duplicate key', 'only one scheduled backup per weekly slot');
update public.backup_runs set status = 'failed' where schedule_slot = '2026-11-08 00:00+08';
insert into public.backup_runs (trigger, status, schedule_slot, attempt, created_by_name) values ('scheduled', 'running', '2026-11-08 00:00+08', 2, 'Automatic scheduler');
select tests.ok(true, 'a failed scheduled backup can be retried for the same slot');
delete from public.backup_runs;
insert into public.backup_runs (trigger, status, schedule_slot, created_by_name, created_at)
select 'scheduled', 'success', now() - make_interval(days => 7 * g), 'Automatic scheduler', now() - make_interval(days => 7 * g) from generate_series(1, 14) g;
insert into public.backup_runs (trigger, status, schedule_slot, created_by_name, created_at) values ('scheduled', 'failed', now() - interval '200 days', 'Automatic scheduler', now() - interval '200 days');
set role service_role;
select tests.eq((select count(*)::int from public.backup_retention_candidates(12)), 2, 'retention keeps the newest 12 successful weekly backups');
select tests.eq((select count(*)::int from public.backup_retention_candidates(12) where status <> 'success'), 0, 'failed backups never count toward retention');
reset role;
update public.backup_settings set restore_in_progress = (select id from public.backup_runs where status = 'success' order by created_at limit 1);
set role service_role;
select tests.eq((select count(*)::int from public.backup_retention_candidates(12)), 1, 'a backup being restored is never deleted by retention');
select tests.eq(public.backup_check_cron_token('wrong-token-wrong-token-wrong-token-xx'), false, 'scheduler rejects a wrong token');
reset role;
update public.backup_settings set restore_in_progress = null;
delete from public.backup_runs;

-- ---------------------------------------------------------------------------
\set QUIET 0
\o
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from tests.results;
do $$
begin
  if exists (select 1 from tests.results where not ok) then
    raise exception 'DATABASE TESTS FAILED: %', (select string_agg(msg, E'\n') from tests.results where not ok);
  end if;
end $$;
