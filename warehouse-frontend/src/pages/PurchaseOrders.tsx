import {
  useState,
  useMemo,
  useRef,
  forwardRef,
  useImperativeHandle,
  type KeyboardEvent,
} from "react";
import {
  useQuery,
  useQueries,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import AsyncSelect from "react-select/async";
import {
  Plus,
  Trash2,
  FileDown,
  Send,
  Undo2,
  PackageCheck,
  Package,
  Pencil,
  Merge,
} from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { formatDate, getApiErrorMessage } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
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
import { LoadingOverlay, ErrorMessage } from "@/components/ui/spinner";
import {
  PurchaseOrdersToolbar,
  type PeriodFilter,
  type StatusFilter,
} from "@/components/purchase-orders/PurchaseOrdersToolbar";
import { NoteCard } from "@/components/purchase-orders/NoteCard";
import { colorForSupplier } from "@/lib/supplier-colors";

// ── Types ────────────────────────────────────────────────────────────
type PurchaseOrderStatus = "note" | "draft" | "sent" | "received";

interface Supplier {
  id: number;
  name: string;
}

interface PurchaseOrderListRow {
  id: number;
  order_number: string;
  supplier_id: number;
  supplier_name: string;
  status: PurchaseOrderStatus;
  notes: string | null;
  label: string | null;
  expected_delivery_date: string | null;
  sent_at: string | null;
  received_at: string | null;
  incoming_goods_id: number | null;
  merged_from_count: number;
  item_count: number | string;
  total_quantity: number | string | null;
  created_at: string;
}

interface PurchaseOrderItem {
  id?: number;
  product_id: number;
  product_name?: string;
  product_code?: string | null;
  product_unit?: string | null;
  quantity: number;
  notes?: string | null;
  total_stock?: number | string | null;
}

interface PurchaseOrderDetail extends PurchaseOrderListRow {
  items: PurchaseOrderItem[];
  supplier_eik?: string | null;
  label: string | null;
  merged_from_count: number;
}

interface ProductOption {
  value: number;
  label: string;
  product: {
    id: number;
    name_bg?: string;
    name_en?: string;
    sku?: string;
    unit?: string;
    total_stock?: number | string;
  };
}

const STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  note: "Бележка",
  draft: "Чернова",
  sent: "Изпратена",
  received: "Получена",
};

const STATUS_VARIANTS: Record<
  PurchaseOrderStatus,
  "secondary" | "warning" | "info" | "success"
> = {
  note: "secondary",
  draft: "warning",
  sent: "info",
  received: "success",
};

// ── Drawer ───────────────────────────────────────────────────────────

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  orderId: number | null;
}

function emptyItem(): PurchaseOrderItem {
  return { product_id: 0, quantity: 1 };
}

interface ProductPickerHandle {
  focus: () => void;
}

const ProductPicker = forwardRef<
  ProductPickerHandle,
  { onSelect: (p: ProductOption["product"]) => void }
