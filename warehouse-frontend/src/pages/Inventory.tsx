import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  AlertTriangle,
  Clock,
  Warehouse,
  PackageCheck,
  PackageX,
  Pencil,
  Trash2,
  Plus,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import {
  WriteOffDialog,
  type WriteOffTarget,
} from "@/components/WriteOffDialog";
import { api } from "@/lib/api";
import type { StockLevel } from "@/types";
import { formatDate, formatUnit, getApiErrorMessage } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

type Tab = "available" | "all" | "zero" | "low-stock" | "expiring";
type QualityFilter = "" | "no_expiry" | "no_batch";

interface EditBatchData {
  productId: number;
  batchId: number;
  productName: string;
  batch_number: string;
  expiry_date: string;
  quantity: number;
  unit?: string | null;
}

function normalizeInventoryItem(item: any): StockLevel {
  const normalizedBatches = Array.isArray(item.batches)
    ? item.batches
    : item.batch_id
      ? [
          {
            batch_id: item.batch_id,
            batch_number: item.batch_number || "",
            expiry_date: item.expiry_date || "",
            quantity: parseFloat(item.quantity ?? item.total_quantity ?? 0),
          },
        ]
      : [];

  return {
    ...item,
    product_name: item.product_name || item.name_bg || item.name_en || item.sku,
    total_quantity: parseFloat(
      item.total_quantity ?? item.total_stock ?? item.quantity ?? 0,
    ),
    batches: normalizedBatches,
  };
}

