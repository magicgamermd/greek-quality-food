import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query, transaction } from "../db.js";

// Allowed НАП reasons. Mirror the CHECK constraint on stock_writeoffs.reason —
// if this list diverges from migration 041, the DB will reject the INSERT.
const WRITEOFF_REASONS = [
  "expired",
  "damaged",
  "theft",
  "count_correction",
  "recall",
  "other",
] as const;

const createWriteoffSchema = z.object({
  product_id: z.number().int().positive(),
  // batch_id nullable — opening-balance stock imported before the batch
  // system was in place has inventory rows with batch_id IS NULL.
  batch_id: z.number().int().positive().nullable().optional(),
  warehouse_id: z.number().int().positive().optional(),
  quantity: z.number().positive(),
  reason: z.enum(WRITEOFF_REASONS),
  notes: z.string().max(2000).nullable().optional(),
});

// Bulk: many write-off lines grouped under ONE protocol number (one НАП акт).
// Each line follows the same shape as a single write-off, minus warehouse_id
// (the bulk body carries one warehouse for the whole protocol — defaults to 1).
const bulkWriteoffLineSchema = z.object({
  product_id: z.number().int().positive(),
  batch_id: z.number().int().positive().nullable().optional(),
  warehouse_id: z.number().int().positive().optional(),
  quantity: z.number().positive(),
  reason: z.enum(WRITEOFF_REASONS),
  notes: z.string().max(2000).nullable().optional(),
});

const bulkWriteoffSchema = z.object({
  notes: z.string().max(2000).nullable().optional(),
  warehouse_id: z.number().int().positive().optional(),
  lines: z.array(bulkWriteoffLineSchema).min(1).max(100),
});

// One write-off line, post-validation. Mirrors a stock_writeoffs row.
interface WriteoffLineInput {
  product_id: number;
  batch_id?: number | null;
  quantity: number;
  reason: string;
  notes?: string | null;
}

interface WriteoffLineContext {
  documentNumber: string;
  protocolNumber: string | null;
  warehouseId: number;
  userId: string | number;
  userEmail: string;
}

// A transaction client (pg PoolClient) — typed loosely so the helper works
// with both the real client and the vitest mock ({ query }).
interface TxClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

/**
 * Validate + decrement + insert + audit for a SINGLE write-off line, inside an
 * already-open transaction. Shared by POST / (single) and POST /bulk (many
 * lines under one protocol). Throws Error with `.statusCode` on validation
 * failures so the whole enclosing transaction rolls back.
 */
