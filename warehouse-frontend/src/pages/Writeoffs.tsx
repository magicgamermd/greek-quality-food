import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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

interface CreatedWriteoff {
  id: number;
  document_number: string;
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

// ---------------------------------------------------------------------------
// Download the НАП protocol PDF for a write-off. Mirrors the authenticated
// blob-download pattern used by Invoices.handleDownload (api.get with
// responseType:"blob" + a temporary <a download> click). The auth header is
// attached by the axios request interceptor in src/lib/api.ts.
// ---------------------------------------------------------------------------
async function downloadWriteoffPdf(id: number, documentNumber: string) {
  // Cache-buster — regenerated PDFs live at the same URL.
  const res = await api.get(`/inventory/write-offs/${id}/pdf?t=${Date.now()}`, {
    responseType: "blob",
  });
  const blob = new Blob([res.data], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${documentNumber}.pdf`;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    document.body.removeChild(link);
  }, 150);
}

// ---------------------------------------------------------------------------
// Product search field — debounced query against /products?search=… (the same
// endpoint Orders / IncomingGoods use). Self-contained so we don't pull in the
// heavier inline pickers from those pages.
// ---------------------------------------------------------------------------
function ProductSearchField({
  selected,
  onSelect,
}: {
  selected: ProductOption | null;
  onSelect: (product: ProductOption | null) => void;
}) {
  const [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search.trim(), 300);
  const [open, setOpen] = useState(false);

  const { data: results = [], isFetching } = useQuery<ProductOption[]>({
    queryKey: ["writeoff-product-search", debounced],
    enabled: debounced.length >= 2 && !selected,
    queryFn: () =>
      api
        .get(
          `/products?search=${encodeURIComponent(debounced)}&limit=10&catalog=true`,
        )
        .then((r) => {
          const raw = r.data;
          const rows = Array.isArray(raw)
            ? raw
            : Array.isArray(raw?.data)
              ? raw.data
              : [];
          return rows as ProductOption[];
        }),
  });

  if (selected) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-gray-300 bg-gray-50 px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {productLabel(selected)}
          </p>
          {selected.sku && (
            <p className="truncate font-mono text-xs text-gray-500">
              {selected.sku}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onSelect(null);
            setSearch("");
          }}
        >
          Смени
        </Button>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2 rounded-md border border-gray-300 px-3">
        <Search className="h-4 w-4 shrink-0 text-gray-400" />
        <Input
          autoFocus
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Търси продукт по име или SKU…"
          className="border-0 px-0 shadow-none focus-visible:ring-0"
        />
      </div>
      {open && debounced.length >= 2 && (
        <div className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg">
          {isFetching ? (
            <div className="px-3 py-3 text-sm text-gray-500">Търсене…</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-3 text-sm text-gray-500">
              Няма намерени продукти
            </div>
          ) : (
            results.map((product) => (
              <button
                type="button"
                key={product.id}
                onClick={() => {
                  onSelect(product);
                  setOpen(false);
                }}
                className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-gray-50"
              >
                <span className="text-sm font-medium">
                  {productLabel(product)}
                </span>
                {product.sku && (
                  <span className="font-mono text-xs text-gray-500">
                    {product.sku}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Batch select — UNLIKE the Orders BatchSelect, expired batches are NOT
// disabled here. The whole point of брак is removing expired stock, so an
// expired batch must remain selectable (shown in red). "Без партида" sends
// batch_id: null for opening-balance / non-batch inventory.
// ---------------------------------------------------------------------------
function BatchSelectField({
  productId,
  value,
  onChange,
}: {
  productId: number;
  value: string;
  onChange: (value: string) => void;
}) {
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
        value={value}
        onChange={(e) => onChange(e.target.value)}
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
}

// ---------------------------------------------------------------------------
// New write-off dialog
// ---------------------------------------------------------------------------
function WriteoffForm({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [product, setProduct] = useState<ProductOption | null>(null);
  const [batchId, setBatchId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState<WriteoffReason | "">("");
  const [notes, setNotes] = useState("");

  const reset = () => {
    setProduct(null);
    setBatchId("");
    setQuantity("");
    setReason("");
    setNotes("");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const quantityNum = Number.parseFloat(quantity);
  const canSubmit =
    !!product &&
    reason !== "" &&
    Number.isFinite(quantityNum) &&
    quantityNum > 0;

  const mutation = useMutation<CreatedWriteoff>({
    mutationFn: () =>
      api
        .post("/inventory/write-offs", {
          product_id: product!.id,
          batch_id: batchId ? Number.parseInt(batchId, 10) : null,
          quantity: quantityNum,
          reason,
          notes: notes.trim() || null,
        })
        .then((r) => r.data as CreatedWriteoff),
    onSuccess: async (created) => {
      qc.invalidateQueries({ queryKey: ["writeoffs"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      toast.success(`Брак ${created.document_number} е записан`);
      handleClose();
      try {
        await downloadWriteoffPdf(created.id, created.document_number);
      } catch {
        toast.error(
          "Бракът е записан, но протоколът не можа да се изтегли. Опитайте отново от списъка.",
        );
      }
    },
  });

  const saveError = mutation.error
    ? getApiErrorMessage(mutation.error, "Грешка при записване на брака.")
    : "";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>Нов брак</DialogTitle>
          <DialogDescription>
            Бракуване на продукт (вкл. партиди с изтекъл срок). Генерира НАП
            протокол.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="space-y-1.5">
            <Label>Продукт *</Label>
            <ProductSearchField
              selected={product}
              onSelect={(value) => {
                setProduct(value);
                setBatchId("");
              }}
            />
          </div>

          {product && (
            <div className="space-y-1.5">
              <Label>Партида</Label>
              <BatchSelectField
                productId={product.id}
                value={batchId}
                onChange={setBatchId}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Количество *</Label>
              <Input
                type="number"
                min="0"
                step="any"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Причина *</Label>
              <Select
                value={reason}
                onChange={(e) => setReason(e.target.value as WriteoffReason)}
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
          </div>

          <div className="space-y-1.5">
            <Label>Бележка</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Незадължителна бележка…"
              rows={3}
            />
          </div>
        </div>

        {saveError && <ErrorMessage message={saveError} />}

        <DialogFooter className="gap-2 shrink-0">
          <Button variant="outline" onClick={handleClose}>
            Отказ
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !canSubmit}
          >
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
// Page
// ---------------------------------------------------------------------------
export function Writeoffs() {
  const [formOpen, setFormOpen] = useState(false);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  const {
    data: writeoffs = [],
    isLoading,
    error,
  } = useQuery<WriteoffRow[]>({
    queryKey: ["writeoffs"],
    queryFn: () =>
      api.get("/inventory/write-offs?limit=100").then((r) => {
        const raw = r.data;
        return Array.isArray(raw)
          ? (raw as WriteoffRow[])
          : Array.isArray(raw?.data)
            ? (raw.data as WriteoffRow[])
            : [];
      }),
  });

  const handleDownload = async (row: WriteoffRow) => {
    setDownloadingId(row.id);
    try {
      await downloadWriteoffPdf(row.id, row.document_number);
    } catch {
      toast.error("Грешка при изтегляне на протокола.");
    } finally {
      setDownloadingId(null);
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
          <CardTitle>Списък ({writeoffs.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <TableSkeleton />
          ) : error ? (
            <div className="p-4">
              <ErrorMessage message="Грешка при зареждане на браковете" />
            </div>
          ) : writeoffs.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              Няма направени бракове.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Документ №</TableHead>
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
                  {writeoffs.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono font-medium">
                        {row.document_number}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-gray-600">
                        {row.written_off_at
                          ? formatDateTime(row.written_off_at)
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">
                          {row.product_name_bg ||
                            row.product_name_en ||
                            `#${row.product_id}`}
                        </div>
                        {row.product_sku && (
                          <div className="font-mono text-xs text-gray-500">
                            {row.product_sku}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {row.batch_number || (
                          <span className="text-gray-400">Без партида</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {toNumber(row.quantity)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {reasonLabel(row.reason)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(toNumber(row.total_cost))}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDownload(row)}
                          disabled={downloadingId === row.id}
                          title="Изтегли НАП протокол (PDF)"
                        >
                          {downloadingId === row.id ? (
                            <Spinner size="sm" />
                          ) : (
                            <FileDown className="h-4 w-4" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
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
