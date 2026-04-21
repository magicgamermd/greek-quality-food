import React, { useState, useRef, useEffect } from "react";
import {
  useQueries,
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Camera,
  Upload,
  CheckCircle,
  AlertCircle,
  Eye,
  PackagePlus,
  Printer,
  Plus,
  Trash2,
  PenLine,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  buildDuplicateInvoiceCancelledMessage,
  buildDuplicateInvoiceConfirmMessage,
  type DuplicateInvoiceInfo,
} from "@/lib/incomingDuplicate";
import type {
  IncomingGoods as IncomingGoodsType,
  ScannedInvoice,
  ScannedInvoiceItem,
  Supplier,
} from "@/types";
import {
  formatDate,
  formatUnit,
  formatCurrency,
  getApiErrorMessage,
} from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { toast } from "@/lib/toast";
import { confirm } from "@/components/ConfirmDialog";
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { LoadingOverlay, ErrorMessage, Spinner } from "@/components/ui/spinner";
import { BakaliqLoader } from "@/components/BakaliqLoader";
import { HighlightMatch } from "@/lib/highlight";

function toNumberOr(value: unknown, fallback = 0): number {
  const num = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(num) ? num : fallback;
}

function toOptionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const num = Number.parseFloat(String(value));
  return Number.isFinite(num) ? num : null;
}

// Local helper: return `value` only after it has stayed unchanged for `delay`
// ms. Used to avoid spamming the product search endpoint on every keystroke.
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(handle);
  }, [value, delay]);
  return debounced;
}

async function fetchManualProductOptions(
  query: string,
): Promise<ManualRowProductOption[]> {
  const res = await api.get(
    `/products?search=${encodeURIComponent(query)}&limit=10&catalog=true`,
  );
  const raw = res.data;
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.data)
      ? raw.data
      : [];
  return rows
    .filter((row: any) => Number.isFinite(Number(row?.id)))
    .map(
      (row: any): ManualRowProductOption => ({
        id: Number(row.id),
        name_bg: row.name_bg ?? null,
        name_en: row.name_en ?? null,
        sku: row.sku ?? null,
        unit: row.unit ?? null,
        purchase_price: toOptionalNumber(row.purchase_price),
        selling_price: toOptionalNumber(row.selling_price),
      }),
    );
}

function isMatchedForAutoLink(item: ScannedInvoiceItem): boolean {
  if (item.matched_product_id == null) return false;
  if (item.match_source === "alias" || item.match_source === "sku") return true;
  return (item.match_confidence ?? 0) >= 0.75;
}

interface ManualRowProductOption {
  id: number;
  name_bg?: string | null;
  name_en?: string | null;
  sku?: string | null;
  unit?: string | null;
  purchase_price?: number | null;
  selling_price?: number | null;
}

function itemDisplayName(item: ScannedInvoiceItem): string {
  return (
    item.name_bg ||
    item.product_name_raw ||
    item.name_en ||
    item.product_name ||
    item.name ||
    "Неразпознат ред"
  );
}

function normalizeScannedInvoice(raw: any): ScannedInvoice {
  const sourceItems = Array.isArray(raw?.line_items)
    ? raw.line_items
    : Array.isArray(raw?.items)
      ? raw.items
      : [];

  const items: ScannedInvoiceItem[] = sourceItems.map((li: any) => {
    const productName =
      li.product_name_raw ?? li.product_name ?? li.name_en ?? li.name ?? "";
    const unitPrice = toNumberOr(li.unit_price ?? li.price, 0);
    const quantity = toNumberOr(li.quantity, 1) || 1;
    return {
      row_number: toOptionalNumber(li.row_number),
      page_number: toOptionalNumber(li.page_number),
      name: li.name_bg ?? productName,
      name_en: productName,
      name_bg: li.name_bg ?? productName,
      product_name: productName,
      product_name_raw: li.product_name_raw ?? productName,
      product_code: li.product_code ?? li.product_code_raw ?? null,
      product_code_raw: li.product_code_raw ?? li.product_code ?? null,
      quantity,
      unit: li.unit ?? "бр",
      price: unitPrice,
      unit_price: unitPrice,
      total: toOptionalNumber(li.total_price ?? li.total),
      brand: li.brand ?? null,
      category_hint: li.category_hint ?? null,
      product_id: li.product_id ?? null,
      matched_product_id: li.matched_product_id ?? null,
      matched_product_name: li.matched_product_name ?? null,
      matched_product_sku: li.matched_product_sku ?? null,
      match_confidence: toOptionalNumber(li.match_confidence),
      match_source: li.match_source ?? null,
      suggestions: Array.isArray(li.suggestions) ? li.suggestions : [],
      selling_price: toOptionalNumber(li.selling_price),
      matched_purchase_price: toOptionalNumber(li.matched_purchase_price),
      matched_selling_price: toOptionalNumber(li.matched_selling_price),
      gross_price: toOptionalNumber(li.gross_price),
      discount_percent: toOptionalNumber(li.discount_percent),
      discount_amount: toOptionalNumber(li.discount_amount),
    };
  });

  return {
    supplier_name: raw?.supplier_name ?? null,
    supplier_eik: raw?.supplier_eik ?? null,
    supplier_vat: raw?.supplier_vat ?? null,
    supplier_address: raw?.supplier_address ?? null,
    supplier_phone: raw?.supplier_phone ?? null,
    supplier_email: raw?.supplier_email ?? null,
    supplier_contact: raw?.supplier_contact ?? null,
    invoice_number: raw?.invoice_number ?? null,
    invoice_date: raw?.invoice_date ?? null,
    document_type: raw?.document_type ?? "invoice",
    total: toOptionalNumber(raw?.total ?? raw?.total_gross ?? raw?.total_net),
    currency: raw?.currency ?? "EUR",
    scanned_file_path: raw?.scanned_file_path,
    visible_row_count: toOptionalNumber(raw?.visible_row_count),
    extracted_row_count: toOptionalNumber(raw?.extracted_row_count),
    completeness_status:
      raw?.completeness_status === "complete" ||
      raw?.completeness_status === "suspicious" ||
      raw?.completeness_status === "incomplete"
        ? raw.completeness_status
        : null,
    warnings: Array.isArray(raw?.warnings)
      ? raw.warnings.map((w: any) => String(w))
      : [],
    needs_review: Boolean(raw?.needs_review),
    items,
  };
}

const statusLabels: Record<string, string> = {
  draft: "Чернова",
  pending: "Чакащо",
  confirmed: "Потвърдено",
  cancelled: "Отказано",
};
const statusVariants: Record<
  string,
  "secondary" | "warning" | "success" | "destructive"
> = {
  draft: "secondary",
  pending: "warning",
  confirmed: "success",
  cancelled: "destructive",
};

