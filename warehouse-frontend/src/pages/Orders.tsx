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
  RefreshCcw,
  RotateCcw,
  Coins,
  Hourglass,
  ClipboardList,
  ScrollText,
  XCircle,
  Search,
  X as XIcon,
  Truck,
  ShieldCheck,
  FileSignature,
  History,
  Building2,
  CreditCard,
  Tag,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { EcontShippingPicker } from "@/components/EcontShippingPicker";
import { EcontShipmentActions } from "@/components/EcontShipmentActions";
import { OrderActionsMenu } from "@/components/OrderActionsMenu";
import { RecordPaymentModal } from "@/components/RecordPaymentModal";
import type { Order, OrderItem, Partner } from "@/types";
import {
  formatDate,
  formatCurrency,
  isoDateToday,
  getApiErrorMessage,
  stockColorClass,
} from "@/lib/utils";
import { matchesSearch, matchesAnyField } from "@/lib/translit";
import { HighlightMatch, HighlightMultiToken } from "@/lib/highlight";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { SmartDateInput } from "@/components/ui/smart-date-input";
import { toast } from "@/lib/toast";
import { confirm } from "@/components/ConfirmDialog";
import { usePermissions } from "@/contexts/PermissionContext";
import { PERMISSIONS } from "@/lib/permissions";
import { VAT_EXEMPTION_REASONS } from "@/lib/vatExemptionReasons";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PartnerHistoryDrawer } from "@/components/PartnerHistoryDrawer";
import type { PartnerHistoryItem } from "@/components/PartnerHistoryDrawer";
import {
  OversellConfirmDialog,
  type OversellItem,
} from "@/components/OversellConfirmDialog";
import {
  INVOICE_PAYMENT_METHOD_OPTIONS,
  INVOICE_PAYMENT_METHOD_LABELS,
  type InvoicePaymentMethod,
} from "@/lib/invoicePaymentMethod";
import {
  ReplacementForm,
  type ReplacementFormState,
} from "@/components/orders/ReplacementForm";
import { ReplacementDetail } from "@/components/orders/ReplacementDetail";

const statusLabels: Record<string, string> = {
  pending: "Чакаща",
  confirmed: "Потвърдена",
  processing: "В обработка",
  fulfilled: "Изпълнена",
  cancelled: "Анулирана",
  invoiced: "Фактурирана",
  quoted: "Оферта",
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
  quoted: "warning",
};

function hasAnnulledInvoice(order: Pick<Order, "annulled_invoice_at">) {
  return Boolean(order.annulled_invoice_at);
}

/**
 * Arrow-key navigation между бутоните в един row (или група).
 *
 * Подход: attach-ва се като `onKeyDown` на parent div-а. При Arrow
 * Left/Right взима всички focusable button-и/линкове в контейнера и
 * мести фокуса към съседен. ArrowUp/ArrowDown отваря opt-out за
 * cross-row navigation (caller-ът решава дали да го handle-не).
 *
 * Кешъра идва от DOS-style програма — всичко се навигира с клавиатура.
 * Пример: drawer footer-а с "Генерирай оферта" / "Потвърди поръчка" —
 * ArrowLeft/Right прескача между двата, Enter активира.
 *
 * Връща true ако event-а е consumed (за да не дублира защита по-нагоре).
 */
function arrowNavRow(e: React.KeyboardEvent<HTMLElement>): boolean {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return false;
  // Не превземаме когато caret-ът е в input текст и user-ът редактира
  // (selectionStart > 0 за ArrowLeft, selectionEnd < length за ArrowRight).
  const target = e.target as HTMLElement;
  if (target instanceof HTMLInputElement && target.type !== "checkbox") {
    if (target.type === "number" || target.type === "text") {
      // За тези типове позволяваме arrow nav само когато caret-ът е в
      // края/началото на полето, за да не пречим на text editing.
      const len = (target.value ?? "").length;
      if (e.key === "ArrowLeft" && (target.selectionStart ?? 0) > 0)
        return false;
      if (e.key === "ArrowRight" && (target.selectionEnd ?? 0) < len)
        return false;
    }
  }
  const container = e.currentTarget;
  // Селектираме всички not-disabled focusable controls в реда.
  // Включваме button + a + input (без hidden), за да обхванем
  // checkbox-и в реда също.
  const controls = Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"])',
    ),
  );
  if (controls.length === 0) return false;
  const active = document.activeElement as HTMLElement | null;
  const idx = active ? controls.indexOf(active) : -1;
  if (idx === -1) return false;
  e.preventDefault();
  const nextIdx =
    e.key === "ArrowRight"
      ? Math.min(controls.length - 1, idx + 1)
      : Math.max(0, idx - 1);
  controls[nextIdx]?.focus();
  return true;
}

/**
 * Replacement orders carry a SIGNED total: positive when the customer must
 * doplaci, negative when the shop refunds the difference, zero for an even
 * swap. Backend stores it as |give − return| so we display the sign by
 * inferring direction from the items, but here we just respect whatever
 * sign the server sent — the row UI only needs the magnitude + a marker.
 */
function formatReplacementTotal(amount: number | null | undefined): string {
  const n = Number(amount ?? 0);
  if (Math.abs(n) < 0.005) return formatCurrency(0);
  const abs = formatCurrency(Math.abs(n));
  if (n > 0) return `+${abs}`;
  return `−${abs}`;
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
  weight_kg: number | null;
  total_stock: number;
  partner_price: number | null;
  low_stock_threshold?: number | null;
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
  /** Weight in kg for this line (stored string so the input can be empty). */
  weight_kg: string;
  /** Product's stored weight at pick time. If the user edits weight_kg
   *  and this snapshot differs, we PATCH it back to the product on save. */
  original_weight_kg: number | null;
  /** Batch F1 — per-line state. Defaults to 'normal'. paid_not_taken
   *  and awaiting opt out of the oversell guard (split-on-oversell UI). */
  line_status: "normal" | "paid_not_taken" | "awaiting";
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
  weight_kg: "",
  original_weight_kg: null,
  line_status: "normal",
  ...overrides,
});

const emptyItem = (): OrderItemRow => makeOrderItemRow();

function getEffectiveStock(item: OrderItemRow) {
  return item.stock;
}

