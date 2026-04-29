// MERT-M inventory — batch-free. MERT-M sells durable commercial kitchen
// equipment (Hendi, Bartscher, KitchenAid, Liebherr), so there is no batch
// tracking and no expiry tracking. Stock is aggregated per product across
// inventory rows. The old Greek Foods endpoints for batch CRUD,
// `/expiring`, and `no_expiry`/`no_batch` filters are gone.
//
// Current endpoints:
//   GET  /inventory                — paginated list, one row per product
//   GET  /inventory/low-stock      — products where total qty < low_stock_threshold
//   POST /inventory/adjust/:productId — admin-only manual stock adjustment
//   POST /inventory/reset-stock    — admin-only, sets all inventory to 0
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query, transaction } from "../db.js";
import { stripFieldsForUser, PERMISSIONS } from "../lib/permissions.js";

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
  if ((request as any).user?.role !== "admin") {
    return reply.status(403).send({ error: "Admin access required" });
  }
}

export default async function inventoryRoutes(app: FastifyInstance) {
  // GET /inventory — current stock levels, one row per product.
  //
  // Unknown query params (e.g. legacy `no_expiry`, `no_batch`) are silently
  // ignored: we only read the keys we recognise and never declare a strict
  // query schema, so frontend callers that still pass the old filters do
  // not get a 400.
  app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);

    const { warehouse_id, page, limit, has_stock, search } =
      request.query as any;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const offset = (pageNum - 1) * pageSize;
    const trimmedSearch = typeof search === "string" ? search.trim() : "";

    const conditions: string[] = [];
    const filterParams: any[] = [];
    let paramIdx = 1;

    if (warehouse_id) {
      conditions.push(`inv.warehouse_id = $${paramIdx++}`);
      filterParams.push(parseInt(warehouse_id));
    }

    if (trimmedSearch) {
      // Translit-aware match on name; raw ILIKE for sku (alphanumeric codes).
      conditions.push(`(
        normalize_search(p.name_bg) ILIKE '%' || normalize_search($${paramIdx}) || '%'
        OR normalize_search(p.name_en) ILIKE '%' || normalize_search($${paramIdx}) || '%'
        OR p.sku ILIKE $${paramIdx + 1}
      )`);
      filterParams.push(trimmedSearch, `%${trimmedSearch}%`);
      paramIdx += 2;
    }

    const where =
      conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

    // HAVING clause for aggregate filters
    const havingConds: string[] = [];
    if (has_stock === "true") {
      havingConds.push("COALESCE(SUM(inv.quantity), 0) > 0");
    } else if (has_stock === "zero") {
      havingConds.push("COALESCE(SUM(inv.quantity), 0) = 0");
    }

    const having =
      havingConds.length > 0 ? "HAVING " + havingConds.join(" AND ") : "";

    const orderParams: any[] = [];
    let orderBy = "ORDER BY p.name_bg";
    if (trimmedSearch) {
      const exactParam = `$${paramIdx++}`;
      const prefixParam = `$${paramIdx++}`;
      orderParams.push(
        trimmedSearch.toLowerCase(),
        `${trimmedSearch.toLowerCase()}%`,
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
        p.name_bg`;
    }

    const limitParam = `$${paramIdx++}`;
    const offsetParam = `$${paramIdx++}`;
    const sql = `
      SELECT p.id AS product_id, p.name_bg, p.name_en, p.sku, p.unit,
             p.low_stock_threshold, p.selling_price, p.purchase_price,
             COALESCE(SUM(inv.quantity), 0)::numeric AS total_quantity,
             c.name_bg AS category_name_bg, c.name_en AS category_name_en
      FROM products p
      LEFT JOIN inventory inv ON inv.product_id = p.id
      LEFT JOIN categories c ON c.id = p.category_id
      ${where}
      GROUP BY p.id, c.name_bg, c.name_en
      ${having}
      ${orderBy}
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;
    const dataParams = [...filterParams, ...orderParams, pageSize, offset];

    const { rows } = await query(sql, dataParams);

    // Count total for pagination (same HAVING to keep totals consistent)
    const countSql = `
      SELECT COUNT(*) as total FROM (
        SELECT p.id
        FROM products p
        LEFT JOIN inventory inv ON inv.product_id = p.id
        ${where}
        GROUP BY p.id
        ${having}
      ) sub
    `;
    const { rows: countRows } = await query(countSql, filterParams);
    const total = parseInt(countRows[0]?.total || "0");

    const filtered = await stripFieldsForUser(request.user as any, rows, [
      {
        permission: PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE,
        fields: ["purchase_price"],
      },
    ]);

    return {
      data: filtered,
      pagination: { page: pageNum, limit: pageSize, total },
    };
  });

  // GET /inventory/low-stock — products whose total stock is below their
  // configured low_stock_threshold. Paginated + searchable.
  app.get(
    "/low-stock",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);

      const { page, limit, search } = request.query as any;
      const pageNum = Math.max(1, parseInt(page) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 50));
      const offset = (pageNum - 1) * pageSize;

      const searchClause = search
        ? ` AND (
            normalize_search(p.name_bg) ILIKE '%' || normalize_search($1) || '%'
            OR normalize_search(p.name_en) ILIKE '%' || normalize_search($1) || '%'
            OR p.sku ILIKE $2
          )`
        : "";
      const dataParams = search
        ? [search, `%${search}%`, pageSize, offset]
        : [pageSize, offset];
      const countParams = search ? [search, `%${search}%`] : [];
      const limitParam = search ? "$3" : "$1";
      const offsetParam = search ? "$4" : "$2";

      const { rows } = await query(
        `
      SELECT p.id AS product_id, p.name_bg, p.name_en, p.sku, p.unit,
             p.low_stock_threshold,
             COALESCE(SUM(inv.quantity), 0)::numeric AS total_quantity
      FROM products p
      LEFT JOIN inventory inv ON inv.product_id = p.id
      WHERE 1=1
      ${searchClause}
      GROUP BY p.id
      HAVING COALESCE(SUM(inv.quantity), 0) < p.low_stock_threshold
      ORDER BY COALESCE(SUM(inv.quantity), 0) ASC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `,
        dataParams,
      );

      const { rows: countRows } = await query(
        `
      SELECT COUNT(*) as total FROM (
        SELECT p.id FROM products p
        LEFT JOIN inventory inv ON inv.product_id = p.id
        WHERE 1=1
        ${searchClause}
        GROUP BY p.id
        HAVING COALESCE(SUM(inv.quantity), 0) < p.low_stock_threshold
      ) sub
    `,
        countParams,
      );
      const total = parseInt(countRows[0]?.total || "0");

      return {
        data: rows,
        count: total,
        pagination: { page: pageNum, limit: pageSize, total },
      };
    },
  );

  // POST /inventory/adjust/:productId — manual stock adjustment (admin only).
  // Required replacement for the legacy PUT /:productId/batch/:batchId path:
  // MERT-M still needs a way to correct qty after a physical stock count.
  // Audit trail is mandatory (Закон за счетоводството чл. 3 + чл. 6) so we
  // require a reason and log to audit_events on non-zero delta.
  app.post(
    "/adjust/:productId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request, reply);
      if (reply.sent) return;

      const { productId } = request.params as { productId: string };
      const productIdNum = parseInt(productId, 10);
      if (Number.isNaN(productIdNum)) {
        return reply.status(400).send({ error: "Invalid product id" });
      }

      const bodySchema = z.object({
        quantity: z.number(),
        warehouse_id: z.number().int().optional(),
        reason: z.string().min(3, "Задължителна е причина (мин. 3 символа)"),
      });
      const body = bodySchema.parse(request.body);

      try {
        const result = await transaction(async (client) => {
          // 1. Confirm product exists
          const { rows: products } = await client.query(
            "SELECT id FROM products WHERE id = $1",
            [productIdNum],
          );
          if (products.length === 0) {
            throw Object.assign(new Error("Продуктът не е намерен"), {
              statusCode: 404,
            });
          }

          // 2. Pick warehouse (default = first one, usually id=1)
          let warehouseId = body.warehouse_id;
          if (!warehouseId) {
            const { rows: warehouses } = await client.query(
              "SELECT id FROM warehouses ORDER BY id LIMIT 1",
            );
            if (warehouses.length === 0) {
              throw Object.assign(new Error("No warehouse configured"), {
                statusCode: 500,
              });
            }
            warehouseId = warehouses[0].id;
          }

          // 3. Snapshot existing qty for delta + audit
          const { rows: existing } = await client.query(
            `SELECT id, quantity FROM inventory
             WHERE product_id = $1 AND warehouse_id = $2 AND batch_id IS NULL
             FOR UPDATE`,
            [productIdNum, warehouseId],
          );
          const previousQty = existing[0]
            ? parseFloat(existing[0].quantity)
            : 0;
          const delta = body.quantity - previousQty;

          // 4. Upsert — relies on the partial unique index
          //    inventory_product_warehouse_nobatch_uidx added in migration 045.
          if (existing[0]) {
            await client.query(
              `UPDATE inventory SET quantity = $1, updated_at = NOW()
               WHERE id = $2`,
              [body.quantity, existing[0].id],
            );
          } else {
            await client.query(
              `INSERT INTO inventory (product_id, warehouse_id, batch_id, quantity)
               VALUES ($1, $2, NULL, $3)`,
              [productIdNum, warehouseId, body.quantity],
            );
          }

          // 5. Audit log when qty actually changed
          if (Math.abs(delta) > 0.0001) {
            try {
              await client.query(
                `INSERT INTO audit_events
                   (actor_user_id, actor_email, action, entity_type, entity_id, diff)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                  (request as any).user.id,
                  (request as any).user.email,
                  delta > 0
                    ? "inventory_adjustment.increase"
                    : "inventory_adjustment.decrease",
                  "inventory",
                  productIdNum,
                  JSON.stringify({
                    product_id: productIdNum,
                    warehouse_id: warehouseId,
                    old_quantity: previousQty,
                    new_quantity: body.quantity,
                    delta,
                    reason: body.reason.trim(),
                  }),
                ],
              );
            } catch (auditErr: any) {
              // Tolerate missing audit_events table only (older envs)
              if (auditErr?.code !== "42P01") throw auditErr;
            }
          }

          return {
            product_id: productIdNum,
            warehouse_id: warehouseId,
            previous_quantity: previousQty,
            new_quantity: body.quantity,
            delta,
          };
        });

        return reply.status(200).send(result);
      } catch (err: any) {
        if (err?.statusCode) {
          return reply.status(err.statusCode).send({ error: err.message });
        }
        request.log.error({ err }, "Failed to adjust inventory");
        return reply
          .status(500)
          .send({ error: "Неуспешна корекция на наличност." });
      }
    },
  );

  // POST /inventory/reset-stock — wipe all inventory quantities to 0
  // (admin only). Used during initial data migration / dev reset.
  app.post(
    "/reset-stock",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request, reply);
      if (reply.sent) return;

      await query("UPDATE inventory SET quantity = 0, updated_at = NOW()");

      return { ok: true, message: "All stock quantities reset to 0" };
    },
  );
}
