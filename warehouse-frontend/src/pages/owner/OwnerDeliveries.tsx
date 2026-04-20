import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  ChevronRight,
  Clock,
  FileText,
  Package2,
  PackageOpen,
} from "lucide-react";
import { api } from "@/lib/api";
import { formatCurrency, formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";

type Delivery = {
  id: number;
  supplier_id: number | null;
  supplier_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  total_amount: number;
  status: string;
  item_count: number;
  created_at: string;
};

type DeliveryFilter = "all" | "today" | "week";

export function OwnerDeliveries() {
  const [filter, setFilter] = useState<DeliveryFilter>("all");

  const { data, isLoading, error } = useQuery<Delivery[]>({
    queryKey: ["owner-deliveries", filter],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "100" });
      if (filter === "today") {
        const today = new Date().toISOString().slice(0, 10);
        params.set("date_from", today);
      } else if (filter === "week") {
        const week = new Date(Date.now() - 7 * 86400000)
          .toISOString()
          .slice(0, 10);
        params.set("date_from", week);
      }
      const res = await api.get(`/incoming?${params}`);
      const rows = Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
      return rows.map((d: any) => ({
        ...d,
        total_amount: parseFloat(d.total_amount ?? 0),
        item_count: parseInt(d.item_count ?? 0),
      }));
    },
    // Same aggressive refresh policy as the main IncomingGoods page — so
    // deliveries saved on other devices / tabs show up promptly.
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  const deliveries = data ?? [];
  const totalValue = deliveries.reduce((s, d) => s + d.total_amount, 0);

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-4 pb-24">
      <h1 className="text-xl font-bold text-[#f3f6ff]">Доставки</h1>

      {/* Filter tabs */}
      <div className="flex gap-1 p-1 rounded-xl bg-[#12162a] border border-[#243055]">
        {[
          { key: "all" as const, label: "Всички" },
          { key: "week" as const, label: "Тази седмица" },
          { key: "today" as const, label: "Днес" },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setFilter(t.key)}
            className={cn(
              "flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors",
              filter === t.key
                ? "bg-[#4f7cff] text-white"
                : "text-[#9aa8d6] hover:text-[#f3f6ff]",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Summary card */}
      <div className="rounded-2xl border border-[#243055] bg-[#12162a] p-4">
        <p className="text-xs text-[#9aa8d6] uppercase tracking-wide">
          Общо доставки{" "}
          {filter === "today"
            ? "днес"
            : filter === "week"
              ? "за 7 дни"
              : "(показани)"}
        </p>
        <p className="text-3xl font-bold text-[#f3f6ff] mt-1">
          {formatCurrency(totalValue)}
        </p>
        <p className="text-xs text-[#6b7692] mt-0.5">
          {deliveries.length} {deliveries.length === 1 ? "фактура" : "фактури"}
        </p>
      </div>

      {/* Deliveries list */}
      <div className="space-y-2">
        {isLoading ? (
          <p className="text-center text-[#9aa8d6] text-sm py-8">Зареждам...</p>
        ) : error ? (
          <p className="text-center text-[#ff6b8a] text-sm py-8">
            Грешка при зареждане.
          </p>
        ) : deliveries.length === 0 ? (
          <div className="text-center py-12 text-[#9aa8d6]">
            <PackageOpen className="h-10 w-10 mx-auto mb-2 opacity-40" />
            <p className="text-sm">
              {filter === "today"
                ? "Няма доставки днес."
                : filter === "week"
                  ? "Няма доставки през последните 7 дни."
                  : "Няма доставки."}
            </p>
            <p className="text-xs mt-1">
              Снимай фактура от таб "Сканирай" за да добавиш.
            </p>
          </div>
        ) : (
          deliveries.map((d) => <DeliveryCard key={d.id} delivery={d} />)
        )}
      </div>
    </div>
  );
}

function DeliveryCard({ delivery }: { delivery: Delivery }) {
  const statusColor =
    delivery.status === "received" || delivery.status === "confirmed"
      ? "text-[#25c38b]"
      : delivery.status === "pending"
        ? "text-[#ffb454]"
        : "text-[#9aa8d6]";

  return (
    <div className="rounded-xl border border-[#243055] bg-[#12162a] p-3 hover:border-[#4f7cff]/50 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <FileText className="h-4 w-4 text-[#4f7cff] shrink-0" />
            <p className="font-medium text-[#f3f6ff] truncate">
              {delivery.supplier_name ?? "Неизвестен доставчик"}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-[#9aa8d6] flex-wrap">
            {delivery.invoice_number ? (
              <span className="font-mono">{delivery.invoice_number}</span>
            ) : null}
            {delivery.invoice_date ? (
              <>
                <span>·</span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {formatDate(delivery.invoice_date)}
                </span>
              </>
            ) : null}
            <span>·</span>
            <span className="inline-flex items-center gap-1">
              <Package2 className="h-3 w-3" />
              {delivery.item_count}{" "}
              {delivery.item_count === 1 ? "артикул" : "артикула"}
            </span>
          </div>
          <p className={cn("text-[10px] mt-1 uppercase", statusColor)}>
            {delivery.status === "received"
              ? "Приета"
              : delivery.status === "confirmed"
                ? "Потвърдена"
                : delivery.status === "pending"
                  ? "Чакаща"
                  : delivery.status}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-lg font-bold text-[#f3f6ff]">
            {formatCurrency(delivery.total_amount)}
          </p>
        </div>
        <ChevronRight className="h-4 w-4 text-[#6b7692] shrink-0 mt-1" />
      </div>
    </div>
  );
}
