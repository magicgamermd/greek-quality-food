import React, { useEffect, useRef, useState } from "react";
import {
  useQueries,
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Plus, FileDown, Trash2, Search } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  getApiErrorMessage,
} from "@/lib/utils";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  DialogDescription,
} from "@/components/ui/dialog";
import { ErrorMessage, Spinner } from "@/components/ui/spinner";

// ---------------------------------------------------------------------------
// Reason → Bulgarian label. Values are the backend enum keys (mirror of the
// CHECK constraint on stock_writeoffs.reason).
// ---------------------------------------------------------------------------
const REASON_OPTIONS = [
  { value: "expired", label: "Изтекъл срок" },
  { value: "damaged", label: "Повреда" },
  { value: "theft", label: "Кражба/Липса" },
  { value: "count_correction", label: "Корекция (инвентаризация)" },
  { value: "recall", label: "Изтегляне (recall)" },
  { value: "other", label: "Друго" },
] as const;

type WriteoffReason = (typeof REASON_OPTIONS)[number]["value"];

const reasonLabel = (reason: string): string =>
  REASON_OPTIONS.find((r) => r.value === reason)?.label ?? reason;

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------
interface WriteoffRow {
  id: number;
  document_number: string;
  protocol_number?: string | null;
  product_id: number;
  product_name_bg?: string | null;
  product_name_en?: string | null;
  product_sku?: string | null;
  batch_id?: number | null;
  batch_number?: string | null;
  quantity: number | string;
  unit_cost?: number | string | null;
  total_cost?: number | string | null;
  reason: string;
  notes?: string | null;
  written_off_at?: string | null;
  written_off_by_email?: string | null;
}

// POST /inventory/write-offs/bulk → 201
interface BulkWriteoffResult {
  protocol_number: string;
  count: number;
  total_cost: number | string;
  lines: unknown[];
}

interface ProductOption {
  id: number;
  name_bg?: string | null;
  name_en?: string | null;
  sku?: string | null;
  unit?: string | null;
}

interface BatchOption {
  id: number;
  batch_number?: string | null;
  expiry_date?: string | null;
  quantity: number | string;
}

const productLabel = (product: ProductOption): string =>
  product.name_bg || product.name_en || `#${product.id}`;

function toNumber(value: number | string | null | undefined): number {
  if (value == null) return 0;
  const num = typeof value === "string" ? Number.parseFloat(value) : value;
  return Number.isFinite(num) ? num : 0;
}

function isExpired(expiry: string | null | undefined): boolean {
  if (!expiry) return false;
  const date = new Date(expiry);
  if (Number.isNaN(date.getTime())) return false;
  // Compare on calendar day in local time — a batch expiring today is treated
  // as expired (последен ден на годност вече е изтекъл за продажба).
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return date.getTime() <= today.getTime();
}

async function fetchProductOptions(query: string): Promise<ProductOption[]> {
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
      (row: any): ProductOption => ({
        id: Number(row.id),
        name_bg: row.name_bg ?? null,
        name_en: row.name_en ?? null,
        sku: row.sku ?? null,
        unit: row.unit ?? null,
      }),
    );
}

// ---------------------------------------------------------------------------
// Authenticated PDF blob download. Generalized to take a full URL + filename so
// it serves both the per-row legacy `/:id/pdf` endpoint and the combined
// `/protocol/<number>/pdf` endpoint. Mirrors the blob-download pattern used by
// Invoices.handleDownload — the auth header is attached by the axios request
// interceptor in src/lib/api.ts.
// ---------------------------------------------------------------------------
async function downloadPdf(url: string, filename: string) {
  const res = await api.get(url, { responseType: "blob" });
  const blob = new Blob([res.data], { type: "application/pdf" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
    document.body.removeChild(link);
  }, 150);
}

// Per-row legacy protocol (old single write-offs without a protocol_number).
// Cache-buster — regenerated PDFs live at the same URL.
function downloadWriteoffPdf(id: number, documentNumber: string) {
  return downloadPdf(
    `/inventory/write-offs/${id}/pdf?t=${Date.now()}`,
    `${documentNumber}.pdf`,
  );
}

