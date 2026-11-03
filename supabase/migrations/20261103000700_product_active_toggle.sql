-- ============================================================================
-- Product Deactivate / Reactivate
-- An inactive product (products.is_archived = true) keeps its stock and its
-- full history. It is hidden from Stock In and Record Sale pickers and cannot
-- be sold or restocked until it is reactivated. Admin only; audit-logged.
-- ============================================================================
create or replace function public.set_product_active(p_id bigint, p_active boolean)
returns public.products
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.products;
begin
  perform public.require_role('admin');
  if p_active is null then
    raise exception 'Specify whether the product should be active.' using errcode = '22023';
  end if;

  update public.products
     set is_archived = not p_active
   where id = p_id
   returning * into v_row;
  if v_row.id is null then
    raise exception 'Product not found.' using errcode = 'P0002';
  end if;

  perform public.log_activity(
    case when p_active then 'product_reactivated' else 'product_deactivated' end,
    'products', v_row.id::text,
    format('%s product: %s', case when p_active then 'Reactivated' else 'Deactivated' end, v_row.name),
    jsonb_build_object('current_stock', v_row.current_stock));
  return v_row;
end
$$;

revoke execute on function public.set_product_active(bigint, boolean) from public, anon;
grant execute on function public.set_product_active(bigint, boolean) to authenticated, service_role;
