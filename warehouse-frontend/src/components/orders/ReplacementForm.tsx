import { useEffect, useMemo, useState, useCallback } from "react";
import AsyncSelect from "react-select/async";
import { Trash2, Package } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency } from "@/lib/utils";

/**
 * ReplacementForm — used by the New Order dialog when "Замяна" mode is on.
 *
 * Renders two item sections (взема се / връща се), each with its own
 * "+ Добави артикул" button. Live-computes the diff and exposes state
 * to the parent via `onChange`. Headless of partner selection — the
 * parent picks the partner and feeds the partnerId in for partner-aware
 * pricing (same `/orders/products-for-order` endpoint Orders.tsx uses,
 * so the catalog and price tier behave identically).
 *
 * Payment method picker is only shown when diff !== 0 (no payment when
 * the swap is even).
 */

export type ReplacementPaymentMethod = "cash" | "pos" | "bank";

export interface ReplacementLineItem {
  product_id: number;
  product_name: string;
  product_code: string;
  quantity: number;
  unit_price: number;
}

export interface ReplacementFormState {
  giveItems: ReplacementLineItem[];
  returnItems: ReplacementLineItem[];
  paymentMethod: ReplacementPaymentMethod;
}

export interface ReplacementFormProps {
  /** Partner id used to fetch partner-aware product prices.
   *  Pass empty string when no partner is selected yet — the picker will be
   *  disabled with a "Избери партньор..." placeholder. */
  partnerId: string;
  onChange: (state: ReplacementFormState) => void;
}

interface PickerProduct {
  id: number;
  name_bg: string | null;
  name_en: string | null;
  sku: string | null;
  unit: string | null;
  selling_price: number | null;
  group_price: number | null;
  partner_price: number | null;
}

interface PickerOption {
  value: number;
  label: string;
  product: PickerProduct;
}

const PAYMENT_METHOD_OPTIONS: ReadonlyArray<{
  value: ReplacementPaymentMethod;
  label: string;
}> = [
  { value: "cash", label: "Брой" },
  { value: "pos", label: "POS" },
  { value: "bank", label: "Превод" },
];

function emptyLine(): ReplacementLineItem {
  return {
    product_id: 0,
    product_name: "",
    product_code: "",
    quantity: 1,
    unit_price: 0,
  };
}

function formatLeva(amount: number): string {
  // Replacement diffs are always shown in BGN (the cashier paying/refunding
  // at the till works in лв, not the EUR-display formatCurrency uses).
  const abs = Math.abs(amount);
  return `${(Math.round(abs * 100) / 100).toLocaleString("bg-BG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} лв`;
}

