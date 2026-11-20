/** 'owner' only exists on retired (deactivated) accounts. */
export type AppRole = 'owner' | 'admin' | 'cashier';

export type MovementType =
  | 'stock_in'
  | 'sale'
  | 'sale_void'
  | 'damaged'
  | 'expired'
  | 'lost'
  | 'internal_use'
  | 'other_out'
  | 'adjustment'
  | 'reclassify';

export type StockOutType = Extract<MovementType, 'damaged' | 'expired' | 'lost' | 'internal_use' | 'other_out'>;

export interface Profile {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  role: AppRole;
  /** cashier sign-in name */
  username?: string | null;
  is_active: boolean;
  can_add_products: boolean;
  must_change_password: boolean;
  /** set when an Admin deletes the account; recoverable for 7 days */
  deletion_scheduled_at?: string | null;
  /** set once the account has been permanently deleted */
  deleted_at?: string | null;
  /** small square profile photo (data URL) */
  avatar_url?: string | null;
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
  barcode: string | null;
  supplier_id: number | null;
  supplier_name: string | null;
  has_image: boolean;
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
  movement_no: string;
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

export type PaymentMethod = 'cash' | 'gcash' | 'maya' | 'card' | 'bank_transfer' | 'other';

export interface Sale {
  id: number;
  reference_no: string;
  invoice_no: string;
  customer_id?: number | null;
  customer_name: string | null;
  sold_at: string;
  item_count: number;
  total_quantity: number;
  subtotal: number;
  discount_amount: number;
  total_amount: number;
  payment_method: string;
  payment_reference: string | null;
  amount_received: number | null;
  change_amount: number;
  status: 'completed' | 'voided';
  payment_status: 'paid' | 'refunded';
  notes?: string | null;
  created_by?: string | null;
  created_by_name: string;
  voided_at: string | null;
  voided_by_name: string | null;
  void_reason: string | null;
  total_count?: number;
}

/** A product as returned by the POS search. */
export interface PosProduct {
  id: number;
  sku: string;
  barcode: string | null;
  name: string;
  category_id: number;
  category_name: string;
  unit: string;
  selling_price: number;
  current_stock: number;
  min_stock_level: number;
  image_url: string | null;
  total_count: number;
}

export interface SalesReport {
  from: string;
  to: string;
  totals: { transactions: number; items_sold: number; gross_sales: number; discounts: number; net_sales: number; average_sale: number };
  voided: { transactions: number; amount: number };
  by_cashier: { cashier_id: string | null; cashier_name: string; transactions: number; items_sold: number; net_sales: number }[];
  by_payment: { payment_method: string; transactions: number; net_sales: number }[];
  best_sellers: { product_id: number; product_name: string; product_sku: string; quantity: number; amount: number; transactions: number }[];
  by_day: { day: string; transactions: number; net_sales: number; items_sold: number }[];
  by_hour: { hour: number; transactions: number; net_sales: number }[];
  monthly_trend: { month: string; transactions: number; net_sales: number }[];
}

export interface StockReport {
  from: string;
  to: string;
  totals: {
    stock_in_qty: number;
    stock_in_count: number;
    stock_out_qty: number;
    stock_out_count: number;
    sales_qty: number;
    sales_count: number;
    returned_qty: number;
    returned_count: number;
    adjustment_net: number;
    adjustment_count: number;
    movements: number;
  };
  products_received: { product_id: number; product_name: string; product_sku: string; quantity: number; entries: number; cost: number }[];
  products_released: { product_id: number; product_name: string; product_sku: string; reason: MovementType; quantity: number; entries: number }[];
  by_day: { day: string; stock_in: number; stock_out: number; sold: number; returned: number; adjustments: number; movements: number }[];
  by_user: { user_name: string; movements: number; stock_in: number; stock_out: number; sold: number }[];
  monthly_trend: { month: string; stock_in: number; stock_out: number; sold: number }[];
}

export interface AdminDashboard {
  today: string;
  timezone: string;
  sales_today: { amount: number; transactions: number };
  sales_week: { amount: number; transactions: number };
  sales_month: { amount: number; transactions: number };
  total_transactions: number;
  total_products: number;
  total_quantity: number;
  low_stock: number;
  out_of_stock: number;
  stock_in_today: { quantity: number; entries: number };
  stock_out_today: { quantity: number; entries: number };
  daily_sales: { day: string; amount: number; transactions: number }[];
  weekly_sales: { week: string; amount: number; transactions: number }[];
  monthly_sales: { month: string; amount: number; transactions: number }[];
  best_sellers: { product_id: number; product_name: string; quantity: number; amount: number }[];
  recent_sales: Pick<Sale, 'id' | 'reference_no' | 'invoice_no' | 'sold_at' | 'total_amount' | 'payment_method' | 'status' | 'created_by_name'>[];
  recent_movements: { id: number; movement_no: string; movement_type: MovementType; product_name: string; quantity_change: number; quantity_after: number; occurred_at: string; created_by_name: string }[];
  cashier_activity: { id: number; user_name: string; action: string; summary: string; created_at: string }[];
  stock_alerts: DashboardStats['stock_alerts'];
}

export interface CashierDashboard {
  today: string;
  sales_today: { amount: number; transactions: number; items_sold: number };
  voided_today: number;
  by_payment: { payment_method: string; transactions: number; amount: number }[];
  available_products: number;
  low_stock: number;
  out_of_stock: number;
  recent_sales: Pick<Sale, 'id' | 'reference_no' | 'invoice_no' | 'sold_at' | 'total_amount' | 'payment_method' | 'status'>[];
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
  payment_methods: PaymentMethod[];
  cashier_max_discount_pct: number;
  invoice_footer: string;
  store_tin: string;
}
