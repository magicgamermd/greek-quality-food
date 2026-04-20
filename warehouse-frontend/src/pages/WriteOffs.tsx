import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Download, FileText, Filter, Printer, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";

type Period = "today" | "week" | "month" | "quarter" | "custom";

type WriteOff = {
  id: number;
  document_number: string;
  product_id: number;
  product_name: string;
  batch_id: number | null;
  batch_number: string | null;
  quantity: number;
  unit_cost: number;
  total_cost: number;
  reason: string;
  notes: string | null;
  written_off_by_email: string | null;
  written_off_at: string;
  pdf_path: string | null;
};

type Summary = {
  period: { from: string; to: string };
  total_value: number;
  total_count: number;
  by_reason: Array<{ reason: string; count: number; value: number }>;
  top_products: Array<{
    product_id: number;
    name_bg: string;
    count: number;
    value: number;
  }>;
};

const REASON_LABELS: Record<string, string> = {
  expired: "Изтекъл срок",
  damaged: "Повреден",
  theft: "Липса",
  count_correction: "Инвентаризация",
  recall: "Изтегляне",
  other: "Друго",
};

const REASON_BADGE: Record<
  string,
  "destructive" | "warning" | "info" | "secondary"
> = {
  expired: "destructive",
  damaged: "warning",
  theft: "destructive",
  count_correction: "info",
  recall: "warning",
  other: "secondary",
};

function periodRange(period: Period): { from: string; to: string } {
  const today = new Date();
  const toISO = (d: Date) => d.toISOString().slice(0, 10);
  const end = toISO(today);
  switch (period) {
    case "today":
      return { from: end, to: end };
    case "week": {
      const d = new Date(today);
      d.setDate(d.getDate() - 7);
      return { from: toISO(d), to: end };
    }
    case "month": {
      const d = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from: toISO(d), to: end };
    }
    case "quarter": {
      const m = Math.floor(today.getMonth() / 3) * 3;
      const d = new Date(today.getFullYear(), m, 1);
      return { from: toISO(d), to: end };
    }
    default:
      return { from: end, to: end };
  }
}

