import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Search,
  Pencil,
  Trash2,
  Package,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { api } from "@/lib/api";
import { SHOW_ALL_LIMIT } from "@/lib/pagination";
import { toast } from "@/lib/toast";
import { confirm } from "@/components/ConfirmDialog";
import type { Product, Category } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  formatCurrency,
  formatUnitPrice,
  formatUnit,
  getApiErrorMessage,
  stockColorClass,
} from "@/lib/utils";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { HighlightMatch } from "@/lib/highlight";
import { Can } from "@/components/Can";
import { PERMISSIONS } from "@/lib/permissions";

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
) {
  return {
    name_bg: product?.name_bg ?? "",
    name_en: product?.name_en ?? "",
    sku: product?.sku ?? "",
    category_id: product?.category_id?.toString() ?? "",
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

function ProductModal({
  open,
  onClose,
  product,
  categories,
  brands,
}: {
  open: boolean;
  onClose: () => void;
  product?: Product | null;
  categories: Category[];
  brands: string[];
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState(buildFormState(product));
  const [showAllPrices, setShowAllPrices] = useState(false);
  const [confirmBelowCost, setConfirmBelowCost] = useState(false);

  useEffect(() => {
    setForm(buildFormState(product));
    setShowAllPrices(false);
    setConfirmBelowCost(false);
  }, [product?.id]);

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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["brands"] });
      onClose();
      toast.success(product ? "Продуктът е обновен" : "Продуктът е създаден");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при запис на продукта",
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
                        ⚠ под ДЦ: {formatCurrency(purchaseCost)}
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
                      {f.label}: {formatCurrency(v)} (губиш{" "}
                      {formatCurrency(lossPerUnit)}/бр.)
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

function CategoryManagerModal({
  open,
  onClose,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  categories: Category[];
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name_bg: "", name_en: "" });

  const createMutation = useMutation({
    mutationFn: async () => api.post("/categories", form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["categories"] });
      setForm({ name_bg: "", name_en: "" });
      toast.success("Категорията е създадена");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при запис на категорията",
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => api.delete(`/categories/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["categories"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      toast.success("Категорията е изтрита");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при изтриване на категорията",
      );
    },
  });

  const createError = createMutation.error
    ? getApiErrorMessage(
        createMutation.error,
        "Грешка при запис на категорията.",
      )
    : "";
  const deleteError = deleteMutation.error
    ? getApiErrorMessage(
        deleteMutation.error,
        "Грешка при изтриване на категорията.",
      )
    : "";

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Категории</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-lg border p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Име (БГ)</Label>
                <Input
                  value={form.name_bg}
                  onChange={(e) =>
                    setForm((current) => ({
                      ...current,
                      name_bg: e.target.value,
                    }))
                  }
                  placeholder="напр. Сирена"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Име (EN)</Label>
                <Input
                  value={form.name_en}
                  onChange={(e) =>
                    setForm((current) => ({
                      ...current,
                      name_en: e.target.value,
                    }))
                  }
                  placeholder="optional"
                />
              </div>
            </div>
            {createError ? <ErrorMessage message={createError} /> : null}
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || !form.name_bg.trim()}
              >
                {createMutation.isPending ? <Spinner size="sm" /> : null}
                Добави категория
              </Button>
            </div>
          </div>

          {deleteError ? <ErrorMessage message={deleteError} /> : null}

          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Категория</TableHead>
                  <TableHead>EN</TableHead>
                  <TableHead className="text-right">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categories.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="py-6 text-center text-gray-500"
                    >
                      Няма категории.
                    </TableCell>
                  </TableRow>
                ) : (
                  categories.map((category) => (
                    <TableRow key={category.id}>
                      <TableCell className="font-medium">
                        {category.name_bg}
                      </TableCell>
                      <TableCell>{category.name_en || "—"}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-red-600 hover:text-red-700"
                          onClick={() => deleteMutation.mutate(category.id)}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type PriceFilter =
  "with_price" | "all" | "no_price" | "zero_stock" | "negative_stock";
type StockTab = "active" | "catalog";

export function Products() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 300);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [priceFilter, setPriceFilter] = useState<PriceFilter>("with_price");
  const [stockTab, setStockTab] = useState<StockTab>("active");
  const [modalOpen, setModalOpen] = useState(false);
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [page, setPage] = useState(1);
  // Без страници — целият каталог се показва на екрана.
  const pageSize = SHOW_ALL_LIMIT;

  const {
    data: productsData,
    isLoading,
    error,
  } = useQuery<{
    data: Product[];
    pagination: { page: number; limit: number; total: number };
    active_count?: number;
    catalog_count?: number;
  }>({
    queryKey: [
      "products",
      debouncedSearch,
      categoryFilter,
      brandFilter,
      priceFilter,
      stockTab,
      page,
    ],
    queryFn: () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (categoryFilter) params.set("category", categoryFilter);
      if (brandFilter) params.set("brand", brandFilter);
      if (priceFilter === "no_price") params.set("no_selling_price", "true");
      if (priceFilter === "with_price") params.set("has_price", "true");
      if (priceFilter === "zero_stock") params.set("zero_stock", "true");
      if (priceFilter === "negative_stock")
        params.set("negative_stock", "true");
      // Stock tab: active_only=true for "Налични", catalog=true for "Каталог".
      // The new stock-based filters (zero/negative) need the catalog scope so
      // the HAVING clause they push can match products that are currently
      // outside the active_only=true cut.
      const stockFilterActive =
        priceFilter === "zero_stock" || priceFilter === "negative_stock";
      if (stockTab === "active" && !stockFilterActive) {
        params.set("active_only", "true");
      } else {
        params.set("catalog", "true");
        params.set("active_only", "false");
      }
      params.set("page", String(page));
      params.set("limit", String(pageSize));
      return api.get(`/products?${params}`).then((r) => {
        const d = r.data;
        if (d?.data && d?.pagination) return d;
        const items = Array.isArray(d)
          ? d
          : Array.isArray(d?.data)
            ? d.data
            : [];
        return {
          data: items,
          pagination: { page: 1, limit: pageSize, total: items.length },
        };
      });
    },
    refetchInterval: 30000,
  });

  const products = productsData?.data ?? [];
  const pagination = productsData?.pagination ?? {
    page: 1,
    limit: pageSize,
    total: 0,
  };
  const activeCount = productsData?.active_count ?? 0;
  const catalogCount = productsData?.catalog_count ?? 0;
  const uncategorizedCount = products.filter(
    (product) => !product.category_id,
  ).length;

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ["categories"],
    queryFn: () =>
      api.get("/categories").then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      }),
  });

  const { data: brands = [] } = useQuery<string[]>({
    queryKey: ["brands"],
    queryFn: () =>
      api.get("/products/brands").then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/products/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      toast.success("Продуктът е изтрит");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при изтриване на продукта",
      );
    },
  });

  const openAdd = () => {
    setEditProduct(null);
    setModalOpen(true);
  };
  const openEdit = (p: Product) => {
    setEditProduct(p);
    setModalOpen(true);
  };

  const priceFilterTabs: { value: PriceFilter; label: string }[] = [
    { value: "all", label: "Всички" },
    { value: "with_price", label: "С цени" },
    { value: "no_price", label: "Без цени" },
    { value: "zero_stock", label: "🟡 Нулеви" },
    { value: "negative_stock", label: "🔴 На минус" },
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Продукти</h1>
          <p className="text-gray-500 text-sm mt-1">
            Управление на продуктовия каталог
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setCategoryModalOpen(true)}>
            Категории
          </Button>
          <Button onClick={openAdd}>
            <Plus className="h-4 w-4" />
            Нов продукт
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs uppercase tracking-wide text-gray-500">
              Каталог
            </p>
            <p className="mt-1 text-2xl font-semibold text-gray-900">
              {catalogCount}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs uppercase tracking-wide text-gray-500">
              Налични
            </p>
            <p className="mt-1 text-2xl font-semibold text-gray-900">
              {activeCount}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-500">
                Без категория
              </p>
              <p className="mt-1 text-2xl font-semibold text-amber-700">
                {uncategorizedCount}
              </p>
            </div>
            {uncategorizedCount > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCategoryModalOpen(true)}
              >
                Управлявай
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {/* Stock tabs: Налични / Каталог */}
      <div className="flex gap-4 border-b border-gray-200">
        <button
          onClick={() => {
            setStockTab("active");
            setPage(1);
          }}
          className={`px-4 py-2 font-medium border-b-2 transition-colors ${
            stockTab === "active"
              ? "border-[#6c3dff] text-[#6c3dff]"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Налични
          <span
            className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
              stockTab === "active"
                ? "bg-[#6c3dff]/10 text-[#6c3dff]"
                : "bg-gray-100 text-gray-500"
            }`}
          >
            {activeCount}
          </span>
        </button>
        <button
          onClick={() => {
            setStockTab("catalog");
            setPage(1);
          }}
          className={`px-4 py-2 font-medium border-b-2 transition-colors ${
            stockTab === "catalog"
              ? "border-[#6c3dff] text-[#6c3dff]"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Каталог
          <span
            className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
              stockTab === "catalog"
                ? "bg-[#6c3dff]/10 text-[#6c3dff]"
                : "bg-gray-100 text-gray-500"
            }`}
          >
            {catalogCount}
          </span>
        </button>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap gap-3">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Търси по име, SKU или марка..."
                className="pl-9"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <Select
              value={categoryFilter}
              onChange={(e) => {
                setCategoryFilter(e.target.value);
                setPage(1);
              }}
              className="w-48"
            >
              <option value="">Всички категории</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name_bg}
                </option>
              ))}
            </Select>
            <Select
              value={brandFilter}
              onChange={(e) => {
                setBrandFilter(e.target.value);
                setPage(1);
              }}
              className="w-48"
            >
              <option value="">Всички марки</option>
              {brands.map((brand) => (
                <option key={brand} value={brand}>
                  {brand}
                </option>
              ))}
            </Select>
            {(search ||
              categoryFilter ||
              brandFilter ||
              priceFilter !== "with_price") && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearch("");
                  setCategoryFilter("");
                  setBrandFilter("");
                  setPriceFilter("with_price");
                  setPage(1);
                }}
              >
                Изчисти филтрите
              </Button>
            )}
          </div>
          {/* Price filter tabs */}
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
            {priceFilterTabs.map((tab) => (
              <button
                key={tab.value}
                onClick={() => {
                  setPriceFilter(tab.value);
                  setPage(1);
                }}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  priceFilter === tab.value
                    ? "bg-white text-gray-900 shadow-sm"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5 text-[#6c3dff]" />
            {pagination.total} продукта
          </CardTitle>
        </CardHeader>
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
                  <TableHead>Наименование</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Мярка</TableHead>
                  <TableHead>Категория</TableHead>
                  <Can permission={PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE}>
                    <TableHead>Доставна цена</TableHead>
                  </Can>
                  <TableHead>Цена на едро</TableHead>
                  <Can permission={PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE}>
                    <TableHead>Марж</TableHead>
                  </Can>
                  <TableHead>Наличност</TableHead>
                  <TableHead className="text-right">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((p) => {
                  const purchaseNum = Number(p.purchase_price) || 0;
                  const sellingNum = Number(p.selling_price) || 0;
                  const margin =
                    purchaseNum > 0 && sellingNum > 0
                      ? ((sellingNum - purchaseNum) / purchaseNum) * 100
                      : null;
                  const marginColor =
                    margin === null
                      ? "text-gray-400"
                      : margin > 20
                        ? "text-green-600"
                        : margin >= 10
                          ? "text-yellow-600"
                          : "text-red-600";

                  const hasStock = parseFloat(String(p.total_stock ?? 0)) > 0;
                  const rowOpacity =
                    stockTab === "catalog" && !hasStock ? "opacity-50" : "";

                  return (
                    <TableRow key={p.id} className={rowOpacity}>
                      <TableCell>
                        <div>
                          <p className="font-medium text-gray-900">
                            <HighlightMatch
                              text={p.name_bg}
                              query={debouncedSearch}
                            />
                          </p>
                          {p.name_en && (
                            <p className="text-xs text-gray-400">
                              <HighlightMatch
                                text={p.name_en}
                                query={debouncedSearch}
                              />
                            </p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        <HighlightMatch text={p.sku} query={debouncedSearch} />
                      </TableCell>
                      <TableCell>{formatUnit(p.unit)}</TableCell>
                      <TableCell>
                        {p.category_name_bg ? (
                          <Badge variant="secondary">
                            {p.category_name_bg}
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <Can
                        permission={PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE}
                      >
                        <TableCell>
                          {p.purchase_price
                            ? formatUnitPrice(p.purchase_price)
                            : "—"}
                        </TableCell>
                      </Can>
                      <TableCell>
                        {p.selling_price
                          ? formatUnitPrice(p.selling_price)
                          : "—"}
                      </TableCell>
                      <Can
                        permission={PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE}
                      >
                        <TableCell className={marginColor}>
                          {margin !== null ? `${margin.toFixed(1)}%` : "—"}
                        </TableCell>
                      </Can>
                      <TableCell>
                        {p.total_stock !== null &&
                        p.total_stock !== undefined ? (
                          <span
                            className={stockColorClass(
                              parseFloat(String(p.total_stock || 0)),
                              p.low_stock_threshold,
                            )}
                          >
                            {parseFloat(String(p.total_stock))}{" "}
                            {formatUnit(String(p.unit))}
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Can permission={PERMISSIONS.PRODUCTS_MANAGE}>
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label="Редактирай продукт"
                              onClick={() => openEdit(p)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                          </Can>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Изтрий продукт"
                            className="text-red-500 hover:text-red-600"
                            onClick={async () => {
                              const ok = await confirm({
                                title: "Изтриване на продукт",
                                description: `Сигурни ли сте, че искате да изтриете "${p.name_bg}"? Действието не може да бъде отменено.`,
                                confirmText: "Изтрий",
                                variant: "danger",
                              });
                              if (ok) deleteMutation.mutate(p.id);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
        {/* Без страници: каталогът е цял на екрана, футърът отчита броя. */}
        {pagination.total > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <p className="text-sm text-gray-500">
              Показани всички {pagination.total}
            </p>
          </div>
        )}
      </Card>

      <ProductModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        product={editProduct}
        categories={categories}
        brands={brands}
      />
      <CategoryManagerModal
        open={categoryModalOpen}
        onClose={() => setCategoryModalOpen(false)}
        categories={categories}
      />
    </div>
  );
}
