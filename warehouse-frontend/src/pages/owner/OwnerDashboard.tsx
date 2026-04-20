import { useQuery } from "@tanstack/react-query";
import { CreditCard, Package, Receipt, TrendingUp } from "lucide-react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { usePeriod } from "@/hooks/usePeriod";
import { KpiCard } from "./components/KpiCard";
import { PeriodSwitcher } from "./components/PeriodSwitcher";

type ProfitResponse = {
  period: string;
  range: { from: string; to: string };
  revenue_net: number;
  revenue_gross: number;
  cogs: number;
  profit: number;
  profit_margin_pct: number;
  order_count: number;
  comparison: {
    previous_period: ProfitResponse;
    previous_range: { from: string; to: string };
    delta_pct: number | null;
  };
};

type DashboardResponse = {
  today_orders: number;
  today_revenue: number;
  today_profit: number;
  today_profit_margin_pct: number;
  pending_payments: number;
  pending_payments_amount: number;
};

type SalesPoint = { group_name: string; total_revenue: number };

export function OwnerDashboard() {
  const { period, from, to, setPeriod } = usePeriod();

  // Main profit KPIs for the selected period
  const profitQ = useQuery<ProfitResponse>({
    queryKey: ["owner-profit", period, from, to],
    queryFn: () => {
      const params = new URLSearchParams({ period });
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      return api.get(`/analytics/profit?${params}`).then((r) => r.data);
    },
    refetchInterval: 60_000,
  });

  // Dashboard-wide stats (includes unpaid total — independent of period)
  const dashQ = useQuery<DashboardResponse>({
    queryKey: ["owner-dashboard"],
    queryFn: () => api.get("/analytics/dashboard").then((r) => r.data),
    refetchInterval: 60_000,
  });

  // 30-day sparkline (revenue trend)
  const trendQ = useQuery<SalesPoint[]>({
    queryKey: ["owner-trend"],
    queryFn: async () => {
      const res = await api.get("/analytics/sales?group_by=day");
      return Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
    },
    refetchInterval: 120_000,
  });

  const pnl = profitQ.data;
  const dash = dashQ.data;

  const trend = (trendQ.data ?? []).slice(-14).map((p) => ({
    date: new Date(p.group_name).toLocaleDateString("bg-BG", {
      day: "2-digit",
      month: "short",
    }),
    revenue: Number(p.total_revenue),
  }));

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-4 pb-24">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-[#f3f6ff]">Анализи</h1>
      </div>

      <PeriodSwitcher value={period} onChange={(p) => setPeriod(p)} />

      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-3">
        <KpiCard
          label="Оборот (без ДДС)"
          value={formatCurrency(pnl?.revenue_net ?? 0)}
          valueSub={`с ДДС ${formatCurrency(pnl?.revenue_gross ?? 0)}`}
          deltaPct={pnl?.comparison.delta_pct ?? null}
          accent="blue"
          icon={<TrendingUp className="h-4 w-4" />}
        />
        <KpiCard
          label="Печалба"
          value={formatCurrency(pnl?.profit ?? 0)}
          valueSub={`маржа ${pnl?.profit_margin_pct?.toFixed(1) ?? "0"}%`}
          accent="green"
          icon={<Receipt className="h-4 w-4" />}
        />
        <KpiCard
          label="Поръчки"
          value={String(pnl?.order_count ?? 0)}
          accent="amber"
          icon={<Package className="h-4 w-4" />}
        />
        <KpiCard
          label="Неплатени"
          value={formatCurrency(dash?.pending_payments_amount ?? 0)}
          valueSub={`${dash?.pending_payments ?? 0} фактури`}
          accent="red"
          icon={<CreditCard className="h-4 w-4" />}
        />
      </div>

      {/* Sparkline */}
      {trend.length > 0 ? (
        <div className="rounded-2xl border border-[#243055] bg-[#12162a] p-4">
          <p className="text-xs text-[#9aa8d6] uppercase tracking-wide mb-3">
            Оборот · последни 14 дни
          </p>
          <div className="h-32">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend}>
                <defs>
                  <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#4f7cff" stopOpacity={0.5} />
                    <stop offset="95%" stopColor="#4f7cff" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="date"
                  tick={{ fill: "#6b7692", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "#6b7692", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={40}
                />
                <Tooltip
                  contentStyle={{
                    background: "#161c34",
                    border: "1px solid #243055",
                    borderRadius: 8,
                    color: "#f3f6ff",
                    fontSize: 12,
                  }}
                  formatter={(v) => formatCurrency(Number(v ?? 0))}
                />
                <Area
                  type="monotone"
                  dataKey="revenue"
                  stroke="#4f7cff"
                  fill="url(#revGrad)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : null}

      {profitQ.isLoading && !pnl ? (
        <div className="text-center text-[#9aa8d6] text-sm py-8">
          Зареждам анализите...
        </div>
      ) : null}

      {profitQ.error ? (
        <div className="rounded-xl border border-[#ff6b8a]/30 bg-[#ff6b8a]/10 p-4 text-sm text-[#ff6b8a]">
          Грешка при зареждане на анализите. Провери интернет връзката.
        </div>
      ) : null}
    </div>
  );
}
