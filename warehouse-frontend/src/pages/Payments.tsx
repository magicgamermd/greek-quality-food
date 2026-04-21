import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { api } from "@/lib/api";
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
import { RecordPaymentModal } from "@/components/RecordPaymentModal";

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

export function Payments() {
  const [modalOpen, setModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"invoice" | "razpiska">("invoice");
  const [razpiskaUnlocked, setRazpiskaUnlocked] = useState<boolean>(
    () => sessionStorage.getItem("razpiska_tab_unlocked") === "true",
  );
  const [filters, setFilters] = useState({
    search: "",
    payment_method: "all",
    date_from: "",
    date_to: "",
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCombo =
        (e.metaKey && e.altKey && e.key.toLowerCase() === "p") ||
        (e.ctrlKey && e.altKey && e.key.toLowerCase() === "p");
      if (!isCombo) return;
      e.preventDefault();
      sessionStorage.setItem("razpiska_tab_unlocked", "true");
      setRazpiskaUnlocked(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const {
    data: payments = [],
    isLoading,
    error,
  } = useQuery<Payment[]>({
    queryKey: ["payments", activeTab, filters],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("limit", "100");
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
                  ? "border-[#f97316] text-[#f97316]"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
              onClick={() => setActiveTab("invoice")}
            >
              Фактурни
            </button>
            <button
              className={`py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "razpiska"
                  ? "border-[#f97316] text-[#f97316]"
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
                        {activeTab === "razpiska"
                          ? `#${p.order_number ?? p.order_id}`
                          : (p.invoice?.invoice_number ??
                            p.invoice_number ??
                            `#${p.invoice_id}`)}
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
    </div>
  );
}
