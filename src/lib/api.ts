import { supabase } from './supabase';
import { edgeError } from './errors';
import { ilikeOr } from './search';
import type {
  ActivityLog,
  BreakdownRow,
  Category,
  Customer,
  DashboardStats,
  MovementType,
  PeriodSummaryRow,
  ProductRow,
  Profile,
  Sale,
  SaleItem,
  StockMovement,
  StoreSettings,
  Supplier,
} from './types';

export const PAGE_SIZE = 20;

export interface Page<T> {
  rows: T[];
  total: number;
}

function range(page: number, size = PAGE_SIZE): [number, number] {
  const from = Math.max(0, (page - 1) * size);
  return [from, from + size - 1];
}

function unwrap<T>(res: { data: T | null; error: unknown }): T {
  if (res.error) throw res.error;
  return res.data as T;
}

function nn<T extends Record<string, unknown>>(obj: T): T {
  // empty strings -> null so optional DB columns stay NULL
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'string' && v.trim() === '' ? null : v;
  return out as T;
}

/** Calls an INVPORTIQ Edge Function and surfaces its JSON error message. */
export async function invokeFunction<T = { ok: boolean }>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    const info = await edgeError(error);
    const err = new Error(info.error ?? 'Request failed.') as Error & { code?: string; info?: unknown };
    err.code = info.code;
    err.info = info;
    throw err;
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Setup, settings & profile
// ---------------------------------------------------------------------------
export async function getSetupStatus(): Promise<{ setup_required: boolean; store_name: string }> {
  return unwrap(await supabase.rpc('setup_status'));
}

export async function fetchSettings(): Promise<StoreSettings> {
  const rows = unwrap(await supabase.from('system_settings').select('key, value')) as { key: string; value: unknown }[];
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    store_name: String(map.store_name ?? 'Bill Store'),
    store_address: String(map.store_address ?? ''),
    store_contact: String(map.store_contact ?? ''),
    currency: String(map.currency ?? 'PHP'),
    timezone: String(map.timezone ?? 'Asia/Manila'),
    default_min_stock: Number(map.default_min_stock ?? 10),
  };
}

export async function updateSetting(key: keyof StoreSettings, value: string | number) {
  return unwrap(await supabase.rpc('update_setting', { p_key: key, p_value: value }));
}

export async function fetchProfile(id: string): Promise<Profile | null> {
  return unwrap(await supabase.from('profiles').select('*').eq('id', id).maybeSingle());
}

export async function updateMyProfile(full_name: string, phone: string) {
  return unwrap(await supabase.rpc('update_my_profile', { p_full_name: full_name, p_phone: phone }));
}

// ---------------------------------------------------------------------------
// Users (admin)
// ---------------------------------------------------------------------------
export async function listUsers(params: { search?: string; page: number }): Promise<Page<Profile>> {
  let q = supabase.from('profiles').select('*', { count: 'exact' }).order('created_at', { ascending: false });
  const or = params.search ? ilikeOr(['full_name', 'email'], params.search) : null;
  if (or) q = q.or(or);
  const [a, b] = range(params.page);
  const res = await q.range(a, b);
  return { rows: unwrap(res) ?? [], total: res.count ?? 0 };
}

export type AdminUserAction =
  | { action: 'create'; email: string; full_name: string; phone?: string; role: 'owner' | 'staff'; password: string; can_add_products: boolean; must_change_password: boolean }
  | { action: 'update'; user_id: string; full_name: string; phone?: string; role?: 'owner' | 'staff' | 'admin'; can_add_products?: boolean }
  | { action: 'set_active'; user_id: string; active: boolean }
  | { action: 'reset_password'; user_id: string; new_password: string };

