import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  dashboardApi,
  analyticsApi,
  inventoryApi,
  ordersApi,
  reportsApi,
  notificationsApi,
  incomingGoodsApi,
} from "../api/endpoints";
import type { SalesPeriod } from "../types";

// ─── Dashboard ────────────────────────────────────────────────────────────────
export function useDashboardKPI() {
  return useQuery({
    queryKey: ["dashboard", "kpi"],
    queryFn: dashboardApi.getKPI,
    refetchInterval: 60_000, // refresh every 1 min
  });
}

// ─── Sales Analytics ──────────────────────────────────────────────────────────
export function useSalesAnalytics(
  period: SalesPeriod,
  from?: string,
  to?: string
) {
  return useQuery({
    queryKey: ["sales", period, from, to],
    queryFn: () => analyticsApi.getSales(period, from, to),
  });
}

export function useTopProducts(period: SalesPeriod) {
  return useQuery({
    queryKey: ["top-products", period],
    queryFn: () => analyticsApi.getTopProducts(period),
  });
}

// ─── Inventory ────────────────────────────────────────────────────────────────
export function useInventory() {
  return useQuery({
    queryKey: ["inventory"],
    queryFn: inventoryApi.getAll,
  });
}

export function useLowStock() {
  return useQuery({
    queryKey: ["inventory", "low-stock"],
    queryFn: inventoryApi.getLowStock,
  });
}

export function useExpiring() {
  return useQuery({
    queryKey: ["inventory", "expiring"],
    queryFn: inventoryApi.getExpiring,
  });
}

// ─── Orders ───────────────────────────────────────────────────────────────────
export function useOrders(params?: { status?: string; limit?: number; page?: number }) {
  return useQuery({
    queryKey: ["orders", params],
    queryFn: () => ordersApi.getAll(params),
  });
}

export function useOrder(id: number | null) {
  return useQuery({
    queryKey: ["orders", id],
    queryFn: () => ordersApi.getById(id!),
    enabled: id !== null,
  });
}

// ─── Reports ──────────────────────────────────────────────────────────────────
export function useDailyReport(date?: string) {
  return useQuery({
    queryKey: ["report", "daily", date],
    queryFn: () => reportsApi.getDaily(date),
  });
}

export function useMonthlyReport(year?: number, month?: number) {
  return useQuery({
    queryKey: ["report", "monthly", year, month],
    queryFn: () => reportsApi.getMonthly(year, month),
  });
}

// ─── Notifications ────────────────────────────────────────────────────────────
export function useNotifications() {
  return useQuery({
    queryKey: ["notifications"],
    queryFn: notificationsApi.getAll,
    refetchInterval: 30_000,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: notificationsApi.markRead,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function useReadAllNotifications() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: notificationsApi.readAll,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function useDismissNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: notificationsApi.dismiss,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

// ─── Incoming Goods ───────────────────────────────────────────────────────────
export function useIncomingGoodsByDate(dateFrom: string, dateTo: string) {
  return useQuery({
    queryKey: ["incoming", dateFrom, dateTo],
    queryFn: () => incomingGoodsApi.getByDate(dateFrom, dateTo),
  });
}

export function useIncomingGoodsById(id: number | null) {
  return useQuery({
    queryKey: ["incoming", id],
    queryFn: () => incomingGoodsApi.getById(id!),
    enabled: id !== null,
  });
}

export function useSuppliers() {
  return useQuery({
    queryKey: ["suppliers"],
    queryFn: incomingGoodsApi.getSuppliers,
  });
}

export function useProducts() {
  return useQuery({
    queryKey: ["products"],
    queryFn: incomingGoodsApi.getProducts,
  });
}

export function useCreateIncomingGoods() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: incomingGoodsApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["incoming"] });
    },
  });
}

export function useConfirmIncomingGoods() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: incomingGoodsApi.confirm,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["incoming"] });
    },
  });
}
