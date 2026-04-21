import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, CreditCard, Search } from "lucide-react";
import { api } from "@/lib/api";
import type { Payment, Invoice } from "@/types";
import { formatDate, formatCurrency, formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { LoadingOverlay, ErrorMessage, Spinner } from "@/components/ui/spinner";

const methodLabels: Record<string, string> = {
  cash: "В брой",
  bank: "Банков превод",
  card: "Карта",
};
const methodVariants: Record<string, "success" | "info" | "default"> = {
  cash: "success",
  bank: "info",
  card: "default",
};

const getInvoiceRemaining = (invoice: Invoice): number => {
  if (typeof invoice.remaining === "number") return invoice.remaining;
  const paid = Number(invoice.paid_amount ?? 0);
  return Number(invoice.total_gross) - paid;
};

function RecordPaymentModal({
  open,
  onClose,
  unpaidInvoices,
}: {
  open: boolean;
  onClose: () => void;
  unpaidInvoices: Invoice[];
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    invoice_id: "",
    amount: "",
    payment_method: "bank",
    bank_reference: "",
    paid_at: new Date().toISOString().split("T")[0],
  });

  // Reset form (especially paid_at) to current date when dialog opens
  useEffect(() => {
    if (open) {
      setForm({
        invoice_id: "",
        amount: "",
        payment_method: "bank",
        bank_reference: "",
        paid_at: new Date().toISOString().split("T")[0],
      });
    }
  }, [open]);

  const selectedInvoice = unpaidInvoices.find(
    (i) => i.id === Number(form.invoice_id),
  );

  const mutation = useMutation({
    mutationFn: () =>
      api.post("/payments", {
        invoice_id: Number(form.invoice_id),
        amount: Number(form.amount),
        payment_method: form.payment_method,
        bank_reference: form.bank_reference || undefined,
        paid_at: form.paid_at,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["unpaid-invoices"] });
      onClose();
    },
  });

  const set = (f: string, v: string) =>
    setForm((prev) => ({ ...prev, [f]: v }));

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle>Запиши плащане</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto min-h-0 space-y-4 py-2 pr-1">
          <div className="space-y-1.5">
            <Label>Фактура</Label>
            <Combobox
              items={unpaidInvoices.map((inv) => ({
                value: String(inv.id),
                label: `${inv.invoice_number} — ${inv.partner?.name ?? inv.partner_name ?? `#${inv.partner_id}`}`,
                hint: `Остатък ${formatCurrency(getInvoiceRemaining(inv))}`,
              }))}
              value={form.invoice_id}
              onChange={(val) => {
                const inv = unpaidInvoices.find((i) => i.id === Number(val));
                set("invoice_id", val);
                if (inv) set("amount", getInvoiceRemaining(inv).toFixed(2));
              }}
              onClear={() => set("invoice_id", "")}
              placeholder="Избери или потърси фактура..."
              emptyMessage="Няма намерени неплатени фактури."
            />
          </div>
          {selectedInvoice && (
            <div className="rounded-lg bg-gray-50 p-3 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-gray-500">Партньор:</span>
                <span className="font-medium">
                  {selectedInvoice.partner?.name ??
                    selectedInvoice.partner_name ??
                    `#${selectedInvoice.partner_id}`}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Дата:</span>
                <span>{formatDate(selectedInvoice.invoice_date)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Остатък:</span>
                <span className="font-bold text-[#f97316]">
                  {formatCurrency(getInvoiceRemaining(selectedInvoice))}
                </span>
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Сума</Label>
              <Input
                type="number"
                step="0.01"
                value={form.amount}
                onChange={(e) => set("amount", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Дата</Label>
              <Input
                type="date"
                value={form.paid_at}
                onChange={(e) => set("paid_at", e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Начин на плащане</Label>
            <Select
              value={form.payment_method}
              onChange={(e) => set("payment_method", e.target.value)}
            >
              <option value="bank">Банков превод</option>
              <option value="cash">В брой</option>
              <option value="card">Карта</option>
            </Select>
          </div>
          {form.payment_method === "bank" && (
            <div className="space-y-1.5">
              <Label>Банкова референция</Label>
              <Input
                value={form.bank_reference}
                onChange={(e) => set("bank_reference", e.target.value)}
              />
            </div>
          )}
        </div>
        {mutation.error && <ErrorMessage message="Грешка при запазване" />}
        <DialogFooter className="gap-2 shrink-0">
          <Button variant="outline" onClick={onClose}>
            Отказ
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !form.invoice_id || !form.amount}
          >
            {mutation.isPending ? (
              <>
                <Spinner size="sm" />
                Запазване...
              </>
            ) : (
              "Запиши плащане"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Payments() {
  const [modalOpen, setModalOpen] = useState(false);
  const [filters, setFilters] = useState({
    search: "",
    payment_method: "all",
    date_from: "",
    date_to: "",
  });

  const {
    data: payments = [],
    isLoading,
    error,
  } = useQuery<Payment[]>({
    queryKey: ["payments", filters],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("limit", "100");
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
      api.get("/invoices/unpaid?limit=100").then((r) => {
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

  const totalReceived = payments.reduce((s, p) => s + safeAmount(p.amount), 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Плащания</h1>
          <p className="text-gray-500 text-sm mt-1">История на плащанията</p>
        </div>
        <Button onClick={() => setModalOpen(true)}>
          <Plus className="h-4 w-4" />
          Запиши плащане
        </Button>
      </div>

      {/* Summary */}
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
        <div className="rounded-xl bg-orange-50 border border-orange-200 p-4">
          <p className="text-sm text-orange-600">Общо транзакции</p>
          <p className="text-2xl font-bold text-orange-700 mt-1">
            {payments.length}
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
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
                <option value="card">Карта</option>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Дата от</Label>
              <Input
                type="date"
                value={filters.date_from}
                onChange={(e) =>
                  setFilters((prev) => ({ ...prev, date_from: e.target.value }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Дата до</Label>
              <Input
                type="date"
                value={filters.date_to}
                onChange={(e) =>
                  setFilters((prev) => ({ ...prev, date_to: e.target.value }))
                }
              />
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setFilters({
                  search: "",
                  payment_method: "all",
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
                  <TableHead>Фактура</TableHead>
                  <TableHead>Партньор</TableHead>
                  <TableHead>Дата</TableHead>
                  <TableHead>Начин</TableHead>
                  <TableHead>Референция</TableHead>
                  <TableHead>Сума</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead>Агент</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="text-center text-gray-400 py-8"
                    >
                      Няма плащания
                    </TableCell>
                  </TableRow>
                ) : (
                  payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-mono text-[#f97316]">
                        {p.invoice?.invoice_number ??
                          p.invoice_number ??
                          `#${p.invoice_id}`}
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
                            p.invoice_total_gross ?? p.invoice?.total_gross,
                          );
                          const paid = safeAmount(p.invoice_paid_total);
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
        unpaidInvoices={unpaidInvoices}
      />
    </div>
  );
}
