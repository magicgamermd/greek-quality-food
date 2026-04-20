import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type OwnerSalesPeriod = "today" | "week" | "month";

export interface OwnerDashboardKPI {
  today_orders: number;
  today_revenue: number;
  total_stock_value: number;
  low_stock_count: number;
  pending_payments: number;
  pending_payments_amount: number;
}

export interface OwnerSalesPoint {
  period: string;
  total_amount: number;
  order_count: number;
}

export interface OwnerTopProduct {
  product_id: number;
  product_name: string;
  total_sold: number;
  total_amount: number;
  unit: string;
}

export interface OwnerSalesAnalytics {
  series: OwnerSalesPoint[];
  top_products: OwnerTopProduct[];
  total_revenue: number;
  total_orders: number;
}

export interface OwnerIncomingGoodsItem {
  id: number;
  product_id: number;
  quantity: number | string;
  unit_price: number | string;
  total_price?: number | string;
  name_bg?: string;
  name_en?: string;
  sku?: string;
  unit?: string;
}

export interface OwnerIncomingGoods {
  id: number;
  supplier_name?: string;
  invoice_number?: string;
  invoice_date?: string;
  status: string;
  item_count?: number;
  total_amount?: number | string;
  currency?: string | null;
  created_at: string;
  items?: OwnerIncomingGoodsItem[];
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const unwrap = <T>(payload: any): T =>
  payload?.data !== undefined ? payload.data : payload;

export function useOwnerDashboardKpi() {
  return useQuery({
    queryKey: ["owner", "kpi"],
    queryFn: async (): Promise<OwnerDashboardKPI> => {
      const [dashRes, lowStockRes] = await Promise.allSettled([
        api.get("/analytics/dashboard"),
        api.get("/inventory/low-stock"),
      ]);

      const dash = dashRes.status === "fulfilled" ? dashRes.value.data : {};
      const lowStock =
        lowStockRes.status === "fulfilled"
          ? Array.isArray(lowStockRes.value.data)
            ? lowStockRes.value.data
            : lowStockRes.value.data?.data || []
          : [];

      return {
        today_orders: asNumber(dash.today_orders),
        today_revenue: asNumber(dash.today_revenue),
        total_stock_value: asNumber(dash.total_stock_value),
        low_stock_count: lowStock.length,
        pending_payments: asNumber(dash.pending_payments),
        pending_payments_amount: asNumber(dash.pending_payments_amount),
      };
    },
    refetchInterval: 60_000,
  });
}

export function useOwnerSalesAnalytics(period: OwnerSalesPeriod) {
  return useQuery({
    queryKey: ["owner", "sales", period],
    queryFn: async (): Promise<OwnerSalesAnalytics> => {
      const response = await api.get("/analytics/sales", {
        params: { period },
      });
      const raw = response.data;
      const series = Array.isArray(raw?.data) ? raw.data : [];
      const topProducts = Array.isArray(raw?.top_products)
        ? raw.top_products
        : [];
      return {
        series: series.map((point: any) => ({
          period: String(point.period || ""),
          total_amount: asNumber(point.total_amount),
          order_count: asNumber(point.order_count),
        })),
        top_products: topProducts.map((product: any) => ({
          product_id: asNumber(product.product_id),
          product_name: String(product.product_name || "Продукт"),
          total_sold: asNumber(product.total_sold),
          total_amount: asNumber(product.total_amount),
          unit: String(product.unit || "бр."),
        })),
        total_revenue: asNumber(raw?.summary?.total_revenue),
        total_orders: asNumber(raw?.summary?.total_orders),
      };
    },
  });
}

export function useOwnerIncomingGoods(params: {
  status?: string;
  dateFrom: string;
  dateTo: string;
}) {
  return useQuery({
    queryKey: ["owner", "incoming", params],
    queryFn: () =>
      api
        .get("/incoming", {
          params: {
            status: params.status,
            date_from: params.dateFrom,
            date_to: params.dateTo,
            limit: 100,
          },
        })
        .then((r) => unwrap<OwnerIncomingGoods[]>(r.data)),
  });
}

export function useOwnerIncomingGoodsById(id: number | null) {
  return useQuery({
    queryKey: ["owner", "incoming", "details", id],
    queryFn: () =>
      api
        .get(`/incoming/${id}`)
        .then((r) => unwrap<OwnerIncomingGoods>(r.data)),
    enabled: id !== null,
  });
}

export function useOwnerConfirmIncomingGoods() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) =>
      api.put(`/incoming/${id}/confirm`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["owner", "incoming"] });
      queryClient.invalidateQueries({ queryKey: ["owner", "kpi"] });
    },
  });
}

export function useOwnerCancelIncomingGoods() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason?: string }) =>
      api
        .put(`/incoming/${id}/cancel`, reason ? { reason } : {})
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["owner", "incoming"] });
      queryClient.invalidateQueries({ queryKey: ["owner", "kpi"] });
    },
  });
}
