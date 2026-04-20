import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Camera,
  Check,
  FileText,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { formatCurrency, getApiErrorMessage } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { Combobox } from "@/components/ui/combobox";
import { cn } from "@/lib/utils";

type ScannedItem = {
  product_name: string;
  name_bg?: string;
  product_code?: string;
  quantity: number;
  unit_price: number;
  total_price?: number;
  // Match fields (filled from /incoming/match-preview)
  matched_product_id?: number | null;
  matched_product_name?: string | null;
  matched_product_sku?: string | null;
  match_confidence?: number | null;
  match_source?: "sku" | "alias" | "fuzzy" | "translit" | "ai" | "none" | null;
  suggestions?: Array<{
    id: number;
    name_bg: string;
    sku: string;
    confidence: number;
  }>;
  // Selling price = price to customers. Auto-populated from DB when row is
  // linked to a product; editable inline. If user changes it, we patch the
  // product on save so the catalog reflects the new price.
  selling_price?: number | null;
  selling_price_db?: number | null; // snapshot of DB value at link-time
};

type ScanResult = {
  supplier_id?: number | null;
  supplier_eik?: string | null;
  supplier_name?: string | null;
  invoice_number?: string | null;
  invoice_date?: string | null;
  total_amount?: number | null;
  items: ScannedItem[];
  duplicate?: {
    duplicate: true;
    existing_id: number;
    status: string;
    created_at: string;
    message: string;
  } | null;
};

type Product = {
  id: number;
  name_bg: string;
  name_en?: string;
  sku: string;
  purchase_price?: number;
  selling_price?: number;
};

type Step = "idle" | "scanning" | "review" | "saving" | "done";

