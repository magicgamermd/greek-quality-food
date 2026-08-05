import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Printer, Pencil, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { SHOW_ALL_LIMIT } from "@/lib/pagination";
import type { Payment, Invoice } from "@/types";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { RecordPaymentModal } from "@/components/RecordPaymentModal";
import { usePermissions } from "@/contexts/PermissionContext";
import { PERMISSIONS } from "@/lib/permissions";
import { toast } from "@/lib/toast";
import "./Payments.print.css";

/** Return today's date in ISO 8601 format (YYYY-MM-DD) in Europe/Sofia timezone. */
function todayIso(): string {
  return new Date().toLocaleDateString("sv-SE", {
    timeZone: "Europe/Sofia",
  });
}

/** Format ISO YYYY-MM-DD as DD.MM.YYYY. Returns original if parse fails. */
function formatDateBg(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

const methodLabels: Record<string, string> = {
  cash: "В брой",
  bank: "Банков превод",
  cod: "Наложен платеж",
  pos: "ПОС",
};
const methodVariants: Record<
  string,
  "success" | "info" | "default" | "warning"
> = {
  cash: "success",
  bank: "info",
  cod: "warning",
  pos: "default",
};

function exportCsv(payments: Payment[], tab: "invoice" | "razpiska") {
  const headers =
    tab === "razpiska"
      ? ["Поръчка", "Партньор", "Дата", "Начин", "Референция", "Сума", "Статус"]
      : [
          "Фактура",
          "Партньор",
          "Дата",
          "Начин",
          "Референция",
          "Сума",
          "Статус",
        ];

  const rows = payments.map((p) => {
    const amount = Number(p.amount).toFixed(2);
    const totalRaw =
      tab === "razpiska"
        ? p.order_total
        : (p.invoice_total_gross ?? p.invoice?.total_gross);
    const paidRaw =
      tab === "razpiska" ? p.order_paid_total : p.invoice_paid_total;
    const total = Number(totalRaw ?? 0);
    const paid = Number(paidRaw ?? 0);
    const status = total > 0 && paid + 0.01 >= total ? "Платена" : "Частично";
    const ref =
      tab === "razpiska"
        ? `#${p.order_number ?? p.order_id}`
        : (p.invoice_number ?? `#${p.invoice_id}`);
    return [
      ref,
      p.partner_name ?? "",
      p.paid_at,
      p.payment_method,
      p.bank_reference ?? "",
      amount,
      status,
    ];
  });

  const csv = [headers, ...rows]
    .map((row) =>
      row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","),
    )
    .join("\n");

  const blob = new Blob(["﻿" + csv], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `payments-${tab}-${new Date().toISOString().split("T")[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

interface EditPaymentState {
  id: number;
  amount: string;
  payment_method: string;
  bank_reference: string;
}

export function Payments() {
  const queryClient = useQueryClient();
  const { hasPermission } = usePermissions();
  const canManagePayments = hasPermission(PERMISSIONS.PAYMENTS_MANAGE);

  const [modalOpen, setModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"invoice" | "razpiska">("invoice");
  const [razpiskaUnlocked, setRazpiskaUnlocked] = useState<boolean>(
    () => sessionStorage.getItem("razpiska_tab_unlocked") === "true",
  );
  const [filters, setFilters] = useState({
    search: "",
    payment_method: "all",
    status: "all",
    date_from: "",
    date_to: "",
  });

  // Edit dialog state — null when closed
  const [editing, setEditing] = useState<EditPaymentState | null>(null);

  useEffect(() => {
    let lastMinusAt = 0;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (isEditable) return;

      if (e.key === "-") {
        lastMinusAt = Date.now();
        return;
      }
      if ((e.key === "+" || e.key === "=") && Date.now() - lastMinusAt < 1500) {
        lastMinusAt = 0;
        e.preventDefault();
        e.stopPropagation();
        setRazpiskaUnlocked((prev) => {
          const next = !prev;
          if (next) {
            sessionStorage.setItem("razpiska_tab_unlocked", "true");
          } else {
            sessionStorage.removeItem("razpiska_tab_unlocked");
            setActiveTab("invoice");
          }
          return next;
        });
        return;
      }
      lastMinusAt = 0;
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const {
    data: payments = [],
    isLoading,
    error,
  } = useQuery<Payment[]>({
    queryKey: ["payments", activeTab, filters],
    queryFn: () => {
      const params = new URLSearchParams();
      const isOneDay = !!(
        filters.date_from &&
        filters.date_to &&
        filters.date_from === filters.date_to
      );
      params.set("limit", String(SHOW_ALL_LIMIT));
      params.set("type", activeTab);
      if (filters.search.trim()) params.set("q", filters.search.trim());
      if (filters.payment_method !== "all") {
        params.set("payment_method", filters.payment_method);
      }
      if (filters.date_from) params.set("date_from", filters.date_from);
      if (filters.date_to) params.set("date_to", filters.date_to);

      return api.get(`/payments?${params.toString()}`).then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      });
    },
    refetchInterval: 30000,
  });

  const { data: unpaidInvoices = [] } = useQuery<Invoice[]>({
    queryKey: ["unpaid-invoices"],
    queryFn: () =>
      api.get(`/invoices/unpaid?limit=${SHOW_ALL_LIMIT}`).then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      }),
    refetchInterval: 30000,
  });

  const safeAmount = (val: unknown): number => {
    if (typeof val === "number") return Number.isFinite(val) ? val : 0;
    if (typeof val === "string") return parseFloat(val.replace(",", ".")) || 0;
    return 0;
  };

  // Derive payment status using the same logic as exportCsv
  const getPaymentStatus = (
    p: Payment,
    tab: "invoice" | "razpiska",
  ): "paid" | "partial" => {
    const total = safeAmount(
      tab === "razpiska"
        ? p.order_total
        : (p.invoice_total_gross ?? p.invoice?.total_gross),
    );
    const paid = safeAmount(
      tab === "razpiska" ? p.order_paid_total : p.invoice_paid_total,
    );
    return total > 0 && paid + 0.01 >= total ? "paid" : "partial";
  };

  // Client-side status filter — operates on the full payments array
  const visiblePayments = useMemo(() => {
    if (filters.status === "all") return payments;
    return payments.filter(
      (p) => getPaymentStatus(p, activeTab) === filters.status,
    );
  }, [payments, filters.status, activeTab]);

  const totalReceived = payments.reduce((s, p) => s + safeAmount(p.amount), 0);

  const isSingleDay =
    !!filters.date_from &&
    !!filters.date_to &&
    filters.date_from === filters.date_to;

  const cashTotal = payments
    .filter((p) => p.payment_method === "cash")
    .reduce((s, p) => s + safeAmount(p.amount), 0);
  const bankTotal = payments
    .filter((p) => p.payment_method === "bank")
    .reduce((s, p) => s + safeAmount(p.amount), 0);
  const posTotal = payments
    .filter((p) => p.payment_method === "pos")
    .reduce((s, p) => s + safeAmount(p.amount), 0);

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      api.delete(`/payments/${id}`).then((r) => r.data),
    onSuccess: () => {
      toast.success("Плащането е изтрито");
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["unpaid-invoices"] });
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data
          ?.error ?? "Грешка при изтриване";
      toast.error(msg);
    },
  });

  // Edit/update mutation
  const editMutation = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: number;
      body: {
        amount: number;
        payment_method: string;
        bank_reference: string | null;
      };
    }) => api.put(`/payments/${id}`, body).then((r) => r.data),
    onSuccess: () => {
      toast.success("Плащането е обновено");
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["unpaid-invoices"] });
      setEditing(null);
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data
          ?.error ?? "Грешка при редакция";
      toast.error(msg);
    },
  });

  function handleDeleteClick(p: Payment) {
    if (
      !window.confirm(
        "Сигурни ли сте, че искате да изтриете това плащане? Действието е необратимо.",
      )
    )
      return;
    deleteMutation.mutate(p.id);
  }

  function handleEditClick(p: Payment) {
    setEditing({
      id: p.id,
      amount: String(Number(p.amount).toFixed(2)),
      payment_method: p.payment_method,
      bank_reference: p.bank_reference ?? "",
    });
  }

  function handleEditSave() {
    if (!editing) return;
    const amount = parseFloat(editing.amount);
    if (!amount || amount <= 0) {
      toast.error("Невалидна сума");
      return;
    }
    editMutation.mutate({
      id: editing.id,
      body: {
        amount,
        payment_method: editing.payment_method,
        bank_reference: editing.bank_reference.trim() || null,
      },
    });
  }

  return (
    <div className="payments-page p-6 space-y-6">
      <div className="print-only print-title">
        <h1>
          Greek Quality Food — Дневен отчет (
          {activeTab === "invoice" ? "Фактурни" : "По разписки"})
        </h1>
        <p>
          {isSingleDay
            ? formatDateBg(filters.date_from)
            : filters.date_from && filters.date_to
              ? `Период: ${formatDateBg(filters.date_from)} – ${formatDateBg(filters.date_to)}`
              : "Всички плащания"}
        </p>
      </div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Плащания</h1>
          <p className="text-gray-500 text-sm mt-1">История на плащанията</p>
        </div>
        {activeTab === "invoice" && (
          <Button onClick={() => setModalOpen(true)}>
            <Plus className="h-4 w-4" />
            Запиши плащане
          </Button>
        )}
      </div>

      {razpiskaUnlocked && (
        <div className="border-b border-gray-200">
          <nav className="flex gap-6">
            <button
              className={`py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "invoice"
                  ? "border-[#6c3dff] text-[#6c3dff]"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
              onClick={() => setActiveTab("invoice")}
            >
              Фактурни
            </button>
            <button
              className={`py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "razpiska"
                  ? "border-[#6c3dff] text-[#6c3dff]"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
              onClick={() => setActiveTab("razpiska")}
            >
              По разписки
            </button>
          </nav>
        </div>
      )}

      {/* Summary */}
      <div className="summary-cards">
        {isSingleDay ? (
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-4">
            <div className="rounded-xl bg-gray-50 border border-gray-200 p-4">
              <p className="text-sm text-gray-600">За деня</p>
              <p className="text-2xl font-bold text-gray-900 mt-1">
                {formatDateBg(filters.date_from)}
              </p>
            </div>
            <div className="rounded-xl bg-green-50 border border-green-200 p-4">
              <p className="text-sm text-green-600">В брой</p>
              <p className="text-2xl font-bold text-green-700 mt-1">
                {formatCurrency(cashTotal)}
              </p>
            </div>
            <div className="rounded-xl bg-blue-50 border border-blue-200 p-4">
              <p className="text-sm text-blue-600">По банка</p>
              <p className="text-2xl font-bold text-blue-700 mt-1">
                {formatCurrency(bankTotal)}
              </p>
            </div>
            <div className="rounded-xl bg-purple-50 border border-purple-200 p-4">
              <p className="text-sm text-purple-600">ПОС</p>
              <p className="text-2xl font-bold text-purple-700 mt-1">
                {formatCurrency(posTotal)}
              </p>
            </div>
            <div className="rounded-xl bg-violet-50 border border-violet-200 p-4">
              <p className="text-sm text-violet-600">Общо за деня</p>
              <p className="text-2xl font-bold text-violet-700 mt-1">
                {formatCurrency(totalReceived)}
              </p>
              <p className="text-xs text-violet-500 mt-1">
                {payments.length} плащания
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="rounded-xl bg-green-50 border border-green-200 p-4">
              <p className="text-sm text-green-600">Получени плащания</p>
              <p className="text-2xl font-bold text-green-700 mt-1">
                {formatCurrency(totalReceived)}
              </p>
            </div>
            <div className="rounded-xl bg-red-50 border border-red-200 p-4">
              <p className="text-sm text-red-600">Чакащи фактури</p>
              <p className="text-2xl font-bold text-red-700 mt-1">
                {unpaidInvoices.length}
              </p>
            </div>
            <div className="rounded-xl bg-violet-50 border border-violet-200 p-4">
              <p className="text-sm text-violet-600">Общо транзакции</p>
              <p className="text-2xl font-bold text-violet-700 mt-1">
                {payments.length}
              </p>
            </div>
          </div>
        )}
      </div>

      <Card className="filters-card">
        <CardContent className="p-4">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <div className="space-y-1 md:col-span-2">
              <Label className="text-xs">Търсене</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  value={filters.search}
                  onChange={(e) =>
                    setFilters((prev) => ({ ...prev, search: e.target.value }))
                  }
                  placeholder="Фактура, партньор или референция"
                  className="pl-9"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Начин</Label>
              <Select
                value={filters.payment_method}
                onChange={(e) =>
                  setFilters((prev) => ({
                    ...prev,
                    payment_method: e.target.value,
                  }))
                }
              >
                <option value="all">Всички</option>
                <option value="bank">Банков превод</option>
                <option value="cash">В брой</option>
                <option value="pos">ПОС</option>
                <option value="cod">Наложен платеж</option>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Статус</Label>
              <Select
                value={filters.status}
                onChange={(e) =>
                  setFilters((prev) => ({ ...prev, status: e.target.value }))
                }
              >
                <option value="all">Всички</option>
                <option value="paid">Платени</option>
                <option value="partial">Частични</option>
              </Select>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Период</Label>
                <button
                  type="button"
                  className="text-xs text-[#6c3dff] hover:underline"
                  onClick={() => {
                    const t = todayIso();
                    setFilters((prev) => ({
                      ...prev,
                      date_from: t,
                      date_to: t,
                    }));
                  }}
                >
                  Днес
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  type="date"
                  value={filters.date_from}
                  onChange={(e) =>
                    setFilters((prev) => ({
                      ...prev,
                      date_from: e.target.value,
                    }))
                  }
                />
                <Input
                  type="date"
                  value={filters.date_to}
                  onChange={(e) =>
                    setFilters((prev) => ({
                      ...prev,
                      date_to: e.target.value,
                    }))
                  }
                />
              </div>
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => exportCsv(payments, activeTab)}
              disabled={payments.length === 0}
            >
              Експорт CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.print()}
              disabled={payments.length === 0}
            >
              <Printer className="h-4 w-4" />
              Принтирай отчет
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setFilters({
                  search: "",
                  payment_method: "all",
                  status: "all",
                  date_from: "",
                  date_to: "",
                })
              }
            >
              Изчисти филтрите
            </Button>
          </div>
        </CardContent>
      </Card>

      {payments.length >= 500 && (
        <div className="no-print rounded-lg bg-yellow-50 border border-yellow-200 p-3 text-sm text-yellow-800">
          Показват се първите 500 плащания. Ако денят има повече записи, сумите
          в обобщението може да не са пълни. Стеснете периода или филтрите.
        </div>
      )}

      <Card className="payments-table">
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
                  <TableHead>
                    {activeTab === "razpiska" ? "Поръчка" : "Фактура"}
                  </TableHead>
                  <TableHead>Партньор</TableHead>
                  <TableHead>Дата</TableHead>
                  <TableHead>Начин</TableHead>
                  <TableHead>Референция</TableHead>
                  <TableHead>Сума</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead>Агент</TableHead>
                  {canManagePayments && <TableHead>Действия</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visiblePayments.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={canManagePayments ? 9 : 8}
                      className="text-center text-gray-400 py-8"
                    >
                      Няма плащания
                    </TableCell>
                  </TableRow>
                ) : (
                  visiblePayments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-mono text-[#6c3dff]">
                        {(() => {
                          const isCancelled =
                            activeTab === "razpiska"
                              ? p.order_status === "cancelled"
                              : p.invoice_status === "cancelled";
                          const label =
                            activeTab === "razpiska"
                              ? `#${p.order_number ?? p.order_id}`
                              : (p.invoice?.invoice_number ??
                                p.invoice_number ??
                                `#${p.invoice_id}`);
                          return (
                            <span
                              className={
                                isCancelled ? "line-through text-gray-400" : ""
                              }
                            >
                              {label}
                              {isCancelled && (
                                <Badge variant="destructive" className="ml-2">
                                  АНУЛИРАНА
                                </Badge>
                              )}
                            </span>
                          );
                        })()}
                      </TableCell>
                      <TableCell>
                        {p.invoice?.partner?.name ?? p.partner_name ?? "—"}
                      </TableCell>
                      <TableCell>{formatDateTime(p.paid_at)}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            methodVariants[p.payment_method] ?? "secondary"
                          }
                        >
                          {methodLabels[p.payment_method] ?? p.payment_method}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-sm text-gray-500">
                        {p.bank_reference ?? "—"}
                      </TableCell>
                      <TableCell className="font-bold text-green-700">
                        {formatCurrency(p.amount)}
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const total = safeAmount(
                            activeTab === "razpiska"
                              ? p.order_total
                              : (p.invoice_total_gross ??
                                  p.invoice?.total_gross),
                          );
                          const paid = safeAmount(
                            activeTab === "razpiska"
                              ? p.order_paid_total
                              : p.invoice_paid_total,
                          );
                          if (total <= 0 || paid <= 0) return null;
                          if (paid + 0.01 < total) {
                            const remaining = total - paid;
                            return (
                              <Badge
                                variant="warning"
                                title={`Платено ${formatCurrency(paid)} от ${formatCurrency(total)} · остават ${formatCurrency(remaining)}`}
                              >
                                Частично
                              </Badge>
                            );
                          }
                          return <Badge variant="success">Платена</Badge>;
                        })()}
                      </TableCell>
                      <TableCell>
                        {p.matched_by_agent && (
                          <Badge variant="info">AI агент</Badge>
                        )}
                      </TableCell>
                      {canManagePayments && (
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              aria-label="Редактирай плащане"
                              onClick={() => handleEditClick(p)}
                              className="p-1.5 rounded text-gray-500 hover:text-[#6c3dff] hover:bg-violet-50 transition-colors"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              aria-label="Изтрий плащане"
                              onClick={() => handleDeleteClick(p)}
                              disabled={deleteMutation.isPending}
                              className="p-1.5 rounded text-gray-500 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <RecordPaymentModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        context={{ kind: "invoice-select", invoices: unpaidInvoices }}
      />

      {/* Edit payment dialog */}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Редактирай плащане</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="edit-amount">Сума (лв.)</Label>
                <Input
                  id="edit-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={editing.amount}
                  onChange={(e) =>
                    setEditing((prev) =>
                      prev ? { ...prev, amount: e.target.value } : prev,
                    )
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-method">Начин на плащане</Label>
                <Select
                  id="edit-method"
                  value={editing.payment_method}
                  onChange={(e) =>
                    setEditing((prev) =>
                      prev ? { ...prev, payment_method: e.target.value } : prev,
                    )
                  }
                >
                  <option value="cash">{methodLabels.cash}</option>
                  <option value="bank">{methodLabels.bank}</option>
                  <option value="cod">{methodLabels.cod}</option>
                  <option value="pos">{methodLabels.pos}</option>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-ref">Референция (незадължително)</Label>
                <Input
                  id="edit-ref"
                  type="text"
                  placeholder="Банкова референция или друг номер"
                  value={editing.bank_reference}
                  onChange={(e) =>
                    setEditing((prev) =>
                      prev ? { ...prev, bank_reference: e.target.value } : prev,
                    )
                  }
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditing(null)}
              disabled={editMutation.isPending}
            >
              Отказ
            </Button>
            <Button
              onClick={handleEditSave}
              disabled={editMutation.isPending}
              className="bg-[#6c3dff] hover:bg-[#5a2fe0] text-white"
            >
              {editMutation.isPending ? "Записва..." : "Запази"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="print-only print-footer">
        Отпечатано на {formatDateBg(todayIso())}{" "}
        {new Date().toLocaleTimeString("bg-BG", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Europe/Sofia",
        })}
      </div>
    </div>
  );
}
