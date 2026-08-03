import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query, transaction } from "../db.js";
import {
  PERMISSIONS,
  requirePermission,
  hasPermission,
} from "../lib/permissions.js";
import {
  allocateFefo,
  InsufficientStockError,
} from "../services/fefo-allocator.js";

/**
 * Stock movements — ръчни in/out adjustments на inventory.
 *
 * Use cases:
 *   • 'in':  доставка без фактура, корекция инвентаризация, връщане от
 *           клиент без credit note, безплатен sample
 *   • 'out': брак, експирация, кражба, лично ползване, подарък на клиент
 *
 * Audit: всеки запис носи created_by + created_at + snapshot преди/след.
 *
 * Permission: STOCK_MOVEMENTS_MANAGE (admin + accountant by default).
 *
 * NB (GQF): route-овете следват GQF конвенцията за този backend —
 * plain Fastify (app.get/app.post + preHandler), а валидацията се прави
 * ръчно в handler-а чрез schema.parse() (този backend не ползва
 * fastify-type-provider-zod / schema блокове в route дефиницията).
 */

async function jwtVerify(request: FastifyRequest) {
  await request.jwtVerify();
}

const stockMovementsManagePreHandler = [
  jwtVerify,
  requirePermission(PERMISSIONS.STOCK_MOVEMENTS_MANAGE),
];

// Разрешени reason стойности per movement_type. Frontend dropdown-ите
// четат същия списък през GET /stock-movements/reasons.
const REASONS_IN = [
  "delivery_no_invoice",
  "inventory_correction",
  "customer_return",
  "free_sample",
  "other",
] as const;
const REASONS_OUT = [
  "damaged",
  "expired",
  "theft_loss",
  "internal_use",
  "gift",
  "inventory_correction",
  "other",
] as const;

// БГ labels за UI display. Backend ги връща през reasons endpoint-а за
// единен източник на истина (frontend не дублира текстовете).
const REASON_LABELS_BG: Record<string, string> = {
  delivery_no_invoice: "Доставка без фактура",
  inventory_correction: "Корекция при инвентаризация",
  customer_return: "Връщане от клиент",
  free_sample: "Безплатен sample / промо",
  damaged: "Брак / повреда",
  expired: "Експирация / стара стока",
  theft_loss: "Кражба / липса",
  internal_use: "Лично или служебно ползване",
  gift: "Подарък на клиент",
  other: "Друго",
};

const createMovementSchema = z
  .object({
    product_id: z.number().int().positive(),
    movement_type: z.enum(["in", "out"]),
    quantity: z.coerce.number().positive().describe("Винаги положително."),
    reason: z.string().min(1),
    note: z.string().nullable().optional(),
    // Admin override за случаи когато 'out' ще остави inventory < 0
    // (рядко — за корекции). Без този флаг се отказва.
    allow_negative: z.boolean().optional().default(false),
  })
  .refine(
    (d) =>
      (d.movement_type === "in" && REASONS_IN.includes(d.reason as any)) ||
      (d.movement_type === "out" && REASONS_OUT.includes(d.reason as any)),
    {
      message: "Невалидна причина за този тип движение.",
      path: ["reason"],
    },
  );

const listQuerySchema = z.object({
  movement_type: z.enum(["in", "out"]).optional(),
  product_id: z.coerce.number().int().positive().optional(),
  user_id: z.string().uuid().optional(),
  date_from: z.string().optional().describe("ISO date YYYY-MM-DD"),
  date_to: z.string().optional().describe("ISO date YYYY-MM-DD"),
  limit: z.coerce.number().int().min(1).max(10000).optional().default(200),
});

