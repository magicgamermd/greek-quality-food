import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CreditCard,
  RefreshCw,
  ShoppingCart,
  TrendingUp,
} from "lucide-react";
import {
  BarChart,
  Bar,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  type OwnerSalesPeriod,
  useOwnerDashboardKpi,
  useOwnerSalesAnalytics,
} from "@/hooks/useOwnerQueries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorMessage, LoadingOverlay } from "@/components/ui/spinner";
import { formatCurrency } from "@/lib/utils";

const PERIOD_OPTIONS: Array<{ key: OwnerSalesPeriod; label: string }> = [
  { key: "today", label: "Днес" },
  { key: "week", label: "Седмица" },
  { key: "month", label: "Месец" },
];

export function OwnerAnalytics() {
  const [period, setPeriod] = useState<OwnerSalesPeriod>("week");
  const kpiQuery = useOwnerDashboardKpi();
  const salesQuery = useOwnerSalesAnalytics(period);

  const isLoading = kpiQuery.isLoading || salesQuery.isLoading;
  const hasError = kpiQuery.isError || salesQuery.isError;

  const chartData = useMemo(
    () =>
      (salesQuery.data?.series || []).map((point) => ({
        period: point.period,
        total_amount: Number(point.total_amount || 0),
      })),
    [salesQuery.data?.series],
  );

  if (isLoading) {
    return (
      <div className="max-w-6xl mx-auto p-6">
        <LoadingOverlay />
      </div>
    );
  }

  if (hasError || !kpiQuery.data || !salesQuery.data) {
    return (
      <div className="max-w-6xl mx-auto p-6 space-y-3">
        <ErrorMessage message="Грешка при зареждане на owner анализите." />
        <Button
          variant="outline"
          className="border-[#243055] bg-[#12162a] text-[#f3f6ff] hover:bg-[#161c34]"
          onClick={() => {
            kpiQuery.refetch();
            salesQuery.refetch();
          }}
        >
          <RefreshCw className="h-4 w-4" />
          Опитай отново
        </Button>
      </div>
    );
  }

  const kpi = kpiQuery.data;
  const analytics = salesQuery.data;

  const kpiCards = [
    {
      label: "Приход днес",
      value: formatCurrency(kpi.today_revenue),
      icon: TrendingUp,
      tone: "text-[#25c38b] bg-[rgba(37,195,139,0.16)]",
    },
    {
      label: "Поръчки днес",
      value: String(kpi.today_orders),
      icon: ShoppingCart,
      tone: "text-[#4f7cff] bg-[rgba(79,124,255,0.2)]",
    },
    {
      label: "Нисък запас",
      value: String(kpi.low_stock_count),
      icon: AlertTriangle,
      tone: "text-[#f2b84b] bg-[rgba(242,184,75,0.18)]",
    },
    {
      label: "Неплатени фактури",
      value: String(kpi.pending_payments),
      icon: CreditCard,
      tone: "text-[#f26f6f] bg-[rgba(242,111,111,0.16)]",
    },
  ];

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#f3f6ff]">Owner Analytics</h1>
          <p className="text-sm text-[#9aa8d6] mt-1">
            KPI табло и оборот по период
          </p>
        </div>
        <Button
          variant="outline"
          className="border-[#243055] bg-[#12162a] text-[#f3f6ff] hover:bg-[#161c34]"
          onClick={() => {
            kpiQuery.refetch();
            salesQuery.refetch();
          }}
        >
          <RefreshCw className="h-4 w-4" />
          Обнови
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {kpiCards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.label}
              className="rounded-2xl border border-[#243055] bg-[#12162a] p-4 transition-colors"
            >
              <div className="flex items-center justify-between">
                <p className="text-xs uppercase tracking-wide font-semibold text-[#9aa8d6]">
                  {card.label}
                </p>
                <span
                  className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${card.tone}`}
                >
                  <Icon className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-3 text-2xl font-bold text-[#f3f6ff]">{card.value}</p>
            </div>
          );
        })}
      </div>

      <Card className="shadow-none rounded-2xl border-[#243055] bg-[#12162a] text-[#f3f6ff]">
        <CardHeader className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-[#f3f6ff]">Приходи по период</CardTitle>
            <div className="inline-flex rounded-lg border border-[#243055] p-1 bg-[#161c34]">
              {PERIOD_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  onClick={() => setPeriod(option.key)}
                  className={`px-3 py-1.5 text-xs rounded-md font-semibold transition-colors ${
                    period === option.key
                      ? "bg-[rgba(79,124,255,0.2)] text-[#4f7cff]"
                      : "text-[#9aa8d6] hover:text-[#f3f6ff]"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {chartData.length === 0 ? (
            <div className="h-56 rounded-lg border border-dashed border-[#243055] text-[#9aa8d6] flex items-center justify-center text-sm">
              Няма продажби за избрания период.
            </div>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#243055" />
                  <XAxis dataKey="period" tick={{ fontSize: 12, fill: "#9aa8d6" }} />
                  <YAxis
                    tick={{ fontSize: 12, fill: "#9aa8d6" }}
                    tickFormatter={(value: number) =>
                      value >= 1000 ? `${(value / 1000).toFixed(0)}K` : String(value)
                    }
                  />
                  <Tooltip
                    formatter={(value: number | string | undefined) =>
                      formatCurrency(value)
                    }
                    cursor={{ fill: "rgba(79,124,255,0.18)" }}
                    contentStyle={{
                      borderRadius: "10px",
                      border: "1px solid #243055",
                      backgroundColor: "#12162a",
                      color: "#f3f6ff",
                    }}
                    labelStyle={{ color: "#9aa8d6" }}
                  />
                  <Bar
                    dataKey="total_amount"
                    fill="#4f7cff"
                    radius={[6, 6, 0, 0]}
                    name="Приход"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg border border-[#243055] bg-[#161c34] p-3">
              <p className="text-[#9aa8d6] text-xs uppercase tracking-wide">
                Общ приход
              </p>
              <p className="mt-1 font-bold text-lg text-[#f3f6ff]">
                {formatCurrency(analytics.total_revenue)}
              </p>
            </div>
            <div className="rounded-lg border border-[#243055] bg-[#161c34] p-3">
              <p className="text-[#9aa8d6] text-xs uppercase tracking-wide">
                Общо поръчки
              </p>
              <p className="mt-1 font-bold text-lg text-[#f3f6ff]">{analytics.total_orders}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-none rounded-2xl border-[#243055] bg-[#12162a] text-[#f3f6ff]">
        <CardHeader>
          <CardTitle className="text-[#f3f6ff]">Топ продукти</CardTitle>
        </CardHeader>
        <CardContent>
          {analytics.top_products.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#243055] text-[#9aa8d6] py-10 text-center text-sm">
              Няма налични данни за топ продукти.
            </div>
          ) : (
            <div className="space-y-2">
              {analytics.top_products.slice(0, 5).map((product, index) => (
                <div
                  key={`${product.product_id}-${index}`}
                  className="rounded-xl border border-[#243055] bg-[#161c34] px-3 py-2.5 flex items-center gap-3"
                >
                  <div className="h-8 w-8 rounded-full bg-[rgba(79,124,255,0.2)] text-[#4f7cff] text-xs font-bold flex items-center justify-center shrink-0">
                    #{index + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate text-[#f3f6ff]">
                      {product.product_name}
                    </p>
                    <p className="text-xs text-[#9aa8d6] mt-0.5">
                      {product.total_sold} {product.unit}
                    </p>
                  </div>
                  <div className="text-sm font-semibold text-[#f3f6ff] flex items-center gap-1 shrink-0">
                    {formatCurrency(product.total_amount)}
                    <ArrowUpRight className="h-3.5 w-3.5 text-[#25c38b]" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
