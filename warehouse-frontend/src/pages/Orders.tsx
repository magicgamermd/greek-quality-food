import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  forwardRef,
  useImperativeHandle,
  Component,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import AsyncSelect from "react-select/async";
import { useNavigate } from "react-router-dom";
import {
  Plus,
  FileText,
  CheckCircle,
  Trash2,
  AlertTriangle,
  Package,
  Eye,
  Clock,
  ExternalLink,
  Pencil,
  ChevronDown,
  RefreshCw,
  RotateCcw,
  ClipboardList,
  ScrollText,
  XCircle,
  Search,
  X as XIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import type { Order, OrderItem, Partner, PartnerOrderObject } from "@/types";
import { formatDate, formatCurrency, isoDateToday } from "@/lib/utils";
import { matchesSearch, matchesAnyField } from "@/lib/translit";
import { HighlightMatch } from "@/lib/highlight";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { SmartDateInput } from "@/components/ui/smart-date-input";
import { toast } from "@/lib/toast";
import { confirm } from "@/components/ConfirmDialog";
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

const statusLabels: Record<string, string> = {
  pending: "Чакаща",
  confirmed: "Потвърдена",
  processing: "В обработка",
  fulfilled: "Изпълнена",
  cancelled: "Анулирана",
  invoiced: "Фактурирана",
};
const statusVariants: Record<
  string,
  "warning" | "info" | "success" | "destructive" | "default"
> = {
  pending: "warning",
  confirmed: "info",
  processing: "info",
  fulfilled: "success",
  cancelled: "destructive",
  invoiced: "default",
};

function hasAnnulledInvoice(order: Pick<Order, "annulled_invoice_at">) {
  return Boolean(order.annulled_invoice_at);
}

interface BatchInfo {
  id: number;
  batch_number: string;
  expiry_date: string | null;
  stock: number;
}

interface OrderProduct {
  id: number;
  name_bg: string;
  name_en: string;
  sku: string;
  unit: string;
  brand: string | null;
  selling_price: number | null;
  group_price: number | null;
  /** Last known purchase price — used as a "not below cost" guard. */
  purchase_price: number | null;
  total_stock: number;
  partner_price: number | null;
  batches?: BatchInfo[];
}

interface OrderItemRow {
  row_key: string;
  product_id: string;
  product_name: string;
  quantity: string;
  unit_price: string;
  /** Per-line отстъпка % (0–100). String защото input type=number дава
   *  string; конвертираме при submit. Default "0". */
  discount_percent: string;
  unit: string;
  stock: number;
  /** Snapshot of the product's purchase_price at pick time — used to
   *  warn the cashier when the typed selling price dips below cost. */
  cost_price: number;
  selected_batch_id: string;
  batches: BatchInfo[];
  // Manual batch/expiry entry (used when no existing batch is picked from FEFO)
  manual_batch_number: string;
  manual_expiry_date: string;
}

let orderItemRowSeq = 0;

const makeOrderItemRow = (
  overrides: Partial<Omit<OrderItemRow, "row_key">> = {},
): OrderItemRow => ({
  row_key: `order-item-row-${Date.now()}-${orderItemRowSeq++}`,
  product_id: "",
  product_name: "",
  quantity: "",
  unit_price: "",
  discount_percent: "0",
  unit: "",
  stock: 0,
  cost_price: 0,
  selected_batch_id: "",
  batches: [],
  manual_batch_number: "",
  manual_expiry_date: "",
  ...overrides,
});

const emptyItem = (): OrderItemRow => makeOrderItemRow();
const AUTO_BATCH_VALUE = "__auto__";

function formatBatchExpiry(expiryDate: string | null | undefined) {
  if (!expiryDate) return "без срок";
  return new Date(expiryDate).toLocaleDateString("bg-BG", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function getSelectedBatch(item: OrderItemRow) {
  if (!item.selected_batch_id) return null;
  return (
    item.batches.find((batch) => String(batch.id) === item.selected_batch_id) ??
    null
  );
}

function getEffectiveStock(item: OrderItemRow) {
  const selectedBatch = getSelectedBatch(item);
  if (selectedBatch && selectedBatch.stock >= 0) {
    return selectedBatch.stock;
  }
  return item.stock;
}

function BatchSelectField({
  item,
  onChange,
  disabled,
}: {
  item: OrderItemRow;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  if (!item.product_id) {
    return <span className="text-xs text-gray-400">Избери продукт</span>;
  }

  return (
    <div className="space-y-1">
      <Select
        value={item.selected_batch_id || AUTO_BATCH_VALUE}
        onChange={(e) =>
          onChange(e.target.value === AUTO_BATCH_VALUE ? "" : e.target.value)
        }
        disabled={disabled}
      >
        <option value={AUTO_BATCH_VALUE}>Автоматично (FEFO)</option>
        {item.batches.map((batch) => (
          <option key={batch.id} value={batch.id}>
            {`${batch.batch_number}${batch.stock >= 0 ? ` · ${batch.stock} ${item.unit || "бр."}` : ""}`}
          </option>
        ))}
      </Select>
      {item.batches.length === 0 && (
        <div className="text-xs text-gray-400">
          Няма налични партиди за избор
        </div>
      )}
    </div>
  );
}

/** Get expiry date of the currently selected batch (or null if auto/FEFO). */
function getSelectedBatchExpiry(item: OrderItemRow): string | null {
  if (!item.selected_batch_id) return null;
  const batch = item.batches.find(
    (b) => String(b.id) === String(item.selected_batch_id),
  );
  return batch?.expiry_date || null;
}

async function openInvoicePdf(invoiceId: number) {
  try {
    // Append a timestamp so the browser never serves a stale cached
    // PDF after "Регенерирай" rewrites the file on disk.
    const res = await api.get(`/invoices/${invoiceId}/pdf?t=${Date.now()}`, {
      responseType: "blob",
    });

    const blob = new Blob([res.data], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);

    // Print the fetched PDF blob directly so the browser prints the full
    // multi-page invoice document, including both generated copies.
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.src = url;
    document.body.appendChild(iframe);

    iframe.onload = () => {
      try {
        iframe.contentWindow?.print();
      } catch {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    };

    setTimeout(() => {
      URL.revokeObjectURL(url);
      if (iframe.parentNode) document.body.removeChild(iframe);
    }, 60000);
  } catch (err: any) {
    console.error("Error opening invoice PDF:", err);
    let msg = "Грешка при отваряне на фактура";
    try {
      if (err?.response?.data instanceof Blob) {
        const text = await err.response.data.text();
        const json = JSON.parse(text);
        if (json.error) msg = json.error;
      } else if (err?.response?.data?.error) {
        msg = err.response.data.error;
      }
    } catch {}
    toast.error(msg);
  }
}

/* ------------------------------------------------------------------ */
/*  Error boundary for ProductSearch                                   */
/* ------------------------------------------------------------------ */
class ProductSearchBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };
  static getDerivedStateFromError(err: Error) {
    return { error: err.message || "Unexpected error" };
  }
  componentDidCatch(err: Error) {
    console.error("[ProductSearchBoundary]", err);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="text-xs text-red-500 py-1">
          Грешка в търсачката.{" "}
          <button
            type="button"
            className="underline text-blue-500"
            onClick={() => this.setState({ error: null })}
          >
            Опитай пак
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ------------------------------------------------------------------ */
/*  Product search using react-select (async, with portal)             */
/* ------------------------------------------------------------------ */
interface ProductOption {
  value: number;
  label: string;
  product: OrderProduct;
}

export interface ProductSearchHandle {
  focus: () => void;
}

const ProductSearch = forwardRef<
  ProductSearchHandle,
  {
    partnerId: string;
    onSelect: (p: OrderProduct) => void;
    disabled: boolean;
  }
>(function ProductSearch({ partnerId, onSelect, disabled }, ref) {
  const [loadError, setLoadError] = useState<string | null>(null);
  const selectRef = useRef<any>(null);
  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        try {
          selectRef.current?.focus?.();
        } catch {
          /* non-fatal: ref may not be ready right after add-row */
        }
      },
    }),
    [],
  );

  const loadOptions = useCallback(
    async (inputValue: string): Promise<ProductOption[]> => {
      try {
        setLoadError(null);
        const params = new URLSearchParams();
        if (partnerId) params.set("partner_id", partnerId);
        if (inputValue.trim()) params.set("search", inputValue.trim());
        params.set("in_stock_only", "true");
        const res = await api.get(`/orders/products-for-order?${params}`);
        const raw = res.data;
        const data = Array.isArray(raw)
          ? raw
          : Array.isArray(raw?.data)
            ? raw.data
            : [];
        return data
          .filter(
            (p: OrderProduct) =>
              p && typeof p === "object" && (p.name_bg || p.name_en),
          )
          .map((p: OrderProduct) => ({
            value: p.id,
            label: `${p.name_bg || p.name_en} — ${p.sku || ""}`,
            product: p,
          }));
      } catch (err: any) {
        const msg =
          err?.response?.data?.error ||
          err?.response?.data?.message ||
          err?.message ||
          "Грешка при зареждане";
        console.error("[ProductSearch] loadOptions error:", msg, err);
        setLoadError(msg);
        return [];
      }
    },
    [partnerId],
  );

  if (loadError) {
    return (
      <div className="text-xs text-red-500 py-1">
        Грешка: {loadError}{" "}
        <button
          type="button"
          className="underline text-blue-500"
          onClick={() => setLoadError(null)}
        >
          Опитай пак
        </button>
      </div>
    );
  }

  return (
    // key={partnerId} forces a full remount when the partner changes —
    // without this, `defaultOptions` (which fires once at mount with
    // whatever `partnerId` is in scope at that instant) would keep
    // showing catalog `selling_price` when the row rendered BEFORE the
    // user picked the partner. With the remount the dropdown refetches
    // defaults against the correct partner, honouring their price tier.
    <AsyncSelect<ProductOption, false>
      ref={selectRef}
      key={`product-search-${partnerId || "none"}`}
      loadOptions={loadOptions}
      defaultOptions
      cacheOptions={false}
      onChange={(option) => option && onSelect(option.product)}
      value={null}
      isDisabled={disabled}
      placeholder={disabled ? "Избери партньор..." : "Търси продукт..."}
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
      formatOptionLabel={(option) => {
        if (!option?.product) {
          return <span className="text-sm">{option?.label ?? "—"}</span>;
        }
        const p = option.product;
        const rawPrice = p.partner_price ?? p.group_price ?? p.selling_price;
        const price = rawPrice != null ? parseFloat(String(rawPrice)) : 0;
        const stock = parseFloat(String(p.total_stock || 0));
        const batches = p.batches || [];
        return (
          <div>
            <div className="flex justify-between items-center">
              <div>
                <div className="font-medium text-sm">
                  {p.name_bg || p.name_en || "Без име"}
                </div>
                <div className="text-xs text-gray-400">
                  {p.sku || ""}
                  {p.brand ? ` · ${p.brand}` : ""}
                </div>
              </div>
              <div className="text-right ml-4 shrink-0">
                <div
                  className={`text-sm font-medium ${price > 0 ? "text-emerald-600" : "text-orange-500"}`}
                >
                  {price > 0 ? formatCurrency(price) : "без цена"}
                </div>
                <div
                  className={`text-xs ${stock > 0 ? "text-gray-400" : "text-red-500"}`}
                >
                  {stock > 0 ? `${stock} ${p.unit || "бр."}` : "няма"}
                </div>
              </div>
            </div>
            {batches.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {batches.slice(0, 3).map((b, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 text-[10px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded"
                  >
                    <span className="font-mono">{b.batch_number}</span>
                    {b.expiry_date && (
                      <span className="text-blue-400">
                        до{" "}
                        {new Date(b.expiry_date).toLocaleDateString("bg-BG", {
                          day: "2-digit",
                          month: "2-digit",
                          year: "numeric",
                        })}
                      </span>
                    )}
                    <span className="text-blue-500 font-medium">
                      ({b.stock} {p.unit || "бр."})
                    </span>
                  </span>
                ))}
                {batches.length > 3 && (
                  <span className="text-[10px] text-gray-400">
                    +{batches.length - 3} още
                  </span>
                )}
              </div>
            )}
          </div>
        );
      }}
    />
  );
});

/* ------------------------------------------------------------------ */
/*  ISSUE 5: Order detail modal                                        */
/* ------------------------------------------------------------------ */
function OrderDetailModal({
  order,
  onClose,
}: {
  order: Order | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();

  // Fetch full order with items
  const { data: fullOrder, isLoading: detailLoading } = useQuery<Order>({
    queryKey: ["order-detail", order?.id],
    queryFn: () =>
      api.get(`/orders/${order!.id}`).then((r) => r.data?.data ?? r.data),
    enabled: !!order,
  });

  const detail = fullOrder ?? order;
  const items: OrderItem[] = detail?.items ?? [];

  // VAT toggle for invoice/documents
  const [includeVat, setIncludeVat] = useState(true);
  const [generatedInvoiceId, setGeneratedInvoiceId] = useState<number | null>(
    null,
  );
  const [editOpen, setEditOpen] = useState(false);
  const [cancelInvoiceOpen, setCancelInvoiceOpen] = useState(false);
  const [cancelInvoiceReason, setCancelInvoiceReason] = useState("");
  // Credit note (сторниране) state
  const [creditNoteOpen, setCreditNoteOpen] = useState(false);
  const [creditNoteReason, setCreditNoteReason] = useState("");
  const [creditNoteRestoreStock, setCreditNoteRestoreStock] = useState(true);
  const [issuedCreditNoteId, setIssuedCreditNoteId] = useState<number | null>(
    null,
  );
  // Per-row batch/expiry edit state (pending orders only)
  const [batchEdits, setBatchEdits] = useState<
    Record<
      number,
      { batch_number: string; expiry_date: string; dirty: boolean }
    >
  >({});
  const [savingBatchItemId, setSavingBatchItemId] = useState<number | null>(
    null,
  );

  useEffect(() => {
    setGeneratedInvoiceId(null);
    setEditOpen(false);
    setCancelInvoiceOpen(false);
    setCancelInvoiceReason("");
    setCreditNoteOpen(false);
    setCreditNoteReason("");
    setCreditNoteRestoreStock(true);
    setIssuedCreditNoteId(null);
    setBatchEdits({});
    setSavingBatchItemId(null);
  }, [order?.id]);

  // Seed batch edits when items arrive
  useEffect(() => {
    const seed: typeof batchEdits = {};
    for (const it of (fullOrder?.items ?? []) as any[]) {
      if (!(it.id in batchEdits)) {
        seed[it.id] = {
          batch_number: it.batch_number ?? "",
          expiry_date: it.expiry_date
            ? String(it.expiry_date).split("T")[0]
            : "",
          dirty: false,
        };
      }
    }
    if (Object.keys(seed).length > 0) {
      setBatchEdits((prev) => ({ ...seed, ...prev }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullOrder?.items]);

  const saveItemBatch = async (itemId: number) => {
    if (!detail) return;
    const edit = batchEdits[itemId];
    if (!edit) return;
    setSavingBatchItemId(itemId);
    try {
      await api.patch(`/orders/${detail.id}/items/${itemId}`, {
        batch_number: edit.batch_number.trim() || null,
        expiry_date: edit.expiry_date || null,
      });
      setBatchEdits((prev) => ({
        ...prev,
        [itemId]: { ...edit, dirty: false },
      }));
      qc.invalidateQueries({ queryKey: ["order-detail", detail.id] });
      qc.invalidateQueries({ queryKey: ["orders"] });
    } catch (err: any) {
      toast.error(
        err?.response?.data?.error ||
          err?.response?.data?.message ||
          "Неуспешно записване на партида/срок.",
      );
    } finally {
      setSavingBatchItemId(null);
    }
  };

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api.put(`/orders/${id}/status`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["order-detail"] });
    },
  });

  // Invalidate all queries that depend on orders/invoices/stock state.
  // Any mutation that touches stock, invoices, or order status must call this
  // so every page reflects the new data (not stale cached).
  const invalidateAllOrderRelated = () => {
    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["order-detail"] });
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: ["unpaid-invoices"] });
    qc.invalidateQueries({ queryKey: ["inventory"] });
    qc.invalidateQueries({ queryKey: ["products"] });
  };

  const fulfillMutation = useMutation({
    mutationFn: (id: number) => api.post(`/orders/${id}/fulfill`),
    onSuccess: () => {
      invalidateAllOrderRelated();
    },
  });

  const fiscalReceiptMutation = useMutation({
    mutationFn: (id: number) => api.post("/fiscal/receipt", { order_id: id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["order-detail"] });
    },
  });

  const invoiceMutation = useMutation({
    mutationFn: (id: number) =>
      api.post("/invoices", { order_id: id, include_vat: includeVat }),
    onSuccess: (res) => {
      const newInvoiceId = res.data?.id ?? null;
      setGeneratedInvoiceId(newInvoiceId);
      invalidateAllOrderRelated();
      // Auto-open PDF for printing immediately after generation
      if (newInvoiceId) {
        setTimeout(() => void openInvoicePdf(newInvoiceId), 300);
      }
    },
  });

  const sendInvoiceEmailMutation = useMutation({
    mutationFn: (invoiceId: number) =>
      api.post(`/invoices/${invoiceId}/send-email`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["order-detail"] });
    },
  });

  // Combined confirm + fulfill — one click goes from pending → fulfilled
  const confirmAndFulfillMutation = useMutation({
    mutationFn: async (id: number) => {
      await api.put(`/orders/${id}/status`, { status: "confirmed" });
      await api.post(`/orders/${id}/fulfill`);
    },
    onSuccess: () => {
      invalidateAllOrderRelated();
    },
  });

  const regenerateInvoiceMutation = useMutation({
    mutationFn: (invoiceId: number) =>
      api.put(`/invoices/${invoiceId}/regenerate`),
    onSuccess: () => {
      invalidateAllOrderRelated();
    },
  });

  // Credit note (сторниране — Кредитно известие)
  const creditNoteMutation = useMutation({
    mutationFn: (data: {
      related_invoice_id: number;
      reason: string;
      include_vat?: boolean;
      restore_stock?: boolean;
    }) => api.post("/invoices/credit-note", data),
    onSuccess: (res) => {
      const cnId = res.data?.id ?? null;
      setIssuedCreditNoteId(cnId);
      invalidateAllOrderRelated();
      setCreditNoteOpen(false);
      // Auto-open the credit note PDF for printing
      if (cnId) {
        setTimeout(() => void openInvoicePdf(cnId), 300);
      }
    },
  });

  const cancelInvoiceMutation = useMutation({
    mutationFn: (data: { id: number; reason: string }) =>
      api.post(`/invoices/${data.id}/cancel`, { reason: data.reason }),
    onSuccess: () => {
      invalidateAllOrderRelated();
      setCancelInvoiceOpen(false);
      setCancelInvoiceReason("");
    },
  });

  // Document PDF download + print
  const handleDocDownload = async (
    orderId: number,
    docType: "stock-dispatch" | "commercial-doc",
  ) => {
    try {
      // For invoiced orders, backend reads VAT from invoice; for fulfilled, use toggle
      const vatParam =
        (detail?.invoice_id ?? generatedInvoiceId)
          ? ""
          : includeVat
            ? ""
            : "?include_vat=false";
      const res = await api.get(
        `/orders/${orderId}/${docType}-pdf${vatParam}`,
        { responseType: "blob" },
      );
      const blob = new Blob([res.data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);

      // Print the generated PDF blob itself so the browser uses the full
      // multi-page document rather than a tab-preview snapshot.
      const iframe = document.createElement("iframe");
      iframe.style.display = "none";
      iframe.src = url;
      document.body.appendChild(iframe);

      iframe.onload = () => {
        try {
          iframe.contentWindow?.print();
        } catch {
          const link = document.createElement("a");
          link.href = url;
          link.target = "_blank";
          link.rel = "noopener";
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        }
      };

      setTimeout(() => {
        URL.revokeObjectURL(url);
        if (iframe.parentNode) document.body.removeChild(iframe);
      }, 60000);
    } catch {
      toast.error("Грешка при генериране на документ");
    }
  };

  if (!detail) return null;

  const effectiveInvoiceId = detail.invoice_id ?? generatedInvoiceId;
  const hasInvoice = Boolean(effectiveInvoiceId);
  const invoiceIncludesVat =
    detail.invoice_include_vat ??
    invoiceMutation.data?.data?.include_vat ??
    includeVat;

  const orderTotal = items.reduce(
    (sum, i) => sum + (i.total_price ?? i.quantity * i.unit_price),
    0,
  );
  const objectLabel = detail.object_name
    ? detail.object_code
      ? `${detail.object_code} · ${detail.object_name}`
      : detail.object_name
    : detail.object_code || "—";
  const invoiceLabel = detail.invoice_number
    ? detail.invoice_number
    : detail.invoice_id
      ? `#${detail.invoice_id}`
      : "—";

  return (
    <Dialog open={!!order} onOpenChange={onClose} modal={false}>
      <DialogContent className="sm:max-w-[98vw] lg:max-w-[1680px] max-h-[92vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-3 flex-wrap">
            <span>Поръчка #{detail.order_number ?? detail.id}</span>
            <Badge variant={statusVariants[detail.status] ?? "secondary"}>
              {statusLabels[detail.status] ?? detail.status}
            </Badge>
            {hasAnnulledInvoice(detail) && (
              <Badge variant="destructive">Анулирана фактура</Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0 space-y-4 py-2 pr-1">
          {/* Header info */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 bg-gray-50 rounded-lg p-4">
            <div>
              <div className="text-xs text-gray-500 mb-1">Партньор</div>
              <div className="font-medium text-sm">
                {detail.partner?.name ??
                  detail.partner_name ??
                  `#${detail.partner_id}`}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">Дата на поръчка</div>
              <div className="text-sm">{formatDate(detail.order_date)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">Дата на доставка</div>
              <div className="text-sm">
                {detail.delivery_date ? formatDate(detail.delivery_date) : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">Източник</div>
              <Badge variant="secondary">{detail.source}</Badge>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">Номер на заявка</div>
              <div className="text-sm">{detail.request_number || "—"}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">Обект / магазин</div>
              <div className="text-sm">{objectLabel}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">Фактура</div>
              <div className="text-sm">{invoiceLabel}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">Дата на фактура</div>
              <div className="text-sm">
                {detail.invoice_date ? formatDate(detail.invoice_date) : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">Стокова №</div>
              <div className="text-sm">
                {detail.stock_dispatch_number || "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">Търговски №</div>
              <div className="text-sm">
                {detail.commercial_document_number || "—"}
              </div>
            </div>
          </div>

          {hasAnnulledInvoice(detail) && (
            <div className="bg-red-50 border border-red-100 rounded-lg p-3 text-sm text-red-800 space-y-1">
              <div>
                <span className="font-medium">Анулирана фактура:</span>{" "}
                <span className="font-mono">
                  {detail.annulled_invoice_number ||
                    (detail.annulled_invoice_id
                      ? `#${detail.annulled_invoice_id}`
                      : "—")}
                </span>
                {detail.annulled_invoice_at && (
                  <span> · {formatDate(detail.annulled_invoice_at)}</span>
                )}
              </div>
              {detail.annulled_invoice_reason && (
                <div>Причина: {detail.annulled_invoice_reason}</div>
              )}
            </div>
          )}

          {detail.notes && (
            <div className="bg-yellow-50 border border-yellow-100 rounded-lg p-3 text-sm text-yellow-800">
              <span className="font-medium">Бележки:</span> {detail.notes}
            </div>
          )}

          {/* Items table */}
          {detailLoading && (
            <div className="flex items-center justify-center py-8">
              <Spinner size="sm" />
              <span className="ml-2 text-sm text-gray-500">
                Зареждане на артикули...
              </span>
            </div>
          )}
          <div className="border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Продукт</TableHead>
                  <TableHead className="w-40">Партида</TableHead>
                  <TableHead className="w-36">Годност</TableHead>
                  <TableHead className="w-20 text-right">К-во</TableHead>
                  <TableHead className="w-24 text-right">Ед. цена</TableHead>
                  <TableHead className="w-24 text-right">Сума</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="text-center text-gray-400 py-6"
                    >
                      Няма артикули
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((item: any) => {
                    const lineTotal =
                      item.total_price ?? item.quantity * item.unit_price;
                    const prodName =
                      item.product?.name_bg ||
                      item.product?.name_en ||
                      item.name_bg ||
                      item.name_en ||
                      item.product?.sku ||
                      item.sku ||
                      `Продукт #${item.product_id}`;
                    const batchNum =
                      item.batch_number || item.product?.batch_number;
                    const expiryDate =
                      item.expiry_date || item.product?.expiry_date;
                    // Allow batch/expiry edits until invoice is generated —
                    // covers forgotten data during pending/confirmed/processing/fulfilled
                    const canEditBatch =
                      detail.status !== "cancelled" &&
                      detail.status !== "invoiced" &&
                      !hasInvoice;
                    const isPending = canEditBatch;
                    const edit = batchEdits[item.id];
                    return (
                      <TableRow key={item.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Package className="h-4 w-4 text-gray-400 shrink-0" />
                            <div className="min-w-0">
                              <div className="text-sm font-medium truncate">
                                {prodName}
                              </div>
                              {(item.product?.sku || item.sku) && (
                                <div className="text-xs text-gray-400">
                                  {item.product?.sku || item.sku}
                                </div>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          {isPending && edit ? (
                            <Input
                              value={edit.batch_number}
                              onChange={(e) =>
                                setBatchEdits((prev) => ({
                                  ...prev,
                                  [item.id]: {
                                    ...edit,
                                    batch_number: e.target.value,
                                    dirty: true,
                                  },
                                }))
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  // Focus the date input in the next TableCell
                                  const next = (
                                    e.currentTarget.parentElement
                                      ?.nextElementSibling as HTMLElement | null
                                  )?.querySelector<HTMLInputElement>("input");
                                  next?.focus();
                                  next?.select();
                                }
                              }}
                              placeholder="партида"
                              className="h-9 text-sm font-mono w-full"
                            />
                          ) : batchNum ? (
                            <span className="text-sm font-mono bg-blue-50 text-blue-700 px-2 py-0.5 rounded">
                              {batchNum}
                            </span>
                          ) : (
                            <span className="text-xs text-gray-300">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {isPending && edit ? (
                            <div className="flex items-center gap-1">
                              <SmartDateInput
                                value={edit.expiry_date}
                                onChange={(iso) =>
                                  setBatchEdits((prev) => ({
                                    ...prev,
                                    [item.id]: {
                                      ...edit,
                                      expiry_date: iso,
                                      dirty: true,
                                    },
                                  }))
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    if (edit.dirty) saveItemBatch(item.id);
                                  }
                                }}
                                className="h-9 text-sm flex-1"
                                placeholder="ДД.ММ.ГГ"
                              />
                              {edit.dirty && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="h-9 px-2 shrink-0"
                                  disabled={savingBatchItemId === item.id}
                                  onClick={() => saveItemBatch(item.id)}
                                  title="Запази партида/срок"
                                >
                                  {savingBatchItemId === item.id ? (
                                    <Spinner size="sm" />
                                  ) : (
                                    "✓"
                                  )}
                                </Button>
                              )}
                            </div>
                          ) : expiryDate ? (
                            <span className="text-sm text-gray-700">
                              {formatDate(expiryDate)}
                            </span>
                          ) : (
                            <span className="text-xs text-gray-300">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {item.quantity}
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {formatCurrency(item.unit_price)}
                        </TableCell>
                        <TableCell className="text-right text-sm font-medium">
                          {formatCurrency(lineTotal)}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          {/* Total */}
          <div className="flex justify-end">
            <div className="bg-gray-50 rounded-lg px-6 py-3 text-right">
              <div className="text-xs text-gray-500 mb-1">
                {items.length} артикул{items.length !== 1 ? "а" : ""}
              </div>
              <div className="text-lg font-bold">
                {formatCurrency(detail.total_amount || orderTotal)}
              </div>
            </div>
          </div>
        </div>

        {/* ── Workflow step indicator ── */}
        {detail.status !== "cancelled" && (
          <div className="shrink-0 border-t pt-3">
            <div className="flex items-center justify-between gap-1 mb-3 px-1">
              {[
                { key: "pending", label: "Чакаща" },
                { key: "confirmed", label: "Потвърдена" },
                { key: "processing", label: "В обработка" },
                { key: "fulfilled", label: "Изпълнена" },
                { key: "invoiced", label: "Фактурирана" },
              ].map((step, idx, arr) => {
                const statusOrder = [
                  "pending",
                  "confirmed",
                  "processing",
                  "fulfilled",
                  "invoiced",
                ];
                const currentIdx = statusOrder.indexOf(detail.status);
                const stepIdx = statusOrder.indexOf(step.key);
                const isDone = stepIdx < currentIdx;
                const isCurrent = stepIdx === currentIdx;
                return (
                  <div key={step.key} className="flex items-center flex-1">
                    <div className="flex flex-col items-center flex-1">
                      <div
                        className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                          isDone
                            ? "bg-green-500 text-white"
                            : isCurrent
                              ? "bg-[#6c3dff] text-white ring-2 ring-[#6c3dff]/30"
                              : "bg-gray-200 text-gray-400"
                        }`}
                      >
                        {isDone ? "✓" : idx + 1}
                      </div>
                      <div
                        className={`text-[10px] mt-0.5 ${isCurrent ? "font-bold text-[#6c3dff]" : isDone ? "text-green-600" : "text-gray-400"}`}
                      >
                        {step.label}
                      </div>
                    </div>
                    {idx < arr.length - 1 && (
                      <div
                        className={`h-0.5 flex-1 -mt-3 ${stepIdx < currentIdx ? "bg-green-400" : "bg-gray-200"}`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Actions — grouped by purpose ── */}
        <DialogFooter className="shrink-0 flex-col items-stretch gap-2 sm:flex-col">
          {/* Error banners — full width on top */}
          {invoiceMutation.isError && (
            <div className="text-xs text-red-600">
              {(invoiceMutation.error as any)?.response?.data?.error ||
                "Грешка при генериране на фактура"}
            </div>
          )}
          {(statusMutation.isError || fulfillMutation.isError) && (
            <div className="text-xs text-red-600">
              {(statusMutation.error as any)?.response?.data?.error ||
                (fulfillMutation.error as any)?.response?.data?.error ||
                "Грешка при смяна на статус"}
            </div>
          )}

          {/* Row 1 — navigation + primary workflow action */}
          <div className="flex flex-wrap gap-2 items-center">
            <Button variant="outline" onClick={onClose}>
              Затвори
            </Button>
            {detail.status !== "cancelled" && (
              <Button variant="outline" onClick={() => setEditOpen(true)}>
                <Pencil className="h-4 w-4" />
                Редактирай артикули
              </Button>
            )}

            <div className="flex-1" />

            {detail.status === "pending" && (
              <Button
                onClick={() => confirmAndFulfillMutation.mutate(detail.id)}
                disabled={confirmAndFulfillMutation.isPending}
                className="bg-green-600 hover:bg-green-700"
              >
                {confirmAndFulfillMutation.isPending ? (
                  <Spinner size="sm" />
                ) : (
                  <CheckCircle className="h-4 w-4" />
                )}
                Потвърди поръчка
              </Button>
            )}
            {(detail.status === "confirmed" ||
              detail.status === "processing") && (
              <Button
                onClick={() => fulfillMutation.mutate(detail.id)}
                disabled={fulfillMutation.isPending}
                className="bg-green-600 hover:bg-green-700"
              >
                {fulfillMutation.isPending ? (
                  <Spinner size="sm" />
                ) : (
                  <CheckCircle className="h-4 w-4" />
                )}
                Изпълни поръчка
              </Button>
            )}
          </div>

          {/* Row 2 — Invoice group (only after fulfilled) */}
          {(detail.status === "fulfilled" || detail.status === "invoiced") && (
            <div className="flex flex-wrap gap-2 items-center border-t pt-2">
              <span className="text-xs text-gray-500 uppercase tracking-wide shrink-0">
                Фактура:
              </span>

              {/* VAT toggle / indicator */}
              {!hasInvoice ? (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-lg border">
                  <span className="text-xs text-gray-500">ДДС:</span>
                  <button
                    type="button"
                    onClick={() => setIncludeVat(true)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition ${
                      includeVat
                        ? "bg-[#6c3dff] text-white"
                        : "bg-white text-gray-600 border hover:bg-gray-100"
                    }`}
                  >
                    С ДДС
                  </button>
                  <button
                    type="button"
                    onClick={() => setIncludeVat(false)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition ${
                      !includeVat
                        ? "bg-orange-500 text-white"
                        : "bg-white text-gray-600 border hover:bg-gray-100"
                    }`}
                  >
                    Без ДДС
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-lg border">
                  <span className="text-xs text-gray-500">ДДС:</span>
                  <span
                    className={`px-2.5 py-1 text-xs font-medium rounded-md ${
                      invoiceIncludesVat !== false
                        ? "bg-[#6c3dff]/10 text-[#6c3dff] border border-[#6c3dff]/20"
                        : "bg-orange-50 text-orange-600 border border-orange-200"
                    }`}
                  >
                    {invoiceIncludesVat !== false ? "С ДДС" : "Без ДДС"}
                  </span>
                </div>
              )}

              {!hasInvoice ? (
                <Button
                  onClick={() => invoiceMutation.mutate(detail.id)}
                  disabled={invoiceMutation.isPending}
                  className="bg-[#6c3dff] hover:bg-[#5a2de6]"
                >
                  {invoiceMutation.isPending ? (
                    <Spinner size="sm" />
                  ) : (
                    <FileText className="h-4 w-4" />
                  )}
                  Генерирай фактура {!includeVat && "(без ДДС)"}
                </Button>
              ) : (
                <>
                  <Button
                    variant="outline"
                    onClick={() => void openInvoicePdf(effectiveInvoiceId!)}
                    className="border-[#6c3dff]/40 text-[#6c3dff] hover:bg-[#6c3dff]/5"
                  >
                    <FileText className="h-4 w-4" />
                    Отвори
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      regenerateInvoiceMutation.mutate(effectiveInvoiceId!)
                    }
                    disabled={regenerateInvoiceMutation.isPending}
                    className="text-orange-600 border-orange-300 hover:bg-orange-50"
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${regenerateInvoiceMutation.isPending ? "animate-spin" : ""}`}
                    />
                    Регенерирай
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      effectiveInvoiceId &&
                      sendInvoiceEmailMutation.mutate(effectiveInvoiceId)
                    }
                    disabled={sendInvoiceEmailMutation.isPending}
                    title="Изпрати фактурата по имейл на партньора"
                  >
                    {sendInvoiceEmailMutation.isPending ? (
                      <Spinner size="sm" />
                    ) : (
                      <span className="text-base leading-none mr-1">
                        &#x2709;
                      </span>
                    )}
                    Имейл
                  </Button>
                  {detail.credit_note_id ? (
                    <Button
                      variant="outline"
                      onClick={() =>
                        void openInvoicePdf(detail.credit_note_id!)
                      }
                      className="text-amber-700 border-amber-300 bg-amber-50"
                      title="Отвори издаденото Кредитно известие"
                    >
                      <RefreshCw className="h-4 w-4" />
                      Сторнирана (
                      <span className="font-mono">
                        {detail.credit_note_number ??
                          `КИ-${detail.credit_note_id}`}
                      </span>
                      )
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setCreditNoteOpen(true);
                        setCreditNoteReason("");
                        setCreditNoteRestoreStock(true);
                      }}
                      className="text-amber-700 border-amber-300 hover:bg-amber-50"
                      title="Издай Кредитно известие (пълно сторниране на фактурата)"
                    >
                      <RefreshCw className="h-4 w-4" />
                      Сторнирай
                    </Button>
                  )}
                  {!detail.credit_note_id &&
                    detail.invoice_status !== "cancelled" && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setCancelInvoiceOpen(true);
                          setCancelInvoiceReason("");
                        }}
                        className="text-red-600 border-red-300 hover:bg-red-50"
                        title="Анулирай фактурата (само ако не е ползвана от получателя)"
                      >
                        <XCircle className="h-4 w-4" />
                        Анулирай
                      </Button>
                    )}
                  {detail.invoice_status === "cancelled" && (
                    <span className="text-xs text-red-600 flex items-center gap-1">
                      <XCircle className="h-3 w-3" />
                      Фактурата е анулирана
                    </span>
                  )}
                </>
              )}

              {sendInvoiceEmailMutation.isSuccess && (
                <span className="text-xs text-green-600 flex items-center gap-1">
                  &#x2713; Имейлът е изпратен
                </span>
              )}
              {sendInvoiceEmailMutation.isError && (
                <span className="text-xs text-red-600">
                  {(sendInvoiceEmailMutation.error as any)?.response?.data
                    ?.error || "Грешка при изпращане"}
                </span>
              )}
              {creditNoteMutation.isError && (
                <span className="text-xs text-red-600">
                  {(creditNoteMutation.error as any)?.response?.data?.error ||
                    "Грешка при издаване на Кредитно известие"}
                </span>
              )}
              {issuedCreditNoteId && (
                <span className="text-xs text-amber-700 flex items-center gap-1">
                  &#x2713; Издадено е Кредитно известие
                  <button
                    type="button"
                    onClick={() => void openInvoicePdf(issuedCreditNoteId)}
                    className="underline hover:text-amber-900"
                  >
                    отвори
                  </button>
                </span>
              )}
            </div>
          )}

          {/* Row 3 — Document downloads */}
          {(detail.status === "fulfilled" || detail.status === "invoiced") && (
            <div className="flex flex-wrap gap-2 items-center border-t pt-2">
              <span className="text-xs text-gray-500 uppercase tracking-wide shrink-0">
                Документи:
              </span>
              <Button
                variant="outline"
                onClick={() => handleDocDownload(detail.id, "stock-dispatch")}
                className="text-emerald-600 border-emerald-300 hover:bg-emerald-50"
              >
                <ClipboardList className="h-4 w-4" />
                Стокова разписка
              </Button>
              <Button
                variant="outline"
                onClick={() => handleDocDownload(detail.id, "commercial-doc")}
                className="text-blue-600 border-blue-300 hover:bg-blue-50"
              >
                <ScrollText className="h-4 w-4" />
                Търговски документ
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>

      {detail && (
        <EditOrderItemsModal
          open={editOpen}
          order={detail}
          onClose={() => setEditOpen(false)}
        />
      )}

      <Dialog
        open={cancelInvoiceOpen}
        onOpenChange={(open) => {
          setCancelInvoiceOpen(open);
          if (!open) setCancelInvoiceReason("");
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Анулирай фактура</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              Фактура:{" "}
              <span className="font-mono font-bold">{invoiceLabel}</span>
            </p>
            <div className="space-y-1.5">
              <Label>Причина за анулиране</Label>
              <Textarea
                value={cancelInvoiceReason}
                onChange={(e) => setCancelInvoiceReason(e.target.value)}
                placeholder="напр. Грешно фактурирана поръчка"
                rows={4}
              />
            </div>
            {cancelInvoiceMutation.isError && (
              <ErrorMessage
                message={
                  (cancelInvoiceMutation.error as any)?.response?.data?.error ||
                  "Грешка при анулиране на фактура"
                }
              />
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCancelInvoiceOpen(false);
                setCancelInvoiceReason("");
              }}
            >
              Отказ
            </Button>
            <Button
              onClick={() =>
                effectiveInvoiceId &&
                cancelInvoiceMutation.mutate({
                  id: effectiveInvoiceId,
                  reason: cancelInvoiceReason.trim(),
                })
              }
              disabled={cancelInvoiceMutation.isPending}
              className="bg-red-600 hover:bg-red-700"
            >
              {cancelInvoiceMutation.isPending ? <Spinner size="sm" /> : null}
              Потвърди анулиране
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Credit Note (сторниране) dialog */}
      <Dialog
        open={creditNoteOpen}
        onOpenChange={(open) => {
          setCreditNoteOpen(open);
          if (!open) setCreditNoteReason("");
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Сторнирай фактура (Кредитно известие)</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              Към фактура:{" "}
              <span className="font-mono font-bold">{invoiceLabel}</span>
            </p>
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
              Ще бъде издадено <strong>Кредитно известие</strong> с отрицателни
              суми, равни на оригиналната фактура. Документът ще се отвори за
              печат автоматично.
            </div>
            <div className="space-y-1.5">
              <Label>Основание за издаване *</Label>
              <Textarea
                value={creditNoteReason}
                onChange={(e) => setCreditNoteReason(e.target.value)}
                placeholder="напр. Върната стока от клиента / Грешно количество"
                rows={3}
              />
            </div>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={creditNoteRestoreStock}
                onChange={(e) => setCreditNoteRestoreStock(e.target.checked)}
                className="mt-1"
              />
              <span>
                <span className="font-medium">Върни стоката в склада</span>
                <span className="block text-xs text-gray-500">
                  Маркирай, ако стоката физически е върната. За отстъпка или
                  корекция на цена — остави непровено.
                </span>
              </span>
            </label>
            {creditNoteMutation.isError && (
              <ErrorMessage
                message={
                  (creditNoteMutation.error as any)?.response?.data?.error ||
                  "Грешка при издаване на Кредитно известие"
                }
              />
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreditNoteOpen(false);
                setCreditNoteReason("");
              }}
            >
              Отказ
            </Button>
            <Button
              onClick={() =>
                effectiveInvoiceId &&
                creditNoteMutation.mutate({
                  related_invoice_id: effectiveInvoiceId,
                  reason: creditNoteReason.trim() || "Сторниране по искане",
                  restore_stock: creditNoteRestoreStock,
                })
              }
              disabled={creditNoteMutation.isPending}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {creditNoteMutation.isPending ? <Spinner size="sm" /> : null}
              Издай Кредитно известие
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/*  Edit Order Items Modal                                             */
/* ------------------------------------------------------------------ */
function EditOrderItemsModal({
  open,
  onClose,
  order,
}: {
  open: boolean;
  onClose: () => void;
  order: Order;
}) {
  const qc = useQueryClient();
  const [deliveryDate, setDeliveryDate] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<OrderItemRow[]>([emptyItem()]);
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  useEffect(() => {
    if (!open) return;

    setDeliveryDate(order.delivery_date?.split("T")[0] || "");
    setNotes(order.notes || "");

    const mappedItems =
      order.items?.map((item) =>
        makeOrderItemRow({
          product_id: String(item.product_id),
          product_name:
            item.product?.name_bg ||
            item.product?.name_en ||
            item.name_bg ||
            item.name_en ||
            item.sku ||
            `Продукт #${item.product_id}`,
          quantity: String(item.quantity),
          unit_price: String(item.unit_price),
          discount_percent: String((item as any).discount_percent ?? "0"),
          unit: item.product?.unit || (item as any).unit || "бр.",
          stock: -1, // unknown until product is re-selected from search
          selected_batch_id: item.batch_id ? String(item.batch_id) : "",
          batches:
            item.batch_id && (item as any).batch_number
              ? [
                  {
                    id: item.batch_id,
                    batch_number: (item as any).batch_number,
                    expiry_date: (item as any).expiry_date || null,
                    stock: -1,
                  },
                ]
              : [],
        }),
      ) || [];

    setItems(mappedItems.length > 0 ? mappedItems : [emptyItem()]);
    setErrorMsg("");
    setSuccessMsg("");
  }, [open, order]);

  const handleProductSelect = useCallback(
    (idx: number, product: OrderProduct) => {
      const rawPrice =
        product.partner_price ?? product.group_price ?? product.selling_price;
      const price = rawPrice != null ? parseFloat(String(rawPrice)) : null;
      const stock = parseFloat(String(product.total_stock || 0));
      setItems((prev) =>
        prev.map((item, i) =>
          i === idx
            ? (() => {
                const batches = product.batches || [];
                const selectedBatchId =
                  item.selected_batch_id &&
                  batches.some(
                    (batch) => String(batch.id) === item.selected_batch_id,
                  )
                    ? item.selected_batch_id
                    : "";

                return {
                  ...item,
                  product_id: String(product.id),
                  product_name: product.name_bg || product.name_en || "Без име",
                  quantity: item.quantity || "1",
                  unit_price:
                    item.unit_price || (price != null ? String(price) : ""),
                  unit: product.unit || "бр.",
                  stock,
                  batches,
                  selected_batch_id: selectedBatchId,
                };
              })()
            : item,
        ),
      );
    },
    [],
  );

  const setItem = (idx: number, field: keyof OrderItemRow, value: string) => {
    setItems((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, [field]: value } : item)),
    );
  };

  const clearProduct = (idx: number) => {
    setItems((prev) => prev.map((item, i) => (i === idx ? emptyItem() : item)));
  };

  const addItem = () => setItems((prev) => [...prev, emptyItem()]);
  const removeItem = (idx: number) => {
    setItems((prev) =>
      prev.length === 1 ? [emptyItem()] : prev.filter((_, i) => i !== idx),
    );
  };

  const validItems = items.filter(
    (i) => i.product_id && Number(i.quantity) > 0 && Number(i.unit_price) >= 0,
  );
  const hasStockIssues = validItems.some(
    (i) =>
      getEffectiveStock(i) >= 0 && Number(i.quantity) > getEffectiveStock(i),
  );

  const mutation = useMutation({
    mutationFn: () =>
      api.put(`/orders/${order.id}`, {
        delivery_date: deliveryDate || undefined,
        notes: notes || undefined,
        items: validItems.map((i) => ({
          product_id: Number(i.product_id),
          quantity: Number(i.quantity),
          unit_price: Number(i.unit_price),
          discount_percent: Number(i.discount_percent) || 0,
          batch_id: i.selected_batch_id
            ? Number(i.selected_batch_id)
            : undefined,
          // When no existing batch is picked, pass manual values for the
          // server to find-or-create the batch.
          batch_number:
            !i.selected_batch_id && i.manual_batch_number.trim()
              ? i.manual_batch_number.trim()
              : undefined,
          expiry_date:
            !i.selected_batch_id && i.manual_expiry_date.trim()
              ? i.manual_expiry_date.trim()
              : undefined,
        })),
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["order-detail", order.id] });
      qc.invalidateQueries({ queryKey: ["order-detail"] });

      const payload = res.data?.data ?? res.data;
      if (payload?.regenerated_invoice_id) {
        setSuccessMsg(
          "Запазено. Фактурата и зависимите документи са регенерирани.",
        );
      } else {
        setSuccessMsg("Промените са записани.");
      }

      setTimeout(() => onClose(), 700);
    },
    onError: (err: any) => {
      const msg =
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        "Грешка при запис на поръчката";
      setErrorMsg(msg);
    },
  });

  const canSubmit =
    validItems.length > 0 && !mutation.isPending && !hasStockIssues;

  return (
    <Dialog open={open} onOpenChange={onClose} modal={false}>
      <DialogContent className="sm:max-w-[98vw] lg:max-w-[1680px] max-h-[92vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            Редакция на поръчка #{order.order_number ?? order.id}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0 space-y-4 py-2 pr-1">
          {order.status === "invoiced" && (
            <div className="text-sm bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-amber-800">
              След запазване системата автоматично регенерира фактура, стокова
              разписка и търговски документ.
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Дата на доставка</Label>
              <Input
                type="date"
                value={deliveryDate}
                onChange={(e) => setDeliveryDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Партньор</Label>
              <Input
                value={
                  order.partner?.name ||
                  order.partner_name ||
                  `#${order.partner_id}`
                }
                disabled
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Артикули</Label>
            <div className="border rounded-lg overflow-x-auto">
              <Table className="min-w-[1000px]">
                <TableHeader>
                  <TableRow>
                    {/* Wider dialog (98vw / 1680px) lets us relax the
                        cramped columns: FEFO batch label + "или ръчно:
                        партида" input + "Няма налични партиди за избор"
                        helper all need breathing room. Product column
                        uses min-width so it claims residual space. */}
                    <TableHead className="min-w-[320px]">Продукт</TableHead>
                    <TableHead className="w-[260px]">Партида</TableHead>
                    <TableHead className="w-32">Годност</TableHead>
                    <TableHead className="w-24">Наличност</TableHead>
                    <TableHead className="w-28">Количество</TableHead>
                    <TableHead className="w-32">Ед. цена</TableHead>
                    <TableHead className="w-20">Отст. %</TableHead>
                    <TableHead className="w-28">Сума</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item, i) => {
                    const qty = Number(item.quantity) || 0;
                    const price = Number(item.unit_price) || 0;
                    const discount = Number(item.discount_percent) || 0;
                    const lineTotal = qty * price * (1 - discount / 100);
                    const availableStock = getEffectiveStock(item);
                    const hasKnownStock = availableStock >= 0;
                    const overStock = hasKnownStock && qty > availableStock;
                    return (
                      <TableRow
                        key={item.row_key}
                        className={overStock ? "bg-red-50" : ""}
                      >
                        <TableCell>
                          {item.product_id ? (
                            <div className="flex items-center gap-2">
                              <Package className="h-4 w-4 text-gray-400 shrink-0" />
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium truncate">
                                  {item.product_name}
                                </div>
                                <div className="text-xs text-gray-400">
                                  {item.unit}
                                </div>
                              </div>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => clearProduct(i)}
                              >
                                Смени
                              </Button>
                            </div>
                          ) : (
                            <ProductSearchBoundary
                              key={`edit-psb-${item.row_key}`}
                            >
                              <ProductSearch
                                partnerId={String(order.partner_id)}
                                onSelect={(p) => handleProductSelect(i, p)}
                                disabled={false}
                              />
                            </ProductSearchBoundary>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            <BatchSelectField
                              item={item}
                              onChange={(value) =>
                                setItem(i, "selected_batch_id", value)
                              }
                              disabled={!item.product_id}
                            />
                            {!item.selected_batch_id && item.product_id && (
                              <Input
                                value={item.manual_batch_number}
                                onChange={(e) =>
                                  setItem(
                                    i,
                                    "manual_batch_number",
                                    e.target.value,
                                  )
                                }
                                placeholder="или ръчно: партида"
                                className="h-7 text-xs font-mono"
                              />
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {(() => {
                            const exp = getSelectedBatchExpiry(item);
                            if (exp) {
                              return (
                                <span className="text-sm text-gray-700 whitespace-nowrap">
                                  {formatBatchExpiry(exp)}
                                </span>
                              );
                            }
                            // No picked batch — allow manual entry
                            return (
                              <SmartDateInput
                                value={item.manual_expiry_date}
                                onChange={(iso) =>
                                  setItem(i, "manual_expiry_date", iso)
                                }
                                disabled={!item.product_id}
                                className="h-8 text-xs"
                                placeholder="ДД.ММ.ГГ"
                              />
                            );
                          })()}
                        </TableCell>
                        <TableCell>
                          {item.product_id ? (
                            hasKnownStock ? (
                              <span
                                className={`text-sm font-medium ${availableStock > 0 ? "text-green-600" : "text-red-500"}`}
                              >
                                {availableStock}
                              </span>
                            ) : (
                              <span className="text-xs text-gray-400">—</span>
                            )
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min="0.001"
                            step="0.001"
                            value={item.quantity}
                            onChange={(e) =>
                              setItem(i, "quantity", e.target.value)
                            }
                            disabled={!item.product_id}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            value={item.unit_price}
                            onChange={(e) =>
                              setItem(i, "unit_price", e.target.value)
                            }
                            disabled={!item.product_id}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            step="0.1"
                            min="0"
                            max="100"
                            value={item.discount_percent}
                            onChange={(e) =>
                              setItem(i, "discount_percent", e.target.value)
                            }
                            disabled={!item.product_id}
                            placeholder="0"
                            className={`w-20 ${discount > 0 ? "border-blue-400 text-blue-700" : ""}`}
                          />
                        </TableCell>
                        <TableCell className="font-medium text-sm">
                          {lineTotal > 0 ? formatCurrency(lineTotal) : "—"}
                        </TableCell>
                        <TableCell>
                          <button
                            type="button"
                            onClick={() => removeItem(i)}
                            className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <Button variant="outline" size="sm" onClick={addItem} type="button">
              + Добави артикул
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label>Бележки</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
        </div>

        {hasStockIssues && (
          <div className="text-sm bg-red-50 border border-red-200 rounded-md px-3 py-2 text-red-700">
            Количеството надвишава наличността за някои артикули.
          </div>
        )}
        {errorMsg && <ErrorMessage message={errorMsg} />}
        {successMsg && (
          <div className="text-sm bg-green-50 border border-green-200 rounded-md px-3 py-2 text-green-700">
            {successMsg}
          </div>
        )}

        <DialogFooter className="shrink-0 gap-2">
          <Button variant="outline" onClick={onClose}>
            Отказ
          </Button>
          <Button
            onClick={() => {
              setErrorMsg("");
              mutation.mutate();
            }}
            disabled={!canSubmit}
          >
            {mutation.isPending ? (
              <>
                <Spinner size="sm" />
                Запазване...
              </>
            ) : (
              "Запази промени"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/*  Create Order Modal (ISSUE 1 integrated)                            */
/* ------------------------------------------------------------------ */
function CreateOrderModal({
  open,
  onClose,
  onCreated,
  partners,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (order: Order) => void;
  partners: Partner[];
}) {
  const qc = useQueryClient();
  const today = isoDateToday();
  const [form, setForm] = useState({
    partner_id: "",
    delivery_date: today,
    request_number: "",
    partner_object_id: "",
    object_name: "",
    object_code: "",
    notes: "",
  });
  const [items, setItems] = useState<OrderItemRow[]>([emptyItem()]);
  const [stockWarnings, setStockWarnings] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [orderCreated, setOrderCreated] = useState(false);
  const [confirmOverstock, setConfirmOverstock] = useState(false);

  // Keyboard-flow refs — Enter in expiry jumps to qty → price → (next row)
  // expiry, so warehouse staff can key-fill a whole order from a single
  // "typed scan" without reaching for the mouse. Keyed by row_key so
  // adding/removing rows keeps the right input in focus.
  const qtyRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const priceRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const discountRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const expiryRefs = useRef<Record<string, HTMLInputElement | null>>({});
  // Full "top-of-form" keyboard flow: партньор → дата → № заявка →
  // обект → (име/код ако нов) → първи продукт.
  const partnerInputRef = useRef<HTMLInputElement | null>(null);
  const dateInputRef = useRef<HTMLInputElement | null>(null);
  const requestNumberRef = useRef<HTMLInputElement | null>(null);
  const objectComboRef = useRef<HTMLInputElement | null>(null);
  const objectNameRef = useRef<HTMLInputElement | null>(null);
  const objectCodeRef = useRef<HTMLInputElement | null>(null);
  const productSearchRefs = useRef<Record<string, ProductSearchHandle | null>>(
    {},
  );
  // Pending focus intents — set synchronously, consumed after next render
  // when the refs have been reconciled (e.g. after handleProductSelect
  // swaps the <ProductSearch> for the expiry/qty row, or after addItem
  // appends a new row).
  const pendingFocusRowRef = useRef<string | null>(null);
  const pendingFocusNewRowProductRef = useRef<boolean>(false);
  const focusAndSelect = (el: HTMLInputElement | null) => {
    if (!el) return;
    el.focus();
    try {
      el.select();
    } catch {
      /* some input types don't support select(); ignore */
    }
  };
  const focusProductSearch = (rowKey: string | undefined | null) => {
    if (!rowKey) return;
    const handle = productSearchRefs.current[rowKey];
    handle?.focus();
  };

  // Reset on open
  useEffect(() => {
    if (open) {
      setForm({
        partner_id: "",
        delivery_date: today,
        request_number: "",
        partner_object_id: "",
        object_name: "",
        object_code: "",
        notes: "",
      });
      setItems([emptyItem()]);
      setStockWarnings([]);
      setErrorMsg("");
      setOrderCreated(false);
      setConfirmOverstock(false);
      // Auto-land focus on партньор combobox so user can start typing
      // immediately — no mouse needed to begin a new order.
      queueMicrotask(() => partnerInputRef.current?.focus());
    }
  }, [open, today]);

  // Consume deferred focus intents AFTER items re-render so refs point
  // at the newly rendered inputs. Two flavours:
  //   (a) just-picked-product → jump from ProductSearch to the row's
  //       expiry (or qty if batch/expiry is auto-picked).
  //   (b) just-added-row → focus the new row's ProductSearch.
  useEffect(() => {
    if (pendingFocusRowRef.current) {
      const rowKey = pendingFocusRowRef.current;
      pendingFocusRowRef.current = null;
      queueMicrotask(() => {
        const target =
          expiryRefs.current[rowKey] ?? qtyRefs.current[rowKey] ?? null;
        focusAndSelect(target);
      });
    }
    if (pendingFocusNewRowProductRef.current) {
      pendingFocusNewRowProductRef.current = false;
      queueMicrotask(() => {
        const last = items[items.length - 1];
        if (last) focusProductSearch(last.row_key);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const { data: partnerObjects = [], isLoading: partnerObjectsLoading } =
    useQuery<PartnerOrderObject[]>({
      queryKey: ["partner-order-objects", form.partner_id],
      queryFn: () =>
        api.get(`/partners/${form.partner_id}/order-objects`).then((r) => {
          const d = r.data;
          return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
        }),
      enabled: open && Boolean(form.partner_id),
      staleTime: 60_000,
    });

  const selectedPartnerObject = partnerObjects.find(
    (obj) => String(obj.id) === form.partner_object_id,
  );

  const handleProductSelect = useCallback(
    (idx: number, product: OrderProduct) => {
      const rawPrice =
        product.partner_price ?? product.group_price ?? product.selling_price;
      const price = rawPrice != null ? parseFloat(String(rawPrice)) : null;
      const stock = parseFloat(String(product.total_stock || 0));
      // Snapshot cost — used to warn later if unit_price drops below it.
      const cost =
        product.purchase_price != null
          ? parseFloat(String(product.purchase_price))
          : 0;
      setItems((prev) =>
        prev.map((item, i) => {
          if (i !== idx) return item;
          // Remember which row's expiry/qty to focus after this render:
          // once the row flips from "product picker" to "filled product",
          // the expiry/qty inputs will mount and the deferred focus
          // effect can honour it.
          pendingFocusRowRef.current = item.row_key;
          return {
            ...item,
            product_id: String(product.id),
            product_name: product.name_bg || product.name_en || "Без име",
            quantity: item.quantity || "1",
            unit_price: item.unit_price || (price != null ? String(price) : ""),
            unit: product.unit || "бр.",
            stock,
            cost_price: Number.isFinite(cost) && cost > 0 ? cost : 0,
            batches: product.batches || [],
            selected_batch_id: "",
          };
        }),
      );
    },
    [],
  );

  const setItem = (idx: number, field: keyof OrderItemRow, value: string) => {
    setItems((items) =>
      items.map((item, i) => (i === idx ? { ...item, [field]: value } : item)),
    );
    setStockWarnings([]);
  };

  const removeItem = (idx: number) => {
    setItems((items) =>
      items.length === 1 ? [emptyItem()] : items.filter((_, i) => i !== idx),
    );
    setStockWarnings([]);
  };

  const addItem = () => setItems((i) => [...i, emptyItem()]);
  // Same as addItem but schedules focus to land on the new row's
  // ProductSearch — used by "Enter on last-row price" so the cashier
  // never needs the mouse between items.
  const addItemAndFocus = () => {
    pendingFocusNewRowProductRef.current = true;
    addItem();
  };

  const validItems = items.filter(
    (i) => i.product_id && Number(i.quantity) > 0,
  );
  // Line totals respect per-line отстъпка: qty × unit × (1 − disc/100).
  const orderTotal = validItems.reduce((sum, i) => {
    const disc = Number(i.discount_percent) || 0;
    return sum + Number(i.quantity) * Number(i.unit_price) * (1 - disc / 100);
  }, 0);
  const hasStockIssues = validItems.some(
    (i) =>
      getEffectiveStock(i) >= 0 && Number(i.quantity) > getEffectiveStock(i),
  );
  // Soft guard: any row where the post-discount unit price is under the
  // snapshotted cost. Сравняваме cost с effective price (not list), защото
  // 20% отстъпка върху листова 10лв прави effective 8лв — ако ДЦ е 9лв,
  // това е вече под-ДЦ продажба.
  const belowCostItems = validItems.filter((i) => {
    const disc = Number(i.discount_percent) || 0;
    const effectivePrice = Number(i.unit_price) * (1 - disc / 100);
    return (
      i.cost_price > 0 && effectivePrice > 0 && effectivePrice < i.cost_price
    );
  });
  const hasBelowCost = belowCostItems.length > 0;
  const [confirmBelowCost, setConfirmBelowCost] = useState(false);
  // Reset the confirmation flag if the user fixes the prices (so they
  // don't accidentally submit a still-below-cost order from a prior
  // "yes, proceed" click).
  useEffect(() => {
    if (!hasBelowCost && confirmBelowCost) setConfirmBelowCost(false);
  }, [hasBelowCost, confirmBelowCost]);

  const mutation = useMutation({
    mutationFn: () =>
      api.post("/orders", {
        partner_id: Number(form.partner_id),
        delivery_date: form.delivery_date || undefined,
        request_number: form.request_number.trim() || undefined,
        partner_object_id: form.partner_object_id
          ? Number(form.partner_object_id)
          : undefined,
        object_name: form.object_name.trim() || undefined,
        object_code: form.object_code.trim() || undefined,
        notes: form.notes || undefined,
        items: validItems.map((i) => ({
          product_id: Number(i.product_id),
          quantity: Number(i.quantity),
          unit_price: Number(i.unit_price) || undefined,
          discount_percent: Number(i.discount_percent) || 0,
          batch_id: i.selected_batch_id
            ? Number(i.selected_batch_id)
            : undefined,
        })),
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({
        queryKey: ["partner-order-objects", form.partner_id],
      });
      const createdOrder: Order | undefined =
        res?.data?.data ?? res?.data ?? undefined;
      if (onCreated && createdOrder && createdOrder.id) {
        // Open detail modal directly — user sees order summary + can edit batches
        onClose();
        onCreated(createdOrder);
        return;
      }
      setOrderCreated(true);
      setTimeout(() => onClose(), 800);
    },
    onError: (err: any) => {
      const msg =
        err.response?.data?.message ||
        err.response?.data?.error ||
        "Грешка при създаване на поръчката";
      setErrorMsg(msg);
    },
  });

  const canSubmit =
    form.partner_id &&
    validItems.length > 0 &&
    !(form.object_code.trim() && !form.object_name.trim()) &&
    !mutation.isPending &&
    !orderCreated;

  // Ctrl/Cmd+Enter anywhere in the dialog submits the order (when it's
  // in a submittable state — warnings still need their explicit confirms
  // via the warning buttons, which keeps destructive decisions deliberate).
  const handleDialogKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter") return;
    if (!(e.ctrlKey || e.metaKey)) return;
    if (!canSubmit) return;
    if (hasStockIssues && !confirmOverstock) return;
    if (hasBelowCost && !confirmBelowCost) return;
    e.preventDefault();
    setErrorMsg("");
    mutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onClose} modal={false}>
      <DialogContent
        className="sm:max-w-[98vw] lg:max-w-[1680px] max-h-[92vh] flex flex-col"
        onKeyDown={handleDialogKeyDown}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>Нова поръчка</DialogTitle>
          <p className="text-xs text-gray-400 mt-1">
            Tab/Enter между полетата · Ctrl+Enter за създаване
          </p>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto min-h-0 space-y-4 py-2 pr-1">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Партньор *</Label>
              <Combobox
                inputRef={partnerInputRef}
                items={partners.map((p) => ({
                  value: String(p.id),
                  label: p.name,
                  hint: p.microinvest_code
                    ? `Код: ${p.microinvest_code}${p.eik ? ` · ЕИК: ${p.eik}` : ""}`
                    : p.eik
                      ? `ЕИК: ${p.eik}`
                      : undefined,
                }))}
                value={form.partner_id}
                onChange={(val) =>
                  setForm((f) => ({
                    ...f,
                    partner_id: val,
                    partner_object_id: "",
                    object_name: "",
                    object_code: "",
                  }))
                }
                onClear={() =>
                  setForm((f) => ({
                    ...f,
                    partner_id: "",
                    partner_object_id: "",
                    object_name: "",
                    object_code: "",
                  }))
                }
                onPickEnter={() =>
                  queueMicrotask(() => focusAndSelect(dateInputRef.current))
                }
                placeholder="Избери или потърси по код, име или ЕИК..."
                emptyMessage="Няма намерени партньори."
              />
            </div>
            <div className="space-y-1.5">
              <Label>Дата на доставка</Label>
              <Input
                ref={dateInputRef}
                type="date"
                value={form.delivery_date}
                min={today}
                placeholder="дд.мм.гггг"
                onChange={(e) =>
                  setForm((f) => ({ ...f, delivery_date: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    focusAndSelect(requestNumberRef.current);
                  }
                }}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Номер на заявка</Label>
              <Input
                ref={requestNumberRef}
                value={form.request_number}
                onChange={(e) =>
                  setForm((f) => ({ ...f, request_number: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    focusAndSelect(objectComboRef.current);
                  }
                }}
                placeholder="напр. Z-2026-0412"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Обект / магазин</Label>
              <Combobox
                inputRef={objectComboRef}
                items={[
                  {
                    value: "__new__",
                    label: form.partner_id
                      ? "+ Нов обект..."
                      : "Избери партньор първо...",
                  },
                  ...partnerObjects.map((obj) => ({
                    value: String(obj.id),
                    label: obj.object_code
                      ? `${obj.object_code} · ${obj.object_name}`
                      : obj.object_name,
                  })),
                ]}
                value={form.partner_object_id || "__new__"}
                disabled={!form.partner_id || partnerObjectsLoading}
                onChange={(val) => {
                  if (val === "__new__") {
                    setForm((f) => ({
                      ...f,
                      partner_object_id: "",
                      object_name: "",
                      object_code: "",
                    }));
                    return;
                  }
                  const selected = partnerObjects.find(
                    (obj) => String(obj.id) === val,
                  );
                  setForm((f) => ({
                    ...f,
                    partner_object_id: val,
                    object_name: selected?.object_name ?? "",
                    object_code: selected?.object_code ?? "",
                  }));
                }}
                onClear={() =>
                  setForm((f) => ({
                    ...f,
                    partner_object_id: "",
                    object_name: "",
                    object_code: "",
                  }))
                }
                onPickEnter={() => {
                  // If user picked an existing object, skip the name/code
                  // inputs (they stay hidden) and go straight to the
                  // first product search. If they picked "+ Нов обект",
                  // send them into Име на обект so they can type it.
                  queueMicrotask(() => {
                    const picked = form.partner_object_id;
                    // NB: form.partner_object_id hasn't updated yet
                    // inside the closure — use the ref's current check.
                    // Safer: look at objectNameRef / first product ref.
                    if (objectNameRef.current) {
                      focusAndSelect(objectNameRef.current);
                    } else {
                      focusProductSearch(items[0]?.row_key);
                    }
                    void picked;
                  });
                }}
                placeholder="Избери или потърси обект..."
                emptyMessage="Няма намерени обекти."
              />
            </div>
          </div>

          {!form.partner_object_id && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Име на обект</Label>
                <Input
                  ref={objectNameRef}
                  value={form.object_name}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, object_name: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      focusAndSelect(objectCodeRef.current);
                    }
                  }}
                  placeholder="напр. Kaufland Бургас 7"
                  disabled={!form.partner_id}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Код на обект</Label>
                <Input
                  ref={objectCodeRef}
                  value={form.object_code}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, object_code: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      focusProductSearch(items[0]?.row_key);
                    }
                  }}
                  placeholder="напр. BGS-007"
                  disabled={!form.partner_id}
                />
              </div>
            </div>
          )}

          {form.partner_object_id && selectedPartnerObject && (
            <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded px-3 py-2">
              Избран обект:{" "}
              <span className="font-medium text-gray-700">
                {selectedPartnerObject.object_code
                  ? `${selectedPartnerObject.object_code} · ${selectedPartnerObject.object_name}`
                  : selectedPartnerObject.object_name}
              </span>
            </div>
          )}

          {form.object_code.trim() && !form.object_name.trim() && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
              Въведете име на обекта, когато задавате код.
            </div>
          )}

          <div className="space-y-2">
            <Label>Артикули</Label>
            <div className="border rounded-lg overflow-x-auto">
              <Table className="min-w-[1000px]">
                <TableHeader>
                  <TableRow>
                    {/* Wider dialog (98vw / 1680px) lets us relax the
                        cramped columns: FEFO batch label + "или ръчно:
                        партида" input + "Няма налични партиди за избор"
                        helper all need breathing room. Product column
                        uses min-width so it claims residual space. */}
                    <TableHead className="min-w-[320px]">Продукт</TableHead>
                    <TableHead className="w-[260px]">Партида</TableHead>
                    <TableHead className="w-32">Годност</TableHead>
                    <TableHead className="w-24">Наличност</TableHead>
                    <TableHead className="w-28">Количество</TableHead>
                    <TableHead className="w-32">Ед. цена</TableHead>
                    <TableHead className="w-20">Отст. %</TableHead>
                    <TableHead className="w-28">Сума</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item, i) => {
                    const qty = Number(item.quantity) || 0;
                    const price = Number(item.unit_price) || 0;
                    const discount = Number(item.discount_percent) || 0;
                    const lineTotal = qty * price * (1 - discount / 100);
                    const availableStock = getEffectiveStock(item);
                    const overStock =
                      item.product_id &&
                      availableStock >= 0 &&
                      qty > availableStock;
                    const noPrice = item.product_id && !price;
                    // Effective price (post-discount) — used за below-cost
                    // проверката, за да хващаме и случая "цена 10лв при 20%
                    // отстъпка дава 8лв < ДЦ 9лв".
                    const effectivePrice = price * (1 - discount / 100);
                    const belowCost =
                      item.product_id &&
                      effectivePrice > 0 &&
                      item.cost_price > 0 &&
                      effectivePrice < item.cost_price;
                    return (
                      <TableRow
                        key={item.row_key}
                        className={
                          overStock
                            ? "bg-red-50"
                            : belowCost
                              ? "bg-amber-50"
                              : ""
                        }
                      >
                        <TableCell>
                          {item.product_id ? (
                            <div className="flex items-center gap-2">
                              <Package className="h-4 w-4 text-gray-400 shrink-0" />
                              <div className="min-w-0">
                                <div className="text-sm font-medium truncate">
                                  {item.product_name}
                                </div>
                                <div className="text-xs text-gray-400">
                                  {item.unit}
                                </div>
                              </div>
                            </div>
                          ) : (
                            <ProductSearchBoundary key={`psb-${item.row_key}`}>
                              <ProductSearch
                                ref={(h) => {
                                  productSearchRefs.current[item.row_key] = h;
                                }}
                                partnerId={form.partner_id}
                                onSelect={(p) => handleProductSelect(i, p)}
                                disabled={!form.partner_id}
                              />
                            </ProductSearchBoundary>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            <BatchSelectField
                              item={item}
                              onChange={(value) =>
                                setItem(i, "selected_batch_id", value)
                              }
                              disabled={!item.product_id}
                            />
                            {!item.selected_batch_id && item.product_id && (
                              <Input
                                value={item.manual_batch_number}
                                onChange={(e) =>
                                  setItem(
                                    i,
                                    "manual_batch_number",
                                    e.target.value,
                                  )
                                }
                                placeholder="или ръчно: партида"
                                className="h-7 text-xs font-mono"
                              />
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {(() => {
                            const exp = getSelectedBatchExpiry(item);
                            if (exp) {
                              return (
                                <span className="text-sm text-gray-700 whitespace-nowrap">
                                  {formatBatchExpiry(exp)}
                                </span>
                              );
                            }
                            // No picked batch — allow manual entry
                            return (
                              <SmartDateInput
                                ref={(el) => {
                                  expiryRefs.current[item.row_key] = el;
                                }}
                                value={item.manual_expiry_date}
                                onChange={(iso) =>
                                  setItem(i, "manual_expiry_date", iso)
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    focusAndSelect(
                                      qtyRefs.current[item.row_key],
                                    );
                                  }
                                }}
                                disabled={!item.product_id}
                                className="h-8 text-xs"
                                placeholder="ДД.ММ.ГГ"
                              />
                            );
                          })()}
                        </TableCell>
                        <TableCell>
                          {item.product_id ? (
                            <span
                              className={`text-sm font-medium ${availableStock > 0 ? "text-green-600" : "text-red-500"}`}
                            >
                              {availableStock}
                            </span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell>
                          <Input
                            ref={(el) => {
                              qtyRefs.current[item.row_key] = el;
                            }}
                            type="number"
                            min="0.001"
                            step="0.001"
                            value={item.quantity}
                            onChange={(e) =>
                              setItem(i, "quantity", e.target.value)
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                focusAndSelect(priceRefs.current[item.row_key]);
                              }
                            }}
                            className={`w-24 ${overStock ? "border-red-400 text-red-600" : ""}`}
                            disabled={!item.product_id}
                          />
                          {overStock && (
                            <div className="text-xs text-red-500 mt-0.5">
                              max {availableStock}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Input
                            ref={(el) => {
                              priceRefs.current[item.row_key] = el;
                            }}
                            type="number"
                            step="0.01"
                            min="0"
                            value={item.unit_price}
                            onChange={(e) =>
                              setItem(i, "unit_price", e.target.value)
                            }
                            onKeyDown={(e) => {
                              if (e.key !== "Enter") return;
                              e.preventDefault();
                              // Enter in Цена → jump to Отст. % на СЪЩИЯ ред.
                              focusAndSelect(
                                discountRefs.current[item.row_key],
                              );
                            }}
                            className={`w-28 ${
                              noPrice
                                ? "border-orange-400"
                                : belowCost
                                  ? "border-amber-500 text-amber-700"
                                  : ""
                            }`}
                            disabled={!item.product_id}
                            title={
                              belowCost
                                ? `Под доставната цена (${formatCurrency(item.cost_price)})`
                                : undefined
                            }
                          />
                          {noPrice && (
                            <div className="text-xs text-orange-500 mt-0.5">
                              задай цена
                            </div>
                          )}
                          {!noPrice && belowCost && (
                            <div className="text-[10px] text-amber-700 mt-0.5 whitespace-nowrap">
                              ⚠ под ДЦ: {formatCurrency(item.cost_price)}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Input
                            ref={(el) => {
                              discountRefs.current[item.row_key] = el;
                            }}
                            type="number"
                            step="0.1"
                            min="0"
                            max="100"
                            value={item.discount_percent}
                            onChange={(e) =>
                              setItem(i, "discount_percent", e.target.value)
                            }
                            onKeyDown={(e) => {
                              if (e.key !== "Enter") return;
                              e.preventDefault();
                              const nextRow = items[i + 1];
                              if (nextRow) {
                                focusAndSelect(
                                  expiryRefs.current[nextRow.row_key],
                                );
                                return;
                              }
                              // Last row — auto-add if filled. Отстъпката
                              // е optional — не я включваме в "is filled"
                              // проверката.
                              if (
                                item.product_id &&
                                Number(item.quantity) > 0 &&
                                Number(item.unit_price) > 0
                              ) {
                                addItemAndFocus();
                              } else {
                                focusAndSelect(
                                  expiryRefs.current[item.row_key],
                                );
                              }
                            }}
                            className={`w-20 ${discount > 0 ? "border-blue-400 text-blue-700" : ""}`}
                            disabled={!item.product_id}
                            placeholder="0"
                          />
                        </TableCell>
                        <TableCell className="font-medium text-sm">
                          {lineTotal > 0 ? formatCurrency(lineTotal) : "—"}
                        </TableCell>
                        <TableCell>
                          <button
                            type="button"
                            onClick={() => removeItem(i)}
                            className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <Button variant="outline" size="sm" onClick={addItem} type="button">
              + Добави артикул
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label>Бележки</Label>
            <Textarea
              value={form.notes}
              onChange={(e) =>
                setForm((f) => ({ ...f, notes: e.target.value }))
              }
              rows={2}
            />
          </div>
        </div>

        {/* Order total */}
        <div className="border-t pt-3 shrink-0">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-500">
              {validItems.length} артикул{validItems.length !== 1 ? "а" : ""}
            </span>
            <span className="text-lg font-bold">
              Общо: {formatCurrency(orderTotal)}
            </span>
          </div>

          {hasStockIssues && !confirmOverstock && (
            <div className="flex items-start gap-2 p-2 bg-orange-50 border border-orange-200 rounded text-sm text-orange-700 mb-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium mb-1">
                  Внимание: Недостатъчна наличност!
                </div>
                <div className="mb-2">
                  Следните артикули надвишават наличното количество:
                </div>
                <ul className="list-disc list-inside space-y-0.5">
                  {validItems
                    .filter(
                      (i) =>
                        getEffectiveStock(i) >= 0 &&
                        Number(i.quantity) > getEffectiveStock(i),
                    )
                    .map((i, idx) => (
                      <li key={idx}>
                        {i.product_name}: налични {getEffectiveStock(i)},
                        поръчани {i.quantity}
                      </li>
                    ))}
                </ul>
              </div>
            </div>
          )}

          {hasStockIssues && confirmOverstock && (
            <div className="flex items-start gap-2 p-2 bg-yellow-50 border border-yellow-200 rounded text-sm text-yellow-800 mb-2">
              <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                Потвърдено — поръчката ще бъде създадена въпреки недостатъчната
                наличност.
              </span>
            </div>
          )}

          {hasBelowCost && !confirmBelowCost && (
            <div className="flex items-start gap-2 p-2 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800 mb-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium mb-1">
                  Внимание: продажба под доставната цена!
                </div>
                <div className="mb-1">
                  Следните артикули са с цена под ДЦ (губиш пари на всеки бр.):
                </div>
                <ul className="list-disc list-inside space-y-0.5">
                  {belowCostItems.map((i, idx) => {
                    const qty = Number(i.quantity) || 0;
                    const loss = (i.cost_price - Number(i.unit_price)) * qty;
                    return (
                      <li key={idx}>
                        {i.product_name}: продаваш на{" "}
                        {formatCurrency(Number(i.unit_price))}, ДЦ{" "}
                        {formatCurrency(i.cost_price)} (загуба{" "}
                        {formatCurrency(loss)})
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          )}

          {hasBelowCost && confirmBelowCost && (
            <div className="flex items-start gap-2 p-2 bg-yellow-50 border border-yellow-200 rounded text-sm text-yellow-800 mb-2">
              <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                Потвърдено — поръчката ще бъде създадена въпреки продажба под
                ДЦ.
              </span>
            </div>
          )}

          {errorMsg && <ErrorMessage message={errorMsg} />}

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={onClose}>
              {orderCreated ? "Затвори" : "Отказ"}
            </Button>
            {!orderCreated && hasStockIssues && !confirmOverstock && (
              <Button
                variant="destructive"
                onClick={() => setConfirmOverstock(true)}
              >
                <AlertTriangle className="h-4 w-4" />
                Потвърди въпреки липсата
              </Button>
            )}
            {!orderCreated &&
              (!hasStockIssues || confirmOverstock) &&
              hasBelowCost &&
              !confirmBelowCost && (
                <Button
                  variant="destructive"
                  onClick={() => setConfirmBelowCost(true)}
                  className="bg-amber-600 hover:bg-amber-700"
                >
                  <AlertTriangle className="h-4 w-4" />
                  Потвърди под ДЦ
                </Button>
              )}
            {!orderCreated &&
              (!hasStockIssues || confirmOverstock) &&
              (!hasBelowCost || confirmBelowCost) && (
                <Button
                  onClick={() => {
                    setErrorMsg("");
                    mutation.mutate();
                  }}
                  disabled={!canSubmit}
                >
                  {mutation.isPending ? (
                    <>
                      <Spinner size="sm" />
                      Запазване...
                    </>
                  ) : (
                    "Създай поръчка"
                  )}
                </Button>
              )}
            {orderCreated && (
              <span className="text-sm text-green-600 flex items-center gap-1">
                <CheckCircle className="h-4 w-4" />
                Поръчката е създадена
              </span>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */

/*  Main Orders page                                                   */
/* ------------------------------------------------------------------ */
export function Orders() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState("");
  // Per-column text filters
  const [filters, setFilters] = useState({
    order_number: "",
    partner: "",
    invoice: "",
    stock_dispatch: "",
    commercial_doc: "",
    request_number: "",
  });
  // Date range filter — same pattern as Приемане на стоки
  const todayIso = new Date().toISOString().split("T")[0];
  const thirtyDaysAgoIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  const [showHistory, setShowHistory] = useState(false);
  const [dateFrom, setDateFrom] = useState(thirtyDaysAgoIso);
  const [dateTo, setDateTo] = useState(todayIso);
  const activeDateFrom = showHistory ? dateFrom : todayIso;
  const activeDateTo = showHistory ? dateTo : todayIso;
  const [createOpen, setCreateOpen] = useState(false);
  const [detailOrder, setDetailOrder] = useState<Order | null>(null);

  const {
    data: orders = [],
    isLoading,
    error,
  } = useQuery<Order[]>({
    queryKey: ["orders", statusFilter],
    queryFn: () => {
      const params = statusFilter ? `?status=${statusFilter}` : "";
      return api.get(`/orders${params}`).then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      });
    },
    refetchInterval: 30000,
  });

  const { data: partners = [] } = useQuery<Partner[]>({
    queryKey: ["partners", "catalog"],
    queryFn: () =>
      // catalog=true bypasses the 100-row API cap so the partner picker
      // dropdown sees ALL partners (the DB already has 400+ rows).
      api.get("/partners?catalog=true&limit=5000").then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      }),
  });

  // Client-side multi-filter (per-column + date range)
  const filteredOrders = useMemo(() => {
    const matchField = (
      haystack: string | number | null | undefined,
      needle: string,
    ) => {
      if (!needle.trim()) return true;
      if (haystack == null) return false;
      return matchesSearch(String(haystack), needle);
    };

    return orders.filter((order) => {
      // № — check both order_number and id
      if (filters.order_number.trim()) {
        const ok = matchesAnyField(filters.order_number, [
          String(order.order_number ?? ""),
          String(order.id),
        ]);
        if (!ok) return false;
      }
      // Partner — name
      if (
        !matchField(
          order.partner?.name ?? order.partner_name ?? "",
          filters.partner,
        )
      )
        return false;
      // Invoice — invoice_number OR annulled_invoice_number
      if (filters.invoice.trim()) {
        const ok = matchesAnyField(filters.invoice, [
          order.invoice_number ?? "",
          order.annulled_invoice_number ?? "",
        ]);
        if (!ok) return false;
      }
      // Stock dispatch
      if (!matchField(order.stock_dispatch_number, filters.stock_dispatch))
        return false;
      // Commercial document
      if (!matchField(order.commercial_document_number, filters.commercial_doc))
        return false;
      // Request number
      if (!matchField(order.request_number, filters.request_number))
        return false;

      // Date range — based on order_date
      if (activeDateFrom || activeDateTo) {
        const orderIso = (order.order_date ?? "").split("T")[0];
        if (!orderIso) return false;
        if (activeDateFrom && orderIso < activeDateFrom) return false;
        if (activeDateTo && orderIso > activeDateTo) return false;
      }

      return true;
    });
  }, [orders, filters, activeDateFrom, activeDateTo]);

  const hasActiveTextFilters = Object.values(filters).some((v) => v.trim());

  const fulfillMutation = useMutation({
    mutationFn: (id: number) => api.post(`/orders/${id}/fulfill`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orders"] }),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api.put(`/orders/${id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orders"] }),
  });

  const invoiceMutation = useMutation({
    mutationFn: (id: number) => api.post("/invoices", { order_id: id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orders"] }),
  });

  const fiscalReceiptMutation = useMutation({
    mutationFn: (id: number) => api.post("/fiscal/receipt", { order_id: id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orders"] }),
  });

  const regenerateInvoiceMutation = useMutation({
    mutationFn: (invoiceId: number) =>
      api.put(`/invoices/${invoiceId}/regenerate`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orders"] }),
  });

  const deleteOrderMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/orders/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["partner-order-counts"] });
    },
  });

  // ── Document PDF downloads ──
  const handleDocumentDownload = async (
    orderId: number,
    docType: "stock-dispatch" | "commercial-doc",
  ) => {
    try {
      const res = await api.get(`/orders/${orderId}/${docType}-pdf`, {
        responseType: "blob",
      });
      const blob = new Blob([res.data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);

      // Open in new tab for print
      const printWindow = window.open(url, "_blank");
      if (printWindow) {
        printWindow.addEventListener("load", () => {
          printWindow.print();
        });
      }

      // Also trigger download
      const link = document.createElement("a");
      link.href = url;
      link.download =
        docType === "stock-dispatch"
          ? `Стокова_разписка_${orderId}.pdf`
          : `Търговски_документ_${orderId}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      console.error(`Error downloading ${docType}:`, err);
      toast.error("Грешка при генериране на документ");
    }
  };

  // Invoice PDF download + print (for list view)
  const handleInvoicePrint = async (invoiceId: number) => {
    try {
      // Timestamp cache-buster — browser must not serve a stale
      // copy after the file on disk was regenerated.
      const bust = `?t=${Date.now()}`;
      let res;
      try {
        res = await api.get(`/invoices/${invoiceId}/pdf${bust}`, {
          responseType: "blob",
        });
      } catch (pdfErr: any) {
        // If PDF not found, try regenerating it first
        if (pdfErr?.response?.status === 404) {
          await api.put(`/invoices/${invoiceId}/regenerate`);
          res = await api.get(`/invoices/${invoiceId}/pdf${bust}`, {
            responseType: "blob",
          });
        } else {
          throw pdfErr;
        }
      }
      const blob = new Blob([res.data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const printWindow = window.open(url, "_blank");
      if (printWindow) {
        printWindow.addEventListener("load", () => {
          printWindow.print();
        });
      }
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err: any) {
      console.error("Error downloading invoice PDF:", err);
      // When responseType is blob, error data may be a Blob — try to parse it
      let msg = "Грешка при отваряне на фактура";
      try {
        if (err?.response?.data instanceof Blob) {
          const text = await err.response.data.text();
          const json = JSON.parse(text);
          if (json.error) msg = json.error;
        } else if (err?.response?.data?.error) {
          msg = err.response.data.error;
        }
      } catch {}
      toast.error(msg);
    }
  };

  const [statusDropdownId, setStatusDropdownId] = useState<number | null>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!statusDropdownId) return;
    const handler = () => setStatusDropdownId(null);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [statusDropdownId]);

  // Status transitions map
  const statusTransitions: Record<string, { label: string; value: string }[]> =
    {
      pending: [
        { label: "Потвърди", value: "confirmed" },
        { label: "Откажи", value: "cancelled" },
      ],
      confirmed: [
        { label: "В обработка", value: "processing" },
        { label: "Откажи", value: "cancelled" },
      ],
      processing: [
        { label: "Изпълни", value: "fulfilled" },
        { label: "Откажи", value: "cancelled" },
      ],
      fulfilled: [{ label: "Фактурирай", value: "invoiced" }],
    };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Поръчки</h1>
          <p className="text-gray-500 text-sm mt-1">
            Управление на клиентски поръчки
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Нова поръчка
        </Button>
      </div>

      {/* Status pills */}
      <div className="flex gap-2 flex-wrap">
        {[
          "",
          "pending",
          "confirmed",
          "processing",
          "fulfilled",
          "invoiced",
          "cancelled",
        ].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              statusFilter === s
                ? "bg-[#6c3dff] text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {s === "" ? "Всички" : statusLabels[s]}
          </button>
        ))}
      </div>

      {/* Date filter — same pattern as Приемане на стоки */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="font-medium text-gray-700">
          {showHistory
            ? "📋 История на поръчките"
            : `📦 Днешни поръчки — ${new Date().toLocaleDateString("bg-BG")}`}
        </div>
        <div className="flex items-center gap-2">
          {showHistory && (
            <div className="flex items-center gap-2 text-sm">
              <label className="text-gray-500">От:</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="border rounded px-2 py-1 text-sm"
              />
              <label className="text-gray-500">До:</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="border rounded px-2 py-1 text-sm"
              />
            </div>
          )}
          <Button
            variant={showHistory ? "default" : "outline"}
            size="sm"
            onClick={() => setShowHistory((h) => !h)}
          >
            {showHistory ? "← Днес" : "📋 История"}
          </Button>
        </div>
      </div>

      {/* Per-column search filters */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <Input
            value={filters.order_number}
            onChange={(e) =>
              setFilters((f) => ({ ...f, order_number: e.target.value }))
            }
            placeholder="№ поръчка"
            className="pl-8 h-9 text-sm"
          />
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <Input
            value={filters.partner}
            onChange={(e) =>
              setFilters((f) => ({ ...f, partner: e.target.value }))
            }
            placeholder="Партньор"
            className="pl-8 h-9 text-sm"
          />
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <Input
            value={filters.request_number}
            onChange={(e) =>
              setFilters((f) => ({ ...f, request_number: e.target.value }))
            }
            placeholder="№ заявка"
            className="pl-8 h-9 text-sm"
          />
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <Input
            value={filters.invoice}
            onChange={(e) =>
              setFilters((f) => ({ ...f, invoice: e.target.value }))
            }
            placeholder="№ фактура"
            className="pl-8 h-9 text-sm"
          />
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <Input
            value={filters.stock_dispatch}
            onChange={(e) =>
              setFilters((f) => ({ ...f, stock_dispatch: e.target.value }))
            }
            placeholder="Стокова разписка"
            className="pl-8 h-9 text-sm"
          />
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <Input
            value={filters.commercial_doc}
            onChange={(e) =>
              setFilters((f) => ({ ...f, commercial_doc: e.target.value }))
            }
            placeholder="Търговски документ"
            className="pl-8 h-9 text-sm"
          />
        </div>
      </div>

      {(hasActiveTextFilters || showHistory) && (
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <span>
            Намерени:{" "}
            <span className="font-medium text-gray-900">
              {filteredOrders.length}
            </span>{" "}
            от {orders.length}
          </span>
          <button
            type="button"
            onClick={() => {
              setFilters({
                order_number: "",
                partner: "",
                invoice: "",
                stock_dispatch: "",
                commercial_doc: "",
                request_number: "",
              });
              setShowHistory(false);
            }}
            className="flex items-center gap-1 text-xs text-red-600 hover:text-red-700"
          >
            <XIcon className="h-3 w-3" />
            Изчисти всички филтри
          </button>
        </div>
      )}

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
                  <TableHead>№</TableHead>
                  <TableHead>Партньор</TableHead>
                  <TableHead>Дата</TableHead>
                  <TableHead>Сума</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead>Фактура</TableHead>
                  <TableHead>Документи</TableHead>
                  <TableHead>Източник</TableHead>
                  <TableHead className="text-right">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredOrders.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={10}
                      className="text-center text-gray-400 py-8"
                    >
                      {hasActiveTextFilters || showHistory
                        ? "Няма намерени поръчки за избраните филтри"
                        : "Няма поръчки за днес"}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredOrders.map((order) => (
                    <TableRow
                      key={order.id}
                      className="cursor-pointer hover:bg-gray-50"
                      onClick={() => setDetailOrder(order)}
                    >
                      <TableCell className="font-mono">
                        <HighlightMatch
                          text={String(order.order_number ?? order.id)}
                          query={filters.order_number}
                        />
                      </TableCell>
                      <TableCell className="font-medium">
                        <HighlightMatch
                          text={
                            order.partner?.name ??
                            order.partner_name ??
                            `#${order.partner_id}`
                          }
                          query={filters.partner}
                        />
                      </TableCell>
                      <TableCell>{formatDate(order.order_date)}</TableCell>
                      <TableCell className="font-medium">
                        {formatCurrency(order.total_amount)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={statusVariants[order.status] ?? "secondary"}
                        >
                          {statusLabels[order.status] ?? order.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {order.invoice_id ? (
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-1">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const param = order.invoice_number
                                    ? `?highlight=${encodeURIComponent(
                                        order.invoice_number,
                                      )}`
                                    : `?highlight_id=${order.invoice_id}`;
                                  navigate(`/invoices${param}`);
                                }}
                                className={`flex items-center gap-1 text-sm hover:underline font-mono ${
                                  order.credit_note_id
                                    ? "text-amber-700 line-through decoration-amber-500/60"
                                    : order.invoice_status === "cancelled"
                                      ? "text-red-600 line-through"
                                      : "text-[#6c3dff]"
                                }`}
                                title="Отвори в страница Фактури"
                              >
                                <ExternalLink className="h-3 w-3" />
                                {order.invoice_number ?? `#${order.invoice_id}`}
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  regenerateInvoiceMutation.mutate(
                                    order.invoice_id!,
                                  );
                                }}
                                disabled={regenerateInvoiceMutation.isPending}
                                className="text-gray-400 hover:text-[#6c3dff] p-0.5 rounded"
                                title="Регенерирай фактура"
                              >
                                <RefreshCw
                                  className={`h-3 w-3 ${regenerateInvoiceMutation.isPending ? "animate-spin" : ""}`}
                                />
                              </button>
                            </div>
                            {order.credit_note_id && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const cnNum = order.credit_note_number;
                                  if (cnNum) {
                                    navigate(
                                      `/invoices?highlight=${encodeURIComponent(cnNum)}`,
                                    );
                                  } else {
                                    navigate(
                                      `/invoices?highlight_id=${order.credit_note_id}`,
                                    );
                                  }
                                }}
                                className="flex items-center gap-1 text-xs text-orange-700 hover:underline font-mono w-fit"
                                title="Отвори кредитното известие"
                              >
                                <RotateCcw className="h-3 w-3" />
                                {order.credit_note_number ??
                                  `КИ-${order.credit_note_id}`}
                              </button>
                            )}
                            {!order.credit_note_id &&
                              order.invoice_status === "cancelled" && (
                                <span className="text-xs text-red-600">
                                  Анулирана
                                </span>
                              )}
                          </div>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {order.status === "fulfilled" ||
                        order.status === "invoiced" ? (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDocumentDownload(
                                  order.id,
                                  "stock-dispatch",
                                );
                              }}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition"
                              title="Стокова разписка"
                            >
                              <ClipboardList className="h-3 w-3" />
                              СР
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDocumentDownload(
                                  order.id,
                                  "commercial-doc",
                                );
                              }}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 transition"
                              title="Търговски документ"
                            >
                              <ScrollText className="h-3 w-3" />
                              ТД
                            </button>
                            {order.invoice_id && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleInvoicePrint(order.invoice_id!);
                                }}
                                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100 transition"
                                title="Печат фактура"
                              >
                                <FileText className="h-3 w-3" />
                                Фактура
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{order.source}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {/* View */}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDetailOrder(order);
                            }}
                            title="Преглед"
                            aria-label="Преглед на поръчка"
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </Button>

                          {/* Status change dropdown */}
                          {statusTransitions[order.status] && (
                            <div className="relative">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setStatusDropdownId(
                                    statusDropdownId === order.id
                                      ? null
                                      : order.id,
                                  );
                                }}
                                disabled={
                                  statusMutation.isPending ||
                                  fulfillMutation.isPending
                                }
                              >
                                <ChevronDown className="h-3.5 w-3.5" />
                                Статус
                              </Button>
                              {statusDropdownId === order.id && (
                                <div className="absolute right-0 top-full mt-1 z-50 bg-white border rounded-lg shadow-lg py-1 min-w-[160px]">
                                  {statusTransitions[order.status].map(
                                    (transition) => (
                                      <button
                                        key={transition.value}
                                        className={`w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 ${
                                          transition.value === "cancelled"
                                            ? "text-red-600"
                                            : ""
                                        }`}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          if (
                                            transition.value === "fulfilled"
                                          ) {
                                            fulfillMutation.mutate(order.id);
                                          } else {
                                            statusMutation.mutate({
                                              id: order.id,
                                              status: transition.value,
                                            });
                                          }
                                          setStatusDropdownId(null);
                                        }}
                                      >
                                        {transition.label}
                                      </button>
                                    ),
                                  )}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Invoice — fulfilled without invoice */}
                          {order.status === "fulfilled" &&
                            !order.invoice_id && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  invoiceMutation.mutate(order.id);
                                }}
                                disabled={invoiceMutation.isPending}
                              >
                                <FileText className="h-3.5 w-3.5" />
                                Фактура
                              </Button>
                            )}

                          {/* Fiscal receipt */}
                          {(order.status === "fulfilled" ||
                            order.status === "invoiced") &&
                            !order.receipt_printed && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  fiscalReceiptMutation.mutate(order.id);
                                }}
                                disabled={fiscalReceiptMutation.isPending}
                                title="Фискален бон"
                              >
                                &#x1F9FE;
                              </Button>
                            )}

                          {/* Delete — only for pending, confirmed, processing */}
                          {order.status !== "cancelled" &&
                            order.status !== "fulfilled" &&
                            order.status !== "invoiced" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  const ok = await confirm({
                                    title: "Изтриване на поръчка",
                                    description: `Сигурни ли сте, че искате да изтриете поръчка #${order.order_number ?? order.id}? Действието не може да бъде отменено.`,
                                    confirmText: "Изтрий",
                                    variant: "danger",
                                  });
                                  if (ok) {
                                    deleteOrderMutation.mutate(order.id);
                                  }
                                }}
                                disabled={deleteOrderMutation.isPending}
                                title="Изтрий поръчка"
                                className="text-red-500 hover:text-red-700 hover:bg-red-50"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <CreateOrderModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(newOrder) => setDetailOrder(newOrder)}
        partners={partners}
      />

      <OrderDetailModal
        order={detailOrder}
        onClose={() => setDetailOrder(null)}
      />
    </div>
  );
}
