import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  FileSearch,
  FileText,
  ListChecks,
  ScanSearch,
  ShieldAlert,
  Upload,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { ScannedInvoice, ScannedInvoiceItem } from "@/types";
import { api } from "@/lib/api";
import {
  buildDuplicateInvoiceCancelledMessage,
  buildDuplicateInvoiceConfirmMessage,
  formatDuplicateInvoiceStatusLabel,
  type DuplicateInvoiceInfo,
} from "@/lib/incomingDuplicate";
import { formatCurrency, getApiErrorMessage } from "@/lib/utils";
import { confirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorMessage, Spinner } from "@/components/ui/spinner";

interface OwnerScanFormState {
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string;
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

function toOptionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDateInput(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function normalizeScannedInvoice(raw: any): ScannedInvoice {
  const sourceItems = Array.isArray(raw?.line_items)
    ? raw.line_items
    : Array.isArray(raw?.items)
      ? raw.items
      : [];

  const items: ScannedInvoiceItem[] = sourceItems.map((line: any) => {
    const productName =
      line.product_name_raw ??
      line.product_name ??
      line.name_en ??
      line.name_bg ??
      line.name ??
      "";
    const unitPrice = Number(line.unit_price ?? line.price ?? 0) || 0;

    return {
      row_number: toOptionalNumber(line.row_number),
      page_number: toOptionalNumber(line.page_number),
      name: line.name_bg ?? productName,
      name_en: productName,
      name_bg: line.name_bg ?? productName,
      product_name: productName,
      product_name_raw: line.product_name_raw ?? productName,
      product_code: line.product_code ?? line.product_code_raw ?? null,
      product_code_raw: line.product_code_raw ?? line.product_code ?? null,
      quantity: Number(line.quantity ?? 1) || 1,
      unit: line.unit ?? "бр",
      price: unitPrice,
      unit_price: unitPrice,
      batch: line.batch ?? line.batch_number ?? null,
      batch_number:
        line.batch_number ?? line.batch ?? line.batch_number_raw ?? null,
      batch_number_raw:
        line.batch_number_raw ?? line.batch_number ?? line.batch ?? null,
      expiry: line.expiry ?? line.expiry_date ?? null,
      expiry_date:
        line.expiry_date ?? line.expiry ?? line.expiry_date_raw ?? null,
      expiry_date_raw:
        line.expiry_date_raw ?? line.expiry_date ?? line.expiry ?? null,
      production_date: line.production_date ?? null,
      notes_raw: line.notes_raw ?? null,
      auto_batch: line.auto_batch ?? null,
      total: toOptionalNumber(line.total_price ?? line.total),
      brand: line.brand ?? null,
      category_hint: line.category_hint ?? null,
      product_id: line.product_id ?? null,
      matched_product_id: line.matched_product_id ?? null,
      matched_product_name: line.matched_product_name ?? null,
      matched_product_sku: line.matched_product_sku ?? null,
      match_confidence: toOptionalNumber(line.match_confidence),
      match_source: line.match_source ?? null,
      suggestions: Array.isArray(line.suggestions) ? line.suggestions : [],
      selling_price: toOptionalNumber(
        line.selling_price ?? line.matched_selling_price,
      ),
      matched_purchase_price: toOptionalNumber(line.matched_purchase_price),
      matched_selling_price: toOptionalNumber(line.matched_selling_price),
      gross_price: toOptionalNumber(line.gross_price),
      discount_percent: toOptionalNumber(line.discount_percent),
      discount_amount: toOptionalNumber(line.discount_amount),
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
    needs_companion_doc: Boolean(raw?.needs_companion_doc),
    missing_batch: Boolean(raw?.missing_batch),
    missing_expiry: Boolean(raw?.missing_expiry),
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
    duplicate_invoice:
      raw?.duplicate_invoice && typeof raw.duplicate_invoice === "object"
        ? {
            duplicate: Boolean(raw.duplicate_invoice.duplicate),
            existing_id:
              toOptionalNumber(raw.duplicate_invoice.existing_id) ?? undefined,
            status: raw.duplicate_invoice.status ?? undefined,
            created_at: raw.duplicate_invoice.created_at ?? undefined,
            message: raw.duplicate_invoice.message ?? undefined,
          }
        : null,
    items,
  };
}

function mapCompletenessLabel(status?: string | null) {
  if (status === "complete") return "пълно";
  if (status === "suspicious") return "съмнително";
  if (status === "incomplete") return "непълно";
  return "неизвестно";
}

type ScanProgressKey = "upload" | "ocr" | "matching" | "review";

const SCAN_PROGRESS_STEPS: Array<{
  key: ScanProgressKey;
  title: string;
  plainLanguage: string;
}> = [
  {
    key: "upload",
    title: "Подготвяме файла",
    plainLanguage: "Качваме снимката и проверяваме дали документът е четим.",
  },
  {
    key: "ocr",
    title: "Извличаме данните",
    plainLanguage:
      "AI чете доставчик, номер, дата, суми и редове от фактурата.",
  },
  {
    key: "matching",
    title: "Свързваме продуктите",
    plainLanguage:
      "Сравняваме редовете с каталога, за да покажем какво иска ръчен преглед.",
  },
  {
    key: "review",
    title: "Подготвяме екрана за преглед",
    plainLanguage:
      "Групираме проблемите, за да се вижда веднага какво още блокира приемането.",
  },
];

function getRowIssueBadges(item: ScannedInvoiceItem): string[] {
  const issues: string[] = [];
  const matched = isMatchedForAutoLink(item) || item.product_id != null;
  if (!matched) issues.push("Без продуктова връзка");
  else if (
    (item.match_confidence ?? 0) < 0.75 &&
    item.match_source !== "manual"
  ) {
    issues.push("Съмнителен мач");
  }
  if (!item.batch_number || !item.expiry_date)
    issues.push("Липсва партида/срок");
  return issues;
}

function isMatchedForAutoLink(item: ScannedInvoiceItem): boolean {
  if (item.matched_product_id == null) return false;
  if (item.match_source === "alias" || item.match_source === "sku") return true;
  return (item.match_confidence ?? 0) >= 0.75;
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

function itemInvoiceCode(item: ScannedInvoiceItem): string | null {
  const rawCode = item.product_code || item.product_code_raw || null;
  const normalizedCode = typeof rawCode === "string" ? rawCode.trim() : "";
  return normalizedCode || null;
}

function batchFromProdDate(prodDateStr: string): string {
  try {
    const d = new Date(prodDateStr);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}${mm}${d.getFullYear()}`;
  } catch {
    return "";
  }
}

function autoBatchFromExpiry(expiryDateStr: string): string {
  try {
    const expiry = new Date(expiryDateStr);
    const production = new Date(expiry);
    production.setMonth(production.getMonth() - 2);
    return batchFromProdDate(production.toISOString().split("T")[0]);
  } catch {
    return "";
  }
}

export function OwnerInvoiceScan() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const cameraFileRef = useRef<HTMLInputElement>(null);
  const uploadFileRef = useRef<HTMLInputElement>(null);
  const rowsSectionRef = useRef<HTMLDivElement | null>(null);

  const [scanned, setScanned] = useState<ScannedInvoice | null>(null);
  const [scanError, setScanError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanProgressKey, setScanProgressKey] =
    useState<ScanProgressKey>("upload");
  const [scanEtaSeconds, setScanEtaSeconds] = useState(0);
  const [matchingPreview, setMatchingPreview] = useState(false);
  const [reviewAccepted, setReviewAccepted] = useState(false);
  const [savedIncomingId, setSavedIncomingId] = useState<number | null>(null);
  const [completionDocId, setCompletionDocId] = useState<number | null>(null);
  const [completionItems, setCompletionItems] = useState<any[]>([]);
  const [showCompletionModal, setShowCompletionModal] = useState(false);
  const [completionStep, setCompletionStep] = useState<"ask" | "manual">("ask");
  const [companionScanning, setCompanionScanning] = useState(false);
  const [companionScanError, setCompanionScanError] = useState("");
  const [completionSaveError, setCompletionSaveError] = useState("");
  const [savingCompletion, setSavingCompletion] = useState(false);
  const [duplicateInfo, setDuplicateInfo] =
    useState<DuplicateInvoiceInfo | null>(null);
  const [form, setForm] = useState<OwnerScanFormState>({
    supplierName: "",
    invoiceNumber: "",
    invoiceDate: "",
  });
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

  useEffect(() => {
    if (searchParams.get("pick") !== "1") return;
    const timer = window.setTimeout(() => {
      uploadFileRef.current?.click();
    }, 200);
    return () => window.clearTimeout(timer);
  }, [searchParams]);

  useEffect(() => {
    if (!scanning || scanEtaSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setScanEtaSeconds((current) => (current > 0 ? current - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [scanning, scanEtaSeconds]);

  const unresolvedItemsCount = useMemo(
    () =>
      (scanned?.items ?? []).filter(
        (item) => !isMatchedForAutoLink(item) && item.product_id == null,
      ).length,
    [scanned?.items],
  );

  const visibleRows = scanned?.visible_row_count ?? scanned?.items.length ?? 0;
  const extractedRows =
    scanned?.extracted_row_count ?? scanned?.items.length ?? 0;
  const completenessStatus =
    scanned?.completeness_status ??
    (visibleRows === extractedRows ? "complete" : "suspicious");
  const isIncompleteExtraction =
    scanned != null && completenessStatus === "incomplete";
  const requiresReviewAcceptance =
    scanned != null && completenessStatus === "suspicious";

  const pendingBatchExpiryCount = useMemo(
    () =>
      completionItems.filter(
        (item) =>
          !Boolean(item.batch_number || item.batch || item.batch_number_raw) ||
          !Boolean(item.expiry_date || item.expiry || item.expiry_date_raw),
      ).length,
    [completionItems],
  );
  const needsCompanionFollowUp = pendingBatchExpiryCount > 0;

  const scanProgressIndex = SCAN_PROGRESS_STEPS.findIndex(
    (step) => step.key === scanProgressKey,
  );
  const matchedItems = (scanned?.items ?? []).filter(
    (item) => isMatchedForAutoLink(item) || item.product_id != null,
  );
  const suspiciousItems = (scanned?.items ?? []).filter(
    (item) =>
      (item.matched_product_id != null || item.product_id != null) &&
      !isMatchedForAutoLink(item) &&
      item.product_id == null,
  );
  const missingProductItems = (scanned?.items ?? []).filter(
    (item) => !isMatchedForAutoLink(item) && item.product_id == null,
  );
  const missingBatchExpiryItems = (scanned?.items ?? []).filter(
    (item) => !item.batch_number || !item.expiry_date,
  );
  const duplicateLikeRows = useMemo(() => {
    const seen = new Map<string, number>();
    return (scanned?.items ?? []).filter((item) => {
      const key = `${itemDisplayName(item).trim().toLowerCase()}::${item.product_code ?? ""}`;
      const count = seen.get(key) ?? 0;
      seen.set(key, count + 1);
      return count >= 1;
    });
  }, [scanned?.items]);
  const readyItems = (scanned?.items ?? []).filter(
    (item) => getRowIssueBadges(item).length === 0,
  );
  const companionRecommended = Boolean(
    scanned?.needs_companion_doc ||
    scanned?.missing_batch ||
    scanned?.missing_expiry ||
    missingBatchExpiryItems.length > 0,
  );
  const reviewBlockers = [
    missingProductItems.length > 0
      ? `${missingProductItems.length} реда без продуктова връзка`
      : null,
    isIncompleteExtraction ? "извличането е непълно" : null,
    requiresReviewAcceptance && !reviewAccepted
      ? "нужна е изрична проверка на съмнителното извличане"
      : null,
  ].filter(Boolean) as string[];
  const acceptanceRisks = [
    companionRecommended
      ? `${missingBatchExpiryItems.length} реда без партида или срок на годност`
      : null,
    duplicateLikeRows.length > 0
      ? `${duplicateLikeRows.length} потенциално дублирани реда`
      : null,
  ].filter(Boolean) as string[];
  const reviewConfidencePercent = scanned?.items?.length
    ? Math.round((matchedItems.length / scanned.items.length) * 100)
    : 0;
  const technicalWarnings = scanned?.warnings ?? [];
  const actionRows = useMemo(
    () =>
      (scanned?.items ?? [])
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => getRowIssueBadges(item).length > 0),
    [scanned?.items],
  );
  const readyRows = useMemo(
    () =>
      (scanned?.items ?? [])
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => getRowIssueBadges(item).length === 0),
    [scanned?.items],
  );
  const reviewStatusLabel = isIncompleteExtraction
    ? "Блокирано"
    : actionRows.length > 0 || requiresReviewAcceptance
      ? "Нужна проверка"
      : "Готово за запис";
  const reviewStatusClasses = isIncompleteExtraction
    ? "border-[rgba(242,111,111,0.35)] bg-[rgba(242,111,111,0.12)] text-[#ffd5d5]"
    : actionRows.length > 0 || requiresReviewAcceptance
      ? "border-[rgba(242,184,75,0.35)] bg-[rgba(242,184,75,0.12)] text-[#f8e7b2]"
      : "border-[rgba(37,195,139,0.35)] bg-[rgba(37,195,139,0.12)] text-[#baf4dd]";
  const actionSummaryParts = [
    missingProductItems.length > 0
      ? `${missingProductItems.length} ${missingProductItems.length === 1 ? "ред иска избор на продукт" : "реда искат избор на продукт"}`
      : null,
    suspiciousItems.length > 0
      ? `${suspiciousItems.length} ${suspiciousItems.length === 1 ? "ред има съмнителен мач" : "реда имат съмнителен мач"}`
      : null,
    missingBatchExpiryItems.length > 0
      ? `${missingBatchExpiryItems.length} ${missingBatchExpiryItems.length === 1 ? "ред чака партида/срок" : "реда чакат партида/срок"}`
      : null,
  ].filter(Boolean) as string[];
  const actionSummary =
    actionSummaryParts.length > 0
      ? `${actionSummaryParts.join(". ")}.`
      : "Всички редове изглеждат готови за запис.";
  const openCompletionModal = () => {
    setCompletionSaveError("");
    setCompanionScanError("");
    setCompletionStep("ask");
    setShowCompletionModal(true);
  };

  const renderInvoiceRowCard = ({
    item,
    index,
  }: {
    item: ScannedInvoiceItem;
    index: number;
  }) => {
    const unresolved = !isMatchedForAutoLink(item) && item.product_id == null;
    const suspicious =
      !unresolved &&
      (item.matched_product_id != null || item.product_id != null) &&
      !isMatchedForAutoLink(item) &&
      item.product_id == null;
    const rowNo = item.row_number ?? index + 1;
    const searchValue = rowSearchInput[index] ?? "";
    const searchResults = rowSearchResults[index] ?? [];
    const selectedId = rowSelectedProductId[index];
    const searchBusy = rowSearchLoading[index] === true;
    const createBusy = rowCreateLoading[index] === true;
    const searchError = rowSearchError[index] || "";
    const createError = rowCreateError[index] || "";
    const mappingOpen = rowMappingOpen[index] === true;
    const linkedProductId = item.matched_product_id ?? item.product_id ?? null;
    const linkedProductName =
      item.matched_product_name ||
      (linkedProductId ? `ID ${linkedProductId}` : null);
    const lineTotal = Number(
      item.total ??
        Number(item.quantity || 0) * Number(item.price || item.unit_price || 0),
    );
    const invoiceUnitPrice = Number(item.unit_price ?? item.price ?? 0);
    const catalogPrice = item.matched_purchase_price;
    const sellingPrice = item.selling_price ?? item.matched_selling_price;
    const missingDetails = !item.batch_number || !item.expiry_date;
    const invoiceCode = itemInvoiceCode(item);

    return (
      <div
        key={`row-${rowNo}-${index}`}
        className={`rounded-[28px] border p-4 sm:p-5 shadow-[0_18px_48px_rgba(0,0,0,0.22)] ${
          unresolved
            ? "border-[rgba(242,184,75,0.28)] bg-[linear-gradient(180deg,rgba(242,184,75,0.11),rgba(18,22,42,0.98))]"
            : suspicious
              ? "border-[rgba(132,156,255,0.24)] bg-[linear-gradient(180deg,rgba(79,124,255,0.10),rgba(18,22,42,0.98))]"
              : "border-[rgba(255,255,255,0.08)] bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(18,22,42,0.98))]"
        }`}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#d4bc7c]">
                  Ред {rowNo}
                </span>
                {invoiceCode ? (
                  <span className="rounded-full border border-[rgba(132,156,255,0.22)] bg-[rgba(79,124,255,0.12)] px-2.5 py-1 text-[11px] font-medium text-[#d7deff]">
                    Код: {invoiceCode}
                  </span>
                ) : null}
              </div>
              <p className="text-lg font-semibold leading-6 text-[#f7f9ff]">
                {itemDisplayName(item)}
              </p>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-[#a9b5dd]">
                <span>
                  {item.quantity} {item.unit || "бр"}
                </span>
                <span>
                  • {formatCurrency(lineTotal, scanned?.currency || "EUR")}
                </span>
              </div>
            </div>

            <span
              className={`inline-flex shrink-0 items-center rounded-full border px-3 py-1.5 text-xs font-semibold ${
                unresolved
                  ? "border-[rgba(242,184,75,0.36)] bg-[rgba(242,184,75,0.14)] text-[#f8e7b2]"
                  : suspicious
                    ? "border-[rgba(132,156,255,0.28)] bg-[rgba(79,124,255,0.15)] text-[#d7deff]"
                    : "border-[rgba(37,195,139,0.26)] bg-[rgba(37,195,139,0.12)] text-[#baf4dd]"
              }`}
            >
              {unresolved
                ? "Избери продукт"
                : suspicious
                  ? "Провери мача"
                  : "Готов ред"}
            </span>
          </div>

          <div className="rounded-[22px] border border-[rgba(255,255,255,0.08)] bg-[rgba(9,12,24,0.66)] p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1">
                <p className="text-[11px] uppercase tracking-[0.18em] text-[#9aa8d6]">
                  Складов продукт
                </p>
                <p className="text-sm font-semibold text-[#f3f6ff]">
                  {linkedProductName || "Няма избран продукт"}
                </p>
                <p className="text-xs text-[#9aa8d6]">
                  {item.matched_product_sku
                    ? `SKU ${item.matched_product_sku}`
                    : "Без SKU"}
                  {item.match_source === "manual" ? " • избран ръчно" : ""}
                  {item.match_confidence != null
                    ? ` • ${Math.round(item.match_confidence * 100)}% увереност`
                    : ""}
                </p>
              </div>

              <Button
                type="button"
                variant={unresolved ? "default" : "outline"}
                className={
                  unresolved
                    ? "shrink-0 rounded-full bg-[#4f7cff] px-4 text-white hover:bg-[#4672ec]"
                    : "shrink-0 rounded-full border-[rgba(255,255,255,0.08)] bg-[#12162a] px-4 text-[#f3f6ff] hover:bg-[#1b2340]"
                }
                onClick={() =>
                  setRowMappingOpen((current) => ({
                    ...current,
                    [index]: !mappingOpen,
                  }))
                }
              >
                {mappingOpen
                  ? "Скрий"
                  : unresolved
                    ? "Избери продукт"
                    : "Смени"}
              </Button>
            </div>

            {mappingOpen && (
              <div className="mt-4 space-y-3 border-t border-[rgba(255,255,255,0.08)] pt-4">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={searchValue}
                    onChange={(event) => {
                      const value = event.target.value;
                      setRowSearchInput((current) => ({
                        ...current,
                        [index]: value,
                      }));
                      if (rowSearchError[index]) {
                        setRowSearchError((current) => ({
                          ...current,
                          [index]: "",
                        }));
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        fetchProductsForRow(index);
                      }
                    }}
                    placeholder="Търси по име или SKU"
                    className="border-[rgba(255,255,255,0.08)] bg-[#12162a] text-[#f3f6ff] placeholder:text-[#9aa8d6]"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full border-[rgba(255,255,255,0.08)] bg-[#12162a] text-[#f3f6ff] hover:bg-[#1b2340]"
                    disabled={searchBusy}
                    onClick={() => fetchProductsForRow(index)}
                  >
                    {searchBusy ? (
                      <>
                        <Spinner size="sm" />
                        Търсене...
                      </>
                    ) : (
                      "Търси"
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full border-[rgba(255,255,255,0.08)] bg-[#12162a] text-[#f3f6ff] hover:bg-[#1b2340]"
                    disabled={createBusy}
                    onClick={() => createProductForRow(index)}
                  >
                    {createBusy ? (
                      <>
                        <Spinner size="sm" />
                        Създаване...
                      </>
                    ) : (
                      "Създай нов"
                    )}
                  </Button>
                </div>

                {searchError ? (
                  <p className="text-xs text-[#f2b84b]">{searchError}</p>
                ) : null}
                {createError ? (
                  <p className="text-xs text-[#f29a9a]">{createError}</p>
                ) : null}

                {searchResults.length > 0 && (
                  <div className="space-y-2">
                    <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
                      {searchResults.map((product) => {
                        const selected = selectedId === product.id;
                        return (
                          <button
                            key={product.id}
                            type="button"
                            onClick={() =>
                              setRowSelectedProductId((current) => ({
                                ...current,
                                [index]: product.id,
                              }))
                            }
                            className={`w-full rounded-2xl border px-3 py-3 text-left transition-colors ${
                              selected
                                ? "border-[#4f7cff] bg-[rgba(79,124,255,0.14)]"
                                : "border-[rgba(255,255,255,0.08)] bg-[#12162a] hover:bg-[#1b2340]"
                            }`}
                          >
                            <p className="text-sm font-medium text-[#f3f6ff]">
                              {product.name_bg || product.name_en || "Без име"}
                            </p>
                            <p className="mt-1 text-xs text-[#9aa8d6]">
                              {product.sku ? `SKU ${product.sku}` : "Без SKU"}
                            </p>
                          </button>
                        );
                      })}
                    </div>

                    <Button
                      type="button"
                      className="rounded-full bg-[#4f7cff] text-white hover:bg-[#4672ec]"
                      onClick={() => bindSelectedProductForRow(index)}
                      disabled={!selectedId}
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

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-[20px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.16em] text-[#9aa8d6]">
                Цена от фактура
              </p>
              <p className="mt-1 text-sm font-semibold text-[#f3f6ff]">
                {formatCurrency(invoiceUnitPrice, scanned?.currency || "EUR")}
              </p>
            </div>
            <div className="rounded-[20px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-4 py-3">
              <p className="text-[11px] uppercase tracking-[0.16em] text-[#9aa8d6]">
                Каталожна цена
              </p>
              <p className="mt-1 text-sm font-semibold text-[#f3f6ff]">
                {catalogPrice != null
                  ? formatCurrency(catalogPrice, scanned?.currency || "EUR")
                  : "Няма"}
              </p>
              <p className="mt-1 text-[11px] text-[#9aa8d6]">Само за справка</p>
            </div>
            <div className="rounded-[20px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-4 py-3">
              <Label className="text-[11px] uppercase tracking-[0.16em] text-[#9aa8d6]">
                Продажна цена
              </Label>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={item.selling_price ?? ""}
                onChange={(event) =>
                  updateRowSellingPrice(index, event.target.value)
                }
                placeholder={
                  sellingPrice != null ? String(sellingPrice) : "0.00"
                }
                className="mt-2 border-[rgba(255,255,255,0.08)] bg-[#12162a] text-[#f3f6ff] placeholder:text-[#9aa8d6]"
              />
              <p className="mt-1 text-[11px] text-[#9aa8d6]">Редактируема</p>
            </div>
          </div>

          {missingDetails ? (
            <div className="inline-flex max-w-full items-center rounded-full border border-[rgba(242,184,75,0.28)] bg-[rgba(242,184,75,0.1)] px-3 py-1.5 text-xs font-medium text-[#f8e7b2]">
              Липсва партида или срок на годност — довърши от втория документ.
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  const resetCompletionState = () => {
    setCompletionDocId(null);
    setCompletionItems([]);
    setShowCompletionModal(false);
    setCompletionStep("ask");
    setCompanionScanning(false);
    setCompanionScanError("");
    setCompletionSaveError("");
    setSavingCompletion(false);
  };

  const handleSaveCompletion = async () => {
    if (!completionDocId) {
      setShowCompletionModal(false);
      return;
    }

    setCompletionSaveError("");
    setSavingCompletion(true);
    try {
      const updates = completionItems.filter(
        (item) => item.batch_number || item.expiry_date || item.production_date,
      );

      if (updates.length > 0) {
        await api.patch(`/incoming/${completionDocId}/batches`, {
          items: updates.map((item) => ({
            incoming_item_id: item.incoming_item_id ?? null,
            product_id: item.product_id,
            batch_number: item.batch_number || null,
            expiry_date: item.expiry_date || null,
            production_date: item.production_date || null,
          })),
        });
      }

      queryClient.invalidateQueries({ queryKey: ["owner", "incoming"] });
      queryClient.invalidateQueries({ queryKey: ["incoming"] });
      setShowCompletionModal(false);
    } catch (error) {
      setCompletionSaveError(
        getApiErrorMessage(
          error,
          "Партидите и сроковете не бяха записани. Провери данните и опитай отново.",
        ),
      );
    } finally {
      setSavingCompletion(false);
    }
  };

  const handleCompanionScan = async (file: File) => {
    setCompanionScanning(true);
    setCompanionScanError("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await api.post("/incoming/scan", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      const d = res.data ?? {};
      const companionSource = Array.isArray(d.items)
        ? d.items
        : Array.isArray(d.line_items)
          ? d.line_items
          : [];

      const companionItems: any[] = companionSource.map((li: any) => ({
        name_en: (li.product_name || li.name || "").toLowerCase(),
        name_bg: (li.name_bg || "").toLowerCase(),
        product_code: String(li.product_code ?? "")
          .trim()
          .toUpperCase(),
        batch_number: li.batch_number ?? null,
        production_date: li.production_date ?? null,
        expiry_date: li.expiry_date ?? null,
        auto_batch: li.auto_batch ?? null,
      }));

      const normalize = (value: string) =>
        value
          .toLowerCase()
          .replace(/[^a-zа-яё0-9]/gi, " ")
          .replace(/\s+/g, " ")
          .trim();

      const companionCodeIndex = new Map<string, number[]>();
      companionItems.forEach((item, index) => {
        if (!item.product_code) return;
        const existing = companionCodeIndex.get(item.product_code) ?? [];
        existing.push(index);
        companionCodeIndex.set(item.product_code, existing);
      });

      const usedCompanionIdx = new Set<number>();
      const updated = completionItems.map((item, index) => {
        const invoiceName = normalize(item.product_name || item.name_en || "");
        const invoiceCode = String(item.product_code ?? "")
          .trim()
          .toUpperCase();

        let matchIdx: number | null = null;
        if (invoiceCode) {
          const candidates = companionCodeIndex.get(invoiceCode) ?? [];
          matchIdx =
            candidates.find((candidate) => !usedCompanionIdx.has(candidate)) ??
            null;
        }

        if (matchIdx == null) {
          let bestScore = 0;
          companionItems.forEach((candidate, candidateIdx) => {
            if (usedCompanionIdx.has(candidateIdx)) return;
            const candidateName = normalize(
              `${candidate.name_en} ${candidate.name_bg}`,
            );
            const invoiceWords = invoiceName
              .split(" ")
              .filter((word) => word.length > 2);
            const candidateWords = candidateName
              .split(" ")
              .filter((word) => word.length > 2);
            const overlap = invoiceWords.filter((word) =>
              candidateWords.some(
                (candidateWord) =>
                  candidateWord.includes(word) || word.includes(candidateWord),
              ),
            ).length;

            if (overlap > bestScore) {
              bestScore = overlap;
              matchIdx = candidateIdx;
            }
          });
        }

        if (
          matchIdx == null &&
          companionItems[index] &&
          !usedCompanionIdx.has(index)
        ) {
          matchIdx = index;
        }

        if (matchIdx == null) {
          const firstUnused = companionItems.findIndex(
            (_, candidateIdx) => !usedCompanionIdx.has(candidateIdx),
          );
          matchIdx = firstUnused >= 0 ? firstUnused : null;
        }

        const match = matchIdx != null ? companionItems[matchIdx] : null;
        if (!match || matchIdx == null) return item;
        usedCompanionIdx.add(matchIdx);

        const expiry = match.expiry_date || item.expiry_date || "";
        const batch =
          match.batch_number ||
          match.auto_batch ||
          item.batch_number ||
          (match.production_date
            ? batchFromProdDate(match.production_date)
            : "") ||
          (expiry ? autoBatchFromExpiry(expiry) : "");

        return {
          ...item,
          expiry_date: expiry,
          batch_number: batch,
          production_date: match.production_date || item.production_date,
        };
      });

      setCompletionItems(updated);
      setCompletionStep("manual");
    } catch {
      setCompanionScanError("Грешка при сканиране на придружителния документ.");
    } finally {
      setCompanionScanning(false);
    }
  };

  const createIncomingMutation = useMutation({
    mutationFn: async () => {
      if (!scanned || (scanned.items ?? []).length === 0) {
        throw new Error("Няма сканирани редове за запис.");
      }
      if (isIncompleteExtraction) {
        throw new Error(
          "Сканирането е отбелязано като непълно. Коригирайте редовете преди запис.",
        );
      }
      if (requiresReviewAcceptance && !reviewAccepted) {
        throw new Error(
          "Потвърдете, че приемате съмнителното извличане преди запис.",
        );
      }

      const effectiveInvoiceDate =
        form.invoiceDate || normalizeDateInput(scanned.invoice_date);

      const payload = {
        supplier_name: form.supplierName || scanned.supplier_name || undefined,
        supplier_eik: scanned.supplier_eik || undefined,
        supplier_vat: scanned.supplier_vat || undefined,
        supplier_address: scanned.supplier_address || undefined,
        supplier_phone: scanned.supplier_phone || undefined,
        supplier_email: scanned.supplier_email || undefined,
        supplier_contact: scanned.supplier_contact || undefined,
        invoice_number:
          form.invoiceNumber || scanned.invoice_number || undefined,
        invoice_date: effectiveInvoiceDate || undefined,
        document_type: "invoice",
        scanned_file_path: scanned.scanned_file_path || undefined,
        visible_row_count: scanned.visible_row_count ?? undefined,
        extracted_row_count: scanned.extracted_row_count ?? undefined,
        completeness_status: scanned.completeness_status ?? undefined,
        warnings: scanned.warnings ?? undefined,
        strict_review_mode: true,
        review_accepted_for_completeness: reviewAccepted || undefined,
        allow_auto_create_unmatched: false,
        items: (scanned.items ?? []).map((item) => ({
          row_number: item.row_number ?? undefined,
          page_number: item.page_number ?? undefined,
          product_name_raw:
            item.product_name_raw ||
            item.name_en ||
            item.product_name ||
            item.name ||
            undefined,
          product_code_raw:
            item.product_code_raw || item.product_code || undefined,
          product_id: isMatchedForAutoLink(item)
            ? (item.matched_product_id ?? item.product_id ?? undefined)
            : (item.product_id ?? undefined),
          product_name:
            item.name_en ||
            item.product_name_raw ||
            item.product_name ||
            item.name ||
            item.name_bg ||
            undefined,
          name_bg: item.name_bg || item.name || undefined,
          product_code: item.product_code || undefined,
          match_confidence: item.match_confidence ?? undefined,
          match_source: item.match_source || undefined,
          brand: item.brand || undefined,
          category_hint: item.category_hint || undefined,
          unit: item.unit || "бр",
          batch_number_raw:
            item.batch_number_raw ||
            item.batch_number ||
            item.batch ||
            undefined,
          batch_number:
            item.batch_number ||
            item.batch ||
            item.batch_number_raw ||
            undefined,
          expiry_date_raw:
            item.expiry_date_raw ||
            item.expiry_date ||
            item.expiry ||
            undefined,
          expiry_date:
            item.expiry_date ||
            item.expiry ||
            item.expiry_date_raw ||
            undefined,
          production_date: item.production_date || undefined,
          notes_raw: item.notes_raw || undefined,
          quantity: Math.max(Number(item.quantity || 0), 0.001),
          unit_price: Math.max(Number(item.unit_price ?? item.price ?? 0), 0),
          selling_price: item.selling_price ?? undefined,
        })),
      };

      const response = await api.post("/incoming", payload);
      return response.data;
    },
    onSuccess: (data) => {
      const savedItems = Array.isArray(data?.items) ? data.items : [];
      const preparedCompletionItems = savedItems.map(
        (item: any, index: number) => {
          const sourceItem = scanned?.items?.[index] ?? null;
          return {
            ...item,
            product_name:
              item.name_bg ||
              sourceItem?.name_bg ||
              item.product_name ||
              sourceItem?.product_name ||
              sourceItem?.name ||
              "Продукт",
            name_en:
              item.product_name ||
              sourceItem?.product_name ||
              sourceItem?.name_en ||
              "",
            product_code: item.product_code || sourceItem?.product_code || null,
            incoming_item_id: item.id ?? null,
            batch_number:
              item.batch_number ||
              sourceItem?.batch_number ||
              sourceItem?.batch ||
              "",
            expiry_date:
              item.expiry_date ||
              sourceItem?.expiry_date ||
              sourceItem?.expiry ||
              "",
            production_date:
              item.production_date || sourceItem?.production_date || null,
          };
        },
      );
      setSavedIncomingId(data?.id ?? null);
      setCompletionDocId(data?.id ?? null);
      setCompletionItems(preparedCompletionItems);
      setCompletionStep("ask");
      setCompanionScanError("");
      setCompletionSaveError("");
      setShowCompletionModal(false);
      queryClient.invalidateQueries({ queryKey: ["owner", "incoming"] });
      queryClient.invalidateQueries({ queryKey: ["owner", "kpi"] });
      queryClient.invalidateQueries({ queryKey: ["incoming"] });
      setScanError("");
    },
    onError: (error: any) => {
      const message =
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        "Неуспешно записване на фактурата.";
      setScanError(message);
    },
  });

  const savePendingDisabled =
    createIncomingMutation.isPending ||
    matchingPreview ||
    isIncompleteExtraction ||
    (requiresReviewAcceptance && !reviewAccepted);
  const savePendingHelperText = isIncompleteExtraction
    ? "Запазването е блокирано, докато коригираш непълното извличане."
    : requiresReviewAcceptance && !reviewAccepted
      ? "Маркирай потвърждението за преглед, за да активираш записа."
      : matchingPreview
        ? "Изчакай matching preview да приключи, за да запишеш доставката."
        : companionRecommended
          ? "Първо записваш доставката. След това ще покажем само една ясна следваща стъпка: сканиране на втори документ."
          : "След записа ще покажем директен бутон „Към приемане“.";

  const handleFilePicked = async (file: File) => {
    setScanning(true);
    setScanProgressKey("upload");
    setScanEtaSeconds(45);
    setMatchingPreview(false);
    setReviewAccepted(false);
    setScanError("");
    resetManualResolveState();
    resetCompletionState();
    setDuplicateInfo(null);
    setScanned(null);
    setSavedIncomingId(null);

    try {
      const scanFormData = new FormData();
      scanFormData.append("file", file);

      const scanResponse = await api.post("/incoming/scan", scanFormData, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      setScanProgressKey("ocr");
      setScanEtaSeconds(28);
      const normalized = normalizeScannedInvoice(scanResponse.data);
      const extractedInvoiceNumber = normalized.invoice_number?.trim() ?? "";
      const duplicatePayload = normalized.duplicate_invoice ?? null;

      if (extractedInvoiceNumber && duplicatePayload?.duplicate) {
        const shouldContinue = await confirm({
          title: "Дублирана фактура",
          description: buildDuplicateInvoiceConfirmMessage(
            extractedInvoiceNumber,
            duplicatePayload,
          ),
          confirmText: "Продължи",
          variant: "danger",
        });

        if (!shouldContinue) {
          setDuplicateInfo(duplicatePayload as DuplicateInvoiceInfo);
          setScanError(
            buildDuplicateInvoiceCancelledMessage(extractedInvoiceNumber),
          );
          return;
        }
      }

      setDuplicateInfo(
        duplicatePayload?.duplicate
          ? (duplicatePayload as DuplicateInvoiceInfo)
          : null,
      );
      setScanError("");

      let enriched = normalized;

      if ((normalized.items ?? []).length > 0) {
        setScanProgressKey("matching");
        setScanEtaSeconds(14);
        setMatchingPreview(true);
        try {
          const previewResponse = await api.post("/incoming/match-preview", {
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

          const matches = Array.isArray(previewResponse.data?.matches)
            ? previewResponse.data.matches
            : [];
          if (matches.length > 0) {
            const mergedItems = normalized.items.map((item, idx) => {
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
            });
            enriched = { ...normalized, items: mergedItems };
          }
        } catch {
          // non-blocking: extraction review should continue even if matching preview fails
        } finally {
          setMatchingPreview(false);
        }
      }

      setScanProgressKey("review");
      setScanEtaSeconds(4);
      setScanned(enriched);
      setDefaultSearchFromScanned(enriched);
      setForm({
        supplierName: enriched.supplier_name || "",
        invoiceNumber: enriched.invoice_number || "",
        invoiceDate: normalizeDateInput(enriched.invoice_date),
      });
    } catch (error: any) {
      const message =
        error?.response?.data?.error ||
        error?.response?.data?.message ||
        "Неуспешно сканиране на фактурата.";
      setScanError(message);
    } finally {
      setScanning(false);
      setScanEtaSeconds(0);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-4 sm:px-6 sm:py-6">
      <Card className="overflow-hidden rounded-[32px] border-[rgba(255,255,255,0.08)] bg-[radial-gradient(circle_at_top_left,rgba(212,188,124,0.18),transparent_28%),linear-gradient(180deg,rgba(20,24,40,0.96),rgba(8,10,18,1))] text-[#f3f6ff] shadow-[0_24px_80px_rgba(0,0,0,0.35)]">
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-2xl space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#d4bc7c]">
                Olympus Noir · Owner Flow
              </p>
              <CardTitle className="text-2xl font-semibold tracking-tight text-[#f8faff] sm:text-[30px]">
                Сканиране на фактура
              </CardTitle>
              <p className="text-sm leading-6 text-[#c9d3f5] sm:text-[15px]">
                Качи или снимай фактура от телефона, запази като чакаща доставка
                и после продължи само по един ясен път: втори документ или
                приемане.
              </p>
            </div>
            <div className="grid min-w-[220px] grid-cols-2 gap-2 rounded-[24px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] p-3 text-sm">
              <div className="rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[rgba(9,12,24,0.55)] px-3 py-2.5">
                <p className="text-[11px] uppercase tracking-[0.18em] text-[#9aa8d6]">
                  Път
                </p>
                <p className="mt-1 font-semibold text-[#f3f6ff]">Една снимка</p>
              </div>
              <div className="rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[rgba(9,12,24,0.55)] px-3 py-2.5">
                <p className="text-[11px] uppercase tracking-[0.18em] text-[#9aa8d6]">
                  След записа
                </p>
                <p className="mt-1 font-semibold text-[#f3f6ff]">
                  1 следваща стъпка
                </p>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <input
            ref={cameraFileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              handleFilePicked(file);
              event.currentTarget.value = "";
            }}
          />
          <input
            ref={uploadFileRef}
            type="file"
            accept="application/pdf,image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              handleFilePicked(file);
              event.currentTarget.value = "";
            }}
          />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Button
              className="h-14 rounded-2xl bg-[#4f7cff] text-white shadow-[0_12px_30px_rgba(79,124,255,0.32)] hover:bg-[#4672ec]"
              onClick={() => cameraFileRef.current?.click()}
              disabled={scanning}
            >
              {scanning ? (
                <>
                  <Spinner size="sm" />
                  Сканиране...
                </>
              ) : (
                <>
                  <Camera className="h-4 w-4" />
                  Сними фактура
                </>
              )}
            </Button>
            <Button
              variant="outline"
              className="h-14 rounded-2xl border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] text-[#f3f6ff] hover:bg-[rgba(255,255,255,0.08)]"
              onClick={() => uploadFileRef.current?.click()}
              disabled={scanning}
            >
              <Upload className="h-4 w-4" />
              Качи файл / PDF
            </Button>
            <Button
              variant="outline"
              className="h-14 rounded-2xl border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] text-[#f3f6ff] hover:bg-[rgba(255,255,255,0.08)]"
              onClick={() => navigate("/owner/incoming")}
            >
              <FileText className="h-4 w-4" />
              Към приемане
            </Button>
          </div>
        </CardContent>
      </Card>

      {savedIncomingId !== null && (
        <Card className="overflow-hidden rounded-[30px] border-[rgba(123,240,191,0.22)] bg-[radial-gradient(circle_at_top_left,rgba(123,240,191,0.18),transparent_22%),linear-gradient(180deg,rgba(17,29,30,0.98),rgba(9,12,24,1))] text-[#f3f6ff] shadow-[0_20px_60px_rgba(0,0,0,0.3)]">
          <CardContent className="pt-6 space-y-5">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full bg-[rgba(37,195,139,0.16)] p-2 text-[#25c38b]">
                <CheckCircle2 className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#98efcb]">
                  Доставката е записана
                </p>
                <h2 className="text-xl font-semibold text-[#f3f6ff]">
                  {needsCompanionFollowUp
                    ? "Следва сканиране на втори документ"
                    : "Следва приемане в склада"}
                </h2>
                <p className="text-sm text-[#d7deff]">
                  {needsCompanionFollowUp
                    ? `Чакаща доставка #${savedIncomingId} е създадена. Остават ${pendingBatchExpiryCount} ${pendingBatchExpiryCount === 1 ? "ред" : "реда"} без партида или срок и затова показваме само една следваща стъпка.`
                    : `Чакаща доставка #${savedIncomingId} е създадена и вече можеш да продължиш към приемането.`}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              {needsCompanionFollowUp ? (
                <>
                  <Button
                    className="bg-[#4f7cff] hover:bg-[#4672ec] text-white"
                    onClick={openCompletionModal}
                  >
                    <FileText className="h-4 w-4" />
                    Сканирай втори документ
                  </Button>
                  <Button
                    variant="outline"
                    className="border-[#243055] bg-[#12162a] text-[#f3f6ff] hover:bg-[#161c34]"
                    onClick={() => {
                      setCompletionStep("manual");
                      setShowCompletionModal(true);
                    }}
                  >
                    Попълни ръчно
                  </Button>
                </>
              ) : (
                <Button
                  className="bg-[#25c38b] hover:bg-[#20b17e] text-white"
                  onClick={() =>
                    navigate(
                      savedIncomingId != null
                        ? `/owner/incoming?incoming=${savedIncomingId}`
                        : "/owner/incoming",
                    )
                  }
                >
                  <FileText className="h-4 w-4" />
                  Към приемане
                </Button>
              )}
              <Button
                variant="outline"
                className="border-[#243055] bg-[#12162a] text-[#f3f6ff] hover:bg-[#161c34]"
                onClick={() => {
                  setScanned(null);
                  setSavedIncomingId(null);
                  setReviewAccepted(false);
                  setMatchingPreview(false);
                  resetManualResolveState();
                  resetCompletionState();
                  setForm({
                    supplierName: "",
                    invoiceNumber: "",
                    invoiceDate: "",
                  });
                  uploadFileRef.current?.click();
                }}
              >
                Сканирай нова
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {scanning && (
        <Card className="rounded-3xl border-[rgba(79,124,255,0.35)] bg-[rgba(79,124,255,0.10)] text-[#f3f6ff] shadow-none">
          <CardContent className="pt-6 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-2 max-w-2xl">
                <p className="text-[11px] uppercase tracking-[0.18em] text-[#9aa8d6]">
                  Сканиране в ход
                </p>
                <h2 className="text-xl font-semibold flex items-center gap-2">
                  <ScanSearch className="h-5 w-5 text-[#4f7cff]" />
                  {SCAN_PROGRESS_STEPS[scanProgressIndex]?.title}
                </h2>
                <p className="text-sm text-[#d7deff]">
                  {SCAN_PROGRESS_STEPS[scanProgressIndex]?.plainLanguage}
                </p>
              </div>
              <div className="rounded-2xl border border-[rgba(79,124,255,0.28)] bg-[#12162a] px-4 py-3 text-sm text-[#d7deff] min-w-[180px]">
                <p className="text-[11px] uppercase tracking-[0.18em] text-[#9aa8d6]">
                  Очакване
                </p>
                <p className="mt-1 text-lg font-semibold text-[#f3f6ff]">
                  {scanEtaSeconds > 0
                    ? `~${scanEtaSeconds} сек.`
                    : "почти готово"}
                </p>
                <p className="mt-1 text-xs text-[#9aa8d6]">
                  Ако екранът е отворен, процесът продължава нормално.
                </p>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-4">
              {SCAN_PROGRESS_STEPS.map((step, index) => {
                const state =
                  index < scanProgressIndex
                    ? "done"
                    : index === scanProgressIndex
                      ? "active"
                      : "idle";
                return (
                  <div
                    key={step.key}
                    className={`rounded-2xl border px-4 py-3 ${
                      state === "done"
                        ? "border-[rgba(37,195,139,0.3)] bg-[rgba(37,195,139,0.08)]"
                        : state === "active"
                          ? "border-[rgba(79,124,255,0.35)] bg-[rgba(79,124,255,0.14)]"
                          : "border-[#243055] bg-[#12162a]"
                    }`}
                  >
                    <p className="text-[11px] uppercase tracking-[0.16em] text-[#9aa8d6]">
                      Етап {index + 1}
                    </p>
                    <p className="mt-1 font-semibold text-[#f3f6ff]">
                      {step.title}
                    </p>
                    <p className="mt-1 text-xs text-[#9aa8d6]">
                      {state === "done"
                        ? "Готово"
                        : state === "active"
                          ? "Изпълнява се"
                          : "Предстои"}
                    </p>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {(scanError || duplicateInfo?.duplicate) && (
        <div className="space-y-3">
          {scanError ? <ErrorMessage message={scanError} /> : null}
          {duplicateInfo?.duplicate && (
            <Card className="rounded-2xl border-[rgba(242,184,75,0.35)] bg-[rgba(242,184,75,0.08)] text-[#f3f6ff] shadow-none">
              <CardContent className="pt-4 text-sm space-y-2">
                <p className="font-semibold text-[#f2b84b] flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  Дублирана фактура
                </p>
                <p className="text-[#d7deff]">
                  ID: #{duplicateInfo.existing_id || "-"} • Статус:{" "}
                  {formatDuplicateInvoiceStatusLabel(duplicateInfo.status)}
                </p>
                {!scanError && (
                  <p className="text-xs text-[#d7deff]">
                    Продължаваш с повторен преглед на сканирането. Провери
                    внимателно преди запис.
                  </p>
                )}
                <Button
                  variant="outline"
                  className="border-[#243055] bg-[#12162a] text-[#f3f6ff] hover:bg-[#161c34]"
                  onClick={() => navigate("/owner/incoming")}
                >
                  Отвори приемане на доставки
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {scanned && (
        <Card className="rounded-[30px] border-[rgba(255,255,255,0.08)] bg-[linear-gradient(180deg,rgba(18,22,42,0.98),rgba(8,10,18,1))] text-[#f3f6ff] shadow-[0_20px_60px_rgba(0,0,0,0.24)]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base sm:text-lg">
              Данни от сканиране
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-[28px] border border-[rgba(255,255,255,0.08)] bg-[radial-gradient(circle_at_top_left,rgba(79,124,255,0.10),transparent_20%),rgba(18,22,42,0.88)] p-4 sm:p-5 space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-[#9aa8d6]">
                        Доставчик
                      </p>
                      <p className="mt-1 text-base font-semibold text-[#f3f6ff]">
                        {form.supplierName || "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-[#9aa8d6]">
                        Фактура
                      </p>
                      <p className="mt-1 text-base font-semibold text-[#f3f6ff]">
                        {form.invoiceNumber || "без номер"}
                        {form.invoiceDate ? ` • ${form.invoiceDate}` : ""}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.16em] text-[#9aa8d6]">
                        Обща сума
                      </p>
                      <p className="mt-1 text-base font-semibold text-[#f3f6ff]">
                        {scanned.total != null
                          ? formatCurrency(
                              scanned.total,
                              scanned.currency || "EUR",
                            )
                          : "—"}
                      </p>
                    </div>
                  </div>

                  <p className="text-sm text-[#d7deff]">{actionSummary}</p>
                </div>

                <span
                  className={`inline-flex items-center rounded-full border px-3 py-1.5 text-sm font-semibold ${reviewStatusClasses}`}
                >
                  {reviewStatusLabel}
                </span>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  className="border-[#243055] bg-[#161c34] text-[#f3f6ff] hover:bg-[#1b2340]"
                  onClick={() =>
                    rowsSectionRef.current?.scrollIntoView({
                      behavior: "smooth",
                      block: "start",
                    })
                  }
                >
                  Продължи с редовете
                </Button>
                {savedIncomingId === null ? (
                  <Button
                    className="bg-[#4f7cff] hover:bg-[#4672ec] text-white"
                    onClick={() => createIncomingMutation.mutate()}
                    disabled={savePendingDisabled}
                  >
                    {createIncomingMutation.isPending ? (
                      <>
                        <Spinner size="sm" />
                        Записване...
                      </>
                    ) : matchingPreview ? (
                      "Изчакване на matching..."
                    ) : (
                      "Запази като чакаща доставка"
                    )}
                  </Button>
                ) : null}
              </div>

              {savedIncomingId === null ? (
                <div className="rounded-2xl border border-[rgba(79,124,255,0.28)] bg-[rgba(79,124,255,0.08)] px-4 py-3 text-sm text-[#d7deff]">
                  <p className="font-medium text-[#f3f6ff]">
                    {companionRecommended
                      ? "След записа ще покажем само „Сканирай втори документ“"
                      : "След записа ще покажем само „Към приемане“"}
                  </p>
                  <p className="mt-1 text-xs text-[#9aa8d6]">
                    {savePendingHelperText}
                  </p>
                </div>
              ) : (
                <p className="text-xs text-[#9aa8d6]">
                  Детайлите по редовете остават видими отдолу, но основното
                  действие вече е горе в зелената карта.
                </p>
              )}

              {matchingPreview ? (
                <div className="rounded-xl border border-[rgba(79,124,255,0.35)] bg-[rgba(79,124,255,0.1)] px-3 py-2 text-sm text-[#d7deff]">
                  Изпълнява се отделен matching preview...
                </div>
              ) : null}

              {requiresReviewAcceptance && !isIncompleteExtraction ? (
                <label className="flex items-start gap-2 rounded-xl border border-[#243055] bg-[#161c34] px-3 py-2.5 text-sm text-[#d7deff]">
                  <input
                    type="checkbox"
                    checked={reviewAccepted}
                    onChange={(event) =>
                      setReviewAccepted(event.target.checked)
                    }
                    className="mt-0.5"
                  />
                  <span>
                    Потвърждавам, че ще прегледам внимателно редовете преди
                    запис.
                  </span>
                </label>
              ) : null}

              {isIncompleteExtraction ? (
                <div className="rounded-xl border border-[rgba(242,111,111,0.35)] bg-[rgba(242,111,111,0.1)] px-3 py-2 text-sm text-[#ffdede]">
                  Непълно извличане: запазването е блокирано до корекция на
                  редовете.
                </div>
              ) : null}

              {technicalWarnings.length > 0 ||
              duplicateLikeRows.length > 0 ||
              scanned.needs_review ? (
                <details className="rounded-xl border border-[#243055] bg-[#161c34] px-3 py-2.5 text-sm text-[#d7deff]">
                  <summary className="cursor-pointer list-none font-medium text-[#9aa8d6]">
                    Технически детайли
                  </summary>
                  <div className="mt-2 space-y-1 text-xs text-[#9aa8d6]">
                    {technicalWarnings.map((warning, index) => (
                      <p key={`${warning}-${index}`}>{warning}</p>
                    ))}
                    {duplicateLikeRows.length > 0 ? (
                      <p>
                        {duplicateLikeRows.length} реда изглеждат потенциално
                        дублирани.
                      </p>
                    ) : null}
                    {scanned.needs_review && technicalWarnings.length === 0 ? (
                      <p>Документът е маркиран за преглед.</p>
                    ) : null}
                  </div>
                </details>
              ) : null}
            </div>

            <div ref={rowsSectionRef} className="space-y-4">
              {actionRows.length > 0 ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[#f3f6ff]">
                        Нуждаят се от действие
                      </p>
                      <p className="text-xs text-[#9aa8d6]">
                        Първо са редовете, които блокират или искат проверка.
                      </p>
                    </div>
                    <span className="rounded-full border border-[rgba(242,184,75,0.35)] bg-[rgba(242,184,75,0.12)] px-2.5 py-1 text-xs font-semibold text-[#f8e7b2]">
                      {actionRows.length}
                    </span>
                  </div>

                  <div className="space-y-3">
                    {actionRows.map(renderInvoiceRowCard)}
                  </div>
                </div>
              ) : null}

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[#f3f6ff]">
                      Готови редове
                    </p>
                    <p className="text-xs text-[#9aa8d6]">
                      Редове без блокиращи липси или избори.
                    </p>
                  </div>
                  <span className="rounded-full border border-[rgba(37,195,139,0.28)] bg-[rgba(37,195,139,0.1)] px-2.5 py-1 text-xs font-semibold text-[#baf4dd]">
                    {readyRows.length}
                  </span>
                </div>

                <div className="space-y-3">
                  {readyRows.length > 0 ? (
                    readyRows.map(renderInvoiceRowCard)
                  ) : (
                    <div className="rounded-2xl border border-[#243055] bg-[#12162a] px-4 py-4 text-sm text-[#9aa8d6]">
                      Все още няма напълно готови редове.
                    </div>
                  )}
                </div>
              </div>
            </div>

            {savedIncomingId === null ? (
              <div className="flex flex-col gap-2">
                <Button
                  className="bg-[#4f7cff] hover:bg-[#4672ec] text-white"
                  onClick={() => createIncomingMutation.mutate()}
                  disabled={savePendingDisabled}
                >
                  {createIncomingMutation.isPending ? (
                    <>
                      <Spinner size="sm" />
                      Записване...
                    </>
                  ) : matchingPreview ? (
                    "Изчакване на matching..."
                  ) : (
                    "Запази като чакаща доставка"
                  )}
                </Button>
                <p className="text-xs text-[#9aa8d6]">
                  {savePendingHelperText}
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      <Dialog
        open={showCompletionModal}
        onOpenChange={(open) => {
          if (!open) {
            setShowCompletionModal(false);
            setCompletionStep("ask");
            setCompanionScanError("");
            setCompletionSaveError("");
          }
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-hidden border-[rgba(255,255,255,0.08)] bg-[radial-gradient(circle_at_top_left,rgba(212,188,124,0.12),transparent_22%),linear-gradient(180deg,rgba(14,18,34,0.99),rgba(7,9,16,1))] text-[#f3f6ff]">
          {completionSaveError && (
            <ErrorMessage message={completionSaveError} />
          )}

          {completionStep === "ask" && (
            <>
              <DialogHeader>
                <DialogTitle>📋 Липсват срокове на годност</DialogTitle>
                <DialogDescription className="text-[#9aa8d6]">
                  Фактурата е записана. За доставка #
                  {completionDocId ?? savedIncomingId ?? "-"}
                  има партиди без срок на годност. Следващата стъпка е да
                  сканираш втори документ, а ако го нямаш — попълни датите
                  ръчно.
                </DialogDescription>
              </DialogHeader>

              <div className="mt-5 flex flex-col gap-3">
                <label className="cursor-pointer">
                  <input
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png"
                    className="hidden"
                    disabled={companionScanning}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) {
                        void handleCompanionScan(file);
                        event.target.value = "";
                      }
                    }}
                  />
                  <div className="flex items-center gap-3 rounded-[24px] border border-[rgba(79,124,255,0.28)] bg-[linear-gradient(180deg,rgba(79,124,255,0.16),rgba(18,22,42,0.88))] px-4 py-4 transition-colors hover:bg-[linear-gradient(180deg,rgba(79,124,255,0.22),rgba(18,22,42,0.92))]">
                    {companionScanning ? (
                      <Spinner size="sm" />
                    ) : (
                      <span className="text-2xl">📄</span>
                    )}
                    <div>
                      <p className="font-semibold">Сканирай втори документ</p>
                      <p className="text-xs text-[#9aa8d6]">
                        Ще опитам да попълня сроковете и партидите автоматично.
                      </p>
                    </div>
                  </div>
                </label>

                {companionScanError && (
                  <p className="text-xs text-red-400 px-1">
                    {companionScanError}
                  </p>
                )}

                <Button
                  variant="outline"
                  className="h-14 justify-start rounded-[24px] border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] text-[#f3f6ff] hover:bg-[rgba(255,255,255,0.08)]"
                  onClick={() => setCompletionStep("manual")}
                >
                  ✏️ Въведи ръчно сроковете
                </Button>
              </div>
            </>
          )}

          {completionStep === "manual" && (
            <>
              <DialogHeader>
                <DialogTitle>✏️ Попълни срокове и партиди</DialogTitle>
                <DialogDescription className="text-[#9aa8d6]">
                  Добави липсващите дати на годност за записаната доставка.
                </DialogDescription>
              </DialogHeader>

              <div className="mt-4 flex-1 overflow-y-auto min-h-0 space-y-3 pr-1">
                {completionItems.map((item, index) => (
                  <div
                    key={item.incoming_item_id ?? index}
                    className="rounded-[24px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] p-4 space-y-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-medium text-sm">
                          {item.product_name}
                        </p>
                        {item.name_en && item.name_en !== item.product_name ? (
                          <p className="text-xs text-[#9aa8d6] uppercase tracking-wide">
                            На фактурата: {item.name_en}
                          </p>
                        ) : null}
                      </div>
                      <span className="text-xs text-[#9aa8d6]">
                        {Number(item.quantity ?? 0).toLocaleString("bg-BG", {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 3,
                        })}{" "}
                        {item.unit || "бр."}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label>Партида</Label>
                        <Input
                          value={item.batch_number ?? ""}
                          onChange={(event) =>
                            setCompletionItems((current) =>
                              current.map((entry, entryIndex) =>
                                entryIndex === index
                                  ? {
                                      ...entry,
                                      batch_number: event.target.value,
                                    }
                                  : entry,
                              ),
                            )
                          }
                          placeholder="напр. 00245680"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Годен до</Label>
                        <Input
                          type="date"
                          value={item.expiry_date ?? ""}
                          onChange={(event) =>
                            setCompletionItems((current) =>
                              current.map((entry, entryIndex) =>
                                entryIndex === index
                                  ? {
                                      ...entry,
                                      expiry_date: event.target.value,
                                    }
                                  : entry,
                              ),
                            )
                          }
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <DialogFooter className="mt-4 gap-2">
                <Button
                  variant="outline"
                  className="border-[#243055] bg-[#12162a] text-[#f3f6ff] hover:bg-[#161c34]"
                  onClick={() => setCompletionStep("ask")}
                >
                  ← Назад
                </Button>
                <Button
                  className="bg-[#4f7cff] hover:bg-[#4672ec] text-white"
                  onClick={() => void handleSaveCompletion()}
                  disabled={savingCompletion}
                >
                  {savingCompletion ? <Spinner size="sm" /> : null}
                  Запази сроковете
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
