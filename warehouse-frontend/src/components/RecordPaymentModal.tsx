import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Invoice, Order } from "@/types";
import { formatDate, formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ErrorMessage, Spinner } from "@/components/ui/spinner";

type Context =
  | { kind: "invoice-select"; invoices: Invoice[] }
  | {
      kind: "invoice-fixed";
      invoice_id: number;
      invoice_number?: string;
      partner_name?: string;
      total: number;
    }
  | { kind: "order-fixed"; order: Order };

interface Props {
  open: boolean;
  onClose: () => void;
  context: Context;
}

const getInvoiceRemaining = (inv: Invoice): number => {
  if (typeof inv.remaining === "number") return inv.remaining;
  const paid = Number(inv.paid_amount ?? 0);
  return Number(inv.total_gross) - paid;
};

const VAT_RATE = 0.2;
const getOrderGross = (order: Order): number =>
  Number(order.total_amount) * (1 + VAT_RATE);

export function RecordPaymentModal({ open, onClose, context }: Props) {
  const qc = useQueryClient();
  const orderId = context.kind === "order-fixed" ? context.order.id : null;

  const { data: orderPayments } = useQuery<{ amount: number | string }[]>({
    queryKey: ["order-razpiska-payments", orderId],
    queryFn: () =>
      api
        .get(`/payments?type=razpiska&order_id=${orderId}&limit=100`)
        .then((r) => {
          const d = r.data;
          return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
        }),
    enabled: open && orderId !== null,
  });

  const alreadyPaidOnOrder = (orderPayments ?? []).reduce(
    (sum, p) => sum + Number(p.amount),
    0,
  );

  const [form, setForm] = useState({
    invoice_id: "",
    amount: "",
    payment_method: "bank",
    bank_reference: "",
    paid_at: new Date().toISOString().split("T")[0],
  });

  const didFillOrderRef = useRef(false);
  useEffect(() => {
    if (!open) {
      didFillOrderRef.current = false;
      return;
    }
    const today = new Date().toISOString().split("T")[0];
    if (context.kind === "invoice-fixed") {
      setForm({
        invoice_id: String(context.invoice_id),
        amount: context.total.toFixed(2),
        payment_method: "bank",
        bank_reference: "",
        paid_at: today,
      });
    } else if (context.kind === "order-fixed") {
      if (orderPayments === undefined || didFillOrderRef.current) return;
      const gross = getOrderGross(context.order);
      const remaining = Math.max(0, gross - alreadyPaidOnOrder);
      setForm({
        invoice_id: "",
        amount: remaining.toFixed(2),
        payment_method: "bank",
        bank_reference: "",
        paid_at: today,
      });
      didFillOrderRef.current = true;
    } else {
      setForm({
        invoice_id: "",
        amount: "",
        payment_method: "bank",
        bank_reference: "",
        paid_at: today,
      });
    }
  }, [open, context, orderPayments, alreadyPaidOnOrder]);

  const mutation = useMutation({
    mutationFn: () => {
      const base = {
        amount: Number(form.amount),
        payment_method: form.payment_method,
        bank_reference: form.bank_reference || undefined,
        paid_at: form.paid_at,
      };
      if (context.kind === "order-fixed") {
        return api.post("/payments", { ...base, order_id: context.order.id });
      }
      const invoice_id =
        context.kind === "invoice-fixed"
          ? context.invoice_id
          : Number(form.invoice_id);
      return api.post("/payments", { ...base, invoice_id });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["unpaid-invoices"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      onClose();
    },
  });

  const set = (f: string, v: string) => setForm((p) => ({ ...p, [f]: v }));
  const title =
    context.kind === "order-fixed" ? "Запиши плащане по СР" : "Запиши плащане";

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto min-h-0 space-y-4 py-2 pr-1">
          {context.kind === "invoice-select" && (
            <div className="space-y-1.5">
              <Label>Фактура</Label>
              <Combobox
                items={context.invoices.map((inv) => ({
                  value: String(inv.id),
                  label: `${inv.invoice_number} — ${inv.partner?.name ?? inv.partner_name ?? `#${inv.partner_id}`}`,
                  hint: `Остатък ${formatCurrency(getInvoiceRemaining(inv))}`,
                }))}
                value={form.invoice_id}
                onChange={(val) => {
                  const inv = context.invoices.find(
                    (i) => i.id === Number(val),
                  );
                  set("invoice_id", val);
                  if (inv) set("amount", getInvoiceRemaining(inv).toFixed(2));
                }}
                onClear={() => set("invoice_id", "")}
                placeholder="Избери или потърси фактура..."
                emptyMessage="Няма намерени неплатени фактури."
              />
            </div>
          )}

          {context.kind === "invoice-fixed" && (
            <div className="rounded-lg bg-gray-50 p-3 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-gray-500">Фактура:</span>
                <span className="font-mono font-medium">
                  {context.invoice_number ?? `#${context.invoice_id}`}
                </span>
              </div>
              {context.partner_name && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Партньор:</span>
                  <span className="font-medium">{context.partner_name}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-500">Сума:</span>
                <span className="font-bold text-[#f97316]">
                  {formatCurrency(context.total)}
                </span>
              </div>
            </div>
          )}

          {context.kind === "order-fixed" &&
            (() => {
              const net = Number(context.order.total_amount);
              const vat = net * VAT_RATE;
              const gross = net + vat;
              const remaining = Math.max(0, gross - alreadyPaidOnOrder);
              const hasPriorPayments = alreadyPaidOnOrder > 0;
              return (
                <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Поръчка:</span>
                    <span className="font-mono font-medium">
                      #{context.order.order_number ?? context.order.id}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Партньор:</span>
                    <span className="font-medium">
                      {context.order.partner?.name ??
                        context.order.partner_name ??
                        `#${context.order.partner_id}`}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Дата:</span>
                    <span>{formatDate(context.order.order_date)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Нето:</span>
                    <span>{formatCurrency(net)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">ДДС (20%):</span>
                    <span>{formatCurrency(vat)}</span>
                  </div>
                  <div className="flex justify-between pt-1 border-t border-amber-200">
                    <span className="text-gray-500">Общо с ДДС:</span>
                    <span
                      className={
                        hasPriorPayments
                          ? "font-medium"
                          : "font-bold text-[#f97316]"
                      }
                    >
                      {formatCurrency(gross)}
                    </span>
                  </div>
                  {hasPriorPayments && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Вече платено:</span>
                        <span className="font-medium text-green-700">
                          − {formatCurrency(alreadyPaidOnOrder)}
                        </span>
                      </div>
                      <div className="flex justify-between pt-1 border-t border-amber-200">
                        <span className="text-gray-500">Остатък:</span>
                        <span className="font-bold text-[#f97316]">
                          {formatCurrency(remaining)}
                        </span>
                      </div>
                    </>
                  )}
                  <div className="text-xs text-amber-700 pt-1">
                    Плащане по стокова разписка (без фактура).
                  </div>
                </div>
              );
            })()}

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
            disabled={
              mutation.isPending ||
              !form.amount ||
              (context.kind === "invoice-select" && !form.invoice_id)
            }
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
