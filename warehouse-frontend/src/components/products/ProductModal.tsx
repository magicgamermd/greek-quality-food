import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import type { Product, Category } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import {
  formatCurrency,
  formatUnitPrice,
  getApiErrorMessage,
} from "@/lib/utils";
import { GroupPicker } from "@/components/groups/GroupPicker";

// Картата на продукта — изнесена от страница „Продукти“, за да се отваря и
// от „Приемане на стоки“ (✎ на реда в доставката).

const PRICE_GROUP_FIELDS = [
  { key: "purchase_price", label: "Доставна цена" },
  { key: "selling_price", label: "Цена на едро" },
  { key: "retail_price", label: "Цена на дребно" },
  { key: "price_group_1", label: "Ценова група 1" },
  { key: "price_group_2", label: "Ценова група 2" },
  { key: "price_group_3", label: "Ценова група 3" },
  { key: "price_group_4", label: "Ценова група 4" },
  { key: "price_group_5", label: "Ценова група 5" },
  { key: "price_group_6", label: "Ценова група 6" },
  { key: "price_group_7", label: "Ценова група 7" },
  { key: "price_group_8", label: "Ценова група 8" },
] as const;

function formatPrice(v: number | null | undefined): string {
  if (v == null) return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  // Единичните цени са с до 3 знака (мигр. 101). Пълним формата с третия
  // знак само когато го има — иначе записът на формата би закръглил тихо
  // 9.253 → 9.25.
  const three = n.toFixed(3);
  return three.endsWith("0") ? n.toFixed(2) : three;
}

function buildFormState(
  product?: (Product & { weight_kg?: number | null }) | null,
  defaultGroupId?: string,
) {
  return {
    name_bg: product?.name_bg ?? "",
    name_en: product?.name_en ?? "",
    sku: product?.sku ?? "",
    category_id: product?.category_id?.toString() ?? "",
    // Нов продукт, докато е избрана група вляво → в нея.
    product_group_id: product
      ? (product.product_group_id?.toString() ?? "")
      : (defaultGroupId ?? ""),
    unit: product?.unit ?? "",
    description: product?.description ?? "",
    brand: product?.brand ?? "",
    weight_kg: formatPrice(product?.weight_kg),
    purchase_price: formatPrice(product?.purchase_price),
    selling_price: formatPrice(product?.selling_price),
    retail_price: formatPrice(product?.retail_price),
    price_group_1: formatPrice(product?.price_group_1),
    price_group_2: formatPrice(product?.price_group_2),
    price_group_3: formatPrice(product?.price_group_3),
    price_group_4: formatPrice(product?.price_group_4),
    price_group_5: formatPrice(product?.price_group_5),
    price_group_6: formatPrice(product?.price_group_6),
    price_group_7: formatPrice(product?.price_group_7),
    price_group_8: formatPrice(product?.price_group_8),
  };
}