// Combined НАП protocol listing all lines of a bulk брак act.
function downloadProtocolPdf(protocolNumber: string) {
  return downloadPdf(
    `/inventory/write-offs/protocol/${encodeURIComponent(
      protocolNumber,
    )}/pdf?t=${Date.now()}`,
    `${protocolNumber}.pdf`,
  );
}

// ---------------------------------------------------------------------------
// Batch select — UNLIKE the Orders BatchSelect, expired batches are NOT
// disabled here. The whole point of брак is removing expired stock, so an
// expired batch must remain selectable (shown in red). "Без партида" sends
// batch_id: null for opening-balance / non-batch inventory.
//
// Accepts a forwarded ref + onKeyDown so it slots into the row Enter-flow.
// ---------------------------------------------------------------------------
const BatchSelectField = React.forwardRef<
  HTMLSelectElement,
  {
    productId: number;
    value: string;
    onChange: (value: string) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLSelectElement>) => void;
  }
>(function BatchSelectField({ productId, value, onChange, onKeyDown }, ref) {
  const { data: batches = [], isLoading } = useQuery<BatchOption[]>({
    queryKey: ["writeoff-batches", productId],
    enabled: productId > 0,
    queryFn: () =>
      api.get(`/batches?product_id=${productId}&limit=100`).then((r) => {
        const raw = r.data;
        const rows = Array.isArray(raw)
          ? raw
          : Array.isArray(raw?.data)
            ? raw.data
            : [];
        return rows as BatchOption[];
      }),
  });

  const selectedBatch = batches.find((b) => String(b.id) === value);
  const selectedExpired = selectedBatch
    ? isExpired(selectedBatch.expiry_date)
    : false;

  const batchText = (batch: BatchOption): string => {
    const number = batch.batch_number || `#${batch.id}`;
    const expiry = batch.expiry_date
      ? `срок ${formatDate(batch.expiry_date)}`
      : "без срок";
    return `${number} · ${expiry} · налично ${toNumber(batch.quantity)}`;
  };

  return (
    <div className="space-y-1">
      <Select
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={isLoading}
        className={selectedExpired ? "text-red-600" : undefined}
      >
        <option value="">Без партида</option>
        {batches.map((batch) => (
          <option key={batch.id} value={String(batch.id)}>
            {isExpired(batch.expiry_date) ? "⚠ ИЗТЕКЪЛ — " : ""}
            {batchText(batch)}
          </option>
        ))}
      </Select>
      {selectedExpired && (
        <p className="text-xs font-medium text-red-600">
          Избрана е партида с изтекъл срок на годност.
        </p>
      )}
      {isLoading && <p className="text-xs text-gray-500">Зареждане…</p>}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Multi-line write-off (брак) state
// ---------------------------------------------------------------------------
interface WriteoffLine {
  product_id: number | null;
  // Display label of the picked product (search box value). When product_id is
  // set this is the chosen product's name; while searching it's the raw query.
  product_name: string;
  product_sku: string | null;
  batch_id: string;
  quantity: string;
  reason: WriteoffReason | "";
}

function emptyLine(reason: WriteoffReason | "" = ""): WriteoffLine {
  return {
    product_id: null,
    product_name: "",
    product_sku: null,
    batch_id: "",
    quantity: "",
    reason,
  };
}

const ROW_FIELD_ORDER = ["product", "batch", "quantity", "reason"] as const;
type RowField = (typeof ROW_FIELD_ORDER)[number];

// ---------------------------------------------------------------------------
// New (bulk) write-off dialog — mirrors the manual delivery multi-line form in
// IncomingGoods (ROW_FIELD_ORDER / focusRowField / handleRowFieldEnter Enter
// flow). One POST creates ONE protocol with many lines.
// ---------------------------------------------------------------------------
function WriteoffForm({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<WriteoffLine[]>([emptyLine()]);
  const [validationError, setValidationError] = useState("");
  const [errorRow, setErrorRow] = useState<number | null>(null);
  // Rows whose product-search dropdown the user dismissed (Escape / picked).
  const [searchDismissed, setSearchDismissed] = useState<
    Record<number, boolean>
  >({});
  const [searchHighlight, setSearchHighlight] = useState<
    Record<number, number>
  >({});

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowInputRefs = useRef<
    Record<string, HTMLInputElement | HTMLSelectElement | null>
  >({});
  const pendingFocusRef = useRef<string | null>(null);

  const reset = () => {
    setNotes("");
    setLines([emptyLine()]);
    setValidationError("");
    setErrorRow(null);
    setSearchDismissed({});
    setSearchHighlight({});
    rowInputRefs.current = {};
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  // -------------------------------------------------------------------------
  // Debounced per-row product search (one query per row, like IncomingGoods).
  // -------------------------------------------------------------------------
  const queryStrings = lines.map((line) =>
    line.product_id ? "" : line.product_name.trim(),
  );
  const debouncedKey = useDebouncedValue(queryStrings.join("§"), 250);
  const debouncedQueries = React.useMemo(
    () => debouncedKey.split("§"),
    [debouncedKey],
  );

  const searchQueries = useQueries({
    queries: lines.map((_line, index) => {
      const query = debouncedQueries[index] ?? "";
      return {
        queryKey: ["writeoff-product-search", query],
        queryFn: () => fetchProductOptions(query),
        enabled: query.length >= 2,
        staleTime: 30_000,
      };
    }),
  });

  const getResults = (rowIndex: number): ProductOption[] => {
    if (searchDismissed[rowIndex]) return [];
    if (lines[rowIndex]?.product_id) return [];
    return searchQueries[rowIndex]?.data ?? [];
  };

  const getLoading = (rowIndex: number): boolean => {
    if (searchDismissed[rowIndex]) return false;
    if (lines[rowIndex]?.product_id) return false;
    return Boolean(searchQueries[rowIndex]?.isFetching);
  };

  const getSearchHint = (rowIndex: number): string => {
    if (searchDismissed[rowIndex]) return "";
    if (lines[rowIndex]?.product_id) return "";
    const q = searchQueries[rowIndex];
    if (!q) return "";
    if (q.isError) return "Грешка при търсене на продукти.";
    if (q.isSuccess && (q.data?.length ?? 0) === 0) {
      const query = debouncedQueries[rowIndex] ?? "";
      if (query.length >= 2) return "Няма намерени продукти.";
    }
    return "";
  };

  // -------------------------------------------------------------------------
  // Row helpers
  // -------------------------------------------------------------------------
  const updateLine = (rowIndex: number, patch: Partial<WriteoffLine>) => {
    setLines((current) =>
      current.map((line, index) =>
        index === rowIndex ? { ...line, ...patch } : line,
      ),
    );
  };

  const selectProduct = (rowIndex: number, product: ProductOption) => {
    updateLine(rowIndex, {
      product_id: product.id,
      product_name: productLabel(product),
      product_sku: product.sku ?? null,
      // Picking a new product invalidates the previously chosen batch.
      batch_id: "",
    });
    setSearchDismissed((current) => ({ ...current, [rowIndex]: true }));
    // Move to the batch field once the product is chosen.
    setTimeout(() => focusRowField(rowIndex, "batch"), 0);
  };

  const addLine = (focusIndex?: number) => {
    setLines((current) => {
      // New rows inherit the previous row's reason — a 20-line "all expired"
      // брак is fast (default the new line's reason from the last line).
      const lastReason = current[current.length - 1]?.reason ?? "";
      const next = [...current, emptyLine(lastReason)];
      pendingFocusRef.current = `${focusIndex ?? next.length - 1}:product`;
      return next;
    });
  };

  const removeLine = (rowIndex: number) => {
    setLines((current) =>
      current.length === 1
        ? [emptyLine()]
        : current.filter((_, index) => index !== rowIndex),
    );
  };

  // -------------------------------------------------------------------------
  // Focus management (mirrors IncomingGoods.focusRowField + pendingFocus effect)
  // -------------------------------------------------------------------------
  const focusRowField = (index: number, field: RowField) => {
    const key = `${index}:${field}`;
    const el = rowInputRefs.current[key];
    if (!el) return false;
    el.focus();
    if (el instanceof HTMLInputElement) el.select();
    const scrollContainer = scrollRef.current;
    if (scrollContainer) {
      const elRect = el.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();
      const padding = field === "product" ? 240 : 80;
      if (elRect.top < containerRect.top + 20) {
        scrollContainer.scrollBy({
          top: elRect.top - containerRect.top - 20,
          behavior: "smooth",
        });
      } else if (elRect.bottom > containerRect.bottom - padding) {
        scrollContainer.scrollBy({
          top: elRect.bottom - containerRect.bottom + padding,
          behavior: "smooth",
        });
      }
    }
    return true;
  };

  // Apply pending focus after a new row renders + scroll the modal to it.
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    const key = pendingFocusRef.current;
    pendingFocusRef.current = null;
    const el = rowInputRefs.current[key];
    if (el) {
      el.focus();
      if (el instanceof HTMLInputElement) el.select();
      if (scrollRef.current) {
        scrollRef.current.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: "smooth",
        });
      }
    }
  }, [lines.length]);

  const handleRowFieldEnter = (
    e: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>,
    index: number,
    field: RowField,
  ) => {
    // Product field has richer keyboard handling (↑ ↓ Enter / Escape).
    if (field === "product") {
      const results = getResults(index);
      const highlighted = searchHighlight[index] ?? 0;

      if (e.key === "ArrowDown" && results.length > 0) {
        e.preventDefault();
        setSearchHighlight((current) => ({
          ...current,
          [index]: Math.min(highlighted + 1, results.length - 1),
        }));
        return;
      }
      if (e.key === "ArrowUp" && results.length > 0) {
        e.preventDefault();
        setSearchHighlight((current) => ({
          ...current,
          [index]: Math.max(highlighted - 1, 0),
        }));
        return;
      }
      if (e.key === "Escape" && results.length > 0) {
        e.preventDefault();
        setSearchDismissed((current) => ({ ...current, [index]: true }));
        return;
      }
      if (e.key === "Enter") {
        if (results.length > 0 && !lines[index]?.product_id) {
          e.preventDefault();
          const pick = results[highlighted] ?? results[0];
          selectProduct(index, pick);
          return;
        }
        if (lines[index]?.product_id) {
          e.preventDefault();
          focusRowField(index, "batch");
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

    // Last field of the row — add a new row (last row) or jump to next row.
    const isLastRow = index === lines.length - 1;
    if (isLastRow) {
      addLine(index + 1);
    } else {
      focusRowField(index + 1, "product");
    }
  };

  // -------------------------------------------------------------------------
  // Save
  // -------------------------------------------------------------------------
  const mutation = useMutation<BulkWriteoffResult>({
    mutationFn: () => {
      const payloadLines = lines.map((line) => ({
        product_id: line.product_id,
        batch_id: line.batch_id ? Number.parseInt(line.batch_id, 10) : null,
        quantity: Number.parseFloat(line.quantity),
        reason: line.reason,
      }));
      return api
        .post("/inventory/write-offs/bulk", {
          notes: notes.trim() || undefined,
          lines: payloadLines,
        })
        .then((r) => r.data as BulkWriteoffResult);
    },
    onSuccess: async (result) => {
      qc.invalidateQueries({ queryKey: ["writeoffs"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      toast.success(
        `Бракувани ${result.count} продукта (Протокол ${result.protocol_number})`,
      );
      handleClose();
      try {
        await downloadProtocolPdf(result.protocol_number);
      } catch {
        toast.error(
          "Бракът е записан, но протоколът не можа да се изтегли. Опитайте отново от списъка.",
        );
      }
    },
    onError: (error) => {
      // Backend rolls back the whole act on a failing line and returns
      // { error, line_index }. Highlight + scroll to that row.
      const data = (error as any)?.response?.data;
      const lineIndex =
        typeof data?.line_index === "number" ? data.line_index : null;
      if (lineIndex != null) {
        setErrorRow(lineIndex);
        setTimeout(() => focusRowField(lineIndex, "product"), 0);
      }
    },
  });

  const handleSubmit = () => {
    setValidationError("");
    setErrorRow(null);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.product_id) {
        setValidationError(`Ред ${index + 1}: изберете продукт.`);
        setErrorRow(index);
        focusRowField(index, "product");
        return;
      }
      const quantityNum = Number.parseFloat(line.quantity);
      if (!Number.isFinite(quantityNum) || quantityNum <= 0) {
        setValidationError(
          `Ред ${index + 1}: количеството трябва да е положително число.`,
        );
        setErrorRow(index);
        focusRowField(index, "quantity");
        return;
      }
      if (line.reason === "") {
        setValidationError(`Ред ${index + 1}: изберете причина.`);
        setErrorRow(index);
        focusRowField(index, "reason");
        return;
      }
    }

    mutation.mutate();
  };

  const saveError = mutation.error
    ? getApiErrorMessage(mutation.error, "Грешка при записване на брака.")
    : "";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-[98vw] lg:max-w-[1280px] max-h-[92vh] overflow-hidden flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5 text-[#6c3dff]" />
            Нов брак
          </DialogTitle>
          <DialogDescription>
            Бракуване на много продукти в един протокол (вкл. партиди с изтекъл
            срок). Генерира един НАП протокол.
          </DialogDescription>
        </DialogHeader>

        {(validationError || saveError) && (
          <div className="shrink-0">
            <ErrorMessage message={validationError || saveError} />
          </div>
        )}

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto min-h-0 space-y-6 pr-1"
        >
          <div className="space-y-1.5">
            <Label>Бележка (за целия протокол)</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Незадължителна бележка…"
              rows={2}
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h4 className="font-medium text-gray-900">
                Продукти за бракуване
              </h4>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => addLine()}
              >
                <Plus className="h-4 w-4" />
                Добави ред
              </Button>
            </div>

            <div className="space-y-3">
              {lines.map((line, index) => (
                <div
                  key={index}
                  className={`grid grid-cols-1 md:grid-cols-[2fr_1.6fr_0.8fr_1.2fr_2.5rem] gap-3 items-end rounded-lg border p-3 ${
                    errorRow === index
                      ? "border-red-400 bg-red-50/40"
                      : "border-gray-200"
                  }`}
                >
                  {/* Продукт */}
                  <div className="min-w-0 space-y-1.5">
                    <Label>Продукт *</Label>
                    <div className="space-y-2">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                        <Input
                          ref={(el) => {
                            rowInputRefs.current[`${index}:product`] = el;
                          }}
                          value={line.product_name}
                          onChange={(e) => {
                            updateLine(index, {
                              product_id: null,
                              product_sku: null,
                              product_name: e.target.value,
                            });
                            // Typing re-opens the dropdown after Escape / pick.
                            setSearchDismissed((current) => {
                              if (!current[index]) return current;
                              const nextState = { ...current };
                              delete nextState[index];
                              return nextState;
                            });
                          }}
                          onKeyDown={(e) =>
                            handleRowFieldEnter(e, index, "product")
                          }
                          placeholder="Търси продукт по име или SKU…"
                          className="h-9 pl-9 pr-9 text-sm"
                        />
                        {getLoading(index) ? (
                          <div className="absolute right-3 top-1/2 -translate-y-1/2">
                            <Spinner size="sm" />
                          </div>
                        ) : null}
                      </div>

                      {line.product_id && line.product_sku ? (
                        <p className="font-mono text-xs text-gray-500">
                          {line.product_sku}
                        </p>
                      ) : null}

                      {getSearchHint(index) && !getLoading(index) ? (
                        <p className="text-xs text-red-600">
                          {getSearchHint(index)}
                        </p>
                      ) : null}

                      {getResults(index).length > 0 ? (
                        <div className="max-h-72 divide-y overflow-y-auto rounded-md border bg-white shadow-sm">
                          {getResults(index).map((product, productIdx) => {
                            const isHighlighted =
                              (searchHighlight[index] ?? 0) === productIdx;
                            return (
                              <button
                                key={product.id}
                                type="button"
                                ref={(el) => {
                                  if (el && isHighlighted) {
                                    el.scrollIntoView({ block: "nearest" });
                                  }
                                }}
                                className={`w-full px-4 py-3 text-left ${
                                  isHighlighted
                                    ? "bg-purple-50"
                                    : "hover:bg-gray-50"
                                }`}
                                onMouseEnter={() =>
                                  setSearchHighlight((current) => ({
                                    ...current,
                                    [index]: productIdx,
                                  }))
                                }
                                onClick={() => selectProduct(index, product)}
                              >
                                <div className="text-sm font-medium text-gray-900">
                                  {productLabel(product)}
                                </div>
                                <div className="mt-0.5 text-xs text-gray-500">
                                  {product.sku
                                    ? `SKU: ${product.sku}`
                                    : "Без SKU"}
                                  {product.unit ? ` • ${product.unit}` : ""}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {/* Партида */}
                  <div className="space-y-1.5">
                    <Label>Партида</Label>
                    {line.product_id ? (
                      <BatchSelectField
                        ref={(el) => {
                          rowInputRefs.current[`${index}:batch`] = el;
                        }}
                        productId={line.product_id}
                        value={line.batch_id}
                        onChange={(value) =>
                          updateLine(index, { batch_id: value })
                        }
                        onKeyDown={(e) =>
                          handleRowFieldEnter(e, index, "batch")
                        }
                      />
                    ) : (
                      <Select disabled>
                        <option>Първо изберете продукт</option>
                      </Select>
                    )}
                  </div>

                  {/* Количество */}
                  <div className="space-y-1.5">
                    <Label>Кол-во *</Label>
                    <Input
                      ref={(el) => {
                        rowInputRefs.current[`${index}:quantity`] = el;
                      }}
                      type="number"
                      min="0"
                      step="any"
                      value={line.quantity}
                      onChange={(e) =>
                        updateLine(index, { quantity: e.target.value })
                      }
                      onKeyDown={(e) =>
                        handleRowFieldEnter(e, index, "quantity")
                      }
                      placeholder="0"
                    />
                  </div>

                  {/* Причина */}
                  <div className="space-y-1.5">
                    <Label>Причина *</Label>
                    <Select
                      ref={(el) => {
                        rowInputRefs.current[`${index}:reason`] = el;
                      }}
                      value={line.reason}
                      onChange={(e) =>
                        updateLine(index, {
                          reason: e.target.value as WriteoffReason,
                        })
                      }
                      onKeyDown={(e) => handleRowFieldEnter(e, index, "reason")}
                    >
                      <option value="" disabled>
                        Изберете…
                      </option>
                      {REASON_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </div>

                  {/* Изтрий ред */}
                  <div className="flex items-end justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Изтрий ред"
                      title="Изтрий ред"
                      onClick={() => removeLine(index)}
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter className="mt-4 shrink-0 gap-2">
          <Button variant="outline" onClick={handleClose}>
            Отказ
          </Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending}>
            {mutation.isPending ? (
              <>
                <Spinner size="sm" />
                Записване…
              </>
            ) : (
              "Запиши брак"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton (house style has no shared Skeleton component, so a small
// table-shaped pulse is rendered inline — per spec: skeleton, not spinner).
// ---------------------------------------------------------------------------
function TableSkeleton() {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          className="h-10 w-full animate-pulse rounded bg-gray-100"
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grouping — bulk брак acts share a protocol_number and collapse into a single
// list entry; legacy single write-offs (protocol_number == null) stay standalone.
// ---------------------------------------------------------------------------
interface ProtocolGroup {
  kind: "protocol";
  protocol_number: string;
  rows: WriteoffRow[];
  product_count: number;
  total_cost: number;
  written_off_at: string | null;
}
interface StandaloneEntry {
  kind: "single";
  row: WriteoffRow;
}
type ListEntry = ProtocolGroup | StandaloneEntry;

function groupWriteoffs(rows: WriteoffRow[]): ListEntry[] {
  const groups = new Map<string, WriteoffRow[]>();
  const entries: ListEntry[] = [];

  for (const row of rows) {
    const proto = row.protocol_number?.trim();
    if (proto) {
      const existing = groups.get(proto);
      if (existing) {
        existing.push(row);
      } else {
        const bucket = [row];
        groups.set(proto, bucket);
        // Reserve the position at first sighting so order follows the list.
        entries.push({
          kind: "protocol",
          protocol_number: proto,
          rows: bucket,
          product_count: 0,
          total_cost: 0,
          written_off_at: null,
        });
      }
    } else {
      entries.push({ kind: "single", row });
    }
  }

  // Finalize aggregates for protocol groups.
  return entries.map((entry) => {
    if (entry.kind !== "protocol") return entry;
    const rowsForProto = entry.rows;
    return {
      ...entry,
      product_count: rowsForProto.length,
      total_cost: rowsForProto.reduce(
        (sum, row) => sum + toNumber(row.total_cost),
        0,
      ),
      written_off_at: rowsForProto[0]?.written_off_at ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function Writeoffs() {
  const [formOpen, setFormOpen] = useState(false);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);

  const {
    data: writeoffs = [],
    isLoading,
    error,
  } = useQuery<WriteoffRow[]>({
    queryKey: ["writeoffs"],
    queryFn: () =>
      api.get("/inventory/write-offs?limit=200").then((r) => {
        const raw = r.data;
        return Array.isArray(raw)
          ? (raw as WriteoffRow[])
          : Array.isArray(raw?.data)
            ? (raw.data as WriteoffRow[])
            : [];
      }),
  });

  const entries = groupWriteoffs(writeoffs);

  const handleDownloadProtocol = async (protocolNumber: string) => {
    setDownloadingKey(`proto:${protocolNumber}`);
    try {
      await downloadProtocolPdf(protocolNumber);
    } catch {
      toast.error("Грешка при изтегляне на протокола.");
    } finally {
      setDownloadingKey(null);
    }
  };

  const handleDownloadSingle = async (row: WriteoffRow) => {
    setDownloadingKey(`row:${row.id}`);
    try {
      await downloadWriteoffPdf(row.id, row.document_number);
    } catch {
      toast.error("Грешка при изтегляне на протокола.");
    } finally {
      setDownloadingKey(null);
    }
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
            <Trash2 className="h-6 w-6 text-[#6c3dff]" />
            Брак
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Бракуване на продукти и партиди с изтекъл срок · НАП протокол
          </p>
        </div>
        <Button onClick={() => setFormOpen(true)}>
          <Plus className="h-4 w-4" />
          Нов брак
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Списък ({entries.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <TableSkeleton />
          ) : error ? (
            <div className="p-4">
              <ErrorMessage message="Грешка при зареждане на браковете" />
            </div>
          ) : entries.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              Няма направени бракове.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Протокол / Документ №</TableHead>
                    <TableHead>Дата</TableHead>
                    <TableHead>Продукт</TableHead>
                    <TableHead>Партида</TableHead>
                    <TableHead className="text-right">Кол-во</TableHead>
                    <TableHead>Причина</TableHead>
                    <TableHead className="text-right">Стойност</TableHead>
                    <TableHead className="text-right">Протокол</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) =>
                    entry.kind === "protocol" ? (
                      <TableRow key={`proto:${entry.protocol_number}`}>
                        <TableCell className="font-mono font-medium">
                          {entry.protocol_number}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm text-gray-600">
                          {entry.written_off_at
                            ? formatDateTime(entry.written_off_at)
                            : "—"}
                        </TableCell>
                        <TableCell colSpan={3}>
                          <Badge variant="secondary">
                            {entry.product_count} продукта
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-gray-500">
                          Многоредов брак
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatCurrency(entry.total_cost)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              handleDownloadProtocol(entry.protocol_number)
                            }
                            disabled={
                              downloadingKey ===
                              `proto:${entry.protocol_number}`
                            }
                            title="Изтегли НАП протокол (PDF)"
                          >
                            {downloadingKey ===
                            `proto:${entry.protocol_number}` ? (
                              <Spinner size="sm" />
                            ) : (
                              <FileDown className="h-4 w-4" />
                            )}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ) : (
                      <TableRow key={`row:${entry.row.id}`}>
                        <TableCell className="font-mono font-medium">
                          {entry.row.document_number}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm text-gray-600">
                          {entry.row.written_off_at
                            ? formatDateTime(entry.row.written_off_at)
                            : "—"}
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">
                            {entry.row.product_name_bg ||
                              entry.row.product_name_en ||
                              `#${entry.row.product_id}`}
                          </div>
                          {entry.row.product_sku && (
                            <div className="font-mono text-xs text-gray-500">
                              {entry.row.product_sku}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {entry.row.batch_number || (
                            <span className="text-gray-400">Без партида</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {toNumber(entry.row.quantity)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">
                            {reasonLabel(entry.row.reason)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatCurrency(toNumber(entry.row.total_cost))}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDownloadSingle(entry.row)}
                            disabled={downloadingKey === `row:${entry.row.id}`}
                            title="Изтегли НАП протокол (PDF)"
                          >
                            {downloadingKey === `row:${entry.row.id}` ? (
                              <Spinner size="sm" />
                            ) : (
                              <FileDown className="h-4 w-4" />
                            )}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ),
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <WriteoffForm open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}
