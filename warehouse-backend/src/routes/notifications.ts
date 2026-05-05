import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { query } from "../db.js";

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

export default async function notificationRoutes(app: FastifyInstance) {
  // GET /notifications — unified feed: computed alerts + persistent rows,
  // each item carries per-user is_read / read_at via notification_reads.
  app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    const user = (request as any).user;
    const userId = user.sub || user.id;

    const notifications: any[] = [];

    // ─── Computed: Low stock alerts ───
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
        message: `${r.name_bg} — само ${parseFloat(r.qty)} бр`,
        severity: "warning",
        payload: { product_id: r.id, sku: r.sku },
        created_at: new Date().toISOString(),
      });
    }

    // ─── Computed: Expiring batches (legacy — MERT-M has no batches but keep) ───
    const { rows: expiring } = await query(`
      SELECT b.id, b.expiry_date, p.name_bg, (b.expiry_date - CURRENT_DATE) AS days_left
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
        message: `${r.name_bg} — изтича след ${r.days_left} дни`,
        severity: r.days_left <= 7 ? "critical" : "warning",
        payload: { batch_id: r.id },
        created_at: new Date().toISOString(),
      });
    }

    // ─── Persistent: rows from the notifications table ───
    // Last 50 — newest first.
    const { rows: persistent } = await query(`
      SELECT id, type, message, payload, created_at
        FROM notifications
       ORDER BY created_at DESC
       LIMIT 50
    `);
    for (const r of persistent) {
      notifications.push({
        id: `db-${r.id}`,
        type: r.type,
        message: r.message,
        severity: "info",
        payload: r.payload,
        created_at:
          r.created_at instanceof Date
            ? r.created_at.toISOString()
            : r.created_at,
      });
    }

    // ─── Per-user read/dismissed status ───
    const { rows: reads } = await query(
      `SELECT notification_id, dismissed, read_at
         FROM notification_reads WHERE user_id = $1`,
      [userId],
    );
    const readMap = new Map(reads.map((r: any) => [r.notification_id, r]));

    const result = notifications
      .filter((n) => !readMap.get(n.id)?.dismissed)
      .map((n) => {
        const entry = readMap.get(n.id);
        return {
          ...n,
          is_read: !!entry?.read_at,
          read_at: entry?.read_at ?? null,
        };
      })
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

    return { data: result, count: result.length };
  });

  // GET /notifications/unread-count — fast path for the bell badge
  app.get("/unread-count", async (request, reply) => {
    await requireAuth(request as FastifyRequest, reply as FastifyReply);
    const user = (request as any).user;
    const userId = user.sub || user.id;

    const { rows: lowStock } = await query(`
      SELECT p.id FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id
       GROUP BY p.id, p.low_stock_threshold
      HAVING COALESCE(SUM(i.quantity),0) <= p.low_stock_threshold
       LIMIT 100
    `);
    const { rows: expiring } = await query(`
      SELECT b.id FROM batches b
       JOIN inventory i ON i.batch_id = b.id
      WHERE b.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
        AND i.quantity > 0
       LIMIT 100
    `);
    const { rows: persistent } = await query(`
      SELECT id FROM notifications ORDER BY created_at DESC LIMIT 50
    `);

    const allIds = [
      ...lowStock.map((r: any) => `low-${r.id}`),
      ...expiring.map((r: any) => `exp-${r.id}`),
      ...persistent.map((r: any) => `db-${r.id}`),
    ];

    if (allIds.length === 0) return { count: 0 };

    const { rows: reads } = await query(
      `SELECT notification_id, dismissed, read_at
         FROM notification_reads
        WHERE user_id = $1 AND notification_id = ANY($2::text[])`,
      [userId, allIds],
    );
    const readMap = new Map(reads.map((r: any) => [r.notification_id, r]));

    let count = 0;
    for (const id of allIds) {
      const entry = readMap.get(id);
      if (!entry?.dismissed && !entry?.read_at) count++;
    }
    return { count };
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
