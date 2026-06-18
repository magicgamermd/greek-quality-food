import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query, transaction } from "../db.js";
import {
  PERMISSIONS,
  requirePermission,
  hasPermission,
} from "../lib/permissions.js";

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
          // Lock inventory ред + read current quantity. Ползваме partial unique
          // index (product_id, warehouse_id) WHERE batch_id IS NULL — same
          // pattern както в orders.fulfill и incoming.confirm.
          const {
            rows: [invRow],
          } = await client.query(
            `SELECT id, quantity FROM inventory
              WHERE product_id = $1 AND warehouse_id = 1 AND batch_id IS NULL
              FOR UPDATE`,
            [body.product_id],
          );
          const currentQty = invRow ? parseFloat(invRow.quantity) : 0;
          const delta =
            body.movement_type === "in" ? body.quantity : -body.quantity;
          const newQty = currentQty + delta;

          // Guard срещу negative inventory за 'out' движения
          if (
            body.movement_type === "out" &&
            newQty < -0.001 &&
            !body.allow_negative
          ) {
            throw Object.assign(
              new Error(
                `Insufficient stock: have ${currentQty}, need ${body.quantity}`,
              ),
              { statusCode: 409 },
            );
          }

          if (invRow) {
            await client.query(
              `UPDATE inventory SET quantity = $1, updated_at = NOW() WHERE id = $2`,
              [newQty, invRow.id],
            );
          } else {
            // Няма inventory ред още — създаваме. За 'out' само ако allow_negative.
            await client.query(
              `INSERT INTO inventory (product_id, warehouse_id, quantity, batch_id)
               VALUES ($1, 1, $2, NULL)`,
              [body.product_id, newQty],
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
