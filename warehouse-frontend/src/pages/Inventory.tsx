import React, { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  AlertTriangle,
  Warehouse,
  PackageCheck,
  PackageX,
  Pencil,
  ChevronRight,
  ChevronDown,
  Check,
} from "lucide-react";
import { toast } from "@/lib/toast";
import {
  isBatchExpired,
  isBatchExpiringSoon,
  type Batch,
} from "@/components/BatchSelect";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import type { StockLevel } from "@/types";
import { formatUnit, getApiErrorMessage, stockColorClass } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

type Tab = "available" | "all" | "zero" | "low-stock" | "negative";

interface AdjustStockData {
  productId: number;
  productName: string;
  currentQuantity: number;
  unit?: string | null;
}

function normalizeInventoryItem(item: any): StockLevel {
  return {
    ...item,
    product_name: item.product_name || item.name_bg || item.name_en || item.sku,
    total_quantity: parseFloat(
      item.total_quantity ?? item.total_stock ?? item.quantity ?? 0,
    ),
  };
}

// Партидите на продукт — разгъващ се панел под реда в Склада. Показва
// номер (служебните АВТО-* се виждат тук — това е складовата
// идентичност), СРОК НА ГОДНОСТ (редактируем на място — точно за
// случая „стоката изглежда изчезнала, а е с грешно въведен/изтекъл
// срок") и количество. Изтекла партида → червено.
function ProductBatchesPanel({
  productId,
  canEdit,
}: {
  productId: number;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  const { data, isLoading, isError } = useQuery({
    queryKey: ["batches", String(productId)],
    queryFn: async () => {
      const res = await api.get("/batches", {
        params: { product_id: productId, limit: 100 },
      });
      return (res.data?.data ?? []) as Batch[];
    },
  });

  const saveExpiry = useMutation({
    mutationFn: ({ id, expiry }: { id: number; expiry: string }) =>
      api.put(`/batches/${id}`, { expiry_date: expiry || null }),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ["batches"] });
      setDrafts((d) => {
        const next = { ...d };
        delete next[vars.id];
        return next;
      });
      toast.success("Срокът на партидата е обновен");
    },
    onError: (err: any) =>
      toast.error(
        getApiErrorMessage(err, "Грешка при запис на срока на партидата."),
      ),
  });

  const batches = (data ?? []).filter((b) => Number(b.quantity) > 0);

  if (isLoading)
    return <div className="h-10 animate-pulse rounded-md bg-gray-100" />;
  if (isError)
    return (
      <div className="text-xs text-red-500">
        Грешка при зареждане на партидите.
      </div>
    );
  if (batches.length === 0)
    return (
      <div className="text-xs text-gray-400">
        Няма партиди с наличност за този продукт.
      </div>
    );

  return (
    <div className="space-y-1.5">
      {batches.map((batch) => {
        const expired = isBatchExpired(batch.expiry_date);
        const soon = !expired && isBatchExpiringSoon(batch.expiry_date);
        const stored = batch.expiry_date
          ? String(batch.expiry_date).slice(0, 10)
          : "";
        const draft = drafts[batch.id] ?? stored;
        const dirty = draft !== stored;
        return (
          <div
            key={batch.id}
            className="flex flex-wrap items-center gap-3 rounded-md border bg-white px-3 py-2"
          >
            <span className="font-mono text-xs text-gray-600 min-w-[110px]">
              {batch.batch_number || `Лот #${batch.id}`}
            </span>
            <span className="text-xs text-gray-500">Срок:</span>
            {canEdit ? (
              <Input
                type="date"
                value={draft}
                onChange={(e) =>
                  setDrafts((d) => ({ ...d, [batch.id]: e.target.value }))
                }
                className={`h-8 w-40 text-xs ${
                  expired
                    ? "border-red-400 text-red-600"
                    : soon
                      ? "border-amber-400 text-amber-700"
                      : ""
                }`}
              />
            ) : (
              <span
                className={`text-xs ${
                  expired
                    ? "text-red-600"
                    : soon
                      ? "text-amber-600"
                      : "text-gray-700"
                }`}
              >
                {stored || "без срок"}
              </span>
            )}
            {canEdit && dirty && (
              <Button
                size="sm"
                className="h-8"
                disabled={saveExpiry.isPending}
                onClick={() =>
                  saveExpiry.mutate({ id: batch.id, expiry: draft })
                }
              >
                {saveExpiry.isPending ? (
                  <Spinner size="sm" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Запази
              </Button>
            )}
            {expired && <Badge variant="destructive">ИЗТЕКЛА</Badge>}
            {soon && (
              <Badge className="bg-amber-100 text-amber-800 border-amber-300">
                Изтича скоро
              </Badge>
            )}
            <span className="ml-auto text-xs text-gray-600">
              Наличност: <b>{Number(batch.quantity)}</b>
            </span>
          </div>
        );
      })}
      <div className="text-[11px] text-gray-400">
        Промяната на срока важи веднага за FEFO при продажба. Изтекла стока се
        изважда през Брак.
      </div>
    </div>
  );
}

function AdjustStockModal({
  data,
  onClose,
}: {
  data: AdjustStockData | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  // `delta` is the signed change to stock (positive to add, negative to remove).
  const [form, setForm] = useState({
    delta: "",
    reason: "",
  });

  // Reset the form whenever a new product is targeted. `productId` is the
  // only field we actually branch on, so guarding by it (and not the full
  // `data` object identity) matches the intent cleanly with no missing deps.
  const productId = data?.productId;
  useEffect(() => {
    if (productId != null) {
      setForm({ delta: "", reason: "" });
    }
  }, [productId]);

  const deltaNum = parseFloat(form.delta);
  const hasDelta =
    form.delta.trim() !== "" && Number.isFinite(deltaNum) && deltaNum !== 0;
  const newTotal = hasDelta
    ? Number(data?.currentQuantity ?? 0) + deltaNum
    : Number(data?.currentQuantity ?? 0);

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/inventory/adjust/${data!.productId}`, {
        quantity: deltaNum,
        reason: form.reason.trim(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      onClose();
    },
  });

  const saveError = mutation.error
    ? getApiErrorMessage(mutation.error, "Грешка при корекция на наличността.")
    : "";

  if (!data) return null;

  const reasonOk = form.reason.trim().length >= 3;
  const canSubmit = hasDelta && reasonOk;

  return (
    <Dialog open={!!data} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle>Корекция на наличност — {data.productName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <Label>Промяна на количеството</Label>
              <span className="text-xs text-gray-500">
                Текущо:{" "}
                <span className="font-mono font-medium text-gray-700">
                  {data.currentQuantity}
                </span>{" "}
                {data.unit ?? ""}
              </span>
            </div>
            <Input
              type="number"
              step="0.001"
              value={form.delta}
              onChange={(e) =>
                setForm((f) => ({ ...f, delta: e.target.value }))
              }
              placeholder="напр. 5 или -3"
              className={
                hasDelta
                  ? deltaNum > 0
                    ? "border-emerald-500 text-emerald-700"
                    : "border-violet-500 text-violet-700"
                  : ""
              }
            />
            {hasDelta && (
              <div
                className={`text-xs ${deltaNum > 0 ? "text-emerald-700" : "text-violet-700"}`}
              >
                Ново общо:{" "}
                <span className="font-mono font-medium">
                  {data.currentQuantity} {deltaNum > 0 ? "+" : ""}
                  {deltaNum} = {newTotal}
                </span>{" "}
                {data.unit ?? ""}
              </div>
            )}
            <p className="text-[11px] text-gray-400">
              Положителна стойност добавя, отрицателна вади. Записва се в audit
              log.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>
              Причина <span className="text-red-500">*</span>
            </Label>
            <Input
              value={form.reason}
              onChange={(e) =>
                setForm((f) => ({ ...f, reason: e.target.value }))
              }
              placeholder="напр. инвентаризация, счупено, брак..."
            />
            <p className="text-[11px] text-gray-400">
              Задължителна (мин. 3 символа).
            </p>
          </div>
        </div>
        {saveError && <ErrorMessage message={saveError} />}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Отказ
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !canSubmit}
            title={
              !canSubmit
                ? "Попълни количеството и причината (мин. 3 символа)"
                : undefined
            }
          >
            {mutation.isPending ? (
              <>
                <Spinner size="sm" />
                Запазване...
              </>
            ) : (
              "Запази корекция"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Inventory() {
  // Разгънат продукт (партидите му със срокове) — един по едно.
  const [expandedProductId, setExpandedProductId] = useState<number | null>(
    null,
  );
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (searchParams.get("tab") as Tab) || "available";
  const [tab, setTab] = useState<Tab>(initialTab);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [adjustData, setAdjustData] = useState<AdjustStockData | null>(null);
  const { user } = useAuth();
  const canAdjustStock = user?.role === "admin";
  const pageSize = 50;

  // Sync tab from URL when navigating from dashboard
  useEffect(() => {
    const urlTab = searchParams.get("tab") as Tab;
    if (urlTab && urlTab !== tab) {
      setTab(urlTab);
      setPage(1);
    }
  }, [searchParams]);

  const {
    data: result,
    isLoading,
    error,
  } = useQuery<{ items: StockLevel[]; total: number }>({
    queryKey: ["inventory", tab, page, search],
    queryFn: () => {
      const base = tab === "low-stock" ? "/inventory/low-stock" : "/inventory";

      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(pageSize));
      if (search.trim()) params.set("search", search.trim());

      if (base === "/inventory") {
        if (tab === "available") params.set("has_stock", "true");
        else if (tab === "zero") params.set("has_stock", "zero");
        else if (tab === "negative") params.set("has_stock", "negative");
      }

      return api.get(`${base}?${params}`).then((r) => {
        const d = r.data;
        const arr = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
        const normalized = arr.map((item: any) => normalizeInventoryItem(item));
        const total = d?.pagination?.total ?? d?.count ?? arr.length;
        return { items: normalized, total };
      });
    },
    refetchInterval: 30000,
  });

  const allStock = result?.items ?? [];
  const totalItems = result?.total ?? 0;
  const totalPages = Math.ceil(totalItems / pageSize);
  const visibleItemsCount = allStock.length;
  const tabSummaryLabel =
    tab === "available"
      ? "Налични артикули"
      : tab === "zero"
        ? "Нулеви артикули"
        : tab === "low-stock"
          ? "Нисък запас"
          : tab === "negative"
            ? "Продукти на минус"
            : "Всички артикули";

  const tabs: {
    key: Tab;
    label: string;
    icon: React.ElementType;
  }[] = [
    { key: "available", label: "Налични", icon: PackageCheck },
    { key: "all", label: "Всички", icon: Warehouse },
    { key: "zero", label: "Нулеви", icon: PackageX },
    { key: "low-stock", label: "Нисък запас", icon: AlertTriangle },
    { key: "negative", label: "На минус", icon: AlertTriangle },
  ];

  const openAdjust = (item: StockLevel) => {
    setAdjustData({
      productId: item.product_id,
      productName: item.product_name || item.name_bg || item.sku || "",
      currentQuantity: Number(item.total_quantity ?? 0),
      unit: item.unit ?? null,
    });
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Склад</h1>
        <p className="text-gray-500 text-sm mt-1">Текущи нива на запасите</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-gray-200">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => {
              setTab(key);
              setPage(1);
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set("tab", key);
                return next;
              });
            }}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === key
                ? "border-[#6c3dff] text-[#6c3dff]"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Търси по име или SKU..."
            className="pl-9"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs uppercase tracking-wide text-gray-500">
              {tabSummaryLabel}
            </p>
            <p className="mt-1 text-2xl font-semibold text-gray-900">
              {totalItems}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs uppercase tracking-wide text-gray-500">
              Показани на страницата
            </p>
            <p className="mt-1 text-2xl font-semibold text-gray-900">
              {visibleItemsCount}
            </p>
          </CardContent>
        </Card>
      </div>

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
                  <TableHead>Продукт</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Категория</TableHead>
                  <TableHead>Мерна ед.</TableHead>
                  <TableHead>Наличност</TableHead>
                  <TableHead>Статус</TableHead>
                  {canAdjustStock && <TableHead className="w-10"></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {allStock.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={canAdjustStock ? 7 : 6}
                      className="text-center text-gray-400 py-8"
                    >
                      Няма намерени записи
                    </TableCell>
                  </TableRow>
                ) : (
                  allStock.map((item) => {
                    const hasStock = item.total_quantity > 0;
                    const isLow =
                      hasStock &&
                      item.total_quantity < (item.low_stock_threshold || 10);
                    const expanded = expandedProductId === item.product_id;
                    return (
                      <React.Fragment key={item.product_id}>
                      <TableRow>
                        <TableCell className="font-medium">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 text-left hover:text-[#6c3dff]"
                            title="Покажи партидите и сроковете на годност"
                            onClick={() =>
                              setExpandedProductId(
                                expanded ? null : item.product_id,
                              )
                            }
                          >
                            {expanded ? (
                              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                            )}
                            {item.product_name}
                          </button>
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {item.sku}
                        </TableCell>
                        <TableCell className="text-sm text-gray-600">
                          {item.category_name_bg ?? "—"}
                        </TableCell>
                        <TableCell>{formatUnit(item.unit)}</TableCell>
                        <TableCell>
                          <span
                            className={
                              item.total_quantity < 0
                                ? "text-red-600 font-bold inline-flex items-center gap-1"
                                : stockColorClass(
                                    item.total_quantity,
                                    item.low_stock_threshold,
                                  )
                            }
                          >
                            {item.total_quantity < 0 && (
                              <AlertTriangle className="h-3.5 w-3.5" />
                            )}
                            {item.total_quantity}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1 flex-wrap">
                            {item.total_quantity < 0 && (
                              <Badge variant="destructive">На минус</Badge>
                            )}
                            {isLow && (
                              <Badge variant="destructive">Нисък запас</Badge>
                            )}
                            {item.total_quantity === 0 && (
                              <Badge variant="outline">Каталог</Badge>
                            )}
                            {hasStock && !isLow && (
                              <Badge variant="success">ОК</Badge>
                            )}
                          </div>
                        </TableCell>
                        {canAdjustStock && (
                          <TableCell>
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label="Корекция на наличност"
                                title="Корекция на наличност"
                                onClick={() => openAdjust(item)}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                      {expanded && (
                        <TableRow className="bg-gray-50/60 hover:bg-gray-50/60">
                          <TableCell colSpan={canAdjustStock ? 7 : 6}>
                            <ProductBatchesPanel
                              productId={item.product_id}
                              canEdit={canAdjustStock}
                            />
                          </TableCell>
                        </TableRow>
                      )}
                      </React.Fragment>
                    );
                  })
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && tab !== "negative" && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">
            Показани {(page - 1) * pageSize + 1}–
            {Math.min(page * pageSize, totalItems)} от {totalItems}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Назад
            </Button>
            <span className="flex items-center px-3 text-sm text-gray-600">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Напред
            </Button>
          </div>
        </div>
      )}

      <AdjustStockModal data={adjustData} onClose={() => setAdjustData(null)} />
    </div>
  );
}
