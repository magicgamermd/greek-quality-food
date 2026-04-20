import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Package, Users } from "lucide-react";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { usePeriod } from "@/hooks/usePeriod";
import { PeriodSwitcher } from "./components/PeriodSwitcher";

type TopProduct = {
  product_id: number;
  name_bg: string;
  name_en?: string;
  sku: string;
  total_sold: number;
  total_revenue: number;
  order_count: number;
};

type TopPartner = {
  partner_id: number;
  partner_name: string;
  order_count: number;
  total_units: number;
  total_revenue: number;
  total_profit: number;
  profit_margin_pct: number;
  revenue_pct: number;
};

export function OwnerTop() {
  const [tab, setTab] = useState<"products" | "partners">("products");
  const { period, from, to, setPeriod } = usePeriod();

  const productsQ = useQuery<TopProduct[]>({
    queryKey: ["top-products", period, from, to],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "15" });
      const range = resolveRange(period, from, to);
      params.set("from", range.from);
      params.set("to", range.to);
      const res = await api.get(`/analytics/top-products?${params}`);
      return Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
    },
    enabled: tab === "products",
  });

  const partnersQ = useQuery<{ partners: TopPartner[]; total_revenue: number }>(
    {
      queryKey: ["top-partners", period, from, to],
      queryFn: () => {
        const params = new URLSearchParams({ period, limit: "15" });
        if (from) params.set("from", from);
        if (to) params.set("to", to);
        return api.get(`/analytics/top-partners?${params}`).then((r) => r.data);
      },
      enabled: tab === "partners",
    },
  );

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-4 pb-24">
      <h1 className="text-xl font-bold text-[#f3f6ff]">Топ</h1>

      <PeriodSwitcher value={period} onChange={(p) => setPeriod(p)} />

      {/* Tab selector */}
      <div className="flex gap-1 p-1 rounded-xl bg-[#12162a] border border-[#243055]">
        {[
          { key: "products" as const, label: "Продукти", icon: Package },
          { key: "partners" as const, label: "Партньори", icon: Users },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-lg transition-colors",
              tab === t.key
                ? "bg-[#4f7cff] text-white"
                : "text-[#9aa8d6] hover:text-[#f3f6ff]",
            )}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </button>
        ))}
      </div>

      {/* List */}
      {tab === "products" ? (
        <div className="space-y-2">
          {productsQ.isLoading ? (
            <p className="text-center text-[#9aa8d6] text-sm py-4">
              Зареждам...
            </p>
          ) : (productsQ.data ?? []).length === 0 ? (
            <p className="text-center text-[#9aa8d6] text-sm py-8">
              Няма продадени продукти в избрания период.
            </p>
          ) : (
            (productsQ.data ?? []).map((p, idx) => (
              <TopProductRow key={p.product_id} product={p} rank={idx + 1} />
            ))
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {partnersQ.isLoading ? (
            <p className="text-center text-[#9aa8d6] text-sm py-4">
              Зареждам...
            </p>
          ) : (partnersQ.data?.partners ?? []).length === 0 ? (
            <p className="text-center text-[#9aa8d6] text-sm py-8">
              Няма поръчки в избрания период.
            </p>
          ) : (
            (partnersQ.data?.partners ?? []).map((p, idx) => (
              <TopPartnerRow key={p.partner_id} partner={p} rank={idx + 1} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function TopProductRow({
  product,
  rank,
}: {
  product: TopProduct;
  rank: number;
}) {
  return (
    <div className="rounded-xl border border-[#243055] bg-[#12162a] p-3">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-lg bg-[#161c34] flex items-center justify-center text-xs font-bold text-[#4f7cff] shrink-0">
          #{rank}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-[#f3f6ff] truncate">
            {product.name_bg}
          </p>
          <p className="text-xs text-[#9aa8d6] truncate font-mono">
            {product.sku} · {Number(product.total_sold).toFixed(0)} бр.
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm font-bold text-[#f3f6ff]">
            {formatCurrency(Number(product.total_revenue))}
          </p>
          <p className="text-xs text-[#9aa8d6]">
            {product.order_count} поръчки
          </p>
        </div>
      </div>
    </div>
  );
}

function TopPartnerRow({
  partner,
  rank,
}: {
  partner: TopPartner;
  rank: number;
}) {
  const marginAccent =
    partner.profit_margin_pct >= 25
      ? "text-[#25c38b]"
      : partner.profit_margin_pct >= 10
        ? "text-[#ffb454]"
        : "text-[#ff6b8a]";
  return (
    <div className="rounded-xl border border-[#243055] bg-[#12162a] p-3">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-lg bg-[#161c34] flex items-center justify-center text-xs font-bold text-[#4f7cff] shrink-0">
          #{rank}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-[#f3f6ff] truncate">
            {partner.partner_name}
          </p>
          <p className="text-xs text-[#9aa8d6]">
            {partner.order_count} поръчки · {partner.revenue_pct.toFixed(1)}% от
            оборота
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm font-bold text-[#f3f6ff]">
            {formatCurrency(partner.total_revenue)}
          </p>
          <p className={cn("text-xs font-medium", marginAccent)}>
            {partner.profit_margin_pct.toFixed(1)}% марж
          </p>
        </div>
      </div>
    </div>
  );
}

function resolveRange(period: string, from?: string, to?: string) {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const day = 86400000;
  switch (period) {
    case "yesterday": {
      const d = new Date(today.getTime() - day);
      return { from: iso(d), to: iso(d) };
    }
    case "week":
      return { from: iso(new Date(today.getTime() - 6 * day)), to: iso(today) };
    case "month":
      return {
        from: iso(new Date(today.getTime() - 29 * day)),
        to: iso(today),
      };
    case "custom":
      return { from: from ?? iso(today), to: to ?? iso(today) };
    case "today":
    default:
      return { from: iso(today), to: iso(today) };
  }
}
