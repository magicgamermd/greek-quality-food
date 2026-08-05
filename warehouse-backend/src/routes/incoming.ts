import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "../lib/pagination.js";
import type { QueryResultRow } from "pg";
import { z } from "zod";
import { query, transaction } from "../db.js";
import {
  requirePermission,
  hasPermission,
  stripFieldsForUser,
  PERMISSIONS,
} from "../lib/permissions.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { escapeLike, normalizeAliasName } from "../utils/product-matching.js";
import {
  invoiceDigitsOnly,
  invoiceOcrKey,
  normalizeInvoiceNumber,
  SQL_OCR_COLLAPSE_EXPR,
} from "../utils/invoice-normalization.js";
import { generateIncomingStockReceiptPdf } from "../services/document-pdf.js";
import { normalizeExpiryInput } from "../utils/expiry-input.js";

// Length caps on free-form strings prevent both accidental DB bloat and
// malicious payloads — e.g. a 100KB supplier_name ending up as an alias
// row keyed by normalize_search() would inflate the index and slow every
// trigram lookup. Values are generous against real invoice data but firm.
const createIncomingSchema = z.object({
  supplier_id: z.number().int().nullish(),
  supplier_name: z.string().max(255).nullish(),
  supplier_eik: z.string().max(32).nullish(),
  supplier_vat: z.string().max(32).nullish(),
  supplier_address: z.string().max(500).nullish(),
  supplier_phone: z.string().max(64).nullish(),
  supplier_email: z.string().max(255).nullish(),
  supplier_contact: z.string().max(255).nullish(),
  invoice_number: z.string().max(64).nullish(),
  invoice_date: z.string().max(32).nullish(),
  document_type: z.string().default("invoice"),
  scanned_file_path: z.string().nullish(),
  visible_row_count: z.number().int().positive().optional(),
  extracted_row_count: z.number().int().nonnegative().optional(),
  completeness_status: z
    .enum(["complete", "suspicious", "incomplete"])
    .optional(),
  warnings: z.array(z.string()).optional(),
  strict_review_mode: z.boolean().optional(),
  review_accepted_for_completeness: z.boolean().optional(),
  allow_auto_create_unmatched: z.boolean().optional(),
  items: z.array(
    z.object({
      row_number: z.number().int().positive().optional(),
      page_number: z.number().int().positive().optional(),
      product_name_raw: z.string().nullish(),
      product_code_raw: z.string().nullish(),
      product_id: z.number().int().optional(),
      product_name: z.string().nullish(), // can be null when product_id is provided
      name_bg: z.string().nullish(), // Bulgarian translation of product_name
      product_code: z.string().nullish(), // invoice line code (e.g. "1002")
      match_confidence: z.number().nullish(),
      match_source: z.string().nullish(),
      brand: z.string().nullish(), // null when brand not on invoice
      category_hint: z.string().nullish(), // beverages|pasta|olive_oil|sweets|meat|spices|legumes|coffee|wine|cheese|dairy
      unit: z.string().nullish(),
      // Greek Quality Food продава хранителни стоки — партида + срок на
      // годност се проследяват. Заснемаме ги на входящия ред; confirm
      // стъпката създава реалната наличност по партида.
      batch_number: z.string().trim().max(100).optional().nullable(),
      expiry_date: z.string().trim().optional().nullable(), // ISO YYYY-MM-DD
      production_date: z.string().trim().optional().nullable(),
      notes_raw: z.string().nullish(),
      quantity: z.number().positive(),
      unit_price: z.number().min(0).default(0),
      selling_price: z.number().min(0).nullish(),
    }),
  ),
});

const cancelIncomingSchema = z.object({
  reason: z.string().trim().min(2).max(500).optional(),
});

type CompletenessStatus = "complete" | "suspicious" | "incomplete";

// Shorten brand: "IOANNOU CONFECTIONERY S.M.P.C." → "IOANNOU"
// TODO: revisit brand logic after supplier meeting — may need per-product override
function shortenBrand(brand: string | null | undefined): string | null {
  if (!brand) return null;
  return brand.trim().split(/[\s,./]+/)[0] || null;
}

function uniqueProductTerms(
  values: Array<string | null | undefined>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const term = raw?.trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

// ai-service requires Bearer auth on /ai/* routes (see ai-service
// migration to scoped INTERNAL_API_KEY). All four fetch() callers below
// must include this header — otherwise ai-service returns 401.
function aiAuthHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  const key = process.env.INTERNAL_API_KEY;
  if (!key) {
    // We deliberately do NOT throw here — let the request proceed and
    // surface a 401 from ai-service rather than failing silently. The
    // env-var existence is also enforced by ai-service's startup check.
    return extra;
  }
  return { ...extra, Authorization: `Bearer ${key}` };
}

const SQL_NORMALIZE_INVOICE_NUMBER_EXPR = `
  UPPER(
    REGEXP_REPLACE(
      TRANSLATE(
        REPLACE(
          REPLACE(
            REPLACE(
              REPLACE(COALESCE(invoice_number, ''), 'Θ', 'TH'),
            'Ψ', 'PS'),
          'θ', 'th'),
        'ψ', 'ps'),
        'ΑΒΓΔΕΖΗΙΚΛΜΝΞΟΠΡΣΤΥΦΧΩαβγδεζηικλμνξοπρστυφχω',
        'ABGDEZHIKLMNXOPRSTYFXOabgdezhiklmnxoprstufxo'
      ),
      '[^A-Z0-9\\-]',
      '',
      'g'
    )
  )
`;

const INCOMING_BY_IDEMPOTENCY_KEY_SQL = `
  SELECT
    ig.*,
    COALESCE(
      JSON_AGG(ii.* ORDER BY ii.id) FILTER (WHERE ii.id IS NOT NULL),
      '[]'::json
    ) AS items
  FROM incoming_goods ig
  LEFT JOIN incoming_items ii ON ii.incoming_goods_id = ig.id
  WHERE ig.idempotency_key = $1
  GROUP BY ig.id
  LIMIT 1
`;

type IncomingReplayRow = {
  id: number;
  idempotency_request_hash: string | null;
  items: unknown[];
  [key: string]: unknown;
};

type SqlExecutor = {
  query: <T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: any[],
  ) => Promise<{ rows: T[] }>;
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableStringify(entryValue)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hashIncomingRequest(body: z.infer<typeof createIncomingSchema>) {
  return crypto
    .createHash("sha256")
    .update(stableStringify(body))
    .digest("hex");
}

function getIdempotencyKey(request: FastifyRequest): string | null {
  const headerValue = request.headers["idempotency-key"];
  if (Array.isArray(headerValue)) {
    const firstValue = headerValue.find((value) => value.trim().length > 0);
    return firstValue?.trim() ?? null;
  }
  if (typeof headerValue !== "string") return null;
  const normalized = headerValue.trim();
  return normalized.length > 0 ? normalized : null;
}

const SCAN_TRACE_HEADER = "x-scan-trace-id";

function generateScanTraceId(): string {
  return `scan-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
}

function getScanTraceId(request: FastifyRequest): string {
  const rawHeader = request.headers[SCAN_TRACE_HEADER];
  if (Array.isArray(rawHeader)) {
    const first = rawHeader.find((value) => value.trim().length > 0)?.trim();
    if (first) return first;
  }
  if (typeof rawHeader === "string" && rawHeader.trim().length > 0) {
    return rawHeader.trim();
  }
  return generateScanTraceId();
}

function logScanEvent(
  logger: FastifyRequest["log"],
  event: string,
  traceId: string,
  details: Record<string, unknown> = {},
) {
  logger.info(
    {
      event,
      trace_id: traceId,
      ...details,
    },
    `[incoming.scan] ${event}`,
  );
}

async function findIncomingByIdempotencyKey(
  executor: SqlExecutor,
  idempotencyKey: string,
) {
  const { rows } = (await executor.query(INCOMING_BY_IDEMPOTENCY_KEY_SQL, [
    idempotencyKey,
  ])) as { rows: IncomingReplayRow[] };
  return rows[0] ?? null;
}

async function findDuplicateInvoice(
  invoiceNumber: string,
  supplierId?: number | null,
) {
  const normalized = normalizeInvoiceNumber(invoiceNumber);
  const digitsOnly = invoiceDigitsOnly(invoiceNumber);
  const ocrKey = invoiceOcrKey(invoiceNumber);

  // ── Tier 1: exact normalized match (Greek↔Latin fold + punctuation) ──
  //    Also allow pure-digit match when ≥6 digits (invoice "14" is too
  //    short to dedupe on across suppliers).
  const exact = await query(
    `SELECT id, supplier_id, invoice_number, status, created_at
     FROM incoming_goods
     WHERE (${SQL_NORMALIZE_INVOICE_NUMBER_EXPR}) = $1
        OR ($2 != '' AND LENGTH($2) >= 6 AND REGEXP_REPLACE(COALESCE(invoice_number, ''), '[^0-9]', '', 'g') = $2)
     ORDER BY created_at DESC
     LIMIT 1`,
    [normalized, digitsOnly],
  );
  if (exact.rows[0]) return exact.rows[0];

  // ── Tier 2: OCR-collapsed match scoped to supplier ────────────────────
  //    Applies the digit↔letter lookalike collapse (0↔O, 1↔I, J↔I, …) and
  //    then requires the collapsed keys to be IDENTICAL, against invoices
  //    from the same supplier within the last 180 days.
  //
  //    Толерансът важи САМО при различна дължина на ключовете.
  //    Разсъждението: collapse-ът вече изравнява lookalike грешките
  //    (буква O ↔ нула, I ↔ 1, …), затова при ЕДНАКВА дължина всяка
  //    останала разлика е замяна на цифра с друга цифра = РАЗЛИЧНА
  //    фактура. Различната дължина обаче значи изпуснат/добавен символ —
  //    типичен OCR шум от снимка с телефон — там Levenshtein ≤ 2 пази.
  //
  //    Старият безусловен Levenshtein ≤ 2 сливаше ПОСЛЕДОВАТЕЛНИ номера
  //    (прод: I20869 ↔ I20870 = разлика 2) и блокираше всяка следваща
  //    фактура от доставчик, който номерира последователно.
  if (!supplierId || !ocrKey || ocrKey.length < 4) return null;

  const fuzzyInner = SQL_OCR_COLLAPSE_EXPR(SQL_NORMALIZE_INVOICE_NUMBER_EXPR);
  const fuzzy = await query(
    `SELECT id, supplier_id, invoice_number, status, created_at,
            levenshtein(${fuzzyInner}, $1) AS edit_distance
     FROM incoming_goods
     WHERE supplier_id = $2
       AND created_at >= NOW() - INTERVAL '180 days'
       AND ${fuzzyInner} <> ''
       AND (
         ${fuzzyInner} = $1
         OR (
           LENGTH(${fuzzyInner}) <> LENGTH($1)
           AND levenshtein(${fuzzyInner}, $1) <= 2
         )
       )
     ORDER BY edit_distance ASC, created_at DESC
     LIMIT 1`,
    [ocrKey, supplierId],
  );

  return fuzzy.rows[0] ?? null;
}

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

const jwtVerify = async (request: FastifyRequest) => {
  await request.jwtVerify();
};

const incomingManagePreHandler = [
  jwtVerify,
  requirePermission(PERMISSIONS.INCOMING_MANAGE),
];

const TOTAL_ROW_RE =
  /(total|subtotal|vat|fpa|φπα|συνολο|σύνολο|grand total|net|gross)/i;

function asFiniteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asPositiveInteger(value: unknown): number | null {
  const n = asFiniteNumber(value);
  if (n == null) return null;
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function asNullableString(value: unknown): string | null {
  if (value == null) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

// Нормализира срок на годност до 'YYYY-MM-DD' или null.
// PostgreSQL DATE колона се чете от node-postgres като JS Date (на локална
// полунощ), а от заявка идва като string. Форматираме Date по ЛОКАЛНИ
// компоненти (същия часови пояс, в който драйверът я е разпарсил), за да
// няма отместване на деня при повторно записване в DATE колона.
// OCR понякога вади 2-цифрена година („27-03-31") → записва се като
// година 0027, а при повторно подаване Postgres я отказва („date/time
// field value out of range"). Коригираме века: година < 100 → +2000.
function asNullableDateString(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    let year = value.getFullYear();
    if (year >= 0 && year < 100) year += 2000;
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${String(year).padStart(4, "0")}-${month}-${day}`;
  }
  const str = String(value).trim();
  if (!str) return null;
  // Низ с 2-цифрена водеща година (YY-MM-DD от OCR) → 20YY-MM-DD.
  const shortYear = str.match(/^(\d{1,2})-(\d{2})-(\d{2})$/);
  if (shortYear) {
    return `20${shortYear[1].padStart(2, "0")}-${shortYear[2]}-${shortYear[3]}`;
  }
  return str;
}

// Минимален клиентски интерфейс (pg PoolClient в транзакция).
type StockClient = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: any[]; rowCount: number | null }>;
};