export function adminUsers(payload: AdminUserAction) {
  return invokeFunction('admin-users', payload as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
export type CategoryWithCount = Category & { products: { count: number }[] };

export async function listCategories(): Promise<CategoryWithCount[]> {
  return unwrap(await supabase.from('categories').select('*, products(count)').order('created_at', { ascending: false }).order('id', { ascending: false }));
}

export async function saveCategory(input: { id?: number; name: string; description?: string }) {
  const payload = nn({ name: input.name.trim(), description: input.description ?? '' });
  if (input.id) return unwrap(await supabase.from('categories').update(payload).eq('id', input.id).select().single());
  return unwrap(await supabase.from('categories').insert(payload).select().single());
}

export async function deleteCategory(id: number) {
  return unwrap(await supabase.rpc('delete_category', { p_id: id }));
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
export interface ProductQuery {
  search?: string;
  categoryId?: number | null;
  status?: 'all' | 'ok' | 'low' | 'out';
  archived?: boolean;
  page: number;
  pageSize?: number;
}

export async function listProducts(p: ProductQuery): Promise<Page<ProductRow>> {
  // Newest products first (creation timestamp, descending).
  let q = supabase
    .from('product_overview')
    .select('*', { count: 'exact' })
    .eq('is_archived', Boolean(p.archived))
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });
  const or = p.search ? ilikeOr(['name', 'sku', 'category_name'], p.search) : null;
  if (or) q = q.or(or);
  if (p.categoryId) q = q.eq('category_id', p.categoryId);
  if (p.status && p.status !== 'all') q = q.eq('stock_status', p.status);
  const [a, b] = range(p.page, p.pageSize);
  const res = await q.range(a, b);
  return { rows: unwrap(res) ?? [], total: res.count ?? 0 };
}

export async function listAllProducts(opts: { categoryId?: number | null; includeArchived?: boolean } = {}): Promise<ProductRow[]> {
  let q = supabase.from('product_overview').select('*').order('created_at', { ascending: false }).order('id', { ascending: false });
  if (!opts.includeArchived) q = q.eq('is_archived', false);
  if (opts.categoryId) q = q.eq('category_id', opts.categoryId);
  return unwrap(await q.limit(5000));
}

export interface ProductInput {
  sku: string;
  name: string;
  category_id: number;
  unit: string;
  purchase_price: number;
  selling_price: number;
  min_stock_level: number;
  description?: string;
  opening_stock?: number;
  supplier_id?: number | null;
}

export async function createProduct(i: ProductInput) {
  return unwrap(
    await supabase.rpc('create_product', {
      p_sku: i.sku,
      p_name: i.name,
      p_category_id: i.category_id,
      p_unit: i.unit,
      p_purchase_price: i.purchase_price,
      p_selling_price: i.selling_price,
      p_min_stock_level: i.min_stock_level,
      p_description: i.description ?? null,
      p_opening_stock: i.opening_stock ?? 0,
      p_supplier_id: i.supplier_id ?? null,
    }),
  );
}

export async function updateProduct(id: number, i: ProductInput) {
  return unwrap(
    await supabase.rpc('update_product', {
      p_id: id,
      p_sku: i.sku,
      p_name: i.name,
      p_category_id: i.category_id,
      p_unit: i.unit,
      p_purchase_price: i.purchase_price,
      p_selling_price: i.selling_price,
      p_min_stock_level: i.min_stock_level,
      p_description: i.description ?? null,
    }),
  );
}

export async function deleteProduct(id: number): Promise<'deleted' | 'archived'> {
  return unwrap(await supabase.rpc('delete_product', { p_id: id }));
}

/** Deactivate (hide from sales & stock-in, keep stock and history) or reactivate a product. Admin only. */
export async function setProductActive(id: number, active: boolean) {
  return unwrap(await supabase.rpc('set_product_active', { p_id: id, p_active: active }));
}

export async function restoreProduct(id: number) {
  return unwrap(await supabase.rpc('restore_product', { p_id: id }));
}

// ---------------------------------------------------------------------------
// Customers & suppliers
// ---------------------------------------------------------------------------
export async function listCustomers(p: { search?: string; page: number; archived?: boolean; pageSize?: number }): Promise<Page<Customer>> {
  let q = supabase
    .from('customer_overview')
    .select('*', { count: 'exact' })
    .eq('is_archived', Boolean(p.archived))
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });
  const or = p.search ? ilikeOr(['full_name', 'contact_number', 'email', 'address'], p.search) : null;
  if (or) q = q.or(or);
  const [a, b] = range(p.page, p.pageSize);
  const res = await q.range(a, b);
  return { rows: unwrap(res) ?? [], total: res.count ?? 0 };
}

export async function listCustomerOptions(): Promise<Pick<Customer, 'id' | 'full_name'>[]> {
  return unwrap(await supabase.from('customers').select('id, full_name').eq('is_archived', false).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(5000));
}

export async function saveCustomer(input: Partial<Customer> & { full_name: string }) {
  const payload = nn({
    full_name: input.full_name.trim(),
    contact_number: input.contact_number ?? '',
    email: input.email ?? '',
    address: input.address ?? '',
  });
  if (input.id) return unwrap(await supabase.from('customers').update(payload).eq('id', input.id).select().single());
  return unwrap(await supabase.from('customers').insert(payload).select().single());
}

