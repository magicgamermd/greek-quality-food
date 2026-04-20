import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query, transaction } from "../db.js";

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
  if (request.user.role !== "admin") {
    throw Object.assign(new Error("Admin access required"), {
      statusCode: 403,
    });
  }
}

export default async function inventoryRoutes(app: FastifyInstance) {
  // GET /inventory — current stock levels
  app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);

    const {
      warehouse_id,
      page,
      limit,
      has_stock,
      no_expiry,
      no_batch,
      search,
    } = request.query as any;
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
      // Translit-aware match on name; raw ILIKE for sku/batch (alphanumeric codes)
      conditions.push(`(
        normalize_search(p.name_bg) ILIKE '%' || normalize_search($${paramIdx}) || '%'
        OR normalize_search(p.name_en) ILIKE '%' || normalize_search($${paramIdx}) || '%'
        OR p.sku ILIKE $${paramIdx + 1}
        OR COALESCE(b.batch_number, '') ILIKE $${paramIdx + 1}
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

    // no_expiry: items with stock rows that are missing expiry dates
    if (no_expiry === "true") {
      havingConds.push(
        "COUNT(inv.product_id) > 0 AND COUNT(CASE WHEN inv.batch_id IS NULL OR b.expiry_date IS NULL THEN 1 END) > 0",
      );
    }

    // no_batch: items that have batches with expiry but no batch_number
    if (no_batch === "true") {
      havingConds.push(
        "(COUNT(b.id) = 0 OR COUNT(CASE WHEN b.batch_number IS NULL OR b.batch_number = '' THEN 1 END) > 0)",
      );
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
             COALESCE(SUM(inv.quantity), 0)::numeric AS total_stock,
             c.name_bg AS category_name_bg, c.name_en AS category_name_en,
             COALESCE(
               json_agg(
                 json_build_object(
                   'batch_id',     b.id,
                   'batch_number', b.batch_number,
                   'expiry_date',  b.expiry_date,
                   'quantity',     inv.quantity
                 ) ORDER BY b.expiry_date ASC NULLS LAST
               ) FILTER (WHERE b.id IS NOT NULL),
               '[]'
             ) AS batches
      FROM products p
      LEFT JOIN inventory inv ON inv.product_id = p.id
      LEFT JOIN batches b ON b.id = inv.batch_id
      LEFT JOIN categories c ON c.id = p.category_id
      ${where}
      GROUP BY p.id, c.name_bg, c.name_en
      ${having}
      ${orderBy}
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;
    const dataParams = [...filterParams, ...orderParams, pageSize, offset];

    const { rows } = await query(sql, dataParams);

    // Count total for pagination (need to apply same having)
    const countSql = `
      SELECT COUNT(*) as total FROM (
        SELECT p.id
        FROM products p
        LEFT JOIN inventory inv ON inv.product_id = p.id
        LEFT JOIN batches b ON b.id = inv.batch_id
        ${where}
        GROUP BY p.id
        ${having}
      ) sub
    `;
    const { rows: countRows } = await query(countSql, filterParams);
    const total = parseInt(countRows[0]?.total || "0");

    return {
      data: rows,
      pagination: { page: pageNum, limit: pageSize, total },
    };
  });

  // GET /inventory/low-stock — products below threshold (with pagination)
  app.get(
    "/low-stock",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);

      const { page, limit, search } = request.query as any;
      const pageNum = Math.max(1, parseInt(page) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 50));
      const offset = (pageNum - 1) * pageSize;

      // Translit-aware for names; raw ILIKE for alphanumeric sku/batch_number
      const searchClause = search
        ? ` AND (
            normalize_search(p.name_bg) ILIKE '%' || normalize_search($1) || '%'
            OR normalize_search(p.name_en) ILIKE '%' || normalize_search($1) || '%'
            OR p.sku ILIKE $2
            OR EXISTS (
              SELECT 1 FROM batches sb
              WHERE sb.product_id = p.id
                AND COALESCE(sb.batch_number, '') ILIKE $2
            )
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
             COALESCE(SUM(inv.quantity), 0)::numeric AS total_stock
      FROM products p
      LEFT JOIN inventory inv ON inv.product_id = p.id
      WHERE (
        EXISTS (SELECT 1 FROM batches pb WHERE pb.product_id = p.id)
        OR EXISTS (SELECT 1 FROM inventory i2 WHERE i2.product_id = p.id AND i2.quantity > 0)
      )
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
        WHERE (
          EXISTS (SELECT 1 FROM batches pb WHERE pb.product_id = p.id)
          OR EXISTS (SELECT 1 FROM inventory i2 WHERE i2.product_id = p.id AND i2.quantity > 0)
        )
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

  // GET /inventory/expiring — batches expiring within N days (with pagination)
  app.get("/expiring", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);

    const { days, page, limit, search } = request.query as any;
    const withinDays = parseInt(days) || 30;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const offset = (pageNum - 1) * pageSize;

    // Translit-aware names; raw ILIKE for sku/batch_number codes
    const searchClause = search
      ? ` AND (
          normalize_search(p.name_bg) ILIKE '%' || normalize_search($2) || '%'
          OR normalize_search(p.name_en) ILIKE '%' || normalize_search($2) || '%'
          OR p.sku ILIKE $3
          OR COALESCE(b.batch_number, '') ILIKE $3
        )`
      : "";
    const dataParams = search
      ? [withinDays, search, `%${search}%`, pageSize, offset]
      : [withinDays, pageSize, offset];
    const countParams = search
      ? [withinDays, search, `%${search}%`]
      : [withinDays];
    const limitParam = search ? "$4" : "$2";
    const offsetParam = search ? "$5" : "$3";

    const { rows } = await query(
      `SELECT b.id AS batch_id, b.batch_number, b.expiry_date,
              p.id AS product_id, p.name_bg, p.name_en, p.sku,
              COALESCE(inv.quantity, 0)::numeric AS quantity,
              b.expiry_date - CURRENT_DATE AS days_until_expiry
       FROM batches b
       JOIN products p ON p.id = b.product_id
       LEFT JOIN inventory inv ON inv.batch_id = b.id
       WHERE b.expiry_date IS NOT NULL
         AND b.expiry_date <= CURRENT_DATE + $1::integer
         AND COALESCE(inv.quantity, 0) > 0
         ${searchClause}
       ORDER BY b.expiry_date ASC
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      dataParams,
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) as total FROM batches b
       JOIN products p ON p.id = b.product_id
       LEFT JOIN inventory inv ON inv.batch_id = b.id
       WHERE b.expiry_date IS NOT NULL
         AND b.expiry_date <= CURRENT_DATE + $1::integer
         AND COALESCE(inv.quantity, 0) > 0
         ${searchClause}`,
      countParams,
    );
    const total = parseInt(countRows[0]?.total || "0");

    return {
      data: rows,
      count: total,
      within_days: withinDays,
      pagination: { page: pageNum, limit: pageSize, total },
    };
  });

  // GET /inventory/valuation — financial snapshot (admin + accountant only).
  // Sums current stock at weighted cost, year-to-date write-offs, breakdown
  // by category, and the value of stock expiring within 30 days.
  app.get(
    "/valuation",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);

      const role = (request as any).user?.role;
      if (role !== "admin" && role !== "accountant") {
        return reply
          .status(403)
          .send({ error: "Нямате достъп до финансови отчети" });
      }

      const { as_of_date, warehouse_id } = request.query as {
        as_of_date?: string;
        warehouse_id?: string;
      };

      const asOf =
        as_of_date && /^\d{4}-\d{2}-\d{2}$/.test(as_of_date)
          ? as_of_date
          : new Date().toISOString().split("T")[0];

      const wh = warehouse_id ? parseInt(warehouse_id, 10) : null;
      const whClause = wh ? ` AND inv.warehouse_id = $2` : "";
      const whParams: any[] = wh ? [asOf, wh] : [asOf];

      // Current stock value — weighted by batch.unit_cost with fallback to
      // products.purchase_price when the batch has no recorded cost.
      const currentValueSql = `
        SELECT COALESCE(SUM(
          inv.quantity *
          COALESCE(b.unit_cost, p.purchase_price, 0)
        ), 0)::numeric AS value
        FROM inventory inv
        JOIN products p ON p.id = inv.product_id
        LEFT JOIN batches b ON b.id = inv.batch_id
        WHERE inv.quantity > 0
          AND (p.is_deleted IS NULL OR p.is_deleted = false)
          ${whClause}
      `;
      const { rows: valueRows } = await query(currentValueSql, whParams);
      const currentValue = parseFloat(valueRows[0]?.value || "0");

      // YTD write-offs: from Jan 1 of the as_of year through as_of_date.
      const yearStart = `${asOf.slice(0, 4)}-01-01`;
      const writeoffWhClause = wh ? ` AND warehouse_id = $3` : "";
      const writeoffParams: any[] = wh
        ? [yearStart, asOf, wh]
        : [yearStart, asOf];

      const { rows: writeoffRows } = await query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(SUM(total_cost), 0)::numeric AS value,
                reason,
                COALESCE(SUM(total_cost), 0)::numeric AS reason_value
         FROM stock_writeoffs
         WHERE written_off_at::date >= $1
           AND written_off_at::date <= $2
           ${writeoffWhClause}
         GROUP BY reason`,
        writeoffParams,
      );

      const byReason: Record<string, { count: number; value: number }> = {};
      let writeoffTotalCount = 0;
      let writeoffTotalValue = 0;
      for (const row of writeoffRows) {
        const c = parseInt(row.count, 10);
        const v = parseFloat(row.reason_value);
        byReason[row.reason] = { count: c, value: v };
        writeoffTotalCount += c;
        writeoffTotalValue += v;
      }

      // Category breakdown
      const { rows: categoryRows } = await query(
        `
        SELECT c.id AS category_id,
               COALESCE(c.name_bg, 'Без категория') AS name,
               COUNT(DISTINCT p.id)::int AS product_count,
               COALESCE(SUM(inv.quantity), 0)::numeric AS qty,
               COALESCE(SUM(
                 inv.quantity * COALESCE(b.unit_cost, p.purchase_price, 0)
               ), 0)::numeric AS value
        FROM inventory inv
        JOIN products p ON p.id = inv.product_id
        LEFT JOIN batches b ON b.id = inv.batch_id
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE inv.quantity > 0
          AND (p.is_deleted IS NULL OR p.is_deleted = false)
          ${whClause}
        GROUP BY c.id, c.name_bg
        ORDER BY value DESC
        `,
        whParams,
      );

      // Expiring stock windows
      const expiringWhClause = wh ? ` AND inv.warehouse_id = $2` : "";
      const expiringParams: any[] = wh ? [asOf, wh] : [asOf];

      const { rows: expiring30Rows } = await query(
        `
        SELECT COUNT(*)::int AS count,
               COALESCE(SUM(
                 inv.quantity * COALESCE(b.unit_cost, p.purchase_price, 0)
               ), 0)::numeric AS value
        FROM inventory inv
        JOIN products p ON p.id = inv.product_id
        JOIN batches b ON b.id = inv.batch_id
        WHERE inv.quantity > 0
          AND b.expiry_date IS NOT NULL
          AND b.expiry_date > $1::date
          AND b.expiry_date <= $1::date + INTERVAL '30 days'
          ${expiringWhClause}
        `,
        expiringParams,
      );

      const { rows: expiredRows } = await query(
        `
        SELECT COUNT(*)::int AS count,
               COALESCE(SUM(
                 inv.quantity * COALESCE(b.unit_cost, p.purchase_price, 0)
               ), 0)::numeric AS value
        FROM inventory inv
        JOIN products p ON p.id = inv.product_id
        JOIN batches b ON b.id = inv.batch_id
        WHERE inv.quantity > 0
          AND b.expiry_date IS NOT NULL
          AND b.expiry_date <= $1::date
          ${expiringWhClause}
        `,
        expiringParams,
      );

      return {
        as_of_date: asOf,
        warehouse_id: wh,
        current_value: Math.round(currentValue * 100) / 100,
        ytd_writeoffs: {
          count: writeoffTotalCount,
          value: Math.round(writeoffTotalValue * 100) / 100,
          by_reason: byReason,
        },
        by_category: categoryRows.map((row) => ({
          category_id: row.category_id,
          name: row.name,
          product_count: row.product_count,
          qty: parseFloat(row.qty),
          value: Math.round(parseFloat(row.value) * 100) / 100,
        })),
        expiring_soon: {
          in_30_days: {
            count: parseInt(expiring30Rows[0]?.count || "0", 10),
            value:
              Math.round(parseFloat(expiring30Rows[0]?.value || "0") * 100) /
              100,
          },
          already_expired: {
            count: parseInt(expiredRows[0]?.count || "0", 10),
            value:
              Math.round(parseFloat(expiredRows[0]?.value || "0") * 100) / 100,
          },
        },
      };
    },
  );

  // POST /inventory/:productId/batch — add a new batch to a product that
  // already exists in inventory (legacy migration, belated supplier batch
  // info, manual split of no-batch stock, inventory corrections). Atomic:
  // creates the batches row + inventory row in a single transaction, optionally
  // transferring qty from the existing no-batch inventory bucket, and logs
  // everything in audit_events.
  app.post(
    "/:productId/batch",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      if ((request as any).user.role === "accountant") {
        return reply.status(403).send({ error: "Insufficient permissions" });
      }

      const { productId } = request.params as { productId: string };

      const bodySchema = z.object({
        batch_number: z.string().min(1, "Партида № е задължително"),
        expiry_date: z.string().optional().nullable(),
        quantity: z.number().positive("Количеството трябва да е > 0"),
        // "transfer": взима се от inventory row с batch_id=NULL (няма net
        //             увеличение на общата наличност) — ползва се когато
        //             легаси стокът е бил без партида и се split-ва.
        // "add":      добавя се изцяло нова наличност — изисква reason
        //             (напр. инвентаризация, belated supplier info).
        source: z.enum(["transfer", "add"]),
        reason: z.string().optional(),
      });

      const body = bodySchema.parse(request.body);
      const productIdNum = parseInt(productId);

      if (Number.isNaN(productIdNum)) {
        return reply.status(400).send({ error: "Invalid product id" });
      }

      try {
        const result = await transaction(async (client) => {
          // 1. Verify product exists
          const { rows: products } = await client.query(
            "SELECT id FROM products WHERE id = $1",
            [productIdNum],
          );
          if (products.length === 0) {
            throw Object.assign(new Error("Продуктът не е намерен"), {
              statusCode: 404,
            });
          }

          // 2. Pick the default warehouse (id=1 — single-warehouse deployment).
          //    If multi-warehouse ever ships, pass warehouse_id in the body.
          const { rows: warehouses } = await client.query(
            "SELECT id FROM warehouses ORDER BY id LIMIT 1",
          );
          if (warehouses.length === 0) {
            throw Object.assign(new Error("No warehouse configured"), {
              statusCode: 500,
            });
          }
          const warehouseId = warehouses[0].id;

          // 3. Prevent duplicate batch_number for the same product
          const { rows: existingBatch } = await client.query(
            `SELECT id FROM batches
             WHERE product_id = $1 AND batch_number = $2`,
            [productIdNum, body.batch_number],
          );
          if (existingBatch.length > 0) {
            throw Object.assign(
              new Error(
                `Вече има партида "${body.batch_number}" за този продукт`,
              ),
              { statusCode: 409 },
            );
          }

          // 4. If transfer mode — subtract from the no-batch inventory bucket
          if (body.source === "transfer") {
            const { rows: noBatchRows } = await client.query(
              `SELECT quantity FROM inventory
               WHERE product_id = $1 AND batch_id IS NULL AND warehouse_id = $2
               FOR UPDATE`,
              [productIdNum, warehouseId],
            );
            const noBatchQty = noBatchRows[0]
              ? parseFloat(noBatchRows[0].quantity)
              : 0;
            if (noBatchQty < body.quantity - 0.0001) {
              throw Object.assign(
                new Error(
                  `Недостатъчна наличност без партида (${noBatchQty}). Избери "Нова наличност" ако добавяш нова стока.`,
                ),
                { statusCode: 400 },
              );
            }
            await client.query(
              `UPDATE inventory
               SET quantity = quantity - $1, updated_at = NOW()
               WHERE product_id = $2 AND batch_id IS NULL AND warehouse_id = $3`,
              [body.quantity, productIdNum, warehouseId],
            );
          } else {
            // "add" — require reason since total stock grows
            const reason = (body.reason ?? "").trim();
            if (reason.length < 3) {
              throw Object.assign(
                new Error(
                  "Задължителна е причина (мин. 3 символа) при добавяне на нова наличност.",
                ),
                { statusCode: 400 },
              );
            }
          }

          // 5. Create the batch
          const {
            rows: [batch],
          } = await client.query(
            `INSERT INTO batches (product_id, batch_number, expiry_date, quantity, received_date)
             VALUES ($1, $2, $3::date, $4, CURRENT_DATE)
             RETURNING *`,
            [
              productIdNum,
              body.batch_number,
              body.expiry_date || null,
              body.quantity,
            ],
          );

          // 6. Create the matching inventory row
          await client.query(
            `INSERT INTO inventory (product_id, batch_id, warehouse_id, quantity)
             VALUES ($1, $2, $3, $4)`,
            [productIdNum, batch.id, warehouseId, body.quantity],
          );

          // 7. Audit log
          try {
            await client.query(
              `INSERT INTO audit_events
                 (actor_user_id, actor_email, action, entity_type, entity_id, diff)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                (request as any).user.id,
                (request as any).user.email,
                body.source === "transfer"
                  ? "inventory_batch.split_from_no_batch"
                  : "inventory_batch.add_new",
                "inventory_batch",
                batch.id,
                JSON.stringify({
                  product_id: productIdNum,
                  batch_id: batch.id,
                  batch_number: body.batch_number,
                  expiry_date: body.expiry_date,
                  quantity: body.quantity,
                  source: body.source,
                  reason: (body.reason ?? "").trim() || null,
                }),
              ],
            );
          } catch (auditErr: any) {
            if (auditErr?.code !== "42P01") throw auditErr;
          }

          return batch;
        });

        return reply.status(201).send(result);
      } catch (err: any) {
        if (err?.statusCode) {
          return reply.status(err.statusCode).send({ error: err.message });
        }
        request.log.error({ err }, "Failed to add batch to product");
        return reply
          .status(500)
          .send({ error: "Неуспешно създаване на партида." });
      }
    },
  );

  // PUT /inventory/:productId/batch/:batchId — edit inventory item
  app.put(
    "/:productId/batch/:batchId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      if ((request as any).user.role === "accountant") {
        return reply.status(403).send({ error: "Insufficient permissions" });
      }

      const { productId, batchId } = request.params as {
        productId: string;
        batchId: string;
      };

      const updateSchema = z.object({
        batch_number: z.string().optional(),
        expiry_date: z.string().optional().nullable(),
        quantity: z.number().optional(),
        adjustment_reason: z.string().optional(),
      });

      const body = updateSchema.parse(request.body);

      // Update batch fields
      const batchUpdates: string[] = [];
      const batchParams: any[] = [];
      let idx = 1;

      if (body.batch_number !== undefined) {
        batchUpdates.push(`batch_number = $${idx++}`);
        batchParams.push(body.batch_number);
      }
      if (body.expiry_date !== undefined) {
        batchUpdates.push(`expiry_date = $${idx++}`);
        batchParams.push(body.expiry_date);
      }

      if (batchUpdates.length > 0) {
        batchParams.push(parseInt(batchId));
        await query(
          `UPDATE batches SET ${batchUpdates.join(", ")}, updated_at = NOW() WHERE id = $${idx}`,
          batchParams,
        );
      }

      // Update inventory quantity if provided — with accounting-grade guards
      // (Закон за счетоводството чл. 3 + чл. 6): any manual stock adjustment
      // must be accompanied by a reason and gets logged to audit_events.
      if (body.quantity !== undefined) {
        // Snapshot current value so we can compute the delta + decide whether
        // to require the reason (changes only — no-op writes are allowed
        // without a reason).
        const { rows: currentRows } = await query(
          `SELECT quantity FROM inventory
           WHERE product_id = $1 AND batch_id = $2`,
          [parseInt(productId), parseInt(batchId)],
        );
        const currentQty = currentRows[0]
          ? parseFloat(currentRows[0].quantity)
          : 0;
        const newQty = body.quantity;
        const delta = newQty - currentQty;

        // Require adjustment_reason when the quantity actually changes.
        // Небрежно "update quantity = X" без причина чупи audit trail
        // и прави невъзможна проверката от счетоводство / НАП.
        if (Math.abs(delta) > 0.0001) {
          const reason = (body.adjustment_reason ?? "").trim();
          if (reason.length < 3) {
            return reply.status(400).send({
              error: "Задължителна е причина за корекцията (мин. 3 символа).",
            });
          }
        }

        await query(
          `UPDATE inventory SET quantity = $1, updated_at = NOW()
           WHERE product_id = $2 AND batch_id = $3`,
          [newQty, parseInt(productId), parseInt(batchId)],
        );
        // Also sync batch quantity
        await query(
          `UPDATE batches SET quantity = $1, updated_at = NOW() WHERE id = $2`,
          [newQty, parseInt(batchId)],
        );

        // Log the adjustment to audit_events for complete traceability.
        if (Math.abs(delta) > 0.0001) {
          try {
            await query(
              `INSERT INTO audit_events
                 (actor_user_id, actor_email, action, entity_type, entity_id, diff)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                (request as any).user.id,
                (request as any).user.email,
                delta > 0
                  ? "inventory_adjustment.increase"
                  : "inventory_adjustment.decrease",
                "inventory_batch",
                parseInt(batchId),
                JSON.stringify({
                  product_id: parseInt(productId),
                  batch_id: parseInt(batchId),
                  old_quantity: currentQty,
                  new_quantity: newQty,
                  delta,
                  reason: (body.adjustment_reason ?? "").trim(),
                }),
              ],
            );
          } catch (auditErr: any) {
            // Swallow "relation does not exist" only — older environments.
            if (auditErr?.code !== "42P01") {
              throw auditErr;
            }
          }
        }
      }

      return { ok: true };
    },
  );

  // POST /inventory/reset-stock — reset ALL stock quantities to 0 (admin only)
  app.post(
    "/reset-stock",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request, reply);
      if (reply.statusCode >= 400) return;

      await transaction(async (client) => {
        // Set all inventory quantities to 0
        await client.query(
          "UPDATE inventory SET quantity = 0, updated_at = NOW()",
        );
        // Set all batch quantities to 0
        await client.query(
          "UPDATE batches SET quantity = 0, updated_at = NOW()",
        );
      });

      return { ok: true, message: "All stock quantities reset to 0" };
    },
  );
}