// Прилага един входящ ред към склада: резолюция/създаване на партида,
// наличност по партида и връзка на реда към партидата. Ползва се от
// confirm И от добавяне на ред към вече потвърдена доставка.
// Редове без подаден номер получават авто-номер ПО РЕД
// (АВТО-{доставка}-{ред}), не по продукт: два реда с един и същ продукт
// (различни лотове/срокове) иначе се блъскат в ux_batches_product_number
// и целият confirm гърми с 500. Lookup-ът върви винаги по effective
// номера, така че повторен опит/остатъчна партида се слива вместо да
// дублира. Връща id-то на партидата.
async function applyIncomingLineToStock(
  client: StockClient,
  deliveryId: string,
  line: {
    id: number;
    product_id: number;
    quantity: number;
    unit_price?: number | null;
    batch_number?: string | null;
    expiry_date?: unknown;
  },
  warehouseId = 1,
): Promise<number> {
  const qty = line.quantity;
  const unitPrice = line.unit_price ?? 0;
  const bNum = (line.batch_number ?? "").trim() || null;
  const exp = asNullableDateString(line.expiry_date);
  const effectiveBatchNumber = bNum ?? `АВТО-${deliveryId}-${line.id}`;

  let batchId: number;
  const foundBatch = await client.query(
    `SELECT id FROM batches WHERE product_id = $1 AND batch_number = $2 LIMIT 1`,
    [line.product_id, effectiveBatchNumber],
  );
  if (foundBatch.rows.length) {
    batchId = foundBatch.rows[0].id;
    await client.query(
      `UPDATE batches
          SET expiry_date = COALESCE($2, expiry_date),
              purchase_price = $3,
              delivery_id = $4,
              quantity = quantity + $5,
              updated_at = NOW()
        WHERE id = $1`,
      [batchId, exp, unitPrice, deliveryId, qty],
    );
  } else {
    const insBatch = await client.query(
      `INSERT INTO batches
         (product_id, batch_number, expiry_date, quantity, purchase_price, delivery_id, received_date)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE)
       RETURNING id`,
      [line.product_id, effectiveBatchNumber, exp, qty, unitPrice, deliveryId],
    );
    batchId = insBatch.rows[0].id;
  }

  // Наличност по партида (заменя счупения NULL-batch ON CONFLICT;
  // старият partial index беше премахнат в миграция 080).
  await client.query(
    `INSERT INTO inventory (product_id, warehouse_id, batch_id, quantity, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (product_id, batch_id, warehouse_id)
     DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity, updated_at = NOW()`,
    [line.product_id, warehouseId, batchId, qty],
  );

  // Връзваме входящия ред към създадената/намерена партида.
  await client.query(`UPDATE incoming_items SET batch_id = $1 WHERE id = $2`, [
    batchId,
    line.id,
  ]);

  return batchId;
}

