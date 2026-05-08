export interface User {
  id: number;
  name: string;
  email: string;
  role: "admin" | "warehouse" | "accountant" | "owner_mobile";
  created_at?: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

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
  category_id: number;
  category?: Category;
  category_name_bg?: string;
  category_name_en?: string;
  unit: string;
  description?: string;
  image_url?: string;
  created_at: string;
  stock_quantity?: number;
  total_stock?: number | string;
  low_stock_threshold?: number;
  brand?: string;
  purchase_price?: number;
  selling_price?: number;
  retail_price?: number;
  price_group_1?: number;
  price_group_2?: number;
  price_group_3?: number;
  price_group_4?: number;
  price_group_5?: number;
  price_group_6?: number;
  price_group_7?: number;
  price_group_8?: number;
}

export interface InventoryItem {
  product_id: number;
  warehouse_id: number;
  quantity: number;
  product?: Product;
}

export interface StockLevel {
  product_id: number;
  product_name?: string;
  name_bg?: string;
  name_en?: string;
  sku: string;
  unit: string;
  total_quantity: number;
  total_stock?: number | string;
  low_stock_threshold?: number;
  selling_price?: number | string;
  purchase_price?: number | string;
  category_name_bg?: string;
  category_name_en?: string;
}

export interface Supplier {
  id: number;
  name: string;
  eik: string;
  vat_number?: string;
  city?: string;
  address?: string;
  contact_person?: string;
  phone?: string;
  email?: string;
  microinvest_code?: string;
  print_name?: string;
  fax?: string;
  bank_name?: string;
  bic?: string;
  iban?: string;
  vat_account?: string;
  group_name?: string;
  client_type?: string;
  price_group?: string;
  discount_percent?: number;
  card_number?: string;
  payment_days?: number;
}

export interface Partner {
  id: number;
  name: string;
  eik: string;
  vat_number?: string;
  address?: string;
  contact_person?: string;
  phone?: string;
  email?: string;
  price_list_id?: number;
  microinvest_code?: string;
  city?: string;
  partner_type?: string;
  print_name?: string;
  client_type?: string;
  price_group?: string;
  discount_percent?: number;
  bank_name?: string;
  bic?: string;
  iban?: string;
  category?: string;
}

export interface PriceList {
  id: number;
  name: string;
  description?: string;
}

export interface PriceListItem {
  id: number;
  price_list_id: number;
  product_id: number;
  price: number;
  product?: Product;
}

export interface PartnerOrderObject {
  id: number;
  partner_id: number;
  object_name: string;
  object_code?: string | null;
  usage_count?: number;
  last_used_at?: string | null;
}

export interface IncomingGoods {
  id: number;
  supplier_id: number;
  supplier_name?: string;
  invoice_number: string;
  invoice_date: string;
  document_type: string;
  scanned_file_path?: string;
  status: "draft" | "pending" | "received" | "confirmed" | "cancelled";
  total_amount?: number;
  created_at: string;
  supplier?: Supplier;
  items?: IncomingItem[];
}

export interface IncomingItem {
  id: number;
  incoming_goods_id: number;
  product_id: number;
  quantity: number;
  unit_price: number;
  total_price: number;
  product?: Product;
}

export interface Order {
  id: number;
  order_number?: number;
  partner_id: number;
  status:
    | "pending"
    | "confirmed"
    | "processing"
    | "fulfilled"
    | "cancelled"
    | "invoiced"
    | "quoted";
  order_date: string;
  delivery_date?: string;
  total_amount: number;
  notes?: string;
  request_number?: string | null;
  partner_object_id?: number | null;
  object_name?: string | null;
  object_code?: string | null;
  source: "manual" | "comarch" | "web";
  invoice_id?: number;
  invoice_number?: string | null;
  invoice_date?: string | null;
  annulled_invoice_id?: number | null;
  annulled_invoice_number?: string | null;
  annulled_invoice_at?: string | null;
  annulled_invoice_reason?: string | null;
  invoice_status?: "active" | "cancelled" | null;
  credit_note_id?: number | null;
  credit_note_number?: string | null;
  stock_dispatch_number?: string | null;
  commercial_document_number?: string | null;
  warranty_number?: string | null;
  warranty_issued_at?: string | null;
  dispatched_to_warehouse_at?: string | null;
  invoiced?: boolean;
  item_count?: number;
  partner?: Partner;
  partner_name?: string;
  items?: OrderItem[];
  // Below-cost approval audit. Populated by POST/PUT /orders when an
  // admin override is used; read by drawer banner + orders-list chip.
  below_cost_approved_at?: string | null;
  below_cost_approved_by?: string | null;
  below_cost_approved_by_name?: string | null;
  below_cost_details?: Array<{
    product_id: number;
    product_name: string;
    quantity: number;
    unit_price: number;
    discount_percent: number;
    effective_price: number;
    purchase_price: number;
    loss_per_unit: number;
  }> | null;
  stock_warnings?: string[];
  receipt_printed?: boolean;
  receipt_printed_at?: string;
  invoice_include_vat?: boolean;
  econt_receiver_name?: string | null;
  econt_receiver_phone?: string | null;
  econt_delivery_type?: "office" | "address" | null;
  econt_city?: string | null;
  econt_office_code?: string | null;
  econt_office_name?: string | null;
  econt_street?: string | null;
  econt_street_num?: string | null;
  econt_cod_amount?: number | null;
  econt_weight?: number | null;
  econt_shipping_cost?: number | null;
  econt_payer?: "sender" | "receiver" | null;
  econt_shipment_description?: string | null;
  econt_shipment_date?: string | null;
  econt_shipment_number?: string | null;
  econt_tracking_url?: string | null;
  econt_pdf_url?: string | null;
  // Product replacement — true when this order is a replacement (mixed
  // give/return items). Backend computes total as |give − return|.
  is_replacement?: boolean;
  // Search by article — populated by GET /orders?article=...
  matched_items?: Array<{
    name_bg: string;
    sku: string | null;
  }>;
  // Sum of all payments tied to this order (or its invoice). Populated by
  // GET /orders endpoint via LEFT JOIN LATERAL on payments. Used to drive
  // razpiska payment-status badges (paid / partial / unpaid).
  paid_amount?: number;
  paid_cod_amount?: number;
  has_cod_shipment?: boolean;
  // Effective receiver — when invoice is issued to a different (legal)
  // partner, this is that partner's name; otherwise the order's partner.
  invoice_partner_name?: string | null;
}

