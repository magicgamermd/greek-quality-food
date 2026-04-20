import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query } from "../db.js";

const createBatchSchema = z.object({
  product_id: z.number().int(),
  batch_number: z.string().optional(),
  expiry_date: z.string().optional(),
  quantity: z.number().min(0).default(0),
  purchase_price: z.number().min(0).optional(),
  delivery_id: z.number().int().optional(),
  received_date: z.string().optional(),
  notes: z.string().optional(),
});

const updateBatchSchema = z.object({
  batch_number: z.string().optional(),
  expiry_date: z.string().nullable().optional(),
  quantity: z.number().min(0).optional(),
  purchase_price: z.number().min(0).nullable().optional(),
  notes: z.string().nullable().optional(),
});

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

export default async function batchRoutes(app: FastifyInstance) {
  // GET /batches?product_id=X — list batches for a product (ordered by expiry_date ASC)
  app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);

    const { product_id, page, limit } = request.query as any;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const offset = (pageNum - 1) * pageSize;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (product_id) {
      conditions.push(`b.product_id = $${paramIdx++}`);
      params.push(parseInt(product_id));
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT b.*, p.name_bg, p.name_en, p.sku, p.unit
      FROM batches b
      JOIN products p ON p.id = b.product_id
      ${where}
      ORDER BY b.expiry_date ASC NULLS LAST
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    params.push(pageSize, offset);

    const { rows } = await query(sql, params);

    const countSql = `SELECT COUNT(*)::int AS total FROM batches b ${where}`;
    const countParams = product_id ? [parseInt(product_id)] : [];
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

  // GET /batches/expiring?days=30 — list batches expiring within N days
  app.get("/expiring", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);

    const { days } = request.query as any;
    const withinDays = parseInt(days) || 30;

    const { rows } = await query(
      `SELECT b.*, p.name_bg, p.name_en, p.sku, p.unit,
              b.expiry_date - CURRENT_DATE AS days_until_expiry
       FROM batches b
       JOIN products p ON p.id = b.product_id
       WHERE b.expiry_date IS NOT NULL
         AND b.expiry_date <= CURRENT_DATE + $1::integer
         AND b.quantity > 0
       ORDER BY b.expiry_date ASC`,
      [withinDays],
    );

    return { data: rows, count: rows.length, within_days: withinDays };
  });

  // POST /batches — create a batch
  app.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (request.user.role === "accountant") {
      return reply.status(403).send({ error: "Insufficient permissions" });
    }

    const body = createBatchSchema.parse(request.body);

    // Verify product exists
    const { rows: products } = await query(
      "SELECT id FROM products WHERE id = $1",
      [body.product_id],
    );
    if (products.length === 0) {
      return reply.status(404).send({ error: "Продуктът не е намерен" });
    }

    const {
      rows: [batch],
    } = await query(
      `INSERT INTO batches (product_id, batch_number, expiry_date, quantity, purchase_price, delivery_id, received_date, notes)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7::date, $8)
       RETURNING *`,
      [
        body.product_id,
        body.batch_number || null,
        body.expiry_date || null,
        body.quantity,
        body.purchase_price ?? null,
        body.delivery_id ?? null,
        body.received_date || null,
        body.notes || null,
      ],
    );

    return reply.status(201).send(batch);
  });

  // PUT /batches/:id — update batch
  app.put("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (request.user.role === "accountant") {
      return reply.status(403).send({ error: "Insufficient permissions" });
    }

    const { id } = request.params as { id: string };
    const body = updateBatchSchema.parse(request.body);

    const sets: string[] = ["updated_at = NOW()"];
    const params: any[] = [];
    let paramIdx = 1;

    if (body.batch_number !== undefined) {
      sets.push(`batch_number = $${paramIdx++}`);
      params.push(body.batch_number);
    }
    if (body.expiry_date !== undefined) {
      sets.push(`expiry_date = $${paramIdx++}::date`);
      params.push(body.expiry_date);
    }
    if (body.quantity !== undefined) {
      sets.push(`quantity = $${paramIdx++}`);
      params.push(body.quantity);
    }
    if (body.purchase_price !== undefined) {
      sets.push(`purchase_price = $${paramIdx++}`);
      params.push(body.purchase_price);
    }
    if (body.notes !== undefined) {
      sets.push(`notes = $${paramIdx++}`);
      params.push(body.notes);
    }

    params.push(parseInt(id));

    const { rows } = await query(
      `UPDATE batches SET ${sets.join(", ")} WHERE id = $${paramIdx} RETURNING *`,
      params,
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: "Партидата не е намерена" });
    }

    return rows[0];
  });

  // DELETE /batches/:id — delete a batch
  app.delete("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (request.user.role === "accountant") {
      return reply.status(403).send({ error: "Insufficient permissions" });
    }

    const { id } = request.params as { id: string };

    const { rows } = await query(
      "DELETE FROM batches WHERE id = $1 RETURNING id",
      [parseInt(id)],
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: "Партидата не е намерена" });
    }

    return { message: "Партидата е изтрита", id: rows[0].id };
  });
}