// Коригира наличността по партидата на входящ ред с delta (положителна
// или отрицателна) — при редакция/триене на ред от ПОТВЪРДЕНА доставка.
async function adjustBatchStock(
  client: StockClient,
  productId: number,
  batchId: number,
  delta: number,
  warehouseId = 1,
): Promise<void> {
  if (delta === 0) return;
  await client.query(
    `UPDATE batches SET quantity = quantity + $1, updated_at = NOW() WHERE id = $2`,
    [delta, batchId],
  );
  const updated = await client.query(
    `UPDATE inventory SET quantity = quantity + $1, updated_at = NOW()
      WHERE product_id = $2 AND warehouse_id = $3 AND batch_id = $4`,
    [delta, productId, warehouseId, batchId],
  );
  if (!updated.rowCount) {
    await client.query(
      `INSERT INTO inventory (product_id, batch_id, warehouse_id, quantity, updated_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [productId, batchId, warehouseId, delta],
    );
  }
}

// Преизчислява header сумата на доставката от редовете ѝ — вика се след
// всяка промяна на редове (редакция/добавяне/триене), иначе
// incoming_goods.total_amount остава старият сбор от създаването.
// Правилото за ред е огледало на стоковата разписка
// (computeIncomingReceiptTotals): запазен total_price важи само когато е
// ≤ кол×цена (реална отстъпка от доставчика); иначе кол×цена.
async function refreshIncomingTotalAmount(
  client: StockClient,
  deliveryId: string,
): Promise<void> {
  await client.query(
    `UPDATE incoming_goods
        SET total_amount = COALESCE((
              SELECT SUM(
                       CASE WHEN COALESCE(ii.total_price, 0) > 0
                            THEN LEAST(
                              ii.total_price,
                              ROUND((ii.quantity * ii.unit_price)::numeric, 2)
                            )
                            ELSE ROUND((ii.quantity * ii.unit_price)::numeric, 2)
                       END
                     )
                FROM incoming_items ii
               WHERE ii.incoming_goods_id = $1
            ), 0),
            updated_at = NOW()
      WHERE id = $1`,
    [deliveryId],
  );
}

function normalizeStatus(value: unknown): CompletenessStatus {
  if (
    value === "complete" ||
    value === "suspicious" ||
    value === "incomplete"
  ) {
    return value;
  }
  return "suspicious";
}

function elevateStatus(
  current: CompletenessStatus,
  next: CompletenessStatus,
): CompletenessStatus {
  if (current === "incomplete" || next === "incomplete") return "incomplete";
  if (current === "suspicious" || next === "suspicious") return "suspicious";
  return "complete";
}

function normalizeWarningList(values: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = String(raw ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function extractAiLineItems(aiResult: any): any[] {
  if (Array.isArray(aiResult?.line_items)) return aiResult.line_items;
  if (Array.isArray(aiResult?.items)) return aiResult.items;

  const rawLineItems = aiResult?.line_items;
  if (
    !rawLineItems ||
    typeof rawLineItems !== "object" ||
    Array.isArray(rawLineItems)
  ) {
    return [];
  }

  const orderedNumericEntries: Array<{ sortKey: number; value: any }> = [];
  const fallbackValues: any[] = [];

  for (const [rawKey, rawValue] of Object.entries(rawLineItems)) {
    const parsedKey = Number(rawKey);
    const value =
      rawValue &&
      typeof rawValue === "object" &&
      !Array.isArray(rawValue) &&
      !Number.isFinite(Number((rawValue as any).row_number)) &&
      Number.isInteger(parsedKey) &&
      parsedKey > 0
        ? { ...(rawValue as Record<string, unknown>), row_number: parsedKey }
        : rawValue;

    if (Number.isInteger(parsedKey) && parsedKey > 0) {
      orderedNumericEntries.push({ sortKey: parsedKey, value });
    } else {
      fallbackValues.push(value);
    }
  }

  orderedNumericEntries.sort((a, b) => a.sortKey - b.sortKey);
  return [
    ...orderedNumericEntries.map((entry) => entry.value),
    ...fallbackValues,
  ];
}

function inflateSparseAiLineItems(aiResult: any, rawLineItems: any[]): any[] {
  if (!Array.isArray(rawLineItems) || rawLineItems.length === 0)
    return rawLineItems;

  const explicitRows = rawLineItems
    .map((item, idx) => {
      const rowNumber = asPositiveInteger((item as any)?.row_number);
      return rowNumber ?? null;
    })
    .filter((value): value is number => value != null);

  const visibleRowCount = asPositiveInteger(aiResult?.visible_row_count) ?? 0;
  const extractedRowCount =
    asPositiveInteger(aiResult?.extracted_row_count) ?? 0;
  const targetRowCount = Math.max(
    rawLineItems.length,
    visibleRowCount,
    extractedRowCount,
    ...explicitRows,
  );

  if (targetRowCount <= rawLineItems.length || explicitRows.length === 0) {
    return rawLineItems;
  }

  const byRowNumber = new Map<number, any>();
  rawLineItems.forEach((item, idx) => {
    const rowNumber = asPositiveInteger((item as any)?.row_number) ?? idx + 1;
    if (!byRowNumber.has(rowNumber)) {
      byRowNumber.set(
        rowNumber,
        rowNumber === (item as any)?.row_number
          ? item
          : { ...(item as object), row_number: rowNumber },
      );
    }
  });

  const denseItems: any[] = [];
  for (let rowNumber = 1; rowNumber <= targetRowCount; rowNumber += 1) {
    const existing = byRowNumber.get(rowNumber);
    if (existing) {
      denseItems.push(existing);
      continue;
    }

    denseItems.push({
      row_number: rowNumber,
      page_number: 1,
      product_name_raw: `UNKNOWN_ROW_${rowNumber}`,
      product_name: `UNKNOWN_ROW_${rowNumber}`,
      name_bg: `UNKNOWN_ROW_${rowNumber}`,
    });
  }

  return denseItems;
}

function inferSubmittedCompleteness(
  body: z.infer<typeof createIncomingSchema>,
) {
  const hasAnyCompletenessSignal =
    body.completeness_status != null ||
    body.visible_row_count != null ||
    body.extracted_row_count != null ||
    (body.warnings?.length ?? 0) > 0;

  if (!hasAnyCompletenessSignal) return null;

  let status: CompletenessStatus = normalizeStatus(body.completeness_status);
  const visibleRows = body.visible_row_count ?? null;
  const extractedRows = body.extracted_row_count ?? body.items.length;

  if (visibleRows != null) {
    if (extractedRows < visibleRows) {
      status = elevateStatus(status, "incomplete");
    } else if (extractedRows !== visibleRows) {
      status = elevateStatus(status, "suspicious");
    }
  }

  if ((body.warnings?.length ?? 0) > 0) {
    status = elevateStatus(status, "suspicious");
  }

  return {
    status,
    visibleRows,
    extractedRows,
  };
}

function evaluateScanCompletenessGate(aiResult: any, rawLineItems: any[]) {
  const extractedRowCount = rawLineItems.length;
  const aiVisible = Number(aiResult?.visible_row_count);
  const aiExtracted = Number(aiResult?.extracted_row_count);
  const visibleRowCount =
    Number.isFinite(aiVisible) && aiVisible > 0 ? aiVisible : extractedRowCount;

  let completenessStatus = normalizeStatus(aiResult?.completeness_status);
  if (!Number.isFinite(aiVisible) && !Number.isFinite(aiExtracted)) {
    completenessStatus =
      visibleRowCount === extractedRowCount ? "complete" : "suspicious";
  }

  const warnings: string[] = [];
  const sourceWarnings = Array.isArray(aiResult?.warnings)
    ? aiResult.warnings
    : [];
  warnings.push(...sourceWarnings.map((w: any) => String(w)));

  if (visibleRowCount !== extractedRowCount) {
    const mismatchStatus: CompletenessStatus =
      extractedRowCount < visibleRowCount ? "incomplete" : "suspicious";
    completenessStatus = elevateStatus(completenessStatus, mismatchStatus);
    warnings.push(
      `row_count_mismatch: visible=${visibleRowCount}, extracted=${extractedRowCount}`,
    );
  }

  const explicitRowNumbers = rawLineItems
    .map((li: any) => Number(li?.row_number))
    .filter((n) => Number.isFinite(n) && n > 0);
  const hasExplicitRows = explicitRowNumbers.length > 0;
  const contiguous =
    !hasExplicitRows ||
    (explicitRowNumbers.length === rawLineItems.length &&
      explicitRowNumbers.every((rowNo, idx) => rowNo === idx + 1));
  if (!contiguous) {
    completenessStatus = elevateStatus(completenessStatus, "suspicious");
    warnings.push("row_sequence_not_contiguous");
  }

  const contaminationRows: number[] = [];
  for (let idx = 0; idx < rawLineItems.length; idx++) {
    const li = rawLineItems[idx];
    const label = String(
      li?.product_name_raw ?? li?.product_name ?? li?.name_en ?? li?.name ?? "",
    ).trim();
    if (!label || !TOTAL_ROW_RE.test(label)) continue;
    const qty = asFiniteNumber(li?.quantity);
    const unit = String(li?.unit ?? "").trim();
    const unitPrice = asFiniteNumber(li?.unit_price ?? li?.price);
    const totalPrice = asFiniteNumber(li?.total_price ?? li?.total);
    const looksSummary = !(
      qty != null &&
      qty > 0 &&
      unit.length > 0 &&
      (unitPrice != null || totalPrice != null)
    );
    if (looksSummary) contaminationRows.push(idx + 1);
  }
  if (contaminationRows.length > 0) {
    completenessStatus = elevateStatus(completenessStatus, "suspicious");
    warnings.push(`table_contamination_rows:${contaminationRows.join(",")}`);
  }

  let arithmeticIssues = 0;
  for (const li of rawLineItems) {
    const qty = asFiniteNumber(li?.quantity);
    const unitPrice = asFiniteNumber(li?.unit_price ?? li?.price);
    const totalPrice = asFiniteNumber(li?.total_price ?? li?.total);
    if (qty == null || unitPrice == null || totalPrice == null) continue;
    if (Math.abs(qty * unitPrice - totalPrice) > 0.15) arithmeticIssues += 1;
  }
  if (arithmeticIssues > 0) {
    completenessStatus = elevateStatus(completenessStatus, "suspicious");
    warnings.push(`arithmetic_plausibility_issues:${arithmeticIssues}`);
  }

  const normalizedWarnings = normalizeWarningList(warnings);
  const needsReview = completenessStatus !== "complete";
  return {
    visibleRowCount,
    extractedRowCount,
    completenessStatus,
    warnings: normalizedWarnings,
    needsReview,
  };
}

export default async function incomingRoutes(app: FastifyInstance) {
  // GET /incoming/check-duplicate — lightweight duplicate invoice check
  app.get(
    "/check-duplicate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);

      const { invoice_number, supplier_id } = request.query as any;
      if (!invoice_number) return reply.send({ duplicate: false });

      const supplierIdNum = supplier_id ? Number(supplier_id) : null;
      const duplicate = await findDuplicateInvoice(
        String(invoice_number),
        Number.isFinite(supplierIdNum) ? supplierIdNum : null,
      );
      if (duplicate) {
        return reply.send({
          duplicate: true,
          existing_id: duplicate.id,
          status: duplicate.status,
          created_at: duplicate.created_at,
          message: `Фактура ${invoice_number} вече е вкарана на ${new Date(duplicate.created_at).toLocaleDateString("bg-BG")}`,
        });
      }
      return reply.send({ duplicate: false });
    },
  );

  // POST /incoming/quick-invoice-check — pre-scan: extract only invoice number via AI (cheap/fast)
  app.post(
    "/quick-invoice-check",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);

      const traceId = getScanTraceId(request);
      reply.header(SCAN_TRACE_HEADER, traceId);
      const startedAt = Date.now();

      const data = await request.file();
      if (!data) {
        logScanEvent(request.log, "quick_request_missing_file", traceId, {
          route: "/incoming/quick-invoice-check",
        });
        return reply
          .status(400)
          .send({ error: "No file uploaded", trace_id: traceId });
      }

      const buffer = await data.toBuffer();
      const aiUrl = process.env.AI_SERVICE_URL || "http://localhost:8000";
      logScanEvent(request.log, "quick_request_received", traceId, {
        route: "/incoming/quick-invoice-check",
        filename: data.filename,
        mime_type: data.mimetype,
        file_size_bytes: buffer.length,
      });

      try {
        const formData = new FormData();
        formData.append("file", new Blob([buffer]), data.filename);
        const controller = new AbortController();
        const timeoutMs = 30000;
        const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

        logScanEvent(request.log, "quick_ai_request_started", traceId, {
          ai_url: `${aiUrl}/ai/quick-invoice-check`,
          timeout_ms: timeoutMs,
        });

        try {
          const aiStartedAt = Date.now();
          const response = await fetch(`${aiUrl}/ai/quick-invoice-check`, {
            method: "POST",
            body: formData,
            headers: aiAuthHeaders({ [SCAN_TRACE_HEADER]: traceId }),
            signal: controller.signal,
          });

          logScanEvent(request.log, "quick_ai_request_finished", traceId, {
            status: response.status,
            ok: response.ok,
            duration_ms: Date.now() - aiStartedAt,
          });

          if (!response.ok) {
            return reply.send({ invoice_number: null, trace_id: traceId });
          }

          const result = (await response.json()) as any;
          logScanEvent(request.log, "quick_request_completed", traceId, {
            duration_ms: Date.now() - startedAt,
            invoice_number: result.invoice_number || null,
          });
          return reply.send({
            invoice_number: result.invoice_number || null,
            trace_id: traceId,
          });
        } finally {
          clearTimeout(timeoutHandle);
        }
      } catch (err: any) {
        logScanEvent(
          request.log,
          err?.name === "AbortError"
            ? "quick_ai_request_timeout"
            : "quick_ai_request_failed",
          traceId,
          {
            duration_ms: Date.now() - startedAt,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        // Graceful fallback — don't block the scan flow
        return reply.send({ invoice_number: null, trace_id: traceId });
      }
    },
  );

  // GET /incoming — list all incoming goods documents
  app.get(
    "/",
    { preHandler: incomingManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { status, page, limit, date_from, date_to, supplier_id, q } =
        request.query as any;
      const pageNum = Math.max(1, parseInt(page) || 1);
      const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(limit) || DEFAULT_PAGE_SIZE),
    );
      const offset = (pageNum - 1) * pageSize;

      const conditions: string[] = [];
      const params: any[] = [];
      let paramIdx = 1;

      if (status) {
        conditions.push(`ig.status = $${paramIdx++}`);
        params.push(status);
      }
      // "Днешни доставки" = доставките които СМЕ ПРИЕЛИ днес (created_at),
      // не фактури издадени днес (invoice_date може да е старо).
      if (date_from) {
        conditions.push(`ig.created_at::date >= $${paramIdx++}`);
        params.push(date_from);
      }
      if (date_to) {
        conditions.push(`ig.created_at::date <= $${paramIdx++}`);
        params.push(date_to);
      }
      if (supplier_id) {
        conditions.push(`ig.supplier_id = $${paramIdx++}`);
        params.push(parseInt(supplier_id));
      }
      // Търсене: номер на фактура ИЛИ име на доставчик — складът помни
      // едното от двете, едно поле покрива и двата случая.
      if (q && String(q).trim()) {
        conditions.push(
          `(ig.invoice_number ILIKE $${paramIdx} OR s.name ILIKE $${paramIdx + 1})`,
        );
        const like = `%${String(q).trim()}%`;
        params.push(like, like);
        paramIdx += 2;
      }

      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const sql = `
      SELECT ig.*, s.name AS supplier_name,
             COUNT(ii.id)::int AS item_count
      FROM incoming_goods ig
      LEFT JOIN suppliers s ON s.id = ig.supplier_id
      LEFT JOIN incoming_items ii ON ii.incoming_goods_id = ig.id
      ${where}
      GROUP BY ig.id, s.name
      ORDER BY ig.created_at DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
      params.push(pageSize, offset);

      const { rows } = await query(sql, params);
      return { data: rows };
    },
  );

  // GET /incoming/:id — get single document with items
  app.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    const { id } = request.params as any;

    // Guard: only numeric IDs (avoid catching /check-duplicate etc.)
    const numId = parseInt(id, 10);
    if (isNaN(numId)) return reply.status(400).send({ error: "Invalid ID" });

    const { rows: docs } = await query(
      `SELECT ig.*, s.name AS supplier_name FROM incoming_goods ig
       LEFT JOIN suppliers s ON s.id = ig.supplier_id WHERE ig.id = $1`,
      [numId],
    );
    if (!docs[0]) return reply.status(404).send({ error: "Not found" });

    // MERT-M: batches table is deprecated — no JOIN / batch columns.
    const { rows: items } = await query(
      `SELECT ii.*, p.name_bg, p.name_en, p.unit,
              p.selling_price AS product_selling_price,
              p.purchase_price AS product_purchase_price,
              p.sku AS product_sku
       FROM incoming_items ii
       LEFT JOIN products p ON p.id = ii.product_id
       WHERE ii.incoming_goods_id = $1
       ORDER BY ii.id ASC`,
      [id],
    );

    const filteredItems = await stripFieldsForUser(
      (request as any).user,
      items,
      [
        {
          permission: PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE,
          fields: ["product_purchase_price"],
        },
      ],
    );

    return reply.send({ ...docs[0], items: filteredItems });
  });

  // POST /incoming — create incoming goods document with items
  app.post(
    "/",
    { preHandler: incomingManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = createIncomingSchema.parse(request.body);
      const strictReviewMode = body.strict_review_mode ?? false;
      const allowAutoCreateUnmatched =
        body.allow_auto_create_unmatched ?? !strictReviewMode;
      const submittedCompleteness = inferSubmittedCompleteness(body);
      const idempotencyKey = getIdempotencyKey(request);
      const idempotencyRequestHash = idempotencyKey
        ? hashIncomingRequest(body)
        : null;

      if (strictReviewMode && submittedCompleteness?.status === "incomplete") {
        return reply.status(422).send({
          error: "incomplete_extraction",
          message:
            "Сканирането е непълно (липсват редове). Коригирайте редовете преди запис.",
          visible_row_count: submittedCompleteness.visibleRows,
          extracted_row_count: submittedCompleteness.extractedRows,
          completeness_status: submittedCompleteness.status,
          warnings: body.warnings ?? [],
        });
      }

      if (
        strictReviewMode &&
        submittedCompleteness?.status === "suspicious" &&
        !body.review_accepted_for_completeness
      ) {
        return reply.status(422).send({
          error: "suspicious_extraction_requires_review",
          message:
            "Сканирането е със съмнителна пълнота. Потвърдете ръчния преглед преди запис.",
          visible_row_count: submittedCompleteness.visibleRows,
          extracted_row_count: submittedCompleteness.extractedRows,
          completeness_status: submittedCompleteness.status,
          warnings: body.warnings ?? [],
        });
      }

      if (idempotencyKey && idempotencyRequestHash) {
        const existingReplay = await findIncomingByIdempotencyKey(
          { query },
          idempotencyKey,
        );
        if (existingReplay) {
          if (
            existingReplay.idempotency_request_hash !== idempotencyRequestHash
          ) {
            return reply.status(409).send({
              error: "idempotency_key_conflict",
              message:
                "Idempotency-Key вече е използван с различно съдържание за входяща доставка.",
              existing_id: existingReplay.id,
            });
          }
          reply.header("Idempotency-Replayed", "true");
          return reply.status(200).send(existingReplay);
        }
      }

      try {
        // Check for duplicate invoice number (before transaction).
        // Passing supplier_id enables tier-2 fuzzy detection (catches
        // OCR variants of the same invoice by the same supplier).
        if (body.invoice_number) {
          const existing = await findDuplicateInvoice(
            body.invoice_number,
            body.supplier_id ?? null,
          );
          if (existing) {
            return reply.status(409).send({
              error: "duplicate_invoice",
              message: `Фактура с номер "${body.invoice_number}" вече е вкарана в системата.`,
              existing_id: existing.id,
              existing_date: existing.created_at,
            });
          }
        }

        const result = await transaction(async (client) => {
          let totalAmount = 0;

          let incoming: Record<string, any> | null = null;
          if (idempotencyKey && idempotencyRequestHash) {
            const {
              rows: [createdIncoming],
            } = await client.query(
              `INSERT INTO incoming_goods (
               supplier_id,
               invoice_number,
               invoice_date,
               document_type,
               scanned_file_path,
               status,
               idempotency_key,
               idempotency_request_hash
             )
             VALUES (NULL, $1, $2, $3, $4, 'pending', $5, $6)
             RETURNING *`,
              [
                body.invoice_number,
                body.invoice_date,
                body.document_type,
                body.scanned_file_path ?? null,
                idempotencyKey,
                idempotencyRequestHash,
              ],
            );
            incoming = createdIncoming;
          }

          // Auto-resolve supplier — everything inside transaction for atomicity
          let finalSupplierId = body.supplier_id ?? null;
          let supplierMatchSource: string = "explicit"; // for alias upsert below
          if (!finalSupplierId && (body.supplier_eik || body.supplier_name)) {
            let existingSupplier = null;

            // ── 0. Learned alias (user-taught) ────────────────────────────
            //    Highest priority: if we've seen this exact raw name before
            //    (either the system auto-linked it or a human confirmed the
            //    suggestion on the review screen), go straight to that
            //    supplier. This is how the app "remembers" choices.
            if (body.supplier_name) {
              const { rows } = await client.query(
                `SELECT sa.supplier_id AS id, s.name
                 FROM supplier_aliases sa
                 JOIN suppliers s ON s.id = sa.supplier_id
                WHERE sa.alias_normalized = normalize_search($1)
                LIMIT 1`,
                [body.supplier_name],
              );
              if (rows[0]) {
                existingSupplier = rows[0];
                supplierMatchSource = "alias_exact";
              }
            }
            // 1. EIK exact (with country prefix stripped — "EL997..." vs "997...")
            if (!existingSupplier && body.supplier_eik) {
              const normalizedEik = body.supplier_eik
                .replace(/^(EL|BG|GR|CY|RO)/i, "")
                .trim();
              const { rows } = await client.query(
                `SELECT id FROM suppliers
               WHERE REGEXP_REPLACE(eik, '^(EL|BG|GR|CY|RO)', '', 'i') = $1
                  OR eik = $2
               LIMIT 1`,
                [normalizedEik, body.supplier_eik],
              );
              if (rows[0]) {
                existingSupplier = rows[0];
                supplierMatchSource = "eik";
              }
            }
            // 2. VAT match (same convention)
            if (!existingSupplier && body.supplier_vat) {
              const normalizedVat = body.supplier_vat
                .replace(/^(EL|BG|GR|CY|RO)/i, "")
                .trim();
              const { rows } = await client.query(
                `SELECT id FROM suppliers
               WHERE REGEXP_REPLACE(vat_number, '^(EL|BG|GR|CY|RO)', '', 'i') = $1
                  OR vat_number = $2
               LIMIT 1`,
                [normalizedVat, body.supplier_vat],
              );
              if (rows[0]) {
                existingSupplier = rows[0];
                supplierMatchSource = "vat";
              }
            }
            // 3. Exact name (case-insensitive)
            if (!existingSupplier && body.supplier_name) {
              const { rows } = await client.query(
                "SELECT id FROM suppliers WHERE name ILIKE $1 LIMIT 1",
                [body.supplier_name],
              );
              if (rows[0]) {
                existingSupplier = rows[0];
                supplierMatchSource = "name_exact";
              }
            }
            // 4. Fuzzy name — translit-aware normalize + pg_trgm
            //    Combines three measures to handle:
            //      - typos          → similarity        ("CONFECTIONARY"↔"CONFECTIONERY")
            //      - short⊂long     → word_similarity   ("ELMAR CRETE S.A." ⊂ "ELMAR CRETE S.A COMMERCIAL & INDUSTRIAL CO.")
            //      - long⊂short     → reversed word_similarity
            //    Catches spacing, punctuation, case, Cyrillic↔Latin differences.
            if (!existingSupplier && body.supplier_name) {
              const { rows } = await client.query(
                `SELECT id, name,
                      similarity(normalize_search(name), normalize_search($1)) AS sim,
                      word_similarity(normalize_search(name), normalize_search($1)) AS wsim_a,
                      word_similarity(normalize_search($1), normalize_search(name)) AS wsim_b,
                      GREATEST(
                        similarity(normalize_search(name), normalize_search($1)),
                        word_similarity(normalize_search(name), normalize_search($1)),
                        word_similarity(normalize_search($1), normalize_search(name))
                      ) AS best
               FROM suppliers
               WHERE normalize_search(name) % normalize_search($1)
                  OR normalize_search(name) <% normalize_search($1)
                  OR normalize_search($1) <% normalize_search(name)
               ORDER BY best DESC
               LIMIT 1`,
                [body.supplier_name],
              );
              // Accept if any measure is strong enough:
              //   similarity      >= 0.45  (fuzzy typo across full strings)
              //   word_similarity >= 0.70  (one name fully contained in the other)
              if (rows[0]) {
                const sim = parseFloat(rows[0].sim);
                const wsimA = parseFloat(rows[0].wsim_a);
                const wsimB = parseFloat(rows[0].wsim_b);
                if (sim >= 0.45 || wsimA >= 0.7 || wsimB >= 0.7) {
                  existingSupplier = rows[0];
                  supplierMatchSource = "fuzzy";
                }
              }
            }
            if (existingSupplier) {
              finalSupplierId = existingSupplier.id;
              // Auto-fill missing supplier fields from AI-extracted invoice data.
              // COALESCE(NULLIF(x, ''), $new) = keep existing if present; fill
              // only when currently NULL or empty string. NEVER overwrites
              // existing data, so AI errors on subsequent scans are harmless.
              //
              // EIK is filled only if no OTHER supplier already has this EIK
              // (protects the unique index on eik).
              let eikToFill: string | null = null;
              if (body.supplier_eik) {
                const normalizedEik = body.supplier_eik
                  .replace(/^(EL|BG|GR|CY|RO)/i, "")
                  .trim();
                const { rows: conflict } = await client.query(
                  `SELECT id FROM suppliers
                 WHERE id <> $1
                   AND (
                     eik = $2
                     OR REGEXP_REPLACE(eik, '^(EL|BG|GR|CY|RO)', '', 'i') = $3
                   )
                 LIMIT 1`,
                  [finalSupplierId, body.supplier_eik, normalizedEik],
                );
                if (conflict.length === 0) {
                  eikToFill = body.supplier_eik;
                }
              }
              await client.query(
                `UPDATE suppliers SET
                eik            = COALESCE(NULLIF(eik, ''),            $1),
                vat_number     = COALESCE(NULLIF(vat_number, ''),     $2),
                address        = COALESCE(NULLIF(address, ''),        $3),
                phone          = COALESCE(NULLIF(phone, ''),          $4),
                email          = COALESCE(NULLIF(email, ''),          $5),
                contact_person = COALESCE(NULLIF(contact_person, ''), $6),
                updated_at     = NOW()
               WHERE id = $7`,
                [
                  eikToFill,
                  body.supplier_vat || null,
                  body.supplier_address || null,
                  body.supplier_phone || null,
                  body.supplier_email || null,
                  body.supplier_contact || null,
                  finalSupplierId,
                ],
              );
            } else if (body.supplier_name) {
              const { rows } = await client.query(
                `INSERT INTO suppliers (name, eik, vat_number, address, phone, email, contact_person)
               VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [
                  body.supplier_name,
                  body.supplier_eik || null,
                  body.supplier_vat || null,
                  body.supplier_address || null,
                  body.supplier_phone || null,
                  body.supplier_email || null,
                  body.supplier_contact || null,
                ],
              );
              finalSupplierId = rows[0].id;
              supplierMatchSource = "created_new";
            }
          }

          // ── Record alias (learn for next time) ───────────────────────────
          //
          // Every successful supplier resolution teaches the system that the
          // raw name we just saw maps to this supplier_id. Next scan with the
          // same (or similar) raw name will hit strategy 0 (alias_exact) and
          // link instantly — no trigram roulette.
          //
          // Source tracks WHY we're linking:
          //   explicit       → user picked a supplier_id on the payload
          //   user_confirmed → user clicked a suggestion on the review screen
          //                    (frontend sends supplier_id + a flag; handled
          //                    via `explicit` branch above)
          //   alias_exact    → found via this same table on a prior scan
          //   eik / vat      → certain identifiers matched
          //   name_exact     → case-insensitive name match
          //   fuzzy          → pg_trgm similarity / word_similarity match
          //   created_new    → brand-new supplier; prime the alias so next
          //                    time we don't fuzzy-roll it again
          //
          // Conflict handling: alias_normalized is UNIQUE. If it already
          // points elsewhere, we prefer user_confirmed > explicit > alias
          // over auto-derived sources — never silently flip a taught mapping.
          if (finalSupplierId && body.supplier_name) {
            // Access-control gate on the authoritative-override branch:
            //   only admin / owner_mobile / warehouse roles can FLIP a stored
            //   `user_confirmed` alias by passing an explicit `supplier_id`
            //   in the body. Any other role (e.g. accountant) gets the
            //   non-authoritative branch, which merely bumps hit_count and
            //   preserves the existing mapping. This matches the threat
            //   model: only operators who physically handle deliveries (or
            //   admins) should be able to retrain the supplier resolver.
            const userRole = (request as any).user?.role as string | undefined;
            const canAuthoritativelyBind =
              userRole === "admin" ||
              userRole === "owner_mobile" ||
              userRole === "warehouse";
            const isAuthoritative =
              canAuthoritativelyBind &&
              (supplierMatchSource === "explicit" ||
                supplierMatchSource === "alias_exact");
            const confidence = supplierMatchSource === "fuzzy" ? 0.75 : 1.0;
            await client.query(
              `INSERT INTO supplier_aliases
                (alias_raw, alias_normalized, supplier_id, source, confidence, hit_count, last_seen_at)
             VALUES ($1, normalize_search($1), $2, $3, $4, 1, NOW())
             ON CONFLICT (alias_normalized) DO UPDATE SET
               hit_count    = supplier_aliases.hit_count + 1,
               last_seen_at = NOW(),
               -- Only overwrite supplier_id when incoming mapping is
               -- authoritative (explicit user pick). Never let an auto
               -- match flip a previously user-confirmed alias.
               supplier_id  = CASE
                 WHEN $5 = true THEN EXCLUDED.supplier_id
                 ELSE supplier_aliases.supplier_id
               END,
               source       = CASE
                 WHEN $5 = true THEN 'user_confirmed'
                 ELSE supplier_aliases.source
               END,
               confidence   = GREATEST(supplier_aliases.confidence, EXCLUDED.confidence)`,
              [
                body.supplier_name,
                finalSupplierId,
                supplierMatchSource,
                confidence,
                isAuthoritative,
              ],
            );
          }

          if (incoming) {
            const {
              rows: [updatedIncoming],
            } = await client.query(
              `UPDATE incoming_goods
             SET supplier_id = $1,
                 updated_at = NOW()
             WHERE id = $2
             RETURNING *`,
              [finalSupplierId, incoming.id],
            );
            incoming = updatedIncoming;
          } else {
            const {
              rows: [createdIncoming],
            } = await client.query(
              `INSERT INTO incoming_goods (supplier_id, invoice_number, invoice_date, document_type, scanned_file_path, status)
             VALUES ($1, $2, $3, $4, $5, 'pending')
             RETURNING *`,
              [
                finalSupplierId,
                body.invoice_number,
                body.invoice_date,
                body.document_type,
                body.scanned_file_path ?? null,
              ],
            );
            incoming = createdIncoming;
          }

          if (!incoming) {
            throw Object.assign(new Error("Failed to persist incoming goods"), {
              statusCode: 500,
            });
          }

          // Create items
          const items = [];
          for (const [index, item] of body.items.entries()) {
            const totalPrice = item.quantity * item.unit_price;
            totalAmount += totalPrice;
            const explicitProductId =
              typeof item.product_id === "number" ? item.product_id : null;

            // Resolve product_id:
            // 1) provided id from matcher
            // 2) alias lookup (supplier-aware)
            // 3) exact and fuzzy DB name lookup
            // 4) create new product as fallback
            let productId = explicitProductId;
            const nameCandidates = uniqueProductTerms([
              item.product_name_raw,
              item.product_name,
              item.name_bg,
            ]);

            // If product_id was provided, verify it exists
            if (productId) {
              const { rows: existCheck } = await client.query(
                "SELECT id FROM products WHERE id = $1",
                [productId],
              );
              if (existCheck.length === 0) {
                productId = null; // ID invalid, fall through to matching
              }
            }

            // Supplier-aware alias lookup (exact normalized key)
            if (!productId && nameCandidates.length > 0) {
              const normalizedCandidates = Array.from(
                new Set(
                  nameCandidates
                    .map((n) => normalizeAliasName(n))
                    .filter((n): n is string => n.length > 0),
                ),
              );
              const rawLowerCandidates = Array.from(
                new Set(nameCandidates.map((n) => n.toLowerCase().trim())),
              );

              if (normalizedCandidates.length > 0) {
                const { rows: aliasMatches } = await client.query(
                  `SELECT pa.product_id
               FROM product_aliases pa
               WHERE (
                  LOWER(pa.alias_name_normalized) = ANY($1::text[])
                  OR LOWER(TRIM(pa.alias_name)) = ANY($2::text[])
               )
                 AND ($3::int IS NULL OR pa.supplier_id = $3 OR pa.supplier_id IS NULL)
               ORDER BY
                 CASE
                   WHEN $3::int IS NOT NULL AND pa.supplier_id = $3 THEN 0
                   WHEN pa.supplier_id IS NULL THEN 1
                   ELSE 2
                 END,
                 pa.confidence DESC NULLS LAST,
                 pa.updated_at DESC
               LIMIT 1`,
                  [
                    normalizedCandidates,
                    rawLowerCandidates,
                    finalSupplierId || null,
                  ],
                );
                if (aliasMatches.length > 0) {
                  productId = aliasMatches[0].product_id;
                }
              }
            }

            // Exact name lookup (case-insensitive)
            if (!productId && nameCandidates.length > 0) {
              const lowered = nameCandidates.map((n) => n.toLowerCase());
              const { rows: exactMatches } = await client.query(
                `SELECT id
             FROM products
             WHERE LOWER(TRIM(name_bg)) = ANY($1::text[])
                OR LOWER(TRIM(name_en)) = ANY($1::text[])
             LIMIT 1`,
                [lowered],
              );
              if (exactMatches.length > 0) {
                productId = exactMatches[0].id;
              }
            }

            // Fuzzy contains lookup for OCR variations (longest term first)
            if (!productId && nameCandidates.length > 0) {
              const ordered = [...nameCandidates].sort(
                (a, b) => b.length - a.length,
              );
              for (const term of ordered) {
                if (term.length < 3) continue;
                const like = `%${escapeLike(term)}%`;
                const { rows: fuzzyMatches } = await client.query(
                  `SELECT id
               FROM products
               WHERE name_bg ILIKE $1 ESCAPE '\\'
                  OR name_en ILIKE $1 ESCAPE '\\'
               ORDER BY ABS(LENGTH(COALESCE(name_bg, name_en, '')) - LENGTH($2))
               LIMIT 1`,
                  [like, term],
                );
                if (fuzzyMatches.length > 0) {
                  productId = fuzzyMatches[0].id;
                  break;
                }
              }
            }

            // If matched existing product, enrich missing brand once.
            if (!strictReviewMode && productId && item.brand) {
              await client.query(
                `UPDATE products
             SET brand = $1
             WHERE id = $2 AND (brand IS NULL OR brand = '')`,
                [shortenBrand(item.brand), productId],
              );
            }

            // Create new product only if no reliable match exists.
            if (!productId) {
              const sourceName =
                item.product_name_raw?.trim() ||
                item.product_name?.trim() ||
                item.name_bg?.trim();
              if (!sourceName) {
                throw Object.assign(
                  new Error(
                    "Incoming item must contain product_name_raw, product_name, or name_bg",
                  ),
                  { statusCode: 400 },
                );
              }

              if (!allowAutoCreateUnmatched) {
                throw Object.assign(
                  new Error(
                    `Unresolved product at row ${item.row_number ?? index + 1}: ${sourceName}`,
                  ),
                  {
                    statusCode: 422,
                    code: "unresolved_products",
                    row_number: item.row_number ?? index + 1,
                  },
                );
              }

              // Auto-detect category from hint
              let categoryId = null;
              if (item.category_hint) {
                // category_hint matches categories.name_en directly
                // Also support legacy/alias hints
                const aliasMap: Record<string, string> = {
                  canned: "sweets", // closest match for canned goods → sweets or keep as-is
                  seafood: "meat", // no seafood category → map to колбаси
                  nuts: "sweets", // nuts → sladki
                };
                const hint = aliasMap[item.category_hint] ?? item.category_hint;
                const { rows: cats } = await client.query(
                  "SELECT id FROM categories WHERE name_en = $1 LIMIT 1",
                  [hint],
                );
                if (cats.length > 0) categoryId = cats[0].id;
              }

              // Normalize unit — BG / EN / Greek variants
              const unitMap: Record<string, string> = {
                // kg — BG / EN / GR (incl. Cyrillic-looking OCR of Greek: КІЛО, КИЛО)
                кг: "kg",
                "кг.": "kg",
                kg: "kg",
                кило: "kg",
                кіло: "kg",
                κγ: "kg",
                κιλ: "kg",
                κιλό: "kg",
                kgr: "kg",
                kilo: "kg",
                кил: "kg",
                кіл: "kg",
                // g
                г: "g",
                "г.": "g",
                g: "g",
                gr: "g",
                γρ: "g",
                // pcs — BG / EN / GR
                бр: "pcs",
                "бр.": "pcs",
                бройки: "pcs",
                pcs: "pcs",
                pc: "pcs",
                τεμ: "pcs",
                "τεμ.": "pcs",
                τεμάχιο: "pcs",
                tem: "pcs",
                тем: "pcs",
                "тем.": "pcs",
                темачио: "pcs", // Cyrillic OCR of ΤΕΜ
                piece: "pcs",
                pieces: "pcs",
                // litre
                л: "l",
                "л.": "l",
                l: "l",
                lt: "l",
                ltr: "l",
                // ml
                мл: "ml",
                ml: "ml",
                // box / pack
                кутия: "box",
                кашон: "box",
                box: "box",
                пакет: "pack",
                pack: "pack",
                pkg: "pack",
              };
              // Default to 'kg' for food items (most sold by weight)
              const unit =
                (item.unit
                  ? (unitMap[item.unit.toLowerCase()] ??
                    unitMap[item.unit] ??
                    item.unit)
                  : null) || "kg";

              // Generate sequential 5-digit numeric SKU (10001, 10002, ...)
              const { rows: lastSku } = await client.query(
                `SELECT sku FROM products WHERE sku ~ '^[0-9]{5}$' ORDER BY sku DESC LIMIT 1`,
              );
              const nextNum =
                lastSku.length > 0 ? parseInt(lastSku[0].sku) + 1 : 10001;
              const sku = String(nextNum).padStart(5, "0");

              // Create product with all extracted info
              // name_bg = Bulgarian translation (from AI), name_en = original invoice name
              const nameBg = item.name_bg || sourceName;
              const nameEn = item.product_name || sourceName;
              const {
                rows: [newProduct],
              } = await client.query(
                `INSERT INTO products (name_bg, name_en, sku, unit, brand, category_id, low_stock_threshold, purchase_price, selling_price)
             VALUES ($1, $2, $3, $4, $5, $6, 10, $7, $8) RETURNING id`,
                [
                  nameBg,
                  nameEn,
                  sku,
                  unit,
                  shortenBrand(item.brand),
                  categoryId,
                  item.unit_price > 0 ? item.unit_price : null,
                  item.selling_price && item.selling_price > 0
                    ? item.selling_price
                    : null,
                ],
              );
              productId = newProduct.id;
            }

            // Партида/срок се заснемат на входящия ред (batch_id остава
            // NULL до confirm — тогава се резолюира/създава реалната
            // партида и наличност по партида).

            const stagedSellingPrice =
              item.selling_price != null && item.selling_price > 0
                ? item.selling_price
                : null;

            const {
              rows: [incomingItem],
            } = await client.query(
              `INSERT INTO incoming_items (
             incoming_goods_id,
             product_id,
             quantity,
             unit_price,
             total_price,
             selling_price,
             batch_number,
             expiry_date
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
              [
                incoming.id,
                productId,
                item.quantity,
                item.unit_price,
                totalPrice,
                stagedSellingPrice,
                item.batch_number ?? null,
                normalizeExpiryInput(item.expiry_date),
              ],
            );

            items.push(incomingItem);

            // Save alias: once confirmed, remember OCR name -> product for future instant matching
            const aliasName =
              item.product_name_raw?.trim() ||
              item.product_name?.trim() ||
              item.name_bg?.trim();
            const shouldPersistAlias =
              Boolean(productId && aliasName) &&
              (!strictReviewMode ||
                (explicitProductId != null && explicitProductId === productId));
            if (shouldPersistAlias && aliasName) {
              try {
                const normalized = normalizeAliasName(aliasName);
                if (normalized) {
                  const supplierIdForAlias = finalSupplierId || null;
                  const { rows: existingAlias } = await client.query(
                    `SELECT id FROM product_aliases
                 WHERE LOWER(alias_name_normalized) = LOWER($1)
                   AND supplier_id IS NOT DISTINCT FROM $2
                 LIMIT 1`,
                    [normalized, supplierIdForAlias],
                  );

                  if (existingAlias.length > 0) {
                    await client.query(
                      `UPDATE product_aliases
                   SET alias_name = $1,
                       alias_name_normalized = $2,
                       product_id = $3,
                       updated_at = NOW()
                   WHERE id = $4`,
                      [aliasName, normalized, productId, existingAlias[0].id],
                    );
                  } else {
                    await client.query(
                      `INSERT INTO product_aliases (alias_name, alias_name_normalized, product_id, supplier_id)
                   VALUES ($1, $2, $3, $4)`,
                      [aliasName, normalized, productId, supplierIdForAlias],
                    );
                  }
                }
              } catch (aliasErr) {
                // Non-critical — don't fail the delivery
                console.warn("Alias save failed:", aliasErr);
              }
            }
          }

          // Update total amount
          await client.query(
            "UPDATE incoming_goods SET total_amount = $1 WHERE id = $2",
            [totalAmount, incoming.id],
          );

          return { ...incoming, total_amount: totalAmount, items };
        });

        return reply.status(201).send(result);
      } catch (error: any) {
        const isIdempotencyConflict =
          idempotencyKey &&
          error?.code === "23505" &&
          error?.constraint === "incoming_goods_idempotency_key_key";

        if (isIdempotencyConflict && idempotencyRequestHash) {
          const existingReplay = await findIncomingByIdempotencyKey(
            { query },
            idempotencyKey,
          );
          if (existingReplay) {
            if (
              existingReplay.idempotency_request_hash !== idempotencyRequestHash
            ) {
              return reply.status(409).send({
                error: "idempotency_key_conflict",
                message:
                  "Idempotency-Key вече е използван с различно съдържание за входяща доставка.",
                existing_id: existingReplay.id,
              });
            }
            reply.header("Idempotency-Replayed", "true");
            return reply.status(200).send(existingReplay);
          }
        }

        throw error;
      }
    },
  );

  // GET /incoming/document/:filename — serve scanned document file
  app.get(
    "/document/:filename",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      if (reply.statusCode >= 400) return;

      const { filename } = request.params as { filename: string };
      // Prevent path traversal
      const safe = path.basename(filename);
      const filepath = path.resolve("uploads", "incoming", safe);

      if (!fs.existsSync(filepath)) {
        return reply.status(404).send({ error: "File not found" });
      }

      const ext = safe.split(".").pop()?.toLowerCase();
      const mimeTypes: Record<string, string> = {
        pdf: "application/pdf",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
      };
      const mime = mimeTypes[ext ?? ""] ?? "application/octet-stream";
      reply.header("Content-Type", mime);
      reply.header("Content-Disposition", `inline; filename="${safe}"`);
      return reply.send(fs.readFileSync(filepath));
    },
  );

  // POST /incoming/scan — upload invoice for AI processing
  app.post("/scan", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);

    const traceId = getScanTraceId(request);
    reply.header(SCAN_TRACE_HEADER, traceId);
    const startedAt = Date.now();

    const data = await request.file();
    if (!data) {
      logScanEvent(request.log, "request_missing_file", traceId, {
        route: "/incoming/scan",
      });
      return reply
        .status(400)
        .send({ error: "No file uploaded", trace_id: traceId });
    }

    // Save file
    const uploadsDir = path.resolve("uploads", "incoming");
    fs.mkdirSync(uploadsDir, { recursive: true });

    const filename = `${Date.now()}-${data.filename}`;
    const filepath = path.join(uploadsDir, filename);
    const buffer = await data.toBuffer();
    fs.writeFileSync(filepath, buffer);
    logScanEvent(request.log, "request_received", traceId, {
      route: "/incoming/scan",
      filename: data.filename,
      stored_filename: filename,
      mime_type: data.mimetype,
      file_size_bytes: buffer.length,
      saved_path: filepath,
    });

    // Forward to AI service for OCR
    const aiUrl = process.env.AI_SERVICE_URL || "http://localhost:8000";
    try {
      const formData = new FormData();
      formData.append("file", new Blob([buffer]), data.filename);
      const controller = new AbortController();
      const timeoutMs = 120000;
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

      logScanEvent(request.log, "ai_request_started", traceId, {
        ai_url: `${aiUrl}/ai/scan-invoice`,
        timeout_ms: timeoutMs,
      });

      let response: Response;
      try {
        const aiStartedAt = Date.now();
        response = await fetch(`${aiUrl}/ai/scan-invoice`, {
          method: "POST",
          body: formData,
          headers: aiAuthHeaders({ [SCAN_TRACE_HEADER]: traceId }),
          signal: controller.signal,
        });
        logScanEvent(request.log, "ai_request_finished", traceId, {
          status: response.status,
          ok: response.ok,
          duration_ms: Date.now() - aiStartedAt,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (!response.ok) {
        logScanEvent(request.log, "ai_response_not_ok", traceId, {
          status: response.status,
          duration_ms: Date.now() - startedAt,
        });
        return reply.status(502).send({
          error: "AI service unavailable",
          scanned_file_path: filepath,
          trace_id: traceId,
        });
      }

      const aiResult = (await response.json()) as any;
      const rawLineItems = inflateSparseAiLineItems(
        aiResult,
        extractAiLineItems(aiResult),
      );
      const completenessGate = evaluateScanCompletenessGate(
        aiResult,
        rawLineItems,
      );
      const extractionLineItems = rawLineItems.map(
        (rawLi: any, idx: number) => {
          const li =
            rawLi && typeof rawLi === "object"
              ? rawLi
              : { product_name_raw: String(rawLi ?? "") };
          return {
            row_number: asPositiveInteger(li.row_number) ?? idx + 1,
            page_number: asPositiveInteger(li.page_number) ?? 1,
            product_name_raw: asNullableString(
              li.product_name_raw ??
                li.product_name ??
                li.name_en ??
                li.name_bg ??
                li.name,
            ),
            product_code_raw: asNullableString(
              li.product_code_raw ?? li.product_code,
            ),
            quantity: asFiniteNumber(li.quantity),
            unit: asNullableString(li.unit),
            unit_price: asFiniteNumber(li.unit_price ?? li.price),
            discount_percent: asFiniteNumber(li.discount_percent),
            discount_amount: asFiniteNumber(li.discount_amount),
            total_price: asFiniteNumber(li.total_price ?? li.total),
            batch_number_raw: asNullableString(
              li.batch_number_raw ?? li.batch_number ?? li.batch,
            ),
            expiry_date_raw: asNullableString(
              li.expiry_date_raw ?? li.expiry_date ?? li.expiry,
            ),
            notes_raw: asNullableString(li.notes_raw),
          };
        },
      );

      // Resolve supplier_id from AI-extracted identity (EIK / name alias)
      // so the duplicate check can use its supplier-scoped fuzzy tier.
      // We look up via alias first (user_confirmed mappings are fastest
      // path) then fall back to EIK match. Missing → null → only tier-1
      // exact-string dedupe applies.
      let scanSupplierId: number | null = null;
      if (aiResult?.supplier_name) {
        const { rows: aliasRows } = await query(
          `SELECT supplier_id FROM supplier_aliases
            WHERE alias_normalized = normalize_search($1) LIMIT 1`,
          [aiResult.supplier_name],
        );
        if (aliasRows[0]) scanSupplierId = aliasRows[0].supplier_id;
      }
      if (!scanSupplierId && aiResult?.supplier_eik) {
        const normalizedEik = String(aiResult.supplier_eik)
          .replace(/^(EL|BG|GR|CY|RO)/i, "")
          .trim();
        const { rows: eikRows } = await query(
          `SELECT id FROM suppliers
            WHERE REGEXP_REPLACE(eik, '^(EL|BG|GR|CY|RO)', '', 'i') = $1
               OR eik = $2
            LIMIT 1`,
          [normalizedEik, aiResult.supplier_eik],
        );
        if (eikRows[0]) scanSupplierId = eikRows[0].id;
      }

      const duplicateInvoice = aiResult?.invoice_number
        ? await findDuplicateInvoice(
            String(aiResult.invoice_number),
            scanSupplierId,
          )
        : null;

      // Extraction-first scan contract: raw rows + completeness metadata.
      const normalized = {
        trace_id: traceId,
        document_type: aiResult.document_type ?? "invoice",
        supplier_name: asNullableString(aiResult.supplier_name),
        supplier_eik: asNullableString(aiResult.supplier_eik),
        supplier_vat: asNullableString(aiResult.supplier_vat),
        supplier_address: asNullableString(aiResult.supplier_address),
        supplier_phone: asNullableString(aiResult.supplier_phone),
        supplier_email: asNullableString(aiResult.supplier_email),
        supplier_contact: asNullableString(aiResult.supplier_contact),
        invoice_number: asNullableString(aiResult.invoice_number),
        invoice_date: asNullableString(aiResult.invoice_date),
        currency: asNullableString(aiResult.currency) ?? "BGN",
        total_net: asFiniteNumber(aiResult.total_net),
        total_vat: asFiniteNumber(aiResult.total_vat),
        total_gross: asFiniteNumber(aiResult.total_gross),
        total: asFiniteNumber(aiResult.total_gross ?? aiResult.total_net),
        needs_companion_doc: Boolean(aiResult.needs_companion_doc),
        missing_batch: Boolean(aiResult.missing_batch),
        missing_expiry: Boolean(aiResult.missing_expiry),
        line_items: extractionLineItems,
        // Backward-compatible alias for existing clients expecting `items`.
        items: extractionLineItems,
        visible_row_count: completenessGate.visibleRowCount,
        extracted_row_count: completenessGate.extractedRowCount,
        completeness_status: completenessGate.completenessStatus,
        warnings: completenessGate.warnings,
        needs_review: completenessGate.needsReview,
        duplicate_invoice: duplicateInvoice
          ? {
              duplicate: true,
              existing_id: duplicateInvoice.id,
              status: duplicateInvoice.status,
              created_at: duplicateInvoice.created_at,
              message: `Фактура ${aiResult.invoice_number} вече е вкарана на ${new Date(duplicateInvoice.created_at).toLocaleDateString("bg-BG")}`,
            }
          : { duplicate: false },
        scanned_file_path: filepath,
      };

      logScanEvent(request.log, "request_completed", traceId, {
        duration_ms: Date.now() - startedAt,
        invoice_number: normalized.invoice_number,
        document_type: normalized.document_type,
        line_item_count: extractionLineItems.length,
        completeness_status: normalized.completeness_status,
        duplicate: Boolean(duplicateInvoice),
      });

      return normalized;
    } catch (err: any) {
      logScanEvent(
        request.log,
        err?.name === "AbortError" ? "ai_request_timeout" : "request_failed",
        traceId,
        {
          duration_ms: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      // AI service may be down — return file path anyway
      return {
        trace_id: traceId,
        scanned_file_path: filepath,
        ai_extracted: null,
        message: "AI service unavailable. File saved for manual entry.",
      };
    }
  });

  // POST /incoming/match-preview — run product matching as a separate post-extraction step
  app.post(
    "/match-preview",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);

      const body = z
        .object({
          supplier_name: z.string().nullish(),
          supplier_eik: z.string().nullish(),
          items: z
            .array(
              z.object({
                name: z.string().nullish(),
                name_en: z.string().nullish(),
                name_bg: z.string().nullish(),
                product_name: z.string().nullish(),
                product_name_raw: z.string().nullish(),
                product_code: z.string().nullish(),
                product_code_raw: z.string().nullish(),
                quantity: z.number().nullish(),
                unit_price: z.number().nullish(),
                price: z.number().nullish(),
              }),
            )
            .default([]),
        })
        .parse(request.body ?? {});

      if ((body.items ?? []).length === 0) {
        return reply.send({ matches: [] });
      }

      const aiUrl = process.env.AI_SERVICE_URL || "http://localhost:8000";
      try {
        const matchResp = await fetch(`${aiUrl}/ai/match-products`, {
          method: "POST",
          headers: aiAuthHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            line_items: (body.items ?? []).map((li: any) => ({
              product_name: (
                li.product_name_raw ||
                li.product_name ||
                li.name_en ||
                li.name ||
                li.name_bg ||
                ""
              ).trim(),
              product_code: li.product_code_raw || li.product_code || null,
              name_bg: li.name_bg ?? null,
              quantity: li.quantity ?? null,
              unit_price: li.unit_price ?? li.price ?? null,
            })),
            supplier_name: body.supplier_name ?? null,
            supplier_eik: body.supplier_eik ?? null,
            preview_mode: true,
          }),
        });

        if (!matchResp.ok) {
          return reply.status(502).send({
            error: "match_service_unavailable",
            matches: [],
          });
        }

        const matchData = (await matchResp.json()) as any;
        const aiMatches = Array.isArray(matchData?.matches)
          ? matchData.matches
          : [];
        const matches = (body.items ?? []).map((_, idx) => {
          const match = aiMatches[idx];
          return match && typeof match === "object"
            ? match
            : { match_source: "none", suggestions: [] };
        });
        return reply.send({ matches });
      } catch (err) {
        return reply.status(502).send({
          error: "match_service_unavailable",
          matches: [],
        });
      }
    },
  );

  // POST /incoming/train-template — proxy to ai-service confirm-invoice-template.
  // Lets the owner "teach" the AI by saving a corrected extraction as a
  // few-shot template for the given supplier. Future scans of the same
  // supplier's invoices will include this as an example.
  app.post(
    "/train-template",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);

      const body = z
        .object({
          supplier_name: z.string().min(1),
          supplier_eik: z.string().nullish(),
          image_base64: z.string().min(1),
          extracted_json: z.record(z.any()),
        })
        .parse(request.body ?? {});

      const aiUrl = process.env.AI_SERVICE_URL || "http://localhost:8000";
      try {
        const resp = await fetch(`${aiUrl}/ai/confirm-invoice-template`, {
          method: "POST",
          headers: aiAuthHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          return reply.status(502).send({
            error: "ai_service_failed",
            detail: text.slice(0, 300),
          });
        }
        const data = await resp.json();
        return reply.send(data);
      } catch (err: any) {
        return reply.status(502).send({
          error: "ai_service_unreachable",
          detail: String(err?.message ?? err).slice(0, 200),
        });
      }
    },
  );

  // PUT /incoming/:id/cancel — cancel pending incoming document (owner/admin flow)
  app.put(
    "/:id/cancel",
    { preHandler: incomingManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = cancelIncomingSchema.parse(request.body || {});

      const result = await transaction(async (client) => {
        const {
          rows: [incoming],
        } = await client.query(
          "SELECT id, status, invoice_number FROM incoming_goods WHERE id = $1 FOR UPDATE",
          [id],
        );

        if (!incoming) {
          throw Object.assign(new Error("Incoming goods not found"), {
            statusCode: 404,
          });
        }
        if (incoming.status !== "pending") {
          throw Object.assign(
            new Error(`Cannot cancel: status is ${incoming.status}`),
            { statusCode: 400 },
          );
        }

        const {
          rows: [cancelledIncoming],
        } = await client.query(
          `UPDATE incoming_goods
           SET status = 'cancelled', updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [id],
        );

        const reasonSuffix = body.reason ? ` Причина: ${body.reason}` : "";
        const invoiceSuffix = incoming.invoice_number
          ? ` (фактура ${incoming.invoice_number})`
          : "";

        await client.query(
          `INSERT INTO notifications (type, message)
           VALUES ('incoming_cancelled', $1)`,
          [`Доставка #${id}${invoiceSuffix} е отказана.${reasonSuffix}`],
        );

        return {
          message: "Доставката е отказана.",
          incoming: cancelledIncoming,
        };
      });

      return result;
    },
  );

  // PUT /incoming/:id/confirm — confirm and add to stock
  const confirmIncomingBodySchema = z
    .object({
      update_selling_price: z.boolean().optional().default(false),
    })
    .partial()
    .default({});

  app.put(
    "/:id/confirm",
    { preHandler: incomingManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const { update_selling_price: updateSellingPrice = false } =
        confirmIncomingBodySchema.parse(request.body ?? {});

      const result = await transaction(async (client) => {
        // Atomic pending → confirmed transition. Bail out cleanly if the
        // row has already been confirmed/cancelled by another request.
        const { rows: confirmedRows } = await client.query(
          `UPDATE incoming_goods
             SET status = 'confirmed', updated_at = NOW()
           WHERE id = $1 AND status = 'pending'
           RETURNING *`,
          [id],
        );

        if (confirmedRows.length === 0) {
          // Distinguish missing row from invalid status
          const {
            rows: [existing],
          } = await client.query(
            "SELECT status FROM incoming_goods WHERE id = $1",
            [id],
          );
          if (!existing) {
            throw Object.assign(new Error("Incoming goods not found"), {
              statusCode: 404,
            });
          }
          throw Object.assign(
            new Error(`Cannot confirm: status is ${existing.status}`),
            { statusCode: 400 },
          );
        }

        // Get all items
        const { rows: items } = await client.query(
          "SELECT * FROM incoming_items WHERE incoming_goods_id = $1",
          [id],
        );

        // OCR-сканирана доставка може да носи редове без свързан продукт
        // (product_id NULL). Без guard опитът за партида гърмеше с NOT
        // NULL violation → 500 без обяснение. Казваме ясно кой ред е.
        const unmatched = items.filter((item: any) => !item.product_id);
        if (unmatched.length > 0) {
          const names = unmatched
            .map(
              (item: any) =>
                item.product_name_raw || item.product_name || `ред #${item.id}`,
            )
            .join("; ");
          throw Object.assign(
            new Error(
              `Доставката има ${unmatched.length} ред(а) без свързан продукт: „${names}". Отвори доставката и свържи продукта(ите) преди потвърждение.`,
            ),
            { statusCode: 400 },
          );
        }

        // Add each item to inventory
        const defaultWarehouseId = 1; // Default warehouse
        for (const item of items) {
          // Партида + наличност + връзка на реда (споделено с добавянето
          // на ред към вече потвърдена доставка).
          await applyIncomingLineToStock(client, id, item, defaultWarehouseId);

          // Update product's purchase_price to the latest unit_price
          if (item.unit_price && item.unit_price > 0) {
            await client.query(
              "UPDATE products SET purchase_price = $1, updated_at = NOW() WHERE id = $2",
              [item.unit_price, item.product_id],
            );
          }

          if (
            updateSellingPrice &&
            item.selling_price &&
            item.selling_price > 0
          ) {
            await client.query(
              "UPDATE products SET selling_price = $1, updated_at = NOW() WHERE id = $2 AND selling_price IS DISTINCT FROM $1",
              [item.selling_price, item.product_id],
            );
          }

          // Batch F1: notify any open orders waiting on this product.
          // We fire one notification per matching order_items row so the
          // bell badge / future toast logic can click straight into the
          // right line. cancelled orders are excluded; everything else
          // (including invoiced orders with paid_not_taken lines waiting
          // for handover) qualifies.
          const { rows: pendingLines } = await client.query(
            `SELECT oi.id          AS item_id,
                    oi.order_id,
                    oi.product_id,
                    oi.quantity,
                    oi.line_status,
                    oi.name_bg_snapshot AS product_name,
                    p.name              AS partner_name
               FROM order_items oi
               JOIN orders o   ON o.id = oi.order_id
               JOIN partners p ON p.id = o.partner_id
              WHERE oi.product_id = $1
                AND oi.line_status IN ('paid_not_taken', 'awaiting')
                AND o.status NOT IN ('cancelled')`,
            [item.product_id],
          );

          for (const pending of pendingLines) {
            await client.query(
              `INSERT INTO notifications (type, message, payload)
               VALUES ('pending_order_ready', $1, $2)`,
              [
                `Поръчка #${pending.order_id} (${pending.partner_name}) — ${pending.product_name} вече е наличен`,
                JSON.stringify({
                  order_id: pending.order_id,
                  order_item_id: pending.item_id,
                  product_id: pending.product_id,
                  qty_pending: pending.quantity,
                  line_status: pending.line_status,
                  partner_name: pending.partner_name,
                }),
              ],
            );
          }
        }

        // Create notification
        await client.query(
          `INSERT INTO notifications (type, message)
         VALUES ('stock_in', $1)`,
          [
            `Incoming goods #${id} confirmed. ${items.length} items added to stock.`,
          ],
        );

        return {
          message: "Stock confirmed and added to inventory",
          items_count: items.length,
        };
      });

      return result;
    },
  );

  // ════════════════════════════════════════════════════════════════════
  // POST /incoming/:id/credit-note — Кредитно известие ОТ доставчика
  // ════════════════════════════════════════════════════════════════════
  // Доставчикът е сгрешил цената по фактурата (или приема връщане на
  // стока) и издава КИ. Завеждаме го като ОТДЕЛЕН входящ документ
  // (document_type='credit_note', мигр. 103) със собствен номер и дата,
  // вързан към оригиналната доставка, с ОТРИЦАТЕЛНА стойност.
  //
  // Оригиналната доставка НЕ се пипа — тя остава каквато доставчикът я е
  // издал; корекцията живее в КИ-то. Така документалната следа е пълна:
  // фактурата и известието стоят едно до друго.
  //
  // Ефект върху склада:
  //   • ценова корекция (new_unit_price) → партидата и продуктът получават
  //     новата покупна цена; количествата НЕ се пипат
  //   • върната стока (returned_quantity) → количеството слиза от
  //     партидата и наличността; цената не се пипа
  //
  // Дължимото към доставчиците и дневните покупки се смятат като сума по
  // incoming_goods.total_amount → отрицателният документ ги намалява сам.
  const creditNoteSchema = z.object({
    credit_note_number: z.string().trim().min(1).max(100),
    credit_note_date: z.string().trim().optional(),
    reason: z.string().trim().max(500).optional(),
    items: z
      .array(
        z.object({
          incoming_item_id: z.number().int().positive(),
          // Ценова корекция: новата (по-ниска) цена по този ред.
          new_unit_price: z.number().min(0).optional(),
          // Връщане на стока: колко от реда се връща на доставчика.
          returned_quantity: z.number().positive().optional(),
        }),
      )
      .min(1),
  });

  app.post(
    "/:id/credit-note",
    { preHandler: incomingManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = creditNoteSchema.parse(request.body);
      const round2 = (n: number) => Math.round(n * 100) / 100;
      const round3 = (n: number) => Math.round(n * 1000) / 1000;

      return await transaction(async (client) => {
        const {
          rows: [original],
        } = await client.query(
          "SELECT * FROM incoming_goods WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (!original) {
          return reply.status(404).send({ error: "Not found" });
        }
        if (original.document_type === "credit_note") {
          throw Object.assign(
            new Error("Не може да се издаде КИ върху друго кредитно известие."),
            { statusCode: 400 },
          );
        }
        if (original.status !== "confirmed") {
          throw Object.assign(
            new Error(
              "Кредитно известие се завежда само за потвърдена доставка. Ако доставката още е чакаща, просто коригирай цената в нея.",
            ),
            { statusCode: 400 },
          );
        }

        // Един и същ номер на КИ от същия доставчик не се завежда два пъти.
        const { rows: dup } = await client.query(
          `SELECT id, invoice_number FROM incoming_goods
            WHERE document_type = 'credit_note'
              AND supplier_id IS NOT DISTINCT FROM $1
              AND UPPER(TRIM(COALESCE(invoice_number, ''))) = UPPER(TRIM($2))
            LIMIT 1`,
          [original.supplier_id, body.credit_note_number],
        );
        if (dup[0]) {
          throw Object.assign(
            new Error(
              `Кредитно известие с номер "${body.credit_note_number}" вече е заведено за този доставчик.`,
            ),
            { statusCode: 409 },
          );
        }

        const { rows: originalItems } = await client.query(
          `SELECT id, product_id, batch_id, quantity, unit_price
             FROM incoming_items
            WHERE incoming_goods_id = $1 AND id = ANY($2)
            FOR UPDATE`,
          [id, body.items.map((i) => i.incoming_item_id)],
        );
        const itemMap = new Map<number, any>(
          originalItems.map((row: any) => [row.id, row]),
        );

        // Първо смятаме всичко (за да знаем сумата преди INSERT-а на
        // header-а), после записваме.
        // incoming_items пази ПОЛОЖИТЕЛНИ количество и единична цена
        // (chk_incoming_items_qty_pos / _price_nonneg). Кредитът се
        // изразява в total_price (отрицателен) и в сумата на документа —
        // затова редът носи и отделна складова делта.
        type CreditLine = {
          kind: "price" | "return";
          orig: any;
          quantity: number; // > 0 — какво се кредитира
          unitPrice: number; // >= 0 — при ценова корекция това е РАЗЛИКАТА
          lineTotal: number; // отрицателен
          stockDelta: number; // < 0 при връщане на стока, иначе 0
          newPrice?: number;
        };
        const lines: CreditLine[] = [];
        let creditTotal = 0;

        for (const item of body.items) {
          const orig = itemMap.get(item.incoming_item_id);
          if (!orig) {
            throw Object.assign(
              new Error(
                `Ред #${item.incoming_item_id} не е част от тази доставка.`,
              ),
              { statusCode: 400 },
            );
          }
          const origQty = Number(orig.quantity);
          const origPrice = Number(orig.unit_price);

          if (item.new_unit_price !== undefined) {
            if (item.new_unit_price > origPrice) {
              throw Object.assign(
                new Error(
                  "Кредитното известие намалява стойността — новата цена трябва да е по-ниска от фактурираната.",
                ),
                { statusCode: 400 },
              );
            }
            const delta = round3(origPrice - item.new_unit_price);
            const amount = round2(delta * origQty);
            creditTotal += amount;
            lines.push({
              kind: "price",
              orig,
              quantity: origQty,
              unitPrice: delta,
              lineTotal: -amount,
              stockDelta: 0,
              newPrice: item.new_unit_price,
            });
          } else if (item.returned_quantity !== undefined) {
            if (item.returned_quantity > origQty) {
              throw Object.assign(
                new Error(
                  `Връщаното количество (${item.returned_quantity}) надвишава доставеното (${origQty}).`,
                ),
                { statusCode: 400 },
              );
            }
            const amount = round2(origPrice * item.returned_quantity);
            creditTotal += amount;
            lines.push({
              kind: "return",
              orig,
              quantity: item.returned_quantity,
              unitPrice: origPrice,
              lineTotal: -amount,
              stockDelta: -item.returned_quantity,
            });
          } else {
            throw Object.assign(
              new Error(
                "Всеки ред трябва да носи корекция: нова цена или върнато количество.",
              ),
              { statusCode: 400 },
            );
          }
        }

        const totalAmount = -round2(creditTotal);

        const {
          rows: [creditNote],
        } = await client.query(
          `INSERT INTO incoming_goods
             (supplier_id, invoice_number, invoice_date, related_incoming_id,
              total_amount, credit_note_reason, document_type, status)
           VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5, $6,
                   'credit_note', 'confirmed')
           RETURNING *`,
          [
            original.supplier_id,
            body.credit_note_number,
            body.credit_note_date ?? null,
            Number(id),
            totalAmount,
            body.reason ?? null,
          ],
        );

        for (const line of lines) {
          await client.query(
            `INSERT INTO incoming_items
               (incoming_goods_id, product_id, quantity, unit_price,
                total_price, batch_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [
              creditNote.id,
              line.orig.product_id,
              line.quantity,
              line.unitPrice,
              line.lineTotal,
              line.orig.batch_id ?? null,
            ],
          );

          if (line.kind === "price") {
            // Складовата стойност следва коригираната цена.
            if (line.orig.batch_id) {
              await client.query(
                `UPDATE batches SET purchase_price = $1, updated_at = NOW() WHERE id = $2`,
                [line.newPrice, line.orig.batch_id],
              );
            }
            await client.query(
              "UPDATE products SET purchase_price = $1, updated_at = NOW() WHERE id = $2",
              [line.newPrice, line.orig.product_id],
            );
          } else if (line.orig.batch_id && line.stockDelta !== 0) {
            // Върнатата стока излиза от склада.
            await adjustBatchStock(
              client,
              line.orig.product_id,
              line.orig.batch_id,
              line.stockDelta,
            );
          }
        }

        return reply.status(201).send({
          ...creditNote,
          total_amount: totalAmount,
          items_count: lines.length,
        });
      });
    },
  );

  // MERT-M: PATCH /incoming/:id/batches removed — no batch/expiry
  // tracking for durable goods. Any frontend that still calls this
  // endpoint gets a 404, which matches the (now intentional) absence
  // of the feature.

  // PATCH /incoming/:id — update header (invoice_number, invoice_date,
  // supplier_id). Разрешено за чакащи И потвърдени доставки — header
  // полетата не пипат склад/партиди, така че корекция след потвърждение
  // е безопасна.
  app.patch(
    "/:id",
    { preHandler: incomingManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        supplier_id: z.number().int().nullable().optional(),
        invoice_number: z.string().nullable().optional(),
        invoice_date: z.string().nullable().optional(),
      });
      const body = schema.parse(request.body);

      return await transaction(async (client) => {
        const { rows } = await client.query(
          "SELECT id, status FROM incoming_goods WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (!rows[0]) {
          return reply.status(404).send({ error: "Not found" });
        }
        if (rows[0].status !== "pending" && rows[0].status !== "confirmed") {
          return reply.status(400).send({
            error:
              "Само чакащи или потвърдени доставки могат да се редактират.",
          });
        }

        const fields: string[] = [];
        const values: any[] = [];
        let idx = 1;
        if (body.supplier_id !== undefined) {
          fields.push(`supplier_id = $${idx++}`);
          values.push(body.supplier_id);
        }
        if (body.invoice_number !== undefined) {
          fields.push(`invoice_number = $${idx++}`);
          values.push(body.invoice_number);
        }
        if (body.invoice_date !== undefined) {
          fields.push(`invoice_date = $${idx++}`);
          values.push(body.invoice_date);
        }

        if (fields.length === 0) return { ok: true };

        fields.push(`updated_at = NOW()`);
        values.push(id);

        const { rows: updated } = await client.query(
          `UPDATE incoming_goods SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
          values,
        );
        return { ok: true, incoming: updated[0] };
      });
    },
  );

  // PATCH /incoming/:id/items — update quantity/unit_price/batch/expiry of
  // existing line items. Разрешено за чакащи И потвърдени доставки. При
  // потвърдена доставка промените се пренасят върху реалната партида и
  // наличността (количество → delta по партида+inventory; срок/номер/цена →
  // върху партидата), така че складът остава верен след корекция.
  app.patch(
    "/:id/items",
    { preHandler: incomingManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      // Партида/срок се редактират на входящия ред (огледало на create
      // пътя). При pending реалната наличност по партида се създава при
      // confirm; при confirmed я коригираме тук.
      const schema = z.object({
        items: z.array(
          z.object({
            id: z.number().int(),
            // Смяна на продукта на реда — при потвърдена доставка старата
            // партида се връща и се създава нова за новия продукт.
            product_id: z.number().int().positive().optional(),
            quantity: z.number().positive().optional(),
            unit_price: z.number().min(0).optional(),
            batch_number: z.string().trim().max(100).optional().nullable(),
            expiry_date: z.string().trim().optional().nullable(),
          }),
        ),
      });
      const body = schema.parse(request.body);

      return await transaction(async (client) => {
        const { rows: docRows } = await client.query(
          "SELECT id, status FROM incoming_goods WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (!docRows[0]) {
          return reply.status(404).send({ error: "Not found" });
        }
        if (
          docRows[0].status !== "pending" &&
          docRows[0].status !== "confirmed"
        ) {
          return reply.status(400).send({
            error:
              "Само чакащи или потвърдени доставки могат да се редактират.",
          });
        }
        const isConfirmed = docRows[0].status === "confirmed";

        for (const item of body.items) {
          // Текущият ред — нужен за delta по количеството и връзката към
          // партидата (batch_id, попълнен при confirm).
          const {
            rows: [current],
          } = await client.query(
            `SELECT id, product_id, batch_id, quantity, unit_price
               FROM incoming_items
              WHERE incoming_goods_id = $1 AND id = $2
              FOR UPDATE`,
            [id, item.id],
          );
          if (!current) continue;

          const wantsProductChange =
            item.product_id !== undefined &&
            item.product_id !== current.product_id;
          if (wantsProductChange) {
            const { rows: prodRows } = await client.query(
              "SELECT id FROM products WHERE id = $1",
              [item.product_id],
            );
            if (!prodRows[0]) {
              throw Object.assign(new Error("Продуктът не е намерен"), {
                statusCode: 404,
              });
            }
            // При потвърдена доставка: първо връщаме ЦЕЛИЯ принос на реда
            // от старата партида (старото количество). Новите стойности се
            // прилагат наведнъж след UPDATE-а чрез applyIncomingLineToStock.
            if (isConfirmed && current.batch_id) {
              await adjustBatchStock(
                client,
                current.product_id,
                current.batch_id,
                -Number(current.quantity),
              );
            }
          }

          // Полевата пропагация важи само когато редът си остава на същия
          // продукт — при смяна всичко се пренася от reapply-а по-долу.
          if (isConfirmed && current.batch_id && !wantsProductChange) {
            // 1) Количество → delta върху партидата + наличността.
            if (item.quantity !== undefined) {
              const delta = item.quantity - Number(current.quantity);
              await adjustBatchStock(
                client,
                current.product_id,
                current.batch_id,
                delta,
              );
            }
            // 2) Срок на годност → директно върху партидата.
            if (item.expiry_date !== undefined) {
              await client.query(
                `UPDATE batches SET expiry_date = $1, updated_at = NOW() WHERE id = $2`,
                [normalizeExpiryInput(item.expiry_date), current.batch_id],
              );
            }
            // 3) Номер на партида → преименуване (с проверка за колизия по
            //    ux_batches_product_number, за да върнем чисто 409 вместо 500).
            if (item.batch_number !== undefined) {
              const newNumber =
                (item.batch_number ?? "").trim() || `АВТО-${id}-${item.id}`;
              const { rows: clash } = await client.query(
                `SELECT id FROM batches
                  WHERE product_id = $1 AND batch_number = $2 AND id <> $3
                  LIMIT 1`,
                [current.product_id, newNumber, current.batch_id],
              );
              if (clash.length) {
                throw Object.assign(
                  new Error(
                    `Партида с номер "${newNumber}" вече съществува за този продукт.`,
                  ),
                  { statusCode: 409 },
                );
              }
              await client.query(
                `UPDATE batches SET batch_number = $1, updated_at = NOW() WHERE id = $2`,
                [newNumber, current.batch_id],
              );
            }
            // 4) Покупна цена → партидата (COGS) + продукта (както confirm).
            if (item.unit_price !== undefined) {
              await client.query(
                `UPDATE batches SET purchase_price = $1, updated_at = NOW() WHERE id = $2`,
                [item.unit_price, current.batch_id],
              );
              if (item.unit_price > 0) {
                await client.query(
                  "UPDATE products SET purchase_price = $1, updated_at = NOW() WHERE id = $2",
                  [item.unit_price, current.product_id],
                );
              }
            }
          }

          const updates: string[] = [];
          const vals: any[] = [];
          let idx = 1;
          if (wantsProductChange) {
            updates.push(`product_id = $${idx++}`);
            vals.push(item.product_id);
          }
          if (item.quantity !== undefined) {
            updates.push(`quantity = $${idx++}`);
            vals.push(item.quantity);
          }
          if (item.unit_price !== undefined) {
            updates.push(`unit_price = $${idx++}`);
            vals.push(item.unit_price);
          }
          if (item.batch_number !== undefined) {
            updates.push(`batch_number = $${idx++}`);
            vals.push(item.batch_number);
          }
          if (item.expiry_date !== undefined) {
            updates.push(`expiry_date = $${idx++}`);
            vals.push(normalizeExpiryInput(item.expiry_date));
          }
          if (updates.length > 0) {
            // total_price следва количество/цена (новите стойности, при
            // частична редакция — допълнени от текущия ред).
            if (item.quantity !== undefined || item.unit_price !== undefined) {
              const newQty = item.quantity ?? Number(current.quantity);
              const newPrice = item.unit_price ?? Number(current.unit_price);
              updates.push(`total_price = $${idx++}`);
              vals.push(Number((newQty * newPrice).toFixed(2)));
            }
            vals.push(id, item.id);
            await client.query(
              `UPDATE incoming_items SET ${updates.join(", ")} WHERE incoming_goods_id = $${idx++} AND id = $${idx}`,
              vals,
            );
          }

          // Смяна на продукт при потвърдена доставка: редът (с новите си
          // стойности) влиза в склада наново — нова/намерена партида за
          // НОВИЯ продукт + наличност + връзка. Старата партида вече е
          // върната по-горе.
          if (isConfirmed && wantsProductChange) {
            const {
              rows: [fresh],
            } = await client.query(
              `SELECT id, product_id, quantity, unit_price, batch_number, expiry_date
                 FROM incoming_items
                WHERE incoming_goods_id = $1 AND id = $2`,
              [id, item.id],
            );
            if (fresh) {
              await applyIncomingLineToStock(client, id, fresh);
              if (fresh.unit_price && Number(fresh.unit_price) > 0) {
                await client.query(
                  "UPDATE products SET purchase_price = $1, updated_at = NOW() WHERE id = $2",
                  [fresh.unit_price, fresh.product_id],
                );
              }
            }
          }
        }

        // Header сумата следва редовете.
        await refreshIncomingTotalAmount(client, id);

        return { ok: true };
      });
    },
  );

  // POST /incoming/:id/items — add a NEW line item. Разрешено за чакащи И
  // потвърдени доставки. При потвърдена доставка редът влиза в склада
  // веднага (партида + наличност), както би станало при confirm.
  app.post(
    "/:id/items",
    { preHandler: incomingManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        product_id: z.number().int().positive(),
        quantity: z.number().positive(),
        unit_price: z.number().min(0).default(0),
        selling_price: z.number().min(0).optional().nullable(),
        batch_number: z.string().trim().max(100).optional().nullable(),
        expiry_date: z.string().trim().optional().nullable(),
      });
      const body = schema.parse(request.body);

      return await transaction(async (client) => {
        const { rows: docRows } = await client.query(
          "SELECT id, status FROM incoming_goods WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (!docRows[0]) {
          return reply.status(404).send({ error: "Not found" });
        }
        if (
          docRows[0].status !== "pending" &&
          docRows[0].status !== "confirmed"
        ) {
          return reply.status(400).send({
            error:
              "Само чакащи или потвърдени доставки могат да се редактират.",
          });
        }
        const prod = await client.query(
          "SELECT id FROM products WHERE id = $1",
          [body.product_id],
        );
        if (!prod.rows[0]) {
          return reply.status(404).send({ error: "Продуктът не е намерен" });
        }

        const totalPrice = Number((body.quantity * body.unit_price).toFixed(2));
        const { rows } = await client.query(
          `INSERT INTO incoming_items (
             incoming_goods_id, product_id, quantity, unit_price, total_price,
             selling_price, batch_number, expiry_date
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [
            id,
            body.product_id,
            body.quantity,
            body.unit_price,
            totalPrice,
            body.selling_price ?? null,
            (body.batch_number ?? "").trim() || null,
            normalizeExpiryInput(body.expiry_date),
          ],
        );

        // При потвърдена доставка новият ред влиза в склада веднага
        // (същата логика като confirm за един ред).
        if (docRows[0].status === "confirmed") {
          const batchId = await applyIncomingLineToStock(client, id, rows[0]);
          rows[0].batch_id = batchId;
          if (body.unit_price > 0) {
            await client.query(
              "UPDATE products SET purchase_price = $1, updated_at = NOW() WHERE id = $2",
              [body.unit_price, body.product_id],
            );
          }
        }

        // Header сумата следва редовете.
        await refreshIncomingTotalAmount(client, id);

        return reply.status(201).send({ ok: true, item: rows[0] });
      });
    },
  );

  // DELETE /incoming/:id/items/:itemId — delete a line from pending delivery
  app.delete(
    "/:id/items/:itemId",
    { preHandler: incomingManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, itemId } = request.params as { id: string; itemId: string };

      return await transaction(async (client) => {
        const { rows } = await client.query(
          "SELECT id, status FROM incoming_goods WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (!rows[0]) {
          return reply.status(404).send({ error: "Not found" });
        }
        if (rows[0].status !== "pending" && rows[0].status !== "confirmed") {
          return reply.status(400).send({
            error:
              "Само чакащи или потвърдени доставки могат да се редактират.",
          });
        }

        // При потвърдена доставка редът вече е в склада — триенето първо
        // сваля количеството от партидата + наличността.
        if (rows[0].status === "confirmed") {
          const {
            rows: [line],
          } = await client.query(
            `SELECT id, product_id, batch_id, quantity
               FROM incoming_items
              WHERE incoming_goods_id = $1 AND id = $2
              FOR UPDATE`,
            [id, itemId],
          );
          if (!line) {
            return reply.status(404).send({ error: "Item not found" });
          }
          if (line.batch_id) {
            await adjustBatchStock(
              client,
              line.product_id,
              line.batch_id,
              -Number(line.quantity),
            );
          }
        }

        const { rowCount } = await client.query(
          "DELETE FROM incoming_items WHERE incoming_goods_id = $1 AND id = $2",
          [id, itemId],
        );
        if (rowCount === 0) {
          return reply.status(404).send({ error: "Item not found" });
        }

        // Header сумата следва редовете.
        await refreshIncomingTotalAmount(client, id);

        return { ok: true };
      });
    },
  );

  // GET /incoming/:id/receipt — Generate stock receipt PDF (warehouse + admin)
  app.get(
    "/:id/receipt",
    { preHandler: incomingManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      // Fetch incoming goods
      const { rows: incomingRows } = await query(
        `SELECT ig.*,
                s.name AS supplier_name,
                s.eik AS supplier_eik,
                s.vat_number AS supplier_vat,
                s.address AS supplier_address,
                s.city AS supplier_city,
                s.phone AS supplier_phone,
                s.email AS supplier_email,
                s.contact_person AS supplier_contact
       FROM incoming_goods ig
       LEFT JOIN suppliers s ON s.id = ig.supplier_id
       WHERE ig.id = $1`,
        [id],
      );

      if (incomingRows.length === 0) {
        return reply.status(404).send({ error: "Incoming goods not found" });
      }

      const incoming = incomingRows[0];
      if (incoming.status !== "confirmed") {
        return reply.status(409).send({
          error: "Stock receipt is available only for confirmed deliveries",
        });
      }

      // Fetch incoming items with product names
      const { rows: items } = await query(
        `SELECT ii.quantity, ii.unit_price, ii.total_price,
                p.sku, p.name_bg, p.name_en, p.unit
       FROM incoming_items ii
       JOIN products p ON p.id = ii.product_id
       WHERE ii.incoming_goods_id = $1
       ORDER BY ii.id ASC`,
        [id],
      );

      // Fetch company settings
      const { rows: settingsRows } = await query(
        "SELECT * FROM settings WHERE id = 1",
      );
      const settings = settingsRows.length > 0 ? settingsRows[0] : {};

      const { rows: warehouseRows } = await query(
        "SELECT name, address FROM warehouses WHERE id = 1 LIMIT 1",
      );
      const warehouse = warehouseRows[0];
      const warehouseName = warehouse
        ? [warehouse.name, warehouse.address].filter(Boolean).join(", ")
        : "Основен склад";

      // Кредитното известие се печата със СВОЯ номер (този на
      // доставчика), а основанието сочи фактурата, която коригира.
      const isCreditNote = incoming.document_type === "credit_note";
      let creditNoteReference: string | null = null;
      if (isCreditNote && incoming.related_incoming_id) {
        const { rows: relatedRows } = await query(
          "SELECT invoice_number FROM incoming_goods WHERE id = $1",
          [incoming.related_incoming_id],
        );
        creditNoteReference = relatedRows[0]?.invoice_number ?? null;
      }
      const docNumber = isCreditNote
        ? incoming.invoice_number ||
          `КИ-${String(incoming.id).padStart(7, "0")}`
        : `СР-${String(incoming.id).padStart(7, "0")}`;
      const pdfDir = path.resolve(process.cwd(), "data", "documents");
      if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
      const outputPath = path.join(
        pdfDir,
        `incoming-stock-receipt-${incoming.id}.pdf`,
      );

      await generateIncomingStockReceiptPdf({
        doc_number: docNumber,
        doc_date: String(incoming.invoice_date || incoming.created_at),
        reference_number: isCreditNote
          ? creditNoteReference
          : incoming.invoice_number || null,
        document_kind: isCreditNote ? "credit_note" : "delivery",
        reason: isCreditNote ? (incoming.credit_note_reason ?? null) : null,
        buyer: {
          name: settings.company_name || "BAKALIA GREEK DELI FOOD",
          eik: settings.eik || undefined,
          vat_number: settings.vat_number || undefined,
          address: settings.address || undefined,
          city: settings.city || undefined,
          phone: settings.phone || undefined,
          email: settings.email || undefined,
          mol: settings.mol || undefined,
        },
        supplier: {
          name: incoming.supplier_name || "Доставчик",
          eik: incoming.supplier_eik || undefined,
          vat_number: incoming.supplier_vat || undefined,
          address: incoming.supplier_address || undefined,
          city: incoming.supplier_city || undefined,
          phone: incoming.supplier_phone || undefined,
          email: incoming.supplier_email || undefined,
          mol: incoming.supplier_contact || undefined,
        },
        warehouse_name: warehouseName,
        items: items.map((item: any) => ({
          sku: item.sku || "",
          name_bg: item.name_bg || undefined,
          name_en: item.name_en || undefined,
          unit: item.unit || undefined,
          quantity: Number(item.quantity) || 0,
          unit_price: Number(item.unit_price) || 0,
          total_price: Number(item.total_price) || 0,
          currency: "EUR",
        })),
        outputPath,
      });

      const stream = fs.createReadStream(outputPath);
      const filename = isCreditNote
        ? `Кредитно_известие_${docNumber}.pdf`
        : `Стокова_разписка_${docNumber}.pdf`;
      const encodedFilename = encodeURIComponent(filename);

      return reply
        .header("Content-Type", "application/pdf")
        .header(
          "Content-Disposition",
          `inline; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`,
        )
        .send(stream);
    },
  );
}
