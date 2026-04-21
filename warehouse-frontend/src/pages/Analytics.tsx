import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  CalendarRange,
  CircleAlert,
  Package,
  ShoppingCart,
  TrendingUp,
} from "lucide-react";
import { api } from "@/lib/api";
import type { SalesData, TopProduct, StockForecast } from "@/types";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { ErrorMessage, LoadingOverlay } from "@/components/ui/spinner";

const BG_MONTHS = [
  "Ян",
  "Фев",
  "Мар",
  "Апр",
  "Май",
  "Юни",
  "Юли",
  "Авг",
  "Сеп",
  "Окт",
  "Ное",
  "Дек",
];

const PERIOD_OPTIONS = [
  { value: "week", label: "Тази седмица" },
  { value: "month", label: "Последни 30 дни" },
  { value: "quarter", label: "Последни 90 дни" },
  { value: "year", label: "Последна година" },
] as const;

type PeriodOption = (typeof PERIOD_OPTIONS)[number]["value"];

type StockStatus = "critical" | "warning" | "healthy";

function formatPeriodLabel(isoStr: string, groupBy: string): string {
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return isoStr;

  if (groupBy === "day") {
    return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  if (groupBy === "week") {
    const end = new Date(d.getTime() + 6 * 86400000);
    return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(end.getUTCDate()).padStart(2, "0")}.${String(end.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  if (groupBy === "month") {
    return `${BG_MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
  }

  return isoStr;
}

function getPeriodConfig(period: PeriodOption): { days: number; group_by: string } {
  const periodMap: Record<PeriodOption, { days: number; group_by: string }> = {
    week: { days: 7, group_by: "day" },
    month: { days: 30, group_by: "day" },
    quarter: { days: 90, group_by: "week" },
    year: { days: 365, group_by: "month" },
  };

  return periodMap[period] ?? periodMap.month;
}

function getDaysLeft(predictedDepletionDate: string): number {
  return Math.ceil(
    (new Date(predictedDepletionDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
  );
}

function getStockStatus(daysLeft: number): StockStatus {
  if (daysLeft <= 14) return "critical";
  if (daysLeft <= 30) return "warning";
  return "healthy";
}

function getStatusLabel(status: StockStatus): string {
  if (status === "critical") return "Спешно";
  if (status === "warning") return "Следи";
  return "Стабилно";
}

function getStatusBadgeVariant(status: StockStatus):
  | "destructive"
  | "warning"
  | "success" {
  if (status === "critical") return "destructive";
  if (status === "warning") return "warning";
  return "success";
}

function getStatusTextClass(status: StockStatus): string {
  if (status === "critical") return "text-red-600";
  if (status === "warning") return "text-orange-600";
  return "text-green-600";
}

function formatDaysLeft(daysLeft: number): string {
  if (daysLeft <= 0) return "Изчерпан";
  if (daysLeft === 1) return "1 ден";
  return `${daysLeft} дни`;
}

function getEmptyState(message: string) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-4 py-10 text-center text-sm text-gray-500">
      {message}
    </div>
  );
}

export function Analytics() {
  const [period, setPeriod] = useState<PeriodOption>("month");

  const {
    data: salesData = [],
    isLoading: salesLoading,
    isError: salesError,
  } = useQuery<SalesData[]>({
    queryKey: ["analytics-sales", period],
    queryFn: () => {
      const now = new Date();
      const cfg = getPeriodConfig(period);
      const from = new Date(now.getTime() - cfg.days * 86400000)
        .toISOString()
        .slice(0, 10);
      const to = now.toISOString().slice(0, 10);

      return api
        .get(`/analytics/sales?from=${from}&to=${to}&group_by=${cfg.group_by}`)
        .then((r) => {
          const d = r.data;
          const rows = Array.isArray(d)
            ? d
            : Array.isArray(d?.data)
              ? d.data
              : [];

          return rows.map((row: any) => ({
            period: formatPeriodLabel(
              String(row.group_name ?? row.period ?? ""),
              cfg.group_by,
            ),
            amount: Number(row.total_revenue ?? row.amount ?? 0),
            orders: Number(row.order_count ?? row.orders ?? 0),
          }));
        });
    },
    refetchInterval: 30000,
  });

  const {
    data: topProducts = [],
    isLoading: topLoading,
    isError: topError,
  } = useQuery<TopProduct[]>({
    queryKey: ["analytics-top-products"],
    queryFn: () =>
      api.get("/analytics/top-products").then((r) => {
        const d = r.data;
        const rows = Array.isArray(d)
          ? d
          : Array.isArray(d?.data)
            ? d.data
            : [];

        return rows.map((row: any) => ({
          product_id: row.id ?? row.product_id,
          product_name:
            row.name_bg || row.name_en || row.product_name || row.sku || "—",
          total_sold: Number(row.total_sold ?? 0),
          total_revenue: Number(row.total_revenue ?? 0),
        }));
      }),
    refetchInterval: 30000,
  });

  const {
    data: stockForecast = [],
    isLoading: forecastLoading,
    isError: forecastError,
  } = useQuery<StockForecast[]>({
    queryKey: ["analytics-forecast"],
    queryFn: () =>
      api.get("/analytics/stock-forecast").then((r) => {
        const d = r.data;
        const rows = Array.isArray(d)
          ? d
          : Array.isArray(d?.data)
            ? d.data
            : [];

        return rows.map((row: any) => ({
          product_id: row.id ?? row.product_id,
          product_name: row.name_bg || row.name_en || row.product_name || "—",
          current_stock: Number(row.current_stock ?? 0),
          daily_usage: Number(row.avg_daily_usage ?? row.daily_usage ?? 0),
          predicted_depletion_date:
            row.estimated_depletion_date ||
            row.predicted_depletion_date ||
            new Date(Date.now() - 86400000).toISOString(),
        }));
      }),
    refetchInterval: 30000,
  });

  const salesSummary = useMemo(() => {
    const totalRevenue = salesData.reduce((sum, item) => sum + item.amount, 0);
    const totalOrders = salesData.reduce((sum, item) => sum + item.orders, 0);
    const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const bestPeriod = salesData.reduce<SalesData | null>((best, item) => {
      if (!best || item.amount > best.amount) return item;
      return best;
    }, null);
    const recentPeriods = [...salesData].slice(-5).reverse();

    return {
      totalRevenue,
      totalOrders,
      averageOrderValue,
      bestPeriod,
      recentPeriods,
    };
  }, [salesData]);

  const topProductsSummary = useMemo(() => {
    const totalTopRevenue = topProducts.reduce(
      (sum, product) => sum + product.total_revenue,
      0,
    );

    return topProducts.slice(0, 6).map((product, index) => ({
      ...product,
      rank: index + 1,
      revenueShare:
        totalTopRevenue > 0 ? (product.total_revenue / totalTopRevenue) * 100 : 0,
    }));
  }, [topProducts]);

  const stockSummary = useMemo(() => {
    const items = stockForecast
      .map((item) => {
        const daysLeft = getDaysLeft(item.predicted_depletion_date);
        const status = getStockStatus(daysLeft);

        return {
          ...item,
          daysLeft,
          status,
        };
      })
      .sort((a, b) => a.daysLeft - b.daysLeft);

    return {
      critical: items.filter((item) => item.status === "critical"),
      warning: items.filter((item) => item.status === "warning"),
      healthy: items.filter((item) => item.status === "healthy"),
      visible: items.slice(0, 6),
      nextRisk: items[0] ?? null,
    };
  }, [stockForecast]);

  const pageLoading = salesLoading || topLoading || forecastLoading;
  const hasFatalError = salesError && topError && forecastError;

  if (pageLoading && salesData.length === 0 && topProducts.length === 0 && stockForecast.length === 0) {
    return (
      <div className="p-6">
        <LoadingOverlay />
      </div>
    );
  }

  if (hasFatalError) {
    return (
      <div className="p-6">
        <ErrorMessage message="Грешка при зареждане на аналитичната страница." />
      </div>
    );
  }

  const selectedPeriodLabel =
    PERIOD_OPTIONS.find((option) => option.value === period)?.label ?? "Последни 30 дни";

  return (
    <div className="p-6 space-y-6 bg-gray-50/60 min-h-full">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Анализи</h1>
          <p className="mt-1 text-sm text-gray-500">
            Ясен преглед на продажбите, топ продуктите и риска от недостиг.
          </p>
        </div>

        <Card className="w-full xl:max-w-sm shadow-none">
          <CardContent className="flex flex-col gap-3 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-600">
              <CalendarRange className="h-4 w-4 text-[#f97316]" />
              Избран период
            </div>
            <Select value={period} onChange={(e) => setPeriod(e.target.value as PeriodOption)}>
              {PERIOD_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <p className="text-xs text-gray-500">
              Данните се обновяват автоматично на всеки 30 секунди.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="border-[#e7ddff] bg-gradient-to-br from-white via-white to-[#f7f3ff] shadow-none">
        <CardContent className="grid gap-4 p-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,1fr)] lg:items-center">
          <div className="space-y-3">
            <Badge variant="secondary" className="w-fit bg-[#fff7ed] text-[#f97316]">
              Обобщение за {selectedPeriodLabel.toLowerCase()}
            </Badge>
            <div>
              <h2 className="text-2xl font-bold text-gray-900">
                {salesSummary.totalRevenue > 0
                  ? formatCurrency(salesSummary.totalRevenue)
                  : "Няма отчетени продажби"}
              </h2>
              <p className="mt-1 text-sm text-gray-600">
                {salesSummary.totalOrders > 0
                  ? `${salesSummary.totalOrders} поръчки със средна стойност ${formatCurrency(salesSummary.averageOrderValue)}`
                  : "Изберете друг период, ако очаквате активност."}
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-white/80 bg-white/80 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Най-силен период
              </p>
              <p className="mt-2 text-lg font-semibold text-gray-900">
                {salesSummary.bestPeriod?.period ?? "—"}
              </p>
              <p className="mt-1 text-sm text-gray-500">
                {salesSummary.bestPeriod
                  ? formatCurrency(salesSummary.bestPeriod.amount)
                  : "Няма данни"}
              </p>
            </div>
            <div className="rounded-2xl border border-white/80 bg-white/80 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Най-близък риск
              </p>
              <p className="mt-2 text-lg font-semibold text-gray-900">
                {stockSummary.nextRisk?.product_name ?? "—"}
              </p>
              <p className="mt-1 text-sm text-gray-500">
                {stockSummary.nextRisk
                  ? formatDaysLeft(stockSummary.nextRisk.daysLeft)
                  : "Няма данни"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="shadow-none">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">Приходи</p>
                <p className="mt-2 text-2xl font-bold text-gray-900">
                  {formatCurrency(salesSummary.totalRevenue)}
                </p>
              </div>
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-orange-50 text-[#f97316]">
                <TrendingUp className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">Поръчки</p>
                <p className="mt-2 text-2xl font-bold text-gray-900">{salesSummary.totalOrders}</p>
              </div>
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
                <ShoppingCart className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">Средна поръчка</p>
                <p className="mt-2 text-2xl font-bold text-gray-900">
                  {formatCurrency(salesSummary.averageOrderValue)}
                </p>
              </div>
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
                <ArrowUpRight className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">Критични наличности</p>
                <p className="mt-2 text-2xl font-bold text-gray-900">{stockSummary.critical.length}</p>
              </div>
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-red-50 text-red-600">
                <AlertTriangle className="h-5 w-5" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <Card className="shadow-none">
          <CardHeader className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="text-gray-900">Продажби по период</CardTitle>
                <CardDescription>
                  Последните отчетени периоди, без излишни графики.
                </CardDescription>
              </div>
              <div className="hidden h-10 w-10 items-center justify-center rounded-2xl bg-gray-100 text-gray-600 sm:flex">
                <BarChart3 className="h-5 w-5" />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {salesError ? (
              <ErrorMessage message="Не успяхме да заредим продажбите." />
            ) : salesSummary.recentPeriods.length === 0 ? (
              getEmptyState("Няма данни за избрания период.")
            ) : (
              <div className="space-y-3">
                {salesSummary.recentPeriods.map((item) => {
                  const averageValue = item.orders > 0 ? item.amount / item.orders : 0;

                  return (
                    <div
                      key={item.period}
                      className="grid gap-3 rounded-2xl border border-gray-200 bg-white p-4 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center"
                    >
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900">{item.period}</p>
                        <p className="mt-1 text-sm text-gray-500">
                          Средна поръчка {formatCurrency(averageValue)}
                        </p>
                      </div>
                      <div className="rounded-xl bg-gray-50 px-3 py-2 text-sm md:text-right">
                        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                          Приходи
                        </p>
                        <p className="mt-1 font-semibold text-gray-900">
                          {formatCurrency(item.amount)}
                        </p>
                      </div>
                      <div className="rounded-xl bg-gray-50 px-3 py-2 text-sm md:text-right">
                        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                          Поръчки
                        </p>
                        <p className="mt-1 font-semibold text-gray-900">{item.orders}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader className="space-y-2">
            <CardTitle className="text-gray-900">Топ продукти</CardTitle>
            <CardDescription>
              Подредени по приход, с лесно сравнение между лидерите.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {topError ? (
              <ErrorMessage message="Не успяхме да заредим топ продуктите." />
            ) : topProductsSummary.length === 0 ? (
              getEmptyState("Няма налични данни за топ продукти.")
            ) : (
              <div className="space-y-3">
                {topProductsSummary.map((product) => (
                  <div
                    key={product.product_id}
                    className="rounded-2xl border border-gray-200 bg-white p-4"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#fff7ed] text-sm font-bold text-[#f97316]">
                        #{product.rank}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-gray-900">
                              {product.product_name}
                            </p>
                            <p className="mt-1 text-sm text-gray-500">
                              Продадени: {product.total_sold}
                            </p>
                          </div>
                          <div className="text-left sm:text-right">
                            <p className="font-semibold text-gray-900">
                              {formatCurrency(product.total_revenue)}
                            </p>
                            <p className="mt-1 text-sm text-gray-500">
                              {product.revenueShare.toFixed(0)}% от топ приходите
                            </p>
                          </div>
                        </div>
                        <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100">
                          <div
                            className="h-full rounded-full bg-[#f97316]"
                            style={{ width: `${Math.max(product.revenueShare, 6)}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-none">
        <CardHeader className="space-y-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <CardTitle className="text-gray-900">Състояние на запасите</CardTitle>
              <CardDescription>
                Фокус върху продуктите, които изискват действие най-скоро.
              </CardDescription>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="rounded-xl bg-red-50 px-3 py-2 text-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-red-500">
                  Спешно
                </p>
                <p className="mt-1 font-bold text-red-700">{stockSummary.critical.length}</p>
              </div>
              <div className="rounded-xl bg-orange-50 px-3 py-2 text-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-orange-500">
                  За следене
                </p>
                <p className="mt-1 font-bold text-orange-700">{stockSummary.warning.length}</p>
              </div>
              <div className="rounded-xl bg-green-50 px-3 py-2 text-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-green-500">
                  Стабилно
                </p>
                <p className="mt-1 font-bold text-green-700">{stockSummary.healthy.length}</p>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {forecastError ? (
            <ErrorMessage message="Не успяхме да заредим прогнозата за наличности." />
          ) : stockSummary.visible.length === 0 ? (
            getEmptyState("Няма данни за складови прогнози.")
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {stockSummary.visible.map((item) => (
                <div
                  key={item.product_id}
                  className="rounded-2xl border border-gray-200 bg-white p-4"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-gray-900">{item.product_name}</p>
                        <Badge variant={getStatusBadgeVariant(item.status)}>
                          {getStatusLabel(item.status)}
                        </Badge>
                      </div>
                      <p className="mt-1 text-sm text-gray-500">
                        Очаквано изчерпване: {formatDate(item.predicted_depletion_date)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <Package className="h-4 w-4 text-gray-400" />
                      <span className={getStatusTextClass(item.status)}>
                        {formatDaysLeft(item.daysLeft)}
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <div className="rounded-xl bg-gray-50 px-3 py-2">
                      <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                        Наличност
                      </p>
                      <p className="mt-1 font-semibold text-gray-900">{item.current_stock} ед.</p>
                    </div>
                    <div className="rounded-xl bg-gray-50 px-3 py-2">
                      <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                        Средна консумация
                      </p>
                      <p className="mt-1 font-semibold text-gray-900">
                        {item.daily_usage > 0 ? `${item.daily_usage.toFixed(1)} ед./ден` : "—"}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!forecastError && stockSummary.critical.length > 0 && (
            <div className="mt-4 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <p>
                {stockSummary.critical.length} продукта изискват бърза заявка или преразпределение.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
