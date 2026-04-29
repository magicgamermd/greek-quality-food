import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  Send,
  CheckCircle,
  XCircle,
  Printer,
  RotateCcw,
  RefreshCw,
  Search,
  Banknote,
} from "lucide-react";
import { api } from "@/lib/api";
import type { Invoice } from "@/types";
import { formatDate, formatCurrency } from "@/lib/utils";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LoadingOverlay, ErrorMessage } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { Can } from "@/components/Can";
import { PERMISSIONS } from "@/lib/permissions";

const paymentVariants: Record<string, "success" | "destructive" | "warning"> = {
  paid: "success",
  unpaid: "destructive",
  partial: "warning",
  cancelled: "destructive",
};
const paymentLabels: Record<string, string> = {
  paid: "Платена",
  unpaid: "Неплатена",
  partial: "Частично",
  cancelled: "Анулирана",
};
const documentTypeLabels: Record<string, string> = {
  invoice: "Фактура",
  credit_note: "Кредитно известие",
};

export function Invoices() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusFromUrl = searchParams.get("status") || "";
  const highlightNumber = searchParams.get("highlight") || "";
  const highlightId = searchParams.get("highlight_id");
  const [statusFilter, setStatusFilter] = useState(statusFromUrl);
  const [highlightedRowId, setHighlightedRowId] = useState<number | null>(null);
  const highlightRowRef = useRef<HTMLTableRowElement | null>(null);
  const [creditNoteModal, setCreditNoteModal] = useState<Invoice | null>(null);
  const [creditNoteReason, setCreditNoteReason] = useState("");
  const [creditNoteIncludeVat, setCreditNoteIncludeVat] = useState(true);
  const [cancelModal, setCancelModal] = useState<Invoice | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const [printingId, setPrintingId] = useState<number | null>(null);
  const [filters, setFilters] = useState({
    search: highlightNumber,
    date_from: "",
    date_to: "",
  });
  // Debounce the free-text search so typing doesn't hammer the API
  const debouncedSearch = useDebouncedValue(filters.search, 300);
  const [payInvoice, setPayInvoice] = useState<Invoice | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState("bank");
  const [payRef, setPayRef] = useState("");
  const [payDate, setPayDate] = useState(
    new Date().toISOString().split("T")[0],
  );
  const [feedbackMsg, setFeedbackMsg] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const {
    data: allInvoices = [],
    isLoading,
    error,
  } = useQuery<Invoice[]>({
    queryKey: [
      "invoices",
      statusFilter,
      debouncedSearch,
      filters.date_from,
      filters.date_to,
    ],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("limit", "100");
      if (statusFilter === "cancelled") {
        params.set("status", "cancelled");
      } else if (statusFilter && statusFilter !== "storno") {
        // "storno" is filtered client-side — don't send as backend param
        params.set("payment_status", statusFilter);
      }
      if (debouncedSearch.trim()) {
        params.set("q", debouncedSearch.trim());
      }
      if (filters.date_from) {
        params.set("date_from", filters.date_from);
      }
      if (filters.date_to) {
        params.set("date_to", filters.date_to);
      }

      return api.get(`/invoices?${params.toString()}`).then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      });
    },
    refetchInterval: 30000,
  });

  // Tab-specific filters applied on top of the backend response:
  //   * "storno" — само фактури с издадено КИ + самите КИ.
  //   * "paid"/"unpaid" — изключваме сторнираните (backend смята
  //     КИ за "paid" защото 0 ≥ -32.02, а сторнираната фактура
  //     макар и с плащане не бива да се брои като реално платена,
  //     защото е обърната от КИ). Тези редове живеят само в
  //     "Сторнирани" таб, иначе се double-count-ват.
  //   * "" (Всички) и "cancelled" — backend-ът вече филтрира.
  const invoices = (() => {
    if (statusFilter === "storno") {
      return allInvoices.filter(
        (inv) =>
          Boolean(inv.credit_note_id) || inv.document_type === "credit_note",
      );
    }
    if (
      statusFilter === "paid" ||
      statusFilter === "unpaid" ||
      statusFilter === "partial"
    ) {
      return allInvoices.filter(
        (inv) => !inv.credit_note_id && inv.document_type !== "credit_note",
      );
    }
    return allInvoices;
  })();

  // When opened with ?highlight=GF-... or ?highlight_id=X from another page,
  // find the invoice row, scroll to it, and pulse-highlight for a few seconds.
  useEffect(() => {
    if (!highlightNumber && !highlightId) return;
    if (allInvoices.length === 0) return;
    const match = allInvoices.find(
      (inv) =>
        (highlightId && String(inv.id) === highlightId) ||
        (highlightNumber && inv.invoice_number === highlightNumber),
    );
    if (!match) return;
    setHighlightedRowId(match.id);
    // Scroll into view after DOM updates
    setTimeout(() => {
      highlightRowRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 50);
    // Remove URL params so refresh doesn't re-trigger
    const next = new URLSearchParams(searchParams);
    next.delete("highlight");
    next.delete("highlight_id");
    setSearchParams(next, { replace: true });
    // Fade out the highlight after 1.5s — filter already singles out the row
    const timer = setTimeout(() => setHighlightedRowId(null), 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allInvoices.length]);

  const sendEmailMutation = useMutation({
    mutationFn: (id: number) => api.post(`/invoices/${id}/send-email`),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      const inv = allInvoices.find((i) => i.id === id);
      showFeedback(
        "success",
        `Фактура ${inv?.invoice_number ?? id} изпратена по имейл`,
      );
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.error || "Грешка при изпращане на имейл";
      showFeedback("error", msg);
    },
  });

  const markSentMutation = useMutation({
    mutationFn: (id: number) => api.patch(`/invoices/${id}/mark-sent`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invoices"] }),
  });

  const creditNoteMutation = useMutation({
    mutationFn: (data: {
      related_invoice_id: number;
      reason: string;
      include_vat: boolean;
    }) => api.post("/invoices/credit-note", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      setCreditNoteModal(null);
      setCreditNoteReason("");
    },
  });

  const cancelInvoiceMutation = useMutation({
    mutationFn: (data: { id: number; reason: string }) =>
      api.post(`/invoices/${data.id}/cancel`, { reason: data.reason }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      const inv = allInvoices.find((i) => i.id === vars.id);
      showFeedback(
        "success",
        `Фактура ${inv?.invoice_number ?? vars.id} е анулирана`,
      );
      setCancelModal(null);
      setCancelReason("");
    },
    onError: (err: any) => {
      const msg =
        err?.response?.data?.error || "Грешка при анулиране на фактура";
      showFeedback("error", msg);
    },
  });

  const regenerateMutation = useMutation({
    mutationFn: (id: number) => api.put(`/invoices/${id}/regenerate`),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      const inv = allInvoices.find((i) => i.id === id);
      showFeedback(
        "success",
        `PDF за ${inv?.invoice_number ?? id} е генериран отново`,
      );
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.error || "Грешка при генериране на PDF";
      showFeedback("error", msg);
    },
  });

  const payMutation = useMutation({
    mutationFn: () =>
      api.post("/payments", {
        invoice_id: payInvoice!.id,
        amount: Number(payAmount),
        payment_method: payMethod,
        bank_reference: payRef || undefined,
        paid_at: payDate,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["unpaid-invoices"] });
      showFeedback(
        "success",
        `Плащане записано за ${payInvoice?.invoice_number}`,
      );
      setPayInvoice(null);
      setPayAmount("");
      setPayRef("");
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.error || "Грешка при запис на плащане";
      showFeedback("error", msg);
    },
  });

  const openPayModal = (inv: Invoice) => {
    setPayInvoice(inv);
    // Calculate remaining amount
    const remaining = Number(inv.total_gross) - Number(inv.paid_amount ?? 0);
    setPayAmount(
      remaining > 0 ? remaining.toFixed(2) : String(inv.total_gross),
    );
    setPayMethod("bank");
    setPayRef("");
    setPayDate(new Date().toISOString().split("T")[0]);
  };

  const showFeedback = (type: "success" | "error", text: string) => {
    setFeedbackMsg({ type, text });
    setTimeout(() => setFeedbackMsg(null), 4000);
  };

  const handleDownload = async (invoice: Invoice) => {
    setDownloadingId(invoice.id);
    try {
      // Cache-buster — regenerated PDFs live at the same URL; without
      // this the browser would hand back the stale blob.
      const res = await api.get(`/invoices/${invoice.id}/pdf?t=${Date.now()}`, {
        responseType: "blob",
      });
      const blob = new Blob([res.data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${invoice.invoice_number}.pdf`;
      document.body.appendChild(link);
      link.click();
      // Revoke after a short delay so the browser can start the download
      setTimeout(() => {
        URL.revokeObjectURL(url);
        document.body.removeChild(link);
      }, 150);
      showFeedback("success", `PDF ${invoice.invoice_number} изтеглен`);
    } catch (err: any) {
      if (err?.response?.status === 404) {
        showFeedback(
          "error",
          `PDF за ${invoice.invoice_number} не е наличен. Натиснете бутона ⟳ за да го генерирате отново.`,
        );
      } else {
        showFeedback("error", "Грешка при изтегляне на PDF");
      }
    } finally {
      setDownloadingId(null);
    }
  };

  const handlePrint = async (invoice: Invoice) => {
    setPrintingId(invoice.id);
    try {
      const res = await api.get(`/invoices/${invoice.id}/pdf?t=${Date.now()}`, {
        responseType: "blob",
      });
      const blob = new Blob([res.data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      // Use an iframe to avoid popup blockers (window.open after await is blocked)
      const iframe = document.createElement("iframe");
      iframe.style.display = "none";
      iframe.src = url;
      document.body.appendChild(iframe);
      iframe.onload = () => {
        try {
          iframe.contentWindow?.print();
        } catch {
          // Fallback: open in new tab via link click (more reliable than window.open)
          const link = document.createElement("a");
          link.href = url;
          link.target = "_blank";
          link.rel = "noopener";
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        }
      };
      // Clean up after a reasonable delay
      setTimeout(() => {
        URL.revokeObjectURL(url);
        if (iframe.parentNode) document.body.removeChild(iframe);
      }, 60000);
      showFeedback("success", `PDF ${invoice.invoice_number} отворен за печат`);
    } catch (err: any) {
      if (err?.response?.status === 404) {
        showFeedback(
          "error",
          `PDF за ${invoice.invoice_number} не е наличен. Натиснете бутона ⟳ за да го генерирате отново.`,
        );
      } else {
        showFeedback("error", "Грешка при отваряне за печат");
      }
    } finally {
      setPrintingId(null);
    }
  };

  const openCreditNoteModal = (inv: Invoice) => {
    setCreditNoteModal(inv);
    setCreditNoteReason("");
    setCreditNoteIncludeVat(inv.include_vat !== false);
  };

  const submitCreditNote = () => {
    if (!creditNoteModal || !creditNoteReason.trim()) return;
    creditNoteMutation.mutate({
      related_invoice_id: creditNoteModal.id,
      reason: creditNoteReason.trim(),
      include_vat: creditNoteIncludeVat,
    });
  };

  const openCancelModal = (inv: Invoice) => {
    setCancelModal(inv);
    setCancelReason("");
  };

  const submitCancelInvoice = () => {
    if (!cancelModal || !cancelReason.trim()) return;
    cancelInvoiceMutation.mutate({
      id: cancelModal.id,
      reason: cancelReason.trim(),
    });
  };

  const totalUnpaid = allInvoices
    .filter(
      (i) => i.payment_status === "unpaid" && i.document_type !== "credit_note",
    )
    .reduce((s, i) => s + i.total_gross, 0);

  // Check if a credit note already exists for an invoice
  const hasCreditNote = (invoiceId: number) =>
    allInvoices.some(
      (i) =>
        i.related_invoice_id === invoiceId && i.document_type === "credit_note",
    );

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Фактури</h1>
          <p className="text-gray-500 text-sm mt-1">
            Архив на издадените фактури и кредитни известия
          </p>
        </div>
        {totalUnpaid > 0 && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-2 text-sm text-red-700">
            Неплатени:{" "}
            <span className="font-bold">{formatCurrency(totalUnpaid)}</span>
          </div>
        )}
      </div>

      {/* Status filter + search */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div className="flex gap-2">
            {[
              { value: "", label: "Всички" },
              { value: "unpaid", label: "Неплатени" },
              { value: "partial", label: "Частично платени" },
              { value: "paid", label: "Платени" },
              { value: "storno", label: "Сторнирани" },
              { value: "cancelled", label: "Анулирани" },
            ].map((f) => (
              <button
                key={f.value}
                onClick={() => setStatusFilter(f.value)}
                className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  statusFilter === f.value
                    ? "bg-[#f97316] text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Търси по номер или партньор..."
              value={filters.search}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, search: e.target.value }))
              }
              className="pl-9 pr-3 py-1.5 text-sm border rounded-lg w-64 focus:outline-none focus:ring-2 focus:ring-[#f97316]/30 focus:border-[#f97316]"
            />
          </div>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <div className="space-y-1">
            <label className="text-xs text-gray-500">Дата от</label>
            <input
              type="date"
              value={filters.date_from}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, date_from: e.target.value }))
              }
              className="px-3 py-1.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#f97316]/30 focus:border-[#f97316]"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-gray-500">Дата до</label>
            <input
              type="date"
              value={filters.date_to}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, date_to: e.target.value }))
              }
              className="px-3 py-1.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#f97316]/30 focus:border-[#f97316]"
            />
          </div>
          {(filters.search ||
            filters.date_from ||
            filters.date_to ||
            statusFilter !== "all") && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setFilters({ search: "", date_from: "", date_to: "" });
                setStatusFilter("all");
              }}
            >
              Изчисти филтрите
            </Button>
          )}
        </div>
        <p className="text-xs text-gray-500">
          ⟳ регенерира PDF, ако липсва или е остарял. Анулираните фактури
          остават видими с причина и дата на анулиране.
        </p>
      </div>

      {feedbackMsg && (
        <div
          className={`rounded-lg border px-4 py-2 text-sm flex items-center gap-2 ${
            feedbackMsg.type === "success"
              ? "bg-green-50 border-green-200 text-green-700"
              : "bg-red-50 border-red-200 text-red-700"
          }`}
        >
          {feedbackMsg.type === "success" ? (
            <CheckCircle className="h-4 w-4" />
          ) : (
            <XCircle className="h-4 w-4" />
          )}
          {feedbackMsg.text}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <LoadingOverlay />
          ) : error ? (
            <div className="p-4">
              <ErrorMessage message="Грешка при зареждане" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Тип</TableHead>
                  <TableHead>Номер</TableHead>
                  <TableHead>Партньор</TableHead>
                  <TableHead>Дата на фактура</TableHead>
                  <TableHead>Нето</TableHead>
                  <TableHead>ДДС</TableHead>
                  <TableHead>Общо</TableHead>
                  <TableHead>Плащане</TableHead>
                  <TableHead>Изпращане</TableHead>
                  <TableHead className="text-right">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={10}
                      className="text-center text-gray-400 py-8"
                    >
                      Няма фактури
                    </TableCell>
                  </TableRow>
                ) : (
                  invoices.map((inv) => {
                    const isCancelled = inv.status === "cancelled";
                    const isCreditNote = inv.document_type === "credit_note";
                    const hasCN = Boolean(inv.credit_note_id);
                    const isHighlighted = highlightedRowId === inv.id;

                    return (
                      <TableRow
                        key={inv.id}
                        ref={isHighlighted ? highlightRowRef : undefined}
                        className={`transition-colors duration-500 ${
                          isHighlighted
                            ? "bg-amber-100 ring-2 ring-amber-400 ring-inset"
                            : isCreditNote
                              ? "bg-red-50/50"
                              : isCancelled
                                ? "bg-gray-100 opacity-70"
                                : hasCN
                                  ? "bg-orange-50"
                                  : ""
                        }`}
                      >
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <Badge
                              variant={
                                inv.document_type === "credit_note"
                                  ? "destructive"
                                  : "secondary"
                              }
                              className="text-xs w-fit"
                            >
                              {inv.document_type === "credit_note"
                                ? "КИ"
                                : "Ф-ра"}
                            </Badge>
                            <span className="text-xs text-gray-500">
                              {documentTypeLabels[
                                inv.document_type ?? "invoice"
                              ] ?? "Фактура"}
                            </span>
                            {isCreditNote && inv.related_invoice_id && (
                              <button
                                type="button"
                                onClick={() => {
                                  setFilters((f) => ({
                                    ...f,
                                    search: inv.related_invoice_number ?? "",
                                  }));
                                  setHighlightedRowId(inv.related_invoice_id!);
                                }}
                                className="text-xs text-red-700 hover:underline"
                                title="Отиди към оригиналната фактура"
                              >
                                към фактура{" "}
                                <span className="font-mono font-medium">
                                  {inv.related_invoice_number ??
                                    `#${inv.related_invoice_id}`}
                                </span>
                              </button>
                            )}
                            {hasCN && (
                              <button
                                type="button"
                                onClick={() => {
                                  setFilters((f) => ({
                                    ...f,
                                    search: inv.credit_note_number ?? "",
                                  }));
                                  setHighlightedRowId(inv.credit_note_id!);
                                }}
                                className="text-xs text-orange-700 hover:underline flex items-center gap-1 w-fit"
                                title="Отвори кредитното известие"
                              >
                                <RotateCcw className="h-3 w-3" />
                                Сторнирана с{" "}
                                <span className="font-mono font-medium">
                                  {inv.credit_note_number ??
                                    `КИ-${inv.credit_note_id}`}
                                </span>
                              </button>
                            )}
                            {isCancelled && (
                              <Badge
                                variant="destructive"
                                className="text-xs w-fit"
                              >
                                Анулирана
                              </Badge>
                            )}
                            {inv.include_vat === false && (
                              <Badge
                                variant="warning"
                                className="text-xs w-fit bg-yellow-100 text-yellow-800 border-yellow-300"
                              >
                                Без ДДС
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            <div className="font-mono font-medium text-[#f97316]">
                              {inv.invoice_number}
                            </div>
                            {isCancelled && (
                              <div className="text-xs text-red-600 space-y-0.5">
                                <div>
                                  Анулирана на{" "}
                                  {inv.cancelled_at
                                    ? formatDate(inv.cancelled_at)
                                    : "—"}
                                </div>
                                {inv.cancel_reason && (
                                  <div className="text-red-500">
                                    Причина: {inv.cancel_reason}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {inv.partner?.name ??
                            inv.partner_name ??
                            `#${inv.partner_id}`}
                        </TableCell>
                        <TableCell>{formatDate(inv.invoice_date)}</TableCell>
                        <TableCell>{formatCurrency(inv.total_net)}</TableCell>
                        <TableCell>{formatCurrency(inv.total_vat)}</TableCell>
                        <TableCell className="font-bold">
                          {formatCurrency(inv.total_gross)}
                        </TableCell>
                        <TableCell>
                          {isCreditNote ? (
                            <Badge variant="destructive" className="text-xs">
                              Сторно
                            </Badge>
                          ) : hasCN ? (
                            <Badge
                              variant="warning"
                              className="text-xs bg-orange-100 text-orange-700 border-orange-300"
                            >
                              Сторнирана
                            </Badge>
                          ) : (
                            <Badge
                              variant={
                                paymentVariants[
                                  isCancelled
                                    ? "cancelled"
                                    : (inv.payment_status ?? "unpaid")
                                ] ?? "secondary"
                              }
                            >
                              {
                                paymentLabels[
                                  isCancelled
                                    ? "cancelled"
                                    : (inv.payment_status ?? "unpaid")
                                ]
                              }
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {isCancelled ? (
                            <span className="text-xs text-gray-400">
                              анулирана
                            </span>
                          ) : inv.sent_at ? (
                            <div className="flex items-center gap-1 text-green-600 text-sm">
                              <CheckCircle className="h-3.5 w-3.5" />
                              {formatDate(inv.sent_at)}
                            </div>
                          ) : (
                            <button
                              onClick={() => markSentMutation.mutate(inv.id)}
                              disabled={markSentMutation.isPending}
                              className="flex items-center gap-1 text-gray-400 hover:text-[#f97316] text-sm transition-colors"
                              title="Маркирай като изпратена"
                            >
                              <span className="text-gray-300">—</span>
                            </button>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {inv.document_type !== "credit_note" &&
                              !isCancelled && (
                                <Tooltip content="Генерирай PDF отново">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      regenerateMutation.mutate(inv.id)
                                    }
                                    disabled={regenerateMutation.isPending}
                                    className="text-orange-600 hover:text-orange-700"
                                  >
                                    {regenerateMutation.isPending ? (
                                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-orange-300 border-t-orange-600" />
                                    ) : (
                                      <RefreshCw className="h-4 w-4" />
                                    )}
                                  </Button>
                                </Tooltip>
                              )}
                            <Tooltip content="Принтирай">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handlePrint(inv)}
                                disabled={printingId === inv.id}
                              >
                                {printingId === inv.id ? (
                                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
                                ) : (
                                  <Printer className="h-4 w-4" />
                                )}
                              </Button>
                            </Tooltip>
                            <Tooltip content="Изтегли PDF">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleDownload(inv)}
                                disabled={downloadingId === inv.id}
                              >
                                {downloadingId === inv.id ? (
                                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
                                ) : (
                                  <Download className="h-4 w-4" />
                                )}
                              </Button>
                            </Tooltip>
                            {!inv.sent_at && !isCancelled && (
                              <Tooltip content="Изпрати по имейл">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    sendEmailMutation.mutate(inv.id)
                                  }
                                  disabled={sendEmailMutation.isPending}
                                >
                                  <Send className="h-4 w-4" />
                                </Button>
                              </Tooltip>
                            )}
                            {/* Quick pay button — for unpaid/partial invoices */}
                            {inv.document_type !== "credit_note" &&
                              !isCancelled &&
                              inv.payment_status !== "paid" && (
                                <Tooltip content="Запиши плащане">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => openPayModal(inv)}
                                    className="text-green-600 hover:text-green-700"
                                  >
                                    <Banknote className="h-4 w-4" />
                                  </Button>
                                </Tooltip>
                              )}
                            {inv.document_type !== "credit_note" &&
                              !isCancelled &&
                              !hasCreditNote(inv.id) && (
                                <Tooltip content="Издай кредитно известие (сторниране)">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => openCreditNoteModal(inv)}
                                    className="text-red-600 hover:text-red-700"
                                  >
                                    <RotateCcw className="h-4 w-4" />
                                  </Button>
                                </Tooltip>
                              )}
                            <Can permission={PERMISSIONS.INVOICES_CANCEL}>
                              {inv.document_type !== "credit_note" &&
                                !isCancelled &&
                                Number(inv.paid_amount ?? 0) <= 0.001 &&
                                !hasCreditNote(inv.id) && (
                                  <Tooltip content="Анулирай фактура">
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => openCancelModal(inv)}
                                      className="text-red-700 hover:text-red-800"
                                    >
                                      <XCircle className="h-4 w-4" />
                                    </Button>
                                  </Tooltip>
                                )}
                            </Can>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Credit Note Modal */}
      {creditNoteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
            <h2 className="text-lg font-bold mb-4">Издай кредитно известие</h2>
            <p className="text-sm text-gray-600 mb-4">
              Към фактура:{" "}
              <span className="font-mono font-bold">
                {creditNoteModal.invoice_number}
              </span>
              <br />
              Сума:{" "}
              <span className="font-bold">
                {formatCurrency(creditNoteModal.total_gross)}
              </span>
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Основание
                </label>
                <textarea
                  className="w-full border rounded-md p-2 text-sm"
                  rows={3}
                  maxLength={500}
                  value={creditNoteReason}
                  onChange={(e) => setCreditNoteReason(e.target.value)}
                  placeholder="Опишете причината за кредитното известие..."
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="cn-include-vat"
                  checked={creditNoteIncludeVat}
                  onChange={(e) => setCreditNoteIncludeVat(e.target.checked)}
                  className="rounded"
                />
                <label htmlFor="cn-include-vat" className="text-sm">
                  Включи ДДС
                </label>
              </div>

              {!creditNoteIncludeVat && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-md p-2 text-sm text-yellow-800">
                  Документ без ДДС
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <Button
                variant="outline"
                onClick={() => setCreditNoteModal(null)}
              >
                Отказ
              </Button>
              <Button
                variant="destructive"
                onClick={submitCreditNote}
                disabled={
                  !creditNoteReason.trim() || creditNoteMutation.isPending
                }
              >
                {creditNoteMutation.isPending ? "Създаване..." : "Издай КИ"}
              </Button>
            </div>

            {creditNoteMutation.isError && (
              <p className="text-sm text-red-600 mt-2">
                Грешка при създаване на кредитно известие
              </p>
            )}
          </div>
        </div>
      )}

      {/* Invoice Cancel Modal */}
      {cancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
            <h2 className="text-lg font-bold mb-4">Анулирай фактура</h2>
            <p className="text-sm text-gray-600 mb-4">
              Фактура:{" "}
              <span className="font-mono font-bold">
                {cancelModal.invoice_number}
              </span>
              <br />
              Сума:{" "}
              <span className="font-bold">
                {formatCurrency(cancelModal.total_gross)}
              </span>
            </p>

            <div>
              <label className="block text-sm font-medium mb-1">
                Причина за анулиране
              </label>
              <textarea
                className="w-full border rounded-md p-2 text-sm"
                rows={4}
                maxLength={500}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Опишете причината за анулиране..."
              />
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <Button variant="outline" onClick={() => setCancelModal(null)}>
                Отказ
              </Button>
              <Button
                variant="destructive"
                onClick={submitCancelInvoice}
                disabled={
                  cancelReason.trim().length < 3 ||
                  cancelInvoiceMutation.isPending
                }
              >
                {cancelInvoiceMutation.isPending ? "Анулиране..." : "Анулирай"}
              </Button>
            </div>

            {cancelInvoiceMutation.isError && (
              <p className="text-sm text-red-600 mt-2">
                Грешка при анулиране на фактура
              </p>
            )}
          </div>
        </div>
      )}

      {/* Payment Modal */}
      {payInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
            <h2 className="text-lg font-bold mb-4">Запиши плащане</h2>
            <p className="text-sm text-gray-600 mb-4">
              Фактура:{" "}
              <span className="font-mono font-bold">
                {payInvoice.invoice_number}
              </span>
              {" — "}
              <span className="font-bold">
                {formatCurrency(payInvoice.total_gross)}
              </span>
              {payInvoice.paid_amount && Number(payInvoice.paid_amount) > 0 && (
                <>
                  <br />
                  <span className="text-green-600">
                    Платено: {formatCurrency(Number(payInvoice.paid_amount))}
                  </span>
                  {" · "}
                  <span className="text-red-600">
                    Остатък:{" "}
                    {formatCurrency(
                      Number(payInvoice.total_gross) -
                        Number(payInvoice.paid_amount),
                    )}
                  </span>
                </>
              )}
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Сума (EUR)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  className="w-full border rounded-md p-2 text-sm"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  Метод на плащане
                </label>
                <select
                  className="w-full border rounded-md p-2 text-sm"
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value)}
                >
                  <option value="bank">Банков превод</option>
                  <option value="cash">В брой</option>
                  <option value="card">Карта</option>
                </select>
              </div>

              {payMethod === "bank" && (
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Банкова референция
                  </label>
                  <input
                    type="text"
                    className="w-full border rounded-md p-2 text-sm"
                    value={payRef}
                    onChange={(e) => setPayRef(e.target.value)}
                    placeholder="Номер на платежно нареждане..."
                  />
                </div>
              )}

              <div>
                <label className="block text-sm font-medium mb-1">
                  Дата на плащане
                </label>
                <input
                  type="date"
                  className="w-full border rounded-md p-2 text-sm"
                  value={payDate}
                  onChange={(e) => setPayDate(e.target.value)}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <Button variant="outline" onClick={() => setPayInvoice(null)}>
                Отказ
              </Button>
              <Button
                onClick={() => payMutation.mutate()}
                disabled={
                  !payAmount || Number(payAmount) <= 0 || payMutation.isPending
                }
                className="bg-green-600 hover:bg-green-700 text-white"
              >
                {payMutation.isPending ? "Записване..." : "Запиши плащане"}
              </Button>
            </div>

            {payMutation.isError && (
              <p className="text-sm text-red-600 mt-2">
                Грешка при запис на плащане
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
