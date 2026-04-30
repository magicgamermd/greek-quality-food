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
import { orderLineStatusSchema } from "../lib/order-line-status.js";
import {
  computeBelowCostItems,
  type ProductCost,
} from "../utils/below-cost.js";
import {
  generateStockDispatchPdf,
  generateCommercialDocPdf,
} from "../services/document-pdf.js";
import { generateInvoicePdf } from "../services/invoice-pdf.js";
import { generateWarrantyCardPdf } from "../services/warranty-pdf.js";
import { generateOfferPdf } from "../services/offer-pdf.js";
import { generateProtocolPdf } from "../services/protocol-pdf.js";
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

// MERT-M sells durable goods (Hendi, Bartscher, KitchenAid, Liebherr), so
// order items are NOT linked to batches. The legacy `batch_id`, `batch_number`,
// and `expiry_date` fields are gone from the input schema; FEFO allocation and
// the `resolveBatchIdForItem()` helper have been deleted. Stock is deducted
// per-product via a direct `UPDATE inventory` on the partial-unique row
// (product_id, warehouse_id) WHERE batch_id IS NULL — see migration 045.
const orderItemSchema = z.object({
  product_id: z.number().int(),
  quantity: z.number().positive(),
  unit_price: z.number().min(0).optional(),
  // Per-line отстъпка % (0–100). Прилага се при запис на total_price.
  // Default 0 → backward-compatible за стари callers които не подават.
  discount_percent: z.number().min(0).max(100).optional().default(0),
  // Batch F1: per-line state. Optional; defaults to 'normal' on the
  // backend side via orderLineStatusSchema's .default.
  line_status: orderLineStatusSchema.optional(),
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
  items: z.array(orderItemSchema).min(1),
  // Admin-only override: explicit acknowledgement that one or more lines
  // are priced below products.purchase_price. Backend re-validates and
  // hard-rejects when this flag is omitted but lines are below cost.
  allow_below_cost: z.boolean().optional().default(false),
  // Initial status — only "pending" (default) or "quoted" allowed at create
  // time. Quoted orders skip stock validation and never deduct inventory
  // until they're moved to pending → confirmed.
  status: z.enum(["pending", "quoted"]).optional().default("pending"),
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
              OR p.brand ILIKE $${paramIdx + 1}
            )`,
          );
          params.push(word, `%${escaped}%`);
          paramIdx += 2;
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
      request_number,
      object_query,
      q,
      below_cost_only,
      article,
      has_paid_not_taken,
      has_awaiting,
    } = request.query as any;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const offset = (pageNum - 1) * pageSize;

    let where = "WHERE 1=1";
    const params: any[] = [];
    let paramIdx = 1;

    if (status) {
      where += ` AND o.status = $${paramIdx++}`;
      params.push(status);
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
             ${ORDER_OBJECT_NAME_SQL} AS object_name,
             ${ORDER_OBJECT_CODE_SQL} AS object_code,
             (o.invoice_id IS NOT NULL) AS invoiced
      FROM orders o
      JOIN partners p ON p.id = o.partner_id
      LEFT JOIN invoices inv ON inv.id = o.invoice_id
      LEFT JOIN invoices cn ON cn.related_invoice_id = inv.id
          AND cn.document_type = 'credit_note'
      LEFT JOIN partner_order_objects po ON po.id = o.partner_object_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS item_count
        FROM order_items oi
        WHERE oi.order_id = o.id
      ) ic ON TRUE
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

  // GET /orders/:id
  app.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    const { id } = request.params as { id: string };

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
              ${STOCK_DISPATCH_NUMBER_SQL} AS stock_dispatch_number,
              ${COMMERCIAL_DOC_NUMBER_SQL} AS commercial_document_number,
              ${WARRANTY_NUMBER_SQL} AS warranty_number,
              ${ORDER_OBJECT_NAME_SQL} AS object_name,
              ${ORDER_OBJECT_CODE_SQL} AS object_code,
              (o.invoice_id IS NOT NULL) AS invoiced,
              approver.name AS below_cost_approved_by_name
       FROM orders o
       JOIN partners p ON p.id = o.partner_id
       LEFT JOIN invoices inv ON inv.id = o.invoice_id
       LEFT JOIN invoices cn ON cn.related_invoice_id = inv.id
           AND cn.document_type = 'credit_note'
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

          const validationResult = await validateRequestedStock(
            client,
            body.items,
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
          const belowCostInput = body.items.map((it) => {
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

          // Create order with sequential order_number
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
           status, order_number
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                 $21, $22,
                 $23, $24, $25,
                 $26, nextval('order_number_seq'))
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
              body.status,
            ],
          );

          let totalAmount = 0;
          const items = [];

          for (const item of body.items) {
            // Price resolution chain: explicit > partner price list > product selling_price > 0
            const prod = productMap.get(item.product_id) as any;
            const unitPrice =
              item.unit_price ??
              priceMap.get(item.product_id) ??
              (prod?.selling_price ? parseFloat(prod.selling_price) : null) ??
              0;
            // total_price е post-discount (qty × цена × (1 − отст/100)), закръглено
            // до 2 знака защото колоната е numeric(12,2) — така СУМ-ите в фактурата
            // не се разминават с визуалните стойности по редовете.
            const discountPct = item.discount_percent ?? 0;
            const totalPrice = Number(
              (item.quantity * unitPrice * (1 - discountPct / 100)).toFixed(2),
            );
            totalAmount += totalPrice;

            if (!prod) {
              throw Object.assign(
                new Error(`Product ${item.product_id} not found`),
                { statusCode: 400 },
              );
            }

            const {
              rows: [orderItem],
            } = await client.query(
              `INSERT INTO order_items
                 (order_id, product_id, quantity, unit_price, discount_percent, total_price,
                  name_bg_snapshot, name_en_snapshot, sku_snapshot, line_status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
              [
                order.id,
                item.product_id,
                item.quantity,
                unitPrice,
                discountPct,
                totalPrice,
                prod.name_bg,
                prod.name_en,
                prod.sku,
                item.line_status ?? "normal",
              ],
            );
            items.push(orderItem);
          }

          // Update total
          await client.query(
            "UPDATE orders SET total_amount = $1 WHERE id = $2",
            [totalAmount, order.id],
          );

          // Notification
          await client.query(
            `INSERT INTO notifications (type, message) VALUES ('order_created', $1)`,
            [
              `Нова поръчка #${order.id} от ${partner.name} на стойност ${totalAmount.toFixed(2)} €`,
            ],
          );

          return {
            ...order,
            total_amount: totalAmount,
            items,
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

              // MERT-M: COGS is captured from products.purchase_price at the
              // moment the order is (re)committed to stock. Batch-sourced COGS
              // (cost_source_batch_id) is obsolete — left NULL in the DB.
              let costUnitPrice: number | null = null;
              if (mustReconcileStock) {
                // Edit-order flow has historically allowed negative
                // inventory (no pre-check). Preserve that behaviour
                // explicitly so the new helper signature doesn't tighten
                // edits unintentionally; line_status enforcement happens
                // in the fulfill flow.
                costUnitPrice = await deductProductStock(
                  client,
                  item.product_id,
                  item.quantity,
                  { allowNegative: true },
                );
              }

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
                  costUnitPrice,
                  snap.name_bg,
                  snap.name_en,
                  snap.sku,
                  (item as any).line_status ?? "normal",
                ],
              );
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
            if (oversell_items.length > 0) {
              putResponse.warnings = { oversell: oversell_items };
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

        // MERT-M: simple per-product deduction. COGS snapshot comes from
        // products.purchase_price; batch-sourced COGS (cost_source_batch_id)
        // stays NULL since there are no batches for durable goods.
        //
        // Batch F1: branch on line_status —
        //   - 'awaiting'        → pre-order; skip entirely (no stock, no COGS)
        //   - 'paid_not_taken'  → customer already paid; allow inventory
        //                          to go negative (promised stock)
        //   - 'normal' (default) → standard pre-checked deduction
        for (const item of items) {
          if (item.line_status === "awaiting") {
            continue;
          }
          const allowNegative = item.line_status === "paid_not_taken";
          const costUnitPrice = await deductProductStock(
            client,
            item.product_id,
            parseFloat(item.quantity),
            { allowNegative },
          );

          await client.query(
            `UPDATE order_items
             SET cost_unit_price = $1
             WHERE id = $2`,
            [costUnitPrice, item.id],
          );
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

  // POST /orders/:id/items/:itemId/handover — Batch F1
  // Flip a paid_not_taken line to normal (customer has now picked up the
  // already-deducted goods). No stock change — the deduction happened at
  // fulfill time with allowNegative=true. Idempotent guard rejects the
  // call if the line is in any other status.
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
        if (item.line_status !== "paid_not_taken") {
          throw Object.assign(
            new Error("Only paid_not_taken lines can be handed over."),
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
        const costUnitPrice = await deductProductStock(
          client,
          item.product_id,
          parseFloat(item.quantity),
          { allowNegative: false },
        );
        const {
          rows: [updated],
        } = await client.query(
          `UPDATE order_items
             SET line_status = 'normal',
                 cost_unit_price = $1
           WHERE id = $2 RETURNING *`,
          [costUnitPrice, itemId],
        );
        return updated;
      });
    },
  );

  // POST /orders/:id/quote — pending → quoted. Cashier prints an offer
  // (OF-XXX) and waits for the customer; quoted orders never deduct stock.
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
        if (order.status !== "pending") {
          throw Object.assign(
            new Error(
              "Само поръчки със статус 'Чакаща' могат да се прехвърлят в оферта.",
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
          // against concurrent fulfill/invoice operations.
          await client.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [
            id,
          ]);

          // Return each item's quantity to inventory. MERT-M: no batches,
          // so we upsert on the partial unique index
          // inventory_product_warehouse_nobatch_uidx (product_id, warehouse_id)
          // WHERE batch_id IS NULL (added in migration 045).
          const { rows: items } = await client.query(
            "SELECT product_id, quantity FROM order_items WHERE order_id = $1",
            [id],
          );

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

          // Cancel the order
          await client.query(
            "UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
            [id],
          );

          return items.length;
        });

        await query(
          `INSERT INTO notifications (type, message) VALUES ('order_cancelled', $1)`,
          [`Поръчка #${id} е отменена. ${result} артикула върнати в склада.`],
        );

        return {
          message: "Order cancelled. Stock returned to inventory.",
          order_id: parseInt(id),
          items_returned: result,
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

  /**
   * MERT-M per-product stock deduction — back-order aware.
   *
   * First attempts an atomic UPDATE without a quantity guard so the
   * inventory row is allowed to go negative (sells into the red). If
   * no row exists for this product/warehouse yet, fall back to an
   * INSERT with a negative quantity; the partial unique index
   * `inventory_product_warehouse_nobatch_uidx` (migration 045) keeps
   * this safe against concurrent inserts because there is only one
   * batch_id-NULL row per product/warehouse.
   *
   * Returns the COGS unit price snapshotted from products.purchase_price
   * for later profit reporting (unchanged from the old behaviour).
   */
  async function deductProductStock(
    db: DbExecutor,
    productId: number,
    quantity: number,
    options: { allowNegative?: boolean } = {},
  ): Promise<number | null> {
    const { allowNegative = false } = options;

    // Pre-check: refuse to go below zero unless the caller explicitly
    // opted in (used by paid_not_taken lines, where the customer has
    // already paid so promised stock can run negative).
    if (!allowNegative) {
      const {
        rows: [inv],
      } = await db.query(
        `SELECT COALESCE(SUM(quantity), 0)::numeric AS qty
           FROM inventory
          WHERE product_id = $1 AND warehouse_id = 1`,
        [productId],
      );
      const current = parseFloat(inv?.qty ?? "0");
      if (current < quantity) {
        throw Object.assign(
          new Error(
            `Insufficient stock for product ${productId}: have ${current}, need ${quantity}`,
          ),
          { statusCode: 409 },
        );
      }
    }

    const { rowCount } = await db.query(
      `UPDATE inventory
         SET quantity = quantity - $1,
             updated_at = NOW()
       WHERE product_id = $2
         AND warehouse_id = 1
         AND batch_id IS NULL
       RETURNING quantity`,
      [quantity, productId],
    );

    if (!rowCount) {
      // No inventory row at all — a product that has never been
      // delivered yet is being sold. Create a row starting at -qty.
      await db.query(
        `INSERT INTO inventory (product_id, warehouse_id, quantity, batch_id)
         VALUES ($1, 1, $2, NULL)`,
        [productId, -quantity],
      );
    }

    const { rows: productRows } = await db.query(
      "SELECT purchase_price FROM products WHERE id = $1",
      [productId],
    );
    const fallbackCost = parseFloat(productRows[0]?.purchase_price ?? "0");
    return Number.isFinite(fallbackCost) && fallbackCost > 0
      ? fallbackCost
      : null;
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
    // Batch D — when an active invoice was issued with `partner_override`,
    // its receiver (a company) supersedes the original order partner (an
    // individual) on every transaction document: Стокова разписка, Оферта,
    // Приемо-предавателен протокол — and the order drawer header. The JOIN
    // is skipped when the invoice was cancelled or its receiver matches the
    // original partner (no override took place); deletion clears
    // orders.invoice_id via FK ON DELETE SET NULL, so that case yields NULL
    // here too.
    const {
      rows: [order],
    } = await db.query(
      `SELECT o.*,
              p.name AS partner_name, p.eik AS partner_eik,
              p.vat_number AS partner_vat, p.address AS partner_address,
              p.city AS partner_city, p.phone AS partner_phone,
              p.contact_person AS partner_mol,
              p.contact_person AS partner_contact_person,
              ip.id   AS invoice_partner_id,
              ip.name AS invoice_partner_name,
              ip.eik  AS invoice_partner_eik,
              ip.vat_number AS invoice_partner_vat,
              ip.address    AS invoice_partner_address,
              ip.city       AS invoice_partner_city,
              ip.phone      AS invoice_partner_phone,
              ip.contact_person AS invoice_partner_mol
       FROM orders o
       JOIN partners p ON p.id = o.partner_id
       LEFT JOIN invoices inv ON inv.id = o.invoice_id
                              AND inv.status <> 'cancelled'
                              AND inv.partner_id <> o.partner_id
       LEFT JOIN partners ip ON ip.id = inv.partner_id
       WHERE o.id = $1`,
      [orderId],
    );
    if (!order) return null;

    const { rows: items } = await db.query(
      `SELECT oi.*,
              oi.name_bg_snapshot AS name_bg,
              oi.name_en_snapshot AS name_en,
              oi.sku_snapshot     AS sku,
              pr.unit, pr.brand,
              NULL::text AS batch_number,
              NULL::date AS expiry_date
       FROM order_items oi
       LEFT JOIN products pr ON pr.id = oi.product_id
       WHERE oi.order_id = $1
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
        pricing_mode: pricingMode,
        outputPath,
      });

      const stream = fs.createReadStream(outputPath);
      const suffix = pricingMode === "gross" ? "_с_ДДС" : "";
      const filename = `Стокова_разписка_${docNumber}${suffix}.pdf`;
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

      await generateCommercialDocPdf({
        doc_number: docNumber,
        doc_date: order.order_date || order.created_at,
        company,
        partner: effectiveReceiver(order),
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

      const totalNet = items.reduce(
        (sum: number, it: any) => sum + parseFloat(it.total_price || 0),
        0,
      );
      const totalVat = totalNet * 0.2;
      const totalGross = totalNet + totalVat;

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
  app.get<{ Params: { id: string } }>(
    "/:id/warranty-pdf",
    { preHandler: ordersManagePreHandler },
    async (request, reply) => {
      const id = Number(request.params.id);
      const { rows } = await query(
        "SELECT id, order_number FROM orders WHERE id = $1",
        [id],
      );
      if (!rows.length)
        return reply.status(404).send({ error: "Order not found" });

      const order = rows[0];
      const serialNumber = `WR-${String(order.order_number || order.id).padStart(7, "0")}`;

      const pdfDir = path.resolve(process.cwd(), "data", "documents");
      if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
      const outputPath = path.join(pdfDir, `warranty-${id}.pdf`);

      await generateWarrantyCardPdf({
        serial_number: serialNumber,
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
        "SELECT name, eik, contact_person FROM partners WHERE id = $1",
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
          rep: request.query.seller_rep || company.mol || "",
        },
        buyer: {
          name: partner?.name || "",
          eik: partner?.eik ?? null,
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
}