async function writeoffOneLine(
  client: TxClient,
  line: WriteoffLineInput,
  ctx: WriteoffLineContext,
): Promise<any> {
  const batchId = line.batch_id ?? null;

  // 1. Verify product exists + get fallback purchase_price for batch-less
  //    write-offs (opening balance items, etc.).
  const productRes = await client.query(
    `SELECT id, purchase_price FROM products WHERE id = $1`,
    [line.product_id],
  );
  if (productRes.rows.length === 0) {
    throw Object.assign(new Error("Продуктът не е намерен"), {
      statusCode: 404,
    });
  }
  const productPurchasePrice = Number(productRes.rows[0].purchase_price ?? 0);

  // 2. If batch_id provided: LOCK batch row, verify product match +
  //    available qty, derive unit_cost from batch.purchase_price.
  let unitCost = productPurchasePrice;
  if (batchId != null) {
    const batchRes = await client.query(
      `SELECT id, product_id, quantity, purchase_price
         FROM batches
        WHERE id = $1
        FOR UPDATE`,
      [batchId],
    );
    if (batchRes.rows.length === 0) {
      throw Object.assign(new Error("Партидата не е намерена"), {
        statusCode: 404,
      });
    }
    const batch = batchRes.rows[0];
    if (Number(batch.product_id) !== Number(line.product_id)) {
      throw Object.assign(new Error("Партидата не съответства на продукта"), {
        statusCode: 400,
      });
    }
    const available = Number(batch.quantity);
    if (available < line.quantity) {
      throw Object.assign(
        new Error(
          `Недостатъчно количество в партидата (налично: ${available})`,
        ),
        { statusCode: 400 },
      );
    }
    if (batch.purchase_price != null) {
      unitCost = Number(batch.purchase_price);
    }
  } else {
    // No batch — verify total inventory at this warehouse has enough.
    const invRes = await client.query(
      `SELECT COALESCE(SUM(quantity), 0)::numeric AS total
         FROM inventory
        WHERE product_id = $1
          AND batch_id IS NULL
          AND warehouse_id = $2
        FOR UPDATE`,
      [line.product_id, ctx.warehouseId],
    );
    const available = Number(invRes.rows[0]?.total ?? 0);
    if (available < line.quantity) {
      throw Object.assign(
        new Error(`Недостатъчно количество в склада (налично: ${available})`),
        { statusCode: 400 },
      );
    }
  }

  // Normalize monetary values to 2-decimal fixed precision before INSERT so
  // total_cost matches the rounded unit_cost * quantity shown on the printed
  // PDF. Floats here would silently drift.
  const unitCostFixed = Number(unitCost.toFixed(2));
  const totalCost = Number((unitCostFixed * line.quantity).toFixed(2));

  // 3. INSERT stock_writeoffs (append-only), including protocol_number.
  const insertRes = await client.query(
    `INSERT INTO stock_writeoffs
       (document_number, protocol_number, product_id, batch_id, warehouse_id,
        quantity, unit_cost, total_cost, reason, notes, written_off_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      ctx.documentNumber,
      ctx.protocolNumber,
      line.product_id,
      batchId,
      ctx.warehouseId,
      line.quantity,
      unitCostFixed,
      totalCost,
      line.reason,
      line.notes ?? null,
      ctx.userId,
    ],
  );
  const writeoff = insertRes.rows[0];

  // 4. Decrement batch (if present) — the CHECK (quantity >= 0) constraint on
  //    batches will reject any concurrent overdraw.
  if (batchId != null) {
    await client.query(
      `UPDATE batches SET quantity = quantity - $1 WHERE id = $2`,
      [line.quantity, batchId],
    );
  }

  // 5. Decrement inventory row matching (product, batch, warehouse). Use
  //    IS NOT DISTINCT FROM so NULL batch_id still matches the null-batch
  //    inventory row (standard = would never match NULL).
  await client.query(
    `UPDATE inventory
        SET quantity = quantity - $1
      WHERE product_id = $2
        AND batch_id IS NOT DISTINCT FROM $3
        AND warehouse_id = $4`,
    [line.quantity, line.product_id, batchId, ctx.warehouseId],
  );

  // 6. Best-effort audit trail. audit_events is an append-only log; if the
  //    table does not exist (older environments) skip silently.
  try {
    await client.query(
      `INSERT INTO audit_events
         (actor_user_id, actor_email, action, entity_type, entity_id, diff)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        ctx.userId,
        ctx.userEmail,
        "stock_writeoff.create",
        "stock_writeoff",
        writeoff.id,
        JSON.stringify({
          document_number: ctx.documentNumber,
          protocol_number: ctx.protocolNumber,
          product_id: line.product_id,
          batch_id: batchId,
          quantity: line.quantity,
          unit_cost: unitCostFixed,
          total_cost: totalCost,
          reason: line.reason,
        }),
      ],
    );
  } catch (auditErr: any) {
    // Only swallow "relation does not exist" — surface any other error.
    if (auditErr?.code !== "42P01") {
      throw auditErr;
    }
  }

  return writeoff;
}

async function requireAuth(request: FastifyRequest, _reply: FastifyReply) {
  await request.jwtVerify();
}

// Only admin + warehouse create write-offs. Accountants and owner_mobile can
// VIEW (audit / read-only dashboards) but must not alter stock.
function canCreateWriteoff(role: string): boolean {
  return role === "admin" || role === "warehouse";
}

function canViewWriteoffs(role: string): boolean {
  return (
    role === "admin" ||
    role === "warehouse" ||
    role === "accountant" ||
    role === "owner_mobile"
  );
}

function buildDocumentNumber(year: number, seqValue: number | string): string {
  const seq = typeof seqValue === "string" ? parseInt(seqValue, 10) : seqValue;
  return `БРАК-${year}-${String(seq).padStart(4, "0")}`;
}

