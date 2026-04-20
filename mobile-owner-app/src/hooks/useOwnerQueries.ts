import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { analyticsApi, dashboardApi, incomingApi } from "../api/endpoints";
import type { SalesPeriod } from "../types";

export function useDashboardKpi() {
  return useQuery({
    queryKey: ["owner", "kpi"],
    queryFn: dashboardApi.getKPI,
    refetchInterval: 60_000,
  });
}

export function useSalesAnalytics(period: SalesPeriod) {
  return useQuery({
    queryKey: ["owner", "sales", period],
    queryFn: () => analyticsApi.getSales(period),
  });
}

export function useIncomingGoods(params: {
  status?: string;
  dateFrom: string;
  dateTo: string;
}) {
  return useQuery({
    queryKey: ["owner", "incoming", params],
    queryFn: () => incomingApi.getList(params),
  });
}

export function useIncomingGoodsById(id: number | null) {
  return useQuery({
    queryKey: ["owner", "incoming", "details", id],
    queryFn: () => incomingApi.getById(id as number),
    enabled: id !== null,
  });
}

export function useConfirmIncomingGoods() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: incomingApi.confirm,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["owner", "incoming"] });
    },
  });
}