>(function ProductPicker({ onSelect }, ref) {
  const selectRef = useRef<any>(null);
  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        try {
          selectRef.current?.focus?.();
        } catch {
          /* noop */
        }
      },
    }),
    [],
  );
  const loadOptions = async (q: string): Promise<ProductOption[]> => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("search", q.trim());
    params.set("limit", "30");
    const res = await api.get(`/products?${params}`);
    const raw = res.data;
    const data = Array.isArray(raw) ? raw : (raw?.data ?? []);
    return data
      .filter((p: any) => p && (p.name_bg || p.name_en))
      .map((p: any) => ({
        value: p.id,
        label: `${p.sku ? `[${p.sku}] ` : ""}${p.name_bg || p.name_en}`,
        product: {
          id: p.id,
          name_bg: p.name_bg,
          name_en: p.name_en,
          sku: p.sku,
          unit: p.unit,
          total_stock: p.total_stock,
        },
      }));
  };
  return (
    <AsyncSelect<ProductOption, false>
      ref={selectRef}
      loadOptions={loadOptions}
      defaultOptions
      cacheOptions={false}
      menuPlacement="auto"
      menuShouldScrollIntoView
      menuPortalTarget={
        typeof document !== "undefined" ? document.body : undefined
      }
      menuPosition="fixed"
      menuShouldBlockScroll
      styles={{
        menu: (base) => ({ ...base, zIndex: 9999 }),
        menuPortal: (base) => ({ ...base, zIndex: 9999 }),
        control: (base) => ({
          ...base,
          minHeight: "40px",
          borderColor: "#d1d5db",
          "&:hover": { borderColor: "#f97316" },
          boxShadow: "none",
        }),
      }}
      formatOptionLabel={(option) => {
        if (!option?.product) {
          return <span className="text-sm">{option?.label ?? "—"}</span>;
        }
        const p = option.product;
        const stock = parseFloat(String(p.total_stock ?? 0));
        return (
          <div className="flex justify-between items-center">
            <div className="min-w-0">
              <div className="font-medium text-sm truncate">
                {p.name_bg || p.name_en || "Без име"}
              </div>
              <div className="text-xs text-gray-400">{p.sku || ""}</div>
            </div>
            <div className="text-right ml-4 shrink-0">
              <div className="text-xs">
                {stock < 0 ? (
                  <span className="text-red-600 font-semibold">
                    на минус: {stock}
                  </span>
                ) : (
                  <span
                    className={
                      stock > 0
                        ? "text-emerald-600 font-medium"
                        : "text-red-500 font-medium"
                    }
                  >
                    налично: {stock}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      }}
      onChange={(opt) => opt && onSelect(opt.product)}
      value={null}
      placeholder="Търси продукт по код или име…"
      noOptionsMessage={() => "Няма резултати"}
      classNamePrefix="rs"
    />
  );
});

function PurchaseOrderDrawer({ open, onClose, orderId }: DrawerProps) {
  const qc = useQueryClient();
  const isEdit = orderId !== null;

  const detailQuery = useQuery({
    queryKey: ["purchase-order", orderId],
    queryFn: () =>
      api
        .get(`/purchase-orders/${orderId}`)
        .then((r) => r.data as PurchaseOrderDetail),
    enabled: open && isEdit,
  });

  const suppliersQuery = useQuery({
    queryKey: ["suppliers", "for-purchase-orders"],
    queryFn: () =>
      api.get("/suppliers").then((r) => (r.data?.data ?? r.data) as Supplier[]),
    enabled: open,
  });

  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [label, setLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [items, setItems] = useState<PurchaseOrderItem[]>([emptyItem()]);
  // Keyboard flow refs:
  //   - qtyInputRefs: focus the qty cell of the row just added
  //   - productPickerRef: focus the product search after Enter in qty
  //   - pendingFocusProductIdRef: marker after picking a product, focus its qty
  const qtyInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const productPickerRef = useRef<any>(null);
  const pendingFocusProductIdRef = useRef<number | null>(null);

  const focusProductPicker = () => {
    queueMicrotask(() => {
      try {
        productPickerRef.current?.focus?.();
      } catch {
        /* noop — react-select ref may not be ready */
      }
    });
  };

  // Sync form when detail loads (edit mode) or drawer opens fresh.
  useMemo(() => {
    if (!open) return;
    if (isEdit && detailQuery.data) {
      setSupplierId(detailQuery.data.supplier_id);
      setLabel(detailQuery.data.label ?? "");
      setNotes(detailQuery.data.notes ?? "");
      setExpectedDate(
        detailQuery.data.expected_delivery_date
          ? detailQuery.data.expected_delivery_date.slice(0, 10)
          : "",
      );
      setItems(
        detailQuery.data.items.length > 0
          ? detailQuery.data.items.map((i) => ({
              product_id: i.product_id,
              product_name: i.product_name,
              product_code: i.product_code,
              product_unit: i.product_unit,
              quantity: Number(i.quantity),
              notes: i.notes ?? null,
              total_stock: i.total_stock ?? 0,
            }))
          : [emptyItem()],
      );
    } else if (!isEdit) {
      setSupplierId(null);
      setLabel("");
      setNotes("");
      setExpectedDate("");
      setItems([emptyItem()]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isEdit, detailQuery.data?.id]);

  const detail = detailQuery.data;
  const isReadOnly =
    isEdit && detail?.status !== "draft" && detail?.status !== "note";
  const isNote = isEdit ? detail?.status === "note" : true;

  const saveMut = useMutation({
    mutationFn: async () => {
      const validItems = items.filter(
        (i) => i.product_id > 0 && i.quantity > 0,
      );
      if (!supplierId) throw new Error("Избери доставчик");
      if (validItems.length === 0) throw new Error("Добави поне един артикул");
      const payload = {
        supplier_id: supplierId,
        label: label || null,
        notes: notes || null,
        expected_delivery_date: expectedDate || null,
        items: validItems.map((i) => ({
          product_id: i.product_id,
          quantity: i.quantity,
          notes: i.notes ?? null,
        })),
      };
      if (isEdit) {
        return (await api.patch(`/purchase-orders/${orderId}`, payload)).data;
      }
      return (await api.post("/purchase-orders", payload)).data;
    },
    onSuccess: () => {
      toast.success(isEdit ? "Заявката е обновена" : "Заявката е създадена");
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["purchase-order", orderId] });
      onClose();
    },
    onError: (err) =>
      toast.error(getApiErrorMessage(err, "Грешка при запазване")),
  });

  const sendMut = useMutation({
    mutationFn: () =>
      api.post(`/purchase-orders/${orderId}/send`).then((r) => r.data),
    onSuccess: () => {
      toast.success("Заявката е маркирана като 'Изпратена'");
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["purchase-order", orderId] });
    },
    onError: (err) =>
      toast.error(getApiErrorMessage(err, "Грешка при изпращане")),
  });

  const reopenMut = useMutation({
    mutationFn: () =>
      api.post(`/purchase-orders/${orderId}/reopen`).then((r) => r.data),
    onSuccess: () => {
      toast.success("Заявката е върната в чернова");
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["purchase-order", orderId] });
    },
    onError: (err) =>
      toast.error(getApiErrorMessage(err, "Грешка при връщане в чернова")),
  });

  const convertMut = useMutation({
    mutationFn: () =>
      api
        .post(`/purchase-orders/${orderId}/convert-to-incoming`)
        .then((r) => r.data),
    onSuccess: (data) => {
      toast.success(
        `Създадено приемане на стока #${data.incoming_goods_id ?? "?"}`,
      );
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["purchase-order", orderId] });
    },
    onError: (err) =>
      toast.error(getApiErrorMessage(err, "Грешка при конвертиране")),
  });

  const convertSingleNoteMut = useMutation({
    mutationFn: () =>
      api
        .post("/purchase-orders/merge", { ids: [orderId] })
        .then((r) => r.data),
    onSuccess: (data) => {
      toast.success(`Бележка превърната в ${data.order_number}`);
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["purchase-order", orderId] });
      onClose();
    },
    onError: (err) =>
      toast.error(getApiErrorMessage(err, "Грешка при обединяване")),
  });

  const handleAddProduct = (p: ProductOption["product"]) => {
    setItems((prev) => {
      // Skip if already present — but still focus its qty input so the
      // user can quickly bump the count.
      const existingIdx = prev.findIndex((i) => i.product_id === p.id);
      if (existingIdx >= 0) {
        pendingFocusProductIdRef.current = p.id;
        toast.info("Продуктът вече е добавен");
        return prev;
      }
      const next: PurchaseOrderItem = {
        product_id: p.id,
        product_name: p.name_bg || p.name_en || "",
        product_code: p.sku ?? null,
        product_unit: p.unit ?? null,
        quantity: 1,
        total_stock: p.total_stock ?? 0,
      };
      const filtered = prev.filter((i) => i.product_id > 0);
      pendingFocusProductIdRef.current = p.id;
      return [...filtered, next];
    });
  };

  // After items re-render, focus + select the qty input of the last-added
  // product so user can immediately overtype the default "1".
  useMemo(() => {
    const targetId = pendingFocusProductIdRef.current;
    if (!targetId) return;
    queueMicrotask(() => {
      const el = qtyInputRefs.current[targetId];
      if (el) {
        el.focus();
        el.select();
      }
      pendingFocusProductIdRef.current = null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const canSubmit =
    !!supplierId && items.some((i) => i.product_id > 0 && i.quantity > 0);

  // Keyboard flow:
  //   - Supplier select → Enter → jump to product picker
  //   - Product picker → Enter → react-select picks option → effect focuses qty
  //   - Qty input → Enter → jump back to product picker (NEW item)
  //   - Submit only with Ctrl/Cmd+Enter or by clicking the button — Enter
  //     alone never creates the order, so the user can keep adding items
  //     without an accidental submit.
  const handleDialogKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter") return;
    if (!(e.ctrlKey || e.metaKey)) return;
    if (!canSubmit || saveMut.isPending) return;
    e.preventDefault();
    saveMut.mutate();
  };

  const downloadPdf = async () => {
    if (!orderId) return;
    try {
      const res = await api.get(`/purchase-orders/${orderId}/pdf`, {
        responseType: "blob",
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${detail?.order_number ?? "ZA"}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Грешка при изтегляне"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()} modal={false}>
      <DialogContent
        className="sm:max-w-[95vw] lg:max-w-[1100px] max-h-[92vh] flex flex-col"
        onKeyDown={handleDialogKeyDown}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-3">
            {isEdit
              ? isNote
                ? `Бележка${detail?.label ? ` — ${detail.label}` : ""}`
                : `Заявка ${detail?.order_number ?? ""}`
              : "Нова бележка"}
            {isEdit && detail && (
              <Badge variant={STATUS_VARIANTS[detail.status]}>
                {STATUS_LABELS[detail.status]}
              </Badge>
            )}
            {isEdit && (detail?.merged_from_count ?? 0) > 0 && (
              <span className="text-xs text-gray-500">
                от {detail!.merged_from_count}{" "}
                {detail!.merged_from_count === 1 ? "бележка" : "бележки"}
              </span>
            )}
          </DialogTitle>
          <p className="text-xs text-gray-400 mt-1">
            Enter избира · Enter в количеството отваря нов продукт · Ctrl+Enter
            създава заявката
          </p>
        </DialogHeader>

        {detailQuery.isLoading && isEdit ? (
          <LoadingOverlay text="Зареждане…" />
        ) : (
          <div className="flex-1 overflow-y-auto min-h-0 space-y-4 py-2 pr-1">
            {/* Supplier + expected date */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>Доставчик</Label>
                <select
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white disabled:bg-gray-50"
                  value={supplierId ?? ""}
                  disabled={isReadOnly}
                  onChange={(e) =>
                    setSupplierId(
                      e.target.value ? Number(e.target.value) : null,
                    )
                  }
                  onKeyDown={(e) => {
                    // Enter on the supplier select jumps to the product
                    // picker so the keyboard flow can keep going.
                    if (e.key === "Enter" && supplierId) {
                      e.preventDefault();
                      focusProductPicker();
                    }
                  }}
                >
                  <option value="">— Избери —</option>
                  {(suppliersQuery.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              {!isNote && (
                <div>
                  <Label>Очаквана дата на доставка</Label>
                  <Input
                    type="date"
                    value={expectedDate}
                    disabled={isReadOnly}
                    onChange={(e) => setExpectedDate(e.target.value)}
                  />
                </div>
              )}
            </div>

            {isNote && (
              <div>
                <Label>Етикет (опционално)</Label>
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="напр. Кухня в Хемус"
                  maxLength={120}
                  disabled={isReadOnly}
                />
              </div>
            )}

            {/* Items */}
            <div>
              <Label>Артикули</Label>
              <div className="rounded-lg border border-gray-200 mt-1">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[140px]">Код</TableHead>
                      <TableHead>Наименование</TableHead>
                      <TableHead className="w-[90px] text-right">
                        Налични
                      </TableHead>
                      <TableHead className="w-[120px] text-right">
                        Количество
                      </TableHead>
                      <TableHead className="w-[80px]">Мярка</TableHead>
                      <TableHead className="w-[40px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items
                      .filter((i) => i.product_id > 0)
                      .map((item, idx) => (
                        <TableRow key={`${item.product_id}-${idx}`}>
                          <TableCell className="font-mono font-bold text-[#f97316]">
                            {item.product_code || "—"}
                          </TableCell>
                          <TableCell className="text-sm">
                            {item.product_name}
                          </TableCell>
                          <TableCell className="text-right text-sm">
                            {(() => {
                              const s = parseFloat(
                                String(item.total_stock ?? 0),
                              );
                              return (
                                <span
                                  className={`font-medium ${s > 0 ? "text-green-600" : "text-red-500"}`}
                                >
                                  {s}
                                </span>
                              );
                            })()}
                          </TableCell>
                          <TableCell>
                            <Input
                              ref={(el) => {
                                qtyInputRefs.current[item.product_id] = el;
                              }}
                              type="number"
                              min="0"
                              step="0.01"
                              className="text-right"
                              value={item.quantity}
                              disabled={isReadOnly}
                              onChange={(e) => {
                                const v = parseFloat(e.target.value) || 0;
                                setItems((prev) =>
                                  prev.map((it) =>
                                    it.product_id === item.product_id
                                      ? { ...it, quantity: v }
                                      : it,
                                  ),
                                );
                              }}
                              onKeyDown={(e) => {
                                // Plain Enter in qty → jump back to picker
                                // for the next product. Ctrl+Enter still
                                // submits via the dialog-level handler.
                                if (
                                  e.key === "Enter" &&
                                  !e.ctrlKey &&
                                  !e.metaKey
                                ) {
                                  e.preventDefault();
                                  focusProductPicker();
                                }
                              }}
                            />
                          </TableCell>
                          <TableCell className="text-sm text-gray-500">
                            {item.product_unit || "бр."}
                          </TableCell>
                          <TableCell>
                            {!isReadOnly && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  setItems((prev) =>
                                    prev.filter(
                                      (it) => it.product_id !== item.product_id,
                                    ),
                                  )
                                }
                              >
                                <Trash2 className="h-4 w-4 text-red-500" />
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    {items.filter((i) => i.product_id > 0).length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="text-center text-sm text-gray-400 py-6"
                        >
                          Няма добавени артикули
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              {!isReadOnly && (
                <div className="mt-2">
                  <ProductPicker
                    ref={productPickerRef}
                    onSelect={handleAddProduct}
                  />
                </div>
              )}
            </div>

            {/* Notes */}
            <div>
              <Label>Бележки</Label>
              <Textarea
                rows={3}
                value={notes}
                disabled={isReadOnly}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Допълнителна информация — пакетиране, транспорт, сезон и т.н."
              />
            </div>

            {detail?.incoming_goods_id && (
              <div className="text-sm text-gray-600 pt-2 border-t">
                Свързано приемане на стока:{" "}
                <a
                  href={`/incoming?id=${detail.incoming_goods_id}`}
                  className="text-[#f97316] underline"
                >
                  #{detail.incoming_goods_id}
                </a>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="shrink-0 flex-wrap gap-2 sm:flex-row sm:justify-start">
          {!isReadOnly && (
            <Button
              onClick={() => saveMut.mutate()}
              disabled={saveMut.isPending}
            >
              {saveMut.isPending
                ? "Запазване…"
                : isEdit
                  ? "Запази промените"
                  : isNote
                    ? "Създай бележка"
                    : "Създай заявка"}
            </Button>
          )}
          {isEdit && isNote && (
            <Button
              variant="outline"
              onClick={() => convertSingleNoteMut.mutate()}
              disabled={convertSingleNoteMut.isPending}
            >
              <Merge className="h-4 w-4 mr-1" />
              {convertSingleNoteMut.isPending
                ? "Превръщане…"
                : "Превърни в заявка"}
            </Button>
          )}
          {isEdit && detail?.status === "draft" && (
            <Button
              variant="outline"
              onClick={() => sendMut.mutate()}
              disabled={sendMut.isPending}
            >
              <Send className="h-4 w-4 mr-1" /> Маркирай като изпратена
            </Button>
          )}
          {isEdit && detail?.status === "sent" && (
            <>
              <Button
                variant="outline"
                onClick={() => convertMut.mutate()}
                disabled={convertMut.isPending}
              >
                <PackageCheck className="h-4 w-4 mr-1" />
                Превърни в приемане на стока
              </Button>
              <Button
                variant="outline"
                onClick={() => reopenMut.mutate()}
                disabled={reopenMut.isPending}
              >
                <Undo2 className="h-4 w-4 mr-1" /> Върни в чернова
              </Button>
            </>
          )}
          {isEdit && (
            <Button variant="outline" onClick={downloadPdf}>
              <FileDown className="h-4 w-4 mr-1" /> Свали PDF
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Затвори
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Page ─────────────────────────────────────────────────────────────

export default function PurchaseOrders() {
  const qc = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [period, setPeriod] = useState<PeriodFilter>("this-week");
  const [status, setStatus] = useState<StatusFilter>("");
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const listQuery = useQuery({
    queryKey: ["purchase-orders", period, status, search],
    queryFn: () => {
      const qs = new URLSearchParams();
      qs.set("period", period);
      if (status) qs.set("status", status);
      if (search.trim()) qs.set("search", search.trim());
      return api
        .get(`/purchase-orders?${qs.toString()}`)
        .then((r) => r.data?.data as PurchaseOrderListRow[]);
    },
  });

  // Notes also need their items for the card preview. We fetch each note's
  // detail lazily — react-query caches per-id so re-renders are cheap.
  const noteIds = useMemo(
    () =>
      (listQuery.data ?? [])
        .filter((r) => r.status === "note")
        .map((r) => r.id),
    [listQuery.data],
  );
  const noteDetails = useQueries({
    queries: noteIds.map((id) => ({
      queryKey: ["purchase-order", id],
      queryFn: () => api.get(`/purchase-orders/${id}`).then((r) => r.data),
      staleTime: 30_000,
    })),
  });
  const itemsById = useMemo(() => {
    const map = new Map<number, PurchaseOrderItem[]>();
    noteDetails.forEach((q) => {
      if (q.data) map.set(q.data.id, q.data.items ?? []);
    });
    return map;
  }, [noteDetails]);

  const mergeMut = useMutation({
    mutationFn: (ids: number[]) =>
      api.post("/purchase-orders/merge", { ids }).then((r) => r.data),
    onSuccess: (data) => {
      toast.success(
        selectedIds.size > 1
          ? `${selectedIds.size} бележки обединени в ${data.order_number}`
          : `Бележка превърната в ${data.order_number}`,
      );
      setSelectedIds(new Set());
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      setEditingId(data.id);
      setDrawerOpen(true);
    },
    onError: (err) =>
      toast.error(getApiErrorMessage(err, "Грешка при обединяване")),
  });

  const openNew = () => {
    setEditingId(null);
    setDrawerOpen(true);
  };
  const openEdit = (id: number) => {
    setEditingId(id);
    setDrawerOpen(true);
  };

  const toggleSelect = (id: number, rowStatus: PurchaseOrderStatus) => {
    if (rowStatus !== "note") return; // Only notes selectable
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allRows = listQuery.data ?? [];
  const notes = allRows.filter((r) => r.status === "note");
  const orders = allRows.filter((r) => r.status !== "note");

  // Group notes by supplier
  const notesBySupplier = useMemo(() => {
    const groups = new Map<
      number,
      { name: string; notes: PurchaseOrderListRow[] }
    >();
    for (const n of notes) {
      const g = groups.get(n.supplier_id) ?? {
        name: n.supplier_name,
        notes: [],
      };
      g.notes.push(n);
      groups.set(n.supplier_id, g);
    }
    return Array.from(groups.entries());
  }, [notes]);

  const selectedRows = allRows.filter((r) => selectedIds.has(r.id));
  const selectedSupplierIds = new Set(selectedRows.map((r) => r.supplier_id));
  const sameSupplier = selectedSupplierIds.size <= 1;
  const canConvert =
    selectedRows.length >= 1 &&
    sameSupplier &&
    selectedRows.every((r) => r.status === "note");

  const counts: Record<StatusFilter, number> = {
    "": allRows.length,
    note: notes.length,
    draft: orders.filter((o) => o.status === "draft").length,
    sent: orders.filter((o) => o.status === "sent").length,
    received: orders.filter((o) => o.status === "received").length,
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Package className="h-6 w-6 text-[#f97316]" />
            Заявки
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            Бележки през деня → официална заявка за доставчика
          </p>
        </div>
        <Button onClick={openNew}>
          <Plus className="h-4 w-4 mr-1" /> Нова бележка
        </Button>
      </div>

      <PurchaseOrdersToolbar
        period={period}
        status={status}
        search={search}
        counts={counts}
        onPeriod={setPeriod}
        onStatus={setStatus}
        onSearch={setSearch}
      />

      {selectedIds.size >= 1 && (
        <div className="flex items-center justify-between bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
          <span className="text-sm text-orange-900">
            {!sameSupplier ? (
              <span className="text-red-600">
                Бележките трябва да са от един и същ доставчик
              </span>
            ) : (
              <>
                <strong>{selectedIds.size}</strong>{" "}
                {selectedIds.size === 1 ? "бележка избрана" : "бележки избрани"}{" "}
                · {selectedRows[0]?.supplier_name}
              </>
            )}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelectedIds(new Set())}
            >
              Изчисти
            </Button>
            <Button
              size="sm"
              onClick={() => mergeMut.mutate([...selectedIds])}
              disabled={!canConvert || mergeMut.isPending}
            >
              <Merge className="h-4 w-4 mr-1" />
              {mergeMut.isPending ? "Превръщане…" : "Превърни в заявка"}
            </Button>
          </div>
        </div>
      )}

      {/* Бележки секция */}
      {(status === "" || status === "note") && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-sm font-semibold text-gray-700">Бележки</h2>
            <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
              {notes.length}
            </span>
            <span className="text-xs text-gray-400 ml-auto">
              маркер = доставчик · клик за избор · 1+ бележки за един доставчик
              за обединение
            </span>
          </div>
          {notesBySupplier.length === 0 ? (
            <div className="text-sm text-gray-400 italic py-6 text-center">
              Няма бележки за този период.
            </div>
          ) : (
            notesBySupplier.map(([supplierId, group]) => {
              const color = colorForSupplier(supplierId);
              return (
                <div key={supplierId} className="mb-4">
                  <div className="flex items-center gap-2 px-1 py-1.5 border-b border-gray-100 mb-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: color.bg }}
                    />
                    {group.name}
                    <span className="ml-auto font-normal normal-case text-gray-400">
                      {group.notes.length}{" "}
                      {group.notes.length === 1 ? "бележка" : "бележки"}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                    {group.notes.map((n) => {
                      const items = itemsById.get(n.id) ?? [];
                      return (
                        <NoteCard
                          key={n.id}
                          note={{
                            id: n.id,
                            label: n.label,
                            created_at: n.created_at,
                            items,
                            total_quantity: Number(n.total_quantity ?? 0),
                            item_count: Number(n.item_count ?? 0),
                          }}
                          selected={selectedIds.has(n.id)}
                          onToggle={() => toggleSelect(n.id, n.status)}
                          onOpen={() => openEdit(n.id)}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Заявки таблица */}
      {(status === "" ||
        status === "draft" ||
        status === "sent" ||
        status === "received") && (
        <div className="rounded-lg border border-gray-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[130px]">№</TableHead>
                <TableHead>Доставчик</TableHead>
                <TableHead className="text-right">Артикули</TableHead>
                <TableHead className="text-right">Кол.</TableHead>
                <TableHead>Очаквана</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead className="w-[40px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer hover:bg-gray-50"
                  onClick={() => openEdit(row.id)}
                >
                  <TableCell className="font-mono font-medium">
                    {row.order_number}
                    {row.merged_from_count > 0 && (
                      <span className="block text-[11px] text-gray-400 font-sans font-normal">
                        от {row.merged_from_count}{" "}
                        {row.merged_from_count === 1 ? "бележка" : "бележки"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{row.supplier_name}</TableCell>
                  <TableCell className="text-right">{row.item_count}</TableCell>
                  <TableCell className="text-right">
                    {row.total_quantity ?? 0}
                  </TableCell>
                  <TableCell>
                    {row.expected_delivery_date
                      ? formatDate(row.expected_delivery_date)
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANTS[row.status]}>
                      {STATUS_LABELS[row.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Pencil className="h-4 w-4 text-gray-400" />
                  </TableCell>
                </TableRow>
              ))}
              {orders.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-sm text-gray-400 py-8 italic"
                  >
                    Няма заявки за този период.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <PurchaseOrderDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        orderId={editingId}
      />
    </div>
  );
}
