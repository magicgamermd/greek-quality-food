import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { type PoolClient } from "pg";
import { z } from "zod";
import { query, transaction } from "../db.js";
import {
  requirePermission,
  hasPermission,
  PERMISSIONS,
} from "../lib/permissions.js";
import { restoreOrderItemsToInventory } from "../utils/order-stock.js";
import {
  allocateFefo,
  InsufficientStockError,
} from "../services/fefo-allocator.js";
import { orderLineStatusSchema } from "../lib/order-line-status.js";
import {
  computeBelowCostItems,
  type ProductCost,
} from "../utils/below-cost.js";
import {
  generateStockDispatchPdf,
  generateCommercialDocPdf,
} from "../services/document-pdf.js";
import { renderReplacementPdf } from "../services/razpiska-replacement-pdf.js";
import { generateInvoicePdf } from "../services/invoice-pdf.js";
import { generateWarrantyCardPdf } from "../services/warranty-pdf.js";
import { generateOfferPdf } from "../services/offer-pdf.js";
import { generateProtocolPdf } from "../services/protocol-pdf.js";
import { generatePackingLabelPdf } from "../services/packing-label-pdf.js";
import { isRazpiskaEligible } from "../constants/partners.js";
import fs from "node:fs";
import path from "node:path";

const STOCK_COMMITTED_STATUSES = new Set(["fulfilled", "invoiced"]);
const EPSILON = 0.001;