function EditInventoryModal({
  data,
  onClose,
}: {
  data: EditBatchData | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  // `add_quantity` holds the amount to ADD to the current batch qty
  // (positive only — decreases go through Бракуване with a mandatory
  // reason + PDF протокол). Empty = no-op.
  const [form, setForm] = useState({
    batch_number: "",
    expiry_date: "",
    add_quantity: "",
    adjustment_reason: "",
  });

  useEffect(() => {
    if (data) {
      setForm({
        batch_number: data.batch_number || "",
        expiry_date: data.expiry_date
          ? new Date(data.expiry_date).toISOString().split("T")[0]
          : "",
        add_quantity: "",
        adjustment_reason: "",
      });
    }
  }, [data]);

  // Compute the new total from current + typed add amount.
  const addAmount = parseFloat(form.add_quantity);
  const hasAddAmount =
    form.add_quantity.trim() !== "" &&
    Number.isFinite(addAmount) &&
    addAmount !== 0;
  const newTotal = hasAddAmount
    ? Number(data?.quantity ?? 0) + addAmount
    : Number(data?.quantity ?? 0);

  const mutation = useMutation({
    mutationFn: () =>
      api.put(`/inventory/${data!.productId}/batch/${data!.batchId}`, {
        batch_number: form.batch_number || null,
        expiry_date: form.expiry_date || null,
        // Send the FULL new total — backend is SET-semantics + audit-logs
        // the delta. Omit quantity if no change requested.
        quantity: hasAddAmount ? newTotal : undefined,
        adjustment_reason: form.adjustment_reason || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      onClose();
    },
  });
  const saveError = mutation.error
    ? getApiErrorMessage(mutation.error, "Грешка при запазване на наличността.")
    : "";

  if (!data) return null;

  return (
    <Dialog open={!!data} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle>Редактиране — {data.productName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Партида №</Label>
            <Input
              value={form.batch_number}
              onChange={(e) =>
                setForm((f) => ({ ...f, batch_number: e.target.value }))
              }
              placeholder="Номер на партида"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Срок на годност</Label>
            <Input
              type="date"
              value={form.expiry_date}
              onChange={(e) =>
                setForm((f) => ({ ...f, expiry_date: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <Label>Добави количество</Label>
              <span className="text-xs text-gray-500">
                Текущо:{" "}
                <span className="font-mono font-medium text-gray-700">
                  {data.quantity}
                </span>{" "}
                {data.unit ?? ""}
              </span>
            </div>
            <Input
              type="number"
              step="0.001"
              min="0"
              value={form.add_quantity}
              onChange={(e) =>
                setForm((f) => ({ ...f, add_quantity: e.target.value }))
              }
              placeholder="0"
              className={
                hasAddAmount ? "border-emerald-500 text-emerald-700" : ""
              }
            />
            {hasAddAmount && (
              <div className="text-xs text-emerald-700">
                Ново общо:{" "}
                <span className="font-mono font-medium">
                  {data.quantity} + {addAmount} = {newTotal}
                </span>{" "}
                {data.unit ?? ""}
              </div>
            )}
            <p className="text-[11px] text-gray-400">
              За намаление на наличност (брак, счупено, изтекло) използвай
              страницата "Бракуване".
            </p>
          </div>
          {hasAddAmount && (
            <div className="space-y-1.5">
              <Label>
                Причина за добавянето <span className="text-red-500">*</span>
              </Label>
              <Input
                value={form.adjustment_reason}
                onChange={(e) =>
                  setForm((f) => ({ ...f, adjustment_reason: e.target.value }))
                }
                placeholder="напр. инвентаризация, допълнителна партида..."
              />
              <p className="text-[11px] text-gray-400">
                Записва се в audit log-а (НАП изискване).
              </p>
            </div>
          )}
        </div>
        {saveError && <ErrorMessage message={saveError} />}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Отказ
          </Button>
          {(() => {
            const reasonOk =
              !hasAddAmount || form.adjustment_reason.trim().length >= 3;
            return (
              <Button
                onClick={() => mutation.mutate()}
                disabled={mutation.isPending || !reasonOk}
                title={
                  !reasonOk
                    ? "Задължителна е причина (мин. 3 символа) при промяна на количеството"
                    : undefined
                }
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
            );
          })()}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// AddBatchDialog — създаване на нова партида за съществуващ продукт.
// Използва се за legacy migration (стокът влязъл без партида), belated
// supplier batch info, или split на наличност без партида.
interface AddBatchTarget {
  productId: number;
  productName: string;
  unit?: string | null;
  noBatchQty: number; // колко има в inventory row с batch_id = NULL
}

function AddBatchDialog({
  target,
  onClose,
}: {
  target: AddBatchTarget | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    batch_number: "",
    expiry_date: "",
    quantity: "",
    source: "transfer" as "transfer" | "add",
    reason: "",
  });

  useEffect(() => {
    if (target) {
      setForm({
        batch_number: "",
        expiry_date: "",
        quantity: "",
        // Default: ако има наличност без партида — прехвърляме от нея;
        // иначе директно "нова наличност" (изисква причина).
        source: target.noBatchQty > 0 ? "transfer" : "add",
        reason: "",
      });
    }
  }, [target?.productId]);

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/inventory/${target!.productId}/batch`, {
        batch_number: form.batch_number.trim(),
        expiry_date: form.expiry_date || null,
        quantity: Number(form.quantity),
        source: form.source,
        reason: form.reason.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      onClose();
    },
  });

  const saveError = mutation.error
    ? getApiErrorMessage(mutation.error, "Грешка при създаване на партида.")
    : "";

  if (!target) return null;

  const qty = Number(form.quantity);
  const qtyOk = Number.isFinite(qty) && qty > 0;
  const batchOk = form.batch_number.trim().length > 0;
  const transferOk =
    form.source !== "transfer" || qty <= target.noBatchQty + 0.0001;
  const reasonOk = form.source !== "add" || form.reason.trim().length >= 3;
  const canSubmit = batchOk && qtyOk && transferOk && reasonOk;

  return (
    <Dialog open={!!target} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle>Нова партида — {target.productName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>
              Партида № <span className="text-red-500">*</span>
            </Label>
            <Input
              value={form.batch_number}
              onChange={(e) =>
                setForm((f) => ({ ...f, batch_number: e.target.value }))
              }
              placeholder="напр. L2509 или 01062026"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label>Срок на годност</Label>
            <Input
              type="date"
              value={form.expiry_date}
              onChange={(e) =>
                setForm((f) => ({ ...f, expiry_date: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>
              Количество <span className="text-red-500">*</span>
            </Label>
            <Input
              type="number"
              step="0.001"
              min="0"
              value={form.quantity}
              onChange={(e) =>
                setForm((f) => ({ ...f, quantity: e.target.value }))
              }
              placeholder="0"
            />
          </div>

          {/* Source chooser — transfer vs add (with clear accounting
              implications for each) */}
          <div className="space-y-1.5">
            <Label>Откъде идва количеството?</Label>
            <div className="space-y-2">
              {target.noBatchQty > 0 && (
                <label className="flex items-start gap-2 rounded border border-gray-200 p-2 cursor-pointer hover:bg-gray-50">
                  <input
                    type="radio"
                    name="source"
                    className="mt-0.5"
                    checked={form.source === "transfer"}
                    onChange={() =>
                      setForm((f) => ({ ...f, source: "transfer" }))
                    }
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium">
                      Прехвърли от наличност без партида
                    </div>
                    <div className="text-xs text-gray-500">
                      Налично без партида:{" "}
                      <span className="font-mono">
                        {target.noBatchQty} {target.unit ?? ""}
                      </span>
                      . Общата наличност не се променя.
                    </div>
                  </div>
                </label>
              )}
              <label className="flex items-start gap-2 rounded border border-gray-200 p-2 cursor-pointer hover:bg-gray-50">
                <input
                  type="radio"
                  name="source"
                  className="mt-0.5"
                  checked={form.source === "add"}
                  onChange={() => setForm((f) => ({ ...f, source: "add" }))}
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-amber-700">
                    Нова наличност (увеличение)
                  </div>
                  <div className="text-xs text-gray-500">
                    Общата наличност се увеличава с въведеното количество.
                    Изисква причина.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {form.source === "add" && (
            <div className="space-y-1.5">
              <Label>
                Причина за новата наличност{" "}
                <span className="text-red-500">*</span>
              </Label>
              <Input
                value={form.reason}
                onChange={(e) =>
                  setForm((f) => ({ ...f, reason: e.target.value }))
                }
                placeholder="напр. инвентаризация, belated supplier batch info..."
              />
              <p className="text-[11px] text-gray-400">
                Записва се в audit log-а (НАП изискване).
              </p>
            </div>
          )}

          {!transferOk && (
            <div className="text-xs text-red-600">
              Количеството надвишава налично без партида ({target.noBatchQty}).
              Избери "Нова наличност" или намали количеството.
            </div>
          )}
        </div>
        {saveError && <ErrorMessage message={saveError} />}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Отказ
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !canSubmit}
          >
            {mutation.isPending ? (
              <>
                <Spinner size="sm" />
                Запазване...
              </>
            ) : (
              "Създай партида"
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
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>("");
  const [page, setPage] = useState(1);
  const [editData, setEditData] = useState<EditBatchData | null>(null);
  const [writeOffTarget, setWriteOffTarget] = useState<WriteOffTarget | null>(
    null,
  );
  const [addBatchTarget, setAddBatchTarget] = useState<AddBatchTarget | null>(
    null,
  );
  const { user } = useAuth();
  const canWriteOff = user?.role === "admin" || user?.role === "warehouse";
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
    queryKey: ["inventory", tab, page, qualityFilter, search],
    queryFn: () => {
      let base =
        tab === "low-stock"
          ? "/inventory/low-stock"
          : tab === "expiring"
            ? "/inventory/expiring"
            : "/inventory";

      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(pageSize));
      if (search.trim()) params.set("search", search.trim());

      // For the main inventory endpoint, add stock filters
      if (base === "/inventory") {
        if (tab === "available") params.set("has_stock", "true");
        else if (tab === "zero") params.set("has_stock", "zero");

        // Quality filters
        if (qualityFilter === "no_expiry") params.set("no_expiry", "true");
        if (qualityFilter === "no_batch") params.set("no_batch", "true");
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

  const filtered = allStock.filter((item) => {
    // For expiring tab, only show items that have expiry dates within 30 days or already expired
    if (tab === "expiring") {
      const hasExpiringBatch = item.batches?.some((b: any) => {
        if (!b.expiry_date) return false;
        const diff =
          (new Date(b.expiry_date).getTime() - Date.now()) /
          (1000 * 60 * 60 * 24);
        return diff <= 30;
      });
      return !!hasExpiringBatch;
    }
    return true;
  });
  const visibleItemsCount = filtered.length;
  const tabSummaryLabel =
    tab === "available"
      ? "Налични артикули"
      : tab === "zero"
        ? "Нулеви артикули"
        : tab === "low-stock"
          ? "Нисък запас"
          : tab === "expiring"
            ? "Изтичащи партиди"
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
    { key: "expiring", label: "Изтичащи", icon: Clock },
  ];

  const qualityChips: { value: QualityFilter; label: string }[] = [
    { value: "no_expiry", label: "Без срок на годност" },
    { value: "no_batch", label: "Без партида" },
  ];

  const handleEditBatch = (item: StockLevel, batch: any) => {
    setEditData({
      productId: item.product_id,
      batchId: batch.batch_id,
      productName: item.product_name || item.name_bg || item.sku || "",
      batch_number: batch.batch_number || "",
      expiry_date: batch.expiry_date || "",
      quantity: parseFloat(batch.quantity ?? 0),
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
              setQualityFilter("");
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

      {/* Search + Quality filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Търси по име, SKU или партида..."
            className="pl-9"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        {/* Quality filter chips — only on main tabs */}
        {(tab === "available" || tab === "all" || tab === "zero") && (
          <div className="flex gap-2">
            {qualityChips.map((chip) => (
              <button
                key={chip.value}
                onClick={() => {
                  setQualityFilter((prev) =>
                    prev === chip.value ? "" : chip.value,
                  );
                  setPage(1);
                }}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                  qualityFilter === chip.value
                    ? "bg-orange-50 text-orange-700 border-orange-300"
                    : "bg-white text-gray-500 border-gray-300 hover:text-gray-700"
                }`}
              >
                {chip.label} {qualityFilter === chip.value ? "✕" : ""}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
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
        <Card>
          <CardContent className="p-4">
            <p className="text-xs uppercase tracking-wide text-gray-500">
              Активен филтър
            </p>
            <p className="mt-1 text-sm font-medium text-gray-900">
              {qualityFilter === "no_expiry"
                ? "Без срок на годност"
                : qualityFilter === "no_batch"
                  ? "Без партида"
                  : "Без допълнителен филтър"}
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
                  <TableHead>Мерна ед.</TableHead>
                  <TableHead>Наличност</TableHead>
                  <TableHead>Партида</TableHead>
                  <TableHead>Срок на годност</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="text-center text-gray-400 py-8"
                    >
                      Няма намерени записи
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((item) => {
                    const hasReceivedStock =
                      item.batches?.length > 0 || item.total_quantity > 0;
                    const isLow =
                      hasReceivedStock &&
                      item.total_quantity < (item.low_stock_threshold || 10);
                    const hasExpiring = item.batches?.some((b: any) => {
                      const diff =
                        (new Date(b.expiry_date).getTime() - Date.now()) /
                        (1000 * 60 * 60 * 24);
                      return diff <= 30 && diff > 0;
                    });

                    const batchCount = item.batches?.length ?? 0;
                    const isSingleBatch = batchCount === 1;
                    return (
                      <TableRow
                        key={item.product_id}
                        className={
                          isSingleBatch ? "cursor-pointer hover:bg-gray-50" : ""
                        }
                        onClick={() => {
                          // Only open row-level edit when there's exactly ONE
                          // batch — otherwise the user would always land on
                          // batches[0] and the other batches would be
                          // unreachable. For multi-batch products the user
                          // clicks the specific batch chip in the Партида /
                          // Срок колони (each is independently editable).
                          if (isSingleBatch) {
                            handleEditBatch(item, item.batches[0]);
                          }
                        }}
                      >
                        <TableCell className="font-medium">
                          {item.product_name}
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {item.sku}
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
                        {/* Партида колона — всяка партида е clickable (отваря
                            точно тази за редакция, вместо винаги batches[0]). */}
                        <TableCell>
                          <div className="space-y-0.5">
                            {item.batches?.length > 0 ? (
                              item.batches.map((b: any, idx: number) => (
                                <button
                                  key={b.batch_id ?? `batch-${idx}`}
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleEditBatch(item, b);
                                  }}
                                  className="block text-xs text-left"
                                  title="Редактирай партидата"
                                >
                                  {b.batch_number ? (
                                    <span className="font-mono bg-gray-100 hover:bg-emerald-100 text-gray-700 hover:text-emerald-900 px-1.5 py-0.5 rounded transition-colors">
                                      {b.batch_number}
                                    </span>
                                  ) : (
                                    <span className="text-gray-400 italic hover:text-emerald-600 hover:underline">
                                      — без №
                                    </span>
                                  )}
                                </button>
                              ))
                            ) : (
                              <span className="text-gray-400 italic text-xs">
                                —
                              </span>
                            )}
                          </div>
                        </TableCell>
                        {/* Срок на годност колона — also per-batch clickable. */}
                        <TableCell>
                          <div className="space-y-0.5">
                            {item.batches?.length > 0 ? (
                              item.batches.map((b: any, idx: number) => {
                                const expColorClass = !b.expiry_date
                                  ? "text-gray-400 italic"
                                  : new Date(b.expiry_date) < new Date()
                                    ? "text-red-600 font-semibold"
                                    : (new Date(b.expiry_date).getTime() -
                                          Date.now()) /
                                          (1000 * 60 * 60 * 24) <=
                                        30
                                      ? "text-orange-500 font-semibold"
                                      : "text-green-600 font-medium";
                                return (
                                  <button
                                    key={b.batch_id ?? `exp-${idx}`}
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleEditBatch(item, b);
                                    }}
                                    className="block text-xs text-left hover:underline decoration-dotted underline-offset-2"
                                    title="Редактирай срока"
                                  >
                                    <span className={expColorClass}>
                                      {b.expiry_date
                                        ? formatDate(b.expiry_date)
                                        : "без срок"}
                                    </span>
                                  </button>
                                );
                              })
                            ) : (
                              <span className="text-gray-400 italic text-xs">
                                —
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1 flex-wrap">
                            {isLow && (
                              <Badge variant="destructive">Нисък запас</Badge>
                            )}
                            {hasExpiring && (
                              <Badge variant="warning">Изтичащо</Badge>
                            )}
                            {!hasReceivedStock && (
                              <Badge variant="outline">Каталог</Badge>
                            )}
                            {hasReceivedStock && !isLow && !hasExpiring && (
                              <Badge variant="success">ОК</Badge>
                            )}
                          </div>
                        </TableCell>
                        {/* Top-level action buttons са enabled САМО ако има
                            точно 1 партида — няма двусмислие коя да се
                            отвори. При multi-batch потребителят кликва
                            директно chip-а на конкретната партида (или
                            срока) в Партида/Срок на годност колоните.
                            Hint текст "кликни партида" се показва когато
                            има 2+ партиди, за да е ясен UX-ът. */}
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
                            {isSingleBatch && (
                              <>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  aria-label="Редактирай партида"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleEditBatch(item, item.batches[0]);
                                  }}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                {canWriteOff &&
                                  item.batches[0].quantity > 0 && (
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      aria-label="Бракувай партида"
                                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        const b = item.batches[0];
                                        setWriteOffTarget({
                                          product_id: item.product_id,
                                          product_name:
                                            item.name_bg ||
                                            item.name_en ||
                                            `#${item.product_id}`,
                                          batch_id: b.batch_id,
                                          batch_number: b.batch_number || null,
                                          expiry_date: b.expiry_date || null,
                                          current_quantity: Number(b.quantity),
                                          unit_cost: (() => {
                                            const raw = (item as any)
                                              .purchase_price;
                                            const n = Number(raw);
                                            return Number.isFinite(n) && n > 0
                                              ? n
                                              : null;
                                          })(),
                                          unit: item.unit ?? null,
                                        });
                                      }}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                  )}
                              </>
                            )}
                            {batchCount > 1 && (
                              <span className="text-[10px] text-gray-400 italic whitespace-nowrap">
                                кликни партида ↑
                              </span>
                            )}
                            {/* "+ Партида" винаги достъпно — позволява
                                retroactive добавяне на партиди/срокове
                                (legacy migration, belated supplier info,
                                split на наличност без партида). */}
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label="Добави нова партида"
                              title="Добави нова партида"
                              className="text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                              onClick={(e) => {
                                e.stopPropagation();
                                const sumBatchQty = (item.batches ?? []).reduce(
                                  (acc: number, b: any) =>
                                    acc + (parseFloat(b.quantity) || 0),
                                  0,
                                );
                                const noBatchQty = Math.max(
                                  0,
                                  Number(item.total_quantity) - sumBatchQty,
                                );
                                setAddBatchTarget({
                                  productId: item.product_id,
                                  productName:
                                    item.product_name ||
                                    item.name_bg ||
                                    item.name_en ||
                                    item.sku ||
                                    `#${item.product_id}`,
                                  unit: item.unit ?? null,
                                  noBatchQty,
                                });
                              }}
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
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

      <EditInventoryModal data={editData} onClose={() => setEditData(null)} />

      <AddBatchDialog
        target={addBatchTarget}
        onClose={() => setAddBatchTarget(null)}
      />

      <WriteOffDialog
        open={writeOffTarget != null}
        target={writeOffTarget}
        onClose={() => setWriteOffTarget(null)}
      />
    </div>
  );
}
