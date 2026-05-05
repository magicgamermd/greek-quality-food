import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query } from "../db.js";
import {
  requirePermission,
  stripFieldsForUser,
  PERMISSIONS,
} from "../lib/permissions.js";

const createProductSchema = z.object({
  name_bg: z.string().min(1),
  name_en: z.string().min(1),
  sku: z.string().min(1),
  category_id: z.coerce.number().int().optional().nullable(),
  unit: z.string().default("pcs"),
  description: z.string().optional().nullable(),
  image_url: z.string().url().optional().nullable(),
  low_stock_threshold: z.coerce.number().default(10),
  brand: z.string().optional().nullable(),
  purchase_price: z
    .preprocess((val) => {
      if (val === null || val === undefined || val === "") return null;
      const n = parseFloat(String(val));
      return isNaN(n) ? null : n;
    }, z.number().nullable())
    .optional(),
  selling_price: z
    .preprocess((val) => {
      if (val === null || val === undefined || val === "") return null;
      const n = parseFloat(String(val));
      return isNaN(n) ? null : n;
    }, z.number().nullable())
    .optional(),
  retail_price: z
    .preprocess((val) => {
      if (val === null || val === undefined || val === "") return null;
      const n = parseFloat(String(val));
      return isNaN(n) ? null : n;
    }, z.number().nullable())
    .optional(),
  price_group_1: z
    .preprocess((val) => {
      if (val === null || val === undefined || val === "") return null;
      const n = parseFloat(String(val));
      return isNaN(n) ? null : n;
    }, z.number().nullable())
    .optional(),
  price_group_2: z
    .preprocess((val) => {
      if (val === null || val === undefined || val === "") return null;
      const n = parseFloat(String(val));
      return isNaN(n) ? null : n;
    }, z.number().nullable())
    .optional(),
  price_group_3: z
    .preprocess((val) => {
      if (val === null || val === undefined || val === "") return null;
      const n = parseFloat(String(val));
      return isNaN(n) ? null : n;
    }, z.number().nullable())
    .optional(),
  price_group_4: z
    .preprocess((val) => {
      if (val === null || val === undefined || val === "") return null;
      const n = parseFloat(String(val));
      return isNaN(n) ? null : n;
    }, z.number().nullable())
    .optional(),
  price_group_5: z
    .preprocess((val) => {
      if (val === null || val === undefined || val === "") return null;
      const n = parseFloat(String(val));
      return isNaN(n) ? null : n;
    }, z.number().nullable())
    .optional(),
  price_group_6: z
    .preprocess((val) => {
      if (val === null || val === undefined || val === "") return null;
      const n = parseFloat(String(val));
      return isNaN(n) ? null : n;
    }, z.number().nullable())
    .optional(),
  price_group_7: z
    .preprocess((val) => {
      if (val === null || val === undefined || val === "") return null;
      const n = parseFloat(String(val));
      return isNaN(n) ? null : n;
    }, z.number().nullable())
    .optional(),
  price_group_8: z
    .preprocess((val) => {
      if (val === null || val === undefined || val === "") return null;
      const n = parseFloat(String(val));
      return isNaN(n) ? null : n;
    }, z.number().nullable())
    .optional(),
  weight_kg: z
    .preprocess((val) => {
      if (val === null || val === undefined || val === "") return null;
      const n = parseFloat(String(val));
      return isNaN(n) ? null : n;
    }, z.number().nullable())
    .optional(),
});

const updateProductSchema = createProductSchema.partial();

// Latin-to-Cyrillic transliteration for search (common food industry terms)
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
    // Try 3-char, 2-char, then 1-char matches
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

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

const jwtVerify = async (request: FastifyRequest) => {
  await request.jwtVerify();
};

const productsManagePreHandler = [
  jwtVerify,
  requirePermission(PERMISSIONS.PRODUCTS_MANAGE),
];

async function ensureSkuAvailable(
  sku: string,
  reply: FastifyReply,
  excludeProductId?: number,
) {
  const normalizedSku = sku.trim();
  if (!normalizedSku) {
    return reply.status(400).send({
      error: "SKU е задължително поле.",
      message: "Въведете уникален SKU за продукта.",
    });
  }

  const params = excludeProductId
    ? [normalizedSku, excludeProductId]
    : [normalizedSku];
  const where = excludeProductId ? "sku = $1 AND id <> $2" : "sku = $1";
  const { rows } = await query<{ id: number; name_bg: string }>(
    `SELECT id, name_bg FROM products WHERE ${where} LIMIT 1`,
    params,
  );

  if (rows.length > 0) {
    return reply.status(409).send({
      error: "duplicate_sku",
      message: `SKU \"${normalizedSku}\" вече се използва от \"${rows[0].name_bg}\".`,
      details: { product_id: rows[0].id },
    });
  }

  return null;
}

