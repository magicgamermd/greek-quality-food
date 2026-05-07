// warehouse-backend/src/routes/reports.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { query } from "../db.js";
import { PERMISSIONS, requirePermission } from "../lib/permissions.js";
import {
  generateDailyReportPdf,
  type DailyReportData,
} from "../services/daily-report-pdf.js";

const dailyReportQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional()
    .transform((v) => v ?? new Date().toISOString().slice(0, 10)),
});

async function jwtVerify(request: FastifyRequest, reply: FastifyReply) {
  try {
    await (request as any).jwtVerify();
  } catch {
    return reply.status(401).send({ error: "Unauthorized" });
  }
}

const reportsViewPreHandler = [
  jwtVerify,
  requirePermission(PERMISSIONS.REPORTS_VIEW),
];

export default async function reportsRoutes(app: FastifyInstance) {
  // GET /reports/daily-pdf?date=YYYY-MM-DD — Дневен отчет (Daily Report)
  app.get(
    "/daily-pdf",
    { preHandler: reportsViewPreHandler },
    async (request, reply) => {
      const parsed = dailyReportQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: parsed.error.errors[0]?.message ?? "Bad date" });
      }
      const { date } = parsed.data;
      const data = await assembleDailyReportData(date, request);
      const pdfDir = path.resolve(process.cwd(), "data", "reports");
      if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
      const outputPath = path.join(pdfDir, `daily-${date}.pdf`);
      data.outputPath = outputPath;
      await generateDailyReportPdf(data);
      const stream = fs.createReadStream(outputPath);
      const filename = `Дневен_отчет_${date}.pdf`;
      const encodedFilename = encodeURIComponent(filename);
      return reply
        .header("Content-Type", "application/pdf")
        .header(
          "Content-Disposition",
          `inline; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`,
        )
        .send(stream);
    },
  );

  // GET /reports/range-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
  // Aggregated totals over a date range — orders, invoices, payments,
  // top products, top partners. Used for weekly/monthly summaries
  // exposed via the MCP server / Telegram bot.
  app.get(
    "/range-summary",
    { preHandler: reportsViewPreHandler },
    async (request, reply) => {
      const parsed = rangeQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: parsed.error.errors[0]?.message ?? "Bad range" });
      }
      const { from, to } = parsed.data;
      if (from > to) {
        return reply.status(400).send({ error: "from must be <= to" });
      }
      return assembleRangeSummary(from, to);
    },
  );
}

const rangeQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
});

