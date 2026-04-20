import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { type PoolClient } from "pg";
import { z } from "zod";
import { query, transaction } from "../db.js";
import { restoreOrderItemsToInventory } from "../utils/order-stock.js";
import {
  generateStockDispatchPdf,
  generateCommercialDocPdf,
} from "../services/document-pdf.js";
import { generateInvoicePdf } from "../services/invoice-pdf.js";
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

const orderItemSchema = z.object({
  product_id: z.number().int(),
  quantity: z.number().positive(),
  unit_price: z.number().min(0).optional(),
  // Per-line отстъпка % (0–100). Прилага се при запис на total_price.
  // Default 0 → backward-compatible за стари callers които не подават.
  discount_percent: z.number().min(0).max(100).optional().default(0),
  batch_id: z.number().int().positive().nullish(),
  // Optional: manually specify batch_number / expiry_date — server will
  // find an existing matching batch for this product or create a new one.
  batch_number: z.string().nullish(),
  expiry_date: z.string().nullish(),
});

/**
 * Resolve batch_id for an order item. If item.batch_id is set, uses it.
 * Otherwise if batch_number or expiry_date is provided, finds or creates
 * a matching batch for the given product and returns its id.
 */
async function resolveBatchIdForItem(
  client: { query: (sql: string, params?: any[]) => Promise<any> },
  item: {
    product_id: number;
    batch_id?: number | null;
    batch_number?: string | null;
    expiry_date?: string | null;
  },
): Promise<number | null> {
  if (item.batch_id) return item.batch_id;
  const batchNumber = item.batch_number?.trim() || null;
  const expiryDate = item.expiry_date?.trim() || null;
  if (!batchNumber && !expiryDate) return null;

  // Try to find existing batch for this product matching the provided values
  if (batchNumber) {
    const { rows } = await client.query(
      `SELECT id FROM batches
       WHERE product_id = $1 AND batch_number = $2
       ${expiryDate ? "AND expiry_date = $3::date" : ""}
       LIMIT 1`,
      expiryDate
        ? [item.product_id, batchNumber, expiryDate]
        : [item.product_id, batchNumber],
    );
    if (rows[0]?.id) return rows[0].id;
  }

  // Create a new batch
  const { rows } = await client.query(
    `INSERT INTO batches (product_id, batch_number, expiry_date, received_date)
     VALUES ($1, $2, $3::date, CURRENT_DATE)
     RETURNING id`,
    [item.product_id, batchNumber, expiryDate],
  );
  return rows[0]?.id ?? null;
}

const createOrderSchema = z.object({
  partner_id: z.number().int(),
  delivery_date: z.string().nullish(),
  notes: z.string().nullish(),
  source: z.enum(["manual", "comarch", "web"]).default("manual"),
  request_number: z.string().nullish(),
  partner_object_id: z.number().int().positive().nullish(),
  object_name: z.string().nullish(),
  object_code: z.string().nullish(),
  items: z.array(orderItemSchema).min(1),
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

  items: z.array(orderItemSchema).min(1).optional(),
});

