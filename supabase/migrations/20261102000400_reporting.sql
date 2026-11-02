-- ============================================================================
-- INVPORTIQ — Reporting & business intelligence
-- All balances are derived from the immutable ledger:
--   balance(t) = SUM(quantity_change) of movements before t
--   Ending = Beginning + Stock In − Stock Sold − Other Stock Out ± Adjustments
-- Day/month boundaries use the store time zone (system_settings.timezone).
-- These functions are SECURITY INVOKER so row level security still applies.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Read models (views run with the caller's privileges)
-- ---------------------------------------------------------------------------
create or replace view public.product_overview with (security_invoker = true) as
select
  p.id, p.sku, p.name, p.category_id, c.name as category_name, p.description, p.unit,
  p.purchase_price, p.selling_price, p.current_stock, p.min_stock_level, p.is_archived,
  p.created_at, p.updated_at, p.created_by,
  case
    when p.current_stock = 0 then 'out'
    when p.current_stock <= p.min_stock_level then 'low'
    else 'ok'
  end as stock_status,
  (p.current_stock * p.purchase_price)::numeric(14,2) as stock_value
from public.products p
join public.categories c on c.id = p.category_id;

create or replace view public.customer_overview with (security_invoker = true) as
select
  c.*,
  coalesce(s.sale_count, 0) as sale_count,
  coalesce(s.total_quantity, 0) as total_quantity,
  coalesce(s.total_amount, 0)::numeric(14,2) as total_amount,
  s.last_purchase_at
from public.customers c
left join lateral (
  select count(*) as sale_count, sum(total_quantity) as total_quantity,
         sum(total_amount) as total_amount, max(sold_at) as last_purchase_at
    from public.sales where customer_id = c.id
) s on true;

create or replace view public.supplier_overview with (security_invoker = true) as
select
  s.*,
  coalesce(m.delivery_count, 0) as delivery_count,
  coalesce(m.total_quantity, 0) as total_quantity,
  coalesce(m.total_cost, 0)::numeric(14,2) as total_cost,
  m.last_delivery_at
from public.suppliers s
left join lateral (
  select count(*) as delivery_count, sum(quantity_change) as total_quantity,
         sum(quantity_change * coalesce(unit_cost, 0)) as total_cost, max(occurred_at) as last_delivery_at
    from public.stock_movements where supplier_id = s.id and movement_type = 'stock_in'
) m on true;

-- ---------------------------------------------------------------------------
-- Period summary: one row per day (daily/weekly/monthly views) or per month
-- (yearly view). Optional category and/or product filter.
-- ---------------------------------------------------------------------------
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
           coalesce(-sum(m.quantity_change) filter (where m.movement_type in ('damaged', 'lost', 'other_out')), 0)::bigint as s_other,
           coalesce(sum(m.quantity_change) filter (where m.movement_type in ('adjustment', 'reclassify')), 0)::bigint as s_adj,
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

-- ---------------------------------------------------------------------------
-- Breakdown for a period, grouped by product or by category.
-- ---------------------------------------------------------------------------
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
           coalesce(-sum(m.quantity_change) filter (where m.occurred_at >= v_start and m.movement_type in ('damaged', 'lost', 'other_out')), 0)::bigint as s_other,
           coalesce(sum(m.quantity_change) filter (where m.occurred_at >= v_start and m.movement_type in ('adjustment', 'reclassify')), 0)::bigint as s_adj,
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
-- Detailed movement list with combined filters and server-side pagination.
-- ---------------------------------------------------------------------------
create or replace function public.list_movements(
  p_from date,
  p_to date,
  p_category_id bigint default null,
  p_product_id bigint default null,
  p_types public.movement_type[] default null,
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0)
returns table (
  id bigint,
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
  select m.id, m.movement_type, m.product_id, m.product_name, m.product_sku, m.category_id, m.category_name,
         m.quantity_change, m.quantity_before, m.quantity_after, m.unit_cost, m.unit_price,
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
          or m.reference_no ilike '%' || v_search || '%'
          or m.reason ilike '%' || v_search || '%'
          or m.created_by_name ilike '%' || v_search || '%')
   order by m.occurred_at desc, m.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 5000)
  offset greatest(coalesce(p_offset, 0), 0);
end
$$;

-- ---------------------------------------------------------------------------
-- Dashboard KPIs (single round trip)
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_stats(p_days integer default 14)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_tz text := public.store_timezone();
  v_today date := (now() at time zone public.store_timezone())::date;
  v_days int := least(greatest(coalesce(p_days, 14), 7), 90);
  v_month_start date := date_trunc('month', (now() at time zone public.store_timezone()))::date;
  v_result jsonb;
begin
  if not public.is_active_user() then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'today', v_today,
    'timezone', v_tz,
    'total_products', (select count(*) from public.products where not is_archived),
    'total_quantity', (select coalesce(sum(current_stock), 0) from public.products),
    'low_stock', (select count(*) from public.products
                   where not is_archived and current_stock > 0 and current_stock <= min_stock_level),
    'out_of_stock', (select count(*) from public.products where not is_archived and current_stock = 0),
    'total_customers', (select count(*) from public.customers where not is_archived),
    'total_suppliers', (select count(*) from public.suppliers where not is_archived),
    'total_categories', (select count(*) from public.categories),
    'inventory_cost_value', (select coalesce(sum(current_stock * purchase_price), 0) from public.products),
    'inventory_retail_value', (select coalesce(sum(current_stock * selling_price), 0) from public.products),
    'today_summary', (select to_jsonb(s) from public.stock_movement_summary(v_today, v_today, 'day') s),
    'month_summary', (select jsonb_build_object(
                         'stock_in', coalesce(sum(s.stock_in), 0), 'stock_sold', coalesce(sum(s.stock_sold), 0),
                         'other_out', coalesce(sum(s.other_out), 0), 'adjustments', coalesce(sum(s.adjustments), 0))
                       from public.stock_movement_summary(v_month_start, v_today, 'day') s),
    'all_time', (select jsonb_build_object(
                   'stock_in', coalesce(sum(quantity_change) filter (where movement_type = 'stock_in'), 0),
                   'stock_sold', coalesce(-sum(quantity_change) filter (where movement_type = 'sale'), 0),
                   'sales_amount', (select coalesce(sum(total_amount), 0) from public.sales))
                 from public.stock_movements),
    'month_sales_amount', (select coalesce(sum(total_amount), 0) from public.sales
                            where sold_at >= (v_month_start::timestamp at time zone v_tz)),
    'trend', (select coalesce(jsonb_agg(to_jsonb(s) order by s.period_start), '[]'::jsonb)
                from public.stock_movement_summary(v_today - (v_days - 1), v_today, 'day') s),
    'category_distribution', (select coalesce(jsonb_agg(x order by x.quantity desc), '[]'::jsonb) from (
                                select c.id, c.name, count(p.id) as products, coalesce(sum(p.current_stock), 0) as quantity
                                  from public.categories c
                                  left join public.products p on p.category_id = c.id and not p.is_archived
                                 group by c.id, c.name) x),
    'stock_alerts', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
                       select p.id, p.name, p.sku, p.current_stock, p.min_stock_level, p.unit,
                              case when p.current_stock = 0 then 'out' else 'low' end as status
                         from public.products p
                        where not p.is_archived and p.current_stock <= p.min_stock_level
                        order by p.current_stock, p.name
                        limit 8) x),
    'top_stock', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
                    select p.id, p.name, p.current_stock, p.min_stock_level
                      from public.products p where not p.is_archived
                     order by p.current_stock desc, p.name limit 10) x)
  ) into v_result;
  return v_result;
end
$$;