export function WriteOffs() {
  const [period, setPeriod] = useState<Period>("month");
  const [reasonFilter, setReasonFilter] = useState<string>("");
  const [search, setSearch] = useState<string>("");

  const range = useMemo(() => periodRange(period), [period]);

  const summaryQ = useQuery<Summary>({
    queryKey: ["inventory-writeoffs-summary", range.from, range.to],
    queryFn: async () => {
      const res = await api.get(
        `/inventory/write-offs/summary?date_from=${range.from}&date_to=${range.to}`,
      );
      return res.data;
    },
  });

  const listQ = useQuery<{ data: WriteOff[]; total: number }>({
    queryKey: ["writeoffs", range.from, range.to, reasonFilter, search],
    queryFn: async () => {
      const params = new URLSearchParams({
        date_from: range.from,
        date_to: range.to,
        limit: "50",
      });
      if (reasonFilter) params.set("reason", reasonFilter);
      if (search.trim()) params.set("q", search.trim());
      const res = await api.get(`/inventory/write-offs?${params.toString()}`);
      // Accept {data, total} OR bare array from backend
      if (Array.isArray(res.data)) {
        return { data: res.data, total: res.data.length };
      }
      return { data: res.data?.data ?? [], total: res.data?.total ?? 0 };
    },
  });

  const handleDownloadPdf = async (id: number, docNumber: string) => {
    try {
      const res = await api.get(`/inventory/write-offs/${id}/pdf`, {
        responseType: "blob",
      });
      const blob = new Blob([res.data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${docNumber}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      // Silent — button tooltip will say "PDF недостъпен"
      console.error("PDF download failed", err);
    }
  };

  /**
   * Print protocol directly — fetches the PDF as a blob, mounts it in a
   * hidden iframe, and calls contentWindow.print() when the PDF loads.
   * This bypasses the "download first, then print" friction and routes
   * the print dialog straight to the OS-level printer picker.
   *
   * The iframe is kept alive for 60s after triggering print so the user
   * has time to confirm the printer settings (if removed too early the
   * print job aborts in some browsers).
   */
  const handlePrintPdf = async (id: number) => {
    try {
      const res = await api.get(`/inventory/write-offs/${id}/pdf`, {
        responseType: "blob",
      });
      const blob = new Blob([res.data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);

      const iframe = document.createElement("iframe");
      // Off-screen but not display:none — some browsers skip print() on
      // fully-hidden iframes. Tiny 1px frame in the bottom-right corner
      // works reliably across Chrome / Safari / Firefox.
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "1px";
      iframe.style.height = "1px";
      iframe.style.border = "0";
      iframe.style.opacity = "0";
      iframe.src = url;

      iframe.onload = () => {
        // Small delay so Safari/Firefox finish rendering the PDF before
        // print() fires — without this some browsers print a blank page.
        setTimeout(() => {
          try {
            iframe.contentWindow?.focus();
            iframe.contentWindow?.print();
          } catch (err) {
            // Some browsers block cross-origin-ish iframe print even for
            // blob URLs — fall back to opening the PDF in a new tab so
            // the user can Ctrl+P / Cmd+P manually.
            console.warn("iframe.print failed, falling back to new tab", err);
            window.open(url, "_blank");
          }
          // Cleanup after giving the print dialog time to open
          setTimeout(() => {
            if (iframe.parentNode) {
              iframe.parentNode.removeChild(iframe);
            }
            URL.revokeObjectURL(url);
          }, 60_000);
        }, 250);
      };

      document.body.appendChild(iframe);
    } catch (err) {
      console.error("Print failed", err);
    }
  };

  const summary = summaryQ.data;
  const rows = listQ.data?.data ?? [];

  const topReason = summary?.by_reason
    ?.slice()
    .sort((a, b) => b.value - a.value)?.[0];

  return (
    // p-6 matches the Dashboard/Orders padding convention — <main> in
    // Layout.tsx has no inset, so without p-* the content sticks to the
    // edges of the viewport right next to the sidebar.
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Бракувана стока</h1>
          <p className="text-sm text-gray-500">
            Протоколи за бракуване съгласно Закона за счетоводството чл. 54 ал.
            1
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={period}
            onChange={(e) => setPeriod(e.target.value as Period)}
            className="w-40"
          >
            <option value="today">Днес</option>
            <option value="week">Последни 7 дни</option>
            <option value="month">Текущ месец</option>
            <option value="quarter">Тримесечие</option>
          </Select>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-gray-500 uppercase">
              Общо бракувано
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-red-700">
              {formatCurrency(summary?.total_value ?? 0)}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              {range.from} – {range.to}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-gray-500 uppercase">
              Брой протоколи
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{summary?.total_count ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-gray-500 uppercase">
              Водеща причина
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">
              {topReason ? REASON_LABELS[topReason.reason] : "—"}
            </p>
            <p className="text-xs text-gray-500">
              {topReason
                ? `${formatCurrency(topReason.value)} (${topReason.count} бр.)`
                : ""}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="py-3 flex items-center gap-2">
          <Filter className="h-4 w-4 text-gray-500" />
          <Input
            placeholder="Търси по артикул / партида..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm"
          />
          <Select
            value={reasonFilter}
            onChange={(e) => setReasonFilter(e.target.value)}
            className="w-52"
          >
            <option value="">Всички причини</option>
            {Object.entries(REASON_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader>
          <CardTitle>Протоколи ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {listQ.isLoading ? (
            <p className="text-center py-8 text-gray-500">Зарежда...</p>
          ) : listQ.isError ? (
            <p className="text-center py-8 text-gray-500">
              API недостъпен. Провери че backend-ът работи.
            </p>
          ) : rows.length === 0 ? (
            <p className="text-center py-8 text-gray-500">
              Няма бракувани артикули в този период.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-500 uppercase">
                  <tr className="border-b">
                    <th className="text-left py-2 pr-3">Документ №</th>
                    <th className="text-left py-2 pr-3">Дата</th>
                    <th className="text-left py-2 pr-3">Артикул</th>
                    <th className="text-left py-2 pr-3">Партида</th>
                    <th className="text-right py-2 pr-3">Кол-во</th>
                    <th className="text-right py-2 pr-3">Стойност</th>
                    <th className="text-left py-2 pr-3">Причина</th>
                    <th className="text-left py-2 pr-3">Бракувал</th>
                    <th className="text-center py-2" colSpan={2}>
                      Протокол
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b hover:bg-gray-50">
                      <td className="py-2 pr-3 font-mono text-xs">
                        {r.document_number}
                      </td>
                      <td className="py-2 pr-3 text-xs">
                        {new Date(r.written_off_at).toLocaleDateString("bg-BG")}
                      </td>
                      <td className="py-2 pr-3">{r.product_name}</td>
                      <td className="py-2 pr-3 font-mono text-xs">
                        {r.batch_number ?? "—"}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {Number(r.quantity).toFixed(3)}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-red-700">
                        {formatCurrency(Number(r.total_cost))}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge variant={REASON_BADGE[r.reason] ?? "secondary"}>
                          {REASON_LABELS[r.reason] ?? r.reason}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 text-xs text-gray-500">
                        {r.written_off_by_email ?? "—"}
                      </td>
                      <td className="py-2 text-center w-10">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handlePrintPdf(r.id)}
                          title="Принтирай протокол"
                          className="text-[#6c3dff] hover:bg-[#6c3dff]/10"
                        >
                          <Printer className="h-4 w-4" />
                        </Button>
                      </td>
                      <td className="py-2 text-center w-10">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            handleDownloadPdf(r.id, r.document_number)
                          }
                          title="Свали протокол (PDF)"
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Back to inventory link */}
      <div className="flex justify-center pt-2">
        <Link
          to="/inventory"
          className="text-sm text-[#6c3dff] hover:underline inline-flex items-center gap-1"
        >
          <Trash2 className="h-3 w-3" />
          Отиди в Инвентар за да бракуваш нова стока
        </Link>
      </div>
    </div>
  );
}
