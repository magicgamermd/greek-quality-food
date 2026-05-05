import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query, transaction } from "../db.js";
import { requirePermission, PERMISSIONS } from "../lib/permissions.js";
import { generatePurchaseOrderPdf } from "../services/purchase-order-pdf.js";

function computePeriodCutoff(
  period: "today" | "this-week" | "this-month",
): Date {
  const now = new Date();
  if (period === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (period === "this-week") {
    const d = new Date(now);
    const dayOfWeek = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - dayOfWeek);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  // this-month
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

// Display number — id zero-padded with "ZA-" prefix. Computed at read
// time so we don't carry a redundant column.
function formatNumber(id: number): string {
  return `ZA-${String(id).padStart(5, "0")}`;
}

const itemSchema = z.object({
  product_id: z.number().int().positive(),
  quantity: z.number().positive(),
  notes: z.string().nullish(),
});

const createSchema = z.object({
  supplier_id: z.number().int().positive(),
  notes: z.string().nullish(),
  expected_delivery_date: z.string().nullish(),
  items: z.array(itemSchema).min(1),
});

const updateSchema = z.object({
  supplier_id: z.number().int().positive().optional(),
  notes: z.string().nullish().optional(),
  expected_delivery_date: z.string().nullish().optional(),
  items: z.array(itemSchema).optional(),
});

const mergeSchema = z.object({
  ids: z.array(z.number().int().positive()).min(2),
});

const jwtVerify = async (request: FastifyRequest) => {
  await request.jwtVerify();
};

const guard = [
  jwtVerify,
  requirePermission(PERMISSIONS.PURCHASE_ORDERS_MANAGE),
];

async function loadOrderWithItems(id: number) {
  const { rows: orderRows } = await query(
    `SELECT po.*, s.name AS supplier_name, s.eik AS supplier_eik,
            s.contact_person AS supplier_contact, s.email AS supplier_email,
            s.phone AS supplier_phone, s.address AS supplier_address,
            u.name AS created_by_name
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN users u ON u.id = po.created_by
     WHERE po.id = $1`,
    [id],
  );
  if (orderRows.length === 0) return null;
  const order = orderRows[0];

  const { rows: items } = await query(
    `SELECT poi.id, poi.product_id, poi.quantity, poi.notes,
            COALESCE(p.name_bg, p.name_en) AS product_name,
            p.sku AS product_code,
            p.unit AS product_unit,
            COALESCE(
              (SELECT SUM(quantity) FROM inventory WHERE product_id = p.id),
              0
            )::numeric AS total_stock
     FROM purchase_order_items poi
     JOIN products p ON p.id = poi.product_id
     WHERE poi.purchase_order_id = $1
     ORDER BY poi.id`,
    [id],
  );

  return {
    ...order,
    order_number: formatNumber(order.id),
    items,
  };
}

export default async function purchaseOrderRoutes(app: FastifyInstance) {
  // GET / — list with optional status / supplier / period / search filters.
  app.get(
    "/",
    { preHandler: guard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { status, supplier_id, period, search } = request.query as {
        status?: string;
        supplier_id?: string;
        period?: "today" | "this-week" | "this-month" | "all";
        search?: string;
      };
      const where: string[] = [];
      const params: unknown[] = [];
      if (status) {
        params.push(status);
        where.push(`po.status = $${params.length}`);
      }
      if (supplier_id) {
        params.push(Number(supplier_id));
        where.push(`po.supplier_id = $${params.length}`);
      }
      if (period && period !== "all") {
        const cutoff = computePeriodCutoff(period);
        params.push(cutoff);
        where.push(`po.created_at >= $${params.length}`);
      }
      if (search && search.trim().length > 0) {
        const term = `%${search.trim()}%`;
        params.push(term);
        const idx = params.length;
        where.push(
          `(s.name ILIKE $${idx} OR EXISTS (
              SELECT 1 FROM purchase_order_items poi
              JOIN products p ON p.id = poi.product_id
              WHERE poi.purchase_order_id = po.id
                AND (p.name_bg ILIKE $${idx} OR p.name_en ILIKE $${idx} OR p.sku ILIKE $${idx})
           ))`,
        );
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const { rows } = await query(
        `SELECT po.id, po.supplier_id, po.status, po.notes,
                po.expected_delivery_date, po.sent_at, po.received_at,
                po.incoming_goods_id, po.created_at, po.updated_at,
                s.name AS supplier_name,
                (SELECT COUNT(*) FROM purchase_order_items
                  WHERE purchase_order_id = po.id) AS item_count,
                (SELECT SUM(quantity) FROM purchase_order_items
                  WHERE purchase_order_id = po.id) AS total_quantity
         FROM purchase_orders po
         JOIN suppliers s ON s.id = po.supplier_id
         ${whereSql}
         ORDER BY po.created_at DESC
         LIMIT 500`,
        params,
      );
      return reply.send({
        data: rows.map((r) => ({ ...r, order_number: formatNumber(r.id) })),
      });
    },
  );

  app.get(
    "/:id",
    { preHandler: guard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = Number((request.params as { id: string }).id);
      const order = await loadOrderWithItems(id);
      if (!order) return reply.status(404).send({ error: "Not found" });
      return reply.send(order);
    },
  );

  // POST / — create draft
  app.post(
    "/",
    { preHandler: guard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const body = parsed.data;
      const userId = (request as any).user?.id ?? null;

      const order = await transaction(async (client) => {
        const {
          rows: [created],
        } = await client.query(
          `INSERT INTO purchase_orders
              (supplier_id, notes, expected_delivery_date, created_by)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [
            body.supplier_id,
            body.notes ?? null,
            body.expected_delivery_date ?? null,
            userId,
          ],
        );
        for (const item of body.items) {
          await client.query(
            `INSERT INTO purchase_order_items
                (purchase_order_id, product_id, quantity, notes)
             VALUES ($1, $2, $3, $4)`,
            [created.id, item.product_id, item.quantity, item.notes ?? null],
          );
        }
        return created;
      });

      const full = await loadOrderWithItems(order.id);
      return reply.status(201).send(full);
    },
  );

  // PATCH /:id — drafts only. Items are replaced wholesale when present;
  // partial line edits aren't worth the API complexity for this tool.
  app.patch(
    "/:id",
    { preHandler: guard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = Number((request.params as { id: string }).id);
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const body = parsed.data;

      try {
        await transaction(async (client) => {
          const {
            rows: [existing],
          } = await client.query(
            "SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE",
            [id],
          );
          if (!existing) {
            throw Object.assign(new Error("Not found"), { statusCode: 404 });
          }
          if (existing.status !== "draft") {
            throw Object.assign(
              new Error(
                "Само заявки в статус 'Чернова' могат да се редактират",
              ),
              { statusCode: 400 },
            );
          }

          const updates: string[] = [];
          const params: unknown[] = [];
          for (const [key, val] of Object.entries(body)) {
            if (key === "items") continue;
            if (val === undefined) continue;
            params.push(val);
            updates.push(`${key} = $${params.length}`);
          }
          if (updates.length > 0) {
            params.push(id);
            await client.query(
              `UPDATE purchase_orders SET ${updates.join(", ")}, updated_at = NOW()
               WHERE id = $${params.length}`,
              params,
            );
          }

          if (body.items) {
            await client.query(
              "DELETE FROM purchase_order_items WHERE purchase_order_id = $1",
              [id],
            );
            for (const item of body.items) {
              await client.query(
                `INSERT INTO purchase_order_items
                    (purchase_order_id, product_id, quantity, notes)
                 VALUES ($1, $2, $3, $4)`,
                [id, item.product_id, item.quantity, item.notes ?? null],
              );
            }
          }
        });
      } catch (err: any) {
        return reply
          .status(err.statusCode ?? 500)
          .send({ error: err.message ?? "Server error" });
      }

      const full = await loadOrderWithItems(id);
      return reply.send(full);
    },
  );

  app.delete(
    "/:id",
    { preHandler: guard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = Number((request.params as { id: string }).id);
      const { rows } = await query(
        "SELECT status FROM purchase_orders WHERE id = $1",
        [id],
      );
      if (rows.length === 0)
        return reply.status(404).send({ error: "Not found" });
      if (rows[0].status !== "draft") {
        return reply
          .status(400)
          .send({ error: "Само чернови могат да бъдат изтрити" });
      }
      await query("DELETE FROM purchase_orders WHERE id = $1", [id]);
      return reply.status(204).send();
    },
  );

  // POST /:id/send — draft → sent
  app.post(
    "/:id/send",
    { preHandler: guard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = Number((request.params as { id: string }).id);
      const { rows } = await query(
        `UPDATE purchase_orders SET status = 'sent', sent_at = NOW(),
          updated_at = NOW()
         WHERE id = $1 AND status = 'draft' RETURNING id`,
        [id],
      );
      if (rows.length === 0) {
        return reply
          .status(400)
          .send({ error: "Заявката трябва да е в статус 'Чернова'" });
      }
      const full = await loadOrderWithItems(id);
      return reply.send(full);
    },
  );

  // POST /:id/reopen — sent → draft (mistake unwind)
  app.post(
    "/:id/reopen",
    { preHandler: guard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = Number((request.params as { id: string }).id);
      const { rows } = await query(
        `UPDATE purchase_orders SET status = 'draft', sent_at = NULL,
            updated_at = NOW()
         WHERE id = $1 AND status = 'sent' RETURNING id`,
        [id],
      );
      if (rows.length === 0) {
        return reply.status(400).send({
          error: "Само 'Изпратена' заявка може да се върне в чернова",
        });
      }
      const full = await loadOrderWithItems(id);
      return reply.send(full);
    },
  );

  // POST /merge — combine 2+ draft purchase orders for the same supplier
  // into one. Workflow: owner files several small drafts during the day
  // ("X is out of stock", "also Y", "also Z"), then merges them at the
  // end into a single PDF to send the supplier. Duplicate products sum
  // their quantities. Notes are concatenated. The oldest order keeps its
  // id (so any links / printed previews still resolve); the rest are
  // deleted.
  app.post(
    "/merge",
    { preHandler: guard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = mergeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const { ids } = parsed.data;

      try {
        const masterId = await transaction(async (client) => {
          const { rows: orders } = await client.query(
            `SELECT id, supplier_id, status, notes, expected_delivery_date,
                    created_at
             FROM purchase_orders WHERE id = ANY($1) FOR UPDATE`,
            [ids],
          );
          if (orders.length !== ids.length) {
            throw Object.assign(
              new Error("Една или повече заявки не са намерени"),
              { statusCode: 404 },
            );
          }
          const nonDraft = orders.find((o: any) => o.status !== "draft");
          if (nonDraft) {
            throw Object.assign(
              new Error("Само заявки в статус 'Чернова' могат да се обединят"),
              { statusCode: 400 },
            );
          }
          const supplierIds = new Set(orders.map((o: any) => o.supplier_id));
          if (supplierIds.size > 1) {
            throw Object.assign(
              new Error("Заявките трябва да са от един и същ доставчик"),
              { statusCode: 400 },
            );
          }

          // Pick the oldest as master; rest get folded into it.
          orders.sort(
            (a: any, b: any) =>
              new Date(a.created_at).getTime() -
              new Date(b.created_at).getTime(),
          );
          const master = orders[0];
          const sourceIds = orders.slice(1).map((o: any) => o.id);

          // Pull all items from source orders.
          const { rows: srcItems } = await client.query(
            `SELECT product_id, quantity, notes
             FROM purchase_order_items
             WHERE purchase_order_id = ANY($1)`,
            [sourceIds],
          );
          // Pull master items so we can sum dupes.
          const { rows: masterItems } = await client.query(
            `SELECT id, product_id, quantity
             FROM purchase_order_items WHERE purchase_order_id = $1`,
            [master.id],
          );
          const byProduct = new Map<
            number,
            { id?: number; quantity: number; notes?: string | null }
          >();
          for (const it of masterItems) {
            byProduct.set(it.product_id, {
              id: it.id,
              quantity: Number(it.quantity),
            });
          }
          for (const it of srcItems) {
            const existing = byProduct.get(it.product_id);
            if (existing) {
              existing.quantity += Number(it.quantity);
            } else {
              byProduct.set(it.product_id, {
                quantity: Number(it.quantity),
                notes: it.notes ?? null,
              });
            }
          }

          // Apply: UPDATE existing master rows, INSERT new ones.
          for (const [productId, data] of byProduct.entries()) {
            if (data.id) {
              await client.query(
                "UPDATE purchase_order_items SET quantity = $1 WHERE id = $2",
                [data.quantity, data.id],
              );
            } else {
              await client.query(
                `INSERT INTO purchase_order_items
                    (purchase_order_id, product_id, quantity, notes)
                 VALUES ($1, $2, $3, $4)`,
                [master.id, productId, data.quantity, data.notes ?? null],
              );
            }
          }

          // Concat notes from all source orders.
          const notesParts = orders
            .map((o: any) =>
              o.notes ? `[ZA-${String(o.id).padStart(5, "0")}] ${o.notes}` : "",
            )
            .filter(Boolean);
          const mergedNotes = notesParts.join("\n");

          // Earliest expected_delivery_date wins (most urgent).
          const expectedDates = orders
            .map((o: any) => o.expected_delivery_date)
            .filter(Boolean)
            .sort();
          const expected = expectedDates[0] ?? null;

          await client.query(
            `UPDATE purchase_orders
             SET notes = $1, expected_delivery_date = $2, updated_at = NOW()
             WHERE id = $3`,
            [mergedNotes || null, expected, master.id],
          );

          // Delete source orders (CASCADE drops their items).
          await client.query("DELETE FROM purchase_orders WHERE id = ANY($1)", [
            sourceIds,
          ]);

          return master.id;
        });

        const full = await loadOrderWithItems(masterId);
        return reply.send(full);
      } catch (err: any) {
        return reply
          .status(err.statusCode ?? 500)
          .send({ error: err.message ?? "Server error" });
      }
    },
  );

  // POST /:id/convert-to-incoming — sent → received + create incoming_goods
  // record so the warehouse-receipt pipeline takes over. Supplier and items
  // are copied 1:1; unit_price defaults to 0 (the receipt UI lets staff
  // fill in the real cost when goods arrive).
  app.post(
    "/:id/convert-to-incoming",
    { preHandler: guard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = Number((request.params as { id: string }).id);

      try {
        const result = await transaction(async (client) => {
          const {
            rows: [order],
          } = await client.query(
            "SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE",
            [id],
          );
          if (!order) {
            throw Object.assign(new Error("Not found"), { statusCode: 404 });
          }
          if (order.status === "received") {
            throw Object.assign(new Error("Заявката вече е получена"), {
              statusCode: 400,
            });
          }
          if (order.status === "draft") {
            throw Object.assign(
              new Error(
                "Заявката трябва първо да бъде маркирана като 'Изпратена'",
              ),
              { statusCode: 400 },
            );
          }

          const { rows: items } = await client.query(
            `SELECT product_id, quantity FROM purchase_order_items
             WHERE purchase_order_id = $1`,
            [id],
          );

          const {
            rows: [incoming],
          } = await client.query(
            `INSERT INTO incoming_goods
                (supplier_id, document_type, status, total_amount)
             VALUES ($1, 'invoice', 'pending', 0)
             RETURNING *`,
            [order.supplier_id],
          );

          for (const item of items) {
            await client.query(
              `INSERT INTO incoming_items
                  (incoming_goods_id, product_id, quantity, unit_price, total_price)
               VALUES ($1, $2, $3, 0, 0)`,
              [incoming.id, item.product_id, item.quantity],
            );
          }

          await client.query(
            `UPDATE purchase_orders SET status = 'received', received_at = NOW(),
                incoming_goods_id = $1, updated_at = NOW()
             WHERE id = $2`,
            [incoming.id, id],
          );

          return { incomingId: incoming.id };
        });

        const full = await loadOrderWithItems(id);
        return reply.send({ ...full, incoming_goods_id: result.incomingId });
      } catch (err: any) {
        return reply
          .status(err.statusCode ?? 500)
          .send({ error: err.message ?? "Server error" });
      }
    },
  );

  // GET /:id/pdf — bilingual (BG + EN) PDF for sending to suppliers
  app.get(
    "/:id/pdf",
    { preHandler: guard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const id = Number((request.params as { id: string }).id);
      const order = await loadOrderWithItems(id);
      if (!order) return reply.status(404).send({ error: "Not found" });

      const buffer = await generatePurchaseOrderPdf(order);
      return reply
        .header("Content-Type", "application/pdf")
        .header(
          "Content-Disposition",
          `inline; filename="${order.order_number}.pdf"`,
        )
        .send(buffer);
    },
  );
}