export default async function productRoutes(app: FastifyInstance) {
  // GET /products — list with optional filters
  app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);

    const {
      category,
      brand,
      low_stock,
      no_selling_price,
      search,
      q,
      supplier_group,
      page,
      limit,
      active_only,
      catalog,
    } = request.query as any;
    const pageNum = Math.max(1, parseInt(page) || 1);
    // Allow larger page size when catalog=true so consumers (owner PWA,
    // AI match service) can fetch the full catalog in a single request.
    // Bumped to 25000 to cover the full Microinvest product catalog
    // (~15k entries today, headroom for growth).
    const maxLimit = catalog === "true" ? 25000 : 100;
    const pageSize = Math.min(maxLimit, Math.max(1, parseInt(limit) || 50));
    const offset = (pageNum - 1) * pageSize;
    const rawSearch = typeof search === "string" && search.trim() ? search : q;
    const trimmedSearch = typeof rawSearch === "string" ? rawSearch.trim() : "";

    let where = "WHERE 1=1";
    const params: any[] = [];
    let paramIdx = 1;

    if (category) {
      where += ` AND p.category_id = $${paramIdx++}`;
      params.push(parseInt(category));
    }

    if (brand) {
      where += ` AND p.brand = $${paramIdx++}`;
      params.push(brand);
    }

    if (trimmedSearch) {
      // Transliteration-aware: normalize_search() folds Cyrillic→Latin and
      // collapses glide-y so "bakalia" matches "БАКАЛИЯ" and vice versa.
      where += ` AND (
        normalize_search(p.name_bg) ILIKE '%' || normalize_search($${paramIdx}) || '%'
        OR normalize_search(p.name_en) ILIKE '%' || normalize_search($${paramIdx}) || '%'
        OR p.sku ILIKE $${paramIdx + 1}
        OR p.brand ILIKE $${paramIdx + 1}
      )`;
      params.push(trimmedSearch, `%${trimmedSearch}%`);
      paramIdx += 2;
    }

    if (supplier_group) {
      where += ` AND p.group_name ILIKE $${paramIdx++}`;
      params.push(`%${supplier_group}%`);
    }

    // active_only filter: only products with stock > 0.
    // zero_stock / negative_stock are catalog-only views — surfaced as
    // pills next to "С цени / Без цени" so the cashier can spot
    // products waiting to be reordered (zero) or already oversold
    // (negative). Both bypass active_only and run their own HAVING.
    const { zero_stock, negative_stock } = request.query as any;
    const showActiveOnly =
      zero_stock !== "true" &&
      negative_stock !== "true" &&
      (active_only === "true" ||
        (active_only !== "false" && catalog !== "true"));
    let havingClause = "";
    if (zero_stock === "true") {
      havingClause = "HAVING COALESCE(SUM(inv.quantity), 0) = 0";
    } else if (negative_stock === "true") {
      havingClause = "HAVING COALESCE(SUM(inv.quantity), 0) < 0";
    } else if (showActiveOnly) {
      havingClause = "HAVING COALESCE(SUM(inv.quantity), 0) > 0";
    } else if (low_stock === "true") {
      havingClause =
        "HAVING COALESCE(SUM(inv.quantity), 0) < p.low_stock_threshold";
    }
    if (no_selling_price === "true") {
      where += ` AND (p.selling_price IS NULL OR p.selling_price = 0)`;
    }

    // has_price filter: show only products with selling_price set
    const { has_price } = request.query as any;
    if (has_price === "true") {
      where += ` AND p.selling_price IS NOT NULL AND p.selling_price > 0`;
    }

    const orderParams: any[] = [];
    let orderBy = "ORDER BY c.name_bg NULLS LAST, p.name_bg";
    if (trimmedSearch) {
      // Prefer exact / prefix hits, then fuzzy pg_trgm similarity across name_bg + name_en.
      const exactParam = `$${paramIdx++}`;
      const prefixParam = `$${paramIdx++}`;
      const normParam = `$${paramIdx++}`;
      orderParams.push(
        trimmedSearch.toLowerCase(),
        `${trimmedSearch.toLowerCase()}%`,
        trimmedSearch,
      );
      orderBy = `ORDER BY
        CASE
          WHEN LOWER(COALESCE(p.name_bg, '')) = ${exactParam} THEN 0
          WHEN LOWER(COALESCE(p.name_en, '')) = ${exactParam} THEN 0
          WHEN LOWER(COALESCE(p.sku, '')) = ${exactParam} THEN 0
          WHEN LOWER(COALESCE(p.name_bg, '')) LIKE ${prefixParam} THEN 1
          WHEN LOWER(COALESCE(p.name_en, '')) LIKE ${prefixParam} THEN 1
          WHEN LOWER(COALESCE(p.sku, '')) LIKE ${prefixParam} THEN 1
          ELSE 2
        END,
        GREATEST(
          similarity(normalize_search(p.name_bg), normalize_search(${normParam})),
          similarity(normalize_search(p.name_en), normalize_search(${normParam}))
        ) DESC,
        c.name_bg NULLS LAST,
        p.name_bg`;
    }

    const sql = `
      SELECT p.*, c.name_bg AS category_name_bg, c.name_en AS category_name_en,
             COALESCE(SUM(inv.quantity), 0)::numeric AS total_stock
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN inventory inv ON inv.product_id = p.id
      ${where}
      GROUP BY p.id, c.name_bg, c.name_en
      ${havingClause}
      ${orderBy}
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    params.push(...orderParams, pageSize, offset);

    const { rows } = await query(sql, params);

    // Total count (must respect HAVING clause for active_only)
    const countParams = params.slice(0, params.length - orderParams.length - 2);
    let countSql: string;
    if (havingClause) {
      countSql = `SELECT COUNT(*) as total FROM (
        SELECT p.id FROM products p
        LEFT JOIN inventory inv ON inv.product_id = p.id
        ${where}
        GROUP BY p.id
        ${havingClause}
      ) sub`;
    } else {
      countSql = `SELECT COUNT(DISTINCT p.id) as total FROM products p ${where}`;
    }
    const { rows: countRows } = await query(countSql, countParams);

    // Also return active count and total catalog count for tab badges
    const { rows: activeCountRows } = await query(
      `SELECT COUNT(*) as total FROM (
        SELECT p.id FROM products p
        LEFT JOIN inventory inv ON inv.product_id = p.id
        GROUP BY p.id
        HAVING COALESCE(SUM(inv.quantity), 0) > 0
      ) sub`,
    );
    const { rows: catalogCountRows } = await query(
      `SELECT COUNT(*) as total FROM products`,
    );

    const filtered = await stripFieldsForUser(request.user as any, rows, [
      {
        permission: PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE,
        fields: ["purchase_price"],
      },
    ]);

    return {
      data: filtered,
      pagination: {
        page: pageNum,
        limit: pageSize,
        total: parseInt(countRows[0]?.total || "0"),
      },
      active_count: parseInt(activeCountRows[0]?.total || "0"),
      catalog_count: parseInt(catalogCountRows[0]?.total || "0"),
    };
  });

  // GET /products/next-sku — returns the next available SKU number
  app.get("/next-sku", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;

    const {
      rows: [{ max_sku }],
    } = await query(
      "SELECT COALESCE(MAX(sku::bigint), 10000) AS max_sku FROM products WHERE sku ~ '^[0-9]{1,9}$'",
    );
    return { next_sku: String(Number(max_sku) + 1) };
  });

  // GET /products/brands — list of distinct brands
  app.get("/brands", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;

    const { rows } = await query(
      `SELECT DISTINCT brand FROM products WHERE brand IS NOT NULL ORDER BY brand ASC`,
    );

    return rows.map((r) => r.brand);
  });

  // GET /products/:id
  app.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    const { id } = request.params as { id: string };

    const { rows } = await query(
      `SELECT p.*, c.name_bg AS category_name_bg, c.name_en AS category_name_en
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.id = $1`,
      [id],
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: "Product not found" });
    }
    return rows[0];
  });

  // GET /products/:id/stock — current inventory
  app.get(
    "/:id/stock",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      const { id } = request.params as { id: string };

      const { rows } = await query(
        `SELECT inv.*, b.batch_number, b.expiry_date, w.name AS warehouse_name
       FROM inventory inv
       LEFT JOIN batches b ON b.id = inv.batch_id
       LEFT JOIN warehouses w ON w.id = inv.warehouse_id
       WHERE inv.product_id = $1
       ORDER BY b.expiry_date ASC NULLS LAST`,
        [id],
      );

      const totalResult = await query(
        "SELECT COALESCE(SUM(quantity), 0)::numeric AS total FROM inventory WHERE product_id = $1",
        [id],
      );

      // Get product name for AI service
      const {
        rows: [product],
      } = await query("SELECT name_bg, name_en FROM products WHERE id = $1", [
        id,
      ]);

      return {
        product_id: parseInt(id),
        total_stock: parseFloat(totalResult.rows[0].total),
        total_quantity: parseFloat(totalResult.rows[0].total),
        name_bg: product?.name_bg || null,
        name_en: product?.name_en || null,
        batches: rows,
      };
    },
  );

  // POST /products
  app.post(
    "/",
    { preHandler: productsManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = createProductSchema.parse(request.body);

      const duplicateReply = await ensureSkuAvailable(body.sku, reply);
      if (duplicateReply) return duplicateReply;

      try {
        const { rows } = await query(
          `INSERT INTO products (name_bg, name_en, sku, category_id, unit, description, image_url, low_stock_threshold, brand, purchase_price, selling_price,
          retail_price, price_group_1, price_group_2, price_group_3, price_group_4, price_group_5, price_group_6, price_group_7, price_group_8, weight_kg)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
         RETURNING *`,
          [
            body.name_bg,
            body.name_en,
            body.sku.trim(),
            body.category_id,
            body.unit,
            body.description,
            body.image_url,
            body.low_stock_threshold,
            body.brand ?? null,
            body.purchase_price ?? null,
            body.selling_price ?? null,
            body.retail_price ?? null,
            body.price_group_1 ?? null,
            body.price_group_2 ?? null,
            body.price_group_3 ?? null,
            body.price_group_4 ?? null,
            body.price_group_5 ?? null,
            body.price_group_6 ?? null,
            body.price_group_7 ?? null,
            body.price_group_8 ?? null,
            body.weight_kg ?? null,
          ],
        );

        return reply.status(201).send(rows[0]);
      } catch (error: any) {
        if (error?.code === "23505") {
          return reply.status(409).send({
            error: "duplicate_sku",
            message: `SKU \"${body.sku.trim()}\" вече съществува. Моля използвайте друг SKU.`,
          });
        }
        throw error;
      }
    },
  );

  // PUT /products/:id
  app.put(
    "/:id",
    { preHandler: productsManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = updateProductSchema.parse(request.body);
      const productId = parseInt(id, 10);

      if (body.sku !== undefined) {
        const duplicateReply = await ensureSkuAvailable(
          body.sku,
          reply,
          productId,
        );
        if (duplicateReply) return duplicateReply;
        body.sku = body.sku.trim();
      }

      const fields: string[] = [];
      const values: any[] = [];
      let idx = 1;

      for (const [key, val] of Object.entries(body)) {
        if (val !== undefined) {
          fields.push(`${key} = $${idx++}`);
          values.push(val);
        }
      }

      if (fields.length === 0) {
        return reply.status(400).send({ error: "No fields to update" });
      }

      fields.push(`updated_at = NOW()`);
      values.push(id);

      let rows;
      try {
        const result = await query(
          `UPDATE products SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
          values,
        );
        rows = result.rows;
      } catch (error: any) {
        if (error?.code === "23505" && body.sku) {
          return reply.status(409).send({
            error: "duplicate_sku",
            message: `SKU \"${body.sku}\" вече съществува. Моля използвайте друг SKU.`,
          });
        }
        throw error;
      }

      if (rows.length === 0) {
        return reply.status(404).send({ error: "Product not found" });
      }
      return rows[0];
    },
  );

  // DELETE /products/:id
  app.delete(
    "/:id",
    { preHandler: productsManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const { rowCount } = await query("DELETE FROM products WHERE id = $1", [
        id,
      ]);

      if (rowCount === 0) {
        return reply.status(404).send({ error: "Product not found" });
      }
      return { message: "Product deleted" };
    },
  );
}
