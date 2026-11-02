export type AppRole = 'owner' | 'admin' | 'staff';

export type MovementType = 'stock_in' | 'sale' | 'damaged' | 'lost' | 'other_out' | 'adjustment' | 'reclassify';

export interface Profile {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  role: AppRole;
  is_active: boolean;
  can_add_products: boolean;
  must_change_password: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface Category {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export type StockStatus = 'ok' | 'low' | 'out';

export interface ProductRow {
  id: number;
  sku: string;
  name: string;
  category_id: number;
  category_name: string;
  description: string | null;
  unit: string;
  purchase_price: number;
  selling_price: number;
  current_stock: number;
  min_stock_level: number;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  stock_status: StockStatus;
  stock_value: number;
}

export interface Customer {
  id: number;
  full_name: string;
  contact_number: string | null;
  email: string | null;
  address: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  sale_count?: number;
  total_quantity?: number;
  total_amount?: number;
  last_purchase_at?: string | null;
}

export interface Supplier {
  id: number;
  name: string;
  contact_person: string | null;
  contact_number: string | null;
  email: string | null;
  address: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  delivery_count?: number;
  total_quantity?: number;
  total_cost?: number;
  last_delivery_at?: string | null;
}

export interface StockMovement {
  id: number;
  movement_type: MovementType;
  product_id: number;
  product_name: string;
  product_sku: string;
  category_id: number;
  category_name: string;
  quantity_change: number;
  quantity_before: number;
  quantity_after: number;
  unit_cost: number | null;
  unit_price: number | null;
  supplier_id: number | null;
  supplier_name?: string | null;
  customer_id: number | null;
  customer_name?: string | null;
  sale_id: number | null;
  reverses_movement_id: number | null;
  reversed_by_id?: number | null;
  reference_no: string | null;
  reason: string | null;
  occurred_at: string;
  created_by_name: string;
  total_count?: number;
}

export interface Sale {
  id: number;
  reference_no: string;
  customer_id: number | null;
  customer_name: string | null;
  sold_at: string;
  item_count: number;
  total_quantity: number;
  total_amount: number;
  notes: string | null;
  created_by_name: string;
}

export interface SaleItem {
  id: number;
  sale_id: number;
  product_id: number;
  product_name: string;
  product_sku: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export interface PeriodSummaryRow {
  period_start: string;
  period_end: string;
  beginning_stock: number;
  stock_in: number;
  stock_sold: number;
  other_out: number;
  adjustments: number;
  ending_stock: number;
  movement_count: number;
}

export interface BreakdownRow {
  group_id: number;
  group_name: string;
  sku: string | null;
  category_name: string | null;
  unit: string | null;
  beginning_stock: number;
  stock_in: number;
  stock_sold: number;
  other_out: number;
  adjustments: number;
  ending_stock: number;
  movement_count: number;
}

export interface ActivityLog {
  id: number;
  user_id: string | null;
  user_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface DashboardStats {
  today: string;
  timezone: string;
  total_products: number;
  total_quantity: number;
  low_stock: number;
  out_of_stock: number;
  total_customers: number;
  total_suppliers: number;
  total_categories: number;
  inventory_cost_value: number;
  inventory_retail_value: number;
  today_summary: PeriodSummaryRow;
  month_summary: { stock_in: number; stock_sold: number; other_out: number; adjustments: number };
  all_time: { stock_in: number; stock_sold: number; sales_amount: number };
  month_sales_amount: number;
  trend: PeriodSummaryRow[];
  category_distribution: { id: number; name: string; products: number; quantity: number }[];
  stock_alerts: {
    id: number;
    name: string;
    sku: string;
    current_stock: number;
    min_stock_level: number;
    unit: string;
    status: 'low' | 'out';
  }[];
  top_stock: { id: number; name: string; current_stock: number; min_stock_level: number }[];
}

export interface StoreSettings {
  store_name: string;
  store_address: string;
  store_contact: string;
  currency: string;
  timezone: string;
  default_min_stock: number;
}