export default async function stockMovementsRoutes(fastify: FastifyInstance) {
  // GET /stock-movements/reasons — dropdown options + labels for UI.
  // Single source of truth — frontend-ът не дублира текстовете.
  fastify.get("/reasons", { preHandler: [jwtVerify] }, async () => {
    return {
      in: REASONS_IN.map((v) => ({ value: v, label: REASON_LABELS_BG[v] })),
      out: REASONS_OUT.map((v) => ({ value: v, label: REASON_LABELS_BG[v] })),
    };
  });

  // POST /stock-movements — създай ново движение.
  // Атомично: 1) update inventory с +/- quantity, 2) запис в stock_movements
  // с snapshot преди/след. Out движение което би оставило inventory < 0 се
  // отказва (409) освен ако allow_negative=true (admin override).
  fastify.post(
    "/",
    { preHandler: stockMovementsManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = createMovementSchema.parse(request.body);
      const userId = (request.user as any)?.id ?? null;

      // Admin-only check за allow_negative override (като при fulfill).
      if (body.allow_negative === true && body.movement_type === "out") {
        const isAdmin = await hasPermission(
          request.user as { id: string; role: string },
          PERMISSIONS.BELOW_COST_OVERRIDE,
        );
        if (!isAdmin) {
          return reply.status(403).send({
            error: "Forbidden",
            message: "Само admin може да изписва над наличността (на минус).",
          });
        }
      }

      // Проверка че продуктът съществува (FK ще се намеси иначе с грозен err).
      const {
        rows: [product],
      } = await query(
        "SELECT id, name_bg, is_service FROM products WHERE id = $1",
        [body.product_id],
      );
      if (!product) {
        return reply.status(404).send({ error: "Product not found" });
      }
      if (product.is_service === true) {
        return reply.status(400).send({
          error: "Stock movements не са приложими за услуги",
          message:
            "Този продукт е маркиран като услуга (is_service=true). Услугите нямат stock.",
        });
      }

      try {
        const result = await transaction(async (client) => {
          // Общата налична количество за продукта в склад 1 — сума по ВСИЧКИ
          // inventory редове (партидни + евент. non-batch). Ползва се за
          // audit snapshot-а и за error съобщението. FOR UPDATE заключва
          // всички редове на продукта в склада (same as FEFO allocator lock).
          // Postgres не приема агрегат заедно с FOR UPDATE, затова е на
          // две стъпки: първо заключваме редовете, после ги сумираме.
          // Сумата е стабилна — редовете вече са заключени в тази
          // транзакция. Сумирането остава в SQL (numeric), за да няма
          // плаваща грешка в audit snapshot-а.
          await client.query(
            `SELECT id FROM inventory
              WHERE product_id = $1 AND warehouse_id = 1
              FOR UPDATE`,
            [body.product_id],
          );
          const { rows: invRows } = await client.query(
            `SELECT COALESCE(SUM(quantity), 0) AS total
               FROM inventory
              WHERE product_id = $1 AND warehouse_id = 1`,
            [body.product_id],
          );
          const currentQty = parseFloat(invRows[0]?.total ?? "0");

          if (body.movement_type === "in") {
            // 'in' движенията остават non-batch (unchanged path) — записват
            // се срещу partial-unique-index реда (product_id, warehouse_id)
            // WHERE batch_id IS NULL, same pattern както преди.
            const {
              rows: [nullRow],
            } = await client.query(
              `SELECT id, quantity FROM inventory
                WHERE product_id = $1 AND warehouse_id = 1 AND batch_id IS NULL
                FOR UPDATE`,
              [body.product_id],
            );
            const nullQty = nullRow ? parseFloat(nullRow.quantity) : 0;
            const newNullQty = nullQty + body.quantity;
            const newQty = currentQty + body.quantity;

            if (nullRow) {
              await client.query(
                `UPDATE inventory SET quantity = $1, updated_at = NOW() WHERE id = $2`,
                [newNullQty, nullRow.id],
              );
            } else {
              await client.query(
                `INSERT INTO inventory (product_id, warehouse_id, quantity, batch_id)
                 VALUES ($1, 1, $2, NULL)`,
                [body.product_id, newNullQty],
              );
            }

            const {
              rows: [movement],
            } = await client.query(
              `INSERT INTO stock_movements
                  (product_id, warehouse_id, movement_type, quantity,
                   quantity_before, quantity_after, reason, note, created_by)
               VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8)
               RETURNING *`,
              [
                body.product_id,
                body.movement_type,
                body.quantity,
                currentQty,
                newQty,
                body.reason,
                body.note ?? null,
                userId,
              ],
            );

            return movement;
          }

          // 'out' — FEFO/batch-aware изписване, огледало на orders.fulfill
          // (deductBatched в orders.ts): allocateFefo() избира партиди по
          // First-Expired-First-Out (пропуска изтеклите), после за всяка
          // allocation се намалява inventory реда И batches.quantity.
          let allocations: {
            batch_id: number;
            quantity: number;
          }[];
          try {
            const res = await allocateFefo(
              client,
              body.product_id,
              1,
              body.quantity,
              { allowShortfall: body.allow_negative },
            );
            allocations = res.allocations;

            // Shortfall (само възможно при allow_negative=true): остатъкът
            // отива в МИНУС срещу non-batch (batch_id IS NULL) реда — same
            // семантика като преди (admin override пише директно на минус).
            if (res.shortfall > 0) {
              const {
                rows: [nullRow],
              } = await client.query(
                `SELECT id, quantity FROM inventory
                  WHERE product_id = $1 AND warehouse_id = 1 AND batch_id IS NULL
                  FOR UPDATE`,
                [body.product_id],
              );
              const nullQty = nullRow ? parseFloat(nullRow.quantity) : 0;
              const newNullQty = nullQty - res.shortfall;
              if (nullRow) {
                await client.query(
                  `UPDATE inventory SET quantity = $1, updated_at = NOW() WHERE id = $2`,
                  [newNullQty, nullRow.id],
                );
              } else {
                await client.query(
                  `INSERT INTO inventory (product_id, warehouse_id, quantity, batch_id)
                   VALUES ($1, 1, $2, NULL)`,
                  [body.product_id, newNullQty],
                );
              }
            }
          } catch (err) {
            if (err instanceof InsufficientStockError) {
              throw Object.assign(
                new Error(
                  `Insufficient stock: have ${currentQty}, need ${body.quantity}`,
                ),
                { statusCode: 409 },
              );
            }
            throw err;
          }

          // Приложи всяка allocation — same pattern като deductBatched() в
          // orders.ts (намаля inventory реда за партидата + batches.quantity).
          for (const allocation of allocations) {
            const updated = await client.query(
              `UPDATE inventory
                  SET quantity = quantity - $1, updated_at = NOW()
                WHERE product_id = $2 AND warehouse_id = 1 AND batch_id = $3`,
              [allocation.quantity, body.product_id, allocation.batch_id],
            );
            if (!updated.rowCount) {
              await client.query(
                `INSERT INTO inventory (product_id, batch_id, warehouse_id, quantity, updated_at)
                 VALUES ($1, $2, 1, $3, NOW())`,
                [body.product_id, allocation.batch_id, -allocation.quantity],
              );
            }
            await client.query(
              `UPDATE batches SET quantity = quantity - $1, updated_at = NOW() WHERE id = $2`,
              [allocation.quantity, allocation.batch_id],
            );
          }

          const newQty = currentQty - body.quantity;

          const {
            rows: [movement],
          } = await client.query(
            `INSERT INTO stock_movements
                (product_id, warehouse_id, movement_type, quantity,
                 quantity_before, quantity_after, reason, note, created_by)
             VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [
              body.product_id,
              body.movement_type,
              body.quantity,
              currentQty,
              newQty,
              body.reason,
              body.note ?? null,
              userId,
            ],
          );

          return movement;
        });

        return reply.status(201).send(result);
      } catch (err: any) {
        if (err?.statusCode) {
          return reply
            .status(err.statusCode)
            .send({ error: err.message ?? "Stock movement failed" });
        }
        throw err;
      }
    },
  );

  // GET /stock-movements — история с филтри по type, product_id, user_id,
  // date range. ORDER BY created_at DESC.
  fastify.get(
    "/",
    { preHandler: stockMovementsManagePreHandler },
    async (request: FastifyRequest) => {
      const q = listQuerySchema.parse(request.query);

      let where = "WHERE 1=1";
      const params: any[] = [];
      let idx = 1;

      if (q.movement_type) {
        where += ` AND sm.movement_type = $${idx++}`;
        params.push(q.movement_type);
      }
      if (q.product_id) {
        where += ` AND sm.product_id = $${idx++}`;
        params.push(q.product_id);
      }
      if (q.user_id) {
        where += ` AND sm.created_by = $${idx++}`;
        params.push(q.user_id);
      }
      if (q.date_from) {
        where += ` AND DATE(sm.created_at) >= $${idx++}`;
        params.push(q.date_from);
      }
      if (q.date_to) {
        where += ` AND DATE(sm.created_at) <= $${idx++}`;
        params.push(q.date_to);
      }
      params.push(q.limit);

      const { rows } = await query(
        `SELECT sm.id, sm.product_id, sm.movement_type,
                sm.quantity::numeric AS quantity,
                sm.quantity_before::numeric AS quantity_before,
                sm.quantity_after::numeric AS quantity_after,
                sm.reason, sm.note, sm.created_at,
                sm.created_by,
                p.name_bg AS product_name, p.sku AS product_sku, p.unit AS product_unit,
                u.name AS created_by_name, u.email AS created_by_email
           FROM stock_movements sm
           LEFT JOIN products p ON p.id = sm.product_id
           LEFT JOIN users u ON u.id = sm.created_by
          ${where}
          ORDER BY sm.created_at DESC
          LIMIT $${idx}`,
        params,
      );

      // Inject reason labels (server-side enrichment за UI consistency).
      const enriched = rows.map((r: any) => ({
        ...r,
        quantity: parseFloat(r.quantity),
        quantity_before: parseFloat(r.quantity_before),
        quantity_after: parseFloat(r.quantity_after),
        reason_label: REASON_LABELS_BG[r.reason] ?? r.reason,
      }));

      return { data: enriched, count: enriched.length };
    },
  );
}