export interface OrderItem {
  id: number;
  order_id: number;
  product_id: number;
  quantity: number;
  unit_price: number;
  total_price: number;
  product?: Product;
  name_bg?: string;
  name_en?: string;
  sku?: string;
  unit?: string;
  // Batch F1 — per-line state. Backend defaults to 'normal' so older
  // payloads stay backward-compatible.
  line_status?: "normal" | "paid_not_taken" | "awaiting";
  // Product replacement — true when this line is being returned by the
  // customer (negative direction), false/unset for normal "give" lines.
  is_returning?: boolean;
}

export interface Invoice {
  id: number;
  order_id: number;
  invoice_number: string;
  invoice_date: string;
  partner_id: number;
  total_net: number;
  total_vat: number;
  total_gross: number;
  include_vat?: boolean;
  payment_method?: "cash" | "bank" | "cod";
  document_type?: "invoice" | "credit_note";
  related_invoice_id?: number;
  related_invoice_number?: string | null;
  credit_note_id?: number | null;
  credit_note_number?: string | null;
  credit_note_reason?: string;
  pdf_path?: string;
  sent_at?: string;
  status?: "active" | "cancelled";
  cancelled_at?: string;
  cancel_reason?: string;
  cancelled_by?: string;
  partner?: Partner;
  partner_name?: string;
  payment_status?: "paid" | "unpaid" | "partial" | "cancelled";
  paid_amount?: number;
  remaining?: number;
}

export interface Payment {
  id: number;
  invoice_id?: number | null;
  order_id?: number | null;
  amount: number;
  payment_method: "cash" | "bank" | "pos" | "cod";
  paid_at: string;
  bank_reference?: string;
  matched_by_agent?: boolean;
  invoice?: Invoice;
  invoice_number?: string;
  partner_name?: string;
  invoice_total_gross?: number | string;
  invoice_paid_total?: number | string;
  order_number?: number;
  order_total?: number | string;
  order_paid_total?: number | string;
  invoice_status?: "active" | "cancelled" | null;
  order_status?:
    | "pending"
    | "confirmed"
    | "processing"
    | "fulfilled"
    | "cancelled"
    | "invoiced"
    | null;
}

export interface Notification {
  id: number;
  type: string;
  message: string;
  read: boolean;
  created_at: string;
}

export interface DashboardKPIs {
  total_stock_value: number;
  todays_orders: number;
  low_stock_count: number;
  pending_payments: number;
}

export interface SalesData {
  period: string;
  amount: number;
  orders: number;
}

export interface TopProduct {
  product_id: number;
  product_name: string;
  total_sold: number;
  total_revenue: number;
}

export interface StockForecast {
  product_id: number;
  product_name: string;
  current_stock: number;
  predicted_depletion_date: string;
  daily_usage: number;
}

export interface ScannedInvoiceItem {
  row_number?: number | null;
  page_number?: number | null;
  name: string;
  name_en?: string;
  name_bg?: string;
  product_name?: string;
  product_name_raw?: string | null;
  product_code?: string | null;
  product_code_raw?: string | null;
  quantity: number;
  unit: string;
  price: number;
  unit_price?: number;
  notes_raw?: string | null;
  total?: number | null;
  brand?: string | null;
  category_hint?: string | null;
  product_id?: number | null;
  matched_product_id?: number | null;
  matched_product_name?: string | null;
  matched_product_sku?: string | null;
  match_confidence?: number | null;
  match_source?: string | null;
  suggestions?: Array<Record<string, any>>;
  selling_price?: number | null;
  matched_purchase_price?: number | null;
  matched_selling_price?: number | null;
  gross_price?: number | null;
  discount_percent?: number | null;
  discount_amount?: number | null;
}

export interface ScannedInvoice {
  supplier_name?: string | null;
  supplier_eik?: string | null;
  supplier_vat?: string | null;
  supplier_address?: string | null;
  supplier_phone?: string | null;
  supplier_email?: string | null;
  supplier_contact?: string | null;
  invoice_number?: string | null;
  invoice_date?: string | null;
  document_type?: string | null;
  total?: number | null;
  currency?: string;
  scanned_file_path?: string;
  visible_row_count?: number | null;
  extracted_row_count?: number | null;
  completeness_status?: "complete" | "suspicious" | "incomplete" | null;
  warnings?: string[];
  needs_review?: boolean;
  duplicate_invoice?: {
    duplicate: boolean;
    existing_id?: number;
    status?: string;
    created_at?: string;
    message?: string;
  } | null;
  items: ScannedInvoiceItem[];
}
