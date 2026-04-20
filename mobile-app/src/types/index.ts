// ─── Auth ────────────────────────────────────────────────────────────────────
export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface User {
  id: number;
  name: string;
  email: string;
  role: "admin" | "warehouse" | "accountant" | "readonly";
}

// ─── Products / Inventory ─────────────────────────────────────────────────────
export interface Category {
  id: number;
  name_bg: string;
  name_en: string;
}

export interface Product {
  id: number;
  name_bg: string;
  name_en: string;
  sku: string;
  unit: string;
  category_id: number;
  category?: Category;
  image_url?: string;
}

export interface InventoryItem {
  product_id: number;
  // Flat fields from API (no nested product object)
  name_bg: string;
  name_en?: string;
  sku: string;
  unit: string;
  low_stock_threshold: number | string;
  total_stock: number | string;
  category_name_bg?: string;
  // Legacy nested (for backward compat)
  product?: Product;
  total_quantity?: number;
  batches?: BatchStock[];
}

export interface BatchStock {
  batch_id: number;
  batch_number: string;
  expiry_date: string;
  quantity: number;
  warehouse_id: number;
}

export interface ExpiringBatchItem {
  batch_id: number;
  batch_number: string;
  expiry_date: string;
  product_id: number;
  name_bg: string;
  name_en?: string;
  sku: string;
  quantity: number;
  unit?: string;
  days_until_expiry: number;
}

// ─── Orders ──────────────────────────────────────────────────────────────────
export type OrderStatus =
  | "pending"
  | "processing"
  | "fulfilled"
  | "cancelled"
  | "invoiced";

export interface Order {
  id: number;
  partner_id: number;
  partner?: Partner;
  status: OrderStatus;
  order_date: string;
  delivery_date?: string;
  total_amount: number;
  notes?: string;
  source: "manual" | "comarch" | "web";
  invoice_id?: number;
  items?: OrderItem[];
}

export interface OrderItem {
  id: number;
  order_id: number;
  product_id: number;
  product?: Product;
  batch_id?: number;
  quantity: number;
  unit_price: number;
  total_price: number;
}

// ─── Incoming Goods ───────────────────────────────────────────────────────────
export type IncomingGoodsStatus =
  | "pending"
  | "received"
  | "confirmed"
  | "cancelled";

export interface IncomingGoodsItem {
  product_id: number;
  quantity: number;
  unit_price: number;
}

export interface IncomingGoodsDetailItem {
  id: number;
  product_id: number;
  quantity: string | number;
  unit_price: string | number;
  total_price?: string | number;
  name_bg?: string;
  name_en?: string;
  sku?: string;
  unit?: string;
  batch_number?: string;
  expiry_date?: string;
  discount_percent?: number;
  discount_amount?: number;
  product?: Product;
}

export interface IncomingGoods {
  id: number;
  supplier_id?: number;
  supplier_name?: string;
  supplier?: Partner;
  invoice_number: string;
  invoice_date: string;
  status: IncomingGoodsStatus;
  currency?: string | null;
  total_price?: string | number | null;
  item_count?: number;
  items?: IncomingGoodsDetailItem[];
  received_at?: string;
  confirmed_at?: string;
  created_at: string;
}

export interface CreateIncomingGoodsRequest {
  supplier_id: number;
  invoice_number: string;
  invoice_date: string;
  items: IncomingGoodsItem[];
}

// ─── Partners / Suppliers ─────────────────────────────────────────────────────
export interface Partner {
  id: number;
  name: string;
  eik: string;
  contact_person?: string;
  phone?: string;
  email?: string;
}

// ─── Invoices & Payments ─────────────────────────────────────────────────────
export interface Invoice {
  id: number;
  order_id: number;
  invoice_number: string;
  invoice_date: string;
  partner_id: number;
  partner?: Partner;
  total_net: number;
  total_vat: number;
  total_gross: number;
  pdf_path?: string;
  sent_at?: string;
}

export interface Payment {
  id: number;
  invoice_id: number;
  amount: number;
  payment_method: "cash" | "bank" | "card";
  paid_at: string;
}

// ─── Analytics ────────────────────────────────────────────────────────────────
export type SalesPeriod = "today" | "week" | "month" | "custom";

export interface SalesData {
  period: string;
  total_amount: number;
  order_count: number;
}

export interface TopProduct {
  product_id: number;
  product_name: string;
  total_sold: number;
  total_amount: number;
  unit: string;
}

export interface SalesAnalytics {
  series: SalesData[];
  top_products: TopProduct[];
  total_revenue: number;
  total_orders: number;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
export interface DashboardKPI {
  today_orders: number;
  today_revenue: number;
  total_stock_value: number;
  low_stock_count: number;
  pending_payments: number;
  pending_payments_amount: number;
  expiring_soon_count: number;
}

// ─── Notifications ────────────────────────────────────────────────────────────
export type NotificationType =
  | "low_stock"
  | "expiring"
  | "payment"
  | "order"
  | "system";

export interface AppNotification {
  id: string;
  type: NotificationType;
  title?: string;
  message: string;
  severity?: string;
  read: boolean;
  created_at: string;
}

// ─── Reports ──────────────────────────────────────────────────────────────────
export interface DailyReport {
  date: string;
  total_orders: number;
  total_revenue: number;
  total_items_sold: number;
  new_stock_received: number;
  payments_collected: number;
  low_stock_alerts: number;
}

export interface MonthlyReport {
  month: string;
  year: number;
  total_orders: number;
  total_revenue: number;
  top_products: TopProduct[];
  avg_daily_revenue: number;
  payments_collected: number;
}

// ─── API Response ─────────────────────────────────────────────────────────────
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}