export function IncomingGoods() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualForm, setManualForm] = useState({
    supplier_id: "",
    invoice_number: "",
    invoice_date: new Date().toISOString().split("T")[0],
  });
  const [manualItems, setManualItems] = useState<
    {
      product_id?: number | null;
      product_name: string;
      quantity: string;
      unit_price: string;
      unit: string;
      original_purchase_price: number | null;
    }[]
  >([
    {
      product_id: null,
      product_name: "",
      quantity: "",
      unit_price: "",
      unit: "бр",
      original_purchase_price: null,
    },
  ]);
  // Rows the user has explicitly dismissed (Escape pressed, or picked a
  // product) — suppresses the result dropdown even if the debounced query
  // would otherwise return rows. Cleared whenever the user types again.
  const [manualSearchDismissed, setManualSearchDismissed] = useState<
    Record<number, boolean>
  >({});
  const [manualSearchHighlight, setManualSearchHighlight] = useState<
    Record<number, number>
  >({});
  const [manualError, setManualError] = useState("");
  const [newDeliveryMenu, setNewDeliveryMenu] = useState(false);
  const manualScrollRef = useRef<HTMLDivElement>(null);
  const invoiceNumberRef = useRef<HTMLInputElement>(null);
  const invoiceDateRef = useRef<HTMLInputElement>(null);
  const rowInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const pendingFocusRef = useRef<string | null>(null);

  const ROW_FIELD_ORDER = [
    "product",
    "quantity",
    "unit",
    "unit_price",
  ] as const;
  type RowField = (typeof ROW_FIELD_ORDER)[number];

  const focusRowField = (index: number, field: RowField) => {
    const key = `${index}:${field}`;
    const el = rowInputRefs.current[key];
    if (el) {
      el.focus();
      el.select?.();
      // Scroll the modal so the active field is visible.
      // For the product search field we center more aggressively to leave
      // room for the dropdown below it.
      const scrollContainer = manualScrollRef.current;
      if (scrollContainer) {
        const elRect = el.getBoundingClientRect();
        const containerRect = scrollContainer.getBoundingClientRect();
        const padding = field === "product" ? 240 : 80;
        // Above the visible area
        if (elRect.top < containerRect.top + 20) {
          scrollContainer.scrollBy({
            top: elRect.top - containerRect.top - 20,
            behavior: "smooth",
          });
        }
        // Below the visible area (add padding so dropdown is visible too)
        else if (elRect.bottom > containerRect.bottom - padding) {
          scrollContainer.scrollBy({
            top: elRect.bottom - containerRect.bottom + padding,
            behavior: "smooth",
          });
        }
      }
      return true;
    }
    return false;
  };

  // Apply pending focus after new row is rendered + auto-scroll modal
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    const key = pendingFocusRef.current;
    pendingFocusRef.current = null;
    const el = rowInputRefs.current[key];
    if (el) {
      el.focus();
      el.select?.();
      // Scroll the modal's container so the new row is visible
      if (manualScrollRef.current) {
        manualScrollRef.current.scrollTo({
          top: manualScrollRef.current.scrollHeight,
          behavior: "smooth",
        });
      }
    }
  }, [manualItems.length]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    const shouldOpenScan = params.get("scan") === "1";
    const shouldAutoPick = params.get("pick") === "1";

    if (!shouldOpenScan) return;

    setNewDeliveryMenu(false);
    setManualOpen(false);
    setScanOpen(true);

    const cleanUrl = `${window.location.pathname}${window.location.hash || ""}`;
    window.history.replaceState({}, "", cleanUrl);

    if (shouldAutoPick) {
      const timer = window.setTimeout(() => {
        fileRef.current?.click();
      }, 250);
      return () => window.clearTimeout(timer);
    }
  }, []);
  const [scanned, setScanned] = useState<ScannedInvoice | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [confirmData, setConfirmData] = useState<{
    supplier_id: string;
    invoice_number: string;
    invoice_date: string;
  }>({ supplier_id: "", invoice_number: "", invoice_date: "" });
  const [itemPrices, setItemPrices] = useState<Record<number, number>>({});

  // Date — default today only; history mode allows custom range
  const today = new Date().toISOString().split("T")[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  const [showHistory, setShowHistory] = useState(false);
  const [dateFrom, setDateFrom] = useState(thirtyDaysAgo);
  const [dateTo, setDateTo] = useState(today);
  const [selectedDoc, setSelectedDoc] = useState<IncomingGoodsType | null>(
    null,
  );
  const [docDetails, setDocDetails] = useState<any[]>([]);
  const [loadingDetails, setLoadingDetails] = useState(false);
  // Local editable copy for pending-delivery edits
  const [editItems, setEditItems] = useState<any[]>([]);
  const [editHeader, setEditHeader] = useState<{
    supplier_id: string;
    invoice_number: string;
    invoice_date: string;
  }>({ supplier_id: "", invoice_number: "", invoice_date: "" });
  // `editSaving` / `editError` are derived from the saveEditChangesMutation
  // (isPending / error). See saveEditChangesMutation below.
  const [cancelReason, setCancelReason] = useState("");
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [rowSearchInput, setRowSearchInput] = useState<Record<number, string>>(
    {},
  );
  const [rowSearchResults, setRowSearchResults] = useState<
    Record<number, ManualRowProductOption[]>
  >({});
  const [rowSelectedProductId, setRowSelectedProductId] = useState<
    Record<number, number | null>
  >({});
  const [rowSearchLoading, setRowSearchLoading] = useState<
    Record<number, boolean>
  >({});
  const [rowSearchError, setRowSearchError] = useState<Record<number, string>>(
    {},
  );
  const [rowMappingOpen, setRowMappingOpen] = useState<Record<number, boolean>>(
    {},
  );
  const [rowCreateLoading, setRowCreateLoading] = useState<
    Record<number, boolean>
  >({});
  const [rowCreateError, setRowCreateError] = useState<Record<number, string>>(
    {},
  );

  const resetManualResolveState = () => {
    setRowSearchInput({});
    setRowSearchResults({});
    setRowSelectedProductId({});
    setRowSearchLoading({});
    setRowSearchError({});
    setRowMappingOpen({});
    setRowCreateLoading({});
    setRowCreateError({});
  };

  const resetManualEntry = () => {
    setManualForm({
      supplier_id: "",
      invoice_number: "",
      invoice_date: new Date().toISOString().split("T")[0],
    });
    setManualItems([
      {
        product_id: null,
        product_name: "",
        quantity: "",
        unit_price: "",
        unit: "бр",
        original_purchase_price: null,
      },
    ]);
    setManualSearchDismissed({});
    setManualSearchHighlight({});
    setManualError("");
  };

  const setDefaultSearchFromScanned = (invoice: ScannedInvoice) => {
    const defaults: Record<number, string> = {};
    const openState: Record<number, boolean> = {};
    (invoice.items ?? []).forEach((item, index) => {
      defaults[index] = item.matched_product_name || itemDisplayName(item);
      openState[index] = !isMatchedForAutoLink(item) && item.product_id == null;
    });
    setRowSearchInput(defaults);
    setRowMappingOpen(openState);
  };

  const bindProductToRow = (
    rowIndex: number,
    product: ManualRowProductOption,
  ) => {
    setScanned((current) => {
      if (!current) return current;
      return {
        ...current,
        items: current.items.map((item, index) =>
          index === rowIndex
            ? {
                ...item,
                product_id: product.id,
                matched_product_id: product.id,
                matched_product_name:
                  product.name_bg || product.name_en || itemDisplayName(item),
                matched_product_sku: product.sku ?? null,
                match_confidence: 1,
                match_source: "manual",
                selling_price:
                  item.selling_price ?? product.selling_price ?? null,
              }
            : item,
        ),
      };
    });

    setRowSearchError((current) => ({ ...current, [rowIndex]: "" }));
    setRowCreateError((current) => ({ ...current, [rowIndex]: "" }));
    setRowSearchResults((current) => ({ ...current, [rowIndex]: [] }));
    setRowSelectedProductId((current) => ({
      ...current,
      [rowIndex]: product.id,
    }));
    setRowSearchInput((current) => ({
      ...current,
      [rowIndex]: product.name_bg || product.name_en || product.sku || "",
    }));
    setRowMappingOpen((current) => ({ ...current, [rowIndex]: false }));
  };

  const updateRowSellingPrice = (rowIndex: number, value: string) => {
    setScanned((current) => {
      if (!current) return current;
      return {
        ...current,
        items: current.items.map((item, index) =>
          index === rowIndex
            ? {
                ...item,
                selling_price: value === "" ? null : toOptionalNumber(value),
              }
            : item,
        ),
      };
    });
  };

  const fetchProductsForRow = async (rowIndex: number) => {
    const query = (rowSearchInput[rowIndex] || "").trim();
    if (query.length < 2) {
      setRowSearchError((current) => ({
        ...current,
        [rowIndex]: "Въведете поне 2 символа за търсене.",
      }));
      setRowSearchResults((current) => ({ ...current, [rowIndex]: [] }));
      setRowSelectedProductId((current) => ({ ...current, [rowIndex]: null }));
      return;
    }

    setRowSearchError((current) => ({ ...current, [rowIndex]: "" }));
    setRowSearchLoading((current) => ({ ...current, [rowIndex]: true }));
    try {
      const res = await api.get(
        `/products?search=${encodeURIComponent(query)}&limit=10`,
      );
      const raw = res.data;
      const rows = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.data)
          ? raw.data
          : [];
      const products: ManualRowProductOption[] = rows
        .filter((row: any) => Number.isFinite(Number(row?.id)))
        .map((row: any) => ({
          id: Number(row.id),
          name_bg: row.name_bg ?? null,
          name_en: row.name_en ?? null,
          sku: row.sku ?? null,
          unit: row.unit ?? null,
          purchase_price: toOptionalNumber(row.purchase_price),
          selling_price: toOptionalNumber(row.selling_price),
        }));

      setRowSearchResults((current) => ({ ...current, [rowIndex]: products }));
      setRowSelectedProductId((current) => ({
        ...current,
        [rowIndex]:
          current[rowIndex] ?? (products.length > 0 ? products[0].id : null),
      }));

      if (products.length === 0) {
        setRowSearchError((current) => ({
          ...current,
          [rowIndex]: "Няма намерени продукти.",
        }));
      }
    } catch (error: any) {
      const message =
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        "Грешка при търсене на продукти.";
      setRowSearchResults((current) => ({ ...current, [rowIndex]: [] }));
      setRowSelectedProductId((current) => ({ ...current, [rowIndex]: null }));
      setRowSearchError((current) => ({ ...current, [rowIndex]: message }));
    } finally {
      setRowSearchLoading((current) => ({ ...current, [rowIndex]: false }));
    }
  };

  const bindSelectedProductForRow = (rowIndex: number) => {
    const selectedId = rowSelectedProductId[rowIndex];
    if (!selectedId) {
      setRowSearchError((current) => ({
        ...current,
        [rowIndex]: "Изберете продукт от резултатите.",
      }));
      return;
    }

    const selected = (rowSearchResults[rowIndex] ?? []).find(
      (product) => product.id === selectedId,
    );
    if (!selected) {
      setRowSearchError((current) => ({
        ...current,
        [rowIndex]: "Избраният продукт не е намерен в текущите резултати.",
      }));
      return;
    }
    bindProductToRow(rowIndex, selected);
  };

  const createProductForRow = async (rowIndex: number) => {
    if (!scanned) return;
    const item = scanned.items[rowIndex];
    if (!item) return;

    setRowCreateError((current) => ({ ...current, [rowIndex]: "" }));
    setRowCreateLoading((current) => ({ ...current, [rowIndex]: true }));
    try {
      const rowName = itemDisplayName(item);
      const nameBg = item.name_bg?.trim() || rowName;
      const nameEn =
        item.name_en?.trim() || item.product_name?.trim() || rowName;
      const unit = item.unit?.trim() || "pcs";
      const purchasePrice = Number(item.unit_price ?? item.price ?? 0);
      const sellingPrice = Number(item.selling_price ?? 0);

      const skuResponse = await api.get("/products/next-sku");
      const nextSku = String(skuResponse.data?.next_sku ?? "").trim();
      if (!nextSku) {
        throw new Error("Неуспешно генериране на SKU.");
      }

      const createdResponse = await api.post("/products", {
        name_bg: nameBg,
        name_en: nameEn,
        sku: nextSku,
        unit,
        category_id: null,
        low_stock_threshold: 10,
        brand: item.brand || null,
        purchase_price: purchasePrice > 0 ? purchasePrice : null,
        selling_price: sellingPrice > 0 ? sellingPrice : null,
      });

      const created = createdResponse.data ?? {};
      const createdProduct: ManualRowProductOption = {
        id: Number(created.id),
        name_bg: created.name_bg ?? nameBg,
        name_en: created.name_en ?? nameEn,
        sku: created.sku ?? nextSku,
        unit: created.unit ?? unit,
        purchase_price: toOptionalNumber(created.purchase_price),
        selling_price: toOptionalNumber(created.selling_price),
      };
      if (!Number.isFinite(createdProduct.id)) {
        throw new Error("Създаденият продукт няма валиден идентификатор.");
      }

      bindProductToRow(rowIndex, createdProduct);
      setRowSearchResults((current) => ({
        ...current,
        [rowIndex]: [
          createdProduct,
          ...(current[rowIndex] ?? []).filter(
            (product) => product.id !== createdProduct.id,
          ),
        ],
      }));
    } catch (error: any) {
      const message =
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        error?.message ||
        "Неуспешно създаване на продукт.";
      setRowCreateError((current) => ({ ...current, [rowIndex]: message }));
    } finally {
      setRowCreateLoading((current) => ({ ...current, [rowIndex]: false }));
    }
  };

  // In normal mode show only today; in history mode use date range
  const activeDateFrom = showHistory ? dateFrom : today;
  const activeDateTo = showHistory ? dateTo : today;

  const {
    data: incoming = [],
    isLoading,
    error,
  } = useQuery<IncomingGoodsType[]>({
    queryKey: ["incoming", activeDateFrom, activeDateTo],
    queryFn: () =>
      api
        .get(`/incoming?date_from=${activeDateFrom}&date_to=${activeDateTo}`)
        .then((r) => {
          const d = r.data;
          return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
        }),
    // Auto-refresh policy — overrides global defaults (see App.tsx) so that
    // a new delivery created anywhere (Owner PWA, another browser tab, or
    // this tab) appears here without a manual reload:
    //   • refetchInterval      → poll every 15s while the tab is visible
    //   • refetchIntervalInBackground=false → no polling when tab is hidden
    //   • refetchOnMount: "always" → re-query every time we land on the page
    //   • refetchOnWindowFocus → catch "tab regained focus" after saving
    //   • staleTime: 0 → data is always considered stale, so the fetches above
    //     actually go to network instead of reusing the cache
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  const handleRowClick = async (doc: IncomingGoodsType) => {
    setDocDetails([]); // clear before open
    setEditItems([]);
    saveEditChangesMutation.reset();
    cancelIncomingDelivery.reset();
    setShowCancelConfirm(false);
    setCancelReason("");
    setLoadingDetails(true); // spinner first — avoid "no details" flash
    setSelectedDoc(doc); // open modal
    setEditHeader({
      supplier_id: String(doc.supplier_id ?? ""),
      invoice_number: doc.invoice_number ?? "",
      invoice_date: doc.invoice_date
        ? String(doc.invoice_date).split("T")[0]
        : "",
    });
    try {
      const res = await api.get(`/incoming/${doc.id}`);
      const items = res.data?.items ?? res.data?.data?.items ?? [];
      const arr = Array.isArray(items) ? items : [];
      setDocDetails(arr);
      setEditItems(
        arr.map((item: any) => {
          // Prefer the selling_price saved WITH this delivery (what was set
          // at scan time). Fall back to the current catalog price if empty.
          const savedSelling =
            item.selling_price != null && String(item.selling_price) !== ""
              ? String(item.selling_price)
              : item.product_selling_price != null
                ? String(item.product_selling_price)
                : "";
          const dbSelling = savedSelling;
          return {
            id: item.id,
            product_id: item.product_id,
            product_name:
              item.name_bg ||
              item.product_name_raw ||
              item.product_name ||
              `#${item.product_id ?? "?"}`,
            quantity: String(item.quantity ?? ""),
            unit_price: String(item.unit_price ?? ""),
            // Selling price from product — editable here, synced back to
            // products table on save.
            selling_price: dbSelling,
            selling_price_db: dbSelling,
            unit: item.unit || "бр",
            // Dirty flags
            dirty: false,
            toDelete: false,
          };
        }),
      );
    } catch (e) {
      console.error("Failed to load delivery details:", e);
      setDocDetails([]);
      setEditItems([]);
    } finally {
      setLoadingDetails(false);
    }
  };

  const closeDetailsModal = () => {
    setSelectedDoc(null);
    setDocDetails([]);
    setEditItems([]);
    saveEditChangesMutation.reset();
    cancelIncomingDelivery.reset();
    setShowCancelConfirm(false);
    setCancelReason("");
  };

  const saveEditChangesMutation = useMutation({
    mutationFn: async () => {
      if (!selectedDoc) throw new Error("No doc selected");

      // Delete marked items
      const toDelete = editItems.filter((i) => i.toDelete && i.id);
      for (const item of toDelete) {
        await api.delete(`/incoming/${selectedDoc.id}/items/${item.id}`);
      }

      // Update header if changed
      const headerPayload: Record<string, any> = {};
      if (
        editHeader.supplier_id &&
        Number(editHeader.supplier_id) !== Number(selectedDoc.supplier_id ?? 0)
      ) {
        headerPayload.supplier_id = Number(editHeader.supplier_id);
      }
      if (
        (editHeader.invoice_number || "") !== (selectedDoc.invoice_number ?? "")
      ) {
        headerPayload.invoice_number = editHeader.invoice_number || null;
      }
      const selectedDate = selectedDoc.invoice_date
        ? String(selectedDoc.invoice_date).split("T")[0]
        : "";
      if (editHeader.invoice_date !== selectedDate) {
        headerPayload.invoice_date = editHeader.invoice_date || null;
      }
      if (Object.keys(headerPayload).length > 0) {
        await api.patch(`/incoming/${selectedDoc.id}`, headerPayload);
      }

      // Update items (dirty only)
      const dirty = editItems
        .filter((i) => i.dirty && !i.toDelete && i.id)
        .map((i) => ({
          id: i.id,
          quantity: Number(i.quantity),
          unit_price: Number(i.unit_price || 0),
        }));
      if (dirty.length > 0) {
        await api.patch(`/incoming/${selectedDoc.id}/items`, { items: dirty });
      }

      // Sync changed selling prices back to the products catalog.
      // Each row has selling_price (editable) + selling_price_db (snapshot);
      // if they differ AND the row has a product_id, patch the product.
      const priceUpdates = editItems.filter((i) => {
        if (i.toDelete || !i.product_id) return false;
        const curr = String(i.selling_price ?? "").trim();
        const prev = String(i.selling_price_db ?? "").trim();
        if (curr === prev) return false;
        const num = parseFloat(curr);
        return Number.isFinite(num) && num >= 0;
      });
      if (priceUpdates.length > 0) {
        await Promise.allSettled(
          priceUpdates.map((i) =>
            api.put(`/products/${i.product_id}`, {
              selling_price: Number(i.selling_price),
            }),
          ),
        );
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["incoming"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });

  const editSaving = saveEditChangesMutation.isPending;

  // Thin wrapper so callers keep the old `Promise<boolean>` contract while
  // the actual work lives in the mutation above.
  const saveEditChanges = async (): Promise<boolean> => {
    if (!selectedDoc) return false;
    try {
      await saveEditChangesMutation.mutateAsync();
      return true;
    } catch {
      return false;
    }
  };

  const cancelIncomingDelivery = useMutation({
    mutationFn: async () => {
      if (!selectedDoc) throw new Error("No doc selected");
      await api.put(`/incoming/${selectedDoc.id}/cancel`, {
        reason: cancelReason.trim() || undefined,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["incoming"] });
      closeDetailsModal();
    },
  });

  // Surface whichever of the two detail-modal mutations most recently errored.
  const editError = saveEditChangesMutation.error
    ? getApiErrorMessage(
        saveEditChangesMutation.error,
        "Неуспешно записване на промените.",
      )
    : cancelIncomingDelivery.error
      ? getApiErrorMessage(
          cancelIncomingDelivery.error,
          "Неуспешно отказване на доставката.",
        )
      : "";

  const confirmFromDetailsModal = async () => {
    if (!selectedDoc) return;
    saveEditChangesMutation.reset();
    cancelIncomingDelivery.reset();
    const hasPendingChanges = editItems.some((i) => i.dirty || i.toDelete);
    if (hasPendingChanges) {
      const ok = await saveEditChanges();
      if (!ok) return;
    }
    confirmIncomingMutation.mutate(selectedDoc.id, {
      onSuccess: () => {
        closeDetailsModal();
      },
    });
  };

  // Close "new delivery" dropdown on outside click
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!newDeliveryMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setNewDeliveryMenu(false);
      }
    };
    // Use mousedown so it fires before the button's onClick toggle
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [newDeliveryMenu]);

  const { data: suppliers = [] } = useQuery<Supplier[]>({
    queryKey: ["suppliers"],
    queryFn: () =>
      api.get("/suppliers").then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      }),
  });

  const handleFileUpload = async (file: File) => {
    setScanning(true);
    setScanError("");
    setScanned(null);
    resetManualResolveState();
    try {
      // Stage 1: lightweight duplicate pre-check (same flow as Android)
      try {
        const quickForm = new FormData();
        quickForm.append("file", file);
        const quickRes = await api.post(
          "/incoming/quick-invoice-check",
          quickForm,
          {
            headers: { "Content-Type": "multipart/form-data" },
            timeout: 30000,
          },
        );
        const invoiceNumber = quickRes.data?.invoice_number as
          | string
          | undefined;
        if (invoiceNumber) {
          const dupCheck = await api.get(
            `/incoming/check-duplicate?invoice_number=${encodeURIComponent(invoiceNumber)}`,
          );
          if (dupCheck.data?.duplicate) {
            const duplicatePayload = dupCheck.data as DuplicateInvoiceInfo;
            const shouldContinue = await confirm({
              title: "Дублирана фактура",
              description: buildDuplicateInvoiceConfirmMessage(
                invoiceNumber,
                duplicatePayload,
              ),
              confirmText: "Продължи",
              variant: "danger",
            });
            if (!shouldContinue) {
              setScanError(
                buildDuplicateInvoiceCancelledMessage(invoiceNumber),
              );
              return;
            }
          }
        }
      } catch {
        // Quick check is best-effort — continue to full scan
      }

      // Stage 2: full OCR scan
      const formData = new FormData();
      formData.append("file", file);
      const res = await api.post("/incoming/scan", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 120000,
      });
      const normalized = normalizeScannedInvoice(res.data ?? {});
      let enriched = normalized;
      if ((normalized.items ?? []).length > 0) {
        try {
          const preview = await api.post("/incoming/match-preview", {
            supplier_name: normalized.supplier_name ?? null,
            supplier_eik: normalized.supplier_eik ?? null,
            items: normalized.items.map((item) => ({
              name: item.name,
              name_en: item.name_en,
              name_bg: item.name_bg,
              product_name: item.product_name,
              product_name_raw: item.product_name_raw,
              product_code: item.product_code,
              product_code_raw: item.product_code_raw,
              quantity: item.quantity,
              unit_price: item.unit_price ?? item.price,
              price: item.price,
            })),
          });
          const matches = Array.isArray(preview.data?.matches)
            ? preview.data.matches
            : [];
          if (matches.length > 0) {
            enriched = {
              ...normalized,
              items: normalized.items.map((item, idx) => {
                const match = matches[idx] ?? {};
                return {
                  ...item,
                  matched_product_id: match.matched_product_id ?? null,
                  matched_product_name: match.matched_product_name ?? null,
                  matched_product_sku: match.matched_product_sku ?? null,
                  match_confidence: toOptionalNumber(match.confidence),
                  match_source: match.match_source ?? "none",
                  suggestions: Array.isArray(match.suggestions)
                    ? match.suggestions
                    : [],
                  matched_purchase_price: toOptionalNumber(
                    match.matched_purchase_price,
                  ),
                  matched_selling_price: toOptionalNumber(
                    match.matched_selling_price,
                  ),
                };
              }),
            };
          }
        } catch {
          // Matching preview is best-effort; extraction flow should continue.
        }
      }
      setScanned(enriched);
      setDefaultSearchFromScanned(enriched);
      if (enriched.invoice_number) {
        setConfirmData((c) => ({
          ...c,
          invoice_number: enriched.invoice_number ?? "",
        }));
      }
      if (enriched.invoice_date) {
        setConfirmData((c) => ({
          ...c,
          invoice_date: (enriched.invoice_date ?? "").split("T")[0],
        }));
      }
    } catch (err: any) {
      const detail =
        err?.response?.data?.detail ||
        err?.response?.data?.message ||
        err?.response?.data?.error;
      setScanError(
        detail
          ? `Грешка при сканиране: ${detail}`
          : "Грешка при сканиране на документа",
      );
    } finally {
      setScanning(false);
    }
  };

  const confirmMutation = useMutation({
    mutationFn: async () => {
      // Create incoming document with editable unit prices
      const doc = await api.post("/incoming", {
        ...confirmData,
        supplier_id: Number(confirmData.supplier_id) || undefined,
        supplier_name: scanned?.supplier_name ?? undefined,
        supplier_eik: scanned?.supplier_eik ?? undefined,
        supplier_vat: scanned?.supplier_vat ?? undefined,
        supplier_address: scanned?.supplier_address ?? undefined,
        supplier_phone: scanned?.supplier_phone ?? undefined,
        supplier_email: scanned?.supplier_email ?? undefined,
        supplier_contact: scanned?.supplier_contact ?? undefined,
        document_type: "invoice",
        scanned_file_path: scanned?.scanned_file_path ?? undefined,
        items: (scanned?.items ?? []).map((item, i) => {
          const matched = isMatchedForAutoLink(item);
          return {
            ...(matched ? { product_id: item.matched_product_id } : {}),
            product_name: item.name_en || item.product_name || item.name, // original invoice name (Greek/EN)
            name_bg: item.name_bg || item.name || item.product_name, // Bulgarian translation
            brand: item.brand ?? undefined,
            category_hint: item.category_hint ?? undefined,
            unit: item.unit ?? undefined,
            quantity: item.quantity,
            unit_price: itemPrices[i] ?? item.unit_price ?? item.price ?? 0,
            selling_price:
              item.selling_price != null ? item.selling_price : undefined,
          };
        }),
      });
      return doc.data;
    },
    onSuccess: async (doc) => {
      // Auto-confirm the delivery so inventory is updated immediately
      try {
        await api.put(`/incoming/${doc.id}/confirm`);
      } catch (error) {
        toast.error(
          getApiErrorMessage(
            error,
            "Доставката е записана, но потвърждението не успя. Наличността може да не е обновена.",
          ),
        );
      }
      qc.invalidateQueries({ queryKey: ["incoming"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      setScanOpen(false);
      setScanned(null);
      setItemPrices({});
      toast.success("Доставката е записана успешно.");
    },
    onError: (err: any) => {
      const data = err?.response?.data;
      if (data?.error === "duplicate_invoice") {
        setScanError(`⚠️ ${data.message}`);
      }
    },
  });

  // Debounced snapshot of the editable query per manual row. Drives the
  // useQueries below — typing settles before we fire a network request.
  const manualQueryStrings = manualItems.map((item) =>
    item.product_id ? "" : item.product_name.trim(),
  );
  const debouncedManualQueryKey = useDebouncedValue(
    manualQueryStrings.join("§"),
    250,
  );
  const debouncedManualQueries = React.useMemo(
    () => debouncedManualQueryKey.split("§"),
    [debouncedManualQueryKey],
  );

  const manualSearchQueries = useQueries({
    queries: manualItems.map((_item, index) => {
      const query = debouncedManualQueries[index] ?? "";
      return {
        queryKey: ["manual-product-search", query],
        queryFn: () => fetchManualProductOptions(query),
        enabled: query.length >= 2,
        staleTime: 30_000,
      };
    }),
  });

  const getManualSearchResults = (
    rowIndex: number,
  ): ManualRowProductOption[] => {
    if (manualSearchDismissed[rowIndex]) return [];
    if (manualItems[rowIndex]?.product_id) return [];
    return manualSearchQueries[rowIndex]?.data ?? [];
  };

  const getManualSearchLoading = (rowIndex: number): boolean => {
    if (manualSearchDismissed[rowIndex]) return false;
    if (manualItems[rowIndex]?.product_id) return false;
    const q = manualSearchQueries[rowIndex];
    return Boolean(q?.isFetching);
  };

  const getManualSearchError = (rowIndex: number): string => {
    if (manualSearchDismissed[rowIndex]) return "";
    if (manualItems[rowIndex]?.product_id) return "";
    const q = manualSearchQueries[rowIndex];
    if (!q) return "";
    if (q.isError) {
      const err = q.error as any;
      return (
        err?.response?.data?.message ||
        err?.response?.data?.error ||
        "Грешка при търсене на продукти."
      );
    }
    if (q.isSuccess && (q.data?.length ?? 0) === 0) {
      const query = debouncedManualQueries[rowIndex] ?? "";
      if (query.length >= 2) return "Няма намерени продукти.";
    }
    return "";
  };

  const selectManualProduct = (
    rowIndex: number,
    product: ManualRowProductOption,
  ) => {
    setManualItems((current) =>
      current.map((entry, entryIndex) => {
        if (entryIndex !== rowIndex) return entry;
        const purchasePrice =
          typeof product.purchase_price === "number" &&
          Number.isFinite(product.purchase_price)
            ? product.purchase_price
            : null;
        // Only overwrite price if user hasn't typed one yet
        const shouldPrefillPrice =
          (!entry.unit_price || entry.unit_price === "0") &&
          purchasePrice !== null;
        return {
          ...entry,
          product_id: product.id,
          product_name:
            product.name_bg ||
            product.name_en ||
            product.sku ||
            entry.product_name,
          unit: product.unit || entry.unit,
          unit_price: shouldPrefillPrice
            ? String(purchasePrice)
            : entry.unit_price,
          original_purchase_price: purchasePrice,
        };
      }),
    );
    setManualSearchDismissed((current) => ({ ...current, [rowIndex]: true }));
    // Focus the quantity field after picking a product
    setTimeout(() => focusRowField(rowIndex, "quantity"), 0);
  };

  const addManualRow = (focusIndex?: number) => {
    setManualItems((current) => {
      const next = [
        ...current,
        {
          product_id: null,
          product_name: "",
          quantity: "",
          unit_price: "",
          unit: "бр",
          original_purchase_price: null,
        },
      ];
      pendingFocusRef.current = `${focusIndex ?? next.length - 1}:product`;
      return next;
    });
  };

  const handleRowFieldEnter = (
    e: React.KeyboardEvent<HTMLInputElement>,
    index: number,
    field: RowField,
  ) => {
    // Product field has richer keyboard handling (↑ ↓ Enter)
    if (field === "product") {
      const results = getManualSearchResults(index);
      const highlighted = manualSearchHighlight[index] ?? 0;

      if (e.key === "ArrowDown" && results.length > 0) {
        e.preventDefault();
        setManualSearchHighlight((current) => ({
          ...current,
          [index]: Math.min(highlighted + 1, results.length - 1),
        }));
        return;
      }
      if (e.key === "ArrowUp" && results.length > 0) {
        e.preventDefault();
        setManualSearchHighlight((current) => ({
          ...current,
          [index]: Math.max(highlighted - 1, 0),
        }));
        return;
      }
      if (e.key === "Escape" && results.length > 0) {
        e.preventDefault();
        setManualSearchDismissed((current) => ({ ...current, [index]: true }));
        return;
      }
      if (e.key === "Enter") {
        if (results.length > 0 && !manualItems[index]?.product_id) {
          e.preventDefault();
          const pick = results[highlighted] ?? results[0];
          selectManualProduct(index, pick);
          return;
        }
        if (manualItems[index]?.product_id) {
          e.preventDefault();
          focusRowField(index, "quantity");
        }
      }
      return;
    }

    if (e.key !== "Enter") return;
    e.preventDefault();

    const currentPos = ROW_FIELD_ORDER.indexOf(field);
    const nextField = ROW_FIELD_ORDER[currentPos + 1];

    if (nextField) {
      focusRowField(index, nextField);
      return;
    }

    // Last field — add new row (if this is the last row) or go to next row's product
    const isLastRow = index === manualItems.length - 1;
    if (isLastRow) {
      addManualRow(index + 1);
    } else {
      focusRowField(index + 1, "product");
    }
  };

  const manualCreateMutation = useMutation({
    mutationFn: async () => {
      const supplierId = Number(manualForm.supplier_id);
      if (!supplierId) {
        throw new Error("Изберете доставчик.");
      }

      const items = manualItems
        .map((item) => ({
          ...(item.product_id ? { product_id: item.product_id } : {}),
          product_name: item.product_name.trim(),
          name_bg: item.product_name.trim(),
          quantity: Number(item.quantity),
          unit_price: Number(item.unit_price || 0),
          unit: item.unit.trim() || "бр",
        }))
        .filter((item) => item.product_name);

      if (items.length === 0) {
        throw new Error("Добавете поне един артикул.");
      }

      if (
        items.some(
          (item) => !Number.isFinite(item.quantity) || item.quantity <= 0,
        )
      ) {
        throw new Error(
          "Количеството трябва да е положително число за всеки артикул.",
        );
      }

      if (
        items.some(
          (item) => !Number.isFinite(item.unit_price) || item.unit_price < 0,
        )
      ) {
        throw new Error(
          "Ед. цена трябва да е неотрицателно число за всеки артикул.",
        );
      }

      const response = await api.post("/incoming", {
        supplier_id: supplierId,
        invoice_number: manualForm.invoice_number.trim() || undefined,
        invoice_date: manualForm.invoice_date || undefined,
        document_type: "invoice",
        items,
      });

      // Propagate price changes back to the master products table
      const priceUpdates = manualItems
        .filter((item) => {
          if (!item.product_id) return false;
          const newPrice = Number(item.unit_price);
          if (!Number.isFinite(newPrice) || newPrice <= 0) return false;
          const old = item.original_purchase_price;
          // Update if product had no price, or if price differs (>0.01 BGN)
          if (old == null) return true;
          return Math.abs(newPrice - old) > 0.005;
        })
        .map((item) =>
          api
            .put(`/products/${item.product_id}`, {
              purchase_price: Number(item.unit_price),
            })
            .catch((err) => {
              // Non-fatal — delivery is already saved
              console.warn(
                `Failed to update purchase_price for product ${item.product_id}`,
                err,
              );
            }),
        );
      if (priceUpdates.length > 0) {
        await Promise.all(priceUpdates);
      }

      return response.data;
    },
    onMutate: () => {
      setManualError("");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["incoming"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      setManualOpen(false);
      resetManualEntry();
    },
    onError: (error) => {
      setManualError(
        getApiErrorMessage(error, "Неуспешно записване на доставката."),
      );
    },
  });

  const confirmIncomingMutation = useMutation({
    mutationFn: (id: number) => api.put(`/incoming/${id}/confirm`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["incoming"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });

  const handlePrintReceipt = async (id: number) => {
    try {
      const res = await api.get(`/incoming/${id}/receipt`, {
        responseType: "blob",
      });
      const blob = new Blob([res.data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
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
      toast.error("Грешка при отваряне на разписката за печат");
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Приемане на стоки
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            Сканиране и приемане на доставки
          </p>
        </div>
        <div className="relative" ref={menuRef}>
          <Button onClick={() => setNewDeliveryMenu((v) => !v)}>
            <PackagePlus className="h-4 w-4" />
            Нова доставка
          </Button>
          {newDeliveryMenu && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-white border rounded-lg shadow-lg py-1 min-w-[200px]">
              <button
                className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-2"
                onClick={() => {
                  setScanError("");
                  setScanned(null);
                  setItemPrices({});
                  setScanOpen(true);
                  setNewDeliveryMenu(false);
                }}
              >
                <Camera className="h-4 w-4 text-[#f97316]" />
                Сканиране на документ
              </button>
              <button
                className="w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 flex items-center gap-2"
                onClick={() => {
                  setManualOpen(true);
                  setNewDeliveryMenu(false);
                }}
              >
                <PenLine className="h-4 w-4 text-emerald-600" />
                Ръчно въвеждане
              </button>
            </div>
          )}
        </div>
      </div>

      {/* History */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>
              {showHistory
                ? "📋 История на доставките"
                : `📦 Днешни доставки — ${new Date().toLocaleDateString("bg-BG")}`}
            </CardTitle>
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
                  <TableHead>Документ №</TableHead>
                  <TableHead>Доставчик</TableHead>
                  <TableHead>Дата</TableHead>
                  <TableHead>Тип</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead className="text-right">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {incoming.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="text-center text-gray-400 py-8"
                    >
                      Няма доставки
                    </TableCell>
                  </TableRow>
                ) : (
                  incoming.map((doc) => (
                    <TableRow
                      key={doc.id}
                      className="cursor-pointer hover:bg-blue-50/10"
                      onClick={() => handleRowClick(doc)}
                    >
                      <TableCell className="font-mono font-medium">
                        {doc.invoice_number || `#${doc.id}`}
                      </TableCell>
                      <TableCell>
                        {doc.supplier?.name ??
                          doc.supplier_name ??
                          (doc.supplier_id
                            ? `Доставчик #${doc.supplier_id}`
                            : "—")}
                      </TableCell>
                      <TableCell>{formatDate(doc.invoice_date)}</TableCell>
                      <TableCell>{doc.document_type}</TableCell>
                      <TableCell>
                        <Badge
                          variant={statusVariants[doc.status] ?? "secondary"}
                        >
                          {statusLabels[doc.status] ?? doc.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              handlePrintReceipt(doc.id);
                            }}
                            title="Разписка"
                            disabled={doc.status !== "confirmed"}
                          >
                            <Printer className="h-4 w-4" />
                          </Button>
                          {doc.status === "pending" && (
                            <Button
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                confirmIncomingMutation.mutate(doc.id);
                              }}
                              disabled={confirmIncomingMutation.isPending}
                            >
                              <CheckCircle className="h-4 w-4" />
                              Потвърди
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

      {/* Details / Edit Modal — triggered by row click */}
      <Dialog
        open={!!selectedDoc}
        onOpenChange={(open) => {
          if (!open) closeDetailsModal();
        }}
      >
        <DialogContent className="sm:max-w-[98vw] lg:max-w-[1680px] max-h-[92vh] overflow-hidden flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5 text-blue-600" />
              Доставка{" "}
              {selectedDoc?.invoice_number
                ? `№ ${selectedDoc.invoice_number}`
                : `#${selectedDoc?.id ?? ""}`}
              {selectedDoc?.status && (
                <Badge
                  variant={statusVariants[selectedDoc.status] ?? "secondary"}
                >
                  {statusLabels[selectedDoc.status] ?? selectedDoc.status}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              {selectedDoc?.status === "pending"
                ? "Провери и редактирай артикулите преди потвърждение."
                : "Детайли на доставката."}
            </DialogDescription>
          </DialogHeader>

          {editError && <ErrorMessage message={editError} />}

          <div className="flex-1 overflow-y-auto min-h-0 space-y-4 pr-1">
            {loadingDetails ? (
              <div className="flex items-center justify-center py-10">
                <Spinner size="md" />
              </div>
            ) : (
              <>
                {/* Header — editable for pending, readonly otherwise */}
                {selectedDoc?.status === "pending" ? (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-1.5">
                      <Label>Доставчик</Label>
                      <Combobox
                        items={suppliers.map((s) => ({
                          value: String(s.id),
                          label: s.name,
                        }))}
                        value={editHeader.supplier_id}
                        onChange={(val) =>
                          setEditHeader((h) => ({ ...h, supplier_id: val }))
                        }
                        onClear={() =>
                          setEditHeader((h) => ({ ...h, supplier_id: "" }))
                        }
                        placeholder="Избери доставчик..."
                        emptyMessage="Няма намерени доставчици."
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Номер на фактура</Label>
                      <Input
                        value={editHeader.invoice_number}
                        onChange={(e) =>
                          setEditHeader((h) => ({
                            ...h,
                            invoice_number: e.target.value,
                          }))
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Дата на фактура</Label>
                      <Input
                        type="date"
                        value={editHeader.invoice_date}
                        onChange={(e) =>
                          setEditHeader((h) => ({
                            ...h,
                            invoice_date: e.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 rounded-lg bg-gray-50 p-4 text-sm">
                    <div>
                      <div className="text-xs text-gray-500">Доставчик</div>
                      <div className="font-medium">
                        {selectedDoc?.supplier?.name ??
                          selectedDoc?.supplier_name ??
                          "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500">
                        Номер на фактура
                      </div>
                      <div className="font-medium">
                        {selectedDoc?.invoice_number ?? "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500">
                        Дата на фактура
                      </div>
                      <div className="font-medium">
                        {selectedDoc?.invoice_date
                          ? formatDate(selectedDoc.invoice_date)
                          : "—"}
                      </div>
                    </div>
                  </div>
                )}

                {/* Items */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="font-medium text-gray-900">
                      Артикули ({editItems.filter((i) => !i.toDelete).length})
                    </h4>
                    {(() => {
                      const total = editItems
                        .filter((i) => !i.toDelete)
                        .reduce((sum, i) => {
                          const q = Number(i.quantity) || 0;
                          const p = Number(i.unit_price) || 0;
                          return sum + q * p;
                        }, 0);
                      return (
                        <div className="text-sm text-gray-600">
                          Обща стойност:{" "}
                          <span className="font-bold text-gray-900">
                            {formatCurrency(total)}
                          </span>
                        </div>
                      );
                    })()}
                  </div>

                  {editItems.length === 0 ? (
                    <div className="text-center py-8 text-gray-500 text-sm">
                      Няма артикули в тази доставка.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {editItems.map((item, index) => {
                        if (item.toDelete) {
                          return (
                            <div
                              key={item.id ?? index}
                              className="border rounded-lg p-3 bg-red-50 flex items-center justify-between"
                            >
                              <div className="text-sm text-red-700 line-through">
                                {item.product_name}
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  setEditItems((current) =>
                                    current.map((entry, i) =>
                                      i === index
                                        ? { ...entry, toDelete: false }
                                        : entry,
                                    ),
                                  )
                                }
                              >
                                Възстанови
                              </Button>
                            </div>
                          );
                        }

                        const readonly = selectedDoc?.status !== "pending";
                        const sellingPriceChanged =
                          String(item.selling_price ?? "").trim() !==
                          String(item.selling_price_db ?? "").trim();
                        return (
                          <div
                            key={item.id ?? index}
                            className="grid grid-cols-12 md:grid-cols-[repeat(12,minmax(0,1fr))] gap-3 items-end border rounded-lg p-3"
                          >
                            <div className="col-span-12 md:col-span-5 space-y-1.5">
                              <Label>Артикул</Label>
                              <div
                                className="h-11 flex items-center px-3 border rounded-md bg-gray-50 text-sm"
                                title={item.product_name}
                              >
                                <span className="truncate">
                                  {item.product_name}
                                </span>
                              </div>
                            </div>
                            <div className="col-span-4 md:col-span-1 space-y-1.5">
                              <Label>Кол-во</Label>
                              <Input
                                type="number"
                                min="0"
                                step="0.001"
                                value={item.quantity}
                                disabled={readonly}
                                onChange={(e) =>
                                  setEditItems((current) =>
                                    current.map((entry, i) =>
                                      i === index
                                        ? {
                                            ...entry,
                                            quantity: e.target.value,
                                            dirty: true,
                                          }
                                        : entry,
                                    ),
                                  )
                                }
                              />
                            </div>
                            <div className="col-span-4 md:col-span-1 space-y-1.5">
                              <Label>Мярка</Label>
                              <div className="h-9 flex items-center px-3 border rounded-md bg-gray-50 text-sm">
                                {item.unit}
                              </div>
                            </div>
                            <div className="col-span-4 md:col-span-2 space-y-1.5">
                              <Label>Ед. цена</Label>
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                value={item.unit_price}
                                disabled={readonly}
                                onChange={(e) =>
                                  setEditItems((current) =>
                                    current.map((entry, i) =>
                                      i === index
                                        ? {
                                            ...entry,
                                            unit_price: e.target.value,
                                            dirty: true,
                                          }
                                        : entry,
                                    ),
                                  )
                                }
                              />
                            </div>
                            <div className="col-span-6 md:col-span-2 space-y-1.5">
                              <Label
                                className={
                                  sellingPriceChanged
                                    ? "text-amber-600"
                                    : undefined
                                }
                              >
                                Продажна цена
                                {sellingPriceChanged && (
                                  <span className="ml-1 text-[10px]">
                                    (ще се обнови)
                                  </span>
                                )}
                              </Label>
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                value={item.selling_price ?? ""}
                                disabled={readonly || !item.product_id}
                                placeholder={item.product_id ? "0.00" : "—"}
                                onChange={(e) =>
                                  setEditItems((current) =>
                                    current.map((entry, i) =>
                                      i === index
                                        ? {
                                            ...entry,
                                            selling_price: e.target.value,
                                            dirty: true,
                                          }
                                        : entry,
                                    ),
                                  )
                                }
                                className={
                                  sellingPriceChanged
                                    ? "border-amber-500 ring-1 ring-amber-200"
                                    : undefined
                                }
                              />
                            </div>
                            {!readonly && (
                              <div className="col-span-12 md:col-span-1 flex justify-end items-end">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  aria-label="Изтрий артикул"
                                  onClick={() =>
                                    setEditItems((current) =>
                                      current.map((entry, i) =>
                                        i === index
                                          ? { ...entry, toDelete: true }
                                          : entry,
                                      ),
                                    )
                                  }
                                  title="Изтрий ред"
                                >
                                  <Trash2 className="h-4 w-4 text-red-500" />
                                </Button>
                              </div>
                            )}
                            <div className="col-span-12 text-right text-sm text-gray-500">
                              Ред общо:{" "}
                              <span className="font-medium text-gray-900">
                                {formatCurrency(
                                  (Number(item.quantity) || 0) *
                                    (Number(item.unit_price) || 0),
                                )}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Cancel prompt */}
                {showCancelConfirm && selectedDoc?.status === "pending" && (
                  <div className="border rounded-lg p-4 bg-red-50 space-y-3">
                    <div className="text-sm text-red-800 font-medium">
                      Сигурен ли си, че искаш да откажеш тази доставка?
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Причина (опционално)</Label>
                      <Input
                        value={cancelReason}
                        onChange={(e) => setCancelReason(e.target.value)}
                        placeholder="напр. Грешни стоки, повредена стока, ..."
                      />
                    </div>
                    <div className="flex gap-2 justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setShowCancelConfirm(false);
                          setCancelReason("");
                        }}
                      >
                        Назад
                      </Button>
                      <Button
                        size="sm"
                        className="bg-red-600 hover:bg-red-700"
                        onClick={() => cancelIncomingDelivery.mutate()}
                        disabled={cancelIncomingDelivery.isPending}
                      >
                        {cancelIncomingDelivery.isPending ? (
                          <Spinner size="sm" />
                        ) : null}
                        Откажи доставката
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <DialogFooter className="shrink-0 mt-4 gap-2 flex-wrap">
            <Button variant="outline" onClick={closeDetailsModal}>
              Затвори
            </Button>
            {selectedDoc?.status === "confirmed" && (
              <Button
                variant="outline"
                onClick={() =>
                  selectedDoc && handlePrintReceipt(selectedDoc.id)
                }
              >
                <Printer className="h-4 w-4" />
                Принтирай
              </Button>
            )}
            {selectedDoc?.status === "pending" && !showCancelConfirm && (
              <>
                <Button
                  variant="outline"
                  className="text-red-600 hover:text-red-700"
                  onClick={() => setShowCancelConfirm(true)}
                  disabled={editSaving || confirmIncomingMutation.isPending}
                >
                  Откажи
                </Button>
                <Button
                  variant="outline"
                  onClick={async () => {
                    const ok = await saveEditChanges();
                    if (ok) {
                      // Reload to refresh IDs after deletions
                      if (selectedDoc) void handleRowClick(selectedDoc);
                    }
                  }}
                  disabled={
                    editSaving ||
                    confirmIncomingMutation.isPending ||
                    !editItems.some((i) => i.dirty || i.toDelete)
                  }
                >
                  {editSaving ? <Spinner size="sm" /> : null}
                  Запази промените
                </Button>
                <Button
                  onClick={confirmFromDetailsModal}
                  disabled={editSaving || confirmIncomingMutation.isPending}
                >
                  {confirmIncomingMutation.isPending ? (
                    <Spinner size="sm" />
                  ) : (
                    <CheckCircle className="h-4 w-4" />
                  )}
                  Потвърди доставката
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={manualOpen}
        onOpenChange={(open) => {
          setManualOpen(open);
          if (!open) resetManualEntry();
        }}
      >
        <DialogContent className="sm:max-w-[98vw] lg:max-w-[1680px] max-h-[92vh] overflow-hidden flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <PenLine className="h-5 w-5 text-emerald-600" />
              Нова доставка — Ръчно въвеждане
            </DialogTitle>
            <DialogDescription>
              Добави доставката ръчно, когато няма документ за сканиране.
            </DialogDescription>
          </DialogHeader>

          {manualError && <ErrorMessage message={manualError} />}

          <div
            ref={manualScrollRef}
            className="flex-1 overflow-y-auto min-h-0 space-y-6 pr-1"
          >
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-1.5 md:col-span-1">
                <Label>Доставчик</Label>
                <Combobox
                  items={suppliers.map((s) => ({
                    value: String(s.id),
                    label: s.name,
                  }))}
                  value={manualForm.supplier_id}
                  onChange={(val) =>
                    setManualForm((current) => ({
                      ...current,
                      supplier_id: val,
                    }))
                  }
                  onClear={() =>
                    setManualForm((current) => ({
                      ...current,
                      supplier_id: "",
                    }))
                  }
                  onPickEnter={() => {
                    // Move focus to "Номер на фактура"
                    invoiceNumberRef.current?.focus();
                  }}
                  placeholder="Избери или потърси доставчик..."
                  emptyMessage="Няма намерени доставчици."
                />
              </div>
              <div className="space-y-1.5">
                <Label>Номер на фактура</Label>
                <Input
                  ref={invoiceNumberRef}
                  value={manualForm.invoice_number}
                  onChange={(e) =>
                    setManualForm((current) => ({
                      ...current,
                      invoice_number: e.target.value,
                    }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      invoiceDateRef.current?.focus();
                    }
                  }}
                  placeholder="напр. 123456"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Дата на фактура</Label>
                <Input
                  ref={invoiceDateRef}
                  type="date"
                  value={manualForm.invoice_date}
                  onChange={(e) =>
                    setManualForm((current) => ({
                      ...current,
                      invoice_date: e.target.value,
                    }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      focusRowField(0, "product");
                    }
                  }}
                />
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h4 className="font-medium text-gray-900">Артикули</h4>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => addManualRow()}
                >
                  <Plus className="h-4 w-4" />
                  Добави ред
                </Button>
              </div>

              <div className="space-y-3">
                {manualItems.map((item, index) => (
                  <div
                    key={index}
                    className="grid grid-cols-12 gap-3 items-end border rounded-lg p-3"
                  >
                    <div className="col-span-12 md:col-span-5 space-y-1.5">
                      <Label>Артикул</Label>
                      <div className="space-y-2">
                        <div className="relative">
                          <Input
                            ref={(el) => {
                              rowInputRefs.current[`${index}:product`] = el;
                            }}
                            value={item.product_name}
                            onChange={(e) => {
                              setManualItems((current) =>
                                current.map((entry, entryIndex) =>
                                  entryIndex === index
                                    ? {
                                        ...entry,
                                        product_id: null,
                                        product_name: e.target.value,
                                      }
                                    : entry,
                                ),
                              );
                              // Typing re-opens the dropdown after Escape.
                              setManualSearchDismissed((current) => {
                                if (!current[index]) return current;
                                const next = { ...current };
                                delete next[index];
                                return next;
                              });
                            }}
                            onKeyDown={(e) =>
                              handleRowFieldEnter(e, index, "product")
                            }
                            placeholder="Търси продукт по име или SKU..."
                            className="h-12 text-base pr-10"
                          />
                          {getManualSearchLoading(index) ? (
                            <div className="absolute right-3 top-1/2 -translate-y-1/2">
                              <Spinner size="sm" />
                            </div>
                          ) : null}
                        </div>
                        {getManualSearchError(index) &&
                        !getManualSearchLoading(index) &&
                        !item.product_id ? (
                          <p className="text-xs text-red-600">
                            {getManualSearchError(index)}
                          </p>
                        ) : null}
                        {getManualSearchResults(index).length > 0 ? (
                          <div className="border rounded-md divide-y bg-white max-h-72 overflow-y-auto shadow-sm">
                            {getManualSearchResults(index).map(
                              (product, productIdx) => {
                                const productLabel =
                                  product.name_bg ||
                                  product.name_en ||
                                  product.sku ||
                                  `Продукт #${product.id}`;
                                const isHighlighted =
                                  (manualSearchHighlight[index] ?? 0) ===
                                  productIdx;
                                return (
                                  <button
                                    key={product.id}
                                    type="button"
                                    ref={(el) => {
                                      if (el && isHighlighted) {
                                        el.scrollIntoView({ block: "nearest" });
                                      }
                                    }}
                                    className={`w-full text-left px-4 py-3 ${
                                      isHighlighted
                                        ? "bg-emerald-50"
                                        : "hover:bg-gray-50"
                                    }`}
                                    onMouseEnter={() =>
                                      setManualSearchHighlight((current) => ({
                                        ...current,
                                        [index]: productIdx,
                                      }))
                                    }
                                    onClick={() =>
                                      selectManualProduct(index, product)
                                    }
                                  >
                                    <div className="font-medium text-gray-900 text-sm">
                                      <HighlightMatch
                                        text={productLabel}
                                        query={item.product_name}
                                      />
                                    </div>
                                    <div className="text-xs text-gray-500 mt-0.5">
                                      {product.sku ? (
                                        <>
                                          SKU:{" "}
                                          <HighlightMatch
                                            text={product.sku}
                                            query={item.product_name}
                                          />
                                        </>
                                      ) : (
                                        "Без SKU"
                                      )}
                                      {product.unit ? ` • ${product.unit}` : ""}
                                    </div>
                                  </button>
                                );
                              },
                            )}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div className="col-span-4 md:col-span-2 space-y-1.5">
                      <Label>Кол-во</Label>
                      <Input
                        ref={(el) => {
                          rowInputRefs.current[`${index}:quantity`] = el;
                        }}
                        type="number"
                        min="0"
                        step="0.001"
                        value={item.quantity}
                        onChange={(e) =>
                          setManualItems((current) =>
                            current.map((entry, entryIndex) =>
                              entryIndex === index
                                ? { ...entry, quantity: e.target.value }
                                : entry,
                            ),
                          )
                        }
                        onKeyDown={(e) =>
                          handleRowFieldEnter(e, index, "quantity")
                        }
                        placeholder="0"
                      />
                    </div>
                    <div className="col-span-4 md:col-span-2 space-y-1.5">
                      <Label>Мярка</Label>
                      <Input
                        ref={(el) => {
                          rowInputRefs.current[`${index}:unit`] = el;
                        }}
                        value={item.unit}
                        onChange={(e) =>
                          setManualItems((current) =>
                            current.map((entry, entryIndex) =>
                              entryIndex === index
                                ? { ...entry, unit: e.target.value }
                                : entry,
                            ),
                          )
                        }
                        onKeyDown={(e) => handleRowFieldEnter(e, index, "unit")}
                        placeholder="бр"
                      />
                    </div>
                    <div className="col-span-4 md:col-span-2 space-y-1.5">
                      <Label>Ед. цена</Label>
                      <Input
                        ref={(el) => {
                          rowInputRefs.current[`${index}:unit_price`] = el;
                        }}
                        type="number"
                        min="0"
                        step="0.01"
                        value={item.unit_price}
                        onChange={(e) =>
                          setManualItems((current) =>
                            current.map((entry, entryIndex) =>
                              entryIndex === index
                                ? { ...entry, unit_price: e.target.value }
                                : entry,
                            ),
                          )
                        }
                        onKeyDown={(e) =>
                          handleRowFieldEnter(e, index, "unit_price")
                        }
                        placeholder="0.00"
                      />
                    </div>
                    <div className="col-span-12 md:col-span-1 flex justify-end items-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Изтрий ред"
                        onClick={() =>
                          setManualItems((current) =>
                            current.length === 1
                              ? [
                                  {
                                    product_id: null,
                                    product_name: "",
                                    quantity: "",
                                    unit_price: "",
                                    unit: "бр",
                                    original_purchase_price: null,
                                  },
                                ]
                              : current.filter(
                                  (_, entryIndex) => entryIndex !== index,
                                ),
                          )
                        }
                        title="Изтрий ред"
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter className="shrink-0 mt-4 gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setManualOpen(false);
                resetManualEntry();
              }}
            >
              Отказ
            </Button>
            <Button
              onClick={() => manualCreateMutation.mutate()}
              disabled={manualCreateMutation.isPending}
            >
              {manualCreateMutation.isPending ? <Spinner size="sm" /> : null}
              Запази доставката
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Scan Dialog */}
      <Dialog open={scanOpen} onOpenChange={setScanOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Camera className="h-5 w-5 text-[#f97316]" />
              Нова доставка — Сканиране на документ
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto min-h-0 space-y-4 pr-1">
            {/* Upload */}
            {!scanned && (
              <div
                className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center cursor-pointer hover:border-[#f97316] transition-colors"
                onClick={() => fileRef.current?.click()}
              >
                {scanning ? (
                  <BakaliqLoader text="AI извлича данните от фактурата..." />
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <Upload className="h-10 w-10 text-gray-400" />
                    <div>
                      <p className="font-medium text-gray-700">
                        Качи фактура или снимка
                      </p>
                      <p className="text-sm text-gray-400 mt-1">
                        PDF, PNG, JPG до 10MB
                      </p>
                    </div>
                    <Button variant="outline" size="sm">
                      Избери файл
                    </Button>
                  </div>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*,.pdf"
                  className="hidden"
                  onChange={(e) =>
                    e.target.files?.[0] && handleFileUpload(e.target.files[0])
                  }
                />
              </div>
            )}

            {scanError && (
              <div className="space-y-2">
                <ErrorMessage message={scanError} />
                {!scanned && (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      setScanOpen(false);
                      setManualOpen(true);
                    }}
                  >
                    Премини към ръчно въвеждане
                  </Button>
                )}
              </div>
            )}

            {/* Scanned Preview */}
            {scanned && (
              <div className="space-y-4">
                <div className="rounded-lg bg-green-50 border border-green-200 p-3 flex items-center gap-2 text-green-700 text-sm">
                  <CheckCircle className="h-4 w-4" />
                  AI успешно извлече данните от документа
                </div>

                {!confirmData.supplier_id && scanned.supplier_name && (
                  <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 flex items-center gap-2 text-blue-700 text-sm">
                    <AlertCircle className="h-4 w-4 flex-shrink-0" />
                    <span>
                      🆕 Нов доставчик: <strong>{scanned.supplier_name}</strong>{" "}
                      ще бъде добавен автоматично
                    </span>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Доставчик</Label>
                    <Combobox
                      items={suppliers.map((s) => ({
                        value: String(s.id),
                        label: s.name,
                      }))}
                      value={confirmData.supplier_id}
                      onChange={(val) =>
                        setConfirmData((c) => ({ ...c, supplier_id: val }))
                      }
                      onClear={() =>
                        setConfirmData((c) => ({ ...c, supplier_id: "" }))
                      }
                      placeholder="Избери или потърси доставчик..."
                      emptyMessage="Няма намерени доставчици."
                    />
                    {scanned.supplier_name && (
                      <p className="text-xs text-gray-500">
                        AI откри: {scanned.supplier_name}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label>Номер на фактура</Label>
                    <Input
                      value={confirmData.invoice_number}
                      onChange={(e) =>
                        setConfirmData((c) => ({
                          ...c,
                          invoice_number: e.target.value,
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Дата на фактура</Label>
                    <Input
                      type="date"
                      value={confirmData.invoice_date}
                      onChange={(e) =>
                        setConfirmData((c) => ({
                          ...c,
                          invoice_date: e.target.value,
                        }))
                      }
                    />
                  </div>
                  {scanned.total && (
                    <div className="space-y-1.5">
                      <Label>Обща сума (AI)</Label>
                      <Input
                        value={scanned.total.toFixed(2)}
                        readOnly
                        className="bg-gray-50"
                      />
                    </div>
                  )}
                </div>

                {/* Items */}
                <div>
                  <h4 className="font-medium text-gray-900 mb-2">
                    Артикули ({(scanned.items ?? []).length})
                  </h4>
                  <div className="space-y-2.5 max-h-[520px] overflow-y-auto pr-1">
                    {(scanned.items ?? []).map((item, index) => {
                      const unresolved =
                        !isMatchedForAutoLink(item) && item.product_id == null;
                      const rowNo = item.row_number ?? index + 1;
                      const unitPrice =
                        itemPrices[index] ?? item.unit_price ?? item.price ?? 0;
                      const total = item.quantity * unitPrice;
                      const searchValue = rowSearchInput[index] ?? "";
                      const searchResults = rowSearchResults[index] ?? [];
                      const selectedId = rowSelectedProductId[index];
                      const searchBusy = rowSearchLoading[index] === true;
                      const createBusy = rowCreateLoading[index] === true;
                      const searchError = rowSearchError[index] || "";
                      const createError = rowCreateError[index] || "";
                      const mappingOpen = rowMappingOpen[index] === true;
                      const linkedProductId =
                        item.matched_product_id ?? item.product_id ?? null;
                      const linkedProductName =
                        item.matched_product_name ||
                        (linkedProductId ? `ID ${linkedProductId}` : null);
                      const linkedProductMeta = [
                        item.matched_product_sku
                          ? `SKU ${item.matched_product_sku}`
                          : null,
                        item.match_source === "manual" ? "ръчно избран" : null,
                      ]
                        .filter(Boolean)
                        .join(" • ");
                      const dbPrice =
                        item.matched_purchase_price != null
                          ? Number(item.matched_purchase_price)
                          : null;
                      const priceDiff =
                        dbPrice != null ? unitPrice - dbPrice : null;

                      return (
                        <div
                          key={`row-${rowNo}-${index}`}
                          className="rounded-lg border px-3 py-2.5 text-sm bg-muted/20"
                        >
                          {/* Row header: name + status */}
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="font-medium truncate">
                                Ред {rowNo}: {itemDisplayName(item)}
                              </p>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {item.quantity} {item.unit || "бр"} ×{" "}
                                {Number(unitPrice).toFixed(2)}€ ={" "}
                                {total.toFixed(2)}€
                              </p>
                              {item.name_en &&
                                item.name_en !==
                                  (item.name_bg ||
                                    item.name ||
                                    item.product_name) && (
                                  <p className="text-xs text-muted-foreground uppercase tracking-wide">
                                    {item.name_en}
                                  </p>
                                )}
                            </div>
                            <p
                              className={`shrink-0 text-xs font-semibold ${unresolved ? "text-amber-600" : "text-emerald-600"}`}
                            >
                              {unresolved ? "Нужна връзка" : "Свързан продукт"}
                            </p>
                          </div>

                          {/* Product mapping block + selling price (always visible) */}
                          <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px] sm:items-end">
                            {/* Product mapping */}
                            <div className="rounded-lg border px-3 py-2.5 bg-background">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                    Продукт в склада
                                  </p>
                                  <p className="mt-1 text-sm font-medium truncate">
                                    {linkedProductName || "Няма избран продукт"}
                                  </p>
                                  {linkedProductMeta && (
                                    <p className="mt-1 text-xs text-muted-foreground">
                                      {linkedProductMeta}
                                    </p>
                                  )}
                                </div>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    setRowMappingOpen((c) => ({
                                      ...c,
                                      [index]: !mappingOpen,
                                    }))
                                  }
                                >
                                  {mappingOpen
                                    ? "Скрий избора"
                                    : unresolved
                                      ? "Избери продукт"
                                      : "Смени продукта"}
                                </Button>
                              </div>
                            </div>

                            {/* Prices */}
                            <div className="space-y-1.5">
                              <div className="space-y-1">
                                <Label className="text-xs text-muted-foreground">
                                  Ед. цена
                                </Label>
                                <Input
                                  type="number"
                                  step="0.01"
                                  value={unitPrice}
                                  onChange={(e) =>
                                    setItemPrices((p) => ({
                                      ...p,
                                      [index]: parseFloat(e.target.value) || 0,
                                    }))
                                  }
                                  className="w-full"
                                />
                                {dbPrice != null && (
                                  <p className="text-[11px] text-muted-foreground">
                                    База: {dbPrice.toFixed(2)}€
                                    {priceDiff != null &&
                                    Math.abs(priceDiff) >= 0.01 ? (
                                      <span className="text-orange-600 font-semibold">
                                        {" "}
                                        ({priceDiff > 0 ? "+" : ""}
                                        {priceDiff.toFixed(2)}€)
                                      </span>
                                    ) : (
                                      <span className="text-emerald-600">
                                        {" "}
                                        ✓
                                      </span>
                                    )}
                                  </p>
                                )}
                              </div>
                              <div className="space-y-1">
                                <Label className="text-xs text-muted-foreground">
                                  Продажна цена
                                </Label>
                                <Input
                                  type="number"
                                  inputMode="decimal"
                                  min="0"
                                  step="0.01"
                                  value={item.selling_price ?? ""}
                                  onChange={(e) =>
                                    updateRowSellingPrice(index, e.target.value)
                                  }
                                  placeholder="0.00"
                                />
                                {item.matched_selling_price != null &&
                                  item.matched_selling_price > 0 && (
                                    <p className="text-[11px] text-muted-foreground">
                                      Каталожна:{" "}
                                      {Number(
                                        item.matched_selling_price,
                                      ).toFixed(2)}
                                      €
                                    </p>
                                  )}
                              </div>
                            </div>
                          </div>

                          {/* Inline search/bind/create flow */}
                          {mappingOpen && (
                            <div className="mt-3 space-y-2.5 rounded-lg border bg-muted/10 p-2.5">
                              <div className="flex flex-col sm:flex-row gap-2">
                                <Input
                                  value={searchValue}
                                  onChange={(e) => {
                                    const value = e.target.value;
                                    setRowSearchInput((c) => ({
                                      ...c,
                                      [index]: value,
                                    }));
                                    if (rowSearchError[index])
                                      setRowSearchError((c) => ({
                                        ...c,
                                        [index]: "",
                                      }));
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      fetchProductsForRow(index);
                                    }
                                  }}
                                  placeholder="Търси продукт по име/SKU..."
                                />
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={searchBusy}
                                  onClick={() => fetchProductsForRow(index)}
                                >
                                  {searchBusy ? (
                                    <>
                                      <Spinner size="sm" /> Търсене...
                                    </>
                                  ) : (
                                    "Търси"
                                  )}
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={createBusy}
                                  onClick={() => createProductForRow(index)}
                                >
                                  {createBusy ? (
                                    <>
                                      <Spinner size="sm" /> Създаване...
                                    </>
                                  ) : (
                                    "Създай нов"
                                  )}
                                </Button>
                              </div>

                              {searchError && (
                                <p className="text-xs text-amber-600">
                                  {searchError}
                                </p>
                              )}
                              {createError && (
                                <p className="text-xs text-red-500">
                                  {createError}
                                </p>
                              )}

                              {searchResults.length > 0 && (
                                <div className="space-y-1.5">
                                  <div className="max-h-36 overflow-y-auto space-y-1">
                                    {searchResults.map((product) => {
                                      const selected =
                                        selectedId === product.id;
                                      return (
                                        <button
                                          key={product.id}
                                          type="button"
                                          onClick={() =>
                                            setRowSelectedProductId((c) => ({
                                              ...c,
                                              [index]: product.id,
                                            }))
                                          }
                                          className={`w-full text-left rounded-md border px-2.5 py-1.5 ${
                                            selected
                                              ? "border-blue-500 bg-blue-50"
                                              : "border-gray-200 hover:bg-gray-50"
                                          }`}
                                        >
                                          <p className="text-sm">
                                            {product.name_bg ||
                                              product.name_en ||
                                              "Без име"}
                                          </p>
                                          <p className="text-xs text-muted-foreground">
                                            {product.sku
                                              ? `SKU ${product.sku}`
                                              : "Без SKU"}
                                          </p>
                                        </button>
                                      );
                                    })}
                                  </div>
                                  <Button
                                    type="button"
                                    onClick={() =>
                                      bindSelectedProductForRow(index)
                                    }
                                    disabled={!selectedId}
                                    size="sm"
                                  >
                                    {linkedProductId
                                      ? "Смени с избрания продукт"
                                      : "Свържи избрания продукт"}
                                  </Button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {confirmMutation.error && (
                  <ErrorMessage
                    message={
                      (confirmMutation.error as any)?.response?.data?.message ??
                      "Грешка при запазване"
                    }
                  />
                )}
                {(() => {
                  const newWithoutPrice = (scanned.items ?? []).filter(
                    (it) =>
                      it.matched_product_id == null &&
                      (it.selling_price == null || it.selling_price <= 0),
                  );
                  if (newWithoutPrice.length === 0) return null;
                  return (
                    <div className="rounded-lg bg-amber-50 border border-amber-300 px-3 py-2 text-xs text-amber-700">
                      ⚠️ {newWithoutPrice.length} нов
                      {newWithoutPrice.length === 1 ? "" : "и"} продукт
                      {newWithoutPrice.length === 1 ? "" : "а"} без продажна
                      цена.
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          <DialogFooter className="gap-2 shrink-0">
            <Button
              variant="outline"
              onClick={() => {
                setScanOpen(false);
                setScanned(null);
                setScanError("");
                resetManualResolveState();
              }}
            >
              Отказ
            </Button>
            {scanned && (
              <Button
                onClick={() => confirmMutation.mutate()}
                disabled={
                  confirmMutation.isPending ||
                  (!confirmData.supplier_id && !scanned?.supplier_name)
                }
              >
                {confirmMutation.isPending ? (
                  <>
                    <Spinner size="sm" />
                    Запазване...
                  </>
                ) : (
                  "Запази доставката"
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
