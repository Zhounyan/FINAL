-- ============================================================================
-- Cashiers may record Stock-In and Stock-Out (receiving deliveries, releasing
-- damaged / expired / lost / internal-use items). Adjustments, reversals, the
-- full movement history and all reports remain Administrator-only.
-- ============================================================================

-- Stock-In: Administrator and Cashier
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
  perform public.require_role('admin', 'cashier');
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
                       'supplier_id', p_supplier_id, 'reference_no', v_row.reference_no, 'unit_cost', p_unit_cost));
  return v_row;
end
$$;

-- Stock-Out: Administrator and Cashier
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
  perform public.require_role('admin', 'cashier');
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

-- Cashiers see the stock entries they recorded themselves (Stock-In / Stock-Out history);
-- the Administrator still sees the whole ledger.
drop policy if exists stock_movements_select_own on public.stock_movements;
create policy stock_movements_select_own on public.stock_movements
  for select to authenticated using (created_by = auth.uid() and public.is_active_user());

-- Cashiers can pick a supplier when receiving stock (read only; changes stay Administrator-only).
drop policy if exists suppliers_select on public.suppliers;
create policy suppliers_select on public.suppliers
  for select to authenticated using (public.is_active_user());

notify pgrst, 'reload schema';