const STOCK_DISPATCH_NUMBER_SQL = `('SR-' || LPAD(COALESCE(o.order_number, o.id)::text, 7, '0'))`;
const COMMERCIAL_DOC_NUMBER_SQL = `('TD-' || LPAD(COALESCE(o.order_number, o.id)::text, 7, '0'))`;
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

      if (search) {
        // Split search into words so "Beef P" matches 'Beef "PASTRAMI"'.
        // Uses normalize_search() for Cyrillic↔Latin transliteration.
        const words = search.trim().split(/\s+/).filter(Boolean);
        const wordClauses: string[] = [];
        for (const word of words) {
          const escaped = word.replace(/[%_\\]/g, "\\$&");
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
             p.purchase_price,
             p.${groupPriceCol} AS group_price,
             COALESCE(SUM(inv.quantity), 0)::numeric AS total_stock
             ${priceListId ? `, pli.price AS partner_price` : `, NULL::numeric AS partner_price`}
      FROM products p
      LEFT JOIN inventory inv ON inv.product_id = p.id
      ${priceListId ? `LEFT JOIN price_list_items pli ON pli.product_id = p.id AND pli.price_list_id = $${paramIdx++}` : ""}
      ${where}
      GROUP BY p.id ${priceListId ? ", pli.price" : ""}
      ${in_stock_only === "true" ? "HAVING COALESCE(SUM(inv.quantity), 0) > 0" : ""}
      ORDER BY p.name_bg
      LIMIT 100
    `;
      if (priceListId) params.splice(paramIdx - 2, 0, priceListId);

      const { rows } = await query(sql, params);

      // Enrich products with available batch info (partida + expiry)
      if (rows.length > 0) {
        const productIds = rows.map((r: any) => r.id);
        const { rows: batchRows } = await query(
          `SELECT b.id, b.product_id, b.batch_number, b.expiry_date,
                  COALESCE(SUM(inv.quantity), b.quantity)::numeric AS batch_stock
           FROM batches b
           LEFT JOIN inventory inv ON inv.batch_id = b.id AND inv.quantity > 0
           WHERE b.product_id = ANY($1)
             AND (COALESCE(inv.quantity, b.quantity) > 0)
           GROUP BY b.id
           ORDER BY b.expiry_date ASC NULLS LAST`,
          [productIds],
        );

        // Group batches by product_id
        const batchMap: Record<number, any[]> = {};
        for (const b of batchRows) {
          if (!batchMap[b.product_id]) batchMap[b.product_id] = [];
          batchMap[b.product_id].push({
            id: b.id,
            batch_number: b.batch_number,
            expiry_date: b.expiry_date,
            stock: parseFloat(b.batch_stock),
          });
        }

        for (const row of rows) {
          (row as any).batches = batchMap[row.id] || [];
        }
      }

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
      data: rows,
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
      `SELECT o.*, p.name AS partner_name,
              inv.include_vat AS invoice_include_vat,
              inv.invoice_number,
              inv.invoice_date,
              inv.status AS invoice_status,
              cn.id AS credit_note_id,
              cn.invoice_number AS credit_note_number,
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
       WHERE o.id = $1`,
      [id],
    );

    if (!order) {
      return reply.status(404).send({ error: "Order not found" });
    }

    const { rows: items } = await query(
      `SELECT oi.*,
              COALESCE(pr.name_bg, 'Продукт #' || oi.product_id) AS name_bg,
              COALESCE(pr.name_en, 'Product #' || oi.product_id) AS name_en,
              pr.sku, pr.unit, pr.brand,
              COALESCE(b.batch_number, fb.batch_number) AS batch_number,
              COALESCE(b.expiry_date, fb.expiry_date) AS expiry_date
       FROM order_items oi
       LEFT JOIN products pr ON pr.id = oi.product_id
       LEFT JOIN batches b ON b.id = oi.batch_id
       LEFT JOIN LATERAL (
         SELECT batch_number, expiry_date
         FROM batches
         WHERE product_id = oi.product_id
         ORDER BY created_at DESC
         LIMIT 1
       ) fb ON oi.batch_id IS NULL
       WHERE oi.order_id = $1
       ORDER BY oi.id`,
      [id],
    );

    return { ...order, items };
  });

  // POST /orders — create order
  app.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (request.user.role === "accountant") {
      return reply.status(403).send({ error: "Insufficient permissions" });
    }

    const body = createOrderSchema.parse(request.body);

    const result = await transaction(async (client) => {
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

      // Load product data including the partner's price group column
      const productIds = [...new Set(body.items.map((i) => i.product_id))];
      const { rows: productData } = await client.query(
        `SELECT id, selling_price, ${partnerPriceColumn} AS group_price, name_bg FROM products WHERE id = ANY($1)`,
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

      await validateRequestedStock(client, body.items, productMap);

      // Create order with sequential order_number
      const {
        rows: [order],
      } = await client.query(
        `INSERT INTO orders (
           partner_id, delivery_date, notes, source, request_number,
           partner_object_id, object_name, object_code, status, order_number
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', nextval('order_number_seq'))
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
        ],
      );

      let totalAmount = 0;
      const items = [];

      for (const item of body.items) {
        // Price resolution chain: explicit > partner price list > product selling_price > 0
        const prod = productMap.get(item.product_id);
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

        const batchId = await resolveBatchIdForItem(client, item);

        const {
          rows: [orderItem],
        } = await client.query(
          `INSERT INTO order_items (order_id, product_id, quantity, unit_price, discount_percent, total_price, batch_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [
            order.id,
            item.product_id,
            item.quantity,
            unitPrice,
            discountPct,
            totalPrice,
            batchId,
          ],
        );
        items.push(orderItem);
      }

      // Update total
      await client.query("UPDATE orders SET total_amount = $1 WHERE id = $2", [
        totalAmount,
        order.id,
      ]);

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

    return reply.status(201).send(result);
  });

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

          const {
            rows: [orderItem],
          } = await client.query(
            `INSERT INTO order_items (order_id, product_id, quantity, unit_price, total_price)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [order.id, productId, item.quantity, item.unit_price, totalPrice],
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
  app.put("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (request.user.role === "accountant") {
      return reply.status(403).send({ error: "Insufficient permissions" });
    }

    const { id } = request.params as { id: string };
    const body = updateOrderSchema.parse(request.body);

    const {
      rows: [order],
    } = await query("SELECT * FROM orders WHERE id = $1", [id]);

    if (!order) {
      return reply.status(404).send({ error: "Order not found" });
    }
    if (order.status === "cancelled") {
      return reply.status(400).send({ error: "Cannot edit a cancelled order" });
    }

    const orderId = Number(id);

    const result = await transaction(async (client) => {
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
      params.push(id);
      const {
        rows: [updated],
      } = await client.query(
        `UPDATE orders SET ${sets.join(", ")} WHERE id = $${paramIdx} RETURNING *`,
        params,
      );

      // Replace items if provided
      if (body.items) {
        const mustReconcileStock = STOCK_COMMITTED_STATUSES.has(updated.status);

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

        const productIds = [...new Set(body.items.map((i) => i.product_id))];
        const { rows: productData } = await client.query(
          "SELECT id, name_bg, selling_price FROM products WHERE id = ANY($1)",
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

        if (mustReconcileStock) {
          await restoreOrderItemsToInventory(client, orderId);
        }

        await client.query("DELETE FROM order_items WHERE order_id = $1", [id]);
        await validateRequestedStock(client, body.items, productMap);

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
            (item.quantity * unitPrice * (1 - discountPct / 100)).toFixed(2),
          );
          totalAmount += totalPrice;

          let batchId: number | null = null;
          let costUnitPrice: number | null = null;
          if (mustReconcileStock) {
            // Prefer manually-specified batch if provided
            const manualBatchId = await resolveBatchIdForItem(client, item);
            const alloc = await allocateInventoryForOrderItem(
              client,
              item.product_id,
              item.quantity,
              manualBatchId,
            );
            batchId = alloc.batchId;
            costUnitPrice = alloc.costUnitPrice;
          } else {
            batchId = await resolveBatchIdForItem(client, item);
          }

          const {
            rows: [orderItem],
          } = await client.query(
            `INSERT INTO order_items (order_id, product_id, quantity, unit_price, discount_percent, total_price, batch_id, cost_unit_price, cost_source_batch_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [
              id,
              item.product_id,
              item.quantity,
              unitPrice,
              discountPct,
              totalPrice,
              batchId,
              costUnitPrice,
              batchId,
            ],
          );
          items.push(orderItem);
        }

        await client.query(
          "UPDATE orders SET total_amount = $1 WHERE id = $2",
          [totalAmount, id],
        );

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

        return {
          ...updated,
          total_amount: totalAmount,
          items,
          regenerated_invoice_id: regeneratedInvoiceId,
          regenerated_documents: mustReconcileStock,
        };
      }

      return updated;
    });

    return result;
  });

  // PATCH /orders/:id/items/:itemId — update batch/expiry of a single line item (pending only)
  app.patch(
    "/:id/items/:itemId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      if (request.user.role === "accountant") {
        return reply.status(403).send({ error: "Insufficient permissions" });
      }

      const { id, itemId } = request.params as { id: string; itemId: string };
      const schema = z.object({
        batch_number: z.string().nullish(),
        expiry_date: z.string().nullish(),
      });
      const body = schema.parse(request.body);

      return await transaction(async (client) => {
        const {
          rows: [order],
        } = await client.query(
          "SELECT id, status, invoice_id FROM orders WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (!order) return reply.status(404).send({ error: "Not found" });
        // Allow batch/expiry edits until the invoice is issued.
        // Once there's an invoice (status = 'invoiced' or invoice_id set),
        // the document is finalized and edits would desync the records.
        if (
          order.status === "cancelled" ||
          order.status === "invoiced" ||
          order.invoice_id
        ) {
          return reply.status(400).send({
            error:
              "Партида/срок могат да се редактират преди издаване на фактура.",
          });
        }

        const {
          rows: [item],
        } = await client.query(
          "SELECT id, product_id, batch_id FROM order_items WHERE order_id = $1 AND id = $2",
          [id, itemId],
        );
        if (!item) return reply.status(404).send({ error: "Item not found" });

        const batchNumber = body.batch_number?.trim() || null;
        const expiryDate = body.expiry_date?.trim() || null;

        if (!batchNumber && !expiryDate) {
          // Clear the binding
          await client.query(
            "UPDATE order_items SET batch_id = NULL WHERE id = $1",
            [item.id],
          );
          return { ok: true, batch_id: null };
        }

        // Try to find an existing batch for this product matching the given values
        let existingBatchId: number | null = null;
        if (batchNumber) {
          const {
            rows: [found],
          } = await client.query(
            `SELECT id FROM batches
             WHERE product_id = $1 AND batch_number = $2
             ${expiryDate ? "AND expiry_date = $3::date" : ""}
             LIMIT 1`,
            expiryDate
              ? [item.product_id, batchNumber, expiryDate]
              : [item.product_id, batchNumber],
          );
          existingBatchId = found?.id ?? null;
        }

        let batchId: number;
        if (existingBatchId) {
          batchId = existingBatchId;
        } else {
          const {
            rows: [created],
          } = await client.query(
            `INSERT INTO batches (product_id, batch_number, expiry_date, received_date)
             VALUES ($1, $2, $3::date, CURRENT_DATE)
             RETURNING id`,
            [item.product_id, batchNumber, expiryDate],
          );
          batchId = created.id;
        }

        await client.query(
          "UPDATE order_items SET batch_id = $1 WHERE id = $2",
          [batchId, item.id],
        );

        return { ok: true, batch_id: batchId };
      });
    },
  );

  // PUT /orders/:id/status — change order status.
  // If transitioning to 'cancelled' from a stock-committed state (fulfilled),
  // return the goods back to inventory.
  app.put(
    "/:id/status",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      if (request.user.role === "accountant") {
        return reply.status(403).send({ error: "Insufficient permissions" });
      }

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

        // Block cancellation of invoiced orders — must go through credit note
        if (status === "cancelled" && current.status === "invoiced") {
          return reply.status(400).send({
            error:
              "Не може да се отмени фактурирана поръчка. Първо анулирайте фактурата (или издайте Кредитно известие).",
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

  // POST /orders/:id/fulfill — deduct from stock using FEFO
  app.post(
    "/:id/fulfill",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      if (request.user.role === "accountant") {
        return reply.status(403).send({ error: "Insufficient permissions" });
      }

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

        const { rows: items } = await client.query(
          "SELECT * FROM order_items WHERE order_id = $1",
          [id],
        );

        // Respect manually selected batch when present, otherwise FEFO.
        // Capture COGS (cost_unit_price + source batch) for profit analytics.
        for (const item of items) {
          const alloc = await allocateInventoryForOrderItem(
            client,
            item.product_id,
            parseFloat(item.quantity),
            item.batch_id ?? null,
          );

          await client.query(
            `UPDATE order_items
             SET batch_id = COALESCE(batch_id, $1),
                 cost_unit_price = $2,
                 cost_source_batch_id = $3
             WHERE id = $4`,
            [alloc.batchId, alloc.costUnitPrice, alloc.batchId, item.id],
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

  // DELETE /orders/:id — cancel an order (soft delete) with stock return for fulfilled orders
  app.delete("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (request.user.role === "accountant") {
      return reply.status(403).send({ error: "Insufficient permissions" });
    }

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
      } = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [
        id,
      ]);
      return locked;
    });

    if (!order) {
      return reply.status(404).send({ error: "Order not found" });
    }

    // Invoiced orders can't be cancelled — use credit note instead
    if (order.status === "invoiced") {
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

        // Get order items with batch info
        const { rows: items } = await client.query(
          "SELECT * FROM order_items WHERE order_id = $1",
          [id],
        );

        // Return each item's quantity to inventory
        for (const item of items) {
          const qty = parseFloat(item.quantity);
          if (qty <= 0) continue;

          if (item.batch_id) {
            // Return to the specific batch inventory record
            await client.query(
              `UPDATE inventory SET quantity = quantity + $1, updated_at = NOW()
               WHERE product_id = $2 AND batch_id = $3 AND warehouse_id = 1`,
              [qty, item.product_id, item.batch_id],
            );

            // Also update batch quantity
            await client.query(
              "UPDATE batches SET quantity = quantity + $1 WHERE id = $2",
              [qty, item.batch_id],
            );
          } else {
            // No batch — return to default inventory record
            const { rows: invRows } = await client.query(
              `SELECT id FROM inventory
               WHERE product_id = $1 AND warehouse_id = 1
               ORDER BY batch_id ASC NULLS FIRST LIMIT 1`,
              [item.product_id],
            );

            if (invRows.length > 0) {
              await client.query(
                "UPDATE inventory SET quantity = quantity + $1, updated_at = NOW() WHERE id = $2",
                [qty, invRows[0].id],
              );
            } else {
              // Create new inventory record if none exists
              await client.query(
                `INSERT INTO inventory (product_id, warehouse_id, quantity, updated_at)
                 VALUES ($1, 1, $2, NOW())`,
                [item.product_id, qty],
              );
            }
          }
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
  });

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

  async function validateRequestedStock(
    db: DbExecutor,
    items: Array<{
      product_id: number;
      quantity: number;
      batch_id?: number | null;
    }>,
    productMap: Map<number, any>,
  ) {
    const requestedByProduct = new Map<number, number>();
    const requestedByBatch = new Map<
      number,
      { productId: number; quantity: number }
    >();

    for (const item of items) {
      requestedByProduct.set(
        item.product_id,
        (requestedByProduct.get(item.product_id) || 0) + item.quantity,
      );

      if (item.batch_id) {
        const existingBatch = requestedByBatch.get(item.batch_id);
        requestedByBatch.set(item.batch_id, {
          productId: item.product_id,
          quantity: (existingBatch?.quantity || 0) + item.quantity,
        });
      }
    }

    const stockErrors: string[] = [];
    for (const [productId, requestedQty] of requestedByProduct.entries()) {
      const {
        rows: [stockRow],
      } = await db.query(
        "SELECT COALESCE(SUM(quantity), 0)::numeric AS total FROM inventory WHERE product_id = $1",
        [productId],
      );
      const available = parseFloat(stockRow.total);
      if (available + EPSILON < requestedQty) {
        const productName =
          productMap.get(productId)?.name_bg || `Продукт #${productId}`;
        stockErrors.push(
          `${productName}: налични ${available}, поръчани ${requestedQty}`,
        );
      }
    }

    if (stockErrors.length > 0) {
      throw Object.assign(
        new Error(`Недостатъчна наличност:\n${stockErrors.join("\n")}`),
        { statusCode: 400 },
      );
    }

    for (const [batchId, request] of requestedByBatch.entries()) {
      const {
        rows: [batchRow],
      } = await db.query(
        `SELECT b.id,
                b.product_id,
                b.batch_number,
                b.expiry_date,
                COALESCE(SUM(inv.quantity), b.quantity, 0)::numeric AS total
         FROM batches b
         LEFT JOIN inventory inv ON inv.batch_id = b.id AND inv.quantity > 0
         WHERE b.id = $1
         GROUP BY b.id`,
        [batchId],
      );

      if (!batchRow) {
        throw Object.assign(new Error(`Selected batch #${batchId} not found`), {
          statusCode: 400,
        });
      }

      if (Number(batchRow.product_id) !== request.productId) {
        throw Object.assign(
          new Error(
            `Selected batch ${batchRow.batch_number || `#${batchId}`} does not belong to product #${request.productId}`,
          ),
          { statusCode: 400 },
        );
      }

      const available = parseFloat(batchRow.total);
      if (available + EPSILON < request.quantity) {
        const productName =
          productMap.get(request.productId)?.name_bg ||
          `Продукт #${request.productId}`;
        const batchLabel = batchRow.batch_number || `#${batchId}`;
        stockErrors.push(
          `${productName} · партида ${batchLabel}: налични ${available}, поръчани ${request.quantity}`,
        );
      }
    }

    if (stockErrors.length > 0) {
      throw Object.assign(
        new Error(`Недостатъчна наличност:\n${stockErrors.join("\n")}`),
        { statusCode: 400 },
      );
    }
  }

  /**
   * FEFO allocation result. When an item is split across multiple batches
   * (e.g. need 10 units, batch A has 3 + batch B has 7), costUnitPrice is
   * the quantity-weighted average and batchId is the FIRST batch touched.
   */
  type AllocationResult = {
    batchId: number | null;
    costUnitPrice: number | null;
  };

  async function allocateInventoryForOrderItem(
    db: DbExecutor,
    productId: number,
    quantity: number,
    preferredBatchId: number | null = null,
  ): Promise<AllocationResult> {
    let remaining = quantity;
    let assignedBatchId: number | null = preferredBatchId;
    let costSumWeighted = 0; // Σ (deduct × purchase_price) over consumed batches
    let costQuantityTotal = 0;

    const { rows: stocks } = await db.query(
      `SELECT inv.id, inv.batch_id, inv.quantity,
              b.expiry_date, b.batch_number, b.purchase_price
       FROM inventory inv
       LEFT JOIN batches b ON b.id = inv.batch_id
       WHERE inv.product_id = $1
         AND inv.quantity > 0
         AND ($2::int IS NULL OR inv.batch_id = $2)
       ORDER BY b.expiry_date ASC NULLS LAST, inv.id ASC
       FOR UPDATE OF inv SKIP LOCKED`,
      [productId, preferredBatchId],
    );

    for (const stock of stocks) {
      if (remaining <= EPSILON) break;

      const available = parseFloat(stock.quantity);
      const deduct = Math.min(remaining, available);
      if (deduct <= 0) continue;

      await db.query(
        "UPDATE inventory SET quantity = quantity - $1, updated_at = NOW() WHERE id = $2",
        [deduct, stock.id],
      );

      if (stock.batch_id) {
        if (!assignedBatchId) assignedBatchId = stock.batch_id;
        await db.query(
          "UPDATE batches SET quantity = quantity - $1 WHERE id = $2",
          [deduct, stock.batch_id],
        );
      }

      // Accumulate quantity-weighted cost for COGS calculation.
      const batchCost = parseFloat(stock.purchase_price ?? "0");
      if (Number.isFinite(batchCost) && batchCost > 0) {
        costSumWeighted += deduct * batchCost;
        costQuantityTotal += deduct;
      }

      remaining -= deduct;
    }

    if (remaining > EPSILON) {
      const batchMessage = preferredBatchId
        ? ` in selected batch #${preferredBatchId}`
        : "";
      throw Object.assign(
        new Error(
          `Insufficient stock for product #${productId}${batchMessage}: need ${remaining.toFixed(3)} more`,
        ),
        { statusCode: 400 },
      );
    }

    if (!assignedBatchId) {
      const { rows: fallbackBatch } = await db.query(
        `SELECT id FROM batches
         WHERE product_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [productId],
      );
      if (fallbackBatch.length > 0) {
        assignedBatchId = fallbackBatch[0].id;
      }
    }

    // Fallback: no batch-level purchase_price captured → use products.purchase_price
    let costUnitPrice: number | null = null;
    if (costQuantityTotal > EPSILON) {
      costUnitPrice = costSumWeighted / costQuantityTotal;
    } else {
      const { rows } = await db.query(
        "SELECT purchase_price FROM products WHERE id = $1",
        [productId],
      );
      const fallbackCost = parseFloat(rows[0]?.purchase_price ?? "0");
      costUnitPrice = Number.isFinite(fallbackCost) ? fallbackCost : null;
    }

    return { batchId: assignedBatchId, costUnitPrice };
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
      `SELECT oi.*, p.name_bg, p.name_en, p.sku, p.unit, p.brand
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
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

  // ── Helper: load order with items + batch info ──
  async function loadOrderWithBatches(
    orderId: number,
    db: DbExecutor = { query },
  ) {
    const {
      rows: [order],
    } = await db.query(
      `SELECT o.*, p.name AS partner_name, p.eik AS partner_eik,
              p.vat_number AS partner_vat, p.address AS partner_address,
              p.city AS partner_city, p.phone AS partner_phone,
              p.contact_person AS partner_mol
       FROM orders o
       JOIN partners p ON p.id = o.partner_id
       WHERE o.id = $1`,
      [orderId],
    );
    if (!order) return null;

    // Fetch items with batch info.
    // If order_item has batch_id → use it directly.
    // If not → fallback to the latest batch for that product (by expiry_date).
    const { rows: items } = await db.query(
      `SELECT oi.*,
              COALESCE(pr.name_bg, 'Продукт #' || oi.product_id) AS name_bg,
              COALESCE(pr.name_en, 'Product #' || oi.product_id) AS name_en,
              pr.sku, pr.unit, pr.brand,
              COALESCE(b.batch_number, fb.batch_number) AS batch_number,
              COALESCE(b.expiry_date, fb.expiry_date) AS expiry_date
       FROM order_items oi
       LEFT JOIN products pr ON pr.id = oi.product_id
       LEFT JOIN batches b ON b.id = oi.batch_id
       LEFT JOIN LATERAL (
         SELECT batch_number, expiry_date
         FROM batches
         WHERE product_id = oi.product_id
         ORDER BY created_at DESC
         LIMIT 1
       ) fb ON oi.batch_id IS NULL
       WHERE oi.order_id = $1
       ORDER BY oi.id`,
      [orderId],
    );

    return { order, items };
  }

  // ════════════════════════════════════════════════════════════════════
  // GET /:id/stock-dispatch-pdf — Стокова разписка
  // ════════════════════════════════════════════════════════════════════
  app.get(
    "/:id/stock-dispatch-pdf",
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { include_vat?: string };
      }>,
      reply: FastifyReply,
    ) => {
      await requireAuth(request, reply);
      if (request.user.role !== "admin" && request.user.role !== "warehouse") {
        return reply.status(403).send({ error: "Insufficient permissions" });
      }

      const id = Number(request.params.id);
      const data = await loadOrderWithBatches(id);
      if (!data) return reply.status(404).send({ error: "Order not found" });

      const { order, items } = data;
      if (order.status !== "fulfilled" && order.status !== "invoiced") {
        return reply.status(400).send({
          error:
            "Стокова разписка може да се генерира само за изпълнени поръчки",
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

      const company = await getCompanySettings();
      const docNumber = `SR-${String(order.order_number || order.id).padStart(7, "0")}`;

      // Generate PDF in temp dir
      const pdfDir = path.resolve(process.cwd(), "data", "documents");
      if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
      const outputPath = path.join(pdfDir, `stock-dispatch-${id}.pdf`);

      await generateStockDispatchPdf({
        doc_number: docNumber,
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
        outputPath,
      });

      const stream = fs.createReadStream(outputPath);
      const filename = `Стокова_разписка_${docNumber}.pdf`;
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
  app.get(
    "/:id/commercial-doc-pdf",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      await requireAuth(request, reply);
      if (request.user.role !== "admin" && request.user.role !== "warehouse") {
        return reply.status(403).send({ error: "Insufficient permissions" });
      }

      const id = Number(request.params.id);
      const data = await loadOrderWithBatches(id);
      if (!data) return reply.status(404).send({ error: "Order not found" });

      const { order, items } = data;
      if (order.status !== "fulfilled" && order.status !== "invoiced") {
        return reply.status(400).send({
          error:
            "Търговски документ може да се генерира само за изпълнени поръчки",
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
}