export async function deleteCustomer(id: number): Promise<'deleted' | 'archived'> {
  return unwrap(await supabase.rpc('delete_customer', { p_id: id }));
}

export async function restoreCustomer(id: number) {
  return unwrap(await supabase.from('customers').update({ is_archived: false }).eq('id', id).select().single());
}

export async function listSuppliers(p: { search?: string; page: number; archived?: boolean; pageSize?: number }): Promise<Page<Supplier>> {
  let q = supabase
    .from('supplier_overview')
    .select('*', { count: 'exact' })
    .eq('is_archived', Boolean(p.archived))
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });
  const or = p.search ? ilikeOr(['name', 'contact_person', 'contact_number', 'email', 'address'], p.search) : null;
  if (or) q = q.or(or);
  const [a, b] = range(p.page, p.pageSize);
  const res = await q.range(a, b);
  return { rows: unwrap(res) ?? [], total: res.count ?? 0 };
}

export async function listSupplierOptions(): Promise<Pick<Supplier, 'id' | 'name'>[]> {
  return unwrap(await supabase.from('suppliers').select('id, name').eq('is_archived', false).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(5000));
}

export async function saveSupplier(input: Partial<Supplier> & { name: string }) {
  const payload = nn({
    name: input.name.trim(),
    contact_person: input.contact_person ?? '',
    contact_number: input.contact_number ?? '',
    email: input.email ?? '',
    address: input.address ?? '',
  });
  if (input.id) return unwrap(await supabase.from('suppliers').update(payload).eq('id', input.id).select().single());
  return unwrap(await supabase.from('suppliers').insert(payload).select().single());
}

export async function deleteSupplier(id: number): Promise<'deleted' | 'archived'> {
  return unwrap(await supabase.rpc('delete_supplier', { p_id: id }));
}

export async function restoreSupplier(id: number) {
  return unwrap(await supabase.from('suppliers').update({ is_archived: false }).eq('id', id).select().single());
}

export async function customerSales(customerId: number): Promise<Sale[]> {
  return unwrap(
    await supabase.from('sales').select('*').eq('customer_id', customerId).order('sold_at', { ascending: false }).limit(200),
  );
}

export async function supplierDeliveries(supplierId: number): Promise<StockMovement[]> {
  return unwrap(
    await supabase
      .from('stock_movements')
      .select('*')
      .eq('supplier_id', supplierId)
      .order('occurred_at', { ascending: false })
      .limit(200),
  );
}

// ---------------------------------------------------------------------------
// Stock operations (all transactional RPCs)
// ---------------------------------------------------------------------------
export async function recordStockIn(i: {
  product_id: number;
  quantity: number;
  supplier_id?: number | null;
  reference_no?: string;
  reason?: string;
  unit_cost?: number | null;
}) {
  return unwrap(
    await supabase.rpc('record_stock_in', {
      p_product_id: i.product_id,
      p_quantity: i.quantity,
      p_supplier_id: i.supplier_id ?? null,
      p_reference_no: i.reference_no ?? null,
      p_reason: i.reason ?? null,
      p_unit_cost: i.unit_cost ?? null,
    }),
  ) as StockMovement;
}

export async function recordStockOut(i: {
  product_id: number;
  quantity: number;
  movement_type: Extract<MovementType, 'damaged' | 'lost' | 'other_out'>;
  customer_id?: number | null;
  reference_no?: string;
  reason: string;
}) {
  return unwrap(
    await supabase.rpc('record_stock_out', {
      p_product_id: i.product_id,
      p_quantity: i.quantity,
      p_movement_type: i.movement_type,
      p_customer_id: i.customer_id ?? null,
      p_reference_no: i.reference_no ?? null,
      p_reason: i.reason,
    }),
  ) as StockMovement;
}

export async function recordSale(i: {
  items: { product_id: number; quantity: number }[];
  customer_id?: number | null;
  reference_no?: string;
  notes?: string;
  client_request_id: string;
}) {
  return unwrap(
    await supabase.rpc('record_sale', {
      p_items: i.items,
      p_customer_id: i.customer_id ?? null,
      p_reference_no: i.reference_no ?? null,
      p_notes: i.notes ?? null,
      p_client_request_id: i.client_request_id,
    }),
  ) as Sale;
}

