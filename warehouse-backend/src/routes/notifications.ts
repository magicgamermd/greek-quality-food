import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { query } from "../db.js";

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

export default async function notificationRoutes(app: FastifyInstance) {
  // GET /notifications — aggregated alerts with read status
  app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    const user = (request as any).user;

    const notifications: any[] = [];

    // Low stock alerts
    const { rows: lowStock } = await query(`
      SELECT p.id, p.name_bg, p.sku, COALESCE(SUM(i.quantity),0)::numeric AS qty, p.low_stock_threshold
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      WHERE EXISTS (SELECT 1 FROM batches pb WHERE pb.product_id = p.id)
         OR EXISTS (SELECT 1 FROM inventory i2 WHERE i2.product_id = p.id AND i2.quantity <> 0)
      GROUP BY p.id, p.name_bg, p.sku, p.low_stock_threshold
      HAVING COALESCE(SUM(i.quantity),0) <= p.low_stock_threshold
      ORDER BY qty ASC LIMIT 20
    `);
    for (const r of lowStock) {
      notifications.push({
        id: `low-${r.id}`,
        type: "low_stock",
        title: "Ниска наличност",
        message: `${r.name_bg} — само ${parseFloat(r.qty)} бр`,
        severity: "warning",
        created_at: new Date().toISOString(),
      });
    }

    // Expiring soon (30 days)
    const { rows: expiring } = await query(`
      SELECT b.id, b.batch_number, b.expiry_date, p.name_bg,
             (b.expiry_date - CURRENT_DATE) AS days_left
      FROM batches b
      JOIN products p ON p.id = b.product_id
      JOIN inventory i ON i.batch_id = b.id
      WHERE b.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
        AND i.quantity > 0
      ORDER BY b.expiry_date ASC LIMIT 10
    `);
    for (const r of expiring) {
      notifications.push({
        id: `exp-${r.id}`,
        type: "expiring",
        title: "Изтичащ срок",
        message: `${r.name_bg} — изтича след ${r.days_left} дни`,
        severity: r.days_left <= 7 ? "critical" : "warning",
        created_at: new Date().toISOString(),
      });
    }

    // Get read/dismissed status for this user
    const { rows: reads } = await query(
      `SELECT notification_id, dismissed FROM notification_reads WHERE user_id = $1`,
      [user.sub || user.id],
    );
    const readMap = new Map(reads.map((r: any) => [r.notification_id, r]));

    // Filter out dismissed and mark read
    const result = notifications
      .filter((n) => {
        const entry = readMap.get(n.id);
        return !entry?.dismissed;
      })
      .map((n) => ({
        ...n,
        read: !!readMap.get(n.id),
      }));

    return { data: result, count: result.length };
  });

  // PUT /notifications/:id/read — mark one as read
  app.put("/:id/read", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    const user = (request as any).user;
    const { id } = request.params as any;

    await query(
      `INSERT INTO notification_reads (user_id, notification_id) VALUES ($1, $2) ON CONFLICT (user_id, notification_id) DO UPDATE SET read_at = NOW()`,
      [user.sub || user.id, id],
    );

    return { ok: true };
  });

  // POST /notifications/read-all — mark all as read
  app.post(
    "/read-all",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      const user = (request as any).user;
      const { ids } = (request.body as any) || {};

      if (ids && Array.isArray(ids)) {
        for (const nid of ids) {
          await query(
            `INSERT INTO notification_reads (user_id, notification_id) VALUES ($1, $2) ON CONFLICT (user_id, notification_id) DO UPDATE SET read_at = NOW()`,
            [user.sub || user.id, nid],
          );
        }
      }

      return { ok: true };
    },
  );

  // DELETE /notifications/:id — dismiss notification
  app.delete("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    const user = (request as any).user;
    const { id } = request.params as any;

    await query(
      `INSERT INTO notification_reads (user_id, notification_id, dismissed) VALUES ($1, $2, true) ON CONFLICT (user_id, notification_id) DO UPDATE SET dismissed = true`,
      [user.sub || user.id, id],
    );

    return { ok: true };
  });
}
