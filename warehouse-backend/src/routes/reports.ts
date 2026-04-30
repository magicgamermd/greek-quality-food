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
}
async function assembleDailyReportData(
  date: string,
  request: FastifyRequest,
): Promise<DailyReportData> {
  const { rows: companyRows } = await query(
    "SELECT company_name FROM settings WHERE id = 1",
  );
  const companyName = companyRows[0]?.company_name ?? "BAKALIA GREEK DELI FOOD";

  // 1) Orders for the day with partner name + payment method via invoice
  const { rows: orderRows } = await query(
    `SELECT o.id, o.order_number, p.name AS partner_name,
            o.total_amount, o.status,
            i.payment_method, i.invoice_number, i.status AS invoice_status,
            o.econt_shipment_number, o.econt_cod_amount
       FROM orders o
       LEFT JOIN partners p ON p.id = o.partner_id
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

  // 3) Invoices by status (active / credit-noted / cancelled)
  const { rows: invStatusRows } = await query(
    `SELECT
        COUNT(*) FILTER (WHERE status = 'active' AND credit_note_id IS NULL)::int AS active_count,
        COALESCE(SUM(total_net) FILTER (WHERE status = 'active' AND credit_note_id IS NULL), 0)::numeric AS active_net,
        COALESCE(SUM(total_vat) FILTER (WHERE status = 'active' AND credit_note_id IS NULL), 0)::numeric AS active_vat,
        COALESCE(SUM(total_gross) FILTER (WHERE status = 'active' AND credit_note_id IS NULL), 0)::numeric AS active_gross,
        COUNT(*) FILTER (WHERE credit_note_id IS NOT NULL)::int AS credit_noted_count,
        COALESCE(SUM(total_gross) FILTER (WHERE credit_note_id IS NOT NULL), 0)::numeric AS credit_noted_sum,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_count,
        COALESCE(SUM(total_gross) FILTER (WHERE status = 'cancelled'), 0)::numeric AS cancelled_sum
       FROM invoices
      WHERE DATE(invoice_date) = $1`,
    [date],
  );
  const invStats = invStatusRows[0] ?? {};

  // 4) Active invoices for the day, grouped by payment_method
  const { rows: invByMethodRows } = await query(
    `SELECT COALESCE(payment_method, 'unset') AS method,
            COUNT(*)::int AS count,
            COALESCE(SUM(total_gross), 0)::numeric AS sum
       FROM invoices
      WHERE DATE(invoice_date) = $1 AND status = 'active' AND credit_note_id IS NULL
      GROUP BY payment_method`,
    [date],
  );

  // 5) Payments received today, grouped by payment_method
  const { rows: paymentByMethodRows } = await query(
    `SELECT payment_method AS method,
            COUNT(*)::int AS count,
            COALESCE(SUM(amount), 0)::numeric AS sum
       FROM payments
      WHERE DATE(payment_date) = $1
      GROUP BY payment_method`,
    [date],
  );
  const paymentTotal = paymentByMethodRows.reduce(
    (s: number, r: any) => s + parseFloat(r.sum ?? 0),
    0,
  );

  // 6) Outstanding invoices snapshot at end of $date — totals
  const { rows: outstandingTotalRows } = await query(
    `SELECT COUNT(*)::int AS count,
            COALESCE(SUM(remaining), 0)::numeric AS total
       FROM (
         SELECT i.id,
                i.total_gross - COALESCE(SUM(p.amount), 0) AS remaining
           FROM invoices i
           LEFT JOIN payments p ON p.invoice_id = i.id AND DATE(p.payment_date) <= $1
          WHERE DATE(i.invoice_date) <= $1
            AND i.status = 'active'
            AND i.credit_note_id IS NULL
          GROUP BY i.id
         HAVING i.total_gross - COALESCE(SUM(p.amount), 0) > 0.01
       ) AS t`,
    [date],
  );
  const outstandingTotal = outstandingTotalRows[0] ?? { count: 0, total: 0 };

  // 6b) Top 10 oldest unpaid invoices
  const { rows: outstandingTopRows } = await query(
    `SELECT i.invoice_number,
            TO_CHAR(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
            p.name AS partner_name,
            i.total_gross::numeric AS gross,
            COALESCE(SUM(pmt.amount), 0)::numeric AS paid,
            (i.total_gross - COALESCE(SUM(pmt.amount), 0))::numeric AS remaining,
            ($1::date - i.invoice_date::date)::int AS days_overdue
       FROM invoices i
       LEFT JOIN payments pmt ON pmt.invoice_id = i.id AND DATE(pmt.payment_date) <= $1
       LEFT JOIN partners p ON p.id = i.partner_id
      WHERE DATE(i.invoice_date) <= $1
        AND i.status = 'active'
        AND i.credit_note_id IS NULL
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
