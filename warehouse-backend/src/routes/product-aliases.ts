import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query } from "../db.js";
import { normalizeAliasName } from "../utils/product-matching.js";

const createAliasSchema = z.object({
  alias_name: z.string().min(1),
  product_id: z.coerce.number().int(),
  supplier_id: z.coerce.number().int().optional().nullable(),
});

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

async function upsertAliasCaseInsensitive(
  aliasName: string,
  productId: number,
  supplierId: number | null,
) {
  const normalized = normalizeAliasName(aliasName);
  if (!normalized) {
    throw Object.assign(new Error("Alias cannot be normalized"), {
      statusCode: 400,
    });
  }

  const { rows: existing } = await query(
    `SELECT id FROM product_aliases
     WHERE LOWER(alias_name_normalized) = LOWER($1)
       AND supplier_id IS NOT DISTINCT FROM $2
     LIMIT 1`,
    [normalized, supplierId],
  );

  if (existing.length > 0) {
    const { rows } = await query(
      `UPDATE product_aliases
       SET alias_name = $1,
           alias_name_normalized = $2,
           product_id = $3,
           confidence = 1.00,
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [aliasName, normalized, productId, existing[0].id],
    );
    return rows[0];
  }

  const { rows } = await query(
    `INSERT INTO product_aliases (alias_name, alias_name_normalized, product_id, supplier_id, confidence)
     VALUES ($1, $2, $3, $4, 1.00)
     RETURNING *`,
    [aliasName, normalized, productId, supplierId],
  );
  return rows[0];
}

export default async function productAliasRoutes(app: FastifyInstance) {
  // GET /product-aliases — list aliases, optionally filtered by supplier
  app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;

    const { supplier_id, product_id, search } = request.query as any;

    let where = "WHERE 1=1";
    const params: any[] = [];
    let paramIdx = 1;

    if (supplier_id) {
      where += ` AND pa.supplier_id = $${paramIdx++}`;
      params.push(parseInt(supplier_id));
    }

    if (product_id) {
      where += ` AND pa.product_id = $${paramIdx++}`;
      params.push(parseInt(product_id));
    }

    if (search) {
      where += ` AND (pa.alias_name ILIKE $${paramIdx} OR p.name_bg ILIKE $${paramIdx})`;
      params.push(`%${search}%`);
      paramIdx++;
    }

    const { rows } = await query(
      `SELECT pa.*, p.name_bg AS product_name_bg, p.name_en AS product_name_en, p.sku AS product_sku,
              s.name AS supplier_name
       FROM product_aliases pa
       LEFT JOIN products p ON p.id = pa.product_id
       LEFT JOIN suppliers s ON s.id = pa.supplier_id
       ${where}
       ORDER BY pa.created_at DESC`,
      params,
    );

    return { data: rows };
  });

  // POST /product-aliases — create or update an alias
  app.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;

    const body = createAliasSchema.parse(request.body);
    const supplierId = body.supplier_id ?? null;
    const saved = await upsertAliasCaseInsensitive(
      body.alias_name,
      body.product_id,
      supplierId,
    );
    return reply.status(201).send(saved);
  });

  // POST /product-aliases/bulk — create multiple aliases at once
  app.post("/bulk", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;

    const bodySchema = z.array(createAliasSchema);
    const aliases = bodySchema.parse(request.body);
    const results = [];

    for (const alias of aliases) {
      const supplierId = alias.supplier_id ?? null;
      const saved = await upsertAliasCaseInsensitive(
        alias.alias_name,
        alias.product_id,
        supplierId,
      );
      results.push(saved);
    }

    return reply.status(201).send({ data: results });
  });

  // DELETE /product-aliases/:id
  app.delete("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;

    const { id } = request.params as { id: string };
    const { rowCount } = await query(
      "DELETE FROM product_aliases WHERE id = $1",
      [id],
    );

    if (rowCount === 0) {
      return reply.status(404).send({ error: "Alias not found" });
    }
    return { message: "Alias deleted" };
  });

  // GET /product-aliases/lookup — internal endpoint for AI service to lookup aliases
  app.get("/lookup", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;

    const { alias_name, supplier_id } = request.query as any;
    if (!alias_name) {
      return reply.status(400).send({ error: "alias_name is required" });
    }

    const normalized = normalizeAliasName(alias_name);
    const rawLower = alias_name.toLowerCase().trim();
    let sql = `
      SELECT pa.*, p.name_bg AS product_name_bg, p.name_en AS product_name_en, p.sku AS product_sku
      FROM product_aliases pa
      LEFT JOIN products p ON p.id = pa.product_id
      WHERE (
        LOWER(pa.alias_name_normalized) = LOWER($1)
        OR LOWER(TRIM(pa.alias_name)) = LOWER($2)
      )`;
    const params: any[] = [normalized, rawLower];

    if (supplier_id) {
      sql += ` AND (pa.supplier_id = $3 OR pa.supplier_id IS NULL)`;
      params.push(parseInt(supplier_id));
      sql += ` ORDER BY
        CASE
          WHEN pa.supplier_id = $3 THEN 0
          WHEN pa.supplier_id IS NULL THEN 1
          ELSE 2
        END,
        pa.confidence DESC,
        pa.updated_at DESC
        LIMIT 1`;
    } else {
      sql += ` ORDER BY pa.confidence DESC, pa.updated_at DESC LIMIT 1`;
    }

    const { rows } = await query(sql, params);

    if (rows.length === 0) {
      return { match: null };
    }
    return { match: rows[0] };
  });
}