export default async function writeoffRoutes(app: FastifyInstance) {
  // POST / — create a write-off (atomic: lock batch, decrement, insert)
  app.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (!canCreateWriteoff(request.user.role)) {
      return reply.status(403).send({ error: "Insufficient permissions" });
    }

    const body = createWriteoffSchema.parse(request.body);
    const warehouseId = body.warehouse_id ?? 1;

    try {
      const result = await transaction(async (client) => {
        // Reserve a document number from the gap-free sequence. We pull the
        // sequence value inside the transaction so concurrent inserts never
        // collide on document_number UNIQUE.
        const seqRes = await client.query(
          `SELECT nextval('stock_writeoff_doc_seq') AS seq`,
        );
        const year = new Date().getUTCFullYear();
        const documentNumber = buildDocumentNumber(year, seqRes.rows[0].seq);

        // Single write-off: no protocol grouping (protocol_number = null).
        return writeoffOneLine(
          client,
          {
            product_id: body.product_id,
            batch_id: body.batch_id ?? null,
            quantity: body.quantity,
            reason: body.reason,
            notes: body.notes ?? null,
          },
          {
            documentNumber,
            protocolNumber: null,
            warehouseId,
            userId: request.user.id,
            userEmail: request.user.email,
          },
        );
      });

      return reply.status(201).send(result);
    } catch (err: any) {
      if (err?.statusCode) {
        return reply.status(err.statusCode).send({ error: err.message });
      }
      request.log.error(err);
      return reply.status(500).send({ error: "Грешка при брак на стока" });
    }
  });

  // POST /bulk — many write-off lines grouped under ONE protocol number.
  // Whole thing is atomic: if any line fails, the entire act rolls back.
  app.post("/bulk", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (!canCreateWriteoff(request.user.role)) {
      return reply.status(403).send({ error: "Insufficient permissions" });
    }

    const body = bulkWriteoffSchema.parse(request.body);
    const bulkWarehouseId = body.warehouse_id ?? 1;

    try {
      const result = await transaction(async (client) => {
        // Reserve ONE protocol number for the whole act.
        const seqRes = await client.query(
          `SELECT nextval('stock_writeoff_doc_seq') AS seq`,
        );
        const year = new Date().getUTCFullYear();
        const protocolNumber = buildDocumentNumber(year, seqRes.rows[0].seq);

        const lines: any[] = [];
        for (let i = 0; i < body.lines.length; i += 1) {
          const line = body.lines[i];
          try {
            const row = await writeoffOneLine(
              client,
              {
                product_id: line.product_id,
                batch_id: line.batch_id ?? null,
                quantity: line.quantity,
                reason: line.reason,
                // Per-line note falls back to the protocol-level note.
                notes: line.notes ?? body.notes ?? null,
              },
              {
                // Each line is uniquely numbered БРАК-YYYY-NNNN-<i+1>, all
                // sharing protocol_number = БРАК-YYYY-NNNN.
                documentNumber: `${protocolNumber}-${i + 1}`,
                protocolNumber,
                warehouseId: line.warehouse_id ?? bulkWarehouseId,
                userId: request.user.id,
                userEmail: request.user.email,
              },
            );
            lines.push(row);
          } catch (lineErr: any) {
            // Annotate which line failed; the whole tx rolls back.
            const prefix = `Ред ${i + 1}: `;
            throw Object.assign(
              new Error(prefix + (lineErr?.message ?? "грешка")),
              {
                statusCode: lineErr?.statusCode ?? 500,
                lineIndex: i,
              },
            );
          }
        }

        const totalCost = Number(
          lines
            .reduce((sum, row) => sum + Number(row.total_cost ?? 0), 0)
            .toFixed(2),
        );

        return {
          protocol_number: protocolNumber,
          count: lines.length,
          total_cost: totalCost,
          lines,
        };
      });

      return reply.status(201).send(result);
    } catch (err: any) {
      if (err?.statusCode) {
        return reply
          .status(err.statusCode)
          .send({ error: err.message, line_index: err.lineIndex });
      }
      request.log.error(err);
      return reply.status(500).send({ error: "Грешка при брак на стока" });
    }
  });

  // GET / — paginated list with filters
  app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (!canViewWriteoffs(request.user.role)) {
      return reply.status(403).send({ error: "Insufficient permissions" });
    }

    const {
      date_from,
      date_to,
      product_id,
      batch_id,
      reason,
      written_off_by,
      page,
      limit,
    } = request.query as Record<string, string | undefined>;

    const pageNum = Math.max(1, parseInt(page || "1", 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(limit || "50", 10) || 50),
    );
    const offset = (pageNum - 1) * pageSize;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (date_from) {
      conditions.push(`w.written_off_at >= $${idx++}::timestamptz`);
      params.push(date_from);
    }
    if (date_to) {
      conditions.push(
        `w.written_off_at < ($${idx++}::date + INTERVAL '1 day')`,
      );
      params.push(date_to);
    }
    if (product_id) {
      conditions.push(`w.product_id = $${idx++}`);
      params.push(parseInt(product_id, 10));
    }
    if (batch_id) {
      conditions.push(`w.batch_id = $${idx++}`);
      params.push(parseInt(batch_id, 10));
    }
    if (reason) {
      conditions.push(`w.reason = $${idx++}`);
      params.push(reason);
    }
    if (written_off_by) {
      conditions.push(`w.written_off_by = $${idx++}`);
      params.push(written_off_by);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT
        w.*,
        p.name_bg AS product_name_bg,
        p.name_en AS product_name_en,
        p.sku     AS product_sku,
        b.batch_number AS batch_number,
        u.email   AS written_off_by_email
      FROM stock_writeoffs w
      JOIN products p ON p.id = w.product_id
      LEFT JOIN batches b ON b.id = w.batch_id
      LEFT JOIN users u ON u.id = w.written_off_by
      ${where}
      ORDER BY w.written_off_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;
    params.push(pageSize, offset);

    const { rows } = await query(sql, params);

    const countSql = `SELECT COUNT(*)::int AS total FROM stock_writeoffs w ${where}`;
    const countParams = params.slice(0, params.length - 2);
    const { rows: countRows } = await query(countSql, countParams);

    return {
      data: rows,
      pagination: {
        page: pageNum,
        limit: pageSize,
        total: countRows[0]?.total || 0,
      },
    };
  });

  // GET /summary — aggregated stats for a period (defaults: current month)
  app.get("/summary", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (!canViewWriteoffs(request.user.role)) {
      return reply.status(403).send({ error: "Insufficient permissions" });
    }

    const { date_from, date_to } = request.query as Record<
      string,
      string | undefined
    >;

    const now = new Date();
    const defaultFrom = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    )
      .toISOString()
      .slice(0, 10);
    const defaultTo = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
    )
      .toISOString()
      .slice(0, 10);

    const fromDate = date_from || defaultFrom;
    const toDate = date_to || defaultTo;

    const totalsSql = `
      SELECT
        COALESCE(SUM(total_cost), 0)::numeric(12,2) AS total_value,
        COUNT(*)::int AS total_count
      FROM stock_writeoffs
      WHERE written_off_at >= $1::timestamptz
        AND written_off_at < ($2::date + INTERVAL '1 day')
    `;

    const byReasonSql = `
      SELECT
        reason,
        COUNT(*)::int AS count,
        COALESCE(SUM(total_cost), 0)::numeric(12,2) AS value
      FROM stock_writeoffs
      WHERE written_off_at >= $1::timestamptz
        AND written_off_at < ($2::date + INTERVAL '1 day')
      GROUP BY reason
      ORDER BY value DESC
    `;

    const topProductsSql = `
      SELECT
        w.product_id,
        p.name_bg,
        p.name_en,
        COUNT(*)::int AS count,
        COALESCE(SUM(w.total_cost), 0)::numeric(12,2) AS value
      FROM stock_writeoffs w
      JOIN products p ON p.id = w.product_id
      WHERE w.written_off_at >= $1::timestamptz
        AND w.written_off_at < ($2::date + INTERVAL '1 day')
      GROUP BY w.product_id, p.name_bg, p.name_en
      ORDER BY value DESC
      LIMIT 5
    `;

    const [totals, byReason, topProducts] = await Promise.all([
      query(totalsSql, [fromDate, toDate]),
      query(byReasonSql, [fromDate, toDate]),
      query(topProductsSql, [fromDate, toDate]),
    ]);

    return {
      period: { from: fromDate, to: toDate },
      total_value: Number(totals.rows[0]?.total_value ?? 0),
      total_count: Number(totals.rows[0]?.total_count ?? 0),
      by_reason: byReason.rows.map((row: any) => ({
        reason: row.reason,
        count: Number(row.count),
        value: Number(row.value),
      })),
      top_products: topProducts.rows.map((row: any) => ({
        product_id: Number(row.product_id),
        name_bg: row.name_bg,
        name_en: row.name_en,
        count: Number(row.count),
        value: Number(row.value),
      })),
    };
  });

  // GET /:id — single write-off with joined detail
  app.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (!canViewWriteoffs(request.user.role)) {
      return reply.status(403).send({ error: "Insufficient permissions" });
    }

    const { id } = request.params as { id: string };
    const numericId = parseInt(id, 10);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      return reply.status(400).send({ error: "Невалиден идентификатор" });
    }

    const { rows } = await query(
      `SELECT
         w.*,
         p.name_bg AS product_name_bg,
         p.name_en AS product_name_en,
         p.sku     AS product_sku,
         b.batch_number AS batch_number,
         b.expiry_date  AS batch_expiry_date,
         u.email   AS written_off_by_email
       FROM stock_writeoffs w
       JOIN products p ON p.id = w.product_id
       LEFT JOIN batches b ON b.id = w.batch_id
       LEFT JOIN users u ON u.id = w.written_off_by
       WHERE w.id = $1`,
      [numericId],
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: "Бракът не е намерен" });
    }

    return rows[0];
  });

  // GET /:id/pdf — rendered НАП-compliant protocol (Level 3).
  // Merged from writeoff-pdf-handler.ts so the PDF route lives under the
  // same /inventory/write-offs prefix as the rest of the writeoff endpoints.
  const { registerWriteoffPdfRoute } =
    await import("./writeoff-pdf-handler.js");
  await registerWriteoffPdfRoute(app);
}
