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
// Placeholder body — Task 3 replaces this with 7 real aggregation queries.
// Returns the company name from settings + zero counts everywhere else, so
// this commit compiles and the route can be tested end-to-end.
async function assembleDailyReportData(
  date: string,
  request: FastifyRequest,
): Promise<DailyReportData> {
  const { rows: companyRows } = await query(
    "SELECT company_name FROM settings WHERE id = 1",
  );
  const companyName = companyRows[0]?.company_name ?? "BAKALIA GREEK DELI FOOD";
  return {
    date,
    generatedBy: (request.user as any)?.email ?? "—",
    company: { name: companyName },
    orders: [],
    ordersSummaryByStatus: [],
    invoices: {
      active: { count: 0, net: 0, vat: 0, gross: 0 },
      credit_noted: { count: 0, sum: 0 },
      cancelled: { count: 0, sum: 0 },
      byPaymentMethod: [],
    },
    payments: { byMethod: [], total: 0 },
    econtShipments: [],
    outstanding: { totalRemaining: 0, totalCount: 0, top10: [] },
    topProducts: [],
    outputPath: "",
  };
}