export async function recordAdjustment(i: { product_id: number; reason: string; new_quantity?: number | null; change?: number | null; reference_no?: string }) {
  return unwrap(
    await supabase.rpc('record_adjustment', {
      p_product_id: i.product_id,
      p_reason: i.reason,
      p_new_quantity: i.new_quantity ?? null,
      p_change: i.change ?? null,
      p_reference_no: i.reference_no ?? null,
    }),
  ) as StockMovement;
}

export async function reverseMovement(id: number, reason: string) {
  return unwrap(await supabase.rpc('reverse_movement', { p_movement_id: id, p_reason: reason })) as StockMovement;
}

export async function listSales(p: { page: number; search?: string }): Promise<Page<Sale>> {
  let q = supabase.from('sales').select('*', { count: 'exact' }).order('sold_at', { ascending: false }).order('id', { ascending: false });
  const or = p.search ? ilikeOr(['reference_no', 'customer_name', 'created_by_name'], p.search) : null;
  if (or) q = q.or(or);
  const [a, b] = range(p.page);
  const res = await q.range(a, b);
  return { rows: unwrap(res) ?? [], total: res.count ?? 0 };
}

export async function saleItems(saleId: number): Promise<SaleItem[]> {
  return unwrap(await supabase.from('sale_items').select('*').eq('sale_id', saleId).order('id'));
}

// ---------------------------------------------------------------------------
// Stock movement reporting
// ---------------------------------------------------------------------------
export interface MovementFilter {
  from: string;
  to: string;
  categoryId?: number | null;
  productId?: number | null;
}

export async function movementSummary(f: MovementFilter & { bucket: 'day' | 'month' }): Promise<PeriodSummaryRow[]> {
  return unwrap(
    await supabase.rpc('stock_movement_summary', {
      p_from: f.from,
      p_to: f.to,
      p_bucket: f.bucket,
      p_category_id: f.categoryId ?? null,
      p_product_id: f.productId ?? null,
    }),
  );
}

export async function movementBreakdown(f: MovementFilter & { group: 'product' | 'category' }): Promise<BreakdownRow[]> {
  const rows: BreakdownRow[] = unwrap(
    await supabase.rpc('stock_movement_breakdown', {
      p_from: f.from,
      p_to: f.to,
      p_group: f.group,
      p_category_id: f.categoryId ?? null,
      p_product_id: f.productId ?? null,
    }),
  );
  // Newest products / categories first (ids increase as records are created).
  return [...(rows ?? [])].sort((x, y) => y.group_id - x.group_id);
}

export async function listMovements(
  f: MovementFilter & { types?: MovementType[]; search?: string; page: number; pageSize?: number },
): Promise<Page<StockMovement>> {
  const size = f.pageSize ?? PAGE_SIZE;
  const rows = unwrap(
    await supabase.rpc('list_movements', {
      p_from: f.from,
      p_to: f.to,
      p_category_id: f.categoryId ?? null,
      p_product_id: f.productId ?? null,
      p_types: f.types && f.types.length ? f.types : null,
      p_search: f.search?.trim() || null,
      p_limit: size,
      p_offset: (f.page - 1) * size,
    }),
  ) as StockMovement[];
  return { rows, total: rows[0]?.total_count ?? 0 };
}

// ---------------------------------------------------------------------------
// Dashboard & activity
// ---------------------------------------------------------------------------
export async function dashboardStats(days = 14): Promise<DashboardStats> {
  return unwrap(await supabase.rpc('dashboard_stats', { p_days: days }));
}

export async function recentMovements(limit = 8): Promise<StockMovement[]> {
  return unwrap(
    await supabase.from('stock_movements').select('*').order('occurred_at', { ascending: false }).order('id', { ascending: false }).limit(limit),
  );
}

export async function listActivity(p: { page: number; search?: string; userId?: string; pageSize?: number }): Promise<Page<ActivityLog>> {
  let q = supabase.from('activity_logs').select('*', { count: 'exact' }).order('created_at', { ascending: false }).order('id', { ascending: false });
  const or = p.search ? ilikeOr(['summary', 'user_name', 'action', 'entity_type'], p.search) : null;
  if (or) q = q.or(or);
  if (p.userId) q = q.eq('user_id', p.userId);
  const [a, b] = range(p.page, p.pageSize);
  const res = await q.range(a, b);
  return { rows: unwrap(res) ?? [], total: res.count ?? 0 };
}
