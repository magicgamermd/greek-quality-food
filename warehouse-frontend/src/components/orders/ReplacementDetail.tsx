import { useMemo } from "react";
import {
  Printer,
  PackageCheck,
  Ban,
  ArrowDownLeft,
  ArrowUpRight,
  RefreshCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import type { Order, OrderItem } from "@/types";

/**
 * ReplacementDetail — used in place of OrderDetailModal's body when the
 * order is a замяна (order.is_replacement === true). Splits the items
 * into "взема се" (give) and "връща се" (return) sections, surfaces the
 * signed difference + payment method, and exposes the three primary
 * actions: print стокова разписка за замяна, отпрати към склад за
 * пакетиране, анулирай замяната.
 *
 * The component is purely presentational — all side effects (PDF fetch,
 * dispatch-to-packing API call, cancel API call) are passed in as
 * callbacks so the parent owns query invalidation and toast handling.
 */

const PAYMENT_LABEL: Record<string, string> = {
  cash: "Брой",
  pos: "POS",
  bank: "Превод",
};

export interface ReplacementDetailProps {
  order: Order;
  /** Print стокова разписка за замяна (parent fetches the PDF blob). */
  onPrintRazpiska: (orderId: number) => void;
  /** Send to warehouse packing — same flow as a normal-order dispatch. */
  onSendToPacking: (orderId: number) => void;
  /** Cancel the replacement (DELETE /orders/:id) — parent handles confirm + API. */
  onCancel: (orderId: number) => void;
  /** True while any of the three actions is in flight (parent-owned). */
  isBusy?: boolean;
}

// Display in EUR via the project-wide formatter (it converts BGN totals
// to EUR using BGN_PER_EUR). Sign is rendered separately by callers.
function formatAmount(amount: number): string {
  return formatCurrency(Math.abs(amount));
}

function lineTotal(item: OrderItem): number {
  const qty = Number(item.quantity) || 0;
  const price = Number(item.unit_price) || 0;
  return Math.round(qty * price * 100) / 100;
}

function ItemsSection({
  title,
  accent,
  items,
  sectionTotal,
  emptyText,
}: {
  title: string;
  accent: "give" | "return";
  items: OrderItem[];
  sectionTotal: number;
  emptyText: string;
}) {
  const isGive = accent === "give";
  const Icon = isGive ? ArrowDownLeft : ArrowUpRight;
  const chipClass = isGive
    ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
    : "bg-rose-50 text-rose-700 border border-rose-200";

  return (
    <div className="rounded-md border bg-white">
      <div className="flex items-center justify-between gap-3 border-b bg-gray-50 px-3 py-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${chipClass}`}
        >
          <Icon className="h-3 w-3" />
          {title}
        </span>
        {items.length > 0 && (
          <span className="text-sm text-gray-600">
            Сума:{" "}
            <span className="font-semibold">{formatAmount(sectionTotal)}</span>
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <div className="px-3 py-3 text-sm italic text-gray-400">
          {emptyText}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Продукт</th>
                <th className="w-24 px-3 py-2 text-right font-medium">К-во</th>
                <th className="w-28 px-3 py-2 text-right font-medium">
                  Ед. цена
                </th>
                <th className="w-28 px-3 py-2 text-right font-medium">Сума</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-t border-gray-100">
                  <td className="px-3 py-2">
                    <div className="font-medium">
                      {it.name_bg ?? it.name_en ?? `#${it.product_id}`}
                    </div>
                    {it.sku && (
                      <div className="text-xs text-gray-400">{it.sku}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {Number(it.quantity).toLocaleString("bg-BG")}
                    {it.unit ? ` ${it.unit}` : ""}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {formatAmount(Number(it.unit_price) || 0)}
                  </td>
                  <td className="px-3 py-2 text-right font-medium">
                    {formatAmount(lineTotal(it))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ReplacementDetail({
  order,
  onPrintRazpiska,
  onSendToPacking,
  onCancel,
  isBusy = false,
}: ReplacementDetailProps) {
  const items: OrderItem[] = order.items ?? [];
  const giveItems = useMemo(
    () => items.filter((i) => !i.is_returning),
    [items],
  );
  const returnItems = useMemo(
    () => items.filter((i) => i.is_returning),
    [items],
  );
  const giveSum = useMemo(
    () => giveItems.reduce((sum, i) => sum + lineTotal(i), 0),
    [giveItems],
  );
  const returnSum = useMemo(
    () => returnItems.reduce((sum, i) => sum + lineTotal(i), 0),
    [returnItems],
  );
  const diff = giveSum - returnSum;
  const isZero = Math.abs(diff) < 0.005;
  const diffLabel = isZero
    ? `${formatCurrency(0)} (равно)`
    : diff > 0
      ? `+${formatAmount(diff)} (клиент доплаща)`
      : `−${formatAmount(diff)} (връщаме на клиент)`;

  const partnerName =
    (order as any).invoice_partner_name ??
    order.partner?.name ??
    order.partner_name ??
    `#${order.partner_id}`;

  const paymentMethod = (order as any).payment_method as string | undefined;
  const paymentLabel = paymentMethod
    ? (PAYMENT_LABEL[paymentMethod] ?? paymentMethod)
    : "—";

  const dispatched = Boolean((order as any).dispatched_to_warehouse_at);
  const cancelled = order.status === "cancelled";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-bold text-gray-900">
            Поръчка #{order.order_number ?? order.id}
          </h2>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-orange-200 bg-orange-50 px-2.5 py-0.5 text-xs font-medium text-orange-700">
            <RefreshCcw className="h-3 w-3" />
            Замяна
          </span>
        </div>
        <span className="text-sm text-gray-600">
          Партньор: <span className="font-medium">{partnerName}</span>
        </span>
      </div>

      <ItemsSection
        title="Взема се"
        accent="give"
        items={giveItems}
        sectionTotal={giveSum}
        emptyText="Няма взети артикули"
      />

      <ItemsSection
        title="Връща се"
        accent="return"
        items={returnItems}
        sectionTotal={returnSum}
        emptyText="Няма върнати артикули"
      />

      <div
        className={`rounded-md border p-3 text-sm ${
          isZero
            ? "border-gray-200 bg-gray-50 text-gray-700"
            : diff > 0
              ? "border-green-200 bg-green-50 text-green-900"
              : "border-red-200 bg-red-50 text-red-900"
        }`}
        role="status"
        aria-live="polite"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            Разлика: <span className="font-semibold">{diffLabel}</span>
          </span>
          {!isZero && (
            <span>
              Метод: <span className="font-medium">{paymentLabel}</span>
            </span>
          )}
          <span>
            Платил: <span className="font-medium">{partnerName}</span>
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 border-t pt-3">
        <Button
          variant="outline"
          onClick={() => onPrintRazpiska(order.id)}
          disabled={isBusy || cancelled}
          title="Изтегли стокова разписка за замяна (PDF)"
        >
          <Printer className="h-4 w-4" />
          Печат Стокова разписка за Замяна
        </Button>
        <Button
          onClick={() => onSendToPacking(order.id)}
          disabled={isBusy || cancelled || dispatched}
          title={
            dispatched
              ? "Вече е изпратена към склада"
              : "Изпрати замяната към склад за пакетиране"
          }
        >
          <PackageCheck className="h-4 w-4" />
          {dispatched ? "Изпратена към склад" : "Към склад пакетиране"}
        </Button>
        <Button
          variant="destructive"
          onClick={() => onCancel(order.id)}
          disabled={isBusy || cancelled}
          title="Анулирай замяната — връща склада в първоначалното състояние"
        >
          <Ban className="h-4 w-4" />
          Анулирай замяна
        </Button>
      </div>
    </div>
  );
}
