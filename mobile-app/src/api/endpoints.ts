import apiClient from "./client";
import type {
  AuthResponse,
  LoginRequest,
  DashboardKPI,
  SalesAnalytics,
  SalesPeriod,
  InventoryItem,
  ExpiringBatchItem,
  Order,
  AppNotification,
  DailyReport,
  MonthlyReport,
  User,
  IncomingGoods,
  CreateIncomingGoodsRequest,
  Partner,
  Product,
} from "../types";

// ─── Auth ─────────────────────────────────────────────────────────────────────
export const authApi = {
  login: (data: LoginRequest) =>
    apiClient.post<AuthResponse>("/auth/login", data).then((r) => r.data),

  me: () => apiClient.get<User>("/auth/me").then((r) => r.data),

  logout: () => apiClient.post("/auth/logout").then((r) => r.data),
};

// ─── Dashboard ────────────────────────────────────────────────────────────────
export const dashboardApi = {
  getKPI: async (): Promise<DashboardKPI> => {
    // Fetch dashboard + accurate counts from dedicated endpoints
    const [dashRes, lowStockRes, expiringRes] = await Promise.allSettled([
      apiClient.get("/analytics/dashboard"),
      apiClient.get("/inventory/low-stock"),
      apiClient.get("/inventory/expiring"),
    ]);
    const dash = dashRes.status === "fulfilled" ? dashRes.value.data : {};
    const lowStockArr =
      lowStockRes.status === "fulfilled"
        ? Array.isArray(lowStockRes.value.data)
          ? lowStockRes.value.data
          : lowStockRes.value.data?.data || []
        : [];
    const expiringArr =
      expiringRes.status === "fulfilled"
        ? Array.isArray(expiringRes.value.data)
          ? expiringRes.value.data
          : expiringRes.value.data?.data || []
        : [];
    return {
      today_orders: dash.today_orders || 0,
      today_revenue: dash.today_revenue || 0,
      total_stock_value: parseFloat(dash.total_stock_value) || 0,
      low_stock_count: lowStockArr.length,
      pending_payments: dash.pending_payments || 0,
      pending_payments_amount: parseFloat(dash.pending_payments_amount) || 0,
      expiring_soon_count: expiringArr.length,
    };
  },
};

// ─── Analytics ────────────────────────────────────────────────────────────────
export const analyticsApi = {
  getSales: (period: SalesPeriod, from?: string, to?: string) => {
    const params: Record<string, string> = { period };
    if (from) params.from = from;
    if (to) params.to = to;
    return apiClient.get("/analytics/sales", { params }).then((r) => {
      const d = r.data;
      // Merge {data: [...], summary: {...}} into flat SalesAnalytics shape
      return {
        series: d.data || [],
        total_revenue: d.summary?.total_revenue || 0,
        total_orders: d.summary?.total_orders || 0,
        top_products: d.top_products || [],
        ...d.summary,
      } as SalesAnalytics;
    });
  },

  getTopProducts: (period: SalesPeriod, limit = 10) =>
    apiClient
      .get("/analytics/top-products", { params: { period, limit } })
      .then(unwrap) as Promise<import("../types").TopProduct[]>,
};

// Helper: unwrap {data: [...]} envelope returned by the backend
const unwrap = (r: any): any =>
  r.data?.data !== undefined ? r.data.data : r.data;

// ─── Inventory ────────────────────────────────────────────────────────────────
export const inventoryApi = {
  getAll: () =>
    apiClient.get("/inventory").then(unwrap) as Promise<InventoryItem[]>,

  getLowStock: () =>
    apiClient.get("/inventory/low-stock").then(unwrap) as Promise<
      InventoryItem[]
    >,

  getExpiring: () =>
    apiClient.get("/inventory/expiring").then(unwrap) as Promise<
      ExpiringBatchItem[]
    >,
};

// ─── Orders ───────────────────────────────────────────────────────────────────
export const ordersApi = {
  getAll: (params?: { status?: string; limit?: number; page?: number }) =>
    apiClient.get("/orders", { params }).then(unwrap) as Promise<Order[]>,

  getById: (id: number) =>
    apiClient.get<Order>(`/orders/${id}`).then((r) => r.data),
};

// ─── Reports ──────────────────────────────────────────────────────────────────
export const reportsApi = {
  getDaily: (date?: string) =>
    apiClient
      .get<DailyReport>("/analytics/report/daily", {
        params: date ? { date } : undefined,
      })
      .then((r) => r.data),

  getMonthly: (year?: number, month?: number) =>
    apiClient
      .get<MonthlyReport>("/analytics/report/monthly", {
        params: { year, month },
      })
      .then((r) => r.data),
};

// ─── Notifications ────────────────────────────────────────────────────────────
export const notificationsApi = {
  getAll: () =>
    apiClient.get("/notifications").then(unwrap) as Promise<AppNotification[]>,

  markRead: (id: string | number) =>
    apiClient.put(`/notifications/${id}/read`).then((r) => r.data),
  readAll: (ids: string[]) =>
    apiClient.post("/notifications/read-all", { ids }).then((r) => r.data),
  dismiss: (id: string | number) =>
    apiClient.delete(`/notifications/${id}`).then((r) => r.data),
};

// ─── Incoming Goods ───────────────────────────────────────────────────────────
export const incomingGoodsApi = {
  getByDate: (dateFrom: string, dateTo: string) =>
    apiClient
      .get("/incoming", { params: { date_from: dateFrom, date_to: dateTo } })
      .then(unwrap) as Promise<IncomingGoods[]>,

  getById: (id: number) =>
    apiClient.get<IncomingGoods>(`/incoming/${id}`).then((r) => r.data),

  create: (data: CreateIncomingGoodsRequest | Record<string, any>) =>
    apiClient.post<IncomingGoods>("/incoming", data).then((r) => r.data),

  confirm: (id: number) =>
    apiClient.put<IncomingGoods>(`/incoming/${id}/confirm`).then((r) => r.data),

  getSuppliers: () =>
    apiClient.get("/suppliers").then(unwrap) as Promise<Partner[]>,

  getProducts: () =>
    apiClient.get("/products").then(unwrap) as Promise<Product[]>,
};
