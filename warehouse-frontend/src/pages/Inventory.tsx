import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  AlertTriangle,
  Warehouse,
  PackageCheck,
  PackageX,
  Pencil,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import type { StockLevel } from "@/types";
import { formatUnit, getApiErrorMessage } from "@/lib/utils";
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

type Tab = "available" | "all" | "zero" | "low-stock";

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

  useEffect(() => {
    if (data) {
      setForm({ delta: "", reason: "" });
    }
  }, [data?.productId]);

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
                    : "border-orange-500 text-orange-700"
                  : ""
              }
            />
            {hasDelta && (
              <div
                className={`text-xs ${deltaNum > 0 ? "text-emerald-700" : "text-orange-700"}`}
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
    if (urlTab && urlTab !== tab) setTab(urlTab);
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

      // For the main inventory endpoint, add stock filters
      if (base === "/inventory") {
        if (tab === "available") params.set("has_stock", "true");
        else if (tab === "zero") params.set("has_stock", "zero");
      }

      return api.get(`${base}?${params}`).then((r) => {
        const d = r.data;
        const arr = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
        const total = d?.pagination?.total ?? d?.count ?? arr.length;
        return {
          items: arr.map((item: any) => normalizeInventoryItem(item)),
          total,
        };
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
                    return (
                      <TableRow key={item.product_id}>
                        <TableCell className="font-medium">
                          {item.product_name}
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
                              isLow
                                ? "text-red-600 font-bold"
                                : "text-gray-900 font-medium"
                            }
                          >
                            {item.total_quantity}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1 flex-wrap">
                            {isLow && (
                              <Badge variant="destructive">Нисък запас</Badge>
                            )}
                            {!hasStock && (
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
                    );
                  })
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
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
