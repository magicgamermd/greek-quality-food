import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CalendarClock } from "lucide-react";
import { api } from "@/lib/api";
import { formatCurrency, formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";

type UnpaidInvoice = {
  id: number;
  invoice_number: string;
  invoice_date: string;
  partner_id: number;
  partner_name: string;
  total_gross: number;
  paid_amount: number;
  due_date?: string | null;
};

type Payable = {
  supplier_id: number;
  supplier_name: string;
  invoice_count: number;
  total_owed: number;
  oldest_delivery: string | null;
  overdue_days: number;
};

export function OwnerPayments() {
  const [tab, setTab] = useState<"receivables" | "payables">("receivables");

  const recvQ = useQuery<UnpaidInvoice[]>({
    queryKey: ["unpaid-invoices"],
    queryFn: async () => {
      const res = await api.get("/invoices?payment_status=unpaid&limit=200");
      const data = Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
      return data.map((i: any) => ({
        ...i,
        total_gross: parseFloat(i.total_gross ?? 0),
        paid_amount: parseFloat(i.paid_amount ?? 0),
      }));
    },
    refetchInterval: 60_000,
    enabled: tab === "receivables",
  });

  const payQ = useQuery<{ total: number; by_supplier: Payable[] }>({
    queryKey: ["supplier-payables"],
    queryFn: () => api.get("/analytics/supplier-payables").then((r) => r.data),
    refetchInterval: 60_000,
    enabled: tab === "payables",
  });

  const receivables = recvQ.data ?? [];
  const receivablesTotal = receivables.reduce(
    (s, inv) => s + (inv.total_gross - inv.paid_amount),
    0,
  );

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-4 pb-24">
      <h1 className="text-xl font-bold text-[#f3f6ff]">Плащания</h1>

      {/* Tab selector */}
      <div className="flex gap-1 p-1 rounded-xl bg-[#12162a] border border-[#243055]">
        {[
          { key: "receivables" as const, label: "Дължат ни" },
          { key: "payables" as const, label: "Дължим на" },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors",
              tab === t.key
                ? "bg-[#4f7cff] text-white"
                : "text-[#9aa8d6] hover:text-[#f3f6ff]",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Summary */}
      <div className="rounded-2xl border border-[#243055] bg-[#12162a] p-4">
        <p className="text-xs text-[#9aa8d6] uppercase tracking-wide">
          {tab === "receivables" ? "Общо ни дължат" : "Общо дължим"}
        </p>
        <p className="text-3xl font-bold text-[#f3f6ff] mt-1">
          {formatCurrency(
            tab === "receivables" ? receivablesTotal : (payQ.data?.total ?? 0),
          )}
        </p>
        <p className="text-xs text-[#6b7692] mt-0.5">
          {tab === "receivables"
            ? `${receivables.length} фактури`
            : `${payQ.data?.by_supplier.length ?? 0} доставчици`}
        </p>
      </div>

      {/* List */}
      {tab === "receivables" ? (
        <div className="space-y-2">
          {recvQ.isLoading ? (
            <p className="text-center text-[#9aa8d6] text-sm py-4">
              Зареждам...
            </p>
          ) : receivables.length === 0 ? (
            <div className="text-center py-12 text-[#9aa8d6]">
              <AlertCircle className="h-10 w-10 mx-auto mb-2 opacity-40" />
              <p className="text-sm">Няма неплатени фактури — браво! 🎉</p>
            </div>
          ) : (
            receivables.map((inv) => <InvoiceCard key={inv.id} invoice={inv} />)
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {payQ.isLoading ? (
            <p className="text-center text-[#9aa8d6] text-sm py-4">
              Зареждам...
            </p>
          ) : (payQ.data?.by_supplier ?? []).length === 0 ? (
            <div className="text-center py-12 text-[#9aa8d6]">
              <AlertCircle className="h-10 w-10 mx-auto mb-2 opacity-40" />
              <p className="text-sm">Няма неплатени доставки към доставчици</p>
            </div>
          ) : (
            payQ.data?.by_supplier.map((p) => (
              <PayableCard key={p.supplier_id} payable={p} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function InvoiceCard({ invoice }: { invoice: UnpaidInvoice }) {
  const outstanding = invoice.total_gross - invoice.paid_amount;
  const daysOverdue = Math.floor(
    (Date.now() - new Date(invoice.invoice_date).getTime()) / 86400000,
  );
  const isOverdue = daysOverdue > 30;

  return (
    <div
      className={cn(
        "rounded-xl border p-3 bg-[#12162a]",
        isOverdue ? "border-[#ff6b8a]/50" : "border-[#243055]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-[#f3f6ff] truncate">
            {invoice.partner_name}
          </p>
          <p className="text-xs text-[#9aa8d6] mt-0.5 font-mono">
            {invoice.invoice_number} · {formatDate(invoice.invoice_date)}
          </p>
          {isOverdue ? (
            <div className="flex items-center gap-1 mt-1 text-xs text-[#ff6b8a]">
              <CalendarClock className="h-3 w-3" />
              <span>{daysOverdue} дни просрочие</span>
            </div>
          ) : null}
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-[#f3f6ff]">
            {formatCurrency(outstanding)}
          </p>
          {invoice.paid_amount > 0 ? (
            <p className="text-xs text-[#9aa8d6]">
              от {formatCurrency(invoice.total_gross)}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PayableCard({ payable }: { payable: Payable }) {
  const isOverdue = payable.overdue_days > 30;
  return (
    <div
      className={cn(
        "rounded-xl border p-3 bg-[#12162a]",
        isOverdue ? "border-[#ffb454]/50" : "border-[#243055]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-[#f3f6ff] truncate">
            {payable.supplier_name}
          </p>
          <p className="text-xs text-[#9aa8d6] mt-0.5">
            {payable.invoice_count} доставки
            {payable.overdue_days > 0
              ? ` · най-стара ${payable.overdue_days} дни`
              : ""}
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-[#f3f6ff]">
            {formatCurrency(payable.total_owed)}
          </p>
        </div>
      </div>
    </div>
  );
}