type DbExecutor = {
  query: (
    text: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

// Latin-to-Cyrillic transliteration for search
const latinToCyrillic: Record<string, string> = {
  a: "а",
  b: "б",
  v: "в",
  g: "г",
  d: "д",
  e: "е",
  zh: "ж",
  z: "з",
  i: "и",
  y: "й",
  k: "к",
  l: "л",
  m: "м",
  n: "н",
  o: "о",
  p: "п",
  r: "р",
  s: "с",
  t: "т",
  u: "у",
  f: "ф",
  h: "х",
  ts: "ц",
  ch: "ч",
  sh: "ш",
  sht: "щ",
  yu: "ю",
  ya: "я",
};
function transliterate(text: string): string {
  let result = "";
  const lower = text.toLowerCase();
  let i = 0;
  while (i < lower.length) {
    if (i + 3 <= lower.length && latinToCyrillic[lower.slice(i, i + 3)]) {
      result += latinToCyrillic[lower.slice(i, i + 3)];
      i += 3;
    } else if (
      i + 2 <= lower.length &&
      latinToCyrillic[lower.slice(i, i + 2)]
    ) {
      result += latinToCyrillic[lower.slice(i, i + 2)];
      i += 2;
    } else if (latinToCyrillic[lower[i]]) {
      result += latinToCyrillic[lower[i]];
      i++;
    } else {
      result += lower[i];
      i++;
    }
  }
  return result;
}
function isLatin(text: string): boolean {
  return /[a-zA-Z]/.test(text);
}

// GQF продава нетрайни хранителни стоки → всяка наличност е по партида с
// срок на годност. Изписването при експедиране е FEFO (First-Expired-First-
// Out) през allocateFefo(): изтеклите партиди се блокират, COGS се снема от
// реалната партида и се записва в order_item_batches. Касиерът може по
// изключение да подаде конкретна партида на реда чрез optional `batch_id`
// (ползва се вместо FEFO, но пак се проверява за изтекъл срок и наличност).
const orderItemSchema = z.object({
  product_id: z.number().int(),
  quantity: z.number().positive(),
  unit_price: z.number().min(0).optional(),
  // По избор — ръчно подадена партида за този ред (вместо автоматично FEFO).
  batch_id: z.number().int().positive().optional(),
  // Per-line отстъпка % (0–100). Прилага се при запис на total_price.
  // Default 0 → backward-compatible за стари callers които не подават.
  discount_percent: z.number().min(0).max(100).optional().default(0),
  // Batch F1: per-line state. Optional; defaults to 'normal' on the
  // backend side via orderLineStatusSchema's .default.
  line_status: orderLineStatusSchema.optional(),
  // Замяна (product exchange) — when true, this line is being RETURNED
  // by the customer in a replacement order. Only valid when the parent
  // order has is_replacement=true. Sign-flips the contribution to
  // total_amount and (later) the stock movement direction.
  is_returning: z.boolean().optional().default(false),
});

const createOrderSchema = z.object({
  partner_id: z.number().int(),
  delivery_date: z.string().nullish(),
  notes: z.string().nullish(),
  source: z.enum(["manual", "comarch", "web"]).default("manual"),
  request_number: z.string().nullish(),
  partner_object_id: z.number().int().positive().nullish(),
  object_name: z.string().nullish(),
  object_code: z.string().nullish(),
  econt_receiver_name: z.string().trim().max(255).optional(),
  econt_receiver_phone: z.string().trim().max(50).optional(),
  econt_delivery_type: z.enum(["office", "address"]).optional(),
  econt_city: z.string().trim().max(255).optional(),
  econt_office_code: z.string().trim().max(50).optional(),
  econt_office_name: z.string().trim().max(500).optional(),
  econt_street: z.string().trim().max(255).optional(),
  econt_street_num: z.string().trim().max(20).optional(),
  econt_cod_amount: z.coerce.number().nonnegative().optional(),
  econt_weight: z.coerce.number().positive().optional(),
  econt_shipping_cost: z.coerce.number().nonnegative().optional(),
  econt_payer: z.enum(["sender", "receiver"]).optional(),
  econt_shipment_description: z.string().trim().max(500).optional(),
  econt_shipment_date: z.string().trim().optional(),
  // Флаг "за Еконт доставка" — касиерски чекбокс. true → econt_requested_at
  // = NOW() (поръчката влиза в опашката на Еконт работника). Огледало на
  // dispatched_to_warehouse_at, но toggled от булева стойност на формата.
  econt_requested: z.boolean().optional(),
  items: z.array(orderItemSchema).min(1),
  // Admin-only override: explicit acknowledgement that one or more lines
  // are priced below products.purchase_price. Backend re-validates and
  // hard-rejects when this flag is omitted but lines are below cost.
  allow_below_cost: z.boolean().optional().default(false),
  // Initial status — only "pending" (default) or "quoted" allowed at create
  // time. Quoted orders skip stock validation and never deduct inventory
  // until they're moved to pending → confirmed.
  status: z.enum(["pending", "quoted"]).optional().default("pending"),
  // Замяна (product exchange) — when true, the order must contain at
  // least one give line (is_returning=false) AND one return line
  // (is_returning=true), and the partner must be razpiska-eligible
  // (no VAT). See spec section 4.1.
  is_replacement: z.boolean().optional().default(false),
  // Payment method for the difference on a replacement order.
  // Drives the auto-inserted payments row (see Task 7). The codebase
  // uses "bank" (not "bank_transfer") consistently — see
  // lib/invoice-payment-method.ts.
  payment_method: z.enum(["cash", "pos", "bank"]).optional(),
});

const updateStatusSchema = z.object({
  status: z.enum([
    "pending",
    "confirmed",
    "processing",
    "fulfilled",
    "invoiced",
    "cancelled",
  ]),
});

const updateOrderSchema = z.object({
  delivery_date: z.string().nullish(),
  notes: z.string().nullish(),
  request_number: z.string().nullish(),
  partner_object_id: z.number().int().positive().nullish(),
  object_name: z.string().nullish(),
  object_code: z.string().nullish(),

  econt_receiver_name: z.string().trim().max(255).nullish(),
  econt_receiver_phone: z.string().trim().max(50).nullish(),
  econt_delivery_type: z.enum(["office", "address"]).nullish(),
  econt_city: z.string().trim().max(255).nullish(),
  econt_office_code: z.string().trim().max(50).nullish(),
  econt_office_name: z.string().trim().max(500).nullish(),
  econt_street: z.string().trim().max(255).nullish(),
  econt_street_num: z.string().trim().max(50).nullish(),
  econt_cod_amount: z.coerce.number().nonnegative().nullish(),
  econt_weight: z.coerce.number().positive().nullish(),
  econt_payer: z.enum(["sender", "receiver"]).nullish(),
  econt_shipment_description: z.string().trim().max(500).nullish(),
  econt_shipment_date: z.string().trim().nullish(),
  // Флаг "за Еконт доставка" — касиерски toggle. true → econt_requested_at
  // = NOW() (влиза в опашката на Еконт работника), false → clear (пада от
  // опашката). Огледало на dispatched_to_warehouse_at.
  econt_requested: z.boolean().nullish(),

  items: z.array(orderItemSchema).min(1).optional(),
  allow_below_cost: z.boolean().optional().default(false),
});

const STOCK_DISPATCH_NUMBER_SQL = `('SR-' || LPAD(COALESCE(o.order_number, o.id)::text, 7, '0'))`;
const COMMERCIAL_DOC_NUMBER_SQL = `('TD-' || LPAD(COALESCE(o.order_number, o.id)::text, 7, '0'))`;
// Only emit a warranty number when one was actually issued. Until the
// user downloads the warranty PDF, warranty_issued_at is NULL and the
// column reads NULL so the UI can render "—".
const WARRANTY_NUMBER_SQL = `CASE WHEN o.warranty_issued_at IS NOT NULL
  THEN ('WR-' || LPAD(COALESCE(o.order_number, o.id)::text, 7, '0'))
  ELSE NULL END`;
const ORDER_OBJECT_NAME_SQL = `COALESCE(NULLIF(o.object_name, ''), po.object_name)`;
const ORDER_OBJECT_CODE_SQL = `NULLIF(COALESCE(NULLIF(o.object_code, ''), po.object_code, ''), '')`;

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function parseOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.length > 0 ? parseOptionalBoolean(value[0]) : null;
  }
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

type OrderObjectSelection = {
  partnerObjectId: number | null;
  objectName: string | null;
  objectCode: string | null;
};

async function resolveOrderObjectSelection(
  client: PoolClient,
  input: {
    partnerId: number;
    partnerObjectId?: number | null;
    objectName?: unknown;
    objectCode?: unknown;
  },
): Promise<OrderObjectSelection> {
  const normalizedName = normalizeOptionalText(input.objectName);
  const normalizedCode = normalizeOptionalText(input.objectCode);
  const normalizedCodeForStore = normalizedCode ?? "";

  if (input.partnerObjectId) {
    const {
      rows: [existing],
    } = await client.query(
      `SELECT id, object_name, object_code
       FROM partner_order_objects
       WHERE id = $1 AND partner_id = $2`,
      [input.partnerObjectId, input.partnerId],
    );

    if (!existing) {
      throw Object.assign(new Error("Selected object/store not found"), {
        statusCode: 400,
      });
    }

    return {
      partnerObjectId: existing.id,
      objectName: normalizeOptionalText(existing.object_name),
      objectCode: normalizeOptionalText(existing.object_code),
    };
  }

  if (!normalizedName && !normalizedCode) {
    return { partnerObjectId: null, objectName: null, objectCode: null };
  }

  if (!normalizedName) {
    throw Object.assign(new Error("Object/store name is required"), {
      statusCode: 400,
    });
  }

  const {
    rows: [existingByIdentity],
  } = await client.query(
    `SELECT id, object_name, object_code
     FROM partner_order_objects
     WHERE partner_id = $1
       AND LOWER(BTRIM(object_name)) = LOWER(BTRIM($2))
       AND LOWER(BTRIM(object_code)) = LOWER(BTRIM($3))
     LIMIT 1`,
    [input.partnerId, normalizedName, normalizedCodeForStore],
  );

  if (existingByIdentity) {
    return {
      partnerObjectId: existingByIdentity.id,
      objectName: normalizeOptionalText(existingByIdentity.object_name),
      objectCode: normalizeOptionalText(existingByIdentity.object_code),
    };
  }

  const {
    rows: [created],
  } = await client.query(
    `INSERT INTO partner_order_objects (partner_id, object_name, object_code)
     VALUES ($1, $2, $3)
     RETURNING id, object_name, object_code`,
    [input.partnerId, normalizedName, normalizedCodeForStore],
  );

  return {
    partnerObjectId: created.id,
    objectName: normalizeOptionalText(created.object_name),
    objectCode: normalizeOptionalText(created.object_code),
  };
}

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

const jwtVerify = async (request: FastifyRequest) => {
  await request.jwtVerify();
};

const ordersManagePreHandler = [
  jwtVerify,
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
];

export default async function orderRoutes(app: FastifyInstance) {
  // GET /orders/products-for-order — products with stock + partner price in one call
  app.get(
    "/products-for-order",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);

      const { partner_id, search, in_stock_only } = request.query as {
        partner_id?: string;
        search?: string;
        in_stock_only?: string;
      };

      let where = "WHERE 1=1";
      const params: any[] = [];
      let paramIdx = 1;

      // Track the param index of the FIRST search word's normalized form,
      // so the ORDER BY below can rank rows by where the word appears in
      // the product name (1st-word match → 2nd-word → 3rd+).
      let firstWordParamIdx: number | null = null;
      if (search) {
        // Split search into words so "Beef P" matches 'Beef "PASTRAMI"'.
        // Uses normalize_search() for Cyrillic↔Latin transliteration.
        // SKU homoglyph fix: Microinvest export-ите дават SKU като
        // "CHВЕ3045" с микс латиница + кирилски В Е (визуално еднакви
        // букви). translate() с homoglyph map → ASCII еквиваленти.
        // Mirror на /products endpoint-а.
        const HOMOGLYPHS_FROM = "АВЕКМНОРСТХаверстх";
        const HOMOGLYPHS_TO = "ABEKMHOPCTXaepctx";
        const words = search.trim().split(/\s+/).filter(Boolean);
        const wordClauses: string[] = [];
        for (const word of words) {
          const escaped = word.replace(/[%_\\]/g, "\\$&");
          if (firstWordParamIdx === null) firstWordParamIdx = paramIdx;
          wordClauses.push(
            `(
              normalize_search(p.name_bg) ILIKE '%' || normalize_search($${paramIdx}) || '%'
              OR normalize_search(p.name_en) ILIKE '%' || normalize_search($${paramIdx}) || '%'
              OR p.sku ILIKE $${paramIdx + 1}
              OR translate(p.sku, $${paramIdx + 2}, $${paramIdx + 3})
                 ILIKE '%' || translate($${paramIdx}, $${paramIdx + 2}, $${paramIdx + 3}) || '%'
              OR p.brand ILIKE $${paramIdx + 1}
            )`,
          );
          params.push(word, `%${escaped}%`, HOMOGLYPHS_FROM, HOMOGLYPHS_TO);
          paramIdx += 4;
        }
        if (wordClauses.length > 0) {
          where += ` AND (${wordClauses.join(" AND ")})`;
        }
      }

      // Get partner's price_list_id and price_group
      let priceListId: number | null = null;
      let partnerPriceGroup: string | null = null;
      if (partner_id) {
        const {
          rows: [partner],
        } = await query(
          "SELECT price_list_id, price_group FROM partners WHERE id = $1",
          [partner_id],
        );
        priceListId = partner?.price_list_id ?? null;
        partnerPriceGroup = partner?.price_group ?? null;
      }

      // Map partner's price group to the product column name
      const priceGroupColumnMap: Record<string, string> = {
        "Цена на едро": "selling_price",
        "Цена на дребно": "retail_price",
        "Ценова група 1": "price_group_1",
        "Ценова група 2": "price_group_2",
        "Ценова група 3": "price_group_3",
        "Ценова група 4": "price_group_4",
        "Ценова група 5": "price_group_5",
        "Ценова група 6": "price_group_6",
        "Ценова група 7": "price_group_7",
        "Ценова група 8": "price_group_8",
      };
      const groupPriceCol = partnerPriceGroup
        ? priceGroupColumnMap[partnerPriceGroup] || "selling_price"
        : "selling_price";

      const sql = `
      SELECT p.id, p.name_bg, p.name_en, p.sku, p.unit, p.brand, p.selling_price,
             p.purchase_price, p.weight_kg,
             p.${groupPriceCol} AS group_price,
             COALESCE(SUM(inv.quantity), 0)::numeric AS total_stock
             ${priceListId ? `, pli.price AS partner_price` : `, NULL::numeric AS partner_price`}
      FROM products p
      LEFT JOIN inventory inv ON inv.product_id = p.id
      ${priceListId ? `LEFT JOIN price_list_items pli ON pli.product_id = p.id AND pli.price_list_id = $${paramIdx++}` : ""}
      ${where}
      GROUP BY p.id ${priceListId ? ", pli.price" : ""}
      ${in_stock_only === "true" ? "HAVING COALESCE(SUM(inv.quantity), 0) > 0" : ""}
      ORDER BY
        CASE
          WHEN COALESCE(${priceListId ? "pli.price, " : ""}p.${groupPriceCol}, p.selling_price, 0) <= 0 THEN 2
          WHEN COALESCE(SUM(inv.quantity), 0) > 0 THEN 0
          ELSE 1
        END,
        ${
          firstWordParamIdx !== null
            ? `NULLIF(POSITION(normalize_search($${firstWordParamIdx}) IN normalize_search(p.name_bg)), 0) NULLS LAST,`
            : ""
        }
        p.name_bg
      LIMIT 100
    `;
      if (priceListId) params.splice(paramIdx - 2, 0, priceListId);

      const { rows } = await query(sql, params);

      // MERT-M: no per-batch enrichment. Stock is tracked per product only.

      return { data: rows };
    },
  );

  // GET /orders
  app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);

    const {
      status,
      partner_id,
      page,
      limit,
      invoiced,
      date_from,
      date_to,
      invoice_number,
      stock_dispatch_number,
      commercial_document_number,
      warranty_number,
      request_number,
      object_query,
      q,
      below_cost_only,
      article,
      has_paid_not_taken,
      has_awaiting,
      has_pending_pickup,
      // Унифициран view за /warehouse-packing — обединява processing
      // orders (за стандартно пакетиране) и orders с pending_pickup
      // линии (клиент дойде за платена-невзета стока). Касиерите/
      // складовите хора нищо повече не им трябва.
      warehouse_view,
      // Filter pill — show only orders that have an Econt shipment
      // attached (товарителница). Combined with `has_cod` it filters
      // down to "Еконт с наложен платеж" specifically.
      has_econt_shipment,
      has_cod,
      // Search input — match the Econt shipment_number partially so
      // the cashier can paste a tracking number from the email and
      // jump straight to the matching order.
      shipment_number,
      // Awaiting-stock children (migration 072) are hidden from the
      // main orders list by default — they live in a dedicated "На
      // изчакване" view. Pass awaiting_only=true to flip the filter
      // and see ONLY them.
      awaiting_only,
      // Product-replacement filter (spec 4.5). When set, narrows the
      // list to either replacement or normal orders. Omitted = both.
      // Accepts the strings "true"/"false" since query strings are
      // strings; anything else is ignored.
      is_replacement,
    } = request.query as any;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const offset = (pageNum - 1) * pageSize;

    let where = "WHERE 1=1";
    const params: any[] = [];
    let paramIdx = 1;

    // Awaiting-stock filter (migration 072 — child orders for line_status
    // 'awaiting'). Default: hide them from the main list. Explicit
    // awaiting_only=true: show ONLY them. An explicit `status` query
    // param wins over the default hide so admin tooling can still inspect
    // these rows directly.
    if (awaiting_only === "true") {
      where += ` AND o.status = 'awaiting_stock'`;
    } else if (status) {
      where += ` AND o.status = $${paramIdx++}`;
      params.push(status);
    } else {
      where += ` AND o.status != 'awaiting_stock'`;
    }
    if (partner_id) {
      const parsedPartnerId = parseInt(partner_id);
      if (!Number.isNaN(parsedPartnerId)) {
        where += ` AND o.partner_id = $${paramIdx++}`;
        params.push(parsedPartnerId);
      }
    }
    const invoicedFilter = parseOptionalBoolean(invoiced);
    if (invoicedFilter === true) {
      where += ` AND o.invoice_id IS NOT NULL`;
    } else if (invoicedFilter === false) {
      where += ` AND o.invoice_id IS NULL`;
    }

    // Reports filter: only orders that required admin below-cost approval.
    // Admin-only on FE; backend does not gate the SQL filter itself — a
    // sales user querying with the param still gets the filter, but they
    // cannot see purchase_price elsewhere in the app.
    if (below_cost_only === "true") {
      where += ` AND o.below_cost_approved_at IS NOT NULL`;
    }

    // Batch F1 filter pills — show only orders with the matching line state.
    // EXISTS keeps the query plan tight (no JOIN cardinality blowup); the
    // partial index idx_order_items_line_status_pending matches both clauses.
    if (has_paid_not_taken === "true") {
      where += ` AND EXISTS (
        SELECT 1 FROM order_items oi
        WHERE oi.order_id = o.id AND oi.line_status = 'paid_not_taken'
      )`;
    }
    if (has_awaiting === "true") {
      where += ` AND EXISTS (
        SELECT 1 FROM order_items oi
        WHERE oi.order_id = o.id AND oi.line_status = 'awaiting'
      )`;
    }
    if (has_pending_pickup === "true") {
      where += ` AND EXISTS (
        SELECT 1 FROM order_items oi
        WHERE oi.order_id = o.id AND oi.line_status = 'pending_pickup'
      )`;
    }
    // Warehouse-packing combined view — поръчки в обработка ИЛИ
    // готови за финално предаване (pending_pickup линии). Не е
    // composable с другите status/has_* filter-и; ако се подаде
    // status=processing В ДОПЪЛНЕНИЕ, той вече е в where и
    // warehouse_view добавя UNION-condition с OR.
    if (warehouse_view === "true") {
      where += ` AND (
        o.status = 'processing'
        OR EXISTS (
          SELECT 1 FROM order_items oi
          WHERE oi.order_id = o.id AND oi.line_status = 'pending_pickup'
        )
      )`;
    }
    // Econt filter pills.
    if (has_econt_shipment === "true") {
      where += ` AND o.econt_shipment_number IS NOT NULL`;
    }
    if (has_cod === "true") {
      where += ` AND o.econt_shipment_number IS NOT NULL
                 AND o.econt_cod_amount IS NOT NULL
                 AND o.econt_cod_amount > 0`;
    }
    const shipmentNumber = normalizeOptionalText(shipment_number);
    if (shipmentNumber) {
      where += ` AND o.econt_shipment_number ILIKE $${paramIdx++}`;
      params.push(`%${shipmentNumber}%`);
    }

    // Замяна — replacement-only / normal-only filter (spec 4.5). The
    // FE replacements view passes is_replacement=true so the customer
    // can see all open exchanges; normal screens pass false to hide
    // them from the regular orders feed.
    if (is_replacement === "true") {
      where += ` AND o.is_replacement = $${paramIdx++}`;
      params.push(true);
    } else if (is_replacement === "false") {
      where += ` AND o.is_replacement = $${paramIdx++}`;
      params.push(false);
    }

    const fromDate = normalizeOptionalText(date_from);
    if (fromDate) {
      where += ` AND DATE(o.order_date) >= $${paramIdx++}`;
      params.push(fromDate);
    }
    const toDate = normalizeOptionalText(date_to);
    if (toDate) {
      where += ` AND DATE(o.order_date) <= $${paramIdx++}`;
      params.push(toDate);
    }

    const invoiceNumber = normalizeOptionalText(invoice_number);
    if (invoiceNumber) {
      where += ` AND inv.invoice_number ILIKE $${paramIdx++}`;
      params.push(`%${invoiceNumber}%`);
    }

    const stockDispatchNumber = normalizeOptionalText(stock_dispatch_number);
    if (stockDispatchNumber) {
      where += ` AND ${STOCK_DISPATCH_NUMBER_SQL} ILIKE $${paramIdx++}`;
      params.push(`%${stockDispatchNumber}%`);
    }

    const commercialDocNumber = normalizeOptionalText(
      commercial_document_number,
    );
    if (commercialDocNumber) {
      where += ` AND ${COMMERCIAL_DOC_NUMBER_SQL} ILIKE $${paramIdx++}`;
      params.push(`%${commercialDocNumber}%`);
    }

    // Warranty number — only orders that already had a warranty card
    // generated (warranty_issued_at IS NOT NULL) match. Format is
    // WR-NNNNNNN, derived from order_number, so a partial like "0000012"
    // or "WR-12" both work.
    const warrantyNumber = normalizeOptionalText(warranty_number);
    if (warrantyNumber) {
      where += ` AND ${WARRANTY_NUMBER_SQL} ILIKE $${paramIdx++}`;
      params.push(`%${warrantyNumber}%`);
    }

    const requestNumber = normalizeOptionalText(request_number);
    if (requestNumber) {
      where += ` AND o.request_number ILIKE $${paramIdx++}`;
      params.push(`%${requestNumber}%`);
    }

    const objectQuery = normalizeOptionalText(object_query);
    if (objectQuery) {
      where += ` AND (${ORDER_OBJECT_NAME_SQL} ILIKE $${paramIdx} OR ${ORDER_OBJECT_CODE_SQL} ILIKE $${paramIdx})`;
      params.push(`%${objectQuery}%`);
      paramIdx++;
    }

    // Article search: matches orders containing a product whose snapshot
    // name or SKU matches the query. Uses oi.*_snapshot from Batch B so a
    // rename in the products catalog does not retroactively hide a match
    // (the historical document's name is what's searchable).
    //
    // The query is split on whitespace so 'колбасо реза' matches
    // 'Колбасорезачка' (each token must appear, in any order). The full
    // un-split query is also kept for exact SKU match.
    const articleQuery = normalizeOptionalText(article);
    const articleTokens = articleQuery
      ? articleQuery.split(/\s+/).filter((t) => t.length > 0)
      : [];
    if (articleQuery && articleTokens.length > 0) {
      const tokenClauses = articleTokens.map(() => {
        const idx = paramIdx++;
        return `(oi.name_bg_snapshot ILIKE $${idx} OR oi.name_en_snapshot ILIKE $${idx})`;
      });
      const skuIdx = paramIdx++;
      where += ` AND EXISTS (
        SELECT 1
        FROM order_items oi
        WHERE oi.order_id = o.id
          AND (
            (${tokenClauses.join(" AND ")})
            OR oi.sku_snapshot = $${skuIdx}
          )
      )`;
      for (const t of articleTokens) params.push(`%${t}%`);
      params.push(articleQuery);
    }

    const freeText = normalizeOptionalText(q);
    if (freeText) {
      // Transliteration-aware partner/object name match; raw ILIKE for numbers.
      where += `
        AND (
          normalize_search(p.name) ILIKE '%' || normalize_search($${paramIdx + 1}) || '%'
          OR normalize_search(${ORDER_OBJECT_NAME_SQL}) ILIKE '%' || normalize_search($${paramIdx + 1}) || '%'
          OR inv.invoice_number ILIKE $${paramIdx}
          OR ${STOCK_DISPATCH_NUMBER_SQL} ILIKE $${paramIdx}
          OR ${COMMERCIAL_DOC_NUMBER_SQL} ILIKE $${paramIdx}
          OR ${WARRANTY_NUMBER_SQL} ILIKE $${paramIdx}
          OR o.request_number ILIKE $${paramIdx}
          OR ${ORDER_OBJECT_CODE_SQL} ILIKE $${paramIdx}
        )
      `;
      params.push(`%${freeText}%`, freeText);
      paramIdx += 2;
    }

    // Snapshot WHERE params before appending ORDER/LIMIT args.
    const filterParams = [...params];

    // When a free-text query was provided, rank by partner similarity first.
    let orderClause = "ORDER BY o.created_at DESC";
    if (freeText) {
      orderClause = `ORDER BY similarity(normalize_search(p.name), normalize_search($${paramIdx})) DESC, o.created_at DESC`;
      params.push(freeText);
      paramIdx++;
    }

    // Batch D — list rows expose `invoice_partner_*` so the table can
    // show "ЖОКЕР ЕНТЪРТЕЙМЪНТ ЕООД" instead of "Физическо лице" when an
    // override is in effect. Source: orders.invoice_partner_id (migration
    // 068) — survives invoice deletion and applies pre-invoice as well.
    const sql = `
      SELECT o.*,
             p.name AS partner_name,
             inv.invoice_number,
             inv.invoice_date,
             inv.status AS invoice_status,
             cn.id AS credit_note_id,
             cn.invoice_number AS credit_note_number,
             COALESCE(ic.item_count, 0)::int AS item_count,
             ${STOCK_DISPATCH_NUMBER_SQL} AS stock_dispatch_number,
             ${COMMERCIAL_DOC_NUMBER_SQL} AS commercial_document_number,
             ${WARRANTY_NUMBER_SQL} AS warranty_number,
             ${ORDER_OBJECT_NAME_SQL} AS object_name,
             ${ORDER_OBJECT_CODE_SQL} AS object_code,
             (o.invoice_id IS NOT NULL) AS invoiced,
             ipo.id   AS invoice_partner_id,
             ipo.name AS invoice_partner_name,
             ipo.eik  AS invoice_partner_eik,
             COALESCE(pay.paid_amount, 0)::numeric AS paid_amount,
             COALESCE(pay.paid_cod_amount, 0)::numeric AS paid_cod_amount,
             (o.econt_shipment_number IS NOT NULL
              AND o.econt_cod_amount IS NOT NULL
              AND o.econt_cod_amount > 0) AS has_cod_shipment
      FROM orders o
      JOIN partners p ON p.id = o.partner_id
      LEFT JOIN invoices inv ON inv.id = o.invoice_id
      LEFT JOIN invoices cn ON cn.related_invoice_id = inv.id
          AND cn.document_type = 'credit_note'
      LEFT JOIN partners ipo ON ipo.id = o.invoice_partner_id
                             AND ipo.id <> o.partner_id
      LEFT JOIN partner_order_objects po ON po.id = o.partner_object_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS item_count
        FROM order_items oi
        WHERE oi.order_id = o.id
      ) ic ON TRUE
      LEFT JOIN LATERAL (
        -- paid_amount: every payment regardless of method.
        -- paid_cod_amount: only COD-method (наложен платеж). Used by
        -- the FE badge: an Econt-COD shipment isn't 'Платена' until
        -- the courier-collected COD is recorded — stray cash/bank
        -- prepayments don't tip the badge to green on their own.
        SELECT COALESCE(SUM(pmt.amount), 0)::numeric AS paid_amount,
               COALESCE(SUM(CASE WHEN pmt.payment_method = 'cod' THEN pmt.amount ELSE 0 END), 0)::numeric AS paid_cod_amount
        FROM payments pmt
        WHERE pmt.order_id = o.id
           OR (o.invoice_id IS NOT NULL AND pmt.invoice_id = o.invoice_id)
      ) pay ON TRUE
      ${where}
      ${orderClause}
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    params.push(pageSize, offset);

    const { rows } = await query(sql, params);

    // When ?article= is set, enrich each row with matched_items so the
    // FE can display which order line(s) matched. One batched query
    // covers every order on the current page.
    let enrichedRows: any[] = rows;
    if (articleQuery && rows.length > 0 && articleTokens.length > 0) {
      const orderIds = rows.map((r: any) => r.id);
      // Same tokenized predicate as the EXISTS clause above so the
      // enrichment is consistent with the filter that selected the rows.
      const enrichParams: any[] = [orderIds];
      let pIdx = 2;
      const tokenClauses = articleTokens.map(() => {
        const idx = pIdx++;
        return `(oi.name_bg_snapshot ILIKE $${idx} OR oi.name_en_snapshot ILIKE $${idx})`;
      });
      const skuIdx = pIdx++;
      for (const t of articleTokens) enrichParams.push(`%${t}%`);
      enrichParams.push(articleQuery);
      const { rows: matched } = await query(
        `SELECT oi.order_id,
                oi.name_bg_snapshot AS name_bg,
                oi.sku_snapshot     AS sku
           FROM order_items oi
          WHERE oi.order_id = ANY($1::int[])
            AND (
              (${tokenClauses.join(" AND ")})
              OR oi.sku_snapshot = $${skuIdx}
            )
          ORDER BY oi.order_id, oi.id
          LIMIT 1000`,
        enrichParams,
      );
      const matchedByOrder = new Map<
        number,
        Array<{ name_bg: string; sku: string | null }>
      >();
      for (const m of matched) {
        const list = matchedByOrder.get(m.order_id) ?? [];
        list.push({ name_bg: m.name_bg, sku: m.sku });
        matchedByOrder.set(m.order_id, list);
      }
      enrichedRows = rows.map((r: any) => ({
        ...r,
        matched_items: matchedByOrder.get(r.id) ?? [],
      }));
    }

    // Total count (same WHERE clause; joins kept minimal since filters reference p/inv/po)
    const countSql = `
      SELECT COUNT(DISTINCT o.id) AS total
      FROM orders o
      JOIN partners p ON p.id = o.partner_id
      LEFT JOIN invoices inv ON inv.id = o.invoice_id
      LEFT JOIN partner_order_objects po ON po.id = o.partner_object_id
      ${where}
    `;
    const { rows: countRows } = await query(countSql, filterParams);
    const total = parseInt(countRows[0]?.total || "0");

    return {
      data: enrichedRows,
      pagination: { page: pageNum, limit: pageSize, total },
    };
  });

  // GET /orders/econt-queue — scoped feed for the Econt worker role.
  // Returns ONLY orders flagged econt_requested_at (non-cancelled), with a
  // price-free projection: no order total/NET/VAT column is ever serialized
  // to this role. The ONLY money value exposed is econt_cod_amount — the
  // cashier-set наложен платеж (gross sum the courier collects). GQF съхранява
  // total_amount като НЕТО, затова COD-ът НЕ се деривира от total_amount
  // (за разлика от MERTM, който пази GROSS); ползваме изричната
  // econt_cod_amount колона — същата семантика като списъка с поръчки
  // (has_cod_shipment = econt_cod_amount > 0). Registered BEFORE /:id so the
  // literal path wins over the param route.
  app.get(
    "/econt-queue",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      const role = (request.user as { role?: string })?.role;
      if (role !== "econt" && role !== "admin") {
        return reply
          .code(403)
          .send({ error: "Достъп само за Еконт работник." });
      }

      const { rows } = await query(
        `SELECT
           o.id,
           o.order_number,
           p.name AS partner_name,
           -- Единствената парична стойност, която Еконт работникът легитимно
           -- вижда — сумата за събиране (наложен платеж), зададена изрично от
           -- касиера. БЕЗ деривация от total_amount (НЕТО в GQF).
           o.econt_cod_amount,
           o.econt_shipment_number,
           o.econt_tracking_url,
           o.econt_pdf_url,
           o.econt_requested_at,
           o.created_at,
           -- paid: дали наложеният платеж (COD метод) вече е събран. Огледало
           -- на paid_cod_amount от списъка — случайни кеш/банкови предплащания
           -- не вдигат флага сами.
           (COALESCE((
              SELECT SUM(pay.amount) FROM payments pay
              WHERE (pay.order_id = o.id
                     OR (o.invoice_id IS NOT NULL AND pay.invoice_id = o.invoice_id))
                AND pay.payment_method = 'cod'
            ), 0) > 0) AS paid,
           COALESCE(
             (SELECT json_agg(json_build_object('name', pr.name_bg, 'quantity', oi.quantity, 'product_id', pr.id, 'weight_kg', pr.weight_kg) ORDER BY oi.id)
              FROM order_items oi
              JOIN products pr ON pr.id = oi.product_id
              WHERE oi.order_id = o.id),
             '[]'::json
           ) AS items
         FROM orders o
         LEFT JOIN partners p ON p.id = o.partner_id
         WHERE o.econt_requested_at IS NOT NULL
           AND o.status <> 'cancelled'
         ORDER BY o.econt_requested_at DESC`,
      );

      return reply.send({ data: rows });
    },
  );

  // GET /orders/:id
  app.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    const { id } = request.params as { id: string };

    // Batch D — drawer header reads `invoice_partner_*` (sourced from
    // orders.invoice_partner_id, migration 068). When set, the override
    // company supersedes the original individual partner everywhere.
    const {
      rows: [order],
    } = await query(
      `SELECT o.*, p.name AS partner_name, p.partner_type AS partner_partner_type,
              inv.include_vat AS invoice_include_vat,
              inv.payment_method AS invoice_payment_method,
              inv.invoice_number,
              inv.invoice_date,
              inv.status AS invoice_status,
              cn.id AS credit_note_id,
              cn.invoice_number AS credit_note_number,
              prof.invoice_number AS proforma_invoice_number,
              ${STOCK_DISPATCH_NUMBER_SQL} AS stock_dispatch_number,
              ${COMMERCIAL_DOC_NUMBER_SQL} AS commercial_document_number,
              ${WARRANTY_NUMBER_SQL} AS warranty_number,
              ${ORDER_OBJECT_NAME_SQL} AS object_name,
              ${ORDER_OBJECT_CODE_SQL} AS object_code,
              (o.invoice_id IS NOT NULL) AS invoiced,
              approver.name AS below_cost_approved_by_name,
              ipo.id   AS invoice_partner_id,
              ipo.name AS invoice_partner_name,
              ipo.eik  AS invoice_partner_eik
       FROM orders o
       JOIN partners p ON p.id = o.partner_id
       LEFT JOIN invoices inv ON inv.id = o.invoice_id
       LEFT JOIN invoices cn ON cn.related_invoice_id = inv.id
           AND cn.document_type = 'credit_note'
       LEFT JOIN invoices prof ON prof.id = o.proforma_invoice_id
       LEFT JOIN partners ipo ON ipo.id = o.invoice_partner_id
                              AND ipo.id <> o.partner_id
       LEFT JOIN partner_order_objects po ON po.id = o.partner_object_id
       LEFT JOIN users approver ON approver.id = o.below_cost_approved_by
       WHERE o.id = $1`,
      [id],
    );

    if (!order) {
      return reply.status(404).send({ error: "Order not found" });
    }

    // MERT-M: no batches — order items carry only product metadata.
    // total_stock is included so the partner-history drawer can disable the
    // "+" button for products that are currently out of stock.
    // Identity (name_bg / name_en / sku) is read from the per-row
    // snapshot so historical orders preserve the name that was on the
    // document at issuance, even after the product is renamed in the
    // catalog. Operational fields (unit / brand / weight / purchase_price)
    // still LEFT-JOIN the live products row.
    const { rows: items } = await query(
      `SELECT oi.*,
              oi.name_bg_snapshot AS name_bg,
              oi.name_en_snapshot AS name_en,
              oi.sku_snapshot     AS sku,
              pr.unit, pr.brand, pr.weight_kg, pr.purchase_price,
              (
                SELECT COALESCE(SUM(quantity), 0)
                FROM inventory
                WHERE product_id = oi.product_id
              )::numeric AS total_stock
       FROM order_items oi
       LEFT JOIN products pr ON pr.id = oi.product_id
       WHERE oi.order_id = $1
       ORDER BY oi.id`,
      [id],
    );

    return { ...order, items };
  });

  // POST /orders — create order
  app.post(
    "/",
    { preHandler: ordersManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = createOrderSchema.parse(request.body);

      // Замяна validation — sanity check the payload shape before we
      // touch the DB (cheap fail-fast). VAT-eligibility check needs the
      // partner row and runs inside the transaction below.
      if (body.is_replacement) {
        // Gate replacement creation behind REPLACEMENT_CREATE. The outer
        // ordersManagePreHandler only verifies ORDERS_MANAGE; this is a
        // stricter check so roles can be configured to manage normal
        // orders without being able to create замени.
        const allowedReplacement = await hasPermission(
          request.user as { id: string; role: string },
          PERMISSIONS.REPLACEMENT_CREATE,
        );
        if (!allowedReplacement) {
          return reply.code(403).send({
            error: "Forbidden",
            required_permission: PERMISSIONS.REPLACEMENT_CREATE,
            message: "Нямаш разрешение за създаване на замяна.",
          });
        }
        const hasGive = body.items.some((it) => !it.is_returning);
        const hasReturn = body.items.some((it) => it.is_returning);
        if (!hasGive) {
          return reply.code(400).send({
            error:
              "Замяната трябва да съдържа поне един артикул, който се дава на клиента.",
          });
        }
        if (!hasReturn) {
          return reply.code(400).send({
            error:
              "Замяната трябва да съдържа поне един артикул, който се връща от клиента.",
          });
        }
      } else {
        if (body.items.some((it) => it.is_returning)) {
          return reply.code(400).send({
            error:
              "Поле is_returning е разрешено само в поръчки от тип замяна.",
          });
        }
      }

      let oversell_items: OversellInfo[] = [];

      let result;
      try {
        result = await transaction(async (client) => {
          // Get partner's price list for default pricing
          const {
            rows: [partner],
          } = await client.query("SELECT * FROM partners WHERE id = $1", [
            body.partner_id,
          ]);

          if (!partner) {
            throw Object.assign(new Error("Partner not found"), {
              statusCode: 404,
            });
          }

          // Замяна (product exchange) is currently supported only for
          // razpiska-eligible partners (no VAT). See spec section 4.1
          // and isRazpiskaEligible() in constants/partners.ts.
          if (body.is_replacement && !isRazpiskaEligible(partner)) {
            throw Object.assign(
              new Error("Замяна за ДДС-фактуриран клиент още не е поддържана."),
              {
                statusCode: 400,
                payload: {
                  error: "Замяна за ДДС-фактуриран клиент още не е поддържана.",
                },
              },
            );
          }

          const requestNumber = normalizeOptionalText(body.request_number);
          const objectSelection = await resolveOrderObjectSelection(client, {
            partnerId: body.partner_id,
            partnerObjectId: body.partner_object_id ?? null,
            objectName: body.object_name,
            objectCode: body.object_code,
          });

          let priceMap = new Map<number, number>();
          if (partner.price_list_id) {
            const { rows: prices } = await client.query(
              "SELECT product_id, price FROM price_list_items WHERE price_list_id = $1",
              [partner.price_list_id],
            );
            for (const p of prices) {
              priceMap.set(p.product_id, parseFloat(p.price));
            }
          }

          // Map partner's price group to the product column name
          const priceGroupColumnMap: Record<string, string> = {
            "Цена на едро": "selling_price",
            "Цена на дребно": "retail_price",
            "Ценова група 1": "price_group_1",
            "Ценова група 2": "price_group_2",
            "Ценова група 3": "price_group_3",
            "Ценова група 4": "price_group_4",
            "Ценова група 5": "price_group_5",
            "Ценова група 6": "price_group_6",
            "Ценова група 7": "price_group_7",
            "Ценова група 8": "price_group_8",
          };
          const partnerPriceColumn = partner.price_group
            ? priceGroupColumnMap[partner.price_group] || "selling_price"
            : "selling_price";

          // Load product data including the partner's price group column.
          // name_en / sku come along so we can snapshot them onto the new
          // order_items rows (Batch B — historical document accuracy).
          const productIds = [...new Set(body.items.map((i) => i.product_id))];
          const { rows: productData } = await client.query(
            `SELECT id, selling_price, ${partnerPriceColumn} AS group_price, name_bg, name_en, sku, purchase_price FROM products WHERE id = ANY($1)`,
            [productIds],
          );
          const productMap = new Map(productData.map((p: any) => [p.id, p]));

          if (productMap.size !== productIds.length) {
            const missingIds = productIds.filter((pid) => !productMap.has(pid));
            throw Object.assign(
              new Error(`Invalid product ids: ${missingIds.join(", ")}`),
              { statusCode: 400 },
            );
          }

          // Awaiting items (line_status='awaiting') don't deduct stock —
          // they're a pre-order placeholder until the goods arrive — so
          // exclude them from the oversell check. Otherwise we'd warn
          // "stock will go negative" for items that never touch stock.
          // Returning items in a replacement order ADD to stock, so we
          // also skip them — there's no "oversell" possible when goods
          // are coming back in.
          const stockableItems = body.items.filter(
            (i) => i.line_status !== "awaiting" && !i.is_returning,
          );
          const validationResult = await validateRequestedStock(
            client,
            stockableItems,
            productMap,
          );
          oversell_items = validationResult.oversell_items;

          // Below-cost detection: build per-line input that mirrors what we
          // will actually persist (resolved unit_price after the same fallback
          // chain used below) so the helper sees the real prices.
          const costMap: Record<number, ProductCost> = {};
          for (const p of productData) {
            costMap[p.id] = {
              product_id: p.id,
              name: p.name_bg,
              purchase_price:
                p.purchase_price != null ? parseFloat(p.purchase_price) : null,
            };
          }
          // Below-cost only matters for goods leaving the warehouse —
          // is_returning lines come BACK from the customer, the unit_price
          // there records the original sale value, not a fresh sell price,
          // so comparing it to purchase_price is meaningless.
          const belowCostInput = body.items
            .filter((it) => !it.is_returning)
            .map((it) => {
              const prod = productMap.get(it.product_id) as any;
              const resolved =
                it.unit_price ??
                priceMap.get(it.product_id) ??
                (prod?.selling_price ? parseFloat(prod.selling_price) : null) ??
                0;
              return {
                product_id: it.product_id,
                quantity: it.quantity,
                unit_price: resolved,
                discount_percent: it.discount_percent ?? 0,
              };
            });
          const belowCost = computeBelowCostItems(belowCostInput, costMap);

          let belowCostApprovedBy: string | null = null;
          let belowCostApprovedAt: Date | null = null;
          let belowCostDetails: any = null;

          if (belowCost.length > 0) {
            if (!body.allow_below_cost) {
              throw Object.assign(new Error("Below cost not approved"), {
                statusCode: 400,
                payload: {
                  error: "Below cost not approved",
                  message:
                    "Има артикули под доставна цена. Изисква одобрение от admin.",
                  below_cost_items: belowCost,
                },
              });
            }
            const allowed = await hasPermission(
              request.user as { id: string; role: string },
              PERMISSIONS.BELOW_COST_OVERRIDE,
            );
            if (!allowed) {
              throw Object.assign(new Error("Forbidden"), {
                statusCode: 403,
                payload: {
                  error: "Forbidden",
                  message:
                    "Само admin може да одобрява продажба под доставна цена.",
                  required_permission: PERMISSIONS.BELOW_COST_OVERRIDE,
                },
              });
            }
            belowCostApprovedBy = (request.user as { id: string; role: string })
              .id;
            belowCostApprovedAt = new Date();
            belowCostDetails = belowCost;
          }

          // Awaiting items get a dual presence in the data model: they
          // stay on the main order as visible historical context (with
          // line_status='awaiting' so docs/totals/PDFs can filter them
          // out) AND they get duplicated into a separate child order
          // with parent_order_id back to main and status='awaiting_stock'.
          // Two cases drive this:
          //   - mixed (non-awaiting + awaiting) → main keeps ALL items
          //     including awaiting; child carries a copy of the awaiting
          //     ones (line_status flipped to 'normal' inside it since
          //     the child itself signals awaiting via order.status). The
          //     awaiting line on main is for "this is what the customer
          //     also asked for, hasn't arrived yet"; the child is the
          //     active workflow track for when stock arrives.
          //   - only awaiting → no parent, no duplication; the order
          //     itself is the awaiting bucket, status='awaiting_stock'
          //     and items are line_status='normal' inside it.
          const awaitingItems = body.items.filter(
            (i) => i.line_status === "awaiting",
          );
          const nonAwaitingItems = body.items.filter(
            (i) => i.line_status !== "awaiting",
          );
          const onlyAwaiting =
            nonAwaitingItems.length === 0 && awaitingItems.length > 0;

          // mainItems are what the primary order's order_items table will
          // hold. only-awaiting case: items become 'normal' inside the
          // (now-awaiting) order. mixed/normal: keep all items as-is so
          // the awaiting lines remain visible on the parent.
          const mainItems = onlyAwaiting
            ? awaitingItems.map((i) => ({
                ...i,
                line_status: "normal" as const,
              }))
            : body.items;
          const mainStatus = onlyAwaiting ? "awaiting_stock" : body.status;

          // Insert helper — used twice: once for the main order and once
          // for the awaiting child (mixed case). Snapshots product fields
          // onto each line, returns total + inserted rows. Awaiting lines
          // (line_status='awaiting') are inserted but DO NOT contribute to
          // `total_amount` — the cashier shouldn't be asked to invoice or
          // collect payment for goods that haven't arrived yet.
          const insertItems = async (
            targetOrderId: number,
            sourceItems: typeof body.items,
          ) => {
            let total = 0;
            const inserted: any[] = [];
            for (const item of sourceItems) {
              const prod = productMap.get(item.product_id) as any;
              if (!prod) {
                throw Object.assign(
                  new Error(`Product ${item.product_id} not found`),
                  { statusCode: 400 },
                );
              }
              const unitPrice =
                item.unit_price ??
                priceMap.get(item.product_id) ??
                (prod?.selling_price ? parseFloat(prod.selling_price) : null) ??
                0;
              const discountPct = item.discount_percent ?? 0;
              const totalPrice = Number(
                (item.quantity * unitPrice * (1 - discountPct / 100)).toFixed(
                  2,
                ),
              );
              const isReturning = item.is_returning ?? false;
              if (item.line_status !== "awaiting") {
                // Замяна — returning lines subtract from the running
                // total so the order's total_amount is the SIGNED
                // difference (positive → customer pays the difference,
                // negative → we refund). Spec section 4.1.
                total += isReturning ? -totalPrice : totalPrice;
              }
              const {
                rows: [orderItem],
              } = await client.query(
                `INSERT INTO order_items
                   (order_id, product_id, quantity, unit_price, discount_percent, total_price,
                    name_bg_snapshot, name_en_snapshot, sku_snapshot, line_status, is_returning)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
                [
                  targetOrderId,
                  item.product_id,
                  item.quantity,
                  unitPrice,
                  discountPct,
                  totalPrice,
                  prod.name_bg,
                  prod.name_en,
                  prod.sku,
                  item.line_status ?? "normal",
                  isReturning,
                ],
              );
              inserted.push(orderItem);
            }
            await client.query(
              "UPDATE orders SET total_amount = $1 WHERE id = $2",
              [total, targetOrderId],
            );
            return { total, items: inserted };
          };

          // Create the primary order. Econt fields ride here regardless —
          // in the only-awaiting case the cashier may still want to record
          // a future Econt destination for when the goods arrive.
          const {
            rows: [order],
          } = await client.query(
            `INSERT INTO orders (
           partner_id, delivery_date, notes, source, request_number,
           partner_object_id, object_name, object_code,
           econt_receiver_name, econt_receiver_phone, econt_delivery_type,
           econt_city, econt_office_code, econt_office_name,
           econt_street, econt_street_num, econt_cod_amount,
           econt_weight, econt_shipping_cost, econt_payer,
           econt_shipment_description, econt_shipment_date,
           below_cost_approved_by, below_cost_approved_at, below_cost_details,
           status, is_replacement, econt_requested_at, order_number
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                 $21, $22,
                 $23, $24, $25,
                 $26, $27, $28, nextval('order_number_seq'))
         RETURNING *`,
            [
              body.partner_id,
              body.delivery_date || null,
              body.notes || null,
              body.source,
              requestNumber,
              objectSelection.partnerObjectId,
              objectSelection.objectName,
              objectSelection.objectCode,
              body.econt_receiver_name ?? null,
              body.econt_receiver_phone ?? null,
              body.econt_delivery_type ?? null,
              body.econt_city ?? null,
              body.econt_office_code ?? null,
              body.econt_office_name ?? null,
              body.econt_street ?? null,
              body.econt_street_num ?? null,
              body.econt_cod_amount ?? null,
              body.econt_weight ?? null,
              body.econt_shipping_cost ?? null,
              body.econt_payer ?? null,
              body.econt_shipment_description ?? null,
              body.econt_shipment_date || null,
              belowCostApprovedBy,
              belowCostApprovedAt,
              belowCostDetails != null
                ? JSON.stringify(belowCostDetails)
                : null,
              mainStatus,
              body.is_replacement,
              // Флаг "за Еконт доставка" — true → влиза в опашката на Еконт
              // работника веднага при създаване; иначе NULL (извън опашката).
              body.econt_requested ? new Date().toISOString() : null,
            ],
          );

          const mainResult = await insertItems(order.id, mainItems);
          const totalAmount = mainResult.total;
          const items = mainResult.items;

          // Mixed case — spawn a child order to carry the awaiting lines.
          // Inherits partner + object info from the parent (so the child
          // shows up under the same customer in any list/filter), but no
          // Econt fields (the awaiting goods will get their own shipment
          // record when they arrive and convert to active).
          let awaitingChild: any = null;
          if (!onlyAwaiting && awaitingItems.length > 0) {
            const {
              rows: [child],
            } = await client.query(
              `INSERT INTO orders (
                 partner_id, partner_object_id, object_name, object_code,
                 status, parent_order_id, source, order_number
               )
               VALUES ($1, $2, $3, $4, 'awaiting_stock', $5, $6,
                       nextval('order_number_seq'))
               RETURNING *`,
              [
                body.partner_id,
                objectSelection.partnerObjectId,
                objectSelection.objectName,
                objectSelection.objectCode,
                order.id,
                body.source,
              ],
            );
            const childAwaitingItems = awaitingItems.map((i) => ({
              ...i,
              line_status: "normal" as const,
            }));
            const childResult = await insertItems(child.id, childAwaitingItems);
            awaitingChild = {
              ...child,
              total_amount: childResult.total,
              items: childResult.items,
            };
          }

          // Замяна — auto-record the signed difference into payments.
          //   total > 0  → customer pays the difference (is_refund = false)
          //   total < 0  → we refund the customer (is_refund = true)
          //   total == 0 → no payment row written
          // Spec section 4.3. amount is always stored as a positive value;
          // the direction lives in is_refund.
          if (body.is_replacement && body.payment_method && totalAmount !== 0) {
            await client.query(
              `INSERT INTO payments (order_id, amount, payment_method, is_refund, paid_at)
               VALUES ($1, $2, $3, $4, NOW())`,
              [
                order.id,
                Math.abs(totalAmount),
                body.payment_method,
                totalAmount < 0,
              ],
            );
          }

          // Notification — single line covers both the main and (if any)
          // awaiting child so the user sees one toast in the bell.
          const notifMessage = awaitingChild
            ? `Нова поръчка #${order.id} от ${partner.name} на стойност ${totalAmount.toFixed(2)} € · #${awaitingChild.id} на изчакване (чака стока)`
            : onlyAwaiting
              ? `Нова поръчка #${order.id} (на изчакване) от ${partner.name} на стойност ${totalAmount.toFixed(2)} €`
              : `Нова поръчка #${order.id} от ${partner.name} на стойност ${totalAmount.toFixed(2)} €`;
          await client.query(
            `INSERT INTO notifications (type, message) VALUES ('order_created', $1)`,
            [notifMessage],
          );

          // Замяна — secondary notification specifically for the
          // packing screen (spec 4.7). Carries a structured payload so
          // the UI can deep-link to the replacement order.
          if (body.is_replacement) {
            await client.query(
              `INSERT INTO notifications (type, message, payload)
               VALUES ('replacement_ready_for_packaging', $1, $2::jsonb)`,
              [
                `Замяна #${order.id} готова за пакетиране (${partner.name})`,
                JSON.stringify({
                  order_id: order.id,
                  is_replacement: true,
                }),
              ],
            );
          }

          return {
            ...order,
            total_amount: totalAmount,
            items,
            awaiting_child: awaitingChild,
          };
        });
      } catch (err: any) {
        if (err && err.payload && typeof err.statusCode === "number") {
          return reply.status(err.statusCode).send(err.payload);
        }
        throw err;
      }

      const response: any = { ...result };
      if (oversell_items.length > 0) {
        response.warnings = { oversell: oversell_items };
      }
      return reply.status(201).send(response);
    },
  );

  // POST /orders/from-comarch — create order from Comarch ERP sync
  app.post(
    "/from-comarch",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);

      const comarchSchema = z.object({
        comarch_order_id: z.string(),
        partner_name: z.string(),
        partner_eik: z.string().optional(),
        order_date: z.string().optional(),
        delivery_date: z.string().optional(),
        notes: z.string().optional(),
        total_amount: z.number().optional(),
        items: z
          .array(
            z.object({
              product_sku: z.string().optional(),
              product_name: z.string().optional(),
              quantity: z.number().positive(),
              unit_price: z.number().min(0).default(0),
              total_price: z.number().min(0).default(0),
            }),
          )
          .min(1),
      });

      const body = comarchSchema.parse(request.body);

      // Check for duplicate comarch order
      const { rows: existing } = await query(
        "SELECT * FROM comarch_sync WHERE comarch_order_id = $1",
        [body.comarch_order_id],
      );
      if (existing.length > 0) {
        return reply.status(409).send({
          error: "Comarch order already synced",
          comarch_order_id: body.comarch_order_id,
          order_id: existing[0].order_id,
        });
      }

      const result = await transaction(async (client) => {
        // Find or create partner
        let partnerId: number;
        if (body.partner_eik) {
          const { rows: partners } = await client.query(
            "SELECT id FROM partners WHERE eik = $1",
            [body.partner_eik],
          );
          if (partners.length > 0) {
            partnerId = partners[0].id;
          } else {
            const {
              rows: [newPartner],
            } = await client.query(
              "INSERT INTO partners (name, eik) VALUES ($1, $2) RETURNING id",
              [body.partner_name, body.partner_eik],
            );
            partnerId = newPartner.id;
          }
        } else {
          const { rows: partners } = await client.query(
            "SELECT id FROM partners WHERE name ILIKE $1 LIMIT 1",
            [body.partner_name],
          );
          if (partners.length > 0) {
            partnerId = partners[0].id;
          } else {
            const {
              rows: [newPartner],
            } = await client.query(
              "INSERT INTO partners (name) VALUES ($1) RETURNING id",
              [body.partner_name],
            );
            partnerId = newPartner.id;
          }
        }

        // Create order
        const {
          rows: [order],
        } = await client.query(
          `INSERT INTO orders (partner_id, delivery_date, notes, source, status, order_date, total_amount)
         VALUES ($1, $2, $3, 'comarch', 'pending', $4, $5)
         RETURNING *`,
          [
            partnerId,
            body.delivery_date || null,
            body.notes || null,
            body.order_date || new Date().toISOString(),
            body.total_amount || 0,
          ],
        );

        // Map and insert items
        let calculatedTotal = 0;
        const items = [];

        for (const item of body.items) {
          // Resolve product by SKU or name
          let productId: number | null = null;

          if (item.product_sku) {
            const { rows } = await client.query(
              "SELECT id FROM products WHERE sku = $1",
              [item.product_sku],
            );
            if (rows.length > 0) productId = rows[0].id;
          }

          if (!productId && item.product_name) {
            const { rows } = await client.query(
              "SELECT id FROM products WHERE name_en ILIKE $1 OR name_bg ILIKE $1 LIMIT 1",
              [`%${item.product_name}%`],
            );
            if (rows.length > 0) productId = rows[0].id;
          }

          if (!productId) {
            // Create product with auto-generated SKU
            const {
              rows: [{ max_sku }],
            } = await client.query(
              "SELECT COALESCE(MAX(sku::int), 10000) AS max_sku FROM products WHERE sku ~ '^[0-9]+$'",
            );
            const newSku = String(parseInt(max_sku) + 1);
            const {
              rows: [newProduct],
            } = await client.query(
              `INSERT INTO products (name_bg, name_en, sku, unit)
             VALUES ($1, $2, $3, 'pcs') RETURNING id`,
              [
                item.product_name || item.product_sku || "Unknown",
                item.product_name || item.product_sku || "Unknown",
                newSku,
              ],
            );
            productId = newProduct.id;
          }

          const totalPrice =
            item.total_price || item.quantity * item.unit_price;
          calculatedTotal += totalPrice;

          // Snapshot product identity at the moment of INSERT (Batch B).
          const {
            rows: [snap],
          } = await client.query(
            `SELECT name_bg, name_en, sku FROM products WHERE id = $1`,
            [productId],
          );
          if (!snap) {
            throw Object.assign(new Error(`Product ${productId} not found`), {
              statusCode: 400,
            });
          }

          const {
            rows: [orderItem],
          } = await client.query(
            `INSERT INTO order_items
               (order_id, product_id, quantity, unit_price, total_price,
                name_bg_snapshot, name_en_snapshot, sku_snapshot, line_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [
              order.id,
              productId,
              item.quantity,
              item.unit_price,
              totalPrice,
              snap.name_bg,
              snap.name_en,
              snap.sku,
              (item as any).line_status ?? "normal",
            ],
          );
          items.push(orderItem);
        }

        // Update total if not provided
        if (!body.total_amount) {
          await client.query(
            "UPDATE orders SET total_amount = $1 WHERE id = $2",
            [calculatedTotal, order.id],
          );
          order.total_amount = calculatedTotal;
        }

        // Record in comarch_sync
        await client.query(
          `INSERT INTO comarch_sync (comarch_order_id, order_id, status, synced_at)
         VALUES ($1, $2, 'synced', NOW())`,
          [body.comarch_order_id, order.id],
        );

        // Notification
        await client.query(
          `INSERT INTO notifications (type, message) VALUES ('order_created', $1)`,
          [
            `Comarch order ${body.comarch_order_id} synced as Order #${order.id} from ${body.partner_name}`,
          ],
        );

        return { ...order, items, comarch_order_id: body.comarch_order_id };
      });

      return reply.status(201).send(result);
    },
  );

  // PUT /orders/:id — edit order details
  app.put(
    "/:id",
    { preHandler: ordersManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = updateOrderSchema.parse(request.body);

      const {
        rows: [order],
      } = await query("SELECT * FROM orders WHERE id = $1", [id]);

      if (!order) {
        return reply.status(404).send({ error: "Order not found" });
      }
      if (order.status === "cancelled") {
        return reply
          .status(400)
          .send({ error: "Cannot edit a cancelled order" });
      }

      // Admin-only guard for edits to already-completed orders. Sales/
      // warehouse users with orders.manage can still edit pending /
      // confirmed / processing orders, but once stock is committed
      // (fulfilled) or the order is invoiced, only admin (or a user with
      // an explicit ORDERS_EDIT_AFTER_FULFILL override) can change it.
      if (order.status === "fulfilled" || order.status === "invoiced") {
        const allowed = await hasPermission(
          request.user as { id: string; role: string },
          PERMISSIONS.ORDERS_EDIT_AFTER_FULFILL,
        );
        if (!allowed) {
          return reply.status(403).send({
            error: "Forbidden",
            message: "Само admin може да редактира приключени поръчки.",
            required_permission: PERMISSIONS.ORDERS_EDIT_AFTER_FULFILL,
          });
        }
      }

      const orderId = Number(id);

      let result;
      try {
        result = await transaction(async (client) => {
          // Update order fields
          const sets: string[] = ["updated_at = NOW()"];
          const params: any[] = [];
          let paramIdx = 1;

          if (body.delivery_date !== undefined) {
            sets.push(`delivery_date = $${paramIdx++}`);
            params.push(body.delivery_date || null);
          }
          if (body.notes !== undefined) {
            sets.push(`notes = $${paramIdx++}`);
            params.push(body.notes || null);
          }
          if (body.request_number !== undefined) {
            sets.push(`request_number = $${paramIdx++}`);
            params.push(normalizeOptionalText(body.request_number));
          }

          const shouldUpdateObjectSelection =
            body.partner_object_id !== undefined ||
            body.object_name !== undefined ||
            body.object_code !== undefined;
          if (shouldUpdateObjectSelection) {
            const objectSelection = await resolveOrderObjectSelection(client, {
              partnerId: order.partner_id,
              partnerObjectId: body.partner_object_id ?? null,
              objectName: body.object_name,
              objectCode: body.object_code,
            });
            sets.push(`partner_object_id = $${paramIdx++}`);
            params.push(objectSelection.partnerObjectId);
            sets.push(`object_name = $${paramIdx++}`);
            params.push(objectSelection.objectName);
            sets.push(`object_code = $${paramIdx++}`);
            params.push(objectSelection.objectCode);
          }

          const econtFields: Array<keyof typeof body> = [
            "econt_receiver_name",
            "econt_receiver_phone",
            "econt_delivery_type",
            "econt_city",
            "econt_office_code",
            "econt_office_name",
            "econt_street",
            "econt_street_num",
            "econt_cod_amount",
            "econt_weight",
            "econt_payer",
            "econt_shipment_description",
            "econt_shipment_date",
          ];
          for (const field of econtFields) {
            if (body[field] !== undefined) {
              sets.push(`${field} = $${paramIdx++}`);
              params.push(body[field] ?? null);
            }
          }

          // econt_requested: true → set NOW() (enters Econt worker queue),
          // false → clear (drops from queue). Mirrors dispatched_to_warehouse_at.
          if (
            body.econt_requested !== undefined &&
            body.econt_requested !== null
          ) {
            sets.push(`econt_requested_at = $${paramIdx++}`);
            params.push(body.econt_requested ? new Date().toISOString() : null);
          }

          params.push(id);
          const {
            rows: [updated],
          } = await client.query(
            `UPDATE orders SET ${sets.join(", ")} WHERE id = $${paramIdx} RETURNING *`,
            params,
          );

          // Replace items if provided
          if (body.items) {
            const mustReconcileStock = STOCK_COMMITTED_STATUSES.has(
              updated.status,
            );

            // Get partner for pricing
            const {
              rows: [partner],
            } = await client.query("SELECT * FROM partners WHERE id = $1", [
              updated.partner_id,
            ]);

            if (!partner) {
              throw Object.assign(new Error("Partner not found"), {
                statusCode: 404,
              });
            }

            let priceMap = new Map<number, number>();
            if (partner.price_list_id) {
              const { rows: prices } = await client.query(
                "SELECT product_id, price FROM price_list_items WHERE price_list_id = $1",
                [partner.price_list_id],
              );
              for (const p of prices) {
                priceMap.set(p.product_id, parseFloat(p.price));
              }
            }

            const productIds = [
              ...new Set(body.items.map((i) => i.product_id)),
            ];
            const { rows: productData } = await client.query(
              "SELECT id, name_bg, name_en, sku, selling_price, purchase_price FROM products WHERE id = ANY($1)",
              [productIds],
            );
            const productMap = new Map(productData.map((p: any) => [p.id, p]));
            if (productMap.size !== productIds.length) {
              const missingIds = productIds.filter(
                (pid) => !productMap.has(pid),
              );
              throw Object.assign(
                new Error(`Invalid product ids: ${missingIds.join(", ")}`),
                { statusCode: 400 },
              );
            }

            // Below-cost detection — same gating as POST /orders.
            const costMap: Record<number, ProductCost> = {};
            for (const p of productData) {
              costMap[p.id] = {
                product_id: p.id,
                name: p.name_bg,
                purchase_price:
                  p.purchase_price != null
                    ? parseFloat(p.purchase_price)
                    : null,
              };
            }
            const belowCostInput = body.items.map((it) => {
              const prod = productMap.get(it.product_id) as any;
              const resolved =
                it.unit_price ??
                priceMap.get(it.product_id) ??
                (prod?.selling_price ? parseFloat(prod.selling_price) : 0);
              return {
                product_id: it.product_id,
                quantity: it.quantity,
                unit_price: resolved,
                discount_percent: it.discount_percent ?? 0,
              };
            });
            const belowCost = computeBelowCostItems(belowCostInput, costMap);

            if (belowCost.length > 0) {
              if (!body.allow_below_cost) {
                throw Object.assign(new Error("Below cost not approved"), {
                  statusCode: 400,
                  payload: {
                    error: "Below cost not approved",
                    message:
                      "Има артикули под доставна цена. Изисква одобрение от admin.",
                    below_cost_items: belowCost,
                  },
                });
              }
              const allowed = await hasPermission(
                request.user as { id: string; role: string },
                PERMISSIONS.BELOW_COST_OVERRIDE,
              );
              if (!allowed) {
                throw Object.assign(new Error("Forbidden"), {
                  statusCode: 403,
                  payload: {
                    error: "Forbidden",
                    message:
                      "Само admin може да одобрява продажба под доставна цена.",
                    required_permission: PERMISSIONS.BELOW_COST_OVERRIDE,
                  },
                });
              }
            }

            if (mustReconcileStock) {
              await restoreOrderItemsToInventory(client, orderId);
            }

            await client.query("DELETE FROM order_items WHERE order_id = $1", [
              id,
            ]);
            const { oversell_items } = await validateRequestedStock(
              client,
              body.items,
              productMap,
            );

            let totalAmount = 0;
            const items = [];
            const expiryWarnings: string[] = [];

            for (const item of body.items) {
              const prod = productMap.get(item.product_id);
              const unitPrice =
                item.unit_price ??
                priceMap.get(item.product_id) ??
                (prod?.selling_price ? parseFloat(prod.selling_price) : 0);
              const discountPct = item.discount_percent ?? 0;
              const totalPrice = Number(
                (item.quantity * unitPrice * (1 - discountPct / 100)).toFixed(
                  2,
                ),
              );
              totalAmount += totalPrice;

              // Snapshot the product identity AT THE MOMENT this line is
              // (re-)created. Existing rows that the user did not change are
              // not touched here — the loop DELETEs all order_items first and
              // re-creates them with snapshot from the current products row.
              const snap = productMap.get(item.product_id) as any;
              if (!snap) {
                throw Object.assign(
                  new Error(`Product ${item.product_id} not found`),
                  { statusCode: 400 },
                );
              }

              // INSERT the line first so deductBatched() has an order_item_id
              // to attach the per-batch allocations to. COGS / batch_id are
              // back-filled below once FEFO has chosen the partidi.
              const lineStatus = (item as any).line_status ?? "normal";
              const {
                rows: [orderItem],
              } = await client.query(
                `INSERT INTO order_items
                   (order_id, product_id, quantity, unit_price, discount_percent, total_price, cost_unit_price,
                    name_bg_snapshot, name_en_snapshot, sku_snapshot, line_status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
                [
                  id,
                  item.product_id,
                  item.quantity,
                  unitPrice,
                  discountPct,
                  totalPrice,
                  null,
                  snap.name_bg,
                  snap.name_en,
                  snap.sku,
                  lineStatus,
                ],
              );

              // GQF: при редакция след fulfill/invoice (mustReconcileStock)
              // стоката е била върната по-горе чрез restoreOrderItemsToInventory
              // и сега се изписва наново по партиди (FEFO или ръчно подадена
              // партида). Awaiting (предварителна поръчка) и returning редове
              // не пипат наличност тук.
              if (
                mustReconcileStock &&
                lineStatus !== "awaiting" &&
                !(item as any).is_returning
              ) {
                try {
                  const deduction = await deductBatched(
                    client,
                    orderItem.id,
                    item.product_id,
                    1,
                    item.quantity,
                    lineStatus === "paid_not_taken",
                    item.batch_id,
                  );
                  expiryWarnings.push(...deduction.warnings);
                  const firstBatch = deduction.allocations[0]?.batch_id ?? null;
                  const costUnitPrice =
                    item.quantity > 0 ? deduction.cost / item.quantity : null;
                  const {
                    rows: [refreshed],
                  } = await client.query(
                    `UPDATE order_items
                        SET cost_unit_price = $1,
                            batch_id = $2,
                            cost_source_batch_id = $2
                      WHERE id = $3 RETURNING *`,
                    [costUnitPrice, firstBatch, orderItem.id],
                  );
                  items.push(refreshed);
                  continue;
                } catch (err) {
                  throw asStockHttpError(err);
                }
              }

              items.push(orderItem);
            }

            await client.query(
              "UPDATE orders SET total_amount = $1 WHERE id = $2",
              [totalAmount, id],
            );

            // Persist new below-cost approval audit when this edit introduced
            // (or re-confirmed) below-cost lines. When belowCost is empty we
            // intentionally leave the existing audit columns alone so previously
            // approved orders keep their audit trail across no-op re-saves.
            if (belowCost.length > 0) {
              await client.query(
                `UPDATE orders SET below_cost_approved_by = $1, below_cost_approved_at = NOW(), below_cost_details = $2 WHERE id = $3`,
                [
                  (request.user as { id: string; role: string }).id,
                  JSON.stringify(belowCost),
                  id,
                ],
              );
            }

            let regeneratedInvoiceId: number | null = null;
            if (updated.invoice_id) {
              regeneratedInvoiceId = await regenerateActiveInvoiceForOrder(
                client,
                orderId,
                updated.partner_id,
                updated.invoice_id,
              );
            }

            if (mustReconcileStock) {
              await regenerateDependentOrderDocuments(client, orderId);
            }

            const orderRef = updated.order_number || updated.id;
            await client.query(
              `INSERT INTO notifications (type, message) VALUES ('order_updated', $1)`,
              [
                regeneratedInvoiceId
                  ? `Поръчка #${orderRef} е редактирана след фактуриране. Фактурата и документите са регенерирани.`
                  : `Поръчка #${orderRef} е редактирана.`,
              ],
            );

            const putResponse: any = {
              ...updated,
              total_amount: totalAmount,
              items,
              regenerated_invoice_id: regeneratedInvoiceId,
              regenerated_documents: mustReconcileStock,
            };
            if (oversell_items.length > 0 || expiryWarnings.length > 0) {
              putResponse.warnings = {
                ...(oversell_items.length > 0
                  ? { oversell: oversell_items }
                  : {}),
                ...(expiryWarnings.length > 0
                  ? { expiry: expiryWarnings }
                  : {}),
              };
            }
            return putResponse;
          }

          return updated;
        });
      } catch (err: any) {
        if (err && err.payload && typeof err.statusCode === "number") {
          return reply.status(err.statusCode).send(err.payload);
        }
        throw err;
      }

      return result;
    },
  );

  // MERT-M: removed PATCH /orders/:id/items/:itemId — it only edited
  // batch_number / expiry_date on an order line, which no longer exists
  // for durable goods.

  // PUT /orders/:id/status — change order status.
  // If transitioning to 'cancelled' from a stock-committed state (fulfilled),
  // return the goods back to inventory.
  app.put(
    "/:id/status",
    { preHandler: ordersManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const { status } = updateStatusSchema.parse(request.body);

      return await transaction(async (client) => {
        const {
          rows: [current],
        } = await client.query(
          "SELECT * FROM orders WHERE id = $1 FOR UPDATE",
          [id],
        );

        if (!current) {
          return reply.status(404).send({ error: "Order not found" });
        }

        // Block cancellation of invoiced orders — must go through credit note.
        // After the flow refactor "Фактурирана" is a flag, so check invoice_id.
        if (status === "cancelled" && current.invoice_id) {
          return reply.status(400).send({
            error:
              "Не може да се отмени фактурирана поръчка. Първо анулирайте фактурата (или издайте Кредитно известие).",
          });
        }

        // Quoted orders may only be cancelled via this endpoint. The
        // pending-confirmed-processing-fulfilled flow is reachable only
        // through POST /:id/unquote → /confirm → … (so the cashier never
        // accidentally activates an offer).
        if (current.status === "quoted" && status !== "cancelled") {
          return reply.status(400).send({
            error:
              "Оферта не може да преминава директно към работен поток. Използвай 'Премини към обработка'.",
          });
        }

        // If cancelling a fulfilled order, return stock first
        if (status === "cancelled" && current.status === "fulfilled") {
          await restoreOrderItemsToInventory(client, Number(id));
        }

        const { rows } = await client.query(
          `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
          [status, id],
        );

        return rows[0];
      });
    },
  );

  // POST /orders/:id/dispatch-to-warehouse — mark order as handed over to
  // warehouse staff for picking. Idempotent: setting it again is a no-op.
  // For backwards compatibility, an order still in 'confirmed' status is
  // also moved to 'processing' so the legacy stock-dispatch / commercial
  // document downloads (gated on processing+) become available.
  app.post(
    "/:id/dispatch-to-warehouse",
    { preHandler: ordersManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const result = await transaction(async (client) => {
        const {
          rows: [order],
        } = await client.query(
          "SELECT * FROM orders WHERE id = $1 FOR UPDATE",
          [id],
        );

        if (!order) {
          throw Object.assign(new Error("Order not found"), {
            statusCode: 404,
          });
        }
        if (order.status === "cancelled") {
          throw Object.assign(
            new Error("Cancelled order cannot be dispatched"),
            { statusCode: 400 },
          );
        }
        if (order.status === "pending") {
          throw Object.assign(
            new Error(
              "Order must be confirmed before dispatching to warehouse",
            ),
            { statusCode: 400 },
          );
        }

        const newStatus =
          order.status === "confirmed" ? "processing" : order.status;

        const {
          rows: [updated],
        } = await client.query(
          `UPDATE orders
             SET dispatched_to_warehouse_at = COALESCE(dispatched_to_warehouse_at, NOW()),
                 status = $1,
                 updated_at = NOW()
           WHERE id = $2
           RETURNING *`,
          [newStatus, id],
        );

        return updated;
      });

      return result;
    },
  );

  // POST /orders/:id/fulfill — deduct per-product stock and snapshot COGS
  app.post(
    "/:id/fulfill",
    { preHandler: ordersManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const result = await transaction(async (client) => {
        const {
          rows: [order],
        } = await client.query(
          "SELECT * FROM orders WHERE id = $1 FOR UPDATE",
          [id],
        );

        if (!order) {
          throw Object.assign(new Error("Order not found"), {
            statusCode: 404,
          });
        }
        if (order.status === "fulfilled") {
          throw Object.assign(new Error("Order already fulfilled"), {
            statusCode: 400,
          });
        }
        if (order.status === "cancelled") {
          throw Object.assign(new Error("Cannot fulfill cancelled order"), {
            statusCode: 400,
          });
        }
        if (order.status === "quoted") {
          throw Object.assign(
            new Error(
              "Cannot fulfill a quoted order — convert to pending first.",
            ),
            { statusCode: 400 },
          );
        }

        const { rows: items } = await client.query(
          "SELECT * FROM order_items WHERE order_id = $1",
          [id],
        );

        // GQF: изписване по партиди (FEFO). За всеки ред deductBatched()
        // избира партиди First-Expired-First-Out (или ползва ръчно подадена
        // партида), снема COGS от реалната партида в order_item_batches и
        // връща предупреждения за изтичащи скоро срокове.
        //
        // line_status разклонения —
        //   - 'awaiting'        → предварителна поръчка; пропуска изцяло
        //   - 'paid_not_taken'  → клиентът вече е платил; пак FEFO (стоката
        //                          трябва да съществува по партида)
        //   - 'normal' (по подр.) → стандартно FEFO изписване
        //
        // Замяна (spec 4.2): is_returning редове идват ОБРАТНО от клиента →
        // връщат се в наличност (по партидата на реда, ако има). Без COGS
        // снимка (оригиналната продажба вече е отчела разхода).
        const expiryWarnings: string[] = [];
        for (const item of items) {
          if (item.line_status === "awaiting") {
            continue;
          }
          if (item.is_returning) {
            // Return line — add stock back. Ако редът има партида (batch_id),
            // връщаме точно в нея; иначе fallback към реда без срок.
            const qty = parseFloat(item.quantity);
            if (item.batch_id) {
              const restored = await client.query(
                `UPDATE inventory
                    SET quantity = quantity + $1, updated_at = NOW()
                  WHERE product_id = $2 AND warehouse_id = 1 AND batch_id = $3`,
                [qty, item.product_id, item.batch_id],
              );
              if (!restored.rowCount) {
                await client.query(
                  `INSERT INTO inventory (product_id, batch_id, warehouse_id, quantity, updated_at)
                   VALUES ($1, $2, 1, $3, NOW())`,
                  [item.product_id, item.batch_id, qty],
                );
              }
              await client.query(
                "UPDATE batches SET quantity = quantity + $1, updated_at = NOW() WHERE id = $2",
                [qty, item.batch_id],
              );
            } else {
              const { rowCount } = await client.query(
                `UPDATE inventory
                   SET quantity = quantity + $1, updated_at = NOW()
                 WHERE product_id = $2 AND warehouse_id = 1
                 RETURNING quantity`,
                [qty, item.product_id],
              );
              if (!rowCount) {
                await client.query(
                  `INSERT INTO inventory (product_id, warehouse_id, quantity)
                   VALUES ($1, 1, $2)`,
                  [item.product_id, qty],
                );
              }
            }
            // Skip COGS snapshot for return lines.
            continue;
          }
          try {
            const deduction = await deductBatched(
              client,
              item.id,
              item.product_id,
              1,
              parseFloat(item.quantity),
              item.line_status === "paid_not_taken",
              item.batch_id ?? undefined,
            );
            expiryWarnings.push(...deduction.warnings);
            const qtyNum = parseFloat(item.quantity);
            const firstBatch = deduction.allocations[0]?.batch_id ?? null;
            const costUnitPrice = qtyNum > 0 ? deduction.cost / qtyNum : null;
            await client.query(
              `UPDATE order_items
                  SET cost_unit_price = $1,
                      batch_id = $2,
                      cost_source_batch_id = $2
                WHERE id = $3`,
              [costUnitPrice, firstBatch, item.id],
            );
          } catch (err) {
            throw asStockHttpError(err);
          }
        }

        // Mark as fulfilled
        await client.query(
          "UPDATE orders SET status = 'fulfilled', updated_at = NOW() WHERE id = $1",
          [id],
        );

        // Notification
        await client.query(
          `INSERT INTO notifications (type, message) VALUES ('order_fulfilled', $1)`,
          [`Order #${id} fulfilled. Stock deducted.`],
        );

        return {
          message: "Order fulfilled successfully",
          order_id: parseInt(id),
          warnings: expiryWarnings,
        };
      });

      // Auto-print fiscal receipt if enabled (non-blocking)
      try {
        const { getFiscalSettings, printReceiptForOrder } =
          await import("../services/fiscal-printer.js");
        const fiscalSettings = await getFiscalSettings();
        if (fiscalSettings.fiscal_enabled && fiscalSettings.fiscal_auto_print) {
          printReceiptForOrder(parseInt(id)).catch((err) => {
            request.log.error("Auto fiscal print failed:", err);
          });
        }
      } catch {
        // Fiscal printer module not available — skip
      }

      return result;
    },
  );

  // POST /orders/:id/items/:itemId/send-to-warehouse — миграция 079
  // Касиерът прехвърля paid_not_taken линия към склада за финално
  // пакетиране. Линията преминава в pending_pickup; складът ще я види
  // на /warehouse-packing в отделна "За предаване" секция и след
  // като опакова, ще извика /handover (по-долу) за финален flip към
  // normal. Stock не се пипа — изтеглен е още при оригиналния fulfill.
  app.post(
    "/:id/items/:itemId/send-to-warehouse",
    { preHandler: ordersManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, itemId } = request.params as {
        id: string;
        itemId: string;
      };
      return await transaction(async (client) => {
        const {
          rows: [item],
        } = await client.query(
          `SELECT id, order_id, line_status FROM order_items
           WHERE id = $1 AND order_id = $2 FOR UPDATE`,
          [itemId, id],
        );
        if (!item) {
          throw Object.assign(new Error("Order item not found"), {
            statusCode: 404,
          });
        }
        if (item.line_status !== "paid_not_taken") {
          throw Object.assign(
            new Error(
              "Only paid_not_taken lines can be sent to the warehouse for pickup.",
            ),
            { statusCode: 400 },
          );
        }
        const {
          rows: [updated],
        } = await client.query(
          `UPDATE order_items SET line_status = 'pending_pickup'
           WHERE id = $1 RETURNING *`,
          [itemId],
        );
        // Notification за склада — нов pickup за пакетиране.
        await client.query(
          `INSERT INTO notifications (type, message)
           VALUES ('pickup_ready_for_packaging', $1)`,
          [
            `Поръчка #${id} — клиент идва за платена-невзета стока, изпратена към склад`,
          ],
        );
        return updated;
      });
    },
  );

  // POST /orders/:id/items/:itemId/handover — Batch F1 + миграция 079
  // Финална стъпка: складът потвърждава, че физически е предал стоката
  // на клиента. Приема линия в pending_pickup (нов 2-step flow) ИЛИ
  // paid_not_taken (легаси/директна предаване — backward compat за
  // повиквания от ниско ниво и за стари UI кешове). И двата прехода
  // отиват в normal. Stock не се пипа — изтеглен е при оригиналния
  // fulfill (back-order/shortfall срещу откриващата партида за paid_not_taken).
  app.post(
    "/:id/items/:itemId/handover",
    { preHandler: ordersManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, itemId } = request.params as {
        id: string;
        itemId: string;
      };
      return await transaction(async (client) => {
        const {
          rows: [item],
        } = await client.query(
          `SELECT id, order_id, line_status FROM order_items
           WHERE id = $1 AND order_id = $2 FOR UPDATE`,
          [itemId, id],
        );
        if (!item) {
          throw Object.assign(new Error("Order item not found"), {
            statusCode: 404,
          });
        }
        if (
          item.line_status !== "pending_pickup" &&
          item.line_status !== "paid_not_taken"
        ) {
          throw Object.assign(
            new Error(
              "Only pending_pickup or paid_not_taken lines can be handed over.",
            ),
            { statusCode: 400 },
          );
        }
        const {
          rows: [updated],
        } = await client.query(
          `UPDATE order_items SET line_status = 'normal'
           WHERE id = $1 RETURNING *`,
          [itemId],
        );
        return updated;
      });
    },
  );

  // POST /orders/:id/mark-arrived — migration 072 / awaiting child order.
  // Flips an `awaiting_stock` order back to `confirmed` and resets
  // order_date to today, so the order surfaces in the day's "Поръчки"
  // list (the cashier's "second customer visit" workflow). The original
  // created_at and parent_order_id stay for audit; the cashier can still
  // see which transaction this was promised against.
  app.post(
    "/:id/mark-arrived",
    { preHandler: ordersManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      return await transaction(async (client) => {
        const {
          rows: [order],
        } = await client.query(
          "SELECT id, order_number, status FROM orders WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (!order) {
          return reply.status(404).send({ error: "Order not found" });
        }
        if (order.status !== "awaiting_stock") {
          return reply.status(400).send({
            error: "Only awaiting orders can be marked as arrived",
            current_status: order.status,
          });
        }
        const {
          rows: [updated],
        } = await client.query(
          `UPDATE orders
              SET status = 'confirmed',
                  order_date = CURRENT_DATE,
                  updated_at = NOW()
            WHERE id = $1
            RETURNING *`,
          [id],
        );
        await client.query(
          `INSERT INTO notifications (type, message) VALUES ('order_arrived', $1)`,
          [
            `Поръчка #${order.order_number} (на изчакване) — стоката пристигна, прехвърлена в днешните поръчки`,
          ],
        );
        return updated;
      });
    },
  );

  // POST /orders/:id/items/:itemId/confirm-from-awaiting — Batch F1
  // Promote an awaiting (pre-order) line to normal AND deduct stock now.
  // Refuses 409 when stock is insufficient — the caller (cashier) is
  // expected to confirm the goods have arrived (typically via the
  // pending_order_ready notification).
  app.post(
    "/:id/items/:itemId/confirm-from-awaiting",
    { preHandler: ordersManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, itemId } = request.params as {
        id: string;
        itemId: string;
      };
      return await transaction(async (client) => {
        const {
          rows: [item],
        } = await client.query(
          `SELECT * FROM order_items
           WHERE id = $1 AND order_id = $2 FOR UPDATE`,
          [itemId, id],
        );
        if (!item) {
          throw Object.assign(new Error("Order item not found"), {
            statusCode: 404,
          });
        }
        if (item.line_status !== "awaiting") {
          throw Object.assign(
            new Error("Only awaiting lines can be confirmed."),
            { statusCode: 400 },
          );
        }
        // GQF: изписване по партиди (FEFO) при потвърждаване на пристигнала
        // предварителна поръчка. Блокира изтекли партиди и недостатъчна
        // наличност (clean 400/409 чрез asStockHttpError).
        let deduction;
        try {
          deduction = await deductBatched(
            client,
            item.id,
            item.product_id,
            1,
            parseFloat(item.quantity),
            item.line_status === "paid_not_taken",
            item.batch_id ?? undefined,
          );
        } catch (err) {
          throw asStockHttpError(err);
        }
        const qtyNum = parseFloat(item.quantity);
        const firstBatch = deduction.allocations[0]?.batch_id ?? null;
        const costUnitPrice = qtyNum > 0 ? deduction.cost / qtyNum : null;
        const {
          rows: [updated],
        } = await client.query(
          `UPDATE order_items
             SET line_status = 'normal',
                 cost_unit_price = $1,
                 batch_id = $2,
                 cost_source_batch_id = $2
           WHERE id = $3 RETURNING *`,
          [costUnitPrice, firstBatch, itemId],
        );
        return {
          ...updated,
          warnings: deduction.warnings,
        };
      });
    },
  );

  // POST /orders/:id/quote — move an order into quote mode.
  //
  // Allowed source statuses: pending, confirmed, processing — all of
  // which are still "warehouse-neutral" (no `inventory` row has been
  // touched yet). Fulfilled / invoiced / cancelled are rejected because
  // they would require a stock-restore (fulfilled) or have a paper
  // document attached (invoiced) that the customer is presumably not
  // about to renegotiate.
  //
  // Cashier prints an offer (OF-XXX) and waits for the customer;
  // quoted orders never deduct stock — that's the whole point of
  // moving them here from confirmed/processing if the customer wants
  // a written quote first.
  app.post(
    "/:id/quote",
    { preHandler: ordersManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      return await transaction(async (client) => {
        const {
          rows: [order],
        } = await client.query(
          "SELECT id, status FROM orders WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (!order) {
          throw Object.assign(new Error("Order not found"), {
            statusCode: 404,
          });
        }
        const QUOTABLE = new Set(["pending", "confirmed", "processing"]);
        if (!QUOTABLE.has(order.status)) {
          throw Object.assign(
            new Error(
              "В режим 'Оферта' могат да се прехвърлят само поръчки преди изпълнение (Чакаща / Потвърдена / В обработка).",
            ),
            { statusCode: 400 },
          );
        }
        const {
          rows: [updated],
        } = await client.query(
          "UPDATE orders SET status = 'quoted', updated_at = NOW() WHERE id = $1 RETURNING *",
          [id],
        );
        return updated;
      });
    },
  );

  // POST /orders/:id/unquote — quoted → pending. Customer accepted the
  // offer; the order goes back into the normal pending → confirmed flow.
  app.post(
    "/:id/unquote",
    { preHandler: ordersManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      return await transaction(async (client) => {
        const {
          rows: [order],
        } = await client.query(
          "SELECT id, status FROM orders WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (!order) {
          throw Object.assign(new Error("Order not found"), {
            statusCode: 404,
          });
        }
        if (order.status !== "quoted") {
          throw Object.assign(
            new Error("Само оферти могат да преминат към обработка."),
            { statusCode: 400 },
          );
        }
        const {
          rows: [updated],
        } = await client.query(
          "UPDATE orders SET status = 'pending', updated_at = NOW() WHERE id = $1 RETURNING *",
          [id],
        );
        return updated;
      });
    },
  );

  // ════════════════════════════════════════════════════════════════════
  // PUT /orders/:id/invoice-partner — set/clear "Издай на фирма" override
  // ════════════════════════════════════════════════════════════════════
  // Persists the override receiver on the order itself so every transaction
  // document (Стокова разписка, Оферта, ППП, Търговски документ) and the
  // drawer header reflect it immediately — without waiting for the invoice
  // to be created. Body is either:
  //   { partner_id: number }                 → pick existing company partner
  //   { name, eik, ... }                     → upsert by EIK, then point to it
  //   {} or { partner_id: null } or null     → clear the override
  // Allowed only when the underlying order partner is an individual; trying
  // to override a legal-entity order is meaningless and rejected with 400.
  const setInvoicePartnerSchema = z
    .union([
      z.object({ partner_id: z.number().int().positive() }),
      z.object({
        name: z.string().trim().min(1).max(255),
        eik: z.string().trim().min(1).max(50),
        vat_number: z.string().trim().max(50).optional(),
        address: z.string().trim().max(500).optional(),
        city: z.string().trim().max(100).optional(),
        contact_person: z.string().trim().max(255).optional(),
        phone: z.string().trim().max(50).optional(),
        email: z.string().trim().max(255).optional(),
      }),
      z.object({ partner_id: z.null() }),
      z.object({}).strict(),
    ])
    .nullable();

  app.put(
    "/:id/invoice-partner",
    { preHandler: ordersManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = setInvoicePartnerSchema.parse(request.body ?? null);

      return await transaction(async (client) => {
        const {
          rows: [row],
        } = await client.query(
          `SELECT o.id, o.partner_id, p.partner_type
             FROM orders o
             JOIN partners p ON p.id = o.partner_id
            WHERE o.id = $1
            FOR UPDATE`,
          [id],
        );
        if (!row) {
          throw Object.assign(new Error("Order not found"), {
            statusCode: 404,
          });
        }

        // Treat null / {} / { partner_id: null } as "clear the override".
        const isClear =
          body == null ||
          (typeof body === "object" &&
            !("name" in body) &&
            (("partner_id" in body && body.partner_id == null) ||
              !("partner_id" in body)));

        if (isClear) {
          await client.query(
            "UPDATE orders SET invoice_partner_id = NULL, updated_at = NOW() WHERE id = $1",
            [id],
          );
          return { ok: true, invoice_partner_id: null };
        }

        if (row.partner_type !== "individual") {
          throw Object.assign(
            new Error(
              "Override към фирма е разрешен само за поръчки на физически лица.",
            ),
            { statusCode: 400 },
          );
        }

        // Resolve the override target — pick existing partner_id, or upsert
        // the supplied new-partner data by EIK (same rules as invoice flow).
        let invoicePartnerId: number;
        if ("partner_id" in body && body.partner_id) {
          const {
            rows: [existing],
          } = await client.query(
            "SELECT id FROM partners WHERE id = $1 LIMIT 1",
            [body.partner_id],
          );
          if (!existing) {
            throw Object.assign(new Error("Partner not found"), {
              statusCode: 404,
            });
          }
          invoicePartnerId = existing.id;
        } else if ("name" in body && "eik" in body) {
          const eik = body.eik.trim();
          const {
            rows: [match],
          } = await client.query(
            "SELECT id FROM partners WHERE eik = $1 LIMIT 1",
            [eik],
          );
          if (match) {
            invoicePartnerId = match.id;
          } else {
            const {
              rows: [created],
            } = await client.query(
              `INSERT INTO partners
                 (name, eik, vat_number, address, city,
                  contact_person, phone, email, partner_type)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'legal_entity')
               RETURNING id`,
              [
                body.name.trim(),
                eik,
                body.vat_number ?? null,
                body.address ?? null,
                body.city ?? null,
                body.contact_person ?? null,
                body.phone ?? null,
                body.email ?? null,
              ],
            );
            invoicePartnerId = created.id;
          }
        } else {
          throw Object.assign(new Error("Invalid invoice-partner payload"), {
            statusCode: 400,
          });
        }

        // Rejecting "set override = original partner" keeps the column
        // semantics clean: "NOT NULL means an override is in effect".
        if (invoicePartnerId === row.partner_id) {
          throw Object.assign(
            new Error(
              "Override партньорът съвпада с оригиналния — без промяна.",
            ),
            { statusCode: 400 },
          );
        }

        await client.query(
          "UPDATE orders SET invoice_partner_id = $1, updated_at = NOW() WHERE id = $2",
          [invoicePartnerId, id],
        );
        return { ok: true, invoice_partner_id: invoicePartnerId };
      });
    },
  );

  // DELETE /orders/:id — cancel an order (soft delete) with stock return for fulfilled orders
  app.delete(
    "/:id",
    { preHandler: ordersManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      // Fetch minimal order snapshot outside the transaction only to give
      // good error messages for missing orders. The authoritative read/lock
      // happens inside the transaction below with FOR UPDATE.
      const {
        rows: [orderSnapshot],
      } = await query("SELECT id FROM orders WHERE id = $1", [id]);

      if (!orderSnapshot) {
        return reply.status(404).send({ error: "Order not found" });
      }

      const order = await transaction(async (client) => {
        const {
          rows: [locked],
        } = await client.query(
          "SELECT * FROM orders WHERE id = $1 FOR UPDATE",
          [id],
        );
        return locked;
      });

      if (!order) {
        return reply.status(404).send({ error: "Order not found" });
      }

      // Invoiced orders can't be cancelled — use credit note instead.
      // After the flow refactor "Фактурирана" is a flag, so check invoice_id.
      if (order.invoice_id) {
        return reply.status(400).send({
          error:
            "Не може да се отмени фактурирана поръчка директно. Първо анулирайте фактурата от секция Фактури.",
        });
      }

      // If fulfilled, return stock to inventory
      if (order.status === "fulfilled") {
        const result = await transaction(async (client) => {
          // Re-lock the order inside the cancel transaction to avoid races
          // against concurrent fulfill/invoice operations. Re-read the
          // is_replacement flag and status from the locked row so the
          // cancel branches off the freshest committed value AND we can
          // detect a parallel cancel that already finished.
          const {
            rows: [locked],
          } = await client.query(
            "SELECT id, is_replacement, status FROM orders WHERE id = $1 FOR UPDATE",
            [id],
          );

          // Idempotency: if another cancel raced us and already flipped
          // status to 'cancelled', skip stock reversal + mirror payment.
          // Without this guard a double-cancel would reverse stock twice
          // and write two mirror payment rows.
          if (locked && locked.status === "cancelled") {
            return { itemCount: 0, alreadyCancelled: true as const };
          }

          // Return each item's quantity to inventory. MERT-M: no batches,
          // so we upsert on the partial unique index
          // inventory_product_warehouse_nobatch_uidx (product_id, warehouse_id)
          // WHERE batch_id IS NULL (added in migration 045).
          //
          // Замяна (product replacement, spec 4.4): for replacement orders
          // we REVERSE the fulfill direction — give lines (is_returning=
          // false) get their stock back (+qty) and return lines
          // (is_returning=true) lose stock again (−qty), because the
          // returned item is no longer ours to keep once the cancellation
          // undoes the swap. Additionally we write a MIRROR payment row
          // that flips is_refund of the original payment so the books
          // net to zero.
          const { rows: items } = await client.query(
            "SELECT product_id, quantity, is_returning FROM order_items WHERE order_id = $1",
            [id],
          );

          if (locked.is_replacement) {
            for (const item of items) {
              const qty = parseFloat(item.quantity);
              if (qty <= 0) continue;
              // Reverse fulfill: give lines were decremented → re-add;
              // return lines were incremented → re-deduct. The signed
              // delta below is what we ADD to inventory.
              const delta = item.is_returning ? -qty : qty;
              const { rowCount } = await client.query(
                `UPDATE inventory
                   SET quantity = quantity + $1,
                       updated_at = NOW()
                 WHERE product_id = $2
                   AND warehouse_id = 1
                   AND batch_id IS NULL`,
                [delta, item.product_id],
              );
              if (!rowCount) {
                await client.query(
                  `INSERT INTO inventory (product_id, warehouse_id, quantity, batch_id)
                   VALUES ($1, 1, $2, NULL)`,
                  [item.product_id, delta],
                );
              }
            }

            // Mirror payment: flip is_refund on the original (oldest)
            // payment row for this order. amount stays positive; only
            // direction reverses. Skip silently if no payment was
            // recorded (e.g. zero-total replacement).
            const { rows: origPayments } = await client.query(
              `SELECT amount, payment_method, is_refund
                 FROM payments
                WHERE order_id = $1
                ORDER BY id ASC
                LIMIT 1`,
              [id],
            );
            if (origPayments[0]) {
              const orig = origPayments[0];
              await client.query(
                `INSERT INTO payments (order_id, amount, payment_method, is_refund, paid_at)
                 VALUES ($1, $2, $3, $4, NOW())`,
                [id, orig.amount, orig.payment_method, !orig.is_refund],
              );
            }
          } else {
            for (const item of items) {
              const qty = parseFloat(item.quantity);
              if (qty <= 0) continue;

              await client.query(
                `INSERT INTO inventory (product_id, warehouse_id, quantity, batch_id)
               VALUES ($1, 1, $2, NULL)
               ON CONFLICT (product_id, warehouse_id) WHERE batch_id IS NULL
               DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity,
                             updated_at = NOW()`,
                [item.product_id, qty],
              );
            }
          }

          // Cancel the order
          await client.query(
            "UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
            [id],
          );

          return { itemCount: items.length, alreadyCancelled: false as const };
        });

        // Idempotent path: a parallel cancel already did the work; just
        // return success without writing a duplicate notification.
        if (result.alreadyCancelled) {
          return {
            message: "Order already cancelled.",
            order_id: parseInt(id),
            items_returned: 0,
            alreadyCancelled: true,
          };
        }

        await query(
          `INSERT INTO notifications (type, message) VALUES ('order_cancelled', $1)`,
          [
            `Поръчка #${id} е отменена. ${result.itemCount} артикула върнати в склада.`,
          ],
        );

        return {
          message: "Order cancelled. Stock returned to inventory.",
          order_id: parseInt(id),
          items_returned: result.itemCount,
        };
      }

      // For pending/confirmed/processing — just cancel (no stock to return)
      await query(
        "UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
        [id],
      );

      await query(
        `INSERT INTO notifications (type, message) VALUES ('order_cancelled', $1)`,
        [`Поръчка #${id} е отменена`],
      );

      return { message: "Order cancelled", order_id: parseInt(id) };
    },
  );

  // GET /orders/:id/invoice — generate invoice for order
  app.get(
    "/:id/invoice",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      const { id } = request.params as { id: string };

      // Check if invoice already exists
      const {
        rows: [order],
      } = await query("SELECT * FROM orders WHERE id = $1", [id]);

      if (!order) {
        return reply.status(404).send({ error: "Order not found" });
      }

      if (order.invoice_id) {
        const {
          rows: [invoice],
        } = await query("SELECT * FROM invoices WHERE id = $1", [
          order.invoice_id,
        ]);
        return invoice;
      }

      return reply.status(404).send({
        error:
          "No invoice generated for this order. Use POST /invoices to create one.",
      });
    },
  );

  interface OversellInfo {
    product_id: number;
    available: number;
    requested: number;
    final_stock: number;
  }

  async function validateRequestedStock(
    db: DbExecutor,
    items: Array<{
      product_id: number;
      quantity: number;
    }>,
    _productMap: Map<number, any>,
  ): Promise<{ oversell_items: OversellInfo[] }> {
    const requestedByProduct = new Map<number, number>();
    for (const item of items) {
      requestedByProduct.set(
        item.product_id,
        (requestedByProduct.get(item.product_id) || 0) + item.quantity,
      );
    }

    const oversell_items: OversellInfo[] = [];
    for (const [productId, requestedQty] of requestedByProduct.entries()) {
      const {
        rows: [stockRow],
      } = await db.query(
        "SELECT COALESCE(SUM(quantity), 0)::numeric AS total FROM inventory WHERE product_id = $1",
        [productId],
      );
      const available = parseFloat(stockRow.total);
      if (available + EPSILON < requestedQty) {
        oversell_items.push({
          product_id: productId,
          available,
          requested: requestedQty,
          final_stock: available - requestedQty,
        });
      }
    }

    return { oversell_items };
  }

  // Find-or-create откриваща партида 'НАЧАЛНО' за продукт. Ползва се за
  // back-order изписване (платени поръчки, чиято стока още я няма по партиди).
  // Откриващата е без срок (expiry_date NULL) и носи продуктовата
  // purchase_price като себестойност.
  async function getOrCreateOpeningBatch(
    client: PoolClient,
    productId: number,
  ): Promise<{ id: number; purchase_price: number }> {
    const { rows: existing } = await client.query(
      `SELECT id, purchase_price FROM batches
        WHERE product_id = $1 AND batch_number = 'НАЧАЛНО'
        ORDER BY id ASC LIMIT 1
        FOR UPDATE`,
      [productId],
    );
    if (existing[0]) {
      return {
        id: existing[0].id,
        purchase_price: parseFloat(existing[0].purchase_price ?? "0"),
      };
    }
    const { rows: prod } = await client.query(
      "SELECT purchase_price FROM products WHERE id = $1",
      [productId],
    );
    const purchasePrice = parseFloat(prod[0]?.purchase_price ?? "0");
    const { rows: created } = await client.query(
      `INSERT INTO batches (product_id, batch_number, expiry_date, quantity, purchase_price)
       VALUES ($1, 'НАЧАЛНО', NULL, 0, $2)
       RETURNING id`,
      [productId, purchasePrice],
    );
    return { id: created[0].id, purchase_price: purchasePrice };
  }

  /**
   * GQF batch-aware изписване по партиди (FEFO или ръчно подадена партида).
   *
   * Изписва `qty` за конкретен поръчков ред:
   *   - ако е подаден `manualBatchId` → заключва точно тази партида (FOR
   *     UPDATE), проверява за наличност и за изтекъл срок, изписва от нея;
   *   - иначе → allocateFefo() избира партиди по First-Expired-First-Out,
   *     пропуска изтеклите. При недостиг:
   *       · allowBackorder=false → хвърля InsufficientStockError (блок);
   *       · allowBackorder=true  → изписва налично + допълва остатъка (shortfall)
   *         в МИНУС срещу откриващата 'НАЧАЛНО' партида (back-order за платени).
   *
   * За всяка засегната партида: намалява inventory + batches.quantity и
   * вмъква ред в order_item_batches (одит на разпределението + COGS).
   * Връща сумарния COGS, разпределенията (за снимка на order_items.batch_id /
   * cost_unit_price / cost_source_batch_id) и предупреждения (изтичащи скоро).
   */
  async function deductBatched(
    client: PoolClient,
    orderItemId: number,
    productId: number,
    warehouseId: number,
    qty: number,
    allowBackorder: boolean,
    manualBatchId?: number,
  ): Promise<{
    cost: number;
    warnings: string[];
    allocations: { batch_id: number; quantity: number; unit_cost: number }[];
  }> {
    let allocations: {
      batch_id: number;
      quantity: number;
      unit_cost: number;
    }[];
    let warnings: string[] = [];

    if (manualBatchId) {
      const { rows } = await client.query(
        `SELECT i.batch_id, b.batch_number, b.expiry_date, b.purchase_price,
                i.quantity AS available
           FROM inventory i
           JOIN batches b ON b.id = i.batch_id
          WHERE i.product_id = $1 AND i.warehouse_id = $2 AND i.batch_id = $3
          FOR UPDATE`,
        [productId, warehouseId, manualBatchId],
      );
      const row = rows[0];
      const today = new Date().toISOString().slice(0, 10);
      if (!row) {
        throw Object.assign(
          new Error(`Няма наличност за партида ${manualBatchId}`),
          { statusCode: 400 },
        );
      }
      if (row.expiry_date && String(row.expiry_date).slice(0, 10) < today) {
        throw Object.assign(
          new Error(
            `Партида ${row.batch_number ?? manualBatchId} е с изтекъл срок на годност`,
          ),
          { statusCode: 400 },
        );
      }
      if (parseFloat(row.available) < qty) {
        throw Object.assign(
          new Error(
            `Недостатъчна наличност за партида ${row.batch_number ?? manualBatchId}: налични ${parseFloat(row.available)}, искани ${qty}`,
          ),
          { statusCode: 409 },
        );
      }
      allocations = [
        {
          batch_id: manualBatchId,
          quantity: qty,
          unit_cost: parseFloat(row.purchase_price ?? "0"),
        },
      ];
    } else {
      const res = await allocateFefo(client, productId, warehouseId, qty, {
        warnDays: 30,
        allowShortfall: allowBackorder,
      });
      allocations = res.allocations;
      warnings = res.warnings;

      // Back-order: остатъкът се изписва в МИНУС срещу откриващата партида,
      // за да остане наличността по партида одитируема (платени поръчки).
      if (res.shortfall > 0) {
        const opening = await getOrCreateOpeningBatch(client, productId);
        allocations.push({
          batch_id: opening.id,
          quantity: res.shortfall,
          unit_cost: opening.purchase_price,
        });
      }
    }

    let cost = 0;
    for (const allocation of allocations) {
      // Find-or-create inventory ред (продукт/склад/партида), за да можем да
      // изпишем дори когато няма заприходен ред (back-order → отрицателна
      // наличност срещу откриващата партида).
      const updated = await client.query(
        `UPDATE inventory
            SET quantity = quantity - $1, updated_at = NOW()
          WHERE product_id = $2 AND warehouse_id = $3 AND batch_id = $4`,
        [allocation.quantity, productId, warehouseId, allocation.batch_id],
      );
      if (!updated.rowCount) {
        await client.query(
          `INSERT INTO inventory (product_id, batch_id, warehouse_id, quantity, updated_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [productId, allocation.batch_id, warehouseId, -allocation.quantity],
        );
      }
      await client.query(
        `UPDATE batches SET quantity = quantity - $1, updated_at = NOW() WHERE id = $2`,
        [allocation.quantity, allocation.batch_id],
      );
      await client.query(
        `INSERT INTO order_item_batches (order_item_id, batch_id, quantity, unit_cost)
         VALUES ($1, $2, $3, $4)`,
        [
          orderItemId,
          allocation.batch_id,
          allocation.quantity,
          allocation.unit_cost,
        ],
      );
      cost += allocation.quantity * allocation.unit_cost;
    }

    return { cost, warnings, allocations };
  }

  // Превръща InsufficientStockError (от allocateFefo) в чист 400 отговор с
  // българско съобщение, така че глобалният error handler да върне
  // подходящ HTTP статус вместо 500.
  function asStockHttpError(err: unknown): unknown {
    if (err instanceof InsufficientStockError) {
      return Object.assign(new Error(err.message), { statusCode: 400 });
    }
    return err;
  }

  async function regenerateActiveInvoiceForOrder(
    db: DbExecutor,
    orderId: number,
    partnerId: number,
    invoiceId: number,
  ) {
    const {
      rows: [invoice],
    } = await db.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [
      invoiceId,
    ]);
    if (!invoice) {
      throw Object.assign(new Error("Invoice not found for linked order"), {
        statusCode: 404,
      });
    }
    if (invoice.status === "cancelled") {
      throw Object.assign(
        new Error("Cannot edit order linked to cancelled invoice"),
        { statusCode: 409 },
      );
    }
    if (invoice.document_type !== "invoice") {
      throw Object.assign(
        new Error("Linked accounting document is not an invoice"),
        { statusCode: 400 },
      );
    }

    const { rows: items } = await db.query(
      `SELECT oi.*,
              oi.name_bg_snapshot AS name_bg,
              oi.name_en_snapshot AS name_en,
              oi.sku_snapshot     AS sku,
              p.unit, p.brand
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1
       ORDER BY oi.id`,
      [orderId],
    );

    const totalNet = items.reduce(
      (sum: number, i: any) => sum + parseFloat(i.total_price),
      0,
    );
    const includeVat = invoice.include_vat !== false;
    const vatRate = includeVat ? 20 : 0;
    const totalVat = includeVat ? totalNet * 0.2 : 0;
    const totalGross = totalNet + totalVat;

    const {
      rows: [{ total: paidTotal }],
    } = await db.query(
      "SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM payments WHERE invoice_id = $1",
      [invoiceId],
    );
    if (parseFloat(paidTotal) > totalGross + EPSILON) {
      throw Object.assign(
        new Error(
          "Order edit would make invoice total lower than already recorded payments",
        ),
        { statusCode: 409 },
      );
    }

    const {
      rows: [updatedInvoice],
    } = await db.query(
      `UPDATE invoices
       SET total_net = $1,
           total_vat = $2,
           total_gross = $3
       WHERE id = $4
       RETURNING *`,
      [totalNet, totalVat, totalGross, invoiceId],
    );

    const {
      rows: [partner],
    } = await db.query("SELECT * FROM partners WHERE id = $1", [partnerId]);

    const company = await getCompanySettings(db);
    const invoicesDir = path.resolve("uploads", "invoices");
    fs.mkdirSync(invoicesDir, { recursive: true });
    const pdfPath = path.join(
      invoicesDir,
      `${updatedInvoice.invoice_number}.pdf`,
    );

    await generateInvoicePdf({
      invoice: updatedInvoice,
      partner,
      company,
      items,
      vatRate,
      includeVat,
      sourceCurrency: (updatedInvoice as any).currency ?? null,
      outputPath: pdfPath,
    });

    await db.query("UPDATE invoices SET pdf_path = $1 WHERE id = $2", [
      pdfPath,
      invoiceId,
    ]);

    return invoiceId;
  }

  async function regenerateDependentOrderDocuments(
    db: DbExecutor,
    orderId: number,
  ) {
    const data = await loadOrderWithBatches(orderId, db);
    if (!data) return;

    const { order, items } = data;
    if (!STOCK_COMMITTED_STATUSES.has(order.status)) return;

    let includeVat = true;
    if (order.invoice_id) {
      const {
        rows: [inv],
      } = await db.query(
        "SELECT include_vat FROM invoices WHERE id = $1 AND status = 'active'",
        [order.invoice_id],
      );
      includeVat = inv?.include_vat !== false;
    }

    const company = await getCompanySettings(db);
    const docDir = path.resolve(process.cwd(), "data", "documents");
    if (!fs.existsSync(docDir)) fs.mkdirSync(docDir, { recursive: true });

    const stockDispatchPath = path.join(
      docDir,
      `stock-dispatch-${orderId}.pdf`,
    );
    const commercialDocPath = path.join(
      docDir,
      `commercial-doc-${orderId}.pdf`,
    );

    const stockDocNumber = `SR-${String(order.order_number || order.id).padStart(7, "0")}`;
    const commercialDocNumber = `TD-${String(order.order_number || order.id).padStart(7, "0")}`;

    await generateStockDispatchPdf({
      doc_number: stockDocNumber,
      doc_date: order.order_date || order.created_at,
      company,
      partner: {
        name: order.partner_name,
        eik: order.partner_eik,
        vat_number: order.partner_vat,
        address: order.partner_address,
        city: order.partner_city,
        phone: order.partner_phone,
        email: order.partner_email,
        mol: order.partner_mol,
      },
      warehouse_name: "Склад Овча Купел",
      items: items.map((i: any) => ({
        sku: i.sku,
        name_bg: i.name_bg,
        name_en: i.name_en,
        brand: i.brand,
        unit: i.unit,
        quantity: parseFloat(i.quantity),
        unit_price: parseFloat(i.unit_price),
        discount_percent: parseFloat(i.discount_percent ?? 0),
        total_price: parseFloat(i.total_price),
        batch_number: i.batch_number,
        expiry_date: i.expiry_date,
      })),
      vat_rate: includeVat ? 20 : 0,
      outputPath: stockDispatchPath,
      show_bgn: company.show_bgn_on_invoice === true,
    });

    await generateCommercialDocPdf({
      doc_number: commercialDocNumber,
      doc_date: order.order_date || order.created_at,
      company,
      partner: {
        name: order.partner_name,
        eik: order.partner_eik,
        vat_number: order.partner_vat,
        address: order.partner_address,
        city: order.partner_city,
        phone: order.partner_phone,
        email: order.partner_email,
        mol: order.partner_mol,
      },
      items: items.map((i: any) => ({
        sku: i.sku,
        name_bg: i.name_bg,
        name_en: i.name_en,
        brand: i.brand,
        unit: i.unit,
        quantity: parseFloat(i.quantity),
        batch_number: i.batch_number,
        expiry_date: i.expiry_date,
      })),
      outputPath: commercialDocPath,
    });
  }

  // ── Helper: load company settings ──
  async function getCompanySettings(db: DbExecutor = { query }) {
    const { rows } = await db.query("SELECT * FROM settings WHERE id = 1");
    const s = rows[0] || {};
    return {
      company_name: s.company_name || "BAKALIA GREEK DELI FOOD",
      address: s.address || "ул. Калогяново 14, 1618 София, България",
      city: s.city || "София",
      eik: s.eik || "202860357",
      vat_number: s.vat_number || "BG202860357",
      phone: s.phone || "00886291003",
      email: s.email || "",
      iban: s.iban || "",
      bank_name: s.bank_name || undefined,
      bic: s.bic || undefined,
      mol: s.mol || undefined,
      vet_reg_number: s.vet_reg_number || undefined,
      // Document toggles (migration 069+) — propagated to every PDF
      // generator so the BGN-next-to-EUR totals appear consistently.
      show_bgn_on_invoice: s.show_bgn_on_invoice === true,
    };
  }

  // ── Helper: load order with items (MERT-M: no batch info) ──
  //
  // The name is preserved for backward compatibility with the PDF helpers
  // that still expect `batch_number` and `expiry_date` fields in the item
  // shape. These fields are now emitted as NULL so the existing PDF
  // templates render "-" without further changes.
  async function loadOrderWithBatches(
    orderId: number,
    db: DbExecutor = { query },
  ) {
    // Batch D — `orders.invoice_partner_id` (migration 068) holds the
    // override receiver and is the source of truth for transaction
    // documents (Стокова разписка, Оферта, ППП, Търговски документ) and
    // the drawer header. It's set the moment the cashier picks "Издай на
    // фирма" and is cleared by ×; FK ON DELETE SET NULL means a deleted
    // override partner cleanly degrades to "no override".
    const {
      rows: [order],
    } = await db.query(
      `SELECT o.*,
              p.name AS partner_name, p.eik AS partner_eik,
              p.vat_number AS partner_vat, p.address AS partner_address,
              p.city AS partner_city, p.phone AS partner_phone,
              p.email AS partner_email,
              p.contact_person AS partner_mol,
              p.contact_person AS partner_contact_person,
              ip.id   AS invoice_partner_id,
              ip.name AS invoice_partner_name,
              ip.eik  AS invoice_partner_eik,
              ip.vat_number AS invoice_partner_vat,
              ip.address    AS invoice_partner_address,
              ip.city       AS invoice_partner_city,
              ip.phone      AS invoice_partner_phone,
              ip.email      AS invoice_partner_email,
              ip.contact_person AS invoice_partner_mol
       FROM orders o
       JOIN partners p ON p.id = o.partner_id
       LEFT JOIN partners ip ON ip.id = o.invoice_partner_id
                             AND ip.id <> o.partner_id
       WHERE o.id = $1`,
      [orderId],
    );
    if (!order) return null;

    // Doc generation skips awaiting lines — these represent goods the
    // customer has asked for but that haven't arrived yet, so they don't
    // belong on the стокова разписка / фактура / приемо-предавателен.
    // The line still lives on the order_items table for the in-app
    // detail view (so the cashier sees "this order also has an item on
    // hold for stock"), but every document the customer signs/receives
    // reflects only what's actually being handed over.
    // GQF: батчите и сроковете на годност са върнати (мигр. 080).
    // JOIN-ваме batches по oi.batch_id, за да покажем партида + срок
    // в drawer-а и PDF документите. При невъведен batch_id (legacy
    // редове) batch_number/expiry_date просто остават NULL.
    const { rows: items } = await db.query(
      `SELECT oi.*,
              oi.name_bg_snapshot AS name_bg,
              oi.name_en_snapshot AS name_en,
              oi.sku_snapshot     AS sku,
              pr.unit, pr.brand,
              b.batch_number,
              b.expiry_date
       FROM order_items oi
       LEFT JOIN products pr ON pr.id = oi.product_id
       LEFT JOIN batches  b  ON b.id  = oi.batch_id
       WHERE oi.order_id = $1
         AND oi.line_status != 'awaiting'
       ORDER BY oi.id`,
      [orderId],
    );

    return { order, items };
  }

  // Pick the partner that should appear as the receiver on transaction
  // documents (Стокова разписка, Оферта, ППП, header). When an active
  // invoice override is present (loadOrderWithBatches surfaced
  // `invoice_partner_*`), prefer it; otherwise fall back to the original
  // order partner. Keeps the four PDF endpoints uniform without each one
  // re-implementing the precedence rule.
  function effectiveReceiver(order: any) {
    if (order?.invoice_partner_id) {
      return {
        name: order.invoice_partner_name,
        eik: order.invoice_partner_eik,
        vat_number: order.invoice_partner_vat,
        address: order.invoice_partner_address,
        city: order.invoice_partner_city,
        phone: order.invoice_partner_phone,
        email: order.invoice_partner_email,
        mol: order.invoice_partner_mol,
        contact_person: order.invoice_partner_mol,
      };
    }
    return {
      name: order.partner_name,
      eik: order.partner_eik,
      vat_number: order.partner_vat,
      address: order.partner_address,
      city: order.partner_city,
      phone: order.partner_phone,
      email: order.partner_email,
      mol: order.partner_mol,
      contact_person: order.partner_contact_person ?? order.partner_mol,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // GET /:id/stock-dispatch-pdf — Стокова разписка
  // ════════════════════════════════════════════════════════════════════
  app.get<{
    Params: { id: string };
    Querystring: { include_vat?: string; pricing_mode?: string };
  }>(
    "/:id/stock-dispatch-pdf",
    { preHandler: ordersManagePreHandler },
    async (request, reply) => {
      const id = Number(request.params.id);
      const data = await loadOrderWithBatches(id);
      if (!data) return reply.status(404).send({ error: "Order not found" });

      const { order, items } = data;

      // Замяна (product replacement) → render the dual-section
      // "Стокова разписка за Замяна" template instead of the standard one.
      // Replacement orders skip the standard "must be confirmed first"
      // status gate: the cashier finalises замяна at the counter and
      // wants the printed document immediately, regardless of whether
      // the order has been formally moved to a later workflow stage.
      // The order's items already carry `is_returning` snapshots so the
      // PDF can split them into the give / return sections without a
      // second query. Total comes signed from the validated order
      // (positive = customer pays, negative = customer refunded).
      // Payment method (cash/pos/bank) lives on a single `payments` row
      // created at finalize-time — we look it up here so the PDF can show
      // both the "Платено в …" / "Възстановено в …" line and the
      // descriptive sentence's correct verb.
      if (order.is_replacement) {
        const docNumber =
          order.order_number != null
            ? String(order.order_number)
            : `25-${String(order.id).padStart(6, "0")}`;
        const partner = effectiveReceiver(order);

        const { rows: paymentRows } = await query(
          `SELECT payment_method
             FROM payments
            WHERE order_id = $1
            ORDER BY paid_at DESC
            LIMIT 1`,
          [id],
        );
        const persistedMethod = paymentRows[0]?.payment_method as
          | string
          | undefined;
        const paymentMethod:
          | "cash"
          | "pos"
          | "bank"
          | "bank_transfer"
          | undefined =
          persistedMethod === "cash" ||
          persistedMethod === "pos" ||
          persistedMethod === "bank" ||
          persistedMethod === "bank_transfer"
            ? persistedMethod
            : undefined;

        const buf = await renderReplacementPdf({
          id: order.id,
          number: docNumber,
          date: new Date(order.order_date || order.created_at),
          partner: {
            name: partner.name || "—",
            egn_or_eik: partner.eik || null,
            address: partner.address || null,
          },
          items: items.map((i: any) => ({
            product_name: i.name_bg || i.name_en || "—",
            product_code: i.sku || "",
            quantity: parseFloat(i.quantity),
            unit_price: parseFloat(i.unit_price),
            is_returning: i.is_returning === true,
          })),
          total: parseFloat(order.total_amount ?? 0),
          payment_method: paymentMethod,
        });
        const filename = `Стокова_разписка_за_Замяна_${docNumber}.pdf`;
        const encodedFilename = encodeURIComponent(filename);
        return reply
          .header("Content-Type", "application/pdf")
          .header(
            "Content-Disposition",
            `inline; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`,
          )
          .send(buf);
      }

      // Standard razpiska gate — non-replacement orders must be at
      // confirmed status or later before a stock-dispatch slip prints.
      if (
        order.status !== "confirmed" &&
        order.status !== "processing" &&
        order.status !== "fulfilled" &&
        order.status !== "invoiced"
      ) {
        return reply.status(400).send({
          error:
            "Стокова разписка може да се генерира само за потвърдени поръчки нататък",
        });
      }

      // For invoiced orders, use the VAT setting from the invoice; otherwise use query param
      let includeVat: boolean;
      if (order.invoice_id) {
        const {
          rows: [inv],
        } = await query("SELECT include_vat FROM invoices WHERE id = $1", [
          order.invoice_id,
        ]);
        includeVat = inv?.include_vat !== false;
      } else {
        includeVat = (request.query as any).include_vat !== "false";
      }

      const pricingMode: "net" | "gross" =
        (request.query as any).pricing_mode === "gross" ? "gross" : "net";

      const company = await getCompanySettings();
      const docNumber = `SR-${String(order.order_number || order.id).padStart(7, "0")}`;

      // Generate PDF in temp dir
      const pdfDir = path.resolve(process.cwd(), "data", "documents");
      if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
      const outputPath = path.join(
        pdfDir,
        `stock-dispatch-${id}-${pricingMode}.pdf`,
      );

      await generateStockDispatchPdf({
        doc_number: docNumber,
        doc_date: order.order_date || order.created_at,
        company,
        partner: effectiveReceiver(order),
        warehouse_name: "Склад Овча Купел",
        // GQF: Стоковата разписка е ЧИСТА — без партида/срок на годност.
        // Тези данни се появяват само на търговския документ. Затова тук
        // НЕ подаваме batch_number/expiry_date (рендерът на разписката и
        // без друго не ги изобразява).
        items: items.map((i: any) => ({
          sku: i.sku,
          name_bg: i.name_bg,
          name_en: i.name_en,
          brand: i.brand,
          unit: i.unit,
          quantity: parseFloat(i.quantity),
          unit_price: parseFloat(i.unit_price),
          discount_percent: parseFloat(i.discount_percent ?? 0),
          total_price: parseFloat(i.total_price),
        })),
        vat_rate: includeVat ? 20 : 0,
        pricing_mode: pricingMode,
        outputPath,
        show_bgn: company.show_bgn_on_invoice === true,
      });

      const stream = fs.createReadStream(outputPath);
      const suffix = pricingMode === "gross" ? "_с_ДДС" : "";
      const filename = `Стокова_разписка_${docNumber}${suffix}.pdf`;
      const encodedFilename = encodeURIComponent(filename);

      return (
        reply
          .header("Content-Type", "application/pdf")
          .header(
            "Content-Disposition",
            `inline; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`,
          )
          // Path on the backend filesystem so the frontend can ask
          // /print/zebra to spool it without re-uploading the bytes.
          .header("X-Pdf-Path", outputPath)
          .header("Access-Control-Expose-Headers", "X-Pdf-Path")
          .send(stream)
      );
    },
  );

  // ════════════════════════════════════════════════════════════════════
  // GET /:id/commercial-doc-pdf — Търговски документ
  // ════════════════════════════════════════════════════════════════════
  app.get<{ Params: { id: string } }>(
    "/:id/commercial-doc-pdf",
    { preHandler: ordersManagePreHandler },
    async (request, reply) => {
      const id = Number(request.params.id);
      const data = await loadOrderWithBatches(id);
      if (!data) return reply.status(404).send({ error: "Order not found" });

      const { order, items } = data;
      if (
        order.status !== "confirmed" &&
        order.status !== "processing" &&
        order.status !== "fulfilled" &&
        order.status !== "invoiced"
      ) {
        return reply.status(400).send({
          error:
            "Търговски документ може да се генерира само за потвърдени поръчки нататък",
        });
      }

      const company = await getCompanySettings();
      const docNumber = `TD-${String(order.order_number || order.id).padStart(7, "0")}`;

      const pdfDir = path.resolve(process.cwd(), "data", "documents");
      if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
      const outputPath = path.join(pdfDir, `commercial-doc-${id}.pdf`);

      // GQF: Търговският документ показва партида + срок на годност за всеки
      // продукт, с по ОТДЕЛЕН РЕД на партида. Ако поръчковият ред е изпълнен
      // от няколко партиди (FEFO split), той се появява като няколко реда —
      // същият продукт, всеки с номера/срока/количеството на своята партида.
      // Източникът е order_item_batches (записан при експедиране).
      const { rows: allocationRows } = await query(
        `SELECT oi.id AS order_item_id,
                oi.sku_snapshot     AS sku,
                oi.name_bg_snapshot AS name_bg,
                oi.name_en_snapshot AS name_en,
                pr.unit, pr.brand,
                oib.quantity        AS batch_qty,
                b.batch_number,
                b.expiry_date
           FROM order_items oi
           JOIN order_item_batches oib ON oib.order_item_id = oi.id
           JOIN batches b ON b.id = oib.batch_id
           LEFT JOIN products pr ON pr.id = oi.product_id
          WHERE oi.order_id = $1
            AND oi.line_status != 'awaiting'
          ORDER BY oi.id, b.expiry_date ASC NULLS LAST, b.id`,
        [id],
      );

      // Групираме разпределенията по order_item_id, за да можем да слеем
      // редовете с партиди и fallback-редовете при запазен ред на поръчката.
      const allocationsByItem = new Map<number, any[]>();
      for (const row of allocationRows) {
        const list = allocationsByItem.get(row.order_item_id) ?? [];
        list.push(row);
        allocationsByItem.set(row.order_item_id, list);
      }

      // За всеки поръчков ред (в реда от loadOrderWithBatches): ако има
      // разпределения по партиди → по ред на партида; иначе → единичен
      // fallback ред (legacy поръчки / неекспедирани редове), за да не
      // изчезне нищо от документа.
      const docItems: Array<{
        sku?: string;
        name_bg?: string;
        name_en?: string;
        brand?: string;
        unit?: string;
        quantity: number;
        batch_number?: string | null;
        expiry_date?: string | null;
      }> = [];
      for (const orderItem of items as any[]) {
        const allocations = allocationsByItem.get(orderItem.id);
        if (allocations && allocations.length > 0) {
          for (const alloc of allocations) {
            docItems.push({
              sku: alloc.sku,
              name_bg: alloc.name_bg,
              name_en: alloc.name_en,
              brand: alloc.brand,
              unit: alloc.unit,
              quantity: parseFloat(alloc.batch_qty),
              batch_number: alloc.batch_number,
              expiry_date: alloc.expiry_date,
            });
          }
        } else {
          docItems.push({
            sku: orderItem.sku,
            name_bg: orderItem.name_bg,
            name_en: orderItem.name_en,
            brand: orderItem.brand,
            unit: orderItem.unit,
            quantity: parseFloat(orderItem.quantity),
            batch_number: orderItem.batch_number,
            expiry_date: orderItem.expiry_date,
          });
        }
      }

      await generateCommercialDocPdf({
        doc_number: docNumber,
        doc_date: order.order_date || order.created_at,
        company,
        partner: effectiveReceiver(order),
        items: docItems,
        outputPath,
      });

      const stream = fs.createReadStream(outputPath);
      const filename = `Търговски_документ_${docNumber}.pdf`;
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

  // ════════════════════════════════════════════════════════════════════
  // GET /:id/offer-pdf — ОФЕРТА (Quotation)
  // ════════════════════════════════════════════════════════════════════
  // Only available while the order is in `quoted` status. Renders an
  // OF-NNNNNNN PDF used by the cashier to print a take-home offer for
  // the customer. Stock is NOT deducted; the order is still convertible
  // to pending → confirmed via POST /:id/unquote.
  app.get<{ Params: { id: string } }>(
    "/:id/offer-pdf",
    { preHandler: ordersManagePreHandler },
    async (request, reply) => {
      const id = Number(request.params.id);
      const data = await loadOrderWithBatches(id);
      if (!data) return reply.status(404).send({ error: "Order not found" });

      const { order, items } = data;
      // Quoted orders use it as their primary document; for confirmed +
      // beyond, it's an additional informational price summary the cashier
      // can hand to the customer alongside Стокова разписка / Търговски
      // документ. Cancelled orders shouldn't generate new offers.
      if (order.status === "cancelled") {
        return reply.status(400).send({
          error: "Оферта не може да се генерира за анулирана поръчка.",
        });
      }

      const offerNumber = `OF-${String(order.order_number || order.id).padStart(7, "0")}`;
      const company = await getCompanySettings();

      const totalGross = items.reduce(
        (sum: number, it: any) => sum + parseFloat(it.total_price || 0),
        0,
      );
      const totalNet = totalGross / 1.2;
      const totalVat = totalGross - totalNet;

      const pdfDir = path.resolve(process.cwd(), "data", "documents");
      if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
      const outputPath = path.join(pdfDir, `offer-${id}.pdf`);

      await generateOfferPdf({
        offerNumber,
        date: (order.order_date || order.created_at || new Date().toISOString())
          .toString()
          .slice(0, 10),
        partner: effectiveReceiver(order),
        company: {
          name: company.company_name,
          eik: company.eik,
          vat_number: company.vat_number,
          address: company.address,
          city: company.city,
          phone: company.phone,
          email: company.email,
          mol: company.mol,
        },
        items: items.map((i: any) => ({
          name_bg: i.name_bg,
          quantity: parseFloat(i.quantity),
          unit: i.unit || "бр",
          unit_price: parseFloat(i.unit_price),
          discount_percent: parseFloat(i.discount_percent ?? 0),
          total_price: parseFloat(i.total_price),
        })),
        totalNet,
        totalVat,
        totalGross,
        outputPath,
        showBgn: company.show_bgn_on_invoice === true,
      });

      const stream = fs.createReadStream(outputPath);
      const filename = `Оферта_${offerNumber}.pdf`;
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

  // ════════════════════════════════════════════════════════════════════
  // GET /:id/warranty-pdf — Гаранционна карта
  // ════════════════════════════════════════════════════════════════════
  // Serial number = WR-<order_number padded to 7 digits>, so the warranty
  // can be traced back to the source order / invoice. All other fields are
  // filled by hand.
  app.get<{
    Params: { id: string };
    Querystring: {
      items?: string;
      buyer_name?: string;
      months?: string;
    };
  }>(
    "/:id/warranty-pdf",
    { preHandler: ordersManagePreHandler },
    async (request, reply) => {
      const id = Number(request.params.id);
      const { rows: orderRows } = await query(
        `SELECT o.id, o.order_number, o.order_date, o.partner_id,
                o.invoice_partner_id,
                p.name AS partner_name, p.partner_type, p.eik AS partner_eik,
                p.address AS partner_address, p.city AS partner_city,
                ip.name AS invoice_partner_name, ip.eik AS invoice_partner_eik,
                ip.address AS invoice_partner_address, ip.city AS invoice_partner_city
           FROM orders o
           JOIN partners p ON p.id = o.partner_id
           LEFT JOIN partners ip ON ip.id = o.invoice_partner_id
          WHERE o.id = $1`,
        [id],
      );
      if (!orderRows.length)
        return reply.status(404).send({ error: "Order not found" });

      const order = orderRows[0];
      const serialNumber = `WR-${String(order.order_number || order.id).padStart(7, "0")}`;

      // Optional comma-separated list of order_item ids — when present
      // the warranty includes ONLY those lines, otherwise all items on
      // the order. Lets the cashier issue a partial-coverage warranty
      // (e.g. only durable goods, skipping the ones that don't carry it).
      const itemIdsParam = (request.query.items ?? "").trim();
      const itemIds = itemIdsParam
        ? itemIdsParam
            .split(",")
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => Number.isFinite(n) && n > 0)
        : [];

      const itemsSql = itemIds.length
        ? `SELECT id, name_bg_snapshot AS name_bg, sku_snapshot AS sku, quantity
             FROM order_items
            WHERE order_id = $1 AND id = ANY($2::int[])
            ORDER BY id`
        : `SELECT id, name_bg_snapshot AS name_bg, sku_snapshot AS sku, quantity
             FROM order_items
            WHERE order_id = $1
            ORDER BY id`;
      const { rows: items } = await query(
        itemsSql,
        itemIds.length ? [id, itemIds] : [id],
      );
      if (!items.length)
        return reply
          .status(400)
          .send({ error: "Не са избрани артикули за гаранция." });

      // Buyer resolution priority:
      //   1. invoice_partner_id (override → company)  → use that partner's data
      //   2. partner_type=individual + body buyer_name → use the override name
      //   3. partner_type=legal_entity                 → partner.name
      //   4. partner_type=individual without override  → 400 (require name)
      const overrideBuyer = (request.query.buyer_name ?? "").trim();
      let buyerName: string;
      let buyerEik: string | null = null;
      let buyerAddress: string | null = null;
      if (order.invoice_partner_id && order.invoice_partner_name) {
        buyerName = order.invoice_partner_name;
        buyerEik = order.invoice_partner_eik ?? null;
        buyerAddress = [
          order.invoice_partner_city,
          order.invoice_partner_address,
        ]
          .filter(Boolean)
          .join(", ");
      } else if (order.partner_type === "legal_entity") {
        buyerName = order.partner_name;
        buyerEik = order.partner_eik ?? null;
        buyerAddress = [order.partner_city, order.partner_address]
          .filter(Boolean)
          .join(", ");
      } else if (overrideBuyer) {
        buyerName = overrideBuyer;
      } else if (
        order.partner_type === "individual" &&
        order.partner_name !== "Физическо лице — краен потребител"
      ) {
        // Named individual partner row — use the partner data directly.
        buyerName = order.partner_name;
        buyerAddress = [order.partner_city, order.partner_address]
          .filter(Boolean)
          .join(", ");
      } else {
        return reply.status(400).send({
          error:
            "Гаранцията се издава на конкретно име. Подайте име на купувача.",
          require_buyer_name: true,
        });
      }

      const months = (() => {
        const m = parseInt(request.query.months ?? "", 10);
        return Number.isFinite(m) && m > 0 && m <= 120 ? m : 12;
      })();

      const company = await getCompanySettings();

      const pdfDir = path.resolve(process.cwd(), "data", "documents");
      if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
      const outputPath = path.join(pdfDir, `warranty-${id}.pdf`);

      const stockDispatchNumber = `SR-${String(order.order_number || order.id).padStart(7, "0")}`;
      await generateWarrantyCardPdf({
        serial_number: serialNumber,
        purchase_date: order.order_date.toISOString().slice(0, 10),
        warranty_months: months,
        buyer_name: buyerName,
        buyer_eik: buyerEik || undefined,
        buyer_address: buyerAddress || undefined,
        seller: {
          name: company.company_name,
          eik: company.eik,
          address: [company.city, company.address].filter(Boolean).join(", "),
          phone: company.phone || undefined,
        },
        items: items.map((it: any) => ({
          name_bg: it.name_bg,
          sku: it.sku,
          quantity: it.quantity,
          unit: "бр",
        })),
        stock_dispatch_number: stockDispatchNumber,
        outputPath,
      });

      // Record first-issuance so the order detail view can show the
      // warranty number. Idempotent: re-downloads don't shift the
      // timestamp once set.
      await query(
        `UPDATE orders
           SET warranty_issued_at = NOW()
         WHERE id = $1 AND warranty_issued_at IS NULL`,
        [id],
      );

      const stream = fs.createReadStream(outputPath);
      const filename = `Гаранционна_карта_${serialNumber}.pdf`;
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

  // ════════════════════════════════════════════════════════════════════
  // GET /:id/protocol-pdf — Приемо-предавателен протокол
  // ════════════════════════════════════════════════════════════════════
  // Optional query overrides let the user adjust place/date/reps in a
  // dialog before download (rare in B2B; most fields default from the
  // partner + company settings).
  app.get<{
    Params: { id: string };
    Querystring: {
      place?: string;
      date?: string;
      seller_rep?: string;
      buyer_rep?: string;
    };
  }>(
    "/:id/protocol-pdf",
    { preHandler: ordersManagePreHandler },
    async (request, reply) => {
      const id = Number(request.params.id);
      const data = await loadOrderWithBatches(id);
      if (!data) return reply.status(404).send({ error: "Order not found" });

      const { order, items } = data;

      const company = await getCompanySettings();
      const {
        rows: [partner],
      } = await query(
        "SELECT name, eik, vat_number, address, city, email, contact_person FROM partners WHERE id = $1",
        [order.partner_id],
      );

      const today = new Date().toISOString().split("T")[0];
      const protocolNumber = `PR-${String(order.order_number || order.id).padStart(7, "0")}`;
      const stockDispatchNumber = `SR-${String(order.order_number || order.id).padStart(7, "0")}`;
      const invoiceNumber = order.invoice_id
        ? (
            await query("SELECT invoice_number FROM invoices WHERE id = $1", [
              order.invoice_id,
            ])
          ).rows[0]?.invoice_number
        : null;

      const totalAmount = items.reduce(
        (sum: number, it: any) => sum + parseFloat(it.total_price),
        0,
      );

      const pdfDir = path.resolve(process.cwd(), "data", "documents");
      if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
      const outputPath = path.join(pdfDir, `protocol-${id}.pdf`);

      await generateProtocolPdf({
        protocolNumber,
        orderNumber: order.order_number ?? order.id,
        invoiceNumber,
        stockDispatchNumber,
        date: request.query.date || today,
        place: request.query.place || company.city || "София",
        seller: {
          name: company.company_name,
          eik: company.eik,
          vat_number: company.vat_number,
          address: [company.city, company.address].filter(Boolean).join(", "),
          email: company.email,
          mol: company.mol,
          rep: request.query.seller_rep || company.mol || "",
        },
        buyer: {
          name: partner?.name || "",
          eik: partner?.eik ?? null,
          vat_number: partner?.vat_number ?? null,
          address: [partner?.city, partner?.address].filter(Boolean).join(", "),
          email: partner?.email ?? null,
          mol: partner?.contact_person ?? null,
          rep: request.query.buyer_rep || partner?.contact_person || "",
        },
        items: items.map((it: any) => ({
          name_bg: it.name_bg,
          quantity: it.quantity,
          unit: it.unit || "бр.",
          unit_price: it.unit_price,
          total_price: it.total_price,
        })),
        totalAmount,
        outputPath,
        showBgn: company.show_bgn_on_invoice === true,
      });

      const stream = fs.createReadStream(outputPath);
      const filename = `Протокол_${protocolNumber}.pdf`;
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

  // ════════════════════════════════════════════════════════════════════
  // GET /:id/packing-label-pdf — Бележка за пакетиране
  // ════════════════════════════════════════════════════════════════════
  // Internal A6 label that warehouse staff print and stick on the box
  // while preparing the order — same printer as the Econt waybill, but
  // generated locally so it works for pickup orders too.
  app.get<{ Params: { id: string } }>(
    "/:id/packing-label-pdf",
    { preHandler: ordersManagePreHandler },
    async (request, reply) => {
      const id = Number(request.params.id);
      const data = await loadOrderWithBatches(id);
      if (!data) return reply.status(404).send({ error: "Order not found" });

      const { order, items } = data;
      const receiver = effectiveReceiver(order);

      // Delivery line — Econt city/office or address, otherwise pickup.
      // Plain text only, no emoji: Roboto has no emoji glyphs and would
      // render them as tofu boxes on the printed label.
      let deliveryLabel = "Вземане на място";
      if (order.econt_city) {
        if (order.econt_delivery_type === "address" && order.econt_street) {
          deliveryLabel = `Еконт адрес: ${order.econt_city}, ${order.econt_street}${
            order.econt_street_num ? ` №${order.econt_street_num}` : ""
          }`;
        } else if (order.econt_office_name) {
          deliveryLabel = `Еконт офис: ${order.econt_city} — ${order.econt_office_name}`;
        } else {
          deliveryLabel = `Еконт: ${order.econt_city}`;
        }
      }

      const pdfDir = path.resolve(process.cwd(), "data", "documents");
      if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
      const outputPath = path.join(pdfDir, `packing-label-${id}.pdf`);

      // Бележката за пакетиране е чисто складов документ — кешъра/
      // склада физически вземат само "normal" линиите. paid_not_taken
      // (клиентът вече е платил, ще си го вземе при следващо посещение)
      // и awaiting (pre-order, чака стока) не отиват в пакета.
      //
      // PICKUP режим (миграция 079): когато поръчката е fulfilled и има
      // pending_pickup линии, бележката се препечатва за финалното
      // ПРЕДАВАНЕ на платена-невзета стока — там показваме само
      // pending_pickup редовете (не normal-ите, които вече са взети).
      const hasPending = items.some(
        (it: any) => it.line_status === "pending_pickup",
      );
      const isPickupHandover = order.status === "fulfilled" && hasPending;
      const packingItems = items.filter((it: any) => {
        const ls = it.line_status ?? "normal";
        return isPickupHandover ? ls === "pending_pickup" : ls === "normal";
      });

      // Нормализация на unit-а — DB може да съдържа "pcs" (legacy
      // английска стойност). Складът чете на български и UI-ът има
      // unitLabels мапинг ("pcs" → "бр."); правим същото и за принт.
      const UNIT_BG: Record<string, string> = {
        pcs: "бр.",
        box: "кутия",
        pack: "пакет",
        kg: "кг",
        g: "г",
        l: "л",
        ml: "мл",
      };
      const localizeUnit = (u: string | null | undefined): string => {
        if (!u) return "бр.";
        return UNIT_BG[u.toLowerCase()] ?? u;
      };

      await generatePackingLabelPdf({
        orderNumber: order.order_number ?? order.id,
        partnerName: receiver.name || `Партньор #${order.partner_id}`,
        preparedAt: new Date(),
        items: packingItems.map((it: any) => ({
          name_bg: it.name_bg || it.name_en || `Продукт #${it.product_id}`,
          quantity: it.quantity,
          unit: localizeUnit(it.unit),
          is_returning: Boolean(it.is_returning),
        })),
        deliveryLabel,
        notes: order.notes ?? null,
        outputPath,
        isReplacement: Boolean(order.is_replacement),
        isPickupHandover,
      });

      const stream = fs.createReadStream(outputPath);
      const filename = `Бележка_поръчка_${order.order_number ?? order.id}.pdf`;
      const encodedFilename = encodeURIComponent(filename);

      return (
        reply
          .header("Content-Type", "application/pdf")
          .header(
            "Content-Disposition",
            `inline; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`,
          )
          // Path on the backend filesystem so the frontend can ask
          // /print/zebra to spool it without re-uploading the bytes.
          .header("X-Pdf-Path", outputPath)
          .header("Access-Control-Expose-Headers", "X-Pdf-Path")
          .send(stream)
      );
    },
  );
}
