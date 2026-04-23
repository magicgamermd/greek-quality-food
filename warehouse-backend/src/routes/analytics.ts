import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { query } from "../db.js";

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

export default async function analyticsRoutes(app: FastifyInstance) {
  // GET /analytics/sales — sales by period, product, partner
  app.get("/sales", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);

    const { from, to, group_by, partner_id, product_id } = request.query as any;
    const dateFrom =
      from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const dateTo = to || new Date().toISOString().slice(0, 10);

    let groupByClause: string;
    let selectExtra: string;

    switch (group_by) {
      case "product":
        groupByClause = "p.id, p.name_en, p.name_bg, p.sku";
        selectExtra = "p.name_en AS group_name, p.sku,";
        break;
      case "partner":
        groupByClause = "pa.id, pa.name";
        selectExtra = "pa.name AS group_name,";
        break;
      case "month":
        groupByClause = "DATE_TRUNC('month', o.order_date)";
        selectExtra = "DATE_TRUNC('month', o.order_date)::date AS group_name,";
        break;
      case "week":
        groupByClause = "DATE_TRUNC('week', o.order_date)";
        selectExtra = "DATE_TRUNC('week', o.order_date)::date AS group_name,";
        break;
      default: // day
        groupByClause = "o.order_date::date";
        selectExtra = "o.order_date::date AS group_name,";
        break;
    }

    let where =
      "WHERE o.status != 'cancelled' AND o.order_date >= $1 AND o.order_date <= $2";
    const params: any[] = [dateFrom, dateTo + "T23:59:59"];
    let paramIdx = 3;

    if (partner_id) {
      where += ` AND o.partner_id = $${paramIdx++}`;
      params.push(parseInt(partner_id));
    }
    if (product_id) {
      where += ` AND oi.product_id = $${paramIdx++}`;
      params.push(parseInt(product_id));
    }

    const sql = `
      SELECT ${selectExtra}
             COUNT(DISTINCT o.id)::int AS order_count,
             SUM(oi.quantity)::numeric AS total_quantity,
             SUM(oi.total_price)::numeric AS total_revenue
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN products p ON p.id = oi.product_id
      JOIN partners pa ON pa.id = o.partner_id
      ${where}
      GROUP BY ${groupByClause}
      ORDER BY total_revenue DESC
    `;

    const { rows } = await query(sql, params);

    // Summary
    const totalRevenue = rows.reduce(
      (sum, r) => sum + parseFloat(r.total_revenue || "0"),
      0,
    );
    const totalOrders = rows.reduce((sum, r) => sum + (r.order_count || 0), 0);

    return {
      data: rows,
      summary: {
        total_revenue: totalRevenue,
        total_orders: totalOrders,
        period: { from: dateFrom, to: dateTo },
      },
    };
  });

  // GET /analytics/top-products
  app.get(
    "/top-products",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);

      const { from, to, limit: queryLimit } = request.query as any;
      const dateFrom =
        from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const dateTo = to || new Date().toISOString().slice(0, 10);
      const topN = Math.min(50, Math.max(1, parseInt(queryLimit) || 10));

      const { rows } = await query(
        `SELECT p.id, p.name_bg, p.name_en, p.sku, p.unit,
              SUM(oi.quantity)::numeric AS total_sold,
              SUM(oi.total_price)::numeric AS total_revenue,
              COUNT(DISTINCT o.id)::int AS order_count
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status != 'cancelled'
         AND o.order_date >= $1 AND o.order_date <= $2
       GROUP BY p.id
       ORDER BY total_revenue DESC
       LIMIT $3`,
        [dateFrom, dateTo + "T23:59:59", topN],
      );

      return { data: rows, period: { from: dateFrom, to: dateTo } };
    },
  );

  // GET /analytics/stock-forecast — simple depletion estimate
  app.get(
    "/stock-forecast",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);

      const { rows } = await query(`
      WITH daily_usage AS (
        SELECT oi.product_id,
               SUM(oi.quantity) / GREATEST(
                 EXTRACT(DAY FROM NOW() - MIN(o.order_date)),
                 1
               ) AS avg_daily_usage
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.status != 'cancelled'
          AND o.order_date >= NOW() - INTERVAL '90 days'
        GROUP BY oi.product_id
      ),
      current_stock AS (
        SELECT product_id, SUM(quantity) AS stock
        FROM inventory
        GROUP BY product_id
      )
      SELECT p.id, p.name_bg, p.name_en, p.sku, p.unit,
             COALESCE(cs.stock, 0)::numeric AS current_stock,
             COALESCE(du.avg_daily_usage, 0)::numeric AS avg_daily_usage,
             CASE
               WHEN COALESCE(du.avg_daily_usage, 0) > 0
               THEN ROUND(COALESCE(cs.stock, 0) / du.avg_daily_usage)
               ELSE NULL
             END AS days_until_depletion,
             CASE
               WHEN COALESCE(du.avg_daily_usage, 0) > 0
               THEN CURRENT_DATE + (COALESCE(cs.stock, 0) / du.avg_daily_usage)::int
               ELSE NULL
             END AS estimated_depletion_date
      FROM products p
      LEFT JOIN current_stock cs ON cs.product_id = p.id
      LEFT JOIN daily_usage du ON du.product_id = p.id
      WHERE COALESCE(cs.stock, 0) > 0
      ORDER BY days_until_depletion ASC NULLS LAST
    `);

      return { data: rows };
    },
  );

  // GET /analytics/anomalies — basic anomaly flags
  app.get(
    "/anomalies",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);

      const anomalies: any[] = [];

      // 1. Products with negative stock (should never happen)
      const { rows: negativeStock } = await query(`
      SELECT p.id, p.name_en, p.sku, SUM(inv.quantity)::numeric AS stock
      FROM inventory inv
      JOIN products p ON p.id = inv.product_id
      GROUP BY p.id
      HAVING SUM(inv.quantity) < 0
    `);
      for (const item of negativeStock) {
        anomalies.push({
          type: "negative_stock",
          severity: "warning",
          ...item,
        });
      }

      // 2. Orders with unusually large quantities (>3x average for that product)
      const { rows: largeOrders } = await query(`
      WITH avg_qty AS (
        SELECT product_id, AVG(quantity) AS avg_q, STDDEV(quantity) AS std_q
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.order_date >= NOW() - INTERVAL '90 days'
        GROUP BY product_id
        HAVING COUNT(*) >= 5
      )
      SELECT oi.id AS order_item_id, o.id AS order_id, p.name_en, p.sku,
             oi.quantity, aq.avg_q AS average_quantity
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN products p ON p.id = oi.product_id
      JOIN avg_qty aq ON aq.product_id = oi.product_id
      WHERE oi.quantity > aq.avg_q + 3 * COALESCE(aq.std_q, aq.avg_q)
        AND o.order_date >= NOW() - INTERVAL '7 days'
    `);
      for (const item of largeOrders) {
        anomalies.push({
          type: "unusual_order_quantity",
          severity: "warning",
          ...item,
        });
      }

      // 3. Expired batches still in stock
      const { rows: expiredInStock } = await query(`
      SELECT b.id AS batch_id, b.batch_number, b.expiry_date,
             p.name_en, p.sku,
             COALESCE(inv.quantity, 0)::numeric AS quantity
      FROM batches b
      JOIN products p ON p.id = b.product_id
      LEFT JOIN inventory inv ON inv.batch_id = b.id
      WHERE b.expiry_date < CURRENT_DATE
        AND COALESCE(inv.quantity, 0) > 0
    `);
      for (const item of expiredInStock) {
        anomalies.push({
          type: "expired_in_stock",
          severity: "critical",
          ...item,
        });
      }

      return { data: anomalies, count: anomalies.length };
    },
  );

  // GET /analytics/dashboard — mobile app KPI summary
  app.get(
    "/dashboard",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);

      const today = new Date().toISOString().split("T")[0];

      const [
        orders,
        revenue,
        profit,
        stockValue,
        lowStock,
        pendingPayments,
        expiring,
      ] = await Promise.all([
        query(
          `SELECT COUNT(*) AS cnt FROM orders WHERE DATE(order_date) = $1`,
          [today],
        ),
        query(
          `SELECT COALESCE(SUM(total_amount),0) AS total FROM orders
           WHERE DATE(order_date) = $1 AND status NOT IN ('cancelled','pending')`,
          [today],
        ),
        // Today's profit = revenue - COGS (from cost_unit_price in order_items)
        query(
          `SELECT
             COALESCE(SUM(oi.total_price),0) AS revenue,
             COALESCE(SUM(oi.cost_unit_price * oi.quantity),0) AS cogs
           FROM orders o
           JOIN order_items oi ON oi.order_id = o.id
           WHERE DATE(o.order_date) = $1
             AND o.status NOT IN ('cancelled','pending')`,
          [today],
        ),
        query(
          `SELECT COALESCE(SUM(i.quantity * p.purchase_price),0) AS total FROM inventory i JOIN products p ON p.id = i.product_id`,
        ),
        query(
          `SELECT COUNT(*) AS cnt FROM (SELECT p.id FROM products p LEFT JOIN inventory i ON i.product_id = p.id WHERE EXISTS (SELECT 1 FROM batches pb WHERE pb.product_id = p.id) OR EXISTS (SELECT 1 FROM inventory i2 WHERE i2.product_id = p.id AND i2.quantity <> 0) GROUP BY p.id, p.low_stock_threshold HAVING COALESCE(SUM(i.quantity),0) < p.low_stock_threshold) sub`,
        ),
        query(
          `SELECT COUNT(*) AS cnt, COALESCE(SUM(i.total_gross - COALESCE(p.paid,0)),0) AS total FROM invoices i LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p ON p.invoice_id = i.id WHERE i.document_type = 'invoice' AND i.status = 'active' AND i.total_gross > COALESCE(p.paid,0)`,
        ),
        query(
          `SELECT COUNT(DISTINCT b.product_id) AS cnt FROM batches b JOIN inventory i ON i.batch_id = b.id WHERE b.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days' AND i.quantity > 0`,
        ),
      ]);

      const todayRevenue = parseFloat(profit.rows[0]?.revenue ?? "0");
      const todayCogs = parseFloat(profit.rows[0]?.cogs ?? "0");
      const todayProfit = todayRevenue - todayCogs;

      return {
        today_orders: parseInt(orders.rows[0].cnt) || 0,
        today_revenue: parseFloat(revenue.rows[0].total) || 0,
        today_profit: todayProfit,
        today_profit_margin_pct:
          todayRevenue > 0
            ? Math.round((todayProfit / todayRevenue) * 1000) / 10
            : 0,
        total_stock_value: parseFloat(stockValue.rows[0].total) || 0,
        low_stock_count: parseInt(lowStock.rows[0].cnt) || 0,
        pending_payments: parseInt(pendingPayments.rows[0].cnt) || 0,
        pending_payments_amount: parseFloat(pendingPayments.rows[0].total) || 0,
        expiring_soon_count: parseInt(expiring.rows[0].cnt) || 0,
      };
    },
  );

  // GET /analytics/report/daily
  app.get(
    "/report/daily",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      const { date } = request.query as any;
      const day = date || new Date().toISOString().slice(0, 10);

      const [orders, revenue, items, stock, payments, lowStock] =
        await Promise.all([
          query(
            `SELECT COUNT(*) AS cnt FROM orders WHERE DATE(order_date) = $1`,
            [day],
          ),
          query(
            `SELECT COALESCE(SUM(total_amount),0) AS total FROM orders WHERE DATE(order_date) = $1`,
            [day],
          ),
          query(
            `SELECT COALESCE(SUM(oi.quantity),0) AS cnt FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE DATE(o.order_date) = $1`,
            [day],
          ),
          query(
            `SELECT COALESCE(SUM(ig.total_amount),0) AS total FROM incoming_goods ig WHERE DATE(ig.created_at) = $1`,
            [day],
          ),
          query(
            `SELECT COALESCE(SUM(p.amount),0) AS total FROM payments p WHERE DATE(p.paid_at) = $1`,
            [day],
          ),
          query(
            `SELECT COUNT(*) AS cnt FROM (SELECT p.id FROM products p LEFT JOIN inventory i ON i.product_id = p.id WHERE EXISTS (SELECT 1 FROM batches b WHERE b.product_id = p.id) GROUP BY p.id, p.low_stock_threshold HAVING COALESCE(SUM(i.quantity),0) < p.low_stock_threshold) sub`,
          ),
        ]);

      return {
        date: day,
        total_orders: parseInt(orders.rows[0].cnt) || 0,
        total_revenue: parseFloat(revenue.rows[0].total) || 0,
        total_items_sold: parseInt(items.rows[0].cnt) || 0,
        new_stock_received: parseFloat(stock.rows[0].total) || 0,
        payments_collected: parseFloat(payments.rows[0].total) || 0,
        low_stock_alerts: parseInt(lowStock.rows[0].cnt) || 0,
      };
    },
  );

  // GET /analytics/report/monthly
  app.get(
    "/report/monthly",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      const { year, month } = request.query as any;
      const y = parseInt(year) || new Date().getFullYear();
      const m = parseInt(month) || new Date().getMonth() + 1;
      const monthStr = `${y}-${String(m).padStart(2, "0")}`;

      const [orders, revenue, avgDaily, payments, topProducts] =
        await Promise.all([
          query(
            `SELECT COUNT(*) AS cnt FROM orders WHERE TO_CHAR(order_date, 'YYYY-MM') = $1`,
            [monthStr],
          ),
          query(
            `SELECT COALESCE(SUM(total_amount),0) AS total FROM orders WHERE TO_CHAR(order_date, 'YYYY-MM') = $1`,
            [monthStr],
          ),
          query(
            `SELECT COALESCE(AVG(daily_rev),0) AS avg FROM (SELECT DATE(order_date) AS d, SUM(total_amount) AS daily_rev FROM orders WHERE TO_CHAR(order_date, 'YYYY-MM') = $1 GROUP BY DATE(order_date)) sub`,
            [monthStr],
          ),
          query(
            `SELECT COALESCE(SUM(p.amount),0) AS total FROM payments p WHERE TO_CHAR(p.paid_at, 'YYYY-MM') = $1`,
            [monthStr],
          ),
          query(
            `SELECT p.name_bg AS name, SUM(oi.quantity) AS qty, SUM(oi.total_price) AS revenue FROM order_items oi JOIN products p ON p.id = oi.product_id JOIN orders o ON o.id = oi.order_id WHERE TO_CHAR(o.order_date, 'YYYY-MM') = $1 GROUP BY p.id, p.name_bg ORDER BY revenue DESC LIMIT 5`,
            [monthStr],
          ),
        ]);

      return {
        month: monthStr,
        year: y,
        total_orders: parseInt(orders.rows[0].cnt) || 0,
        total_revenue: parseFloat(revenue.rows[0].total) || 0,
        avg_daily_revenue: parseFloat(avgDaily.rows[0].avg) || 0,
        payments_collected: parseFloat(payments.rows[0].total) || 0,
        top_products: topProducts.rows.map((r) => ({
          name: r.name,
          quantity: parseFloat(r.qty),
          revenue: parseFloat(r.revenue),
        })),
      };
    },
  );

  /**
   * Convert the period enum + optional custom range into [fromISO, toISO].
   * Returns ISO-date strings (YYYY-MM-DD). Both endpoints inclusive.
   */
  function resolvePeriodRange(
    period: string | undefined,
    from?: string,
    to?: string,
  ): { from: string; to: string; previousFrom: string; previousTo: string } {
    const today = new Date();
    const dayMs = 86400000;
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    let fromDate: Date;
    let toDate: Date = today;

    switch (period) {
      case "yesterday": {
        const y = new Date(today.getTime() - dayMs);
        fromDate = toDate = y;
        break;
      }
      case "week": {
        fromDate = new Date(today.getTime() - 6 * dayMs);
        break;
      }
      case "month": {
        fromDate = new Date(today.getTime() - 29 * dayMs);
        break;
      }
      case "custom": {
        fromDate = from
          ? new Date(from)
          : new Date(today.getTime() - 6 * dayMs);
        toDate = to ? new Date(to) : today;
        break;
      }
      case "today":
      default:
        fromDate = today;
    }

    const fromIso = iso(fromDate);
    const toIso = iso(toDate);

    // Previous period of the same length for comparison
    const spanMs = toDate.getTime() - fromDate.getTime();
    const prevToDate = new Date(fromDate.getTime() - dayMs);
    const prevFromDate = new Date(prevToDate.getTime() - spanMs);

    return {
      from: fromIso,
      to: toIso,
      previousFrom: iso(prevFromDate),
      previousTo: iso(prevToDate),
    };
  }

  // GET /analytics/profit — revenue, COGS, profit for a period with delta vs previous
  app.get("/profit", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    const { period, from, to } = request.query as any;
    const range = resolvePeriodRange(period, from, to);

    // Core aggregation — re-used for current & previous periods
    const aggregateSql = `
      SELECT
        COALESCE(SUM(oi.total_price), 0)::numeric AS revenue_net,
        COALESCE(SUM(oi.cost_unit_price * oi.quantity), 0)::numeric AS cogs,
        COUNT(DISTINCT o.id)::int AS order_count
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.status NOT IN ('cancelled', 'pending')
        AND o.order_date >= $1::date
        AND o.order_date < ($2::date + INTERVAL '1 day')
    `;

    const [current, previous] = await Promise.all([
      query(aggregateSql, [range.from, range.to]),
      query(aggregateSql, [range.previousFrom, range.previousTo]),
    ]);

    const fmt = (row: any) => {
      const revenue = parseFloat(row?.revenue_net ?? "0");
      const cogs = parseFloat(row?.cogs ?? "0");
      const profit = revenue - cogs;
      const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
      return {
        revenue_net: revenue,
        revenue_gross: Math.round(revenue * 1.2 * 100) / 100, // +20% VAT estimate
        cogs,
        profit,
        profit_margin_pct: Math.round(margin * 10) / 10,
        order_count: parseInt(row?.order_count ?? "0"),
      };
    };

    const curr = fmt(current.rows[0]);
    const prev = fmt(previous.rows[0]);
    const deltaPct =
      prev.revenue_net > 0
        ? ((curr.revenue_net - prev.revenue_net) / prev.revenue_net) * 100
        : null;

    return {
      period: period || "today",
      range: { from: range.from, to: range.to },
      ...curr,
      comparison: {
        previous_period: prev,
        previous_range: { from: range.previousFrom, to: range.previousTo },
        delta_pct: deltaPct !== null ? Math.round(deltaPct * 10) / 10 : null,
      },
    };
  });

  // GET /analytics/supplier-payables — money we owe suppliers (unpaid incoming_goods)
  app.get(
    "/supplier-payables",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);

      // Best-effort: incoming_goods table tracks purchase cost. We consider
      // any incoming not marked paid as payable. `paid_at` or `payment_status`
      // column is checked below with COALESCE fallback (schema-tolerant).
      const sql = `
        SELECT
          s.id AS supplier_id,
          s.name AS supplier_name,
          COUNT(ig.id)::int AS invoice_count,
          COALESCE(SUM(ig.total_amount), 0)::numeric AS total_owed,
          MIN(ig.delivery_date)::date AS oldest_delivery
        FROM incoming_goods ig
        JOIN suppliers s ON s.id = ig.supplier_id
        WHERE COALESCE(ig.payment_status, 'unpaid') <> 'paid'
        GROUP BY s.id, s.name
        ORDER BY total_owed DESC
      `;

      let rows: any[] = [];
      try {
        const result = await query(sql, []);
        rows = result.rows;
      } catch (err: any) {
        // Fallback if payment_status column doesn't exist yet — return empty
        if (err?.code === "42703") {
          rows = [];
        } else {
          throw err;
        }
      }

      const grandTotal = rows.reduce(
        (sum, r) => sum + parseFloat(r.total_owed ?? "0"),
        0,
      );

      return {
        total: grandTotal,
        count: rows.length,
        by_supplier: rows.map((r) => ({
          supplier_id: r.supplier_id,
          supplier_name: r.supplier_name,
          invoice_count: r.invoice_count,
          total_owed: parseFloat(r.total_owed),
          oldest_delivery: r.oldest_delivery,
          overdue_days: r.oldest_delivery
            ? Math.floor(
                (Date.now() - new Date(r.oldest_delivery).getTime()) / 86400000,
              )
            : 0,
        })),
      };
    },
  );

  // GET /analytics/top-partners — best-selling partners for a period
  app.get(
    "/top-partners",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      const { period, from, to, limit } = request.query as any;
      const range = resolvePeriodRange(period, from, to);
      const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 10));

      const sql = `
        SELECT
          p.id AS partner_id,
          p.name AS partner_name,
          COUNT(DISTINCT o.id)::int AS order_count,
          COALESCE(SUM(oi.total_price), 0)::numeric AS total_revenue,
          COALESCE(SUM(oi.cost_unit_price * oi.quantity), 0)::numeric AS total_cogs,
          COALESCE(SUM(oi.quantity), 0)::numeric AS total_units
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN partners p ON p.id = o.partner_id
        WHERE o.status NOT IN ('cancelled', 'pending')
          AND o.order_date >= $1::date
          AND o.order_date < ($2::date + INTERVAL '1 day')
        GROUP BY p.id, p.name
        ORDER BY total_revenue DESC
        LIMIT $3
      `;
      const { rows } = await query(sql, [range.from, range.to, limitNum]);

      const grandRevenue = rows.reduce(
        (s, r) => s + parseFloat(r.total_revenue ?? "0"),
        0,
      );

      return {
        period: period || "today",
        range: { from: range.from, to: range.to },
        total_revenue: grandRevenue,
        partners: rows.map((r) => {
          const rev = parseFloat(r.total_revenue);
          const cogs = parseFloat(r.total_cogs);
          return {
            partner_id: r.partner_id,
            partner_name: r.partner_name,
            order_count: r.order_count,
            total_units: parseFloat(r.total_units),
            total_revenue: rev,
            total_profit: rev - cogs,
            profit_margin_pct:
              rev > 0 ? Math.round(((rev - cogs) / rev) * 1000) / 10 : 0,
            revenue_pct:
              grandRevenue > 0
                ? Math.round((rev / grandRevenue) * 1000) / 10
                : 0,
          };
        }),
      };
    },
  );
}