export function ProductModal({
  open,
  onClose,
  product,
  categories,
  brands,
  defaultGroupId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  product?: Product | null;
  categories: Category[];
  brands: string[];
  /** Избраната вляво група — за нов продукт. */
  defaultGroupId?: string;
  /** Вика се със записания продукт (отговора на сървъра) след успешен запис. */
  onSaved?: (saved: Product) => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState(buildFormState(product, defaultGroupId));
  const [showAllPrices, setShowAllPrices] = useState(false);
  const [confirmBelowCost, setConfirmBelowCost] = useState(false);

  useEffect(() => {
    setForm(buildFormState(product, defaultGroupId));
    setShowAllPrices(false);
    setConfirmBelowCost(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id, open]);

  // Below-cost guard: any selling-price field (selling, retail, group 1–8)
  // that's non-zero and BELOW purchase_price. Mirrors the order-level guard
  // so products can't be misconfigured to lose money on every sale.
  const purchaseCost = parseFloat(form.purchase_price) || 0;
  const belowCostFields = PRICE_GROUP_FIELDS.filter((f) => {
    if (f.key === "purchase_price") return false;
    const raw = form[f.key as keyof typeof form];
    const v = parseFloat(String(raw)) || 0;
    return purchaseCost > 0 && v > 0 && v < purchaseCost;
  });
  const hasBelowCost = belowCostFields.length > 0;

  useEffect(() => {
    if (!hasBelowCost && confirmBelowCost) setConfirmBelowCost(false);
  }, [hasBelowCost, confirmBelowCost]);

  const mutation = useMutation({
    mutationFn: async () => {
      const toNum = (v: string) => (v ? Number(v) : null);
      const payload = {
        ...form,
        category_id: form.category_id ? Number(form.category_id) : null,
        product_group_id: form.product_group_id
          ? Number(form.product_group_id)
          : null,
        purchase_price: toNum(form.purchase_price),
        selling_price: toNum(form.selling_price),
        retail_price: toNum(form.retail_price),
        price_group_1: toNum(form.price_group_1),
        price_group_2: toNum(form.price_group_2),
        price_group_3: toNum(form.price_group_3),
        price_group_4: toNum(form.price_group_4),
        price_group_5: toNum(form.price_group_5),
        price_group_6: toNum(form.price_group_6),
        price_group_7: toNum(form.price_group_7),
        price_group_8: toNum(form.price_group_8),
        weight_kg: toNum(form.weight_kg),
        brand: form.brand || null,
      };
      if (product) return api.put(`/products/${product.id}`, payload);
      return api.post("/products", payload);
    },
    onSuccess: (response) => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["brands"] });
      qc.invalidateQueries({ queryKey: ["groups", "product"] });
      const saved = response?.data as Product | undefined;
      if (saved && Number.isFinite(Number(saved.id))) onSaved?.(saved);
      onClose();
      toast.success(product ? "Продуктът е обновен" : "Продуктът е създаден");
    },
    onError: (err: unknown) => {
      const data = (
        err as { response?: { data?: { error?: string; message?: string } } }
      )?.response?.data;
      toast.error(
        data?.error ?? data?.message ?? "Грешка при запис на продукта",
      );
    },
  });
  const saveError = mutation.error
    ? getApiErrorMessage(mutation.error, "Грешка при запазване на продукта.")
    : "";

  const set = (field: string, value: string) =>
    setForm((f) => ({ ...f, [field]: value }));

  // Show price groups that have non-zero values, or all if editing
  const visiblePriceFields = showAllPrices
    ? PRICE_GROUP_FIELDS
    : PRICE_GROUP_FIELDS.filter((f) => {
        const val = form[f.key as keyof typeof form];
        return val && parseFloat(val) > 0;
      });

  // Always show at least purchase + selling + retail
  const alwaysShown = ["purchase_price", "selling_price", "retail_price"];
  const displayFields = showAllPrices
    ? PRICE_GROUP_FIELDS
    : PRICE_GROUP_FIELDS.filter(
        (f) =>
          alwaysShown.includes(f.key) ||
          visiblePriceFields.some((v) => v.key === f.key),
      );

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {product ? "Редактиране на продукт" : "Нов продукт"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto min-h-0 grid gap-4 py-2 pr-1">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Наименование (БГ)</Label>
              <Input
                value={form.name_bg}
                onChange={(e) => set("name_bg", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Наименование (EN)</Label>
              <Input
                value={form.name_en}
                onChange={(e) => set("name_en", e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>SKU</Label>
              <div className="flex gap-2">
                <Input
                  value={form.sku}
                  onChange={(e) => set("sku", e.target.value)}
                  placeholder="10001"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    const res = await api.get("/products/next-sku");
                    const nextSku = res.data?.next_sku;
                    if (nextSku) set("sku", String(nextSku));
                  }}
                >
                  Генерирай
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Мерна единица</Label>
              <Select
                value={form.unit}
                onChange={(e) => set("unit", e.target.value)}
              >
                <option value="">Избери...</option>
                <option value="kg">кг</option>
                <option value="g">г</option>
                <option value="l">л</option>
                <option value="ml">мл</option>
                <option value="pcs">бр</option>
                <option value="box">кутия</option>
                <option value="pack">пакет</option>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="product-group">Група</Label>
            <GroupPicker
              id="product-group"
              kind="product"
              value={form.product_group_id}
              onChange={(value) => set("product_group_id", value)}
            />
            <p className="text-xs text-gray-400">
              Като групите в Microinvest — напр. по доставчик. „+ Нова група…“ я
              създава веднага.
            </p>
          </div>
          <div className="grid grid-cols-[2fr_1fr_1fr] gap-4">
            <div className="space-y-1.5">
              <Label>Категория</Label>
              <Combobox
                items={categories.map((cat) => ({
                  value: String(cat.id),
                  label: cat.name_bg,
                }))}
                value={form.category_id}
                onChange={(val) => set("category_id", val)}
                onClear={() => set("category_id", "")}
                placeholder="Избери или потърси категория..."
                emptyMessage="Няма намерени категории."
              />
            </div>
            <div className="space-y-1.5">
              <Label>Марка</Label>
              <Input
                list="brands-list"
                value={form.brand}
                onChange={(e) => set("brand", e.target.value)}
                placeholder="Избери или въведи марка..."
              />
              <datalist id="brands-list">
                {brands.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label>Тегло (кг)</Label>
              <Input
                type="number"
                step="0.001"
                min="0"
                value={form.weight_kg}
                onChange={(e) => set("weight_kg", e.target.value)}
                placeholder="0.000"
              />
            </div>
          </div>

          {/* Ценови групи */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
                Ценови групи
              </h3>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-xs"
                onClick={() => setShowAllPrices((v) => !v)}
              >
                {showAllPrices ? "Скрий празните" : "Покажи всички"}
              </Button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {displayFields.map((f) => {
                const raw = form[f.key as keyof typeof form];
                const v = parseFloat(String(raw)) || 0;
                const isBelowCost =
                  f.key !== "purchase_price" &&
                  purchaseCost > 0 &&
                  v > 0 &&
                  v < purchaseCost;
                return (
                  <div key={f.key} className="space-y-1">
                    <Label className="text-xs">{f.label}</Label>
                    <Input
                      type="number"
                      step="0.001"
                      value={raw}
                      onChange={(e) => set(f.key, e.target.value)}
                      placeholder="0.00"
                      className={`h-8 text-sm ${
                        isBelowCost ? "border-amber-500 text-amber-700" : ""
                      }`}
                      title={
                        isBelowCost
                          ? `Под доставната цена (${formatCurrency(purchaseCost)})`
                          : undefined
                      }
                    />
                    {isBelowCost && (
                      <div className="text-[10px] text-amber-700 whitespace-nowrap">
                        ⚠ под ДЦ: {formatUnitPrice(purchaseCost)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Описание</Label>
            <Textarea
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              rows={3}
            />
          </div>
        </div>
        {hasBelowCost && !confirmBelowCost && (
          <div className="flex items-start gap-2 p-2 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800 shrink-0">
            <span className="text-amber-600 shrink-0">⚠</span>
            <div>
              <div className="font-medium mb-1">
                Внимание: цени под доставната ({formatCurrency(purchaseCost)})!
              </div>
              <ul className="list-disc list-inside space-y-0.5">
                {belowCostFields.map((f) => {
                  const v =
                    parseFloat(String(form[f.key as keyof typeof form])) || 0;
                  const lossPerUnit = purchaseCost - v;
                  return (
                    <li key={f.key}>
                      {f.label}: {formatUnitPrice(v)} (губиш{" "}
                      {formatUnitPrice(lossPerUnit)}/бр.)
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}
        {hasBelowCost && confirmBelowCost && (
          <div className="flex items-start gap-2 p-2 bg-yellow-50 border border-yellow-200 rounded text-sm text-yellow-800 shrink-0">
            <span className="text-yellow-600 shrink-0">✓</span>
            <span>
              Потвърдено — продуктът ще бъде запазен с цени под доставната.
            </span>
          </div>
        )}
        {saveError && <ErrorMessage message={saveError} />}
        <DialogFooter className="gap-2 shrink-0">
          <Button variant="outline" onClick={onClose}>
            Отказ
          </Button>
          {hasBelowCost && !confirmBelowCost ? (
            <Button
              variant="destructive"
              className="bg-amber-600 hover:bg-amber-700"
              onClick={() => setConfirmBelowCost(true)}
            >
              ⚠ Потвърди под ДЦ
            </Button>
          ) : (
            <Button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? (
                <>
                  <Spinner size="sm" />
                  Запазване...
                </>
              ) : (
                "Запази"
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