export function OwnerScan() {
  const [step, setStep] = useState<Step>("idle");
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [items, setItems] = useState<ScannedItem[]>([]);
  const [scannedFile, setScannedFile] = useState<File | null>(null);
  const [isTraining, setIsTraining] = useState(false);
  const [trainedFor, setTrainedFor] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();

  // Load products catalog for the dropdown (cached, used for manual matching)
  const { data: products = [] } = useQuery<Product[]>({
    queryKey: ["owner-products-catalog"],
    queryFn: async () => {
      const res = await api.get("/products?limit=2000&catalog=true");
      return Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
    },
    staleTime: 5 * 60_000,
  });

  // Load suppliers for the "confirm supplier" Combobox on the review screen.
  // Small list (~100 rows), cached 5 min. Used as fallback when AI's
  // auto-link misses (e.g. Greek-scripted name not matched to Latin record).
  type SupplierLite = {
    id: number;
    name: string;
    eik?: string | null;
    vat_number?: string | null;
  };
  const { data: suppliersCatalog = [] } = useQuery<SupplierLite[]>({
    queryKey: ["owner-suppliers-catalog"],
    queryFn: async () => {
      const res = await api.get("/suppliers?limit=500");
      return Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
    },
    staleTime: 5 * 60_000,
  });

  // User's explicit supplier pick (overrides AI auto-match). `null` means
  // "use whatever the backend resolves via alias / EIK / fuzzy". Set via
  // Combobox on review screen; telling backend this is user_confirmed
  // causes it to upsert an authoritative alias so future scans link fast.
  const [supplierOverrideId, setSupplierOverrideId] = useState<number | null>(
    null,
  );

  const scanMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const scanRes = await api.post("/incoming/scan", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        // Match backend's 120s AI timeout + buffer for network / processing.
        // When Gemini is rate-limited (503), fallback chain can take 60-90s.
        timeout: 150_000,
      });
      const data = scanRes.data ?? {};
      const rawItems: any[] = Array.isArray(data.items)
        ? data.items
        : Array.isArray(data.line_items)
          ? data.line_items
          : [];

      // AI may populate any of these name fields — normalize to a single display string.
      const pickName = (li: any): string =>
        (
          li.product_name_raw ||
          li.product_name ||
          li.name_en ||
          li.name ||
          li.name_bg ||
          li.description ||
          ""
        ).trim();

      let matched: ScannedItem[] = rawItems.map((li: any) => ({
        product_name: pickName(li),
        name_bg: li.name_bg ?? "",
        product_code: li.product_code_raw ?? li.product_code ?? "",
        quantity: parseFloat(li.quantity ?? 1),
        unit_price: parseFloat(li.unit_price ?? li.price ?? 0),
        total_price: parseFloat(li.total_price ?? 0),
      }));

      if (matched.length > 0) {
        try {
          const matchRes = await api.post("/incoming/match-preview", {
            supplier_name: data.supplier_name ?? "",
            supplier_eik: data.supplier_eik ?? data.supplier?.eik ?? null,
            items: rawItems.map((li: any) => ({
              product_name_raw: li.product_name_raw ?? pickName(li),
              product_name: pickName(li),
              name_bg: li.name_bg ?? null,
              product_code: li.product_code_raw ?? li.product_code ?? null,
              quantity: parseFloat(li.quantity ?? 1),
              unit_price: parseFloat(li.unit_price ?? li.price ?? 0),
            })),
          });
          // Backend returns { matches: [...] } — see routes/incoming.ts:1679
          const matches: any[] = Array.isArray(matchRes.data?.matches)
            ? matchRes.data.matches
            : Array.isArray(matchRes.data?.items)
              ? matchRes.data.items
              : Array.isArray(matchRes.data)
                ? matchRes.data
                : [];
          matched = matched.map((item, idx) => {
            const m = matches[idx] ?? {};
            const sellingFromMatch =
              m.matched_selling_price ?? m.selling_price ?? null;
            return {
              ...item,
              matched_product_id: m.matched_product_id ?? m.product_id ?? null,
              matched_product_name:
                m.matched_product_name ?? m.product_name ?? null,
              matched_product_sku: m.matched_product_sku ?? m.sku ?? null,
              match_confidence: m.confidence ?? null,
              match_source: m.match_source ?? "none",
              suggestions: m.suggestions ?? [],
              selling_price:
                sellingFromMatch != null ? Number(sellingFromMatch) : null,
              selling_price_db:
                sellingFromMatch != null ? Number(sellingFromMatch) : null,
            };
          });
        } catch (err) {
          console.warn("match-preview failed", err);
        }
      }

      return {
        supplier_id: data.supplier_id ?? null,
        supplier_eik: data.supplier_eik ?? null,
        supplier_name: data.supplier_name ?? "",
        invoice_number: data.invoice_number ?? "",
        invoice_date: data.invoice_date ?? "",
        total_amount: parseFloat(data.total_amount ?? 0),
        items: matched,
        duplicate:
          data.duplicate_invoice && data.duplicate_invoice.duplicate
            ? data.duplicate_invoice
            : null,
      } as ScanResult;
    },
    onSuccess: (data) => {
      setScanResult(data);
      setItems(data.items);
      setStep("review");
    },
    onError: (err) => {
      toast.error(
        getApiErrorMessage(
          err,
          "Грешка при сканирането. Опитай с по-ясна снимка.",
        ),
      );
      setStep("idle");
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!scanResult) throw new Error("Няма сканирана фактура");

      // 1. Patch selling prices for products where user changed the value.
      //    Done before creating the delivery so new stock has the right price.
      const priceUpdates = items.filter(
        (i) =>
          i.matched_product_id &&
          i.selling_price != null &&
          i.selling_price > 0 &&
          i.selling_price !== i.selling_price_db,
      );
      if (priceUpdates.length > 0) {
        await Promise.allSettled(
          priceUpdates.map((i) =>
            api.put(`/products/${i.matched_product_id}`, {
              selling_price: i.selling_price,
            }),
          ),
        );
      }

      // 2. Create the incoming delivery with items.
      //    Strip undefined/null keys so backend Zod schemas don't complain
      //    about optional fields being explicitly null.
      const cleanObj = <T extends object>(o: T): Partial<T> =>
        Object.fromEntries(
          Object.entries(o).filter(
            ([, v]) => v !== null && v !== undefined && v !== "",
          ),
        ) as Partial<T>;

      // Coerce numeric fields defensively — DB numerics can come back as strings.
      const toNum = (v: any): number | undefined => {
        if (v === null || v === undefined || v === "") return undefined;
        const n = typeof v === "number" ? v : parseFloat(String(v));
        return Number.isFinite(n) ? n : undefined;
      };

      // User's explicit pick on the review screen wins. Telling the backend
      // the choice is authoritative (explicit) causes it to upsert a
      // user_confirmed alias keyed to the AI-extracted raw name — so the
      // NEXT scan from the same supplier auto-links via strategy 0 (alias)
      // without guessing.
      const resolvedSupplierId =
        supplierOverrideId ?? toNum(scanResult.supplier_id);
      const payload = cleanObj({
        supplier_id: resolvedSupplierId,
        supplier_name: scanResult.supplier_name ?? "",
        invoice_number: scanResult.invoice_number ?? "",
        invoice_date: scanResult.invoice_date ?? "",
        total_amount: toNum(scanResult.total_amount) ?? 0,
        allow_auto_create_unmatched: true,
      }) as any;

      payload.items = items.map((i) =>
        cleanObj({
          product_id: i.matched_product_id ?? undefined,
          product_name_raw: i.product_name,
          product_name: i.matched_product_name ?? i.product_name,
          product_code: i.product_code ?? undefined,
          quantity: toNum(i.quantity) ?? 0,
          unit_price: toNum(i.unit_price) ?? 0,
          selling_price: toNum(i.selling_price),
        }),
      );
      return api.post("/incoming", payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["incoming"] });
      qc.invalidateQueries({ queryKey: ["owner-products-catalog"] });
      setStep("done");
      toast.success("Доставката е записана успешно!");
    },
    onError: (err) => {
      toast.error(
        getApiErrorMessage(err, "Грешка при записването на доставката."),
      );
      setStep("review");
    },
  });

  const handleFile = (file: File) => {
    setScannedFile(file);
    setTrainedFor(null);
    setStep("scanning");
    scanMutation.mutate(file);
  };

  const resetAll = () => {
    setStep("idle");
    setScanResult(null);
    setItems([]);
    setScannedFile(null);
    setTrainedFor(null);
  };

  /**
   * "Teach the AI" — send the corrected extraction back as a template for
   * future few-shot learning. Next time this supplier's invoice is scanned,
   * the AI will see this confirmed example and extract more accurately.
   */
  const trainFromScan = async () => {
    if (!scannedFile || !scanResult || items.length === 0) return;
    setIsTraining(true);
    try {
      // Read file as base64
      const base64: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          // Strip "data:...;base64," prefix
          resolve(result.split(",")[1] ?? result);
        };
        reader.onerror = reject;
        reader.readAsDataURL(scannedFile);
      });

      // Build the corrected JSON shape the AI expects
      const corrected = {
        supplier_name: scanResult.supplier_name ?? "",
        supplier_eik: scanResult.supplier_eik ?? null,
        invoice_number: scanResult.invoice_number ?? null,
        invoice_date: scanResult.invoice_date ?? null,
        total_amount: scanResult.total_amount ?? 0,
        line_items: items.map((i) => ({
          product_name_raw: i.product_name,
          product_code_raw: i.product_code || null,
          matched_product_sku: i.matched_product_sku || null,
          quantity: i.quantity,
          unit_price: i.unit_price,
          total_price: i.total_price ?? i.quantity * i.unit_price,
        })),
      };

      // Route through backend proxy → ai-service /ai/confirm-invoice-template
      await api.post("/incoming/train-template", {
        supplier_name: scanResult.supplier_name || "Unknown",
        supplier_eik: scanResult.supplier_eik ?? null,
        image_base64: base64,
        extracted_json: corrected,
      });

      setTrainedFor(scanResult.supplier_name || "Unknown");
      toast.success(
        `AI научи шаблона за ${scanResult.supplier_name}. Следваща фактура ще е по-точна!`,
      );
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Грешка при обучаване на AI."));
    } finally {
      setIsTraining(false);
    }
  };

  const unmatchedCount = items.filter((i) => !i.matched_product_id).length;

  // Derive SKU prefix by LEARNING from matched items in this scan.
  //
  // For each matched row we have both:
  //   - product_code (what the invoice says, e.g. "1002")
  //   - matched_product_sku (what the DB says, e.g. "D1002")
  //
  // If DB SKU ends with the invoice code, the chars before it = prefix.
  // We pick the most common prefix across all pairs. That way:
  //   DAGKOS  → "D"      (SKU D1002 from code 1002)
  //   KOSTAS  → "KOS"    (SKU KOS06032 from code 06032)
  //   MAMOS   → "M"      (SKU M2204394 from code 2204394)
  //
  // Fallback: first letter of supplier name (keeps old behavior for edge cases).
  const supplierSkuPrefix: string | null = (() => {
    const pairs = items.filter(
      (i) =>
        i.product_code &&
        i.matched_product_sku &&
        i.matched_product_sku
          .toUpperCase()
          .endsWith(i.product_code.toUpperCase()),
    );
    if (pairs.length > 0) {
      const counts = new Map<string, number>();
      for (const p of pairs) {
        const sku = p.matched_product_sku!;
        const code = p.product_code!;
        const prefix = sku.slice(0, sku.length - code.length);
        counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top && top[1] >= 1) return top[0];
    }
    // Fallback: first letter of supplier name
    const name = scanResult?.supplier_name?.trim();
    if (!name) return null;
    const first = name.split(/\s+/)[0] ?? "";
    return first ? first.charAt(0).toUpperCase() : null;
  })();

  // ===== IDLE (camera launcher) =====
  if (step === "idle") {
    return (
      <div className="p-4 max-w-xl mx-auto space-y-4 pb-24">
        <h1 className="text-xl font-bold text-[#f3f6ff]">Сканирай фактура</h1>
        <p className="text-sm text-[#9aa8d6]">
          Снимай доставническа фактура. AI ще извади продуктите автоматично.
        </p>

        <div className="grid grid-cols-1 gap-3">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-4 rounded-2xl border border-[#4f7cff] bg-[#4f7cff]/10 hover:bg-[#4f7cff]/20 p-6 text-left transition-colors"
          >
            <div className="h-14 w-14 rounded-xl bg-[#4f7cff] flex items-center justify-center">
              <Camera className="h-7 w-7 text-white" />
            </div>
            <div>
              <p className="font-semibold text-[#f3f6ff]">Снимай с камера</p>
              <p className="text-xs text-[#9aa8d6] mt-0.5">
                Отваря камерата на телефона
              </p>
            </div>
          </button>

          <button
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = "image/*,application/pdf";
              input.onchange = (e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (file) handleFile(file);
              };
              input.click();
            }}
            className="flex items-center gap-4 rounded-2xl border border-[#243055] bg-[#12162a] hover:bg-[#161c34] p-5 text-left transition-colors"
          >
            <div className="h-12 w-12 rounded-xl bg-[#161c34] border border-[#243055] flex items-center justify-center">
              <Upload className="h-6 w-6 text-[#9aa8d6]" />
            </div>
            <div>
              <p className="font-medium text-[#f3f6ff]">Качи от галерия/файл</p>
              <p className="text-xs text-[#9aa8d6] mt-0.5">
                PDF или изображение
              </p>
            </div>
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          // Explicit mimetypes — "image/*" on desktop Chrome sometimes
          // doesn't advertise HEIC in the picker, forcing users to switch
          // to "all files". Listing extensions + .heic/.heif makes Finder
          // surface iPhone photos (and old PDF exports) in the default view.
          accept="image/*,.heic,.heif,application/pdf"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />

        <div className="mt-6 rounded-xl border border-[#243055] bg-[#12162a] p-4 text-xs text-[#9aa8d6] leading-relaxed">
          <p className="font-medium text-[#f3f6ff] mb-1">
            Съвети за бърз match:
          </p>
          <ul className="space-y-1 list-disc list-inside">
            <li>Добро осветление, без блик</li>
            <li>Цялата фактура в кадъра</li>
            <li>Чети SKU-тата — правят match по-точен</li>
          </ul>
        </div>
      </div>
    );
  }

  // ===== SCANNING =====
  if (step === "scanning") {
    return <ScanningScreen />;
  }

  // ===== REVIEW =====
  if (step === "review" && scanResult) {
    return (
      <div className="p-4 max-w-3xl mx-auto space-y-3 pb-40">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-[#f3f6ff]">Провери</h1>
          <button
            onClick={resetAll}
            className="text-xs text-[#9aa8d6] hover:text-[#f3f6ff] inline-flex items-center gap-1"
          >
            <RefreshCw className="h-3 w-3" />
            Преснимай
          </button>
        </div>

        {/* Duplicate warning — blocks save unless user explicitly confirms */}
        {scanResult.duplicate ? (
          <div className="rounded-xl border border-[#ff6b8a] bg-[#ff6b8a]/10 p-3 space-y-2">
            <div className="flex items-start gap-2">
              <div className="h-5 w-5 rounded-full bg-[#ff6b8a] text-white flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">
                !
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-[#ff6b8a] text-sm">
                  Дубликат на фактура
                </p>
                <p className="text-xs text-[#ffb0c0] mt-1">
                  Фактура{" "}
                  <span className="font-mono">{scanResult.invoice_number}</span>{" "}
                  вече е вкарана в системата като доставка #
                  {scanResult.duplicate.existing_id} (
                  {new Date(scanResult.duplicate.created_at).toLocaleDateString(
                    "bg-BG",
                  )}
                  , статус: {scanResult.duplicate.status}).
                </p>
                <p className="text-xs text-[#ffb0c0] mt-1">
                  Ако натиснеш "Запази", ще получиш грешка. Препоръчително —
                  натисни "Отказ".
                </p>
              </div>
            </div>
          </div>
        ) : null}

        {/* Header info */}
        <div className="rounded-xl border border-[#243055] bg-[#12162a] p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <FileText className="h-4 w-4 text-[#4f7cff] shrink-0" />
            <span className="font-medium text-[#f3f6ff] truncate">
              {scanResult.supplier_name || "Неизвестен доставчик"}
            </span>
          </div>

          {/* Supplier confirmation — shown whenever backend did NOT return
              a supplier_id (no confident auto-match). User picks from
              Combobox; the pick is sent as supplier_id on save and the
              backend upserts a user_confirmed alias so future scans of
              the same raw name link instantly. */}
          {!(supplierOverrideId ?? scanResult.supplier_id) ? (
            <div className="rounded-lg bg-[#f7c12a]/10 border border-[#f7c12a]/30 p-2 space-y-1.5">
              <p className="text-[11px] text-[#f7c12a] font-medium">
                Доставчикът не е разпознат автоматично. Избери от списъка, за да
                го запомня за следващия път.
              </p>
              <Combobox
                variant="dark"
                items={suppliersCatalog.map((s) => ({
                  value: String(s.id),
                  label: s.name,
                  hint: s.eik ? `ЕИК: ${s.eik}` : undefined,
                }))}
                value={supplierOverrideId ? String(supplierOverrideId) : ""}
                onChange={(val) => setSupplierOverrideId(parseInt(val, 10))}
                onClear={() => setSupplierOverrideId(null)}
                placeholder="Избери доставчик..."
              />
            </div>
          ) : supplierOverrideId ? (
            // User explicitly picked — show a small confirmation chip with
            // the ability to change or clear.
            <div className="flex items-center gap-2 text-xs">
              <Check className="h-3.5 w-3.5 text-[#25c38b] shrink-0" />
              <span className="text-[#25c38b] font-medium">
                Свързан с:{" "}
                {
                  suppliersCatalog.find((s) => s.id === supplierOverrideId)
                    ?.name
                }
              </span>
              <button
                type="button"
                onClick={() => setSupplierOverrideId(null)}
                className="ml-auto text-[#9aa8d6] hover:text-[#f3f6ff] text-[11px] underline"
              >
                промени
              </button>
            </div>
          ) : null}

          {scanResult.invoice_number ? (
            <p className="text-xs text-[#9aa8d6] font-mono">
              № {scanResult.invoice_number}
              {scanResult.invoice_date ? ` · ${scanResult.invoice_date}` : ""}
            </p>
          ) : null}
          {scanResult.total_amount ? (
            <p className="text-sm font-semibold text-[#f3f6ff]">
              Общо: {formatCurrency(scanResult.total_amount)}
            </p>
          ) : null}
        </div>

        {/* Match summary */}
        <div className="grid grid-cols-2 gap-2 text-center">
          <div className="rounded-lg bg-[#25c38b]/15 border border-[#25c38b]/30 py-2">
            <p className="text-lg font-bold text-[#25c38b]">
              {items.length - unmatchedCount}
            </p>
            <p className="text-[10px] text-[#9aa8d6] uppercase">Match</p>
          </div>
          <div className="rounded-lg bg-[#ff6b8a]/15 border border-[#ff6b8a]/30 py-2">
            <p className="text-lg font-bold text-[#ff6b8a]">{unmatchedCount}</p>
            <p className="text-[10px] text-[#9aa8d6] uppercase">Без match</p>
          </div>
        </div>

        {/* Items list */}
        <div className="space-y-2">
          {items.map((item, idx) => (
            <ItemRow
              key={idx}
              item={item}
              products={products}
              supplierSkuPrefix={supplierSkuPrefix}
              onChange={(patch) =>
                setItems((prev) =>
                  prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
                )
              }
              onRemove={() =>
                setItems((prev) => prev.filter((_, i) => i !== idx))
              }
            />
          ))}
        </div>

        {/* Train AI — only visible when all items matched */}
        {unmatchedCount === 0 && items.length > 0 && scannedFile ? (
          <button
            type="button"
            onClick={trainFromScan}
            disabled={isTraining || trainedFor === scanResult.supplier_name}
            className="w-full rounded-xl border border-[#25c38b]/50 bg-[#25c38b]/10 hover:bg-[#25c38b]/20 p-3 text-sm text-[#25c38b] flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
          >
            {isTraining ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Обучавам AI...
              </>
            ) : trainedFor === scanResult.supplier_name ? (
              <>
                <Check className="h-4 w-4" />
                AI научен за {scanResult.supplier_name}
              </>
            ) : (
              <>Обучи AI от тази фактура ({scanResult.supplier_name})</>
            )}
          </button>
        ) : null}

        {/* Save button fixed bottom */}
        <div className="fixed bottom-16 left-0 right-0 z-20 border-t border-[#243055] bg-[#090c18]/95 backdrop-blur p-3">
          <div className="max-w-3xl mx-auto flex gap-2">
            <button
              onClick={resetAll}
              className="px-4 py-3 rounded-xl border border-[#243055] text-sm text-[#9aa8d6] hover:bg-[#12162a]"
            >
              Отказ
            </button>
            <button
              onClick={() => {
                setStep("saving");
                saveMutation.mutate();
              }}
              disabled={
                items.length === 0 ||
                saveMutation.isPending ||
                Boolean(scanResult.duplicate)
              }
              className={cn(
                "flex-1 px-4 py-3 rounded-xl disabled:opacity-50 text-sm font-semibold text-white flex items-center justify-center gap-2",
                scanResult.duplicate
                  ? "bg-[#ff6b8a] hover:bg-[#ff4060] cursor-not-allowed"
                  : "bg-[#4f7cff] hover:bg-[#3d6ae8]",
              )}
              title={
                scanResult.duplicate
                  ? "Тази фактура вече е вкарана — не може да се запази отново"
                  : ""
              }
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              {scanResult.duplicate
                ? "Дубликат — не може да се запише"
                : `Запази доставката (${items.length})`}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ===== DONE =====
  if (step === "done") {
    return (
      <div className="p-4 max-w-xl mx-auto pb-24">
        <div className="rounded-2xl border border-[#25c38b]/40 bg-[#25c38b]/10 p-10 flex flex-col items-center gap-4">
          <div className="h-16 w-16 rounded-full bg-[#25c38b] flex items-center justify-center">
            <Check className="h-8 w-8 text-white" />
          </div>
          <div className="text-center">
            <p className="font-semibold text-[#f3f6ff] text-lg">Готово!</p>
            <p className="text-sm text-[#9aa8d6] mt-1">
              Доставката е добавена към inventory-то.
            </p>
          </div>
          <div className="flex gap-2 w-full">
            <button
              onClick={resetAll}
              className="flex-1 px-4 py-3 rounded-xl bg-[#4f7cff] hover:bg-[#3d6ae8] text-sm font-semibold text-white"
            >
              Ново сканиране
            </button>
            <button
              onClick={() => navigate("/owner/dashboard")}
              className="flex-1 px-4 py-3 rounded-xl border border-[#243055] text-sm text-[#9aa8d6] hover:bg-[#12162a]"
            >
              Към Анализи
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

// ===== Scanning spinner with elapsed-time + dynamic message =====

function ScanningScreen() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  const message =
    elapsed < 8
      ? "Claude чете фактурата..."
      : elapsed < 20
        ? "Извличам продуктите и кодовете..."
        : elapsed < 40
          ? "Match-вам с базата данни..."
          : elapsed < 80
            ? "Проверявам последните неразпознати редове..."
            : "Почти готово — не затваряй страницата...";

  return (
    <div className="p-4 max-w-xl mx-auto pb-24">
      <div className="rounded-2xl border border-[#243055] bg-[#12162a] p-10 flex flex-col items-center gap-4">
        <Loader2 className="h-12 w-12 text-[#4f7cff] animate-spin" />
        <div className="text-center">
          <p className="font-semibold text-[#f3f6ff]">{message}</p>
          <p className="text-sm text-[#9aa8d6] mt-1 font-mono">
            {elapsed}с изминали
          </p>
          <p className="text-xs text-[#6b7692] mt-3 max-w-xs">
            Не затваряй страницата — резултатът ще се появи автоматично.
          </p>
        </div>
      </div>
    </div>
  );
}

// ===== Item row with match status + manual override =====

function ItemRow({
  item,
  products,
  supplierSkuPrefix,
  onChange,
  onRemove,
}: {
  item: ScannedItem;
  products: Product[];
  supplierSkuPrefix: string | null;
  onChange: (patch: Partial<ScannedItem>) => void;
  onRemove: () => void;
}) {
  // Auto-expand rows that need attention: no match or low-confidence match.
  const needsAttention =
    !item.matched_product_id || (item.match_confidence ?? 0) < 0.85;
  const [expanded, setExpanded] = useState(needsAttention);

  const matchStatus = !item.matched_product_id
    ? "none"
    : (item.match_confidence ?? 0) >= 0.85
      ? "good"
      : "fuzzy";
  const statusStyle = {
    good: "bg-[#25c38b]/15 border-[#25c38b]/40 text-[#25c38b]",
    fuzzy: "bg-[#ffb454]/15 border-[#ffb454]/40 text-[#ffb454]",
    none: "bg-[#ff6b8a]/15 border-[#ff6b8a]/40 text-[#ff6b8a]",
  }[matchStatus];
  const statusLabel = {
    good: "Match",
    fuzzy: "Провери",
    none: "Без match",
  }[matchStatus];

  const priceChanged =
    item.selling_price != null &&
    item.selling_price_db != null &&
    Math.abs(item.selling_price - item.selling_price_db) > 0.001;

  return (
    <div className="rounded-xl border border-[#243055] bg-[#12162a] overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full p-3 flex items-start gap-3 text-left"
      >
        <Package className="h-4 w-4 text-[#9aa8d6] shrink-0 mt-1" />
        <div className="min-w-0 flex-1">
          {/* Top line: AI-extracted name from the invoice + its code chip */}
          <div className="flex items-start gap-2">
            <p className="text-sm font-medium text-[#f3f6ff] truncate flex-1">
              {item.product_name}
            </p>
            {item.product_code ? (
              <span
                className="font-mono text-[10px] text-[#ffb454] bg-[#ffb454]/10 border border-[#ffb454]/30 rounded px-1.5 py-0.5 shrink-0"
                title="Код на реда от фактурата"
              >
                {item.product_code}
              </span>
            ) : null}
          </div>
          {/* Second line: what it was matched to, with DB SKU chip */}
          {item.matched_product_name ? (
            <p className="text-xs text-[#4f7cff] mt-0.5 truncate">
              → {item.matched_product_name}
              {item.matched_product_sku ? (
                <span className="ml-1.5 font-mono text-[10px] text-[#25c38b]">
                  [{item.matched_product_sku}]
                </span>
              ) : null}
            </p>
          ) : null}
          {/* Third line: quantity, prices */}
          <p className="text-xs text-[#9aa8d6] mt-0.5 truncate">
            {item.quantity} × {formatCurrency(item.unit_price)}
            {item.selling_price != null && item.selling_price > 0
              ? ` → ${formatCurrency(item.selling_price)}${priceChanged ? " *" : ""}`
              : ""}
          </p>
        </div>
        <span
          className={cn(
            "text-[10px] font-medium px-2 py-0.5 rounded-full border shrink-0",
            statusStyle,
          )}
        >
          {statusLabel}
        </span>
      </button>

      {expanded ? (
        <div className="border-t border-[#243055] p-3 space-y-3 bg-[#0d1020]">
          {/* Manual product selector */}
          <div>
            <label className="text-xs text-[#9aa8d6] mb-1 block">
              Продукт от базата
            </label>
            <Combobox
              variant="dark"
              items={products.map((p) => ({
                value: String(p.id),
                label: p.name_bg,
                hint:
                  `SKU: ${p.sku}` +
                  (p.selling_price
                    ? ` · ${formatCurrency(Number(p.selling_price))}`
                    : ""),
              }))}
              value={
                item.matched_product_id ? String(item.matched_product_id) : ""
              }
              onChange={(val, optItem) => {
                const prodId = parseInt(val);
                const prod = products.find((p) => p.id === prodId);
                const dbSelling =
                  prod?.selling_price != null
                    ? Number(prod.selling_price)
                    : null;
                onChange({
                  matched_product_id: prodId,
                  matched_product_name: prod?.name_bg ?? optItem.label,
                  matched_product_sku: prod?.sku ?? "",
                  match_source: "ai",
                  match_confidence: 1.0,
                  selling_price: dbSelling,
                  selling_price_db: dbSelling,
                });
              }}
              onClear={() =>
                onChange({
                  matched_product_id: null,
                  matched_product_name: null,
                  matched_product_sku: null,
                  selling_price: null,
                  selling_price_db: null,
                })
              }
              placeholder={
                item.matched_product_name
                  ? "Кликни за смяна..."
                  : "Търси продукт по име или SKU..."
              }
            />
          </div>

          {/* Create new product inline — only when no match */}
          {!item.matched_product_id ? (
            <CreateProductInline
              defaultName={item.product_name}
              defaultSku={
                supplierSkuPrefix && item.product_code
                  ? `${supplierSkuPrefix}${item.product_code}`
                  : ""
              }
              defaultPurchasePrice={item.unit_price}
              onCreated={(created) => {
                onChange({
                  matched_product_id: created.id,
                  matched_product_name: created.name_bg,
                  matched_product_sku: created.sku,
                  match_source: "ai",
                  match_confidence: 1.0,
                  selling_price: created.selling_price ?? null,
                  selling_price_db: created.selling_price ?? null,
                });
              }}
            />
          ) : null}

          {/* Price row: доставна + продажна */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-[#9aa8d6] mb-1 block">
                Доставна цена
              </label>
              <input
                type="number"
                step="0.0001"
                value={item.unit_price}
                onChange={(e) =>
                  onChange({ unit_price: parseFloat(e.target.value) || 0 })
                }
                className="w-full px-3 py-2 rounded-lg bg-[#12162a] border border-[#243055] text-sm text-[#f3f6ff] focus:border-[#4f7cff] outline-none"
              />
            </div>
            <div>
              <label className="text-xs text-[#9aa8d6] mb-1 block flex items-center gap-1">
                Продажна цена
                {priceChanged ? (
                  <span className="text-[10px] text-[#ffb454]">
                    (ще се обнови)
                  </span>
                ) : null}
              </label>
              <input
                type="number"
                step="0.01"
                value={item.selling_price ?? ""}
                onChange={(e) => {
                  const val = e.target.value;
                  onChange({
                    selling_price: val === "" ? null : parseFloat(val),
                  });
                }}
                placeholder={
                  item.matched_product_id
                    ? "Въведи цена..."
                    : "Първо избери продукт"
                }
                disabled={!item.matched_product_id}
                className={cn(
                  "w-full px-3 py-2 rounded-lg bg-[#12162a] border text-sm text-[#f3f6ff] focus:border-[#4f7cff] outline-none disabled:opacity-50",
                  priceChanged ? "border-[#ffb454]" : "border-[#243055]",
                )}
              />
              {item.matched_product_id &&
              (item.selling_price == null || item.selling_price === 0) ? (
                <p className="text-[10px] text-[#ff6b8a] mt-1">
                  Няма продажна цена в базата
                </p>
              ) : null}
            </div>
          </div>

          {/* Quantity */}
          <div>
            <label className="text-xs text-[#9aa8d6] mb-1 block">
              Количество
            </label>
            <input
              type="number"
              step="0.01"
              value={item.quantity}
              onChange={(e) =>
                onChange({ quantity: parseFloat(e.target.value) || 0 })
              }
              className="w-full px-3 py-2 rounded-lg bg-[#12162a] border border-[#243055] text-sm text-[#f3f6ff] focus:border-[#4f7cff] outline-none"
            />
          </div>

          {/* Fuzzy suggestions for unmatched items */}
          {(item.suggestions?.length ?? 0) > 0 && !item.matched_product_id ? (
            <div>
              <p className="text-xs text-[#9aa8d6] mb-1">Предложения:</p>
              <div className="space-y-1">
                {item.suggestions!.slice(0, 3).map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      const prod = products.find((p) => p.id === s.id);
                      const dbSelling =
                        prod?.selling_price != null
                          ? Number(prod.selling_price)
                          : null;
                      onChange({
                        matched_product_id: s.id,
                        matched_product_name: s.name_bg,
                        matched_product_sku: s.sku,
                        match_confidence: s.confidence,
                        match_source: "fuzzy",
                        selling_price: dbSelling,
                        selling_price_db: dbSelling,
                      });
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg bg-[#12162a] border border-[#243055] hover:border-[#4f7cff] text-xs text-[#f3f6ff] flex items-center justify-between"
                  >
                    <span className="truncate">{s.name_bg}</span>
                    <span className="text-[#9aa8d6] ml-2 shrink-0">
                      {Math.round(s.confidence * 100)}%
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <button
            onClick={onRemove}
            className="w-full text-xs text-[#ff6b8a] hover:text-[#ff4060] inline-flex items-center justify-center gap-1 py-1"
          >
            <X className="h-3 w-3" />
            Премахни този ред
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ===== Inline form to create a new product when none exists in DB =====

function CreateProductInline({
  defaultName,
  defaultSku,
  defaultPurchasePrice,
  onCreated,
}: {
  defaultName: string;
  defaultSku: string;
  defaultPurchasePrice: number;
  onCreated: (p: {
    id: number;
    name_bg: string;
    sku: string;
    selling_price: number | null;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [sku, setSku] = useState(defaultSku);
  const [sellingPrice, setSellingPrice] = useState<string>("");
  const qc = useQueryClient();

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Името е задължително");
      if (!sku.trim()) throw new Error("SKU-то е задължително");
      const res = await api.post("/products", {
        name_bg: name.trim(),
        name_en: name.trim(),
        sku: sku.trim(),
        unit: "бр.",
        purchase_price: defaultPurchasePrice || 0,
        selling_price: sellingPrice ? parseFloat(sellingPrice) : null,
      });
      return res.data;
    },
    onSuccess: (created) => {
      toast.success(`Създаден: ${created.name_bg} (${created.sku})`);
      qc.invalidateQueries({ queryKey: ["owner-products-catalog"] });
      onCreated({
        id: created.id,
        name_bg: created.name_bg,
        sku: created.sku,
        selling_price: created.selling_price ?? null,
      });
      setOpen(false);
    },
    onError: (err) => {
      toast.error(getApiErrorMessage(err, "Грешка при създаване на продукта."));
    },
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-dashed border-[#25c38b]/50 bg-[#25c38b]/5 hover:bg-[#25c38b]/10 text-[#25c38b] text-xs font-medium py-2.5 inline-flex items-center justify-center gap-1.5 transition-colors"
      >
        <Plus className="h-3.5 w-3.5" />
        Създай нов продукт (ако го няма в базата)
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-[#25c38b]/40 bg-[#25c38b]/5 p-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-[#25c38b] uppercase tracking-wide font-medium">
          Нов продукт
        </p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[#9aa8d6] hover:text-[#f3f6ff]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div>
        <label className="text-xs text-[#9aa8d6] mb-1 block">
          Наименование *
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Название на продукта"
          className="w-full px-3 py-2 rounded-lg bg-[#12162a] border border-[#243055] text-sm text-[#f3f6ff] focus:border-[#25c38b] outline-none"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-[#9aa8d6] mb-1 block">SKU *</label>
          <input
            type="text"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="напр. D1610"
            className="w-full px-3 py-2 rounded-lg bg-[#12162a] border border-[#243055] text-sm text-[#f3f6ff] font-mono focus:border-[#25c38b] outline-none"
          />
        </div>
        <div>
          <label className="text-xs text-[#9aa8d6] mb-1 block">
            Продажна цена
          </label>
          <input
            type="number"
            step="0.01"
            value={sellingPrice}
            onChange={(e) => setSellingPrice(e.target.value)}
            placeholder="по избор"
            className="w-full px-3 py-2 rounded-lg bg-[#12162a] border border-[#243055] text-sm text-[#f3f6ff] focus:border-[#25c38b] outline-none"
          />
        </div>
      </div>

      <p className="text-[10px] text-[#6b7692]">
        Доставна цена {formatCurrency(defaultPurchasePrice)} ще се вземе от
        фактурата. SKU може да остане или да се коригира.
      </p>

      <button
        type="button"
        onClick={() => createMutation.mutate()}
        disabled={createMutation.isPending || !name.trim() || !sku.trim()}
        className="w-full px-4 py-2 rounded-lg bg-[#25c38b] hover:bg-[#1ea876] disabled:opacity-50 text-sm font-semibold text-white inline-flex items-center justify-center gap-2"
      >
        {createMutation.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Plus className="h-3.5 w-3.5" />
        )}
        Създай и свържи
      </button>
    </div>
  );
}
