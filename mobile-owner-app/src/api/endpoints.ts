import apiClient from "./client";
import type {
  AuthResponse,
  DashboardKPI,
  IncomingGoods,
  LoginRequest,
  SalesAnalytics,
  SalesPeriod,
  User,
} from "../types";

const unwrap = <T>(r: any): T =>
  r.data?.data !== undefined ? r.data.data : r.data;

export const authApi = {
  login: (data: LoginRequest) =>
    apiClient.post<AuthResponse>("/auth/login", data).then((r) => r.data),

  me: () =>
    apiClient
      .get<{ user: User; permissions: string[] }>("/auth/me")
      .then((r) => r.data.user),

  logout: () => apiClient.post("/auth/logout").then((r) => r.data),
};

export const dashboardApi = {
  getKPI: async (): Promise<DashboardKPI> => {
    const [dashRes, lowStockRes, expiringRes] = await Promise.allSettled([
      apiClient.get("/analytics/dashboard"),
      apiClient.get("/inventory/low-stock"),
      apiClient.get("/inventory/expiring"),
    ]);

    const dash = dashRes.status === "fulfilled" ? dashRes.value.data : {};
    const lowStock =
      lowStockRes.status === "fulfilled"
        ? Array.isArray(lowStockRes.value.data)
          ? lowStockRes.value.data
          : lowStockRes.value.data?.data || []
        : [];
    const expiring =
      expiringRes.status === "fulfilled"
        ? Array.isArray(expiringRes.value.data)
          ? expiringRes.value.data
          : expiringRes.value.data?.data || []
        : [];

    return {
      today_orders: Number(dash.today_orders || 0),
      today_revenue: Number(dash.today_revenue || 0),
      total_stock_value: Number(dash.total_stock_value || 0),
      low_stock_count: lowStock.length,
      pending_payments: Number(dash.pending_payments || 0),
      pending_payments_amount: Number(dash.pending_payments_amount || 0),
      expiring_soon_count: expiring.length,
    };
  },
};

export const analyticsApi = {
  getSales: async (period: SalesPeriod): Promise<SalesAnalytics> => {
    const response = await apiClient.get("/analytics/sales", {
      params: { period },
    });
    const raw = response.data;
    const series = Array.isArray(raw.data) ? raw.data : [];
    return {
      series,
      top_products: raw.top_products || [],
      total_revenue: Number(raw.summary?.total_revenue || 0),
      total_orders: Number(raw.summary?.total_orders || 0),
    };
  },
};

export const incomingApi = {
  getList: (params: { status?: string; dateFrom: string; dateTo: string }) =>
    apiClient
      .get("/incoming", {
        params: {
          status: params.status,
          date_from: params.dateFrom,
          date_to: params.dateTo,
          limit: 100,
        },
      })
      .then((r) => unwrap<IncomingGoods[]>(r)),

  getById: (id: number) =>
    apiClient.get<IncomingGoods>(`/incoming/${id}`).then((r) => r.data),

  confirm: (id: number) =>
    apiClient.put(`/incoming/${id}/confirm`).then((r) => r.data),
};