async function assembleRangeSummary(from: string, to: string) {
  const { rows: orderTotals } = await query(
    `SELECT
        COUNT(*) FILTER (WHERE status NOT IN ('cancelled','quoted'))::int AS active_count,
        COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('cancelled','quoted')), 0)::numeric AS active_sum,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_count,
        COUNT(*) FILTER (WHERE status = 'quoted')::int AS quoted_count
       FROM orders
      WHERE DATE(order_date) BETWEEN $1 AND $2`,
    [from, to],
  );

  const { rows: invoiceTotals } = await query(
    `SELECT
        COUNT(*) FILTER (WHERE i.status='active' AND cn.id IS NULL)::int AS active_count,
        COALESCE(SUM(i.total_net)   FILTER (WHERE i.status='active' AND cn.id IS NULL), 0)::numeric AS active_net,
        COALESCE(SUM(i.total_vat)   FILTER (WHERE i.status='active' AND cn.id IS NULL), 0)::numeric AS active_vat,
        COALESCE(SUM(i.total_gross) FILTER (WHERE i.status='active' AND cn.id IS NULL), 0)::numeric AS active_gross
       FROM invoices i
       LEFT JOIN invoices cn
         ON cn.related_invoice_id = i.id
        AND cn.document_type = 'credit_note'
      WHERE DATE(i.invoice_date) BETWEEN $1 AND $2
        AND i.document_type = 'invoice'`,
    [from, to],
  );

  const { rows: paymentByMethod } = await query(
    `SELECT payment_method AS method,
            COUNT(*)::int AS count,
            COALESCE(SUM(amount), 0)::numeric AS sum
       FROM payments
      WHERE DATE(paid_at) BETWEEN $1 AND $2
      GROUP BY payment_method
      ORDER BY sum DESC`,
    [from, to],
  );

  const { rows: topProducts } = await query(
    `SELECT
        oi.name_bg_snapshot AS name,
        oi.sku_snapshot AS sku,
        SUM(oi.quantity)::numeric AS qty,
        SUM(oi.total_price)::numeric AS total
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE DATE(o.order_date) BETWEEN $1 AND $2
        AND o.status NOT IN ('cancelled','quoted')
      GROUP BY oi.name_bg_snapshot, oi.sku_snapshot
      ORDER BY qty DESC
      LIMIT 10`,
    [from, to],
  );

  const { rows: topPartners } = await query(
    `SELECT p.name AS partner_name,
            COUNT(*)::int AS order_count,
            COALESCE(SUM(o.total_amount), 0)::numeric AS total
       FROM orders o
       LEFT JOIN partners p ON p.id = o.partner_id
      WHERE DATE(o.order_date) BETWEEN $1 AND $2
        AND o.status NOT IN ('cancelled','quoted')
      GROUP BY p.name
      ORDER BY total DESC
      LIMIT 10`,
    [from, to],
  );

  const orders = orderTotals[0] ?? {};
  const invoices = invoiceTotals[0] ?? {};
  const paymentTotal = paymentByMethod.reduce(
    (s: number, r: any) => s + parseFloat(r.sum ?? 0),
    0,
  );

  return {
    range: { from, to },
    orders: {
      active_count: orders.active_count ?? 0,
      active_sum: parseFloat(orders.active_sum ?? 0),
      cancelled_count: orders.cancelled_count ?? 0,
      quoted_count: orders.quoted_count ?? 0,
    },
    invoices: {
      active_count: invoices.active_count ?? 0,
      active_net: parseFloat(invoices.active_net ?? 0),
      active_vat: parseFloat(invoices.active_vat ?? 0),
      active_gross: parseFloat(invoices.active_gross ?? 0),
    },
    payments: {
      total: paymentTotal,
      by_method: paymentByMethod.map((r: any) => ({
        method: r.method,
        count: r.count,
        sum: parseFloat(r.sum ?? 0),
      })),
    },
    top_products: topProducts.map((r: any) => ({
      name: r.name ?? "—",
      sku: r.sku ?? null,
      qty: parseFloat(r.qty ?? 0),
      total: parseFloat(r.total ?? 0),
    })),
    top_partners: topPartners.map((r: any) => ({
      partner_name: r.partner_name ?? "—",
      order_count: r.order_count,
      total: parseFloat(r.total ?? 0),
    })),
  };
}