async function openInvoicePdf(invoiceId: number, copies: 1 | 2 = 1) {
  try {
    // Append a timestamp so the browser never serves a stale cached
    // PDF after "Регенерирай" rewrites the file on disk.
    const res = await api.get(
      `/invoices/${invoiceId}/pdf?copies=${copies}&t=${Date.now()}`,
      {
        responseType: "blob",
      },
    );

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

// Batch D — invoice partner override. Either points to an existing partner
// from the catalog (carrying name/EIK for the chip preview), or carries the
// full new-partner data the server will upsert by EIK.
type PartnerOverride =
  | { partner_id: number; name: string; eik: string }
  | {
      name: string;
      eik: string;
      vat_number?: string;
      address?: string;
      city?: string;
      contact_person?: string;
      phone?: string;
      email?: string;
    };

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
                <div className="text-xs">
                  {(() => {
                    const qty = parseFloat(String(p.total_stock || 0));
                    if (qty < 0) {
                      return (
                        <span className="text-red-600 font-semibold">
                          на минус: {qty}
                        </span>
                      );
                    }
                    return (
                      <span
                        className={stockColorClass(qty, p.low_stock_threshold)}
                      >
                        налично: {qty}
                      </span>
                    );
                  })()}
                </div>
              </div>
            </div>
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
  onRecordPayment,
}: {
  order: Order | null;
  onClose: () => void;
  onRecordPayment: (order: Order) => void;
}) {
  const qc = useQueryClient();
  const { token: authToken } = useAuth();
  const { hasPermission } = usePermissions();
  const canEditAfterFulfill = hasPermission(
    PERMISSIONS.ORDERS_EDIT_AFTER_FULFILL,
  );

  // Fetch full order with items
  const {
    data: fullOrder,
    isLoading: detailLoading,
    refetch: refetchDetail,
  } = useQuery<Order>({
    queryKey: ["order-detail", order?.id],
    queryFn: () =>
      api.get(`/orders/${order!.id}`).then((r) => r.data?.data ?? r.data),
    enabled: !!order,
  });

  const detail = fullOrder ?? order;
  const items: OrderItem[] = detail?.items ?? [];

  // VAT toggle for invoice/documents
  const [invoiceNote, setInvoiceNote] = useState("");
  const [vatExemptionReason, setVatExemptionReason] = useState("");
  // Hidden invoice-date override — surfaces only when the cashier
  // presses a "−" then "+" chord while the order detail dialog is
  // focused. Use case: Saturday sale that needs to be backdated to
  // Friday so the weekly accounting paperwork stays in line. Empty
  // string = field hidden (default flow); non-empty = the date the
  // cashier picked. Cleared automatically on successful invoice
  // generation so the field disappears for the next order.
  const [invoiceDateOverride, setInvoiceDateOverride] = useState("");
  // Popover-style dialog for the optional invoice note + VAT-exemption
  // legal-basis fields. Replaces the inline inputs that were pushing the
  // "Генерирай фактура" button around.
  const [invoiceExtrasOpen, setInvoiceExtrasOpen] = useState(false);
  const [protocolDialogOpen, setProtocolDialogOpen] = useState(false);
  const [protocolPlace, setProtocolPlace] = useState("");
  const [protocolDate, setProtocolDate] = useState(
    new Date().toISOString().split("T")[0],
  );
  const [protocolSellerRep, setProtocolSellerRep] = useState("");
  const [protocolBuyerRep, setProtocolBuyerRep] = useState("");
  const [includeVat, setIncludeVat] = useState(true);
  // Payment basis printed on the invoice ("Начин на плащане:"). Defaults
  // to cash because the bulk of МЕРТ-М's orders are retail walk-ins; the
  // cashier flips to "Банков превод" / "Наложен платеж" only for the
  // minority B2B and Econt-COD cases.
  const [paymentMethod, setPaymentMethod] =
    useState<InvoicePaymentMethod>("cash");
  // Open/close state for the post-invoice payment-method dropdown.
  const [paymentMenuOpen, setPaymentMenuOpen] = useState(false);
  const paymentMenuRef = useRef<HTMLDivElement | null>(null);
  // Optional override of the buyer name on the printed invoice. Only
  // exposed when the order's partner is an individual (физ. лице). When
  // empty we fall back to partner.name server-side.
  const [clientDisplayName, setClientDisplayName] = useState("");
  const [clientDisplayEgn, setClientDisplayEgn] = useState("");
  const [clientDisplayAddress, setClientDisplayAddress] = useState("");
  // Per-line warranty selection — checkboxes rendered next to each item
  // in the order drawer. Reset to empty Set on order change so a freshly
  // opened drawer never inherits picks from the previous order.
  const [warrantyItemIds, setWarrantyItemIds] = useState<Set<number>>(
    new Set(),
  );
  const [warrantyDialogOpen, setWarrantyDialogOpen] = useState(false);
  const [warrantyBuyerName, setWarrantyBuyerName] = useState("");
  const toggleWarrantyItem = (id: number) =>
    setWarrantyItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Batch D — issue invoice in the name of a different (company) partner.
  // Only available when the order's partner is an individual. Either pick
  // an existing company partner, or supply full new-partner data — the
  // server upserts by EIK.
  const [partnerOverride, setPartnerOverride] =
    useState<PartnerOverride | null>(null);
  const [partnerOverrideOpen, setPartnerOverrideOpen] = useState(false);
  // Sub-dialog form state — reset on every open.
  const [overrideMode, setOverrideMode] = useState<
    "individual_anon" | "individual_named" | "existing" | "new"
  >("existing");
  // Local inputs for the named-individual receiver (mirror clientDisplay*,
  // but live inside the dialog so users can preview before applying).
  const [overrideIndividualName, setOverrideIndividualName] = useState("");
  const [overrideIndividualEgn, setOverrideIndividualEgn] = useState("");
  const [overrideIndividualAddress, setOverrideIndividualAddress] =
    useState("");
  const [overrideExistingId, setOverrideExistingId] = useState<number | null>(
    null,
  );
  const [newPartner, setNewPartner] = useState({
    name: "",
    eik: "",
    vat_number: "",
    address: "",
    city: "",
    contact_person: "",
    phone: "",
    email: "",
  });
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
  // Per-line selection за частично кредитно известие. Keyed по
  // order_item.id; стойността е { checked, qty }. Default state при
  // отваряне на dialog-а: всички редове checked, qty = original (full
  // КИ — backward-compat UX). Когато потребителят свали checkbox или
  // редактира qty, payload-ът включва `items[]` и backend-ът превключва
  // в partial mode.
  const [creditNoteSelection, setCreditNoteSelection] = useState<
    Record<number, { checked: boolean; qty: number }>
  >({});
  const [issuedCreditNoteId, setIssuedCreditNoteId] = useState<number | null>(
    null,
  );
  const [pendingFulfillOversell, setPendingFulfillOversell] = useState<{
    items: OversellItem[];
    proceed: () => void;
  } | null>(null);
  useEffect(() => {
    setGeneratedInvoiceId(null);
    setEditOpen(false);
    setCancelInvoiceOpen(false);
    setCancelInvoiceReason("");
    setCreditNoteOpen(false);
    setCreditNoteReason("");
    setCreditNoteRestoreStock(true);
    setCreditNoteSelection({});
    setIssuedCreditNoteId(null);
    setClientDisplayName("");
    setClientDisplayEgn("");
    setClientDisplayAddress("");
    setWarrantyItemIds(new Set());
    setWarrantyBuyerName("");
    setWarrantyDialogOpen(false);
    setInvoiceNote("");
    setVatExemptionReason("");
    setInvoiceDateOverride("");
    setPaymentMethod("cash");
    setPaymentMenuOpen(false);
    setPartnerOverride(null);
    setPartnerOverrideOpen(false);
    // Close any in-flight oversell dialog — its `proceed` closure captured
    // the previous order's id, so leaving it open would fulfill the wrong
    // order if the user confirms after switching drawers.
    setPendingFulfillOversell(null);
  }, [order?.id]);

  // Hydrate creditNoteSelection при отваряне на dialog-а: всички items
  // checked с пълно количество. Това дава "full credit note" UX по
  // подразбиране (потребителят може да свали checkbox или да редактира
  // qty за partial). Skip-ваме awaiting линиите — те още не са fulfilled
  // и не могат да бъдат сторнирани.
  useEffect(() => {
    if (!creditNoteOpen) return;
    const next: Record<number, { checked: boolean; qty: number }> = {};
    for (const it of items) {
      if ((it.line_status ?? "normal") === "awaiting") continue;
      next[it.id] = { checked: true, qty: parseFloat(String(it.quantity)) };
    }
    setCreditNoteSelection(next);
  }, [creditNoteOpen, items]);

  // Hydrate the override chip from the server-persisted value on
  // orders.invoice_partner_id, so reopening a drawer that already has an
  // override applied still shows the yellow "Фактура на: …" pill (and the
  // header amber hint). The local `partnerOverride` state is otherwise
  // reset on order id change above.
  useEffect(() => {
    if (!detail) return;
    const persisted: any = detail;
    if (
      !partnerOverride &&
      persisted.invoice_partner_id &&
      persisted.invoice_partner_name
    ) {
      setPartnerOverride({
        partner_id: persisted.invoice_partner_id,
        name: persisted.invoice_partner_name,
        eik: persisted.invoice_partner_eik ?? "",
      });
    }
    // We intentionally only react to the persisted ID — once the user
    // clears the override locally we don't want this effect to immediately
    // re-hydrate from a stale React Query cache; the mutation invalidates
    // the cache and a fresh fetch (with NULL) overrides this branch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(detail as any)?.invoice_partner_id]);

  // Reset the partner-override sub-dialog form whenever it opens, so a
  // closed-and-reopened dialog never shows stale picks. Default tab tries
  // to mirror current state: if a company override is in effect → existing
  // company tab; if a named individual is in play → individual tab; else
  // start on existing-company.
  useEffect(() => {
    if (!partnerOverrideOpen) return;
    if (partnerOverride) {
      setOverrideMode("existing");
      setOverrideExistingId(
        "partner_id" in partnerOverride ? partnerOverride.partner_id : null,
      );
    } else if (
      clientDisplayName.trim() ||
      clientDisplayEgn.trim() ||
      clientDisplayAddress.trim()
    ) {
      setOverrideMode("individual_named");
    } else {
      setOverrideMode("individual_anon");
      setOverrideExistingId(null);
    }
    setOverrideIndividualName(clientDisplayName);
    setOverrideIndividualEgn(clientDisplayEgn);
    setOverrideIndividualAddress(clientDisplayAddress);
    setNewPartner({
      name: "",
      eik: "",
      vat_number: "",
      address: "",
      city: "",
      contact_person: "",
      phone: "",
      email: "",
    });
    setEikLookupLoading(false);
    setEikAutoFilled(false);
  }, [partnerOverrideOpen]);

  // Auto-fill new partner data from the Bulgarian Trade Registry (papagal.bg)
  // whenever the user types a valid 9- or 13-digit EIK. Debounced to avoid
  // spamming the API on every keystroke.
  const [eikLookupLoading, setEikLookupLoading] = useState(false);
  const [eikAutoFilled, setEikAutoFilled] = useState(false);
  useEffect(() => {
    const eik = newPartner.eik.trim();
    if (!/^\d{9}$|^\d{13}$/.test(eik)) {
      setEikAutoFilled(false);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setEikLookupLoading(true);
      try {
        const res = await api.get(`/partners/lookup/${eik}`);
        if (cancelled) return;
        const data = res.data || {};
        setNewPartner((p) => ({
          ...p,
          name: p.name || data.name || "",
          address: p.address || data.address || "",
          city: p.city || data.city || "",
          vat_number: p.vat_number || data.vat_number || "",
          contact_person: p.contact_person || data.manager || "",
          phone: p.phone || data.phone || "",
          email: p.email || data.email || "",
        }));
        setEikAutoFilled(true);
      } catch {
        // Silent — user can fill manually
      } finally {
        if (!cancelled) setEikLookupLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [newPartner.eik]);

  // Partners catalog for the override picker. Same query key as the outer
  // page so the cache is shared (no duplicate fetch).
  const { data: overridePartners = [] } = useQuery<Partner[]>({
    queryKey: ["partners", "catalog"],
    queryFn: () =>
      api.get("/partners?catalog=true&limit=25000").then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      }),
    enabled: partnerOverrideOpen,
  });

  // Close the payment-method dropdown when clicking outside it.
  useEffect(() => {
    if (!paymentMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        paymentMenuRef.current &&
        !paymentMenuRef.current.contains(e.target as Node)
      ) {
        setPaymentMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [paymentMenuOpen]);

  // Hidden chord — press "−" then "+" within 1.5s while the order detail
  // dialog is focused (and not while typing in an input) to surface the
  // invoice-date override field next to "Генерирай фактура". Closing /
  // reopening the dialog resets it. Once the cashier picks a date and
  // generates the invoice, the field disappears automatically.
  useEffect(() => {
    if (!order) return;
    let minusAt = 0;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      if (e.key === "-") {
        minusAt = Date.now();
        return;
      }
      if (e.key === "+" || e.key === "=") {
        if (minusAt && Date.now() - minusAt < 1500) {
          minusAt = 0;
          // Default to the order's existing date so the user only needs to
          // tweak day/month rather than retype the whole thing.
          const defaultDate =
            (detail?.order_date ?? "").slice(0, 10) ||
            new Date().toISOString().slice(0, 10);
          setInvoiceDateOverride((prev) => prev || defaultDate);
        }
      } else if (e.key !== "-") {
        // Any other key cancels the chord window.
        minusAt = 0;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [order, detail?.order_date]);

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api.put(`/orders/${id}/status`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["order-detail"] });
      refetchDetail();
      toast.success("Статусът е обновен");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при обновяване на статуса",
      );
    },
  });

  // Invalidate all queries that depend on orders/invoices/stock state.
  // Any mutation that touches stock, invoices, or order status must call this
  // so every page reflects the new data (not stale cached).
  // Also forces an immediate refetch of the open drawer's detail query so
  // the UI updates without requiring the user to close + reopen.
  const invalidateAllOrderRelated = () => {
    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["order-detail"] });
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: ["unpaid-invoices"] });
    qc.invalidateQueries({ queryKey: ["inventory"] });
    qc.invalidateQueries({ queryKey: ["products"] });
    qc.invalidateQueries({ queryKey: ["partner-history"] });
    qc.invalidateQueries({ queryKey: ["partner-history-detail"] });
    refetchDetail();
  };

  const fulfillMutation = useMutation({
    mutationFn: (id: number) => api.post(`/orders/${id}/fulfill`),
    onSuccess: () => {
      invalidateAllOrderRelated();
      toast.success("Поръчката е изпълнена");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при изпълнение на поръчката",
      );
    },
  });

  function handleFulfillClick(orderId: number) {
    // Reads items from the React Query cache — stale-cache accepted per
    // spec §2 (the backend is the source of truth; this check is a soft
    // UX gate, not an enforcement barrier). Pure synchronous Map ops; no
    // awaits, nothing that can throw on realistic inputs → no try/catch.
    type FulfillItem = {
      product_id: number;
      quantity: number | string;
      total_stock?: number | string;
      name_bg?: string;
      name_en?: string;
    };
    const itemsList = (detail?.items ?? []) as unknown as FulfillItem[];

    // First pass — sum requested quantities per product_id.
    const requestedByProduct = new Map<number, number>();
    for (const it of itemsList) {
      const qty = parseFloat(String(it.quantity));
      if (!Number.isFinite(qty) || qty <= 0) continue;
      requestedByProduct.set(
        it.product_id,
        (requestedByProduct.get(it.product_id) || 0) + qty,
      );
    }

    // Second pass — one-time stock + name lookup per unique product_id.
    const stockByProduct = new Map<
      number,
      { total_stock: number; name: string }
    >();
    for (const it of itemsList) {
      if (stockByProduct.has(it.product_id)) continue;
      stockByProduct.set(it.product_id, {
        total_stock: parseFloat(String(it.total_stock ?? 0)),
        name: it.name_bg || it.name_en || `Продукт #${it.product_id}`,
      });
    }

    const oversell: OversellItem[] = [];
    for (const [productId, requested] of requestedByProduct) {
      const meta = stockByProduct.get(productId);
      if (!meta) continue;
      if (meta.total_stock - requested < 0) {
        oversell.push({
          product_name: meta.name,
          available: meta.total_stock,
          requested,
          final_stock: meta.total_stock - requested,
        });
      }
    }

    if (oversell.length > 0) {
      setPendingFulfillOversell({
        items: oversell,
        proceed: () => fulfillMutation.mutate(orderId),
      });
      return;
    }
    fulfillMutation.mutate(orderId);
  }

  const dispatchToWarehouseMutation = useMutation({
    mutationFn: (id: number) => api.post(`/orders/${id}/dispatch-to-warehouse`),
    onSuccess: () => {
      invalidateAllOrderRelated();
      toast.success("Поръчката е изпратена към склад");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при изпращане към склад",
      );
    },
  });

  // Cancel a replacement (DELETE /orders/:id) — backend reverses the
  // bidirectional stock movements and credits/debits the difference
  // payment so the till + stock state both return to pre-замяна.
  const cancelReplacementMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/orders/${id}`),
    onSuccess: () => {
      invalidateAllOrderRelated();
      toast.success("Замяната е анулирана");
      onClose();
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при анулиране на замяна",
      );
    },
  });

  // Print Стокова разписка за Замяна — fetches the PDF blob and opens it
  // in a new tab. Same flow OrderDetailModal uses for the offer PDF.
  const printReplacementRazpiska = async (orderId: number) => {
    try {
      const res = await api.get(`/orders/${orderId}/stock-dispatch-pdf`, {
        responseType: "blob",
      });
      const blob = new Blob([res.data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err: any) {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при генериране на стокова разписка",
      );
    }
  };

  const handleCancelReplacement = async (orderId: number) => {
    const ok = await confirm({
      title: "Анулирай замяна",
      description:
        "Това ще върне склада в първоначалното състояние и ще анулира платената разлика. Сигурни ли сте?",
      confirmText: "Анулирай",
      cancelText: "Отказ",
      variant: "danger",
    });
    if (!ok) return;
    cancelReplacementMutation.mutate(orderId);
  };

  const invoiceMutation = useMutation({
    mutationFn: (id: number) => {
      const payload: Record<string, unknown> = {
        order_id: id,
        include_vat: includeVat,
        payment_method: paymentMethod,
        // Batch D — when an override is set, client_display_name is mutually
        // exclusive (server-side too) — drop it so the request stays clean.
        client_display_name: partnerOverride
          ? undefined
          : clientDisplayName.trim() || undefined,
        client_display_egn: partnerOverride
          ? undefined
          : clientDisplayEgn.trim() || undefined,
        client_display_address: partnerOverride
          ? undefined
          : clientDisplayAddress.trim() || undefined,
        // Batch G+H — optional invoice extras
        invoice_note: invoiceNote.trim() || undefined,
        vat_exemption_reason: !includeVat
          ? vatExemptionReason.trim() || undefined
          : undefined,
        // Hidden "−/+" chord — backdate the invoice to a chosen date
        // without touching the sequential invoice number.
        invoice_date_override: invoiceDateOverride || undefined,
      };
      if (partnerOverride) {
        payload.partner_override =
          "partner_id" in partnerOverride
            ? { partner_id: partnerOverride.partner_id }
            : {
                name: partnerOverride.name.trim(),
                eik: partnerOverride.eik.trim(),
                vat_number: partnerOverride.vat_number?.trim() || undefined,
                address: partnerOverride.address?.trim() || undefined,
                city: partnerOverride.city?.trim() || undefined,
                contact_person:
                  partnerOverride.contact_person?.trim() || undefined,
                phone: partnerOverride.phone?.trim() || undefined,
                email: partnerOverride.email?.trim() || undefined,
              };
      }
      return api.post("/invoices", payload);
    },
    onSuccess: (res) => {
      const newInvoiceId = res.data?.id ?? null;
      setGeneratedInvoiceId(newInvoiceId);
      setPartnerOverride(null);
      // Hidden invoice-date override is per-order — once the invoice
      // is out, hide the field so the next order starts clean.
      setInvoiceDateOverride("");
      invalidateAllOrderRelated();
      // Auto-open PDF for printing immediately after generation
      if (newInvoiceId) {
        setTimeout(() => void openInvoicePdf(newInvoiceId), 300);
      }
      toast.success("Фактурата е генерирана");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при генериране на фактура",
      );
    },
  });

  const sendInvoiceEmailMutation = useMutation({
    mutationFn: (invoiceId: number) =>
      api.post(`/invoices/${invoiceId}/send-email`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["order-detail"] });
      toast.success("Фактурата е изпратена по имейл");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при изпращане на фактура",
      );
    },
  });

  // Confirm only — pending → confirmed. Fulfill happens later via the
  // warehouse flow ("Изпрати към склад" → warehouse picks → "Изпълни").
  const confirmOrderMutation = useMutation({
    mutationFn: (id: number) =>
      api.put(`/orders/${id}/status`, { status: "confirmed" }),
    onSuccess: () => {
      invalidateAllOrderRelated();
      toast.success("Статусът е обновен");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при потвърждение на поръчката",
      );
    },
  });

  // Batch D — persist the "Издай на фирма" override on the order itself
  // (PUT /orders/:id/invoice-partner). Auto-saved the moment the cashier
  // picks an override, so every transaction document (Стокова разписка,
  // Оферта, ППП, Търговски документ) and the drawer header reflect it
  // immediately — without waiting for the invoice to be created. Pass
  // `null` to clear.
  const setInvoicePartnerMutation = useMutation({
    mutationFn: ({
      orderId,
      payload,
    }: {
      orderId: number;
      payload: any | null;
    }) => api.put(`/orders/${orderId}/invoice-partner`, payload ?? {}),
    onSuccess: () => {
      invalidateAllOrderRelated();
    },
    onError: (err: any) => {
      const detail =
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        err?.message ||
        "Грешка при запис на override партньора";
      toast.error(detail);
    },
  });

  // Batch F1 + миграция 079 — line-status transitions per row (drawer).
  // Когато клиент идва за платена-невзета стока, касиерът натиска
  // "Изпрати в склад" → backend flip-ва линията към pending_pickup и
  // тя се появява в /warehouse-packing като отделна "За предаване"
  // секция. Складът физически опакова и натиска "Потвърди предаване"
  // там, което извиква /handover (финален flip към normal).
  const handoverMutation = useMutation({
    mutationFn: ({ orderId, itemId }: { orderId: number; itemId: number }) =>
      api.post(`/orders/${orderId}/items/${itemId}/send-to-warehouse`),
    onSuccess: () => {
      invalidateAllOrderRelated();
      toast.success("Изпратено към склад за предаване");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при изпращане към склад",
      );
    },
  });
  const confirmAwaitingMutation = useMutation({
    mutationFn: ({ orderId, itemId }: { orderId: number; itemId: number }) =>
      api.post(`/orders/${orderId}/items/${itemId}/confirm-from-awaiting`),
    onSuccess: () => {
      invalidateAllOrderRelated();
      toast.success("Артикулът е потвърден");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при потвърждение на артикула",
      );
    },
  });

  // Batch E — Quotation transitions. /quote moves pending → quoted (and
  // opens the offer PDF in a new tab on success). /unquote takes a quoted
  // order back to pending so the normal workflow can resume.
  const quoteMutation = useMutation({
    mutationFn: (id: number) => api.post(`/orders/${id}/quote`),
    onSuccess: (_res, id) => {
      invalidateAllOrderRelated();
      void handleDocDownload(id, "offer");
      toast.success("Офертата е генерирана");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при генериране на оферта",
      );
    },
  });

  const unquoteMutation = useMutation({
    mutationFn: (id: number) => api.post(`/orders/${id}/unquote`),
    onSuccess: () => {
      invalidateAllOrderRelated();
      toast.success("Офертата е върната към обработка");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при връщане на офертата",
      );
    },
  });

  const regenerateInvoiceMutation = useMutation({
    mutationFn: (
      input: number | { id: number; payment_method?: InvoicePaymentMethod },
    ) => {
      const id = typeof input === "number" ? input : input.id;
      const body =
        typeof input === "number" || !input.payment_method
          ? undefined
          : { payment_method: input.payment_method };
      return api.put(`/invoices/${id}/regenerate`, body);
    },
    onSuccess: () => {
      invalidateAllOrderRelated();
      toast.success("Фактурата е регенерирана");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при регенериране на фактура",
      );
    },
  });

  // Credit note (сторниране — Кредитно известие)
  const creditNoteMutation = useMutation({
    mutationFn: (data: {
      related_invoice_id: number;
      reason: string;
      include_vat?: boolean;
      restore_stock?: boolean;
      // Partial — ако присъства, КИ-то е само за избраните редове с
      // указани количества. Без `items` поведението е пълно сторниране.
      items?: Array<{ order_item_id: number; quantity: number }>;
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
      toast.success("Кредитното известие е издадено");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при издаване на кредитно известие",
      );
    },
  });

  const cancelInvoiceMutation = useMutation({
    mutationFn: (data: { id: number; reason: string }) =>
      api.post(`/invoices/${data.id}/cancel`, { reason: data.reason }),
    onSuccess: () => {
      invalidateAllOrderRelated();
      setCancelInvoiceOpen(false);
      setCancelInvoiceReason("");
      toast.success("Фактурата е анулирана");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при анулиране на фактура",
      );
    },
  });

  // DELETE — physically remove an invoice issued by mistake. Only allowed
  // before order fulfillment; after that, only annul (cancel) is legal.
  const deleteInvoiceMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/invoices/${id}`),
    onSuccess: () => {
      invalidateAllOrderRelated();
      setGeneratedInvoiceId(null);
      toast.success("Фактурата е изтрита");
    },
    onError: (err: any) => {
      const detail =
        err?.response?.data?.error ||
        err?.message ||
        "Неизвестна грешка при изтриване";
      window.alert(`Грешка: ${detail}`);
    },
  });

  // Document PDF download + print
  const handleDocDownload = async (
    orderId: number,
    docType: "stock-dispatch" | "commercial-doc" | "warranty" | "offer",
    options?: { pricingMode?: "net" | "gross"; buyerName?: string },
  ) => {
    try {
      // For invoiced orders, backend reads VAT from invoice; for fulfilled, use toggle
      const params = new URLSearchParams();
      const invoiced = detail?.invoice_id ?? generatedInvoiceId;
      if (!invoiced && !includeVat) params.set("include_vat", "false");
      if (options?.pricingMode === "gross") params.set("pricing_mode", "gross");
      if (docType === "warranty") {
        if (warrantyItemIds.size === 0) {
          toast.error(
            "Маркирайте поне един артикул с тикчето в първата колона.",
          );
          return;
        }
        params.set(
          "items",
          [...warrantyItemIds].sort((a, b) => a - b).join(","),
        );
        if (options?.buyerName) params.set("buyer_name", options.buyerName);
      }
      const queryString = params.toString();
      const vatParam = queryString ? `?${queryString}` : "";
      const res = await api.get(
        `/orders/${orderId}/${docType}-pdf${vatParam}`,
        {
          responseType: "blob",
          // Read 4xx error JSON via a fallback transformer below
          validateStatus: (s) => s >= 200 && s < 500,
        },
      );
      if (res.status >= 400) {
        // Backend returned a JSON error in a Blob — read it back, decide
        // what to do. For warranty: a missing-name error opens a dialog
        // that prompts for the buyer name and retries on submit.
        const text = await (res.data as Blob).text();
        let payload: any = {};
        try {
          payload = JSON.parse(text);
        } catch {
          /* non-JSON response */
        }
        if (
          docType === "warranty" &&
          payload?.require_buyer_name &&
          !options?.buyerName
        ) {
          setWarrantyBuyerName("");
          setWarrantyDialogOpen(true);
          return;
        }
        toast.error(payload?.error ?? "Грешка при генериране на документ");
        return;
      }
      // Stock dispatch is an A4 document — print on the regular printer
      // via the browser dialog, NOT the Zebra. The Zebra printer is
      // reserved for label-format documents (Econt waybills + warehouse
      // packing notes), wired in their own components.
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

      // Issuing a warranty stamps warranty_issued_at on the server; refresh
      // the detail so the "Гаранция №" field in the header shows up.
      if (docType === "warranty") {
        invalidateAllOrderRelated();
      }
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
  // Read the most recent value: a successful regenerate response wins over
  // the cached order detail (which may not have refetched yet), which wins
  // over the original invoice creation response, with the local toggle
  // state as a final fallback for never-invoiced orders.
  const invoicePaymentMethod = (regenerateInvoiceMutation.data?.data
    ?.payment_method ??
    (detail as any).invoice_payment_method ??
    invoiceMutation.data?.data?.payment_method ??
    paymentMethod) as InvoicePaymentMethod;

  const orderTotal = items.reduce(
    (sum, i) => sum + (i.total_price ?? i.quantity * i.unit_price),
    0,
  );
  const invoiceLabel = detail.invoice_number
    ? detail.invoice_number
    : detail.invoice_id
      ? `#${detail.invoice_id}`
      : "—";

  return (
    <>
      <Dialog open={!!order} onOpenChange={onClose} modal={false}>
        <DialogContent className="sm:max-w-[98vw] lg:max-w-[1680px] max-h-[92vh] flex flex-col">
          <DialogHeader className="shrink-0">
            <div className="flex items-start justify-between gap-3 pr-8">
              <DialogTitle className="flex items-center gap-3 flex-wrap">
                <span>Поръчка #{detail.order_number ?? detail.id}</span>
                <Badge variant={statusVariants[detail.status] ?? "secondary"}>
                  {statusLabels[detail.status] ?? detail.status}
                </Badge>
                {hasAnnulledInvoice(detail) && (
                  <Badge variant="destructive">Анулирана фактура</Badge>
                )}
              </DialogTitle>
              <div className="flex items-center gap-2 shrink-0">
                {hasInvoice && (
                  <Button
                    variant="outline"
                    size="sm"
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
                )}
                <Button variant="outline" size="sm" onClick={onClose}>
                  Затвори
                </Button>
              </div>
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto min-h-0 space-y-4 py-2 pr-1">
            {detail.is_replacement ? (
              <ReplacementDetail
                order={detail}
                onPrintRazpiska={printReplacementRazpiska}
                onSendToPacking={(id) => dispatchToWarehouseMutation.mutate(id)}
                onCancel={handleCancelReplacement}
                isBusy={
                  dispatchToWarehouseMutation.isPending ||
                  cancelReplacementMutation.isPending
                }
              />
            ) : (
              <>
                {/* Header info */}
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 bg-gray-50 rounded-lg p-4">
                  <div>
                    <div className="text-xs text-gray-500 mb-1 flex items-center gap-2">
                      <span>Партньор</span>
                      <button
                        type="button"
                        onClick={() => setPartnerOverrideOpen(true)}
                        className="text-[11px] text-blue-600 hover:text-blue-800 hover:underline"
                        title="Редакция получател — име на ФЛ или фирма"
                      >
                        📝 Редакция
                      </button>
                    </div>
                    <div className="font-medium text-sm">
                      {/* Precedence:
                      1. `partnerOverride` — local state during the invoice
                         creation flow (shown immediately as the user picks).
                      2. `invoice_partner_name` — server-side persisted
                         override exposed by GET /orders/:id once the
                         invoice has been created and is still active.
                      3. `clientDisplayName` — local state for a named
                         individual receiver (no override partner used).
                      4. Original partner. */}
                      {partnerOverride
                        ? partnerOverride.name
                        : ((detail as any).invoice_partner_name ??
                          (clientDisplayName.trim() ||
                            detail.partner?.name ||
                            detail.partner_name ||
                            `#${detail.partner_id}`))}
                    </div>
                    {partnerOverride && partnerOverride.eik ? (
                      <div className="text-[11px] text-gray-500 mt-0.5">
                        ЕИК: {partnerOverride.eik}
                      </div>
                    ) : (detail as any).invoice_partner_eik ? (
                      <div className="text-[11px] text-gray-500 mt-0.5">
                        ЕИК: {(detail as any).invoice_partner_eik}
                        <span className="ml-1 text-amber-600">
                          (издадена на фирма)
                        </span>
                      </div>
                    ) : clientDisplayName.trim() && !partnerOverride ? (
                      <div className="text-[11px] text-emerald-600 mt-0.5">
                        👤 Физическо лице с име
                      </div>
                    ) : null}
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">
                      Дата на поръчка
                    </div>
                    <div className="text-sm">
                      {formatDate(detail.order_date)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">
                      Дата на доставка
                    </div>
                    <div className="text-sm">
                      {detail.delivery_date
                        ? formatDate(detail.delivery_date)
                        : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Източник</div>
                    <Badge variant="secondary">{detail.source}</Badge>
                  </div>
                  {/* "Номер на заявка" + "Обект / магазин" intentionally
                  removed from the drawer header — МЕРТ-М doesn't issue
                  per-store requests, so both fields rendered "—" on
                  every order and just added visual noise. The data is
                  still kept on the order object for export/debug. */}
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Фактура</div>
                    <div className="text-sm">{invoiceLabel}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">
                      Дата на фактура
                    </div>
                    <div className="text-sm">
                      {detail.invoice_date
                        ? formatDate(detail.invoice_date)
                        : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Стокова №</div>
                    <div className="text-sm">
                      {detail.stock_dispatch_number || "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Гаранция №</div>
                    <div className="text-sm">
                      {detail.warranty_number || "—"}
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

                {detail && authToken && (
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <EcontShipmentActions
                        order={detail}
                        token={authToken}
                        onOrderUpdated={() => {
                          refetchDetail();
                          qc.invalidateQueries({ queryKey: ["orders"] });
                        }}
                      />
                    </div>
                    {detail.status !== "cancelled" &&
                      ((detail.status !== "fulfilled" &&
                        detail.status !== "invoiced") ||
                        canEditAfterFulfill) && (
                        <Button
                          variant="outline"
                          onClick={() => setEditOpen(true)}
                          className="shrink-0"
                        >
                          <Pencil className="h-4 w-4" />
                          Редактирай артикули
                        </Button>
                      )}
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
                        <TableHead
                          className="w-10 text-center"
                          title="Маркирай артикулите за гаранционна карта"
                        >
                          🛡
                        </TableHead>
                        <TableHead>Продукт</TableHead>
                        <TableHead className="w-24 text-right whitespace-nowrap">
                          К-во
                        </TableHead>
                        <TableHead className="w-28 text-right whitespace-nowrap">
                          Ед. цена
                        </TableHead>
                        <TableHead className="w-24 text-right whitespace-nowrap">
                          Отстъпка
                        </TableHead>
                        <TableHead className="w-28 text-right whitespace-nowrap">
                          Сума
                        </TableHead>
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
                          const discountPct = parseFloat(
                            item.discount_percent ?? 0,
                          );
                          const prodName =
                            item.product?.name_bg ||
                            item.product?.name_en ||
                            item.name_bg ||
                            item.name_en ||
                            item.product?.sku ||
                            item.sku ||
                            `Продукт #${item.product_id}`;
                          const lineStatus = item.line_status ?? "normal";
                          const rowBg =
                            lineStatus === "paid_not_taken"
                              ? "bg-amber-50"
                              : lineStatus === "awaiting"
                                ? "bg-gray-50"
                                : "";
                          return (
                            <TableRow key={item.id} className={rowBg}>
                              <TableCell className="text-center align-middle">
                                <input
                                  type="checkbox"
                                  checked={warrantyItemIds.has(item.id)}
                                  onChange={() => toggleWarrantyItem(item.id)}
                                  className="h-4 w-4 cursor-pointer accent-blue-600"
                                  title="Включи в гаранционна карта"
                                />
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  <Package className="h-4 w-4 text-gray-400 shrink-0" />
                                  <div className="min-w-0">
                                    <div className="text-sm font-medium truncate flex items-center gap-2 flex-wrap">
                                      <span>{prodName}</span>
                                      {lineStatus === "paid_not_taken" && (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 border border-amber-200 text-xs font-normal whitespace-nowrap">
                                          💰 Платена невзета
                                        </span>
                                      )}
                                      {lineStatus === "awaiting" && (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-gray-100 text-gray-700 border border-gray-200 text-xs font-normal whitespace-nowrap">
                                          ⏳ Изчакване
                                        </span>
                                      )}
                                    </div>
                                    {(item.product?.sku || item.sku) && (
                                      <div className="text-xs text-gray-400">
                                        {item.product?.sku || item.sku}
                                      </div>
                                    )}
                                    {lineStatus === "paid_not_taken" && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          handoverMutation.mutate({
                                            orderId: detail.id,
                                            itemId: item.id,
                                          })
                                        }
                                        disabled={handoverMutation.isPending}
                                        className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs border border-amber-300 text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                                        title="Изпрати към склад за финално опаковане и предаване (paid_not_taken → pending_pickup)"
                                      >
                                        📦 Изпрати в склад
                                      </button>
                                    )}
                                    {lineStatus === "pending_pickup" && (
                                      <span
                                        className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs border border-blue-300 bg-blue-50 text-blue-800"
                                        title="Изпратено към склад. Складарят ще потвърди предаването."
                                      >
                                        🟡 На склад
                                      </span>
                                    )}
                                    {lineStatus === "awaiting" && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          confirmAwaitingMutation.mutate({
                                            orderId: detail.id,
                                            itemId: item.id,
                                          })
                                        }
                                        disabled={
                                          confirmAwaitingMutation.isPending
                                        }
                                        className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs border border-gray-400 text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                                        title="Потвърди и извади от наличност (awaiting → normal). Ще откаже ако няма стока."
                                      >
                                        ✓ Потвърди
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell className="text-right text-sm">
                                {item.quantity}
                              </TableCell>
                              <TableCell className="text-right text-sm">
                                {formatCurrency(item.unit_price)}
                              </TableCell>
                              <TableCell className="text-right text-sm">
                                {discountPct > 0 ? (
                                  <span className="text-amber-600 font-medium">
                                    {discountPct
                                      .toFixed(2)
                                      .replace(/\.?0+$/, "")}
                                    %
                                  </span>
                                ) : (
                                  <span className="text-gray-300">—</span>
                                )}
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
              </>
            )}
          </div>

          {/* ── Below-cost approval audit banner ── */}
          {detail.below_cost_approved_at && (
            <div className="shrink-0 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-sm text-amber-800 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-medium">
                  Поръчка с одобрение под доставна цена
                </div>
                <div className="text-xs opacity-80">
                  Одобрена от {detail.below_cost_approved_by_name ?? "admin"} на{" "}
                  {formatDate(detail.below_cost_approved_at)}
                </div>
              </div>
            </div>
          )}

          {/* ── Workflow step indicator ── */}
          {detail.status !== "cancelled" && (
            <div className="shrink-0 border-t pt-3">
              <div className="flex items-center justify-between gap-1 mb-3 px-1">
                {[
                  { key: "pending", label: "Чакаща" },
                  { key: "confirmed", label: "Потвърдена" },
                  { key: "processing", label: "В обработка" },
                  { key: "fulfilled", label: "Изпълнена" },
                ].map((step, idx, arr) => {
                  const statusOrder = [
                    "pending",
                    "confirmed",
                    "processing",
                    "fulfilled",
                  ];
                  // Legacy "invoiced" status — treat as fulfilled for the stepper.
                  const normalizedStatus =
                    detail.status === "invoiced" ? "fulfilled" : detail.status;
                  const currentIdx = statusOrder.indexOf(normalizedStatus);
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
                                ? "bg-[#f97316] text-white ring-2 ring-[#f97316]/30"
                                : "bg-gray-200 text-gray-400"
                          }`}
                        >
                          {isDone ? "✓" : idx + 1}
                        </div>
                        <div
                          className={`text-[10px] mt-0.5 ${isCurrent ? "font-bold text-[#f97316]" : isDone ? "text-green-600" : "text-gray-400"}`}
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

            {/* Row 1 — primary workflow action */}
            <div
              className="flex flex-wrap gap-2 items-center justify-end"
              onKeyDown={arrowNavRow}
            >
              {detail.status === "pending" && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => quoteMutation.mutate(detail.id)}
                    disabled={quoteMutation.isPending}
                    className="border-amber-500 text-amber-700 hover:bg-amber-50"
                    title="Запази като оферта (без изваждане от наличности)"
                  >
                    {quoteMutation.isPending ? (
                      <Spinner size="sm" />
                    ) : (
                      <FileText className="h-4 w-4" />
                    )}
                    Генерирай оферта
                  </Button>
                  <Button
                    onClick={() => confirmOrderMutation.mutate(detail.id)}
                    disabled={confirmOrderMutation.isPending}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    {confirmOrderMutation.isPending ? (
                      <Spinner size="sm" />
                    ) : (
                      <CheckCircle className="h-4 w-4" />
                    )}
                    Потвърди поръчка
                  </Button>
                </>
              )}
              {detail.status === "quoted" && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => handleDocDownload(detail.id, "offer")}
                    className="border-amber-500 text-amber-700 hover:bg-amber-50"
                    title="Отвори / регенерирай PDF на офертата"
                  >
                    <FileText className="h-4 w-4" />
                    Регенерирай оферта
                  </Button>
                  <Button
                    onClick={() => unquoteMutation.mutate(detail.id)}
                    disabled={unquoteMutation.isPending}
                    className="bg-emerald-600 hover:bg-emerald-700"
                    title="Премини към обработка (pending → confirmed → ...)"
                  >
                    {unquoteMutation.isPending ? (
                      <Spinner size="sm" />
                    ) : (
                      <CheckCircle className="h-4 w-4" />
                    )}
                    Премини към обработка
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      statusMutation.mutate({
                        id: detail.id,
                        status: "cancelled",
                      })
                    }
                    disabled={statusMutation.isPending}
                    className="border-red-500 text-red-700 hover:bg-red-50"
                    title="Откажи офертата"
                  >
                    <XIcon className="h-4 w-4" />
                    Откажи оферта
                  </Button>
                  <span className="text-xs text-gray-500 ml-2">
                    Издадена преди{" "}
                    {Math.max(
                      0,
                      Math.floor(
                        (Date.now() -
                          new Date(
                            (detail as { updated_at?: string }).updated_at ??
                              detail.order_date,
                          ).getTime()) /
                          (1000 * 60 * 60 * 24),
                      ),
                    )}{" "}
                    дни
                  </span>
                </>
              )}
              {detail.status !== "pending" &&
                detail.status !== "cancelled" &&
                detail.status !== "quoted" &&
                (() => {
                  const dispatched = Boolean(detail.dispatched_to_warehouse_at);
                  return (
                    <Button
                      onClick={() =>
                        dispatchToWarehouseMutation.mutate(detail.id)
                      }
                      disabled={
                        dispatched || dispatchToWarehouseMutation.isPending
                      }
                      variant="outline"
                      className={
                        dispatched
                          ? "border-emerald-300 text-emerald-700 bg-emerald-50 disabled:opacity-100 disabled:cursor-default"
                          : "border-blue-600 text-blue-600 hover:bg-blue-50"
                      }
                      title={
                        dispatched
                          ? "Поръчката вече е изпратена към склад"
                          : "Уведоми склад да приготви стоката"
                      }
                    >
                      {dispatchToWarehouseMutation.isPending ? (
                        <Spinner size="sm" />
                      ) : dispatched ? (
                        <CheckCircle className="h-4 w-4" />
                      ) : (
                        <Truck className="h-4 w-4" />
                      )}
                      {dispatched ? "Изпратена към склад" : "Изпрати към склад"}
                    </Button>
                  );
                })()}
              {(detail.status === "confirmed" ||
                detail.status === "processing") && (
                <Button
                  onClick={() => handleFulfillClick(detail.id)}
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
              {detail.status !== "pending" &&
                detail.status !== "quoted" &&
                detail.status !== "cancelled" && (
                  <Button
                    variant="outline"
                    onClick={() => onRecordPayment(detail)}
                    className="border-emerald-500 text-emerald-700 hover:bg-emerald-50"
                  >
                    <CreditCard className="h-4 w-4" />
                    Запиши плащане
                  </Button>
                )}
            </div>

            {/* Row 2 — Invoice group (available from confirmed onwards) */}
            {detail.status !== "pending" && detail.status !== "cancelled" && (
              <div
                className="flex flex-wrap gap-2 items-center border-t pt-2"
                onKeyDown={arrowNavRow}
              >
                <span className="text-xs text-gray-500 uppercase tracking-wide shrink-0">
                  Фактура:
                </span>

                {/* VAT toggle / indicator — dropdown за компактност, тъй
                    като "Без ДДС" се ползва рядко. По default = С ДДС. */}
                {!hasInvoice ? (
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-lg border">
                    <span className="text-xs text-gray-500">ДДС:</span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md transition ${
                            includeVat
                              ? "bg-[#f97316] text-white hover:bg-[#ea580c]"
                              : "bg-orange-500 text-white hover:bg-orange-600"
                          }`}
                          title="Смени режим на ДДС"
                        >
                          {includeVat ? "С ДДС" : "Без ДДС"}
                          <ChevronDown className="h-3 w-3" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="start"
                        className="min-w-[120px]"
                      >
                        <DropdownMenuItem
                          onSelect={() => setIncludeVat(true)}
                          className={
                            includeVat ? "bg-[#f97316]/10 text-[#f97316]" : ""
                          }
                        >
                          С ДДС
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => setIncludeVat(false)}
                          className={
                            !includeVat ? "bg-orange-50 text-orange-700" : ""
                          }
                        >
                          Без ДДС
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-lg border">
                    <span className="text-xs text-gray-500">ДДС:</span>
                    <span
                      className={`px-2.5 py-1 text-xs font-medium rounded-md ${
                        invoiceIncludesVat !== false
                          ? "bg-[#f97316]/10 text-[#f97316] border border-[#f97316]/20"
                          : "bg-orange-50 text-orange-600 border border-orange-200"
                      }`}
                    >
                      {invoiceIncludesVat !== false ? "С ДДС" : "Без ДДС"}
                    </span>
                  </div>
                )}

                {/* Payment method — printed on the invoice as "Начин на
                    плащане". Dropdown за компактност (4 опции в pills
                    заемаха цял ред); default = "В брой". */}
                {!hasInvoice ? (
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-lg border">
                    <span className="text-xs text-gray-500">Плащане:</span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-[#f97316] text-white hover:bg-[#ea580c]"
                          title="Смени начин на плащане"
                        >
                          {INVOICE_PAYMENT_METHOD_LABELS[paymentMethod] ??
                            "Банков превод"}
                          <ChevronDown className="h-3 w-3" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="start"
                        className="min-w-[160px]"
                      >
                        {INVOICE_PAYMENT_METHOD_OPTIONS.map((opt) => {
                          const isCurrent = paymentMethod === opt.value;
                          return (
                            <DropdownMenuItem
                              key={opt.value}
                              onSelect={() => setPaymentMethod(opt.value)}
                              className={
                                isCurrent
                                  ? "bg-[#f97316]/10 text-[#f97316]"
                                  : ""
                              }
                            >
                              {opt.label}
                            </DropdownMenuItem>
                          );
                        })}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ) : (
                  <div
                    ref={paymentMenuRef}
                    className="relative flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-lg border"
                  >
                    <span className="text-xs text-gray-500">Плащане:</span>
                    <button
                      type="button"
                      disabled={
                        detail.invoice_status === "cancelled" ||
                        regenerateInvoiceMutation.isPending
                      }
                      onClick={() => setPaymentMenuOpen((v) => !v)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-[#f97316]/10 text-[#f97316] border border-[#f97316]/20 hover:bg-[#f97316]/20 disabled:opacity-60 disabled:cursor-not-allowed"
                      title="Натисни за смяна — фактурата ще се регенерира"
                    >
                      {regenerateInvoiceMutation.isPending ? (
                        <Spinner size="sm" />
                      ) : (
                        <>
                          {INVOICE_PAYMENT_METHOD_LABELS[
                            invoicePaymentMethod
                          ] ?? "Банков превод"}
                          <ChevronDown className="h-3 w-3" />
                        </>
                      )}
                    </button>
                    {paymentMenuOpen && (
                      <div className="absolute left-0 bottom-full mb-1 z-50 w-44 rounded-md border bg-white shadow-lg py-1">
                        {INVOICE_PAYMENT_METHOD_OPTIONS.map((opt) => {
                          const isCurrent = opt.value === invoicePaymentMethod;
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              disabled={isCurrent}
                              onClick={() => {
                                setPaymentMenuOpen(false);
                                if (isCurrent || !effectiveInvoiceId) return;
                                regenerateInvoiceMutation.mutate({
                                  id: effectiveInvoiceId,
                                  payment_method: opt.value,
                                });
                              }}
                              className={`w-full text-left px-3 py-1.5 text-xs ${
                                isCurrent
                                  ? "bg-[#f97316]/10 text-[#f97316] cursor-default"
                                  : "text-gray-700 hover:bg-gray-100"
                              }`}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {!hasInvoice ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      {(detail as any)?.partner_partner_type ===
                        "individual" && (
                        <Button
                          variant="outline"
                          onClick={() => setPartnerOverrideOpen(true)}
                          className="border-blue-600 text-blue-700 hover:bg-blue-50"
                        >
                          <Building2 className="h-4 w-4" />
                          {partnerOverride ? "Промени фирма" : "Издай на фирма"}
                        </Button>
                      )}
                      {invoiceDateOverride && (
                        // Hidden chord (− then +) flipped this on. Surfaces a
                        // tiny date input so the cashier can backdate the
                        // invoice without leaving the order modal. Cleared
                        // on close or after a successful generate.
                        <div className="flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                          <span>📅</span>
                          <input
                            type="date"
                            value={invoiceDateOverride}
                            onChange={(e) =>
                              setInvoiceDateOverride(e.target.value)
                            }
                            className="bg-transparent outline-none text-amber-900"
                            title="Дата на фактурата (само за тази поръчка)"
                          />
                          <button
                            type="button"
                            onClick={() => setInvoiceDateOverride("")}
                            className="text-amber-700 hover:text-amber-900"
                            title="Откажи смяна на дата"
                          >
                            ×
                          </button>
                        </div>
                      )}
                      <Button
                        onClick={() => invoiceMutation.mutate(detail.id)}
                        disabled={invoiceMutation.isPending}
                        className="bg-[#f97316] hover:bg-[#ea580c]"
                      >
                        {invoiceMutation.isPending ? (
                          <Spinner size="sm" />
                        ) : (
                          <FileText className="h-4 w-4" />
                        )}
                        Генерирай фактура {!includeVat && "(без ДДС)"}
                      </Button>
                      {/* Compact „note" button — opens the extras dialog
                          (Забележка + Основание-без-ДДС). Filled-amber when
                          either field has a value. */}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setInvoiceExtrasOpen(true)}
                        className={
                          invoiceNote || (!includeVat && vatExemptionReason)
                            ? "border-amber-500 bg-amber-50 text-amber-800 hover:bg-amber-100 px-2 relative"
                            : "border-gray-300 text-gray-600 hover:bg-gray-50 px-2"
                        }
                        title="Добави забележка / основание (по желание)"
                        aria-label="Допълнителни полета на фактурата"
                      >
                        <Pencil className="h-4 w-4" />
                        {(invoiceNote ||
                          (!includeVat && vatExemptionReason)) && (
                          <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-amber-500" />
                        )}
                      </Button>
                    </div>
                    {partnerOverride && (
                      <div className="text-xs flex items-center gap-1 px-2 py-1 rounded bg-amber-50 text-amber-800 border border-amber-200 self-start">
                        <span>
                          Фактура на: <b>{partnerOverride.name}</b> (ЕИК{" "}
                          {partnerOverride.eik})
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setPartnerOverride(null);
                            // Clear the persisted override so PDFs revert to
                            // the original individual partner immediately.
                            if (order) {
                              setInvoicePartnerMutation.mutate({
                                orderId: order.id,
                                payload: null,
                              });
                            }
                          }}
                          className="ml-1 text-amber-600 hover:text-amber-900"
                          title="Премахни"
                          aria-label="Премахни override-а"
                          disabled={setInvoicePartnerMutation.isPending}
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="inline-flex">
                      <Button
                        variant="outline"
                        onClick={() =>
                          void openInvoicePdf(effectiveInvoiceId!, 1)
                        }
                        className="border-[#f97316]/40 text-[#f97316] hover:bg-[#f97316]/5 rounded-r-none border-r-0"
                        title="Принтирай 1 копие (Оригинал)"
                      >
                        <FileText className="h-4 w-4" />
                        Отвори
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="outline"
                            className="border-[#f97316]/40 text-[#f97316] hover:bg-[#f97316]/5 rounded-l-none px-2"
                            title="Избери брой копия"
                            aria-label="Избери брой копия"
                          >
                            <ChevronDown className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() =>
                              void openInvoicePdf(effectiveInvoiceId!, 1)
                            }
                          >
                            📄 1 копие (Оригинал)
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              void openInvoicePdf(effectiveInvoiceId!, 2)
                            }
                          >
                            📄📄 2 копия (и двете Оригинал)
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        regenerateInvoiceMutation.mutate(effectiveInvoiceId!)
                      }
                      disabled={regenerateInvoiceMutation.isPending}
                      className="text-orange-600 border-orange-300 hover:bg-orange-50 px-2"
                      title="Регенерирай фактурата (пресъздай PDF)"
                      aria-label="Регенерирай фактурата"
                    >
                      <RefreshCw
                        className={`h-4 w-4 ${regenerateInvoiceMutation.isPending ? "animate-spin" : ""}`}
                      />
                    </Button>
                    <div className="ml-auto flex flex-wrap gap-2 items-center">
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
                      {/* Изтрий — само когато поръчката НЕ е изпълнена.
                          След fulfilled остава само Анулирай (правилен
                          legal flow при вече изпратени стоки). */}
                      {!detail.credit_note_id &&
                        detail.invoice_status !== "cancelled" &&
                        detail.status !== "fulfilled" &&
                        detail.status !== "invoiced" && (
                          <Button
                            variant="outline"
                            onClick={() => {
                              if (
                                window.confirm(
                                  "Сигурен ли си, че искаш да ИЗТРИЕШ фактурата? Номерът ѝ ще се освободи и ще бъде ползван за следващата.",
                                )
                              ) {
                                deleteInvoiceMutation.mutate(
                                  detail.invoice_id!,
                                );
                              }
                            }}
                            className="text-red-600 border-red-300 hover:bg-red-50"
                            title="Изтрий фактурата физически (само преди поръчката да е изпълнена). Номерът се освобождава."
                            disabled={deleteInvoiceMutation.isPending}
                          >
                            <Trash2 className="h-4 w-4" />
                            Изтрий
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
                            title="Анулирай фактурата (запазва номера и legal trail)"
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
                    </div>
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

            {/* Row 3 — Document downloads (available from confirmed onwards) */}
            {(detail.status === "confirmed" ||
              detail.status === "processing" ||
              detail.status === "fulfilled" ||
              detail.status === "invoiced") && (
              <div className="flex flex-wrap gap-2 items-center border-t pt-2">
                <span className="text-xs text-gray-500 uppercase tracking-wide shrink-0">
                  Документи:
                </span>
                <div className="inline-flex">
                  <Button
                    variant="outline"
                    onClick={() =>
                      handleDocDownload(detail.id, "stock-dispatch", {
                        pricingMode: "gross",
                      })
                    }
                    className="text-emerald-700 border-emerald-400 hover:bg-emerald-50 rounded-r-none border-r-0"
                    title="Стокова разписка с ДДС (по подразбиране)"
                  >
                    <ClipboardList className="h-4 w-4" />
                    Стокова разписка
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        className="text-emerald-700 border-emerald-400 hover:bg-emerald-50 rounded-l-none px-2"
                        title="Избери дали с или без ДДС"
                        aria-label="Избери дали с или без ДДС"
                      >
                        <ChevronDown className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem
                        onClick={() =>
                          handleDocDownload(detail.id, "stock-dispatch", {
                            pricingMode: "gross",
                          })
                        }
                      >
                        💶 Стокова разписка (с ДДС)
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() =>
                          handleDocDownload(detail.id, "stock-dispatch")
                        }
                      >
                        🧾 Стокова разписка (без ДДС)
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <Button
                  variant="outline"
                  onClick={() => {
                    // The "Оферта" button on the documents row is the
                    // single entry-point for quote mode. If the order is
                    // still warehouse-neutral (pending / confirmed /
                    // processing), POST /quote flips its status to
                    // `quoted` AND opens the PDF — that's what the
                    // backend response handler does. For statuses that
                    // can't be downgraded (fulfilled, invoiced,
                    // cancelled) we fall back to a pure PDF download so
                    // the cashier can still hand the customer an
                    // informational offer summary.
                    const QUOTABLE = ["pending", "confirmed", "processing"];
                    if (QUOTABLE.includes(detail.status)) {
                      quoteMutation.mutate(detail.id);
                    } else {
                      void handleDocDownload(detail.id, "offer");
                    }
                  }}
                  disabled={quoteMutation.isPending}
                  className="text-amber-700 border-amber-300 hover:bg-amber-50"
                  title={
                    ["pending", "confirmed", "processing"].includes(
                      detail.status,
                    )
                      ? "Прехвърли поръчката в режим 'Оферта' и принтирай"
                      : "Оферта (информационна — без задължение)"
                  }
                >
                  <FileText className="h-4 w-4" />
                  Оферта
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleDocDownload(detail.id, "warranty")}
                  className="text-amber-700 border-amber-300 hover:bg-amber-50 ml-auto mr-2"
                  title="Гаранционна карта (сериен номер = номер на поръчката)"
                >
                  <ShieldCheck className="h-4 w-4" />
                  Гаранция
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    // Pre-fill from the loaded order detail; user can override
                    // anything in the dialog before downloading.
                    setProtocolBuyerRep(
                      (detail as any)?.partner?.contact_person ?? "",
                    );
                    setProtocolDialogOpen(true);
                  }}
                  className="text-purple-700 border-purple-300 hover:bg-purple-50"
                  title="Приемо-предавателен протокол"
                >
                  <FileSignature className="h-4 w-4" />
                  Приемо-предавателен
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
            onSaved={() => {
              refetchDetail();
              invalidateAllOrderRelated();
            }}
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
                    (cancelInvoiceMutation.error as any)?.response?.data
                      ?.error || "Грешка при анулиране на фактура"
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

        {/* Credit Note (сторниране) dialog — supports partial */}
        <Dialog
          open={creditNoteOpen}
          onOpenChange={(open) => {
            setCreditNoteOpen(open);
            if (!open) setCreditNoteReason("");
          }}
        >
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Сторнирай фактура (Кредитно известие)</DialogTitle>
            </DialogHeader>
            {(() => {
              // Items за този dialog — изключваме awaiting линиите.
              const cnEligible = items.filter(
                (it) => (it.line_status ?? "normal") !== "awaiting",
              );
              const includeVat = Boolean((detail as any)?.include_vat ?? true);
              // Live preview: сума = sum(qty × unit_price). order_items
              // съхраняват unit_price като ГРОС (с ДДС включено) в
              // целия проект — invoice creation прави totalGross =
              // SUM(total_price) и нетно се изчислява чрез / 1.2.
              // Затова grossSum е директно "сума с ДДС" — НЕ добавяме
              // отново 20% (би било double VAT).
              let grossSum = 0;
              for (const it of cnEligible) {
                const sel = creditNoteSelection[it.id];
                if (!sel || !sel.checked) continue;
                const qty = Number.isFinite(sel.qty) ? sel.qty : 0;
                if (qty <= 0) continue;
                const unitPrice = parseFloat(String(it.unit_price ?? 0));
                grossSum += qty * unitPrice;
              }
              // Validation: има ли поне 1 ред със checked + qty > 0
              const hasAnySelected = cnEligible.some((it) => {
                const sel = creditNoteSelection[it.id];
                return sel && sel.checked && sel.qty > 0;
              });
              // Дали е "full" (всички items checked + full qty) → не
              // изпращаме `items` (backward-compat path в backend-а).
              const isFull = cnEligible.every((it) => {
                const sel = creditNoteSelection[it.id];
                if (!sel || !sel.checked) return false;
                const orig = parseFloat(String(it.quantity));
                return Math.abs(sel.qty - orig) < 0.0001;
              });

              const toggleAll = (checked: boolean) => {
                const next: typeof creditNoteSelection = {};
                for (const it of cnEligible) {
                  next[it.id] = {
                    checked,
                    qty: parseFloat(String(it.quantity)),
                  };
                }
                setCreditNoteSelection(next);
              };

              return (
                <div className="space-y-3">
                  <p className="text-sm text-gray-600">
                    Към фактура:{" "}
                    <span className="font-mono font-bold">{invoiceLabel}</span>
                  </p>
                  <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
                    Избери редовете за сторниране и количеството.{" "}
                    <strong>По подразбиране всички са избрани</strong> (пълно
                    КИ). За частично — свали отметката или намали qty.
                  </div>

                  {/* Items table */}
                  {cnEligible.length === 0 ? (
                    <div className="text-sm text-gray-500 italic">
                      Няма артикули за сторниране.
                    </div>
                  ) : (
                    <div className="border rounded-lg overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 border-b text-xs">
                        <button
                          type="button"
                          onClick={() => toggleAll(true)}
                          className="text-amber-700 hover:underline"
                        >
                          Избери всички
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleAll(false)}
                          className="text-gray-500 hover:underline"
                        >
                          Изчисти
                        </button>
                      </div>
                      <ul className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
                        {cnEligible.map((it) => {
                          const sel = creditNoteSelection[it.id] ?? {
                            checked: false,
                            qty: 0,
                          };
                          const orig = parseFloat(String(it.quantity));
                          const unitPrice = parseFloat(
                            String(it.unit_price ?? 0),
                          );
                          const lineTotal = sel.checked
                            ? sel.qty * unitPrice
                            : 0;
                          const prodName =
                            it.name_bg ||
                            it.product?.name_bg ||
                            it.name_en ||
                            it.product?.name_en ||
                            `Продукт #${it.product_id}`;
                          const unit = it.unit || it.product?.unit || "бр.";
                          return (
                            <li
                              key={it.id}
                              className="flex items-center gap-2 px-3 py-2 text-sm"
                            >
                              <input
                                type="checkbox"
                                checked={sel.checked}
                                onChange={(e) =>
                                  setCreditNoteSelection((prev) => ({
                                    ...prev,
                                    [it.id]: {
                                      checked: e.target.checked,
                                      qty:
                                        prev[it.id]?.qty ??
                                        parseFloat(String(it.quantity)),
                                    },
                                  }))
                                }
                                className="h-4 w-4"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="truncate">{prodName}</div>
                                <div className="text-xs text-gray-500">
                                  оригинал: {orig} {unit} ×{" "}
                                  {formatCurrency(unitPrice)}
                                </div>
                              </div>
                              <input
                                type="number"
                                min={0}
                                max={orig}
                                step="0.001"
                                value={sel.qty}
                                disabled={!sel.checked}
                                onChange={(e) => {
                                  const v = parseFloat(e.target.value);
                                  setCreditNoteSelection((prev) => ({
                                    ...prev,
                                    [it.id]: {
                                      checked: prev[it.id]?.checked ?? true,
                                      qty: Number.isFinite(v) ? v : 0,
                                    },
                                  }));
                                }}
                                className="w-20 px-2 py-1 border rounded text-right disabled:bg-gray-100 disabled:text-gray-400"
                              />
                              <span className="text-xs text-gray-400 w-8">
                                {unit}
                              </span>
                              <span className="text-right font-medium w-20 text-sm">
                                {sel.checked ? formatCurrency(lineTotal) : "—"}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  {/* Live total */}
                  <div className="flex items-center justify-end gap-4 text-sm">
                    <span className="text-gray-500">
                      Сума за кредитиране{includeVat ? " (с ДДС)" : ""}:
                    </span>
                    <span className="text-lg font-bold text-amber-700">
                      −{formatCurrency(grossSum)}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <Label>Основание за издаване *</Label>
                    <Textarea
                      value={creditNoteReason}
                      onChange={(e) => setCreditNoteReason(e.target.value)}
                      placeholder="напр. Върната стока от клиента / Грешно количество"
                      rows={2}
                    />
                  </div>
                  <label className="flex items-start gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={creditNoteRestoreStock}
                      onChange={(e) =>
                        setCreditNoteRestoreStock(e.target.checked)
                      }
                      className="mt-1"
                    />
                    <span>
                      <span className="font-medium">
                        Върни стоката в склада
                      </span>
                      <span className="block text-xs text-gray-500">
                        Маркирай, ако стоката физически е върната. За отстъпка
                        или корекция на цена — остави непроверено.
                      </span>
                    </span>
                  </label>
                  {creditNoteMutation.isError && (
                    <ErrorMessage
                      message={
                        (creditNoteMutation.error as any)?.response?.data
                          ?.error || "Грешка при издаване на Кредитно известие"
                      }
                    />
                  )}

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
                      onClick={() => {
                        if (!effectiveInvoiceId) return;
                        // Когато е full (всички checked + full qty) →
                        // изпращаме без `items` за backward-compat path.
                        // Иначе градим items[] от selection-а.
                        const partialItems = isFull
                          ? undefined
                          : cnEligible
                              .filter((it) => {
                                const sel = creditNoteSelection[it.id];
                                return sel && sel.checked && sel.qty > 0;
                              })
                              .map((it) => ({
                                order_item_id: it.id,
                                quantity: creditNoteSelection[it.id].qty,
                              }));
                        creditNoteMutation.mutate({
                          related_invoice_id: effectiveInvoiceId,
                          reason:
                            creditNoteReason.trim() || "Сторниране по искане",
                          restore_stock: creditNoteRestoreStock,
                          ...(partialItems ? { items: partialItems } : {}),
                        });
                      }}
                      disabled={creditNoteMutation.isPending || !hasAnySelected}
                      className="bg-amber-600 hover:bg-amber-700"
                    >
                      {creditNoteMutation.isPending ? (
                        <Spinner size="sm" />
                      ) : null}
                      {isFull ? "Издай Кредитно известие" : "Издай частично КИ"}
                    </Button>
                  </DialogFooter>
                </div>
              );
            })()}
          </DialogContent>
        </Dialog>
      </Dialog>
      {/* Invoice extras — popover-style dialog for the optional Забележка
          and Основание (без ДДС) fields. Triggered by the small pencil
          button next to "Генерирай фактура". */}
      <Dialog
        open={invoiceExtrasOpen}
        onOpenChange={setInvoiceExtrasOpen}
        modal={false}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Допълнително към фактурата</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">Забележка</Label>
              <Textarea
                value={invoiceNote}
                onChange={(e) => setInvoiceNote(e.target.value)}
                placeholder="напр. по проект X — отпечатва се под сумите във фактурата"
                maxLength={2000}
                rows={3}
                className="text-sm"
              />
              <div className="text-xs text-gray-500 mt-1">
                Свободен текст, до 2000 знака. По желание.
              </div>
            </div>
            {!includeVat && (
              <div>
                <Label className="text-xs text-amber-700">
                  Основание (без ДДС)
                </Label>
                <Input
                  list="vat-exemption-suggestions"
                  value={vatExemptionReason}
                  onChange={(e) => setVatExemptionReason(e.target.value)}
                  placeholder="избери или въведи свободно"
                  maxLength={500}
                  className="text-sm"
                />
                <datalist id="vat-exemption-suggestions">
                  {VAT_EXEMPTION_REASONS.map((r) => (
                    <option key={r} value={r} />
                  ))}
                </datalist>
                <div className="text-xs text-amber-700 mt-1">
                  Задължително при фактура без ДДС (legal basis).
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setInvoiceNote("");
                setVatExemptionReason("");
              }}
              title="Изчисти полетата"
            >
              Изчисти
            </Button>
            <Button onClick={() => setInvoiceExtrasOpen(false)}>Готово</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Acceptance protocol — manual override dialog before PDF download */}
      <Dialog
        open={protocolDialogOpen}
        onOpenChange={setProtocolDialogOpen}
        modal={false}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Приемо-предавателен протокол</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">Място</Label>
              <Input
                value={protocolPlace}
                onChange={(e) => setProtocolPlace(e.target.value)}
                placeholder="напр. София (default: фирмен град)"
              />
            </div>
            <div>
              <Label className="text-xs">Дата</Label>
              <Input
                type="date"
                value={protocolDate}
                onChange={(e) => setProtocolDate(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Продавач — представител</Label>
              <Input
                value={protocolSellerRep}
                onChange={(e) => setProtocolSellerRep(e.target.value)}
                placeholder="default: МОЛ от настройки"
              />
            </div>
            <div>
              <Label className="text-xs">Купувач — представител</Label>
              <Input
                value={protocolBuyerRep}
                onChange={(e) => setProtocolBuyerRep(e.target.value)}
                placeholder="default: лице за контакт от партньора"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setProtocolDialogOpen(false)}
            >
              Отказ
            </Button>
            <Button
              onClick={async () => {
                if (!detail) return;
                const params = new URLSearchParams();
                if (protocolPlace.trim())
                  params.set("place", protocolPlace.trim());
                if (protocolDate) params.set("date", protocolDate);
                if (protocolSellerRep.trim())
                  params.set("seller_rep", protocolSellerRep.trim());
                if (protocolBuyerRep.trim())
                  params.set("buyer_rep", protocolBuyerRep.trim());
                const qs = params.toString();
                try {
                  // Fetch as blob via the api wrapper (carries the JWT) —
                  // window.open on the raw URL fails with 401 because the
                  // browser strips the Authorization header on cross-context
                  // navigation.
                  const res = await api.get(
                    `/orders/${detail.id}/protocol-pdf${qs ? "?" + qs : ""}`,
                    { responseType: "blob" },
                  );
                  const blob = new Blob([res.data], {
                    type: "application/pdf",
                  });
                  const url = URL.createObjectURL(blob);
                  window.open(url, "_blank");
                  setTimeout(() => URL.revokeObjectURL(url), 60000);
                } catch (err: any) {
                  toast.error(
                    err?.response?.data?.error ||
                      "Грешка при сваляне на протокола",
                  );
                }
                setProtocolDialogOpen(false);
              }}
              className="bg-purple-600 hover:bg-purple-700"
            >
              <FileSignature className="h-4 w-4" />
              Свали PDF
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <OversellConfirmDialog
        open={!!pendingFulfillOversell}
        items={pendingFulfillOversell?.items ?? []}
        onCancel={() => setPendingFulfillOversell(null)}
        onConfirm={() => {
          const proceed = pendingFulfillOversell?.proceed;
          setPendingFulfillOversell(null);
          proceed?.();
        }}
      />

      {/* Batch D — partner override sub-dialog */}
      <Dialog open={partnerOverrideOpen} onOpenChange={setPartnerOverrideOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Редакция получател</DialogTitle>
          </DialogHeader>

          {hasInvoice && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
              ⚠ Поръчката вече има фактура. Промените тук НЕ се прилагат
              автоматично върху съществуващата фактура. За да се отрази, изтрий
              фактурата (или анулирай) и я регенерирай.
            </div>
          )}

          <div className="flex gap-2 flex-wrap">
            <Button
              size="sm"
              variant={
                overrideMode === "individual_anon" ? "default" : "outline"
              }
              onClick={() => setOverrideMode("individual_anon")}
            >
              👤 Анонимно ФЛ
            </Button>
            <Button
              size="sm"
              variant={
                overrideMode === "individual_named" ? "default" : "outline"
              }
              onClick={() => setOverrideMode("individual_named")}
            >
              👤 ФЛ с данни
            </Button>
            <Button
              size="sm"
              variant={overrideMode === "existing" ? "default" : "outline"}
              onClick={() => setOverrideMode("existing")}
            >
              🏢 Съществуваща фирма
            </Button>
            <Button
              size="sm"
              variant={overrideMode === "new" ? "default" : "outline"}
              onClick={() => setOverrideMode("new")}
            >
              + Нова фирма
            </Button>
          </div>

          {overrideMode === "individual_anon" ? (
            <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
              👤 Фактурата ще бъде издадена на „Физическо лице — краен
              потребител" без лични данни.
            </div>
          ) : overrideMode === "individual_named" ? (
            <div className="space-y-2">
              <div>
                <Label>Име *</Label>
                <Input
                  autoFocus
                  value={overrideIndividualName}
                  onChange={(e) => setOverrideIndividualName(e.target.value)}
                  placeholder="напр. Иван Иванов"
                />
              </div>
              <div>
                <Label>ЕГН</Label>
                <Input
                  value={overrideIndividualEgn}
                  onChange={(e) => setOverrideIndividualEgn(e.target.value)}
                  placeholder="напр. 8501010000"
                  maxLength={20}
                />
              </div>
              <div>
                <Label>Адрес</Label>
                <Input
                  value={overrideIndividualAddress}
                  onChange={(e) => setOverrideIndividualAddress(e.target.value)}
                  placeholder={`напр. гр. София, ул. „Витоша" 25`}
                />
              </div>
              <p className="text-[11px] text-gray-500 mt-1">
                Данните се записват на фактурата като „Получател". Партньор в
                базата НЕ се създава — за разово фактуриране на ФЛ.
              </p>
            </div>
          ) : overrideMode === "existing" ? (
            <div>
              <Label>Партньор</Label>
              <Combobox
                items={overridePartners
                  .filter((p) => (p as any).partner_type !== "individual")
                  .map((p) => ({
                    value: String(p.id),
                    label: p.name,
                    hint: p.eik ? `ЕИК: ${p.eik}` : undefined,
                  }))}
                value={
                  overrideExistingId != null ? String(overrideExistingId) : ""
                }
                onChange={(v) => setOverrideExistingId(v ? Number(v) : null)}
                placeholder="Търси по име или ЕИК"
              />
            </div>
          ) : (
            <div className="space-y-2">
              <div>
                <Label>Име *</Label>
                <Input
                  value={newPartner.name}
                  onChange={(e) =>
                    setNewPartner((p) => ({ ...p, name: e.target.value }))
                  }
                  placeholder="напр. Фирма Х ЕООД"
                />
              </div>
              <div>
                <Label>ЕИК *</Label>
                <Input
                  value={newPartner.eik}
                  onChange={(e) =>
                    setNewPartner((p) => ({ ...p, eik: e.target.value }))
                  }
                  placeholder="9–13 цифри (автоматично попълва от Търговски регистър)"
                />
                {eikLookupLoading && (
                  <p className="text-[11px] text-blue-600 mt-1">
                    🔎 Търся фирмата в Търговски регистър...
                  </p>
                )}
                {eikAutoFilled && !eikLookupLoading && (
                  <p className="text-[11px] text-emerald-600 mt-1">
                    ✓ Данните са попълнени автоматично от Търговски регистър
                  </p>
                )}
              </div>
              <div>
                <Label>ДДС №</Label>
                <Input
                  value={newPartner.vat_number}
                  onChange={(e) =>
                    setNewPartner((p) => ({
                      ...p,
                      vat_number: e.target.value,
                    }))
                  }
                />
              </div>
              <div>
                <Label>Адрес</Label>
                <Input
                  value={newPartner.address}
                  onChange={(e) =>
                    setNewPartner((p) => ({
                      ...p,
                      address: e.target.value,
                    }))
                  }
                />
              </div>
              <div>
                <Label>Град</Label>
                <Input
                  value={newPartner.city}
                  onChange={(e) =>
                    setNewPartner((p) => ({ ...p, city: e.target.value }))
                  }
                />
              </div>
              <div>
                <Label>МОЛ</Label>
                <Input
                  value={newPartner.contact_person}
                  placeholder="Управител / материално отговорно лице"
                  onChange={(e) =>
                    setNewPartner((p) => ({
                      ...p,
                      contact_person: e.target.value,
                    }))
                  }
                />
              </div>
              <div>
                <Label>Телефон</Label>
                <Input
                  value={newPartner.phone}
                  onChange={(e) =>
                    setNewPartner((p) => ({
                      ...p,
                      phone: e.target.value,
                    }))
                  }
                />
              </div>
              <div>
                <Label>Имейл</Label>
                <Input
                  type="email"
                  value={newPartner.email}
                  onChange={(e) =>
                    setNewPartner((p) => ({
                      ...p,
                      email: e.target.value,
                    }))
                  }
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPartnerOverrideOpen(false)}
            >
              Отказ
            </Button>
            <Button
              onClick={() => {
                if (!order) return;
                if (overrideMode === "individual_anon") {
                  // Anonymous individual — clear everything that would
                  // override the default "Физическо лице — краен потребител".
                  setPartnerOverride(null);
                  setClientDisplayName("");
                  setClientDisplayEgn("");
                  setClientDisplayAddress("");
                  setInvoicePartnerMutation.mutate({
                    orderId: order.id,
                    payload: null,
                  });
                  setPartnerOverrideOpen(false);
                  return;
                }
                if (overrideMode === "individual_named") {
                  // Named individual: clear company override, save the
                  // free-text name/EGN/address locally; consumed at invoice
                  // generation via `client_display_*` fields.
                  if (!overrideIndividualName.trim()) {
                    toast.error("Името е задължително");
                    return;
                  }
                  setPartnerOverride(null);
                  setClientDisplayName(overrideIndividualName.trim());
                  setClientDisplayEgn(overrideIndividualEgn.trim());
                  setClientDisplayAddress(overrideIndividualAddress.trim());
                  setInvoicePartnerMutation.mutate({
                    orderId: order.id,
                    payload: null,
                  });
                  setPartnerOverrideOpen(false);
                  return;
                }
                let payload: any = null;
                if (overrideMode === "existing") {
                  const picked = overridePartners.find(
                    (p) => p.id === overrideExistingId,
                  );
                  if (!picked) return;
                  setPartnerOverride({
                    partner_id: picked.id,
                    name: picked.name,
                    eik: picked.eik,
                  });
                  payload = { partner_id: picked.id };
                } else {
                  if (!newPartner.name.trim() || !newPartner.eik.trim()) return;
                  setPartnerOverride({ ...newPartner });
                  // Strip empty optionals so the server doesn't get blank strings.
                  payload = Object.fromEntries(
                    Object.entries(newPartner).filter(
                      ([, v]) => typeof v === "string" && v.trim().length > 0,
                    ),
                  );
                }
                // Switching to a company override clears any named-individual
                // intent — the two are mutually exclusive on the invoice.
                setClientDisplayName("");
                setClientDisplayEgn("");
                setClientDisplayAddress("");
                // Persist on the order so every document picks it up.
                setInvoicePartnerMutation.mutate({
                  orderId: order.id,
                  payload,
                });
                setPartnerOverrideOpen(false);
              }}
            >
              Запази
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Warranty buyer-name prompt — opens when the backend tells us
          the order can't auto-resolve a buyer (anonymous individual,
          no client_display_name, no invoice override). The cashier
          types the buyer name once and the warranty PDF re-fetches. */}
      <Dialog
        open={warrantyDialogOpen}
        onOpenChange={(o) => {
          setWarrantyDialogOpen(o);
          if (!o) setWarrantyBuyerName("");
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Име на купувача за гаранцията</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-xs text-gray-500">
              Поръчката е на анонимно физическо лице — гаранцията се издава на
              конкретно име. Името се вписва само върху тази гаранционна карта
              (не се записва на партньора).
            </p>
            <div>
              <Label>Име на купувача *</Label>
              <Input
                autoFocus
                value={warrantyBuyerName}
                onChange={(e) => setWarrantyBuyerName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && warrantyBuyerName.trim()) {
                    e.preventDefault();
                    setWarrantyDialogOpen(false);
                    handleDocDownload(detail!.id, "warranty", {
                      buyerName: warrantyBuyerName.trim(),
                    });
                  }
                }}
                placeholder="напр. Иван Петров Иванов"
              />
            </div>
            <p className="text-[11px] text-gray-500">
              Маркирани {warrantyItemIds.size}{" "}
              {warrantyItemIds.size === 1 ? "артикул" : "артикула"} за гаранция.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setWarrantyDialogOpen(false);
                setWarrantyBuyerName("");
              }}
            >
              Отказ
            </Button>
            <Button
              onClick={() => {
                if (!warrantyBuyerName.trim() || !detail) return;
                setWarrantyDialogOpen(false);
                handleDocDownload(detail.id, "warranty", {
                  buyerName: warrantyBuyerName.trim(),
                });
              }}
              disabled={!warrantyBuyerName.trim()}
            >
              Издай гаранция
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Edit Order Items Modal                                             */
/* ------------------------------------------------------------------ */
function EditOrderItemsModal({
  open,
  onClose,
  order,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  order: Order;
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const { hasPermission } = usePermissions();
  const canOverrideBelowCost = hasPermission(PERMISSIONS.BELOW_COST_OVERRIDE);
  const [deliveryDate, setDeliveryDate] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<OrderItemRow[]>([emptyItem()]);
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  // Глобалната отстъпка може да се въвежда или като процент, или като
  // фиксирана сума (€). Касиерът обикновено мисли в "колко да му сваля
  // от сметката" — например клиент с обща сума 1080 € иска 81 € отстъпка.
  // Пресмятаме процента: 81 / 1080 = 7.5%, и го прилагаме на всички
  // редове чрез "Приложи на всички". `bulkDiscount` е каноничното
  // състояние (процент) — `bulkDiscountAmount` е derived от него спрямо
  // нетния pre-discount total на order-а.
  const [bulkDiscount, setBulkDiscount] = useState("");
  const [bulkDiscountAmount, setBulkDiscountAmount] = useState("");

  const applyBulkDiscount = () => {
    const v = parseFloat(bulkDiscount);
    if (!Number.isFinite(v) || v < 0 || v > 100) return;
    setItems((prev) =>
      prev.map((it) =>
        it.product_id ? { ...it, discount_percent: bulkDiscount } : it,
      ),
    );
  };

  // Keyboard refs + arrow navigation — same pattern като в CreateOrderModal.
  // Виж там подробен коментар.
  const editQtyRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const editKgRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const editPriceRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const editDiscountRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const editSubmitBtnRef = useRef<HTMLButtonElement | null>(null);
  const editFocusAndSelect = (el: HTMLInputElement | null) => {
    if (!el) return;
    el.focus();
    try {
      el.select();
    } catch {
      /* ignore */
    }
  };
  type EditCol = "qty" | "kg" | "price" | "discount";
  const EDIT_COLS: EditCol[] = ["qty", "kg", "price", "discount"];
  const editFocusCell = (rowIdx: number, col: EditCol): boolean => {
    const row = items[rowIdx];
    if (!row) return false;
    const refs = {
      qty: editQtyRefs,
      kg: editKgRefs,
      price: editPriceRefs,
      discount: editDiscountRefs,
    }[col];
    const el = refs.current[row.row_key];
    if (!el) return false;
    editFocusAndSelect(el);
    return true;
  };
  const handleEditCellArrowKey = (
    e: React.KeyboardEvent<HTMLInputElement>,
    rowIdx: number,
    col: EditCol,
  ): boolean => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (rowIdx > 0) editFocusCell(rowIdx - 1, col);
      return true;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!editFocusCell(rowIdx + 1, col)) {
        editSubmitBtnRef.current?.focus();
      }
      return true;
    }
    if (e.key === "ArrowLeft") {
      const t = e.currentTarget;
      if (t.selectionStart && t.selectionStart > 0) return false;
      e.preventDefault();
      const idx = EDIT_COLS.indexOf(col);
      if (idx > 0) editFocusCell(rowIdx, EDIT_COLS[idx - 1]);
      return true;
    }
    if (e.key === "ArrowRight") {
      const t = e.currentTarget;
      const len = (t.value ?? "").length;
      if (t.selectionEnd != null && t.selectionEnd < len) return false;
      e.preventDefault();
      const idx = EDIT_COLS.indexOf(col);
      if (idx < EDIT_COLS.length - 1) editFocusCell(rowIdx, EDIT_COLS[idx + 1]);
      return true;
    }
    return false;
  };

  useEffect(() => {
    if (!open) return;

    setDeliveryDate(order.delivery_date?.split("T")[0] || "");
    setNotes(order.notes || "");

    const mappedItems =
      order.items?.map((item) => {
        const rawW =
          (item as any).weight_kg ?? (item as any).product?.weight_kg ?? null;
        const w = rawW != null ? parseFloat(String(rawW)) : NaN;
        const productWeight = Number.isFinite(w) && w > 0 ? w : null;
        const rawCost = (item as any).purchase_price;
        const costNum = rawCost != null ? parseFloat(String(rawCost)) : NaN;
        return makeOrderItemRow({
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
          weight_kg: productWeight != null ? String(productWeight) : "",
          original_weight_kg: productWeight,
          cost_price: Number.isFinite(costNum) && costNum > 0 ? costNum : 0,
          line_status: (item.line_status ?? "normal") as
            | "normal"
            | "paid_not_taken"
            | "awaiting",
        });
      }) || [];

    setItems(mappedItems.length > 0 ? mappedItems : [emptyItem()]);
    setErrorMsg("");
    setSuccessMsg("");
    // Reset bulk-discount inputs — иначе попълнените стойности от
    // предишно отваряне остават залепнали в полетата.
    setBulkDiscount("");
    setBulkDiscountAmount("");
  }, [open, order]);

  const handleProductSelect = useCallback(
    (idx: number, product: OrderProduct) => {
      const rawPrice =
        product.partner_price ?? product.group_price ?? product.selling_price;
      const price = rawPrice != null ? parseFloat(String(rawPrice)) : null;
      const stock = parseFloat(String(product.total_stock || 0));
      const wRaw =
        product.weight_kg != null ? parseFloat(String(product.weight_kg)) : NaN;
      const productWeight = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : null;
      const costRaw =
        product.purchase_price != null
          ? parseFloat(String(product.purchase_price))
          : NaN;
      const cost = Number.isFinite(costRaw) && costRaw > 0 ? costRaw : 0;
      setItems((prev) =>
        prev.map((item, i) =>
          i === idx
            ? {
                ...item,
                product_id: String(product.id),
                product_name: product.name_bg || product.name_en || "Без име",
                quantity: item.quantity || "1",
                unit_price:
                  item.unit_price || (price != null ? String(price) : ""),
                unit: product.unit || "бр.",
                stock,
                weight_kg: productWeight != null ? String(productWeight) : "",
                original_weight_kg: productWeight,
                cost_price: cost,
              }
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
  // Batch F1 — only NORMAL lines participate in the oversell guard.
  // paid_not_taken / awaiting lines are explicit opt-outs (the cashier
  // already chose to split or pre-order them), so they never block save.
  const oversellNormalItems = validItems.filter(
    (i) =>
      i.line_status === "normal" &&
      getEffectiveStock(i) >= 0 &&
      Number(i.quantity) > getEffectiveStock(i),
  );
  const hasStockIssues = oversellNormalItems.length > 0;

  // Split a normal-status line that's gone over stock into two rows:
  //   - the original kept at the available stock (still 'normal')
  //   - a new row carrying the overage with the chosen line_status
  // No-op when the line is already within stock or already non-normal.
  const splitOversellLine = (
    rowKey: string,
    target: "paid_not_taken" | "awaiting",
  ) => {
    setItems((prev) => {
      const idx = prev.findIndex((r) => r.row_key === rowKey);
      if (idx < 0) return prev;
      const orig = prev[idx];
      if (orig.line_status !== "normal") return prev;
      const available = getEffectiveStock(orig);
      const requested = Number(orig.quantity);
      if (!(available >= 0) || requested <= available) return prev;
      const overage = requested - available;
      const taken: OrderItemRow = { ...orig, quantity: String(available) };
      const pending: OrderItemRow = makeOrderItemRow({
        product_id: orig.product_id,
        product_name: orig.product_name,
        quantity: String(overage),
        unit_price: orig.unit_price,
        discount_percent: orig.discount_percent,
        unit: orig.unit,
        stock: orig.stock,
        cost_price: orig.cost_price,
        weight_kg: orig.weight_kg,
        original_weight_kg: orig.original_weight_kg,
        line_status: target,
      });
      return [...prev.slice(0, idx), taken, pending, ...prev.slice(idx + 1)];
    });
  };

  // Per-row status setter, mirrors CreateOrderModal so the cashier can
  // flip a line to 'paid_not_taken' / 'awaiting' / 'normal' on an
  // already-created order. The split-on-overage rule applies only to
  // paid_not_taken with stock > 0; awaiting always flips the whole row
  // since the entire qty is waiting on stock arrival.
  const setLineStatus = (
    rowKey: string,
    target: "normal" | "paid_not_taken" | "awaiting",
  ) => {
    setItems((prev) => {
      const idx = prev.findIndex((r) => r.row_key === rowKey);
      if (idx < 0) return prev;
      const orig = prev[idx];
      if (
        target === "normal" ||
        target === "awaiting" ||
        orig.line_status !== "normal"
      ) {
        return prev.map((r) =>
          r.row_key === rowKey ? { ...r, line_status: target } : r,
        );
      }
      const available = getEffectiveStock(orig);
      const requested = Number(orig.quantity);
      const isOverage = available > 0 && requested > available;
      if (!isOverage) {
        return prev.map((r) =>
          r.row_key === rowKey ? { ...r, line_status: target } : r,
        );
      }
      const overage = requested - available;
      const taken: OrderItemRow = { ...orig, quantity: String(available) };
      const pending: OrderItemRow = makeOrderItemRow({
        product_id: orig.product_id,
        product_name: orig.product_name,
        quantity: String(overage),
        unit_price: orig.unit_price,
        discount_percent: orig.discount_percent,
        unit: orig.unit,
        stock: orig.stock,
        cost_price: orig.cost_price,
        weight_kg: orig.weight_kg,
        original_weight_kg: orig.original_weight_kg,
        line_status: target,
      });
      return [...prev.slice(0, idx), taken, pending, ...prev.slice(idx + 1)];
    });
  };

  // Reduce-to-available — the simple "no, just sell what we have" path.
  const reduceToAvailable = (rowKey: string) => {
    setItems((prev) =>
      prev.map((r) => {
        if (r.row_key !== rowKey) return r;
        const available = getEffectiveStock(r);
        if (!(available >= 0)) return r;
        return { ...r, quantity: String(available) };
      }),
    );
  };

  const belowCostItems = validItems.filter((i) => {
    const disc = Number(i.discount_percent) || 0;
    const effectivePrice = Number(i.unit_price) * (1 - disc / 100);
    return (
      i.cost_price > 0 && effectivePrice > 0 && effectivePrice < i.cost_price
    );
  });
  const hasBelowCost = belowCostItems.length > 0;
  const totalBelowCostLoss = belowCostItems.reduce((sum, i) => {
    const qty = Number(i.quantity) || 0;
    return sum + (i.cost_price - Number(i.unit_price)) * qty;
  }, 0);

  const mutation = useMutation({
    mutationFn: async (vars: { allow_below_cost?: boolean } = {}) => {
      const res = await api.put(`/orders/${order.id}`, {
        delivery_date: deliveryDate || undefined,
        notes: notes || undefined,
        items: validItems.map((i) => ({
          product_id: Number(i.product_id),
          quantity: Number(i.quantity),
          unit_price: Number(i.unit_price),
          discount_percent: Number(i.discount_percent) || 0,
          // Batch F1 — only send when not the default; spares the wire
          // and lets the backend's column DEFAULT 'normal' handle it.
          line_status: i.line_status !== "normal" ? i.line_status : undefined,
        })),
        allow_below_cost: vars.allow_below_cost === true ? true : undefined,
      });

      // Persist edited weights back to the product catalog.
      const weightUpdates = validItems
        .map((i) => {
          const w = Number(i.weight_kg);
          if (!Number.isFinite(w) || w <= 0) return null;
          if (
            i.original_weight_kg != null &&
            Math.abs(w - i.original_weight_kg) < 0.001
          )
            return null;
          return { id: Number(i.product_id), weight_kg: w };
        })
        .filter((u): u is { id: number; weight_kg: number } => u !== null);
      if (weightUpdates.length > 0) {
        await Promise.allSettled(
          weightUpdates.map((u) =>
            api.put(`/products/${u.id}`, { weight_kg: u.weight_kg }),
          ),
        );
        qc.invalidateQueries({ queryKey: ["products"] });
      }
      return res;
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["order-detail", order.id] });
      qc.invalidateQueries({ queryKey: ["order-detail"] });
      // Tell the parent drawer to refetch its detail query immediately so
      // the items list refreshes without having to close + reopen.
      onSaved?.();

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

  const submitEdit = async () => {
    setErrorMsg("");
    if (hasBelowCost) {
      if (!canOverrideBelowCost) {
        setErrorMsg(
          "Има артикули под доставна цена. Свържи се с admin за одобрение.",
        );
        return;
      }
      const ok = await confirm({
        title: "Продажба под доставна цена",
        description: `${belowCostItems.length} артикул(а) са под доставна цена. Обща загуба: ${formatCurrency(totalBelowCostLoss)}. Сигурен ли си?`,
        confirmText: "Разреши",
        cancelText: "Отказ",
        variant: "danger",
      });
      if (!ok) return;
    }
    mutation.mutate({ allow_below_cost: hasBelowCost });
  };

  return (
    <Dialog open={open} onOpenChange={onClose} modal={false}>
      <DialogContent className="sm:max-w-[98vw] lg:max-w-[1680px] max-h-[92vh] flex flex-col border-2 border-[#f97316] shadow-[0_0_0_1px_rgba(249,115,22,0.25)]">
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
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <Label>Артикули</Label>
              <div className="flex items-center gap-2">
                <Label
                  htmlFor="bulk-discount-edit"
                  className="text-sm font-normal text-gray-600"
                >
                  Обща отстъпка %:
                </Label>
                <Input
                  id="bulk-discount-edit"
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  value={bulkDiscount}
                  onChange={(e) => {
                    const v = e.target.value;
                    setBulkDiscount(v);
                    const gross = items.reduce(
                      (sum, it) =>
                        sum +
                        Number(it.quantity || 0) * Number(it.unit_price || 0),
                      0,
                    );
                    const pct = parseFloat(v);
                    if (!Number.isFinite(pct) || v === "" || gross <= 0) {
                      setBulkDiscountAmount("");
                    } else {
                      setBulkDiscountAmount(((gross * pct) / 100).toFixed(2));
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      applyBulkDiscount();
                    }
                  }}
                  placeholder="0"
                  className="w-20"
                />
                <Label
                  htmlFor="bulk-discount-amt-edit"
                  className="text-sm font-normal text-gray-600"
                >
                  или €:
                </Label>
                <Input
                  id="bulk-discount-amt-edit"
                  type="number"
                  step="0.01"
                  min="0"
                  value={bulkDiscountAmount}
                  onChange={(e) => {
                    const v = e.target.value;
                    setBulkDiscountAmount(v);
                    const gross = items.reduce(
                      (sum, it) =>
                        sum +
                        Number(it.quantity || 0) * Number(it.unit_price || 0),
                      0,
                    );
                    const amt = parseFloat(v);
                    if (!Number.isFinite(amt) || v === "" || gross <= 0) {
                      setBulkDiscount("");
                    } else {
                      const pct = Math.min(
                        100,
                        Math.max(0, (amt / gross) * 100),
                      );
                      setBulkDiscount(String(parseFloat(pct.toFixed(4))));
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      applyBulkDiscount();
                    }
                  }}
                  placeholder="0.00"
                  className="w-24"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={applyBulkDiscount}
                  disabled={
                    bulkDiscount === "" ||
                    !Number.isFinite(parseFloat(bulkDiscount)) ||
                    parseFloat(bulkDiscount) < 0 ||
                    parseFloat(bulkDiscount) > 100
                  }
                >
                  Приложи на всички
                </Button>
              </div>
            </div>
            <div className="border rounded-lg overflow-x-auto">
              <Table className="min-w-[1000px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[320px]">Продукт</TableHead>
                    <TableHead className="w-24">Наличност</TableHead>
                    <TableHead className="w-28">Количество</TableHead>
                    <TableHead className="w-24">Кг</TableHead>
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
                    // Batch F1 — split rows opt out of the oversell guard
                    // (their whole purpose is to carry the overage). Only
                    // 'normal' lines get the red bg.
                    const overStock =
                      item.line_status === "normal" &&
                      hasKnownStock &&
                      qty > availableStock;
                    const rowBg =
                      item.line_status === "paid_not_taken"
                        ? "bg-amber-50"
                        : item.line_status === "awaiting"
                          ? "bg-gray-50"
                          : overStock
                            ? "bg-red-50"
                            : "";
                    return (
                      <TableRow key={item.row_key} className={rowBg}>
                        <TableCell>
                          {item.product_id ? (
                            <div className="flex items-center gap-2">
                              <Package className="h-4 w-4 text-gray-400 shrink-0" />
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium truncate flex items-center gap-2 flex-wrap">
                                  <span>{item.product_name}</span>
                                  {item.line_status === "paid_not_taken" && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 border border-amber-200 text-xs font-normal whitespace-nowrap">
                                      💰 Платена невзета
                                    </span>
                                  )}
                                  {item.line_status === "awaiting" && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-gray-100 text-gray-700 border border-gray-200 text-xs font-normal whitespace-nowrap">
                                      ⏳ Изчакване
                                    </span>
                                  )}
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
                            ref={(el) => {
                              editQtyRefs.current[item.row_key] = el;
                            }}
                            type="number"
                            min="0.001"
                            step="0.001"
                            value={item.quantity}
                            onChange={(e) =>
                              setItem(i, "quantity", e.target.value)
                            }
                            onKeyDown={(e) =>
                              handleEditCellArrowKey(e, i, "qty")
                            }
                            disabled={!item.product_id}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            ref={(el) => {
                              editKgRefs.current[item.row_key] = el;
                            }}
                            type="number"
                            step="0.01"
                            min="0"
                            value={item.weight_kg}
                            onChange={(e) =>
                              setItem(i, "weight_kg", e.target.value)
                            }
                            onKeyDown={(e) =>
                              handleEditCellArrowKey(e, i, "kg")
                            }
                            className="w-20"
                            disabled={!item.product_id}
                            placeholder="0"
                            title="Тегло (кг)"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            ref={(el) => {
                              editPriceRefs.current[item.row_key] = el;
                            }}
                            type="number"
                            step="0.01"
                            min="0"
                            value={item.unit_price}
                            onChange={(e) =>
                              setItem(i, "unit_price", e.target.value)
                            }
                            onKeyDown={(e) =>
                              handleEditCellArrowKey(e, i, "price")
                            }
                            disabled={!item.product_id}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            ref={(el) => {
                              editDiscountRefs.current[item.row_key] = el;
                            }}
                            type="number"
                            step="0.1"
                            min="0"
                            max="100"
                            value={item.discount_percent}
                            onChange={(e) =>
                              setItem(i, "discount_percent", e.target.value)
                            }
                            onKeyDown={(e) =>
                              handleEditCellArrowKey(e, i, "discount")
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
                          <div className="flex items-center gap-1">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  disabled={!item.product_id}
                                  className={`p-1 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                                    item.line_status === "paid_not_taken"
                                      ? "text-amber-600 hover:bg-amber-100"
                                      : item.line_status === "awaiting"
                                        ? "text-gray-600 hover:bg-gray-100"
                                        : "text-gray-300 hover:text-gray-600 hover:bg-gray-50"
                                  }`}
                                  title="Маркирай реда като платена невзета или на изчакване"
                                >
                                  {item.line_status === "paid_not_taken" ? (
                                    <span className="text-base leading-none">
                                      💰
                                    </span>
                                  ) : item.line_status === "awaiting" ? (
                                    <span className="text-base leading-none">
                                      ⏳
                                    </span>
                                  ) : (
                                    <Tag className="h-4 w-4" />
                                  )}
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onClick={() =>
                                    setLineStatus(item.row_key, "normal")
                                  }
                                  className={
                                    item.line_status === "normal"
                                      ? "font-medium"
                                      : ""
                                  }
                                >
                                  📦 Нормална
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() =>
                                    setLineStatus(
                                      item.row_key,
                                      "paid_not_taken",
                                    )
                                  }
                                  className={
                                    item.line_status === "paid_not_taken"
                                      ? "font-medium text-amber-700"
                                      : ""
                                  }
                                >
                                  💰 Платена невзета
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() =>
                                    setLineStatus(item.row_key, "awaiting")
                                  }
                                  className={
                                    item.line_status === "awaiting"
                                      ? "font-medium text-gray-700"
                                      : ""
                                  }
                                >
                                  ⏳ На изчакване
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <button
                              type="button"
                              onClick={() => removeItem(i)}
                              className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
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
            {(() => {
              const total = validItems.reduce(
                (s, i) =>
                  s + (Number(i.quantity) || 0) * (Number(i.weight_kg) || 0),
                0,
              );
              return total > 0 ? (
                <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
                  <Package className="h-4 w-4" />
                  <span>
                    Общо тегло:{" "}
                    <span className="font-semibold">
                      {(Math.round(total * 100) / 100).toLocaleString("bg-BG", {
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 2,
                      })}{" "}
                      кг
                    </span>
                  </span>
                </div>
              ) : null;
            })()}
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
          <div className="text-sm bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-amber-900 space-y-2">
            <div className="font-medium">
              ⚠ Има артикули над наличността. Избери действие за всеки ред:
            </div>
            <ul className="space-y-1.5">
              {oversellNormalItems.map((i) => {
                const available = getEffectiveStock(i);
                const overage = Number(i.quantity) - available;
                return (
                  <li
                    key={i.row_key}
                    className="flex flex-wrap items-center gap-2 text-xs"
                  >
                    <span className="font-medium">{i.product_name}</span>
                    <span className="text-gray-600">
                      ({i.quantity}, налично {available}, недостигат {overage})
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => reduceToAvailable(i.row_key)}
                    >
                      Намали до {available}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="border-amber-500 text-amber-800 hover:bg-amber-100"
                      onClick={() =>
                        splitOversellLine(i.row_key, "paid_not_taken")
                      }
                      title="Раздели: налично като нормално + остатъка като платена-невзета"
                    >
                      💰 Платена невзета (×{overage})
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="border-gray-400 text-gray-700 hover:bg-gray-100"
                      onClick={() => splitOversellLine(i.row_key, "awaiting")}
                      title="Раздели: налично като нормално + остатъка като изчакване (pre-order, не вади стока)"
                    >
                      ⏳ На изчакване (×{overage})
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {hasBelowCost && (
          <div className="flex items-start gap-2 p-2 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <div className="font-medium mb-1">
                Внимание: артикули под доставна цена
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
              {!canOverrideBelowCost && (
                <div className="mt-2 font-medium text-red-700">
                  Свържи се с admin за одобрение.
                </div>
              )}
            </div>
          </div>
        )}
        {errorMsg && <ErrorMessage message={errorMsg} />}
        {successMsg && (
          <div className="text-sm bg-green-50 border border-green-200 rounded-md px-3 py-2 text-green-700">
            {successMsg}
          </div>
        )}

        <DialogFooter className="shrink-0 gap-2" onKeyDown={arrowNavRow}>
          <Button variant="outline" onClick={onClose}>
            Отказ
          </Button>
          <Button
            ref={editSubmitBtnRef}
            onClick={() => void submitEdit()}
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
  const { hasPermission } = usePermissions();
  const canOverrideBelowCost = hasPermission(PERMISSIONS.BELOW_COST_OVERRIDE);
  const canCreateReplacement = hasPermission(PERMISSIONS.REPLACEMENT_CREATE);
  const today = isoDateToday();
  const anonymousIndividual = partners.find(
    (p) =>
      (p as any).partner_type === "individual" &&
      p.name === "Физическо лице — краен потребител",
  );
  const [customerMode, setCustomerMode] = useState<"legal" | "individual">(
    "legal",
  );

  // New-firm sub-dialog: cashier types EIK, we auto-fill from the BG
  // trade registry, then on submit POST /partners and select the new
  // row inline so the order keeps moving.
  const [newFirmOpen, setNewFirmOpen] = useState(false);
  const [newFirm, setNewFirm] = useState({
    name: "",
    eik: "",
    vat_number: "",
    address: "",
    city: "",
    contact_person: "",
    phone: "",
    email: "",
  });
  const [newFirmEikLoading, setNewFirmEikLoading] = useState(false);
  const [newFirmEikAutoFilled, setNewFirmEikAutoFilled] = useState(false);
  const [newFirmSaving, setNewFirmSaving] = useState(false);

  useEffect(() => {
    if (!newFirmOpen) return;
    const eik = newFirm.eik.trim();
    if (!/^\d{9}$|^\d{13}$/.test(eik)) {
      setNewFirmEikAutoFilled(false);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setNewFirmEikLoading(true);
      try {
        const res = await api.get(`/partners/lookup/${eik}`);
        if (cancelled) return;
        const data = res.data || {};
        setNewFirm((p) => ({
          ...p,
          name: p.name || data.name || "",
          address: p.address || data.address || "",
          city: p.city || data.city || "",
          vat_number: p.vat_number || data.vat_number || "",
          contact_person: p.contact_person || data.manager || "",
          phone: p.phone || data.phone || "",
          email: p.email || data.email || "",
        }));
        setNewFirmEikAutoFilled(true);
      } catch {
        /* silent — user can fill manually */
      } finally {
        if (!cancelled) setNewFirmEikLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [newFirm.eik, newFirmOpen]);

  const resetNewFirm = () => {
    setNewFirm({
      name: "",
      eik: "",
      vat_number: "",
      address: "",
      city: "",
      contact_person: "",
      phone: "",
      email: "",
    });
    setNewFirmEikAutoFilled(false);
    setNewFirmEikLoading(false);
  };

  const submitNewFirm = async () => {
    if (!newFirm.name.trim()) {
      toast.error("Името е задължително");
      return;
    }
    setNewFirmSaving(true);
    try {
      const res = await api.post("/partners", {
        name: newFirm.name.trim(),
        eik: newFirm.eik.trim() || undefined,
        vat_number: newFirm.vat_number.trim() || undefined,
        address: newFirm.address.trim() || undefined,
        city: newFirm.city.trim() || undefined,
        contact_person: newFirm.contact_person.trim() || undefined,
        phone: newFirm.phone.trim() || undefined,
        email: newFirm.email.trim() || undefined,
        partner_type: "legal_entity",
      });
      const created = res.data;
      qc.invalidateQueries({ queryKey: ["partners"] });
      setForm((f) => ({ ...f, partner_id: String(created.id) }));
      setNewFirmOpen(false);
      resetNewFirm();
      toast.success(`Партньорът "${created.name}" е създаден`);
    } catch (err: any) {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при създаване на партньор",
      );
    } finally {
      setNewFirmSaving(false);
    }
  };
  const [form, setForm] = useState({
    partner_id: "",
    delivery_date: today,
    notes: "",
    econt_delivery_type: "office" as "office" | "address",
    econt_receiver_name: "",
    econt_receiver_phone: "",
    econt_city: "",
    econt_post_code: "",
    econt_office_code: "",
    econt_office_name: "",
    econt_street: "",
    econt_street_num: "",
    econt_weight: 1,
    econt_cod_amount: 0,
    econt_payer: "sender" as "sender" | "receiver",
    econt_has_cod: false,
    econt_shipment_description: "",
    econt_shipment_date: (() => {
      const t = new Date();
      t.setDate(t.getDate() + 1);
      return t.toISOString().slice(0, 10);
    })(),
  });
  const { token: authToken } = useAuth();
  const [items, setItems] = useState<OrderItemRow[]>([emptyItem()]);
  const [stockWarnings, setStockWarnings] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [orderCreated, setOrderCreated] = useState(false);
  const [confirmOverstock, setConfirmOverstock] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Виж коментара в EditOrderItemsModal — bulkDiscount е канонично %,
  // bulkDiscountAmount е удобство за касиера да въведе директно "колко
  // лева да сваля". Двупосочна синх чрез pre-discount gross total.
  const [bulkDiscount, setBulkDiscount] = useState("");
  const [bulkDiscountAmount, setBulkDiscountAmount] = useState("");

  const applyBulkDiscount = () => {
    const v = parseFloat(bulkDiscount);
    if (!Number.isFinite(v) || v < 0 || v > 100) return;
    setItems((prev) =>
      prev.map((it) =>
        it.product_id ? { ...it, discount_percent: bulkDiscount } : it,
      ),
    );
  };
  const [pendingOversell, setPendingOversell] = useState<{
    items: OversellItem[];
    proceed: () => void;
  } | null>(null);
  // Product-replacement mode — when true, the body of the form is replaced
  // with the two-section ReplacementForm (взема се / връща се). The toggle
  // is gated on partner razpiska-eligibility (no VAT number, or individual).
  const [isReplacement, setIsReplacement] = useState(false);
  const [replacementState, setReplacementState] =
    useState<ReplacementFormState | null>(null);

  // Keyboard-flow refs — Enter in qty jumps to price → (next row) qty,
  // so warehouse staff can key-fill a whole order from a single
  // "typed scan" without reaching for the mouse. Keyed by row_key so
  // adding/removing rows keeps the right input in focus.
  const qtyRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const kgRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const priceRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const discountRefs = useRef<Record<string, HTMLInputElement | null>>({});
  // Submit button ref — ArrowDown от последния ред слиза тук, така че
  // касиерът може да попълни всичко с клавиатурата и натисне Enter за
  // създаване, без да посяга към мишка.
  const submitBtnRef = useRef<HTMLButtonElement | null>(null);
  // Full "top-of-form" keyboard flow: партньор → дата → първи продукт.
  const partnerInputRef = useRef<HTMLInputElement | null>(null);
  const dateInputRef = useRef<HTMLInputElement | null>(null);
  // Customer mode toggle бутоните — за да можем да фокусираме активния
  // когато user натисне ArrowUp от partner combobox-а (преминаване
  // нагоре в потока).
  const legalModeBtnRef = useRef<HTMLButtonElement | null>(null);
  const individualModeBtnRef = useRef<HTMLButtonElement | null>(null);
  const productSearchRefs = useRef<Record<string, ProductSearchHandle | null>>(
    {},
  );
  // Pending focus intents — set synchronously, consumed after next render
  // when the refs have been reconciled (e.g. after handleProductSelect
  // swaps the <ProductSearch> for the qty row, or after addItem
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

  // Arrow-key navigation между клетките на items таблицата. Колоните
  // са ['qty', 'kg', 'price', 'discount'] — продуктът и сумата не са
  // editable числа. ArrowUp/Down мести между редовете в същата колона;
  // ArrowLeft/Right в същия ред между колоните; ArrowDown от последния
  // ред слиза към submit бутона ("Създай поръчка"). Browser-овият
  // default за ArrowUp/Down в number input-и (промяна +/- step) се
  // потиска — кешъра не иска stealth промени на quantities/цени.
  type Col = "qty" | "kg" | "price" | "discount";
  const COLS: Col[] = ["qty", "kg", "price", "discount"];
  const cellRefMap = (col: Col) =>
    ({
      qty: qtyRefs,
      kg: kgRefs,
      price: priceRefs,
      discount: discountRefs,
    })[col];
  const focusCell = (rowIdx: number, col: Col): boolean => {
    const row = items[rowIdx];
    if (!row) return false;
    const el = cellRefMap(col).current[row.row_key];
    if (!el) return false;
    focusAndSelect(el);
    return true;
  };
  const handleCellArrowKey = (
    e: React.KeyboardEvent<HTMLInputElement>,
    rowIdx: number,
    col: Col,
  ): boolean => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (rowIdx > 0) focusCell(rowIdx - 1, col);
      return true;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      // Опитваме next row. Ако няма (последния ред) → submit бутон.
      if (!focusCell(rowIdx + 1, col)) {
        submitBtnRef.current?.focus();
      }
      return true;
    }
    if (e.key === "ArrowLeft") {
      // Не превземаме когато caret-ът не е в началото на полето —
      // user-ът редактира числото и иска да мести в текста.
      const target = e.currentTarget;
      if (target.selectionStart && target.selectionStart > 0) return false;
      e.preventDefault();
      const idx = COLS.indexOf(col);
      if (idx > 0) focusCell(rowIdx, COLS[idx - 1]);
      return true;
    }
    if (e.key === "ArrowRight") {
      const target = e.currentTarget;
      const len = (target.value ?? "").length;
      if (target.selectionEnd != null && target.selectionEnd < len)
        return false;
      e.preventDefault();
      const idx = COLS.indexOf(col);
      if (idx < COLS.length - 1) focusCell(rowIdx, COLS[idx + 1]);
      return true;
    }
    return false;
  };

  // Sync partner_id with customerMode
  useEffect(() => {
    if (customerMode === "individual") {
      if (anonymousIndividual) {
        setForm((f) => ({ ...f, partner_id: String(anonymousIndividual.id) }));
      }
    } else {
      // When switching back to "фирма", clear partner_id so the combobox
      // re-engages (keeps the user in control — they must pick explicitly).
      setForm((f) =>
        f.partner_id &&
        anonymousIndividual &&
        f.partner_id === String(anonymousIndividual.id)
          ? { ...f, partner_id: "" }
          : f,
      );
    }
  }, [customerMode, anonymousIndividual]);

  useEffect(() => {
    setHistoryOpen(false);
  }, [form.partner_id, customerMode]);

  // Reset on open
  useEffect(() => {
    if (open) {
      setCustomerMode("legal");
      setForm({
        partner_id: "",
        delivery_date: today,
        notes: "",
        econt_delivery_type: "office",
        econt_receiver_name: "",
        econt_receiver_phone: "",
        econt_city: "",
        econt_post_code: "",
        econt_office_code: "",
        econt_office_name: "",
        econt_street: "",
        econt_street_num: "",
        econt_weight: 1,
        econt_cod_amount: 0,
        econt_payer: "sender",
        econt_has_cod: false,
        econt_shipment_description: "",
        econt_shipment_date: (() => {
          const t = new Date();
          t.setDate(t.getDate() + 1);
          return t.toISOString().slice(0, 10);
        })(),
      });
      setItems([emptyItem()]);
      setStockWarnings([]);
      setErrorMsg("");
      setOrderCreated(false);
      setConfirmOverstock(false);
      setPendingOversell(null);
      setIsReplacement(false);
      setReplacementState(null);
      // Reset на bulk-discount полетата — иначе при затваряне с попълнена
      // отстъпка стойностите остават и при следващото отваряне на dialog-а
      // изглеждат "залепнали" от предишната поръчка.
      setBulkDiscount("");
      setBulkDiscountAmount("");
      // Auto-land focus on партньор combobox so user can start typing
      // immediately — no mouse needed to begin a new order.
      queueMicrotask(() => partnerInputRef.current?.focus());
    }
  }, [open, today]);

  // Consume deferred focus intents AFTER items re-render so refs point
  // at the newly rendered inputs. Two flavours:
  //   (a) just-picked-product → jump from ProductSearch to the row's qty.
  //   (b) just-added-row → focus the new row's ProductSearch.
  useEffect(() => {
    if (pendingFocusRowRef.current) {
      const rowKey = pendingFocusRowRef.current;
      pendingFocusRowRef.current = null;
      queueMicrotask(() => {
        const target = qtyRefs.current[rowKey] ?? null;
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
      const wRaw =
        product.weight_kg != null ? parseFloat(String(product.weight_kg)) : NaN;
      const productWeight = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : null;
      setItems((prev) =>
        prev.map((item, i) => {
          if (i !== idx) return item;
          // Remember which row's qty to focus after this render:
          // once the row flips from "product picker" to "filled product",
          // the qty input mounts and the deferred focus effect honours it.
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
            weight_kg: productWeight != null ? String(productWeight) : "",
            original_weight_kg: productWeight,
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

  // Set the per-line status (normal / paid_not_taken / awaiting) from the
  // row's tag dropdown. Two cases:
  //   1. quantity > available stock and current is 'normal' → split the
  //      row into a normal line carrying the available qty and a new
  //      line carrying the overage with the chosen status. Mirrors the
  //      'Раздели' buttons in the overage warning banner.
  //   2. otherwise (enough stock OR row is already split) → flip the
  //      whole row to the chosen status. Useful when the customer paid
  //      for everything but won't pick up today, even though we have it
  //      in stock — surfaces in the "Платени невзети" view without
  //      decrementing inventory off-track.
  const setLineStatus = (
    rowKey: string,
    target: "normal" | "paid_not_taken" | "awaiting",
  ) => {
    setItems((prev) => {
      const idx = prev.findIndex((r) => r.row_key === rowKey);
      if (idx < 0) return prev;
      const orig = prev[idx];
      // Always flip the whole row when:
      //   - going to 'normal' (clear status),
      //   - going to 'awaiting' (the entire qty is waiting on stock —
      //     splitting "available + overage" makes no sense for awaiting,
      //     was creating a confusing zombie 0-qty 'normal' row),
      //   - the row already has a non-normal status (don't re-split).
      if (
        target === "normal" ||
        target === "awaiting" ||
        orig.line_status !== "normal"
      ) {
        return prev.map((r) =>
          r.row_key === rowKey ? { ...r, line_status: target } : r,
        );
      }
      // From here, target='paid_not_taken' on a 'normal' row. Split only
      // when there's actual stock to leave behind as 'normal' — at
      // stock=0 a split would produce a useless 0-qty 'normal' row plus
      // a paid_not_taken row, so just flip the whole line in that case.
      const available = getEffectiveStock(orig);
      const requested = Number(orig.quantity);
      const isOverage = available > 0 && requested > available;
      if (!isOverage) {
        return prev.map((r) =>
          r.row_key === rowKey ? { ...r, line_status: target } : r,
        );
      }
      const overage = requested - available;
      const taken: OrderItemRow = { ...orig, quantity: String(available) };
      const pending: OrderItemRow = makeOrderItemRow({
        product_id: orig.product_id,
        product_name: orig.product_name,
        quantity: String(overage),
        unit_price: orig.unit_price,
        discount_percent: orig.discount_percent,
        unit: orig.unit,
        stock: orig.stock,
        cost_price: orig.cost_price,
        weight_kg: orig.weight_kg,
        original_weight_kg: orig.original_weight_kg,
        line_status: target,
      });
      return [...prev.slice(0, idx), taken, pending, ...prev.slice(idx + 1)];
    });
    setStockWarnings([]);
  };

  const addHistoryItems = useCallback(
    (newItems: PartnerHistoryItem[]) => {
      if (newItems.length === 0) return;
      const existingIds = new Set(
        items
          .map((i) => Number(i.product_id))
          .filter((id) => Number.isFinite(id) && id > 0),
      );
      const eligible = newItems.filter((ni) => !existingIds.has(ni.product_id));
      const skippedAsDupes = newItems.length - eligible.length;
      const adding = eligible.filter((ni) => ni.stock_now > 0);
      const skippedOutOfStock = eligible.length - adding.length;

      if (adding.length > 0) {
        setItems((prev) => {
          const base = prev.filter(
            (row) => row.product_id !== "" || Number(row.quantity) > 0,
          );
          const newRows = adding.map((ni) =>
            makeOrderItemRow({
              product_id: String(ni.product_id),
              product_name: ni.product_name,
              quantity: "1",
              unit_price: String(ni.unit_price),
              discount_percent: String(ni.discount_percent),
              unit: ni.unit,
              stock: ni.stock_now,
            }),
          );
          return [...base, ...newRows];
        });
      }

      const parts: string[] = [];
      if (adding.length > 0)
        parts.push(
          `Добавени ${adding.length} ${adding.length === 1 ? "артикул" : "артикула"}`,
        );
      if (skippedAsDupes > 0)
        parts.push(`пропуснати ${skippedAsDupes} (вече в поръчката)`);
      if (skippedOutOfStock > 0)
        parts.push(`пропуснати ${skippedOutOfStock} (няма наличност)`);

      if (parts.length > 0) {
        if (adding.length === 0) {
          toast.info(parts.join(" · "));
        } else {
          toast.success(parts.join(" · "));
        }
      }
    },
    [items],
  );

  const addItem = () => setItems((i) => [...i, emptyItem()]);
  // Same as addItem but schedules focus to land on the new row's
  // ProductSearch — used by "Enter on last-row price" so the cashier
  // never needs the mouse between items.
  const addItemAndFocus = () => {
    pendingFocusNewRowProductRef.current = true;
    addItem();
  };

  // Selected partner (if any) — used for the replacement-mode toggle gate.
  // Replacement is only razpiska-eligible: individuals (no VAT) or non-VAT
  // legal entities. Mirrors the backend isRazpiskaEligible helper.
  const selectedPartner = useMemo(
    () =>
      form.partner_id
        ? (partners.find((p) => String(p.id) === form.partner_id) ?? null)
        : null,
    [partners, form.partner_id],
  );
  const isSelectedPartnerRazpiskaEligible = useMemo(() => {
    if (!selectedPartner) return false;
    if ((selectedPartner as any).partner_type === "individual") return true;
    const vat = (selectedPartner.vat_number ?? "").trim();
    return vat.length === 0;
  }, [selectedPartner]);
  // If the user picks a VAT-registered partner after toggling замяна on,
  // silently flip back to normal-order mode so we never submit a замяна
  // payload for an ineligible partner.
  useEffect(() => {
    if (
      isReplacement &&
      selectedPartner &&
      !isSelectedPartnerRazpiskaEligible
    ) {
      setIsReplacement(false);
      setReplacementState(null);
    }
  }, [isReplacement, selectedPartner, isSelectedPartnerRazpiskaEligible]);

  const validItems = items.filter(
    (i) => i.product_id && Number(i.quantity) > 0,
  );
  // Line totals respect per-line отстъпка: qty × unit × (1 − disc/100).
  // Round each line to 2 decimals BEFORE summing, so the displayed total
  // matches what the backend persists per-row → no 1-cent drift between
  // the modal and the PDF / order detail.
  // Mirror the backend's total convention (orders.ts insertItems): awaiting
  // lines DO NOT count toward the order total. They're tracked on the
  // parent for visibility but the goods haven't arrived yet, so the
  // cashier doesn't see them in the "to invoice / to charge" bucket.
  const computeLineTotal = (i: OrderItemRow) => {
    const disc = Number(i.discount_percent) || 0;
    const line = Number(i.quantity) * Number(i.unit_price) * (1 - disc / 100);
    return Math.round(line * 100) / 100;
  };
  const orderTotal = validItems
    .filter((i) => i.line_status !== "awaiting")
    .reduce((sum, i) => sum + computeLineTotal(i), 0);
  const awaitingTotal = validItems
    .filter((i) => i.line_status === "awaiting")
    .reduce((sum, i) => sum + computeLineTotal(i), 0);
  // Only 'normal' lines guard against overstock — paid_not_taken and
  // awaiting lines are explicitly allowed to exceed available stock
  // (paid_not_taken lets stock go negative for promised goods; awaiting
  // is a pre-order with no stock effect at all).
  const hasStockIssues = validItems.some(
    (i) =>
      i.line_status === "normal" &&
      getEffectiveStock(i) >= 0 &&
      Number(i.quantity) > getEffectiveStock(i),
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
  const totalBelowCostLoss = belowCostItems.reduce((sum, i) => {
    const qty = Number(i.quantity) || 0;
    return sum + (i.cost_price - Number(i.unit_price)) * qty;
  }, 0);

  // Auto-fill Еконт teglo from sum(qty × weight_kg) whenever items change.
  // Еконт min е 0.1 кг; ако няма никакви тегла, държим минимум 0.1.
  const totalItemsWeight = validItems.reduce((sum, i) => {
    const q = Number(i.quantity) || 0;
    const w = Number(i.weight_kg) || 0;
    return sum + q * w;
  }, 0);
  useEffect(() => {
    const rounded = Math.round(totalItemsWeight * 100) / 100;
    const next = rounded > 0 ? rounded : 0.1;
    setForm((f) =>
      Math.abs((f.econt_weight || 0) - next) < 0.0001
        ? f
        : { ...f, econt_weight: next },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalItemsWeight]);

  const mutation = useMutation({
    mutationFn: async (
      vars: { allow_below_cost?: boolean; asQuoted?: boolean } = {},
    ) => {
      // Replacement mode — backend expects a different payload shape:
      // is_replacement: true + items with is_returning flag + payment_method.
      // No Еконт / no asQuoted / no below-cost handling for замяна.
      if (isReplacement && replacementState) {
        const replacementItems = [
          ...replacementState.giveItems
            .filter((i) => i.product_id && Number(i.quantity) > 0)
            .map((i) => ({
              product_id: Number(i.product_id),
              quantity: Number(i.quantity),
              unit_price: Number(i.unit_price) || undefined,
              is_returning: false,
            })),
          ...replacementState.returnItems
            .filter((i) => i.product_id && Number(i.quantity) > 0)
            .map((i) => ({
              product_id: Number(i.product_id),
              quantity: Number(i.quantity),
              unit_price: Number(i.unit_price) || undefined,
              is_returning: true,
            })),
        ];
        const res = await api.post("/orders", {
          partner_id: Number(form.partner_id),
          is_replacement: true,
          items: replacementItems,
          payment_method: replacementState.paymentMethod,
          delivery_date: form.delivery_date || undefined,
          notes: form.notes || undefined,
        });
        return res;
      }

      const res = await api.post("/orders", {
        partner_id: Number(form.partner_id),
        delivery_date: form.delivery_date || undefined,
        notes: form.notes || undefined,
        econt_receiver_name: form.econt_receiver_name.trim() || undefined,
        econt_receiver_phone: form.econt_receiver_phone.trim() || undefined,
        econt_delivery_type: form.econt_city
          ? form.econt_delivery_type
          : undefined,
        econt_city: form.econt_city.trim() || undefined,
        econt_office_code: form.econt_office_code || undefined,
        econt_office_name: form.econt_office_name || undefined,
        econt_street: form.econt_street.trim() || undefined,
        econt_street_num: form.econt_street_num.trim() || undefined,
        econt_weight: form.econt_weight || undefined,
        econt_cod_amount:
          form.econt_has_cod && form.econt_cod_amount
            ? form.econt_cod_amount
            : undefined,
        econt_payer: form.econt_city ? form.econt_payer : undefined,
        econt_shipment_description:
          form.econt_shipment_description?.trim() || undefined,
        econt_shipment_date: form.econt_shipment_date || undefined,
        items: validItems.map((i) => ({
          product_id: Number(i.product_id),
          quantity: Number(i.quantity),
          unit_price: Number(i.unit_price) || undefined,
          discount_percent: Number(i.discount_percent) || 0,
          // Batch F1 — tunnel through the line state set by split-on-oversell
          line_status: (i as any).line_status ?? undefined,
        })),
        allow_below_cost: vars.allow_below_cost === true ? true : undefined,
        status: vars.asQuoted ? "quoted" : undefined,
      });

      // Persist any edited weights back to the product catalog so
      // future orders inherit the corrected weight automatically.
      const weightUpdates = validItems
        .map((i) => {
          const w = Number(i.weight_kg);
          if (!Number.isFinite(w) || w <= 0) return null;
          if (
            i.original_weight_kg != null &&
            Math.abs(w - i.original_weight_kg) < 0.001
          )
            return null;
          return { id: Number(i.product_id), weight_kg: w };
        })
        .filter((u): u is { id: number; weight_kg: number } => u !== null);
      if (weightUpdates.length > 0) {
        await Promise.allSettled(
          weightUpdates.map((u) =>
            api.put(`/products/${u.id}`, { weight_kg: u.weight_kg }),
          ),
        );
        qc.invalidateQueries({ queryKey: ["products"] });
      }
      return res;
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["partner-history"] });
      qc.invalidateQueries({ queryKey: ["partner-history-detail"] });
      const oversell = res.data?.warnings?.oversell;
      if (Array.isArray(oversell) && oversell.length > 0) {
        toast.warning(
          `Поръчката е записана, но ${oversell.length} ${oversell.length === 1 ? "артикул ще влезе" : "артикула ще влязат"} в минус при изпълнение.`,
        );
      }
      const createdOrder: Order | undefined =
        res?.data?.data ?? res?.data ?? undefined;
      // If saved as quoted, fetch the offer PDF as a blob (auth headers are
      // attached by the api wrapper) and open it in a new tab. window.open
      // on the raw URL fails because the browser doesn't carry the JWT.
      if (createdOrder?.status === "quoted" && createdOrder.id) {
        api
          .get(`/orders/${createdOrder.id}/offer-pdf`, { responseType: "blob" })
          .then((pdfRes) => {
            const blob = new Blob([pdfRes.data], { type: "application/pdf" });
            const url = URL.createObjectURL(blob);
            window.open(url, "_blank");
            setTimeout(() => URL.revokeObjectURL(url), 60000);
          })
          .catch(() => {
            /* swallow — order was created, PDF can be re-opened from drawer */
          });
      }
      if (onCreated && createdOrder && createdOrder.id) {
        // Open detail modal directly — user sees order summary
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

  // For замяна, validItems is irrelevant — items live in replacementState,
  // and we require at least one give AND one return line.
  const replacementHasGives = !!replacementState?.giveItems.some(
    (i) => i.product_id && Number(i.quantity) > 0,
  );
  const replacementHasReturns = !!replacementState?.returnItems.some(
    (i) => i.product_id && Number(i.quantity) > 0,
  );
  const canSubmit = isReplacement
    ? !!form.partner_id &&
      replacementHasGives &&
      replacementHasReturns &&
      !mutation.isPending &&
      !orderCreated
    : form.partner_id &&
      validItems.length > 0 &&
      !mutation.isPending &&
      !orderCreated;

  // Compute which items will go negative. Uses the stock snapshotted at
  // product-pick time (item.stock), which matches what the server sees.
  function computeOversellItems(): OversellItem[] {
    const byProduct = new Map<
      number,
      { requested: number; name: string; available: number }
    >();
    for (const row of items) {
      if (!row.product_id) continue;
      // Awaiting lines never deduct stock — backend's POST /orders skips
      // them in validateRequestedStock and orders.ts /fulfill skips the
      // inventory update too. Including them here would make the
      // "Наличността ще отиде под нулата" dialog complain about awaiting
      // qty going negative when it never touches stock.
      if (row.line_status === "awaiting") continue;
      const qty = parseFloat(String(row.quantity || 0));
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const id = Number(row.product_id);
      const existing = byProduct.get(id);
      if (existing) {
        existing.requested += qty;
      } else {
        byProduct.set(id, {
          requested: qty,
          name: row.product_name || `Продукт #${id}`,
          available: parseFloat(String(row.stock || 0)),
        });
      }
    }
    const result: OversellItem[] = [];
    for (const [pid, info] of byProduct) {
      const finalStock = info.available - info.requested;
      if (finalStock < 0) {
        result.push({
          product_id: pid,
          product_name: info.name,
          available: info.available,
          requested: info.requested,
          final_stock: finalStock,
        });
      }
    }
    return result;
  }

  // Batch F1 — three resolutions for an oversell warning:
  //  - reduce  → clamp every over-stock line to its available qty
  //  - split   → keep available-qty as 'normal' + add sibling line tagged
  //              'paid_not_taken' or 'awaiting' for the rest
  // All three close the dialog; the user can re-submit with the now-clean
  // items[] and the order goes through.
  function reduceOversellToAvailable(over: OversellItem[]) {
    setItems((prev) =>
      prev.map((row) => {
        const o = over.find(
          (x) =>
            x.product_id != null && x.product_id === Number(row.product_id),
        );
        if (!o) return row;
        return { ...row, quantity: String(o.available) };
      }),
    );
    setPendingOversell(null);
  }
  function splitOversellTo(
    over: OversellItem[],
    status: "paid_not_taken" | "awaiting",
  ) {
    setItems((prev) => {
      const out: typeof prev = [];
      for (const row of prev) {
        const o = over.find(
          (x) =>
            x.product_id != null && x.product_id === Number(row.product_id),
        );
        if (!o) {
          out.push(row);
          continue;
        }
        const overQty = Number(row.quantity) - o.available;
        out.push({ ...row, quantity: String(o.available) });
        out.push({
          ...row,
          quantity: String(overQty),
          line_status: status,
        } as any);
      }
      return out;
    });
    setPendingOversell(null);
  }

  // Single entry point for the create-order submit. Gates: below-cost
  // (admin-only override), then oversell. Stock-issue confirmation is
  // already a UI-level gate (button visibility) so we don't double-check
  // it here. allow_below_cost is sent to the API only when the admin
  // explicitly confirmed the dialog.
  const submitCreateOrder = async ({ asQuoted = false } = {}) => {
    setErrorMsg("");
    // Замяна skips below-cost / oversell / quoted guards — the backend
    // owns the bidirectional stock movement and there is no "под cost"
    // concept for a swap (it's a price-difference settlement).
    if (isReplacement) {
      mutation.mutate({});
      return;
    }
    if (hasBelowCost) {
      if (!canOverrideBelowCost) {
        setErrorMsg(
          "Има артикули под доставна цена. Свържи се с admin за одобрение.",
        );
        return;
      }
      const ok = await confirm({
        title: "Продажба под доставна цена",
        description: `${belowCostItems.length} артикул(а) са под доставна цена. Обща загуба: ${formatCurrency(totalBelowCostLoss)}. Сигурен ли си?`,
        confirmText: "Разреши",
        cancelText: "Отказ",
        variant: "danger",
      });
      if (!ok) return;
    }
    // Skip oversell guard for quoted orders — they don't deduct stock.
    if (!asQuoted) {
      const oversell = computeOversellItems();
      if (oversell.length > 0) {
        setPendingOversell({
          items: oversell,
          proceed: () =>
            mutation.mutate({ allow_below_cost: hasBelowCost, asQuoted }),
        });
        return;
      }
    }
    mutation.mutate({ allow_below_cost: hasBelowCost, asQuoted });
  };

  // Ctrl/Cmd+Enter anywhere in the dialog submits the order.
  const handleDialogKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter") return;
    if (!(e.ctrlKey || e.metaKey)) return;
    if (!canSubmit) return;
    if (hasStockIssues && !confirmOverstock) return;
    e.preventDefault();
    void submitCreateOrder();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onClose} modal={false}>
        <DialogContent
          className="sm:max-w-[98vw] lg:max-w-[1680px] max-h-[92vh] flex flex-col"
          onKeyDown={handleDialogKeyDown}
        >
          <DialogHeader className="shrink-0">
            <div className="flex items-center justify-between gap-2 pr-9">
              <div className="flex items-center gap-2">
                <DialogTitle>Нова поръчка</DialogTitle>
                {isReplacement && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-orange-200 bg-orange-50 px-2.5 py-0.5 text-xs font-medium text-orange-700">
                    <RefreshCcw className="h-3 w-3" />
                    Замяна
                  </span>
                )}
              </div>
              {canCreateReplacement && (
                <Button
                  type="button"
                  size="sm"
                  variant={isReplacement ? "default" : "outline"}
                  disabled={
                    !selectedPartner || !isSelectedPartnerRazpiskaEligible
                  }
                  title={
                    !selectedPartner
                      ? "Първо избери партньор"
                      : !isSelectedPartnerRazpiskaEligible
                        ? "Замяна за ДДС-фактуриран клиент ще бъде добавена в следваща итерация."
                        : isReplacement
                          ? "Излез от режим Замяна"
                          : "Премини в режим Замяна"
                  }
                  onClick={() => {
                    setIsReplacement((v) => {
                      const next = !v;
                      if (!next) setReplacementState(null);
                      return next;
                    });
                  }}
                >
                  <RefreshCcw className="h-4 w-4" />
                  Замяна
                </Button>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-1">
              Tab/Enter между полетата · Ctrl+Enter за създаване
            </p>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto min-h-0 space-y-4 py-2 pr-1">
            {/* Тип клиент (сегмент) */}
            <div className="flex flex-wrap items-center gap-2">
              <Label className="mr-2">Тип клиент:</Label>
              <div
                className="inline-flex rounded-lg border bg-gray-50 p-1"
                onKeyDown={(e) => {
                  // ArrowDown от toggle бутон → влиза в partner combobox
                  // (или, при individual режим, директно в първия
                  // ProductSearch — там няма combobox).
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    if (customerMode === "individual") {
                      const firstRow = items[0];
                      if (firstRow) focusProductSearch(firstRow.row_key);
                    } else {
                      partnerInputRef.current?.focus();
                    }
                    return;
                  }
                  arrowNavRow(e);
                }}
              >
                <button
                  ref={legalModeBtnRef}
                  type="button"
                  onClick={() => setCustomerMode("legal")}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition ${
                    customerMode === "legal"
                      ? "bg-white shadow text-gray-900"
                      : "text-gray-500 hover:text-gray-900"
                  }`}
                >
                  🏢 Фирма (с ЕИК)
                </button>
                <button
                  ref={individualModeBtnRef}
                  type="button"
                  onClick={() => setCustomerMode("individual")}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition ${
                    customerMode === "individual"
                      ? "bg-white shadow text-gray-900"
                      : "text-gray-500 hover:text-gray-900"
                  }`}
                  disabled={!anonymousIndividual}
                  title={
                    anonymousIndividual
                      ? "Физическо лице — без ЕИК, без лични данни"
                      : "Seed партньорът липсва — изпълнете миграцията"
                  }
                >
                  👤 Физическо лице
                </button>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setCustomerMode("legal");
                  resetNewFirm();
                  setNewFirmOpen(true);
                }}
                title="Създай нов партньор-фирма по ЕИК (auto-fill от Търговски регистър)"
              >
                + Нова фирма
              </Button>
              {customerMode === "individual" && (
                <span className="text-xs text-gray-500">
                  Продажба на краен потребител. Касовата бележка излиза от
                  фискалния апарат.
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>
                  {customerMode === "individual" ? "Клиент" : "Партньор *"}
                </Label>
                {customerMode === "individual" ? (
                  <div className="h-9 flex items-center px-3 rounded-md border bg-gray-50 text-sm text-gray-700">
                    👤 Физическо лице — краен потребител
                  </div>
                ) : (
                  <div className="flex items-stretch gap-2">
                    <div className="flex-1">
                      <Combobox
                        inputRef={partnerInputRef}
                        items={partners
                          .filter(
                            (p) => (p as any).partner_type !== "individual",
                          )
                          .map((p) => ({
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
                          }))
                        }
                        onClear={() =>
                          setForm((f) => ({
                            ...f,
                            partner_id: "",
                          }))
                        }
                        onPickEnter={() =>
                          // След избор на партньор — направо на първия
                          // ProductSearch, не на "Дата на доставка".
                          // Датата по подразбиране е утре и рядко се
                          // променя; кешъра иска веднага да започне с
                          // първия артикул. Ако трябва да коригира
                          // датата, Tab/Shift+Tab я достига.
                          queueMicrotask(() => {
                            const firstRow = items[0];
                            if (firstRow) focusProductSearch(firstRow.row_key);
                          })
                        }
                        onArrowUpClosed={() => {
                          // Връщане към активния тип-клиент toggle бутон.
                          const target =
                            customerMode === "legal"
                              ? legalModeBtnRef.current
                              : individualModeBtnRef.current;
                          target?.focus();
                        }}
                        placeholder="Избери или потърси по код, име или ЕИК..."
                        emptyMessage="Няма намерени партньори."
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => setHistoryOpen(true)}
                      disabled={!form.partner_id}
                      title={
                        form.partner_id
                          ? "Виж минали поръчки от този партньор"
                          : "Избери партньор"
                      }
                      className="shrink-0 inline-flex items-center gap-1.5 px-3 rounded-md border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <History className="h-4 w-4" />
                      <span className="hidden sm:inline">История</span>
                    </button>
                  </div>
                )}
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
                      focusProductSearch(items[0]?.row_key);
                    }
                  }}
                />
              </div>
            </div>

            {isReplacement ? (
              <ReplacementForm
                partnerId={form.partner_id}
                onChange={setReplacementState}
              />
            ) : (
              <>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <Label>Артикули</Label>
                    <div className="flex items-center gap-2">
                      <Label
                        htmlFor="bulk-discount-create"
                        className="text-sm font-normal text-gray-600"
                      >
                        Обща отстъпка %:
                      </Label>
                      <Input
                        id="bulk-discount-create"
                        type="number"
                        step="0.1"
                        min="0"
                        max="100"
                        value={bulkDiscount}
                        onChange={(e) => {
                          const v = e.target.value;
                          setBulkDiscount(v);
                          // Sync към € — pre-discount gross на всички
                          // непразни редове.
                          const gross = items.reduce(
                            (sum, it) =>
                              sum +
                              Number(it.quantity || 0) *
                                Number(it.unit_price || 0),
                            0,
                          );
                          const pct = parseFloat(v);
                          if (!Number.isFinite(pct) || v === "" || gross <= 0) {
                            setBulkDiscountAmount("");
                          } else {
                            setBulkDiscountAmount(
                              ((gross * pct) / 100).toFixed(2),
                            );
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            applyBulkDiscount();
                          }
                        }}
                        placeholder="0"
                        className="w-20"
                      />
                      <Label
                        htmlFor="bulk-discount-amt-create"
                        className="text-sm font-normal text-gray-600"
                      >
                        или €:
                      </Label>
                      <Input
                        id="bulk-discount-amt-create"
                        type="number"
                        step="0.01"
                        min="0"
                        value={bulkDiscountAmount}
                        onChange={(e) => {
                          const v = e.target.value;
                          setBulkDiscountAmount(v);
                          const gross = items.reduce(
                            (sum, it) =>
                              sum +
                              Number(it.quantity || 0) *
                                Number(it.unit_price || 0),
                            0,
                          );
                          const amt = parseFloat(v);
                          if (!Number.isFinite(amt) || v === "" || gross <= 0) {
                            setBulkDiscount("");
                          } else {
                            // Cap-ваме до 100% (не може да сваляме повече
                            // от стойността на сметката).
                            const pct = Math.min(
                              100,
                              Math.max(0, (amt / gross) * 100),
                            );
                            // Използваме до 4 знака за minimal loss на
                            // точност при apply-а; визуализацията на
                            // input-а ползва % .toFixed(4) -> parseFloat
                            // = чист number без trailing нули.
                            setBulkDiscount(String(parseFloat(pct.toFixed(4))));
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            applyBulkDiscount();
                          }
                        }}
                        placeholder="0.00"
                        className="w-24"
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={applyBulkDiscount}
                        disabled={
                          bulkDiscount === "" ||
                          !Number.isFinite(parseFloat(bulkDiscount)) ||
                          parseFloat(bulkDiscount) < 0 ||
                          parseFloat(bulkDiscount) > 100
                        }
                      >
                        Приложи на всички
                      </Button>
                    </div>
                  </div>
                  <div className="border rounded-lg overflow-x-auto">
                    <Table className="min-w-[1000px]">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="min-w-[320px]">
                            Продукт
                          </TableHead>
                          <TableHead className="w-24">Наличност</TableHead>
                          <TableHead className="w-28">Количество</TableHead>
                          <TableHead className="w-24">Кг</TableHead>
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
                          // Only flag overstock on normal lines; paid-not-taken
                          // and awaiting lines opt out of the red warning bg.
                          const overStock =
                            item.line_status === "normal" &&
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
                                item.line_status === "paid_not_taken"
                                  ? "bg-amber-50"
                                  : item.line_status === "awaiting"
                                    ? "bg-gray-50"
                                    : overStock
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
                                      <div className="text-sm font-medium truncate flex items-center gap-2 flex-wrap">
                                        <span>{item.product_name}</span>
                                        {item.line_status ===
                                          "paid_not_taken" && (
                                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 border border-amber-200 text-xs font-normal whitespace-nowrap">
                                            💰 Платена невзета
                                          </span>
                                        )}
                                        {item.line_status === "awaiting" && (
                                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-gray-100 text-gray-700 border border-gray-200 text-xs font-normal whitespace-nowrap">
                                            ⏳ На изчакване
                                          </span>
                                        )}
                                      </div>
                                      <div className="text-xs text-gray-400">
                                        {item.unit}
                                      </div>
                                    </div>
                                  </div>
                                ) : (
                                  <ProductSearchBoundary
                                    key={`psb-${item.row_key}`}
                                  >
                                    <ProductSearch
                                      ref={(h) => {
                                        productSearchRefs.current[
                                          item.row_key
                                        ] = h;
                                      }}
                                      partnerId={form.partner_id}
                                      onSelect={(p) =>
                                        handleProductSelect(i, p)
                                      }
                                      disabled={!form.partner_id}
                                    />
                                  </ProductSearchBoundary>
                                )}
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
                                    if (handleCellArrowKey(e, i, "qty")) return;
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      focusAndSelect(
                                        priceRefs.current[item.row_key],
                                      );
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
                                    kgRefs.current[item.row_key] = el;
                                  }}
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  value={item.weight_kg}
                                  onChange={(e) =>
                                    setItem(i, "weight_kg", e.target.value)
                                  }
                                  onKeyDown={(e) => {
                                    if (handleCellArrowKey(e, i, "kg")) return;
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      focusAndSelect(
                                        priceRefs.current[item.row_key],
                                      );
                                    }
                                  }}
                                  className="w-20"
                                  disabled={!item.product_id}
                                  placeholder="0"
                                  title="Тегло (кг) — ще се запамети към продукта и ще се използва за Еконт"
                                />
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
                                    if (handleCellArrowKey(e, i, "price"))
                                      return;
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
                                    setItem(
                                      i,
                                      "discount_percent",
                                      e.target.value,
                                    )
                                  }
                                  onKeyDown={(e) => {
                                    if (handleCellArrowKey(e, i, "discount"))
                                      return;
                                    if (e.key !== "Enter") return;
                                    e.preventDefault();
                                    const nextRow = items[i + 1];
                                    if (nextRow) {
                                      focusAndSelect(
                                        qtyRefs.current[nextRow.row_key],
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
                                        qtyRefs.current[item.row_key],
                                      );
                                    }
                                  }}
                                  className={`w-20 ${discount > 0 ? "border-blue-400 text-blue-700" : ""}`}
                                  disabled={!item.product_id}
                                  placeholder="0"
                                />
                              </TableCell>
                              <TableCell className="font-medium text-sm">
                                {lineTotal > 0
                                  ? formatCurrency(lineTotal)
                                  : "—"}
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-1">
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <button
                                        type="button"
                                        disabled={!item.product_id}
                                        className={`p-1 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                                          item.line_status === "paid_not_taken"
                                            ? "text-amber-600 hover:bg-amber-100"
                                            : item.line_status === "awaiting"
                                              ? "text-gray-600 hover:bg-gray-100"
                                              : "text-gray-300 hover:text-gray-600 hover:bg-gray-50"
                                        }`}
                                        title="Маркирай реда като платена невзета или на изчакване"
                                      >
                                        {item.line_status ===
                                        "paid_not_taken" ? (
                                          <span className="text-base leading-none">
                                            💰
                                          </span>
                                        ) : item.line_status === "awaiting" ? (
                                          <span className="text-base leading-none">
                                            ⏳
                                          </span>
                                        ) : (
                                          <Tag className="h-4 w-4" />
                                        )}
                                      </button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      <DropdownMenuItem
                                        onClick={() =>
                                          setLineStatus(item.row_key, "normal")
                                        }
                                        className={
                                          item.line_status === "normal"
                                            ? "font-medium"
                                            : ""
                                        }
                                      >
                                        📦 Нормална
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        onClick={() =>
                                          setLineStatus(
                                            item.row_key,
                                            "paid_not_taken",
                                          )
                                        }
                                        className={
                                          item.line_status === "paid_not_taken"
                                            ? "font-medium text-amber-700"
                                            : ""
                                        }
                                      >
                                        💰 Платена невзета
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        onClick={() =>
                                          setLineStatus(
                                            item.row_key,
                                            "awaiting",
                                          )
                                        }
                                        className={
                                          item.line_status === "awaiting"
                                            ? "font-medium text-gray-700"
                                            : ""
                                        }
                                      >
                                        ⏳ На изчакване
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                  <button
                                    type="button"
                                    onClick={() => removeItem(i)}
                                    className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={addItem}
                    type="button"
                  >
                    + Добави артикул
                  </Button>
                  {totalItemsWeight > 0 && (
                    <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
                      <Package className="h-4 w-4" />
                      <span>
                        Общо тегло:{" "}
                        <span className="font-semibold">
                          {(
                            Math.round(totalItemsWeight * 100) / 100
                          ).toLocaleString("bg-BG", {
                            minimumFractionDigits: 1,
                            maximumFractionDigits: 2,
                          })}{" "}
                          кг
                        </span>
                      </span>
                    </div>
                  )}
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

                {authToken && (
                  <EcontShippingPicker
                    value={{
                      econt_delivery_type: form.econt_delivery_type,
                      econt_receiver_name: form.econt_receiver_name,
                      econt_receiver_phone: form.econt_receiver_phone,
                      econt_city: form.econt_city,
                      econt_post_code: form.econt_post_code || undefined,
                      econt_office_code: form.econt_office_code || undefined,
                      econt_office_name: form.econt_office_name || undefined,
                      econt_street: form.econt_street || undefined,
                      econt_street_num: form.econt_street_num || undefined,
                      econt_weight: form.econt_weight,
                      econt_cod_amount: form.econt_cod_amount,
                      econt_payer: form.econt_payer,
                      econt_has_cod: form.econt_has_cod,
                      econt_shipment_description:
                        form.econt_shipment_description || undefined,
                      econt_shipment_date:
                        form.econt_shipment_date || undefined,
                    }}
                    onChange={(patch) =>
                      setForm((f) => ({
                        ...f,
                        ...(patch as Partial<typeof f>),
                      }))
                    }
                    token={authToken}
                    defaultOpen={false}
                    defaultCodAmount={orderTotal}
                  />
                )}
              </>
            )}
          </div>

          {/* Order total */}
          <div className="border-t pt-3 shrink-0">
            <div className="flex items-center justify-between mb-2">
              {(() => {
                if (isReplacement && replacementState) {
                  // In replacement mode the regular `validItems` array is
                  // empty — count + sign-applied total come from the
                  // give/return rows the ReplacementForm owns. Same
                  // signed math the backend uses to compute orders.total.
                  const giveCount = replacementState.giveItems.filter(
                    (i) => i.product_id && Number(i.quantity) > 0,
                  ).length;
                  const retCount = replacementState.returnItems.filter(
                    (i) => i.product_id && Number(i.quantity) > 0,
                  ).length;
                  const totalCount = giveCount + retCount;
                  const giveSum = replacementState.giveItems.reduce(
                    (s, i) =>
                      s +
                      (Number(i.quantity) || 0) * (Number(i.unit_price) || 0),
                    0,
                  );
                  const retSum = replacementState.returnItems.reduce(
                    (s, i) =>
                      s +
                      (Number(i.quantity) || 0) * (Number(i.unit_price) || 0),
                    0,
                  );
                  const diff = giveSum - retSum;
                  return (
                    <>
                      <span className="text-sm text-gray-500">
                        {totalCount} артикул{totalCount !== 1 ? "а" : ""}
                        {giveCount > 0 || retCount > 0
                          ? ` (взема ${giveCount} · връща ${retCount})`
                          : ""}
                      </span>
                      <span className="text-lg font-bold">
                        Разлика: {diff > 0 ? "+" : diff < 0 ? "−" : ""}
                        {formatCurrency(Math.abs(diff))}
                      </span>
                    </>
                  );
                }
                return (
                  <>
                    <span className="text-sm text-gray-500">
                      {validItems.length} артикул
                      {validItems.length !== 1 ? "а" : ""}
                    </span>
                    <span className="text-lg font-bold">
                      Общо: {formatCurrency(orderTotal)}
                    </span>
                  </>
                );
              })()}
            </div>
            {awaitingTotal > 0 && (
              // Awaiting items live on the parent for visibility but their
              // value never lands on the invoice or the cashier's "to
              // collect" total — it'll be charged on a separate
              // transaction once the goods arrive (the spawned child
              // order). Show it as a discreet sub-line so the cashier
              // knows what's promised but not yet pay-able.
              <div className="flex items-center justify-end gap-2 mb-2 text-xs text-gray-500">
                <span>⏳ На изчакване (отделна сделка):</span>
                <span className="font-medium text-gray-700">
                  {formatCurrency(awaitingTotal)}
                </span>
              </div>
            )}

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
                  Потвърдено — поръчката ще бъде създадена въпреки
                  недостатъчната наличност.
                </span>
              </div>
            )}

            {hasBelowCost && (
              <div className="flex items-start gap-2 p-2 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800 mb-2">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium mb-1">
                    Внимание: продажба под доставната цена!
                  </div>
                  <div className="mb-1">
                    Следните артикули са с цена под ДЦ (губиш пари на всеки
                    бр.):
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
                  {!canOverrideBelowCost && (
                    <div className="mt-2 font-medium text-red-700">
                      Свържи се с admin за одобрение — само admin може да пуска
                      поръчки под доставна цена.
                    </div>
                  )}
                </div>
              </div>
            )}

            {errorMsg && <ErrorMessage message={errorMsg} />}

            <DialogFooter className="gap-2" onKeyDown={arrowNavRow}>
              <Button variant="outline" onClick={onClose}>
                {orderCreated ? "Затвори" : "Отказ"}
              </Button>
              {!orderCreated &&
                !isReplacement &&
                hasStockIssues &&
                !confirmOverstock && (
                  <Button
                    variant="destructive"
                    onClick={() => setConfirmOverstock(true)}
                  >
                    <AlertTriangle className="h-4 w-4" />
                    Потвърди въпреки липсата
                  </Button>
                )}
              {!orderCreated && !isReplacement && (
                <Button
                  variant="outline"
                  onClick={() => void submitCreateOrder({ asQuoted: true })}
                  disabled={!canSubmit || mutation.isPending}
                  className="border-amber-500 text-amber-700 hover:bg-amber-50"
                  title="Запази без изваждане от наличности и отвори PDF на офертата"
                >
                  <FileText className="h-4 w-4" />
                  Запази като оферта
                </Button>
              )}
              {!orderCreated &&
                (isReplacement || !hasStockIssues || confirmOverstock) && (
                  <Button
                    ref={submitBtnRef}
                    onClick={() => void submitCreateOrder()}
                    onKeyDown={(e) => {
                      // ArrowUp от submit бутон → връщам в последния
                      // ред на items grid-а (qty колоната — началото на
                      // реда). Двупосочно с ArrowDown→submit от grid-а.
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        const lastRow = items[items.length - 1];
                        if (lastRow) {
                          const el = qtyRefs.current[lastRow.row_key];
                          if (el) focusAndSelect(el);
                          else focusProductSearch(lastRow.row_key);
                        }
                      }
                    }}
                    disabled={!canSubmit}
                  >
                    {mutation.isPending ? (
                      <>
                        <Spinner size="sm" />
                        Запазване...
                      </>
                    ) : isReplacement ? (
                      "Създай замяна"
                    ) : (
                      "Създай поръчка"
                    )}
                  </Button>
                )}
              {orderCreated && (
                <span className="text-sm text-green-600 flex items-center gap-1">
                  <CheckCircle className="h-4 w-4" />
                  {isReplacement
                    ? "Замяната е създадена"
                    : "Поръчката е създадена"}
                </span>
              )}
            </DialogFooter>
          </div>
        </DialogContent>
        {customerMode === "legal" && form.partner_id && (
          <PartnerHistoryDrawer
            open={historyOpen}
            onOpenChange={setHistoryOpen}
            partnerId={form.partner_id}
            partnerName={
              partners.find((p) => String(p.id) === form.partner_id)?.name ?? ""
            }
            currentProductIds={
              new Set(
                items
                  .map((i) => Number(i.product_id))
                  .filter((id) => Number.isFinite(id) && id > 0),
              )
            }
            onAddItem={(hi) => addHistoryItems([hi])}
            onRepeatOrder={(his) => addHistoryItems(his)}
          />
        )}
        <OversellConfirmDialog
          open={!!pendingOversell}
          items={pendingOversell?.items ?? []}
          onCancel={() => setPendingOversell(null)}
          onConfirm={() => {
            const proceed = pendingOversell?.proceed;
            setPendingOversell(null);
            proceed?.();
          }}
        />
      </Dialog>

      <Dialog
        open={newFirmOpen}
        onOpenChange={(o) => {
          setNewFirmOpen(o);
          if (!o) resetNewFirm();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Нова фирма</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <div>
              <Label>ЕИК *</Label>
              <Input
                autoFocus
                value={newFirm.eik}
                onChange={(e) =>
                  setNewFirm((p) => ({ ...p, eik: e.target.value }))
                }
                placeholder="9–13 цифри (auto-fill от Търговски регистър)"
              />
              {newFirmEikLoading && (
                <p className="text-[11px] text-blue-600 mt-1">
                  🔎 Търся фирмата в Търговски регистър...
                </p>
              )}
              {newFirmEikAutoFilled && !newFirmEikLoading && (
                <p className="text-[11px] text-emerald-600 mt-1">
                  ✓ Данните са попълнени автоматично
                </p>
              )}
            </div>
            <div>
              <Label>Име *</Label>
              <Input
                value={newFirm.name}
                onChange={(e) =>
                  setNewFirm((p) => ({ ...p, name: e.target.value }))
                }
                placeholder="напр. Фирма Х ЕООД"
              />
            </div>
            <div>
              <Label>ДДС №</Label>
              <Input
                value={newFirm.vat_number}
                onChange={(e) =>
                  setNewFirm((p) => ({ ...p, vat_number: e.target.value }))
                }
              />
            </div>
            <div>
              <Label>Адрес</Label>
              <Input
                value={newFirm.address}
                onChange={(e) =>
                  setNewFirm((p) => ({ ...p, address: e.target.value }))
                }
              />
            </div>
            <div>
              <Label>Град</Label>
              <Input
                value={newFirm.city}
                onChange={(e) =>
                  setNewFirm((p) => ({ ...p, city: e.target.value }))
                }
              />
            </div>
            <div>
              <Label>МОЛ</Label>
              <Input
                value={newFirm.contact_person}
                placeholder="Управител / материално отговорно лице"
                onChange={(e) =>
                  setNewFirm((p) => ({ ...p, contact_person: e.target.value }))
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Телефон</Label>
                <Input
                  value={newFirm.phone}
                  onChange={(e) =>
                    setNewFirm((p) => ({ ...p, phone: e.target.value }))
                  }
                />
              </div>
              <div>
                <Label>E-mail</Label>
                <Input
                  value={newFirm.email}
                  onChange={(e) =>
                    setNewFirm((p) => ({ ...p, email: e.target.value }))
                  }
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setNewFirmOpen(false);
                resetNewFirm();
              }}
              disabled={newFirmSaving}
            >
              Отказ
            </Button>
            <Button
              onClick={submitNewFirm}
              disabled={newFirmSaving || !newFirm.name.trim()}
            >
              {newFirmSaving ? "Запазвам…" : "Запази и избери"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ */

/*  Main Orders page                                                   */
/* ------------------------------------------------------------------ */
export function Orders() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const canSeeBelowCostFilter = hasPermission(PERMISSIONS.BELOW_COST_OVERRIDE);
  const [statusFilter, setStatusFilter] = useState("");
  const [belowCostOnly, setBelowCostOnly] = useState(false);
  // Batch F1 filter pills — surface only orders containing the matching
  // open line state. Backend uses EXISTS on order_items.line_status.
  const [hasPaidNotTaken, setHasPaidNotTaken] = useState(false);
  const [hasAwaiting, setHasAwaiting] = useState(false);
  // Econt filter pill — orders with a courier shipment + COD attached
  // (i.e. the cashier still owes the till money once Econt collects).
  const [hasCod, setHasCod] = useState(false);
  // Replacement filter — three states: "all" (no filter), "only" (just замени),
  // "exclude" (hide замени). Orders.tsx exposes only "all" / "only" via the
  // pill toggle; the "exclude" branch is here so a future Settings could opt
  // power-users out of seeing замени at all.
  const [filterReplacement, setFilterReplacement] = useState<
    "all" | "only" | "exclude"
  >("all");

  // Single exclusive filter selector — clicking any chip clears all the
  // others. Earlier the status buttons were exclusive but the pills
  // (Под cost / Платени невзети / На изчакване / Наложен платеж) were
  // independent toggles, so combining them produced empty intersections
  // ("status=fulfilled AND has_awaiting=true" matched zero rows). Fold
  // them all into one selector — clicking the active chip again clears
  // everything (= "Всички").
  const activeFilter: string = belowCostOnly
    ? "below_cost"
    : hasPaidNotTaken
      ? "paid_not_taken"
      : hasAwaiting
        ? "awaiting"
        : hasCod
          ? "cod"
          : filterReplacement === "only"
            ? "replacement"
            : statusFilter;
  const selectFilter = (next: string) => {
    setStatusFilter("");
    setBelowCostOnly(false);
    setHasPaidNotTaken(false);
    setHasAwaiting(false);
    setHasCod(false);
    setFilterReplacement("all");
    if (next === activeFilter) return; // toggle off
    switch (next) {
      case "below_cost":
        setBelowCostOnly(true);
        break;
      case "paid_not_taken":
        setHasPaidNotTaken(true);
        break;
      case "awaiting":
        setHasAwaiting(true);
        break;
      case "cod":
        setHasCod(true);
        break;
      case "replacement":
        setFilterReplacement("only");
        break;
      default:
        setStatusFilter(next); // pending / quoted / … / "" (Всички)
    }
  };
  // Per-column text filters
  const [filters, setFilters] = useState({
    order_number: "",
    partner: "",
    invoice: "",
    stock_dispatch: "",
    warranty: "",
    shipment: "",
    article: "",
  });
  // Article + shipment_number filters are sent to the backend so the
  // search works across the full history page (not just the 50 rows
  // currently rendered). Other text filters stay client-side fuzzy.
  // Debounce so each keystroke does not hit the API.
  const debouncedArticle = useDebouncedValue(filters.article.trim(), 300);
  const debouncedShipment = useDebouncedValue(filters.shipment.trim(), 300);
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
  const [paymentOrder, setPaymentOrder] = useState<Order | null>(null);

  const {
    data: orders = [],
    isLoading,
    error,
  } = useQuery<Order[]>({
    queryKey: [
      "orders",
      statusFilter,
      belowCostOnly,
      hasPaidNotTaken,
      hasAwaiting,
      hasCod,
      filterReplacement,
      debouncedArticle,
      debouncedShipment,
    ],
    queryFn: () => {
      const parts: string[] = [];
      if (statusFilter === "invoiced") parts.push("invoiced=true");
      else if (statusFilter) parts.push(`status=${statusFilter}`);
      if (belowCostOnly) parts.push("below_cost_only=true");
      if (hasPaidNotTaken) parts.push("has_paid_not_taken=true");
      // Awaiting child orders (migration 072) live as status='awaiting_stock';
      // they're hidden from the main list and surface only via this filter.
      if (hasAwaiting) parts.push("awaiting_only=true");
      if (hasCod) parts.push("has_cod=true");
      if (filterReplacement === "only") parts.push("is_replacement=true");
      else if (filterReplacement === "exclude")
        parts.push("is_replacement=false");
      if (debouncedArticle)
        parts.push(`article=${encodeURIComponent(debouncedArticle)}`);
      if (debouncedShipment)
        parts.push(`shipment_number=${encodeURIComponent(debouncedShipment)}`);
      const params = parts.length > 0 ? `?${parts.join("&")}` : "";
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
      api.get("/partners?catalog=true&limit=25000").then((r) => {
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
      // Partner — match against the override receiver if any (so a row
      // displayed as "ЖОКЕР ЕНТЪРТЕЙМЪНТ" is found by typing "ЖОКЕР"), and
      // still fall back to the original partner name.
      if (filters.partner.trim()) {
        const ok = matchesAnyField(filters.partner, [
          (order as any).invoice_partner_name ?? "",
          order.partner?.name ?? "",
          order.partner_name ?? "",
        ]);
        if (!ok) return false;
      }
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
      // Warranty — only orders that already had a warranty card issued
      // (warranty_number is non-null) match. Format WR-NNNNNNN.
      if (!matchField((order as any).warranty_number, filters.warranty))
        return false;
      // Shipment number — Econt tracking ID. Backend already filters
      // server-side via `?shipment_number=...`, but the client-side
      // pass keeps the matching consistent when the request hasn't
      // refetched yet.
      if (!matchField((order as any).econt_shipment_number, filters.shipment))
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      toast.success("Поръчката е изпълнена");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при изпълнение на поръчката",
      );
    },
  });

  const [pendingFulfillOversell, setPendingFulfillOversell] = useState<{
    items: OversellItem[];
    proceed: () => void;
  } | null>(null);

  async function handleFulfillClick(orderId: number) {
    try {
      const detailRes = await api.get(`/orders/${orderId}`);
      const detail = detailRes.data?.data ?? detailRes.data;
      const itemsList: Array<{
        product_id: number;
        quantity: number | string;
        total_stock?: number | string;
        name_bg?: string;
        name_en?: string;
      }> = detail?.items ?? [];

      // First pass — sum requested quantities per product_id.
      const requestedByProduct = new Map<number, number>();
      for (const it of itemsList) {
        const qty = parseFloat(String(it.quantity));
        if (!Number.isFinite(qty) || qty <= 0) continue;
        requestedByProduct.set(
          it.product_id,
          (requestedByProduct.get(it.product_id) || 0) + qty,
        );
      }

      // Second pass — one-time stock + name lookup per unique product_id.
      const stockByProduct = new Map<
        number,
        { total_stock: number; name: string }
      >();
      for (const it of itemsList) {
        if (stockByProduct.has(it.product_id)) continue;
        stockByProduct.set(it.product_id, {
          total_stock: parseFloat(String(it.total_stock ?? 0)),
          name: it.name_bg || it.name_en || `Продукт #${it.product_id}`,
        });
      }

      const oversell: OversellItem[] = [];
      for (const [productId, requested] of requestedByProduct) {
        const meta = stockByProduct.get(productId);
        if (!meta) continue;
        if (meta.total_stock - requested < 0) {
          oversell.push({
            product_name: meta.name,
            available: meta.total_stock,
            requested,
            final_stock: meta.total_stock - requested,
          });
        }
      }

      if (oversell.length > 0) {
        setPendingFulfillOversell({
          items: oversell,
          proceed: () => fulfillMutation.mutate(orderId),
        });
        return;
      }
      fulfillMutation.mutate(orderId);
    } catch (err) {
      toast.error(
        getApiErrorMessage(err, "Грешка при проверка на наличността."),
      );
    }
  }

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      api.put(`/orders/${id}/status`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      toast.success("Статусът е обновен");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при обновяване на статуса",
      );
    },
  });

  // Migration 072 — flip an awaiting child order back to active when the
  // promised stock arrives. Backend bumps order_date to today so the
  // row jumps into the day's "Поръчки" view ready for invoicing.
  const markArrivedMutation = useMutation({
    // Empty body — pass `{}` so axios still sends the request with the
    // application/json content-type that Fastify expects (otherwise it
    // 400s with "Body cannot be empty when content-type is set...").
    mutationFn: (id: number) => api.post(`/orders/${id}/mark-arrived`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      toast.success("Поръчката е прехвърлена в днешните поръчки");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при прехвърляне на поръчката",
      );
    },
  });

  const invoiceMutation = useMutation({
    mutationFn: (id: number) => api.post("/invoices", { order_id: id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      toast.success("Фактурата е генерирана");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при генериране на фактура",
      );
    },
  });

  const regenerateInvoiceMutation = useMutation({
    mutationFn: (invoiceId: number) =>
      api.put(`/invoices/${invoiceId}/regenerate`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      toast.success("Фактурата е регенерирана");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при регенериране на фактура",
      );
    },
  });

  const deleteOrderMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/orders/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["partner-order-counts"] });
      toast.success("Поръчката е изтрита");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при изтриване на поръчката",
      );
    },
  });

  // ── Document PDF downloads ──
  const handleDocumentDownload = async (
    orderId: number,
    docType: "stock-dispatch",
  ) => {
    try {
      // Default to gross pricing (с ДДС) — that's МЕРТ-М's standard format.
      // The order detail drawer has explicit "без ДДС" item in the dropdown
      // for the rare case the user needs net.
      const res = await api.get(
        `/orders/${orderId}/${docType}-pdf?pricing_mode=gross`,
        { responseType: "blob" },
      );
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
      link.download = `Стокова_разписка_${orderId}.pdf`;
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

  // Status transitions map
  const statusTransitions: Record<string, { label: string; value: string }[]> =
    {
      pending: [
        { label: "Потвърди", value: "confirmed" },
        { label: "Откажи", value: "cancelled" },
      ],
      confirmed: [
        { label: "Изпрати към склад", value: "processing" },
        { label: "Откажи", value: "cancelled" },
      ],
      processing: [
        { label: "Изпълни", value: "fulfilled" },
        { label: "Откажи", value: "cancelled" },
      ],
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
          "quoted",
          "confirmed",
          "processing",
          "fulfilled",
          "invoiced",
          "cancelled",
        ].map((s) => (
          <button
            key={s}
            onClick={() => selectFilter(s)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              statusFilter === s &&
              !belowCostOnly &&
              !hasPaidNotTaken &&
              !hasAwaiting &&
              !hasCod &&
              filterReplacement !== "only"
                ? "bg-[#f97316] text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {s === "" ? "Всички" : statusLabels[s]}
          </button>
        ))}
        {canSeeBelowCostFilter && (
          <button
            onClick={() => selectFilter("below_cost")}
            className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              belowCostOnly
                ? "bg-[#f97316] text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
            title="Покажи само поръчки с одобрение под доставна цена"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            Под cost
          </button>
        )}
        {/* Batch F1 — line-status filter pills (open paid_not_taken / awaiting) */}
        <button
          onClick={() => selectFilter("paid_not_taken")}
          className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
            hasPaidNotTaken
              ? "bg-[#f97316] text-white"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
          title="Покажи само поръчки с платени-невзети редове"
        >
          <Coins className="h-3.5 w-3.5" />
          Платени невзети
        </button>
        <button
          onClick={() => selectFilter("awaiting")}
          className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
            hasAwaiting
              ? "bg-[#f97316] text-white"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
          title="Покажи само поръчки с редове на изчакване (pre-order)"
        >
          <Hourglass className="h-3.5 w-3.5" />
          На изчакване
        </button>
        {/* Econt COD filter — show only orders with a courier shipment
            attached AND a cod_amount > 0. Combined with the new
            "товарителница" search input, gives the cashier a fast path
            to "find me everything Econt is bringing money in for". */}
        <button
          onClick={() => selectFilter("cod")}
          className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
            hasCod
              ? "bg-[#f97316] text-white"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
          title="Покажи само поръчки с Еконт товарителница и наложен платеж"
        >
          <Truck className="h-3.5 w-3.5" />
          Наложен платеж
        </button>
        {/* Замени filter — toggle "show only replacement orders" */}
        <button
          onClick={() => selectFilter("replacement")}
          className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
            filterReplacement === "only"
              ? "bg-[#f97316] text-white"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
          title="Покажи само замени"
        >
          <RefreshCcw className="h-3.5 w-3.5" />
          Замени
        </button>
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

      {/* Per-column search filters — compact, fit on a single row at lg+ */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-1.5">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400" />
          <Input
            value={filters.order_number}
            onChange={(e) =>
              setFilters((f) => ({ ...f, order_number: e.target.value }))
            }
            placeholder="№ поръчка"
            className="pl-7 h-8 text-xs"
          />
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400" />
          <Input
            value={filters.partner}
            onChange={(e) =>
              setFilters((f) => ({ ...f, partner: e.target.value }))
            }
            placeholder="Партньор"
            className="pl-7 h-8 text-xs"
          />
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400" />
          <Input
            value={filters.invoice}
            onChange={(e) =>
              setFilters((f) => ({ ...f, invoice: e.target.value }))
            }
            placeholder="№ фактура"
            className="pl-7 h-8 text-xs"
          />
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400" />
          <Input
            value={filters.stock_dispatch}
            onChange={(e) =>
              setFilters((f) => ({ ...f, stock_dispatch: e.target.value }))
            }
            placeholder="Ст. разписка"
            className="pl-7 h-8 text-xs"
          />
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400" />
          <Input
            value={filters.warranty}
            onChange={(e) =>
              setFilters((f) => ({ ...f, warranty: e.target.value }))
            }
            placeholder="№ гаранция"
            className="pl-7 h-8 text-xs"
          />
        </div>
        {/* Shipment-number search — paste an Econt tracking ID from the
            email and the matching order pops up. Backend match is
            ILIKE on econt_shipment_number, so partial codes work too. */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400" />
          <Input
            value={filters.shipment}
            onChange={(e) =>
              setFilters((f) => ({ ...f, shipment: e.target.value }))
            }
            placeholder="№ товарителница"
            className="pl-7 h-8 text-xs"
          />
        </div>
        {/* Article search — finds orders containing this product (snapshot match) */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400" />
          <Input
            value={filters.article}
            onChange={(e) =>
              setFilters((f) => ({ ...f, article: e.target.value }))
            }
            placeholder="Артикул"
            className="pl-7 h-8 text-xs"
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
                warranty: "",
                shipment: "",
                article: "",
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
            <Table className="table-fixed [&_th]:px-2 [&_td]:px-2 [&_th]:py-2 [&_td]:py-3">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[44px]">№</TableHead>
                  <TableHead className="w-[200px]">Партньор</TableHead>
                  <TableHead className="w-[96px] whitespace-nowrap">
                    Дата
                  </TableHead>
                  <TableHead className="w-[88px] whitespace-nowrap text-right">
                    Сума
                  </TableHead>
                  <TableHead className="w-[150px]">Статус</TableHead>
                  <TableHead className="w-[110px]">Фактура</TableHead>
                  <TableHead className="w-[140px]">Документи</TableHead>
                  {filters.article.trim() && (
                    <TableHead className="w-[200px]">Намерен артикул</TableHead>
                  )}
                  <TableHead className="w-[72px]">Източник</TableHead>
                  <TableHead className="w-[120px]">Плащане</TableHead>
                  <TableHead className="w-[110px] text-right">
                    Действия
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredOrders.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={11}
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
                        {order.is_replacement && (
                          <span
                            className="mr-1.5 inline-flex items-center gap-1 rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-[10px] font-medium text-orange-700"
                            title="Замяна — двупосочно движение на стока"
                          >
                            <RefreshCcw className="h-2.5 w-2.5" />
                            Замяна
                          </span>
                        )}
                        <HighlightMatch
                          text={String(order.order_number ?? order.id)}
                          query={filters.order_number}
                        />
                      </TableCell>
                      <TableCell
                        className="font-medium truncate max-w-[220px]"
                        title={
                          (order as any).invoice_partner_name ??
                          order.partner?.name ??
                          order.partner_name ??
                          `#${order.partner_id}`
                        }
                      >
                        <HighlightMatch
                          text={
                            (order as any).invoice_partner_name ??
                            order.partner?.name ??
                            order.partner_name ??
                            `#${order.partner_id}`
                          }
                          query={filters.partner}
                        />
                        {(order as any).invoice_partner_name ? (
                          <div className="text-[10px] text-amber-600 mt-0.5 truncate">
                            издадена на фирма
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatDate(order.order_date)}
                      </TableCell>
                      <TableCell className="font-medium text-right whitespace-nowrap">
                        {order.is_replacement
                          ? formatReplacementTotal(order.total_amount)
                          : formatCurrency(order.total_amount)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Badge
                            variant={
                              statusVariants[order.status] ?? "secondary"
                            }
                          >
                            {statusLabels[order.status] ?? order.status}
                          </Badge>
                          {order.below_cost_approved_at && (
                            <span
                              className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-800 border border-amber-300"
                              title={`Под cost — одобрена ${formatDate(order.below_cost_approved_at)}`}
                            >
                              <AlertTriangle className="h-3 w-3" />
                            </span>
                          )}
                          {order.dispatched_to_warehouse_at &&
                            (order.status === "fulfilled" ||
                            order.status === "invoiced" ? (
                              <span
                                className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200"
                                title={`Изпълнена от склад · изпратена ${formatDate(
                                  order.dispatched_to_warehouse_at,
                                )}`}
                              >
                                <CheckCircle className="h-3 w-3" />
                                от склад
                              </span>
                            ) : (
                              <span
                                className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200"
                                title={`Чака изпълнение от склад · изпратена ${formatDate(
                                  order.dispatched_to_warehouse_at,
                                )}`}
                              >
                                <Truck className="h-3 w-3" />в склад
                              </span>
                            ))}
                        </div>
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
                                      : "text-[#f97316]"
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
                                className="text-gray-400 hover:text-[#f97316] p-0.5 rounded"
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
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {order.econt_shipment_number ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                const url =
                                  order.econt_pdf_url ||
                                  order.econt_tracking_url ||
                                  `https://www.econt.com/services/track-shipment/${order.econt_shipment_number}`;
                                window.open(url, "_blank");
                              }}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100 transition"
                              title={`Товарителница ${order.econt_shipment_number}`}
                            >
                              <Truck className="h-3 w-3" />
                              {order.econt_shipment_number}
                            </button>
                          ) : order.econt_city ? (
                            <span
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-amber-50 text-amber-700 border border-amber-200"
                              title="Econt доставка — чака товарителница"
                            >
                              <Truck className="h-3 w-3" />
                              Econt
                            </span>
                          ) : null}
                          {order.status === "processing" ||
                          order.status === "fulfilled" ||
                          order.status === "invoiced" ? (
                            <>
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
                              {order.invoice_id && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleInvoicePrint(order.invoice_id!);
                                  }}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-orange-50 text-orange-700 border border-orange-200 hover:bg-orange-100 transition"
                                  title="Печат фактура"
                                >
                                  <FileText className="h-3 w-3" />
                                  Фактура
                                </button>
                              )}
                            </>
                          ) : !order.econt_city &&
                            !order.econt_shipment_number ? (
                            <span className="text-gray-300">—</span>
                          ) : null}
                        </div>
                      </TableCell>
                      {filters.article.trim() && (
                        <TableCell className="text-xs">
                          {(order.matched_items ?? [])
                            .slice(0, 3)
                            .map((it, idx) => (
                              <div
                                key={`${it.sku ?? "no-sku"}-${idx}`}
                                className="truncate"
                              >
                                <HighlightMultiToken
                                  text={it.name_bg}
                                  query={filters.article}
                                />
                                {it.sku && (
                                  <span className="text-gray-400 ml-1">
                                    ({it.sku})
                                  </span>
                                )}
                              </div>
                            ))}
                          {(order.matched_items?.length ?? 0) > 3 && (
                            <div className="text-gray-400">
                              +{(order.matched_items?.length ?? 0) - 3} още
                            </div>
                          )}
                        </TableCell>
                      )}
                      <TableCell>
                        <Badge variant="secondary">{order.source}</Badge>
                      </TableCell>
                      {/* Плащане badge — green/amber/slate/red derived from
                          paid_amount vs total_amount + the COD-shipment
                          flag. Cancelled and quoted orders short-circuit to
                          a dash — quotations carry no payment obligation
                          until they're converted to a real order. */}
                      <TableCell>
                        {(() => {
                          const o = order as any;
                          if (
                            order.status === "cancelled" ||
                            order.status === "quoted"
                          ) {
                            return (
                              <span className="text-gray-400 text-sm">—</span>
                            );
                          }
                          const total = parseFloat(
                            String(order.total_amount ?? 0),
                          );
                          const paid = parseFloat(String(o.paid_amount ?? 0));
                          const paidCod = parseFloat(
                            String(o.paid_cod_amount ?? 0),
                          );
                          const codAmount = parseFloat(
                            String(o.econt_cod_amount ?? 0),
                          );
                          const isCod = o.has_cod_shipment === true;

                          // For COD shipments the order is 'Платена' only
                          // when the courier-collected COD has actually been
                          // recorded (payment_method='cod'). Other-method
                          // prepayments don't tip the badge — until Еконт
                          // delivers and the cashier marks the COD payment,
                          // the order stays in 'Налож. платеж'.
                          if (isCod) {
                            const codCovered =
                              paidCod >= (codAmount || total) - 0.01;
                            if (codCovered) {
                              return <Badge variant="success">Платена</Badge>;
                            }
                            return (
                              <Badge
                                variant="warning"
                                title="Очаква наложен платеж от Еконт"
                              >
                                Налож. платеж
                              </Badge>
                            );
                          }

                          // Замяна — total_amount е signed (give − return).
                          // payments.amount винаги е положителна (auto row на
                          // create или manual). Сравнението е срещу |total|.
                          //  • |total| ≈ 0 → same-value swap (warranty), няма
                          //    плащане → счита се за settled.
                          //  • paid ≥ |total| → settled (или клиентът е
                          //    доплатил на +, или ние сме изплатили refund на
                          //    −).
                          //  • 0 < paid < |total| → частично (рядко за замяна,
                          //    но manual payments го допускат).
                          //  • paid = 0 и |total| > 0 → unsettled. Знакът ни
                          //    казва кой дължи на кого, така че кешъра не
                          //    трябва да чете signed total в съседната колона.
                          if (o.is_replacement) {
                            const absTotal = Math.abs(total);
                            if (absTotal < 0.01) {
                              return (
                                <Badge
                                  variant="success"
                                  title="Замяна без разлика (гаранция)"
                                >
                                  Платена
                                </Badge>
                              );
                            }
                            if (paid >= absTotal - 0.01) {
                              return <Badge variant="success">Платена</Badge>;
                            }
                            if (paid > 0) {
                              return <Badge variant="warning">Частично</Badge>;
                            }
                            if (total < 0) {
                              return (
                                <Badge
                                  variant="destructive"
                                  title="Дължим refund на клиента"
                                >
                                  Дължим refund
                                </Badge>
                              );
                            }
                            return (
                              <Badge variant="destructive">Неплатена</Badge>
                            );
                          }

                          const isPaid = paid >= total - 0.01 && total > 0;
                          const isPartial = paid > 0 && paid < total - 0.01;

                          if (isPaid) {
                            return <Badge variant="success">Платена</Badge>;
                          }
                          if (isPartial) {
                            return <Badge variant="warning">Частично</Badge>;
                          }
                          return <Badge variant="destructive">Неплатена</Badge>;
                        })()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {/* Status change dropdown — radix Portal-based, за
                              да не бъде клипнато от overflow-auto на Table
                              wrapper-a (последния ред на таблицата иначе
                              рендира dropdown-а извън viewport-a и излиза
                              само горната рамка). Анти-flip на radix го
                              отваря нагоре когато няма място отдолу. */}
                          {statusTransitions[order.status] && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={(e) => e.stopPropagation()}
                                  disabled={
                                    statusMutation.isPending ||
                                    fulfillMutation.isPending
                                  }
                                  title="Промени статуса"
                                  aria-label="Промени статуса"
                                >
                                  <ChevronDown className="h-3.5 w-3.5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align="end"
                                className="min-w-[160px]"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {statusTransitions[order.status].map(
                                  (transition) => (
                                    <DropdownMenuItem
                                      key={transition.value}
                                      className={
                                        transition.value === "cancelled"
                                          ? "text-red-600 focus:text-red-700"
                                          : ""
                                      }
                                      onSelect={() => {
                                        if (transition.value === "fulfilled") {
                                          handleFulfillClick(order.id);
                                        } else {
                                          statusMutation.mutate({
                                            id: order.id,
                                            status: transition.value,
                                          });
                                        }
                                      }}
                                    >
                                      {transition.label}
                                    </DropdownMenuItem>
                                  ),
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}

                          {/* Mark-arrived — awaiting child order whose
                              stock has come in. Flips status → confirmed
                              and order_date → today so the row joins the
                              day's orders for the second customer visit. */}
                          {(order.status as string) === "awaiting_stock" && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={(e) => {
                                e.stopPropagation();
                                markArrivedMutation.mutate(order.id);
                              }}
                              disabled={markArrivedMutation.isPending}
                              title="Стоката пристигна — прехвърли в днешните поръчки"
                              className="border-emerald-400 text-emerald-700 hover:bg-emerald-50"
                            >
                              📦 Пристигна
                            </Button>
                          )}

                          {/* Запиши плащане — показваме иконка при неплатена
                              поръчка (paid_amount < |total|). Cancelled и
                              quoted пропускаме (нямат payment obligation),
                              COD също — куриерът ще събере. Зам поръчките
                              сравняват срещу |total| (refund-нати са с
                              negative signed total). */}
                          {(() => {
                            const o = order as any;
                            if (
                              order.status === "cancelled" ||
                              order.status === "quoted"
                            )
                              return null;
                            if (o.has_cod_shipment === true) return null;
                            const total = parseFloat(
                              String(order.total_amount ?? 0),
                            );
                            const paid = parseFloat(String(o.paid_amount ?? 0));
                            const billed = o.is_replacement
                              ? Math.abs(total)
                              : total;
                            if (billed < 0.01) return null;
                            if (paid >= billed - 0.01) return null;
                            return (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPaymentOrder(order);
                                }}
                                title="Запиши плащане"
                                aria-label="Запиши плащане"
                                className="text-orange-600 hover:bg-orange-50"
                              >
                                <CreditCard className="h-3.5 w-3.5" />
                              </Button>
                            );
                          })()}

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

                          <OrderActionsMenu
                            order={order}
                            onRecordPayment={(o) => setPaymentOrder(o)}
                          />
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
        onRecordPayment={(o) => setPaymentOrder(o)}
      />

      {paymentOrder && (
        <RecordPaymentModal
          open
          onClose={() => setPaymentOrder(null)}
          context={
            paymentOrder.invoice_id
              ? {
                  kind: "invoice-fixed",
                  invoice_id: paymentOrder.invoice_id,
                  invoice_number: paymentOrder.invoice_number ?? undefined,
                  // Prefer the invoice partner override (Batch D —
                  // 'Издай на фирма' on an individual order) so the
                  // modal shows the actual invoice recipient instead
                  // of the order's original cash-customer row.
                  partner_name:
                    (paymentOrder as any).invoice_partner_name ??
                    paymentOrder.partner?.name ??
                    paymentOrder.partner_name ??
                    undefined,
                  total: Number(paymentOrder.total_amount),
                  order: paymentOrder,
                }
              : { kind: "order-fixed", order: paymentOrder }
          }
        />
      )}

      <OversellConfirmDialog
        open={!!pendingFulfillOversell}
        items={pendingFulfillOversell?.items ?? []}
        onCancel={() => setPendingFulfillOversell(null)}
        onConfirm={() => {
          const proceed = pendingFulfillOversell?.proceed;
          setPendingFulfillOversell(null);
          proceed?.();
        }}
      />
    </div>
  );
}