export function ReplacementForm({ partnerId, onChange }: ReplacementFormProps) {
  const [giveItems, setGiveItems] = useState<ReplacementLineItem[]>([
    emptyLine(),
  ]);
  const [returnItems, setReturnItems] = useState<ReplacementLineItem[]>([
    emptyLine(),
  ]);
  const [paymentMethod, setPaymentMethod] =
    useState<ReplacementPaymentMethod>("cash");

  const giveSum = useMemo(
    () =>
      giveItems.reduce(
        (sum, it) =>
          sum + (Number(it.quantity) || 0) * (Number(it.unit_price) || 0),
        0,
      ),
    [giveItems],
  );
  const retSum = useMemo(
    () =>
      returnItems.reduce(
        (sum, it) =>
          sum + (Number(it.quantity) || 0) * (Number(it.unit_price) || 0),
        0,
      ),
    [returnItems],
  );
  const diff = giveSum - retSum;
  // Tolerance for "equal" — float math can leave 0.0001 residue when the
  // two sums are computed from different qty/price combos.
  const isZero = Math.abs(diff) < 0.005;

  // Notify parent on every state change. useEffect (not useMemo) — useMemo
  // in the plan skeleton is a misuse; effects are the right primitive for
  // "tell the parent something changed".
  useEffect(() => {
    onChange({ giveItems, returnItems, paymentMethod });
  }, [giveItems, returnItems, paymentMethod, onChange]);

  return (
    <div className="space-y-4">
      <ItemsSection
        title="🟢 Взема се"
        accent="green"
        items={giveItems}
        onItemsChange={setGiveItems}
        partnerId={partnerId}
      />
      <ItemsSection
        title="🔴 Връща се"
        accent="red"
        items={returnItems}
        onItemsChange={setReturnItems}
        partnerId={partnerId}
      />

      <DiffBanner diff={diff} isZero={isZero} />

      {!isZero && (
        <PaymentMethodPicker
          value={paymentMethod}
          onChange={setPaymentMethod}
          diff={diff}
        />
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/*  DiffBanner                                                            */
/* ────────────────────────────────────────────────────────────────────── */

function DiffBanner({ diff, isZero }: { diff: number; isZero: boolean }) {
  if (isZero) {
    return (
      <div
        className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700"
        role="status"
        aria-live="polite"
      >
        <span className="font-medium">0 лв</span> (равно — без плащане)
      </div>
    );
  }
  if (diff > 0) {
    return (
      <div
        className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900"
        role="status"
        aria-live="polite"
      >
        <span className="font-semibold">+{formatLeva(diff)}</span> (клиент
        доплаща)
      </div>
    );
  }
  return (
    <div
      className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-900"
      role="status"
      aria-live="polite"
    >
      −{formatLeva(diff)} (връщаме на клиент)
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/*  PaymentMethodPicker                                                   */
/* ────────────────────────────────────────────────────────────────────── */

function PaymentMethodPicker({
  value,
  onChange,
  diff,
}: {
  value: ReplacementPaymentMethod;
  onChange: (m: ReplacementPaymentMethod) => void;
  diff: number;
}) {
  const helperText =
    diff > 0
      ? "Как клиентът ще доплати разликата?"
      : "Как ще върнем разликата на клиента?";

  return (
    <div className="space-y-2">
      <Label>Начин на плащане за разликата</Label>
      <div className="text-xs text-gray-500">{helperText}</div>
      <div className="flex flex-wrap gap-2">
        {PAYMENT_METHOD_OPTIONS.map((opt) => {
          const isActive = value === opt.value;
          return (
            <Button
              key={opt.value}
              type="button"
              variant={isActive ? "default" : "outline"}
              size="sm"
              onClick={() => onChange(opt.value)}
              aria-pressed={isActive}
            >
              {opt.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/*  ItemsSection                                                          */
/* ────────────────────────────────────────────────────────────────────── */

function ItemsSection({
  title,
  accent,
  items,
  onItemsChange,
  partnerId,
}: {
  title: string;
  accent: "green" | "red";
  items: ReplacementLineItem[];
  onItemsChange: (items: ReplacementLineItem[]) => void;
  partnerId: string;
}) {
  const borderClass =
    accent === "green"
      ? "border-l-4 border-green-500 bg-green-50/30"
      : "border-l-4 border-red-500 bg-red-50/30";

  const addRow = () => onItemsChange([...items, emptyLine()]);

  const updateRow = (idx: number, next: ReplacementLineItem) => {
    onItemsChange(items.map((it, i) => (i === idx ? next : it)));
  };

  const removeRow = (idx: number) => {
    if (items.length === 1) {
      onItemsChange([emptyLine()]);
      return;
    }
    onItemsChange(items.filter((_, i) => i !== idx));
  };

  const sectionTotal = items.reduce(
    (sum, it) =>
      sum + (Number(it.quantity) || 0) * (Number(it.unit_price) || 0),
    0,
  );

  return (
    <div className={`rounded-r-md p-4 ${borderClass}`}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-semibold">{title}</h3>
        {sectionTotal > 0 && (
          <span className="text-sm text-gray-600">
            Сума:{" "}
            <span className="font-semibold">{formatLeva(sectionTotal)}</span>
          </span>
        )}
      </div>

      <div className="space-y-2">
        {items.map((item, idx) => (
          <ItemRow
            key={idx}
            item={item}
            partnerId={partnerId}
            onChange={(next) => updateRow(idx, next)}
            onRemove={() => removeRow(idx)}
          />
        ))}
      </div>

      <div className="mt-3">
        <Button type="button" variant="outline" size="sm" onClick={addRow}>
          + Добави артикул
        </Button>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/*  ItemRow                                                               */
/* ────────────────────────────────────────────────────────────────────── */

function ItemRow({
  item,
  partnerId,
  onChange,
  onRemove,
}: {
  item: ReplacementLineItem;
  partnerId: string;
  onChange: (next: ReplacementLineItem) => void;
  onRemove: () => void;
}) {
  const lineTotal =
    (Number(item.quantity) || 0) * (Number(item.unit_price) || 0);

  // Same endpoint Orders.tsx uses for the new-order picker so the user
  // sees identical results (partner-aware pricing, same name+sku label).
  const loadOptions = useCallback(
    async (inputValue: string): Promise<PickerOption[]> => {
      try {
        const params = new URLSearchParams();
        if (partnerId) params.set("partner_id", partnerId);
        if (inputValue.trim()) params.set("search", inputValue.trim());
        const res = await api.get(`/orders/products-for-order?${params}`);
        const raw = res.data;
        const data = Array.isArray(raw)
          ? raw
          : Array.isArray(raw?.data)
            ? raw.data
            : [];
        return data
          .filter(
            (p: PickerProduct) =>
              p && typeof p === "object" && (p.name_bg || p.name_en),
          )
          .map((p: PickerProduct) => ({
            value: p.id,
            label: `${p.name_bg || p.name_en} — ${p.sku || ""}`,
            product: p,
          }));
      } catch {
        return [];
      }
    },
    [partnerId],
  );

  const handleSelect = (option: PickerOption | null) => {
    if (!option) return;
    const p = option.product;
    const rawPrice = p.partner_price ?? p.group_price ?? p.selling_price;
    const price =
      rawPrice != null && Number.isFinite(parseFloat(String(rawPrice)))
        ? parseFloat(String(rawPrice))
        : 0;
    onChange({
      ...item,
      product_id: p.id,
      product_name: p.name_bg || p.name_en || "Без име",
      product_code: p.sku || "",
      // Keep current quantity if the user already typed one; default to 1.
      quantity: item.quantity > 0 ? item.quantity : 1,
      unit_price: item.unit_price > 0 ? item.unit_price : price,
    });
  };

  const clearProduct = () => {
    onChange(emptyLine());
  };

  return (
    <div className="grid grid-cols-12 gap-2 items-center">
      <div className="col-span-12 md:col-span-6">
        {item.product_id ? (
          <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-2 py-1.5">
            <Package className="h-4 w-4 shrink-0 text-gray-400" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {item.product_name}
              </div>
              {item.product_code && (
                <div className="text-xs text-gray-400">{item.product_code}</div>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={clearProduct}
            >
              Смени
            </Button>
          </div>
        ) : (
          <AsyncSelect<PickerOption, false>
            key={`replacement-picker-${partnerId || "none"}`}
            loadOptions={loadOptions}
            defaultOptions
            cacheOptions={false}
            onChange={handleSelect}
            value={null}
            isDisabled={!partnerId}
            placeholder={partnerId ? "Търси продукт..." : "Избери партньор..."}
            noOptionsMessage={() => "Няма резултати"}
            loadingMessage={() => "Зареждане..."}
            isSearchable
            classNamePrefix="rs"
            menuPlacement="auto"
            menuShouldScrollIntoView
            menuPortalTarget={document.body}
            menuPosition="fixed"
            menuShouldBlockScroll
            styles={{
              menu: (base) => ({ ...base, zIndex: 9999 }),
              menuPortal: (base) => ({ ...base, zIndex: 9999 }),
              control: (base) => ({
                ...base,
                minHeight: "40px",
                borderColor: "#d1d5db",
                "&:hover": { borderColor: "#6366f1" },
                boxShadow: "none",
              }),
            }}
          />
        )}
      </div>

      <div className="col-span-4 md:col-span-2">
        <Input
          type="number"
          min="0.001"
          step="0.001"
          value={item.quantity || ""}
          onChange={(e) =>
            onChange({ ...item, quantity: Number(e.target.value) || 0 })
          }
          disabled={!item.product_id}
          placeholder="К-во"
          aria-label="Количество"
        />
      </div>

      <div className="col-span-4 md:col-span-2">
        <Input
          type="number"
          min="0"
          step="0.01"
          value={item.unit_price || ""}
          onChange={(e) =>
            onChange({ ...item, unit_price: Number(e.target.value) || 0 })
          }
          disabled={!item.product_id}
          placeholder="Цена"
          aria-label="Единична цена"
        />
      </div>

      <div className="col-span-3 md:col-span-1 text-sm font-medium">
        {lineTotal > 0 ? formatLeva(lineTotal) : "—"}
      </div>

      <div className="col-span-1 flex justify-end">
        <button
          type="button"
          onClick={onRemove}
          className="rounded p-1 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500"
          aria-label="Премахни ред"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// formatCurrency is exported in case parent integrations want EUR display
// elsewhere — the component itself uses BGN-formatting because the диф is
// shown in лева at the till.
export { formatCurrency };