async function assembleDailyReportData(
  date: string,
  request: FastifyRequest,
): Promise<DailyReportData> {
  const { rows: companyRows } = await query(
    "SELECT company_name FROM settings WHERE id = 1",
  );
  const companyName = companyRows[0]?.company_name ?? "BAKALIA GREEK DELI FOOD";

  // 1) Orders for the day with partner name + payment method via invoice.
  // partner_name uses the invoice_partner override when set (Batch D —
  // 'Издай на фирма' on an individual order), so the report reflects
  // the invoice recipient, not the original cash-customer row.
  const { rows: orderRows } = await query(
    `SELECT o.id, o.order_number, COALESCE(ip.name, p.name) AS partner_name,
            o.total_amount, o.status,
            i.payment_method, i.invoice_number, i.status AS invoice_status,
            o.econt_shipment_number, o.econt_cod_amount
       FROM orders o
       LEFT JOIN partners p ON p.id = o.partner_id
       LEFT JOIN partners ip ON ip.id = o.invoice_partner_id
       LEFT JOIN invoices i ON i.id = o.invoice_id
      WHERE DATE(o.order_date) = $1
      ORDER BY o.order_number ASC`,
    [date],
  );

  // 2) Orders summary by status
  const { rows: orderSummaryRows } = await query(
    `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total_amount), 0)::numeric AS sum
       FROM orders WHERE DATE(order_date) = $1 GROUP BY status`,
    [date],
  );

  // 3) Invoices by status (active / credit-noted / cancelled).
  // Schema note: invoices.credit_note_id does NOT exist. Credit notes are
  // separate invoice rows (document_type='credit_note') that point at the
  // parent invoice via related_invoice_id. So an invoice is "credit-noted"
  // when there exists a credit_note row whose related_invoice_id = i.id.
  const { rows: invStatusRows } = await query(
    `WITH classified AS (
        SELECT i.status,
               i.total_net,
               i.total_vat,
               i.total_gross,
               (cn.id IS NOT NULL) AS is_credit_noted
          FROM invoices i
          LEFT JOIN invoices cn
            ON cn.related_invoice_id = i.id
           AND cn.document_type = 'credit_note'
         WHERE DATE(i.invoice_date) = $1
           AND i.document_type = 'invoice'
     )
     SELECT
        COUNT(*) FILTER (WHERE status = 'active' AND NOT is_credit_noted)::int AS active_count,
        COALESCE(SUM(total_net)   FILTER (WHERE status = 'active' AND NOT is_credit_noted), 0)::numeric AS active_net,
        COALESCE(SUM(total_vat)   FILTER (WHERE status = 'active' AND NOT is_credit_noted), 0)::numeric AS active_vat,
        COALESCE(SUM(total_gross) FILTER (WHERE status = 'active' AND NOT is_credit_noted), 0)::numeric AS active_gross,
        COUNT(*) FILTER (WHERE is_credit_noted)::int AS credit_noted_count,
        COALESCE(SUM(total_gross) FILTER (WHERE is_credit_noted), 0)::numeric AS credit_noted_sum,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_count,
        COALESCE(SUM(total_gross) FILTER (WHERE status = 'cancelled'), 0)::numeric AS cancelled_sum
       FROM classified`,
    [date],
  );
  const invStats = invStatusRows[0] ?? {};

  // 4) Active (not credit-noted, not cancelled) invoices for the day, grouped by payment_method.
  const { rows: invByMethodRows } = await query(
    `SELECT COALESCE(i.payment_method, 'unset') AS method,
            COUNT(*)::int AS count,
            COALESCE(SUM(i.total_gross), 0)::numeric AS sum
       FROM invoices i
       LEFT JOIN invoices cn
         ON cn.related_invoice_id = i.id
        AND cn.document_type = 'credit_note'
      WHERE DATE(i.invoice_date) = $1
        AND i.document_type = 'invoice'
        AND i.status = 'active'
        AND cn.id IS NULL
      GROUP BY i.payment_method`,
    [date],
  );

  // 5) Payments received today, grouped by payment_method
  const { rows: paymentByMethodRows } = await query(
    `SELECT payment_method AS method,
            COUNT(*)::int AS count,
            COALESCE(SUM(amount), 0)::numeric AS sum
       FROM payments
      WHERE DATE(paid_at) = $1
      GROUP BY payment_method`,
    [date],
  );
  const paymentTotal = paymentByMethodRows.reduce(
    (s: number, r: any) => s + parseFloat(r.sum ?? 0),
    0,
  );

  // 5b) Per-order rows for the cashier-style table on the PDF — every
  // order created today is listed regardless of whether a payment has
  // been recorded against it yet. Aggregates payment data so the PDF
  // can flag each row as "Платено / Частично / Неплатено" and surface
  // how much money has actually landed against the order's invoice.
  // Two payment-link paths because both the legacy `payments.invoice_id`
  // and the newer `payments.order_id` are in use.
  // Partner display: invoice_partner override (Batch D) wins over the
  // order's own partner. If an individual order ('Физическо лице')
  // got reissued to a company via 'Издай на фирма', the override
  // company name is what the cashier expects to see in the report.
  const { rows: orderPaymentRows } = await query(
    `SELECT o.id,
            o.order_number,
            o.order_date,
            o.total_amount::numeric AS total_amount,
            o.status,
            COALESCE(ip.name, p.name) AS partner_name,
            i.payment_method,
            i.invoice_number,
            i.status AS invoice_status,
            COALESCE(SUM(pmt.amount), 0)::numeric AS paid_amount,
            COUNT(pmt.id)::int AS payment_count,
            MAX(pmt.paid_at) AS last_paid_at
       FROM orders o
       LEFT JOIN partners p ON p.id = o.partner_id
       LEFT JOIN partners ip ON ip.id = o.invoice_partner_id
       LEFT JOIN invoices i ON i.id = o.invoice_id
       LEFT JOIN payments pmt ON (pmt.invoice_id = i.id OR pmt.order_id = o.id)
                              AND DATE(pmt.paid_at) <= $1
      WHERE DATE(o.order_date) = $1
      GROUP BY o.id, o.order_number, o.order_date, o.total_amount, o.status,
               ip.name, p.name, i.payment_method, i.invoice_number, i.status
      ORDER BY o.order_number ASC`,
    [date],
  );

  // 5c) "Очакван наложен платеж" — Econt COD shipments matched to the
  // report date by ANY of: shipment date, order creation date, or
  // related invoice's creation date. The previous filter only matched
  // `econt_shipment_date OR created_at` but not both, so an order
  // created today with shipment_date on a different day (e.g. user
  // picked tomorrow as pickup, or Econt actually shipped yesterday)
  // wouldn't appear in either day's report. The COALESCE-fallback also
  // failed when shipment_date is set but to a different date.
  // Surfaced as a separate KPI / table block so the cashier can see
  // the gap between "money in the till today" and "money expected
  // from couriers".
  const { rows: expectedCodRows } = await query(
    `SELECT o.id,
            o.order_number,
            COALESCE(ip.name, p.name) AS partner_name,
            o.econt_shipment_number AS shipment_number,
            o.econt_cod_amount::numeric AS cod_amount,
            COALESCE(o.econt_shipment_date, o.created_at::date) AS shipped_at
       FROM orders o
       LEFT JOIN partners p ON p.id = o.partner_id
       LEFT JOIN partners ip ON ip.id = o.invoice_partner_id
       LEFT JOIN invoices i ON i.id = o.invoice_id
      WHERE o.econt_shipment_number IS NOT NULL
        AND o.econt_cod_amount IS NOT NULL
        AND o.econt_cod_amount > 0
        AND (
              DATE(o.econt_shipment_date) = $1
           OR DATE(o.created_at) = $1
           OR DATE(i.invoice_date) = $1
        )
      ORDER BY o.order_number ASC`,
    [date],
  );
  const expectedCodTotal = expectedCodRows.reduce(
    (s: number, r: any) => s + parseFloat(r.cod_amount ?? 0),
    0,
  );

  // 6) Outstanding invoices snapshot at end of $date — totals.
  // Excludes: credit notes themselves, cancelled invoices, and invoices that
  // have been credit-noted (i.e. a credit_note row points at them).
  const { rows: outstandingTotalRows } = await query(
    `SELECT COUNT(*)::int AS count,
            COALESCE(SUM(remaining), 0)::numeric AS total
       FROM (
         SELECT i.id,
                i.total_gross - COALESCE(SUM(p.amount), 0) AS remaining
           FROM invoices i
           LEFT JOIN payments p ON p.invoice_id = i.id AND DATE(p.paid_at) <= $1
           LEFT JOIN invoices cn
             ON cn.related_invoice_id = i.id
            AND cn.document_type = 'credit_note'
          WHERE DATE(i.invoice_date) <= $1
            AND i.document_type = 'invoice'
            AND i.status = 'active'
            AND cn.id IS NULL
          GROUP BY i.id
         HAVING i.total_gross - COALESCE(SUM(p.amount), 0) > 0.01
       ) AS t`,
    [date],
  );
  const outstandingTotal = outstandingTotalRows[0] ?? { count: 0, total: 0 };

  // 6b) Top 10 oldest unpaid invoices (same exclusions as 6).
  const { rows: outstandingTopRows } = await query(
    `SELECT i.invoice_number,
            TO_CHAR(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
            p.name AS partner_name,
            i.total_gross::numeric AS gross,
            COALESCE(SUM(pmt.amount), 0)::numeric AS paid,
            (i.total_gross - COALESCE(SUM(pmt.amount), 0))::numeric AS remaining,
            ($1::date - i.invoice_date::date)::int AS days_overdue
       FROM invoices i
       LEFT JOIN payments pmt ON pmt.invoice_id = i.id AND DATE(pmt.paid_at) <= $1
       LEFT JOIN partners p ON p.id = i.partner_id
       LEFT JOIN invoices cn
         ON cn.related_invoice_id = i.id
        AND cn.document_type = 'credit_note'
      WHERE DATE(i.invoice_date) <= $1
        AND i.document_type = 'invoice'
        AND i.status = 'active'
        AND cn.id IS NULL
      GROUP BY i.id, p.name
     HAVING i.total_gross - COALESCE(SUM(pmt.amount), 0) > 0.01
      ORDER BY i.invoice_date ASC
      LIMIT 10`,
    [date],
  );

  // 7) Top 5 products for the day by quantity
  const { rows: topProductRows } = await query(
    `SELECT
        oi.name_bg_snapshot AS name,
        oi.sku_snapshot     AS sku,
        SUM(oi.quantity)::numeric    AS qty,
        SUM(oi.total_price)::numeric AS total
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE DATE(o.order_date) = $1
        AND o.status NOT IN ('cancelled', 'quoted')
      GROUP BY oi.name_bg_snapshot, oi.sku_snapshot
      ORDER BY qty DESC
      LIMIT 5`,
    [date],
  );

  return {
    date,
    generatedBy: (request.user as any)?.email ?? "—",
    company: { name: companyName },
    orders: orderRows.map((o: any) => ({
      order_number: o.order_number ?? o.id,
      partner_name: o.partner_name ?? "—",
      total_amount: parseFloat(o.total_amount ?? 0),
      status: o.status,
      payment_method: o.payment_method ?? null,
      invoice_number: o.invoice_number ?? null,
      invoice_status: o.invoice_status ?? null,
    })),
    ordersSummaryByStatus: orderSummaryRows.map((r: any) => ({
      status: r.status,
      count: r.count,
      sum: parseFloat(r.sum ?? 0),
    })),
    invoices: {
      active: {
        count: invStats.active_count ?? 0,
        net: parseFloat(invStats.active_net ?? 0),
        vat: parseFloat(invStats.active_vat ?? 0),
        gross: parseFloat(invStats.active_gross ?? 0),
      },
      credit_noted: {
        count: invStats.credit_noted_count ?? 0,
        sum: parseFloat(invStats.credit_noted_sum ?? 0),
      },
      cancelled: {
        count: invStats.cancelled_count ?? 0,
        sum: parseFloat(invStats.cancelled_sum ?? 0),
      },
      byPaymentMethod: invByMethodRows.map((r: any) => ({
        method: r.method,
        count: r.count,
        sum: parseFloat(r.sum ?? 0),
      })),
    },
    payments: {
      byMethod: paymentByMethodRows.map((r: any) => ({
        method: r.method,
        count: r.count,
        sum: parseFloat(r.sum ?? 0),
      })),
      total: paymentTotal,
      // Per-order detail for the cashier-style table on the PDF. Every
      // order from the day is here, with paid_amount/total_amount used
      // to derive paid/partial/unpaid status. ISO date strings only
      // (Postgres TIMESTAMPTZ comes back as Date objects, which lack
      // .slice — toISOString() is the lingua franca).
      rows: orderPaymentRows.map((r: any) => {
        const total = parseFloat(r.total_amount ?? 0);
        const paid = parseFloat(r.paid_amount ?? 0);
        const cancelled = r.status === "cancelled";
        let paymentStatus: "paid" | "partial" | "unpaid" | "cancelled";
        if (cancelled) paymentStatus = "cancelled";
        else if (paid >= total - 0.01) paymentStatus = "paid";
        else if (paid > 0) paymentStatus = "partial";
        else paymentStatus = "unpaid";
        const orderDateIso =
          r.order_date instanceof Date
            ? r.order_date.toISOString()
            : String(r.order_date);
        const lastPaidIso = r.last_paid_at
          ? r.last_paid_at instanceof Date
            ? r.last_paid_at.toISOString()
            : String(r.last_paid_at)
          : null;
        return {
          order_number: r.order_number ?? r.id,
          partner_name: r.partner_name ?? "—",
          order_date: orderDateIso,
          total_amount: total,
          paid_amount: paid,
          payment_count: r.payment_count ?? 0,
          last_paid_at: lastPaidIso,
          method: r.payment_method ?? null,
          invoice_number: r.invoice_number ?? null,
          invoice_status: r.invoice_status ?? null,
          payment_status: paymentStatus,
        };
      }),
    },
    unpaidToday: (() => {
      // Информативен tally в footer-а: поръчки от деня без пълно плащане
      // към края на деня. Изключваме cancelled (нямат смисъл в "неплатени")
      // и paid_not_taken/awaiting не променят логиката — статусът тук е
      // payment_status (paid/partial/unpaid/cancelled), който се изчислява
      // в paymentsRows блока по-горе. Сумираме remaining = total − paid.
      let count = 0;
      let total = 0;
      for (const r of orderPaymentRows) {
        const totalAmt = parseFloat(r.total_amount ?? 0);
        const paid = parseFloat(r.paid_amount ?? 0);
        if (r.status === "cancelled") continue;
        const remaining = totalAmt - paid;
        if (remaining > 0.001) {
          count++;
          total += remaining;
        }
      }
      return { count, total };
    })(),
    expectedCod: {
      count: expectedCodRows.length,
      total: expectedCodTotal,
      rows: expectedCodRows.map((r: any) => ({
        order_number: r.order_number ?? r.id,
        partner_name: r.partner_name ?? "—",
        // Same TIMESTAMPTZ → string conversion as the payments rows
        // above; the renderer expects an ISO string it can slice.
        shipped_at:
          r.shipped_at instanceof Date
            ? r.shipped_at.toISOString()
            : String(r.shipped_at),
        shipment_number: r.shipment_number,
        cod_amount: parseFloat(r.cod_amount ?? 0),
      })),
    },
    econtShipments: orderRows
      .filter((o: any) => !!o.econt_shipment_number)
      .map((o: any) => ({
        order_number: o.order_number ?? o.id,
        partner_name: o.partner_name ?? "—",
        total_amount: parseFloat(o.total_amount ?? 0),
        type:
          parseFloat(o.econt_cod_amount ?? 0) > 0
            ? ("cod" as const)
            : ("standard" as const),
        cod_amount: o.econt_cod_amount ? parseFloat(o.econt_cod_amount) : null,
        shipment_number: o.econt_shipment_number,
      })),
    outstanding: {
      totalRemaining: parseFloat(outstandingTotal.total ?? 0),
      totalCount: outstandingTotal.count ?? 0,
      top10: outstandingTopRows.map((r: any) => ({
        invoice_number: r.invoice_number,
        invoice_date: r.invoice_date,
        partner_name: r.partner_name ?? "—",
        gross: parseFloat(r.gross ?? 0),
        paid: parseFloat(r.paid ?? 0),
        remaining: parseFloat(r.remaining ?? 0),
        days_overdue: r.days_overdue ?? 0,
      })),
    },
    topProducts: topProductRows.map((r: any) => ({
      name: r.name ?? "—",
      sku: r.sku ?? null,
      qty: parseFloat(r.qty ?? 0),
      total: parseFloat(r.total ?? 0),
    })),
    outputPath: "",
  };
}
