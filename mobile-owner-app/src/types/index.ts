export interface LoginRequest {
  email: string;
  password: string;
}

export interface User {
  id: number;
  name: string;
  email: string;
  role: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface DashboardKPI {
  today_orders: number;
  today_revenue: number;
  total_stock_value: number;
  low_stock_count: number;
  pending_payments: number;
  pending_payments_amount: number;
  expiring_soon_count: number;
}

export type SalesPeriod = "today" | "week" | "month";

export interface SalesDataPoint {
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
  series: SalesDataPoint[];
  top_products: TopProduct[];
  total_revenue: number;
  total_orders: number;
}

export type IncomingGoodsStatus =
  | "pending"
  | "received"
  | "confirmed"
  | "cancelled"
  | string;

export interface IncomingGoodsItem {
  id: number;
  product_id: number;
  quantity: number | string;
  unit_price: number | string;
  total_price?: number | string;
  name_bg?: string;
  name_en?: string;
  sku?: string;
  unit?: string;
  batch_number?: string;
  expiry_date?: string;
}

export interface IncomingGoods {
  id: number;
  supplier_name?: string;
  invoice_number?: string;
  invoice_date?: string;
  status: IncomingGoodsStatus;
  item_count?: number;
  total_amount?: number | string;
  currency?: string | null;
  created_at: string;
  items?: IncomingGoodsItem[];
}
