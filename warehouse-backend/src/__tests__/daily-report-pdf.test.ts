import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { generateDailyReportPdf } from "../services/daily-report-pdf.js";

const TEST_OUTPUT_DIR = path.resolve("/tmp/mertm-test-daily-report");

function getPdfPageCount(filePath: string): number {
  const content = fs.readFileSync(filePath, "latin1");
  return (content.match(/\/Type\s*\/Page\b/g) || []).length;
}

describe("generateDailyReportPdf", () => {
  afterEach(() => {
    if (fs.existsSync(TEST_OUTPUT_DIR)) {
      fs.rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
    }
  });

  it("writes a non-empty PDF for a day with one order, one invoice, one payment", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(TEST_OUTPUT_DIR, "report.pdf");
    await generateDailyReportPdf({
      date: "2026-04-30",
      generatedBy: "admin@mertm.bg",
      company: { name: "BAKALIA GREEK DELI FOOD" },
      orders: [
        {
          order_number: 101,
          partner_name: "ЖОКЕР ЕНТ. ЕООД",
          total_amount: 359.11,
          status: "fulfilled",
          payment_method: "cash",
          invoice_number: "0000000023",
          invoice_status: "active",
        },
      ],
      ordersSummaryByStatus: [{ status: "fulfilled", count: 1, sum: 359.11 }],
      invoices: {
        active: { count: 1, net: 299.26, vat: 59.85, gross: 359.11 },
        credit_noted: { count: 0, sum: 0 },
        cancelled: { count: 0, sum: 0 },
        byPaymentMethod: [{ method: "cash", count: 1, sum: 359.11 }],
      },
      payments: {
        byMethod: [{ method: "cash", count: 1, sum: 359.11 }],
        total: 359.11,
        rows: [],
      },
      expectedCod: { count: 0, total: 0, rows: [] },
      econtShipments: [],
      outstanding: { totalRemaining: 0, totalCount: 0, top10: [] },
      topProducts: [
        { name: "Wine bottle lantern", sku: "MBG-344", qty: 1, total: 359.11 },
      ],
      outputPath,
    });
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.statSync(outputPath).size).toBeGreaterThan(1000);
    expect(getPdfPageCount(outputPath)).toBeGreaterThanOrEqual(1);
  });

  it("renders an empty-day report with zero counts in every section", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(TEST_OUTPUT_DIR, "empty.pdf");
    await generateDailyReportPdf({
      date: "2026-04-30",
      generatedBy: "admin@mertm.bg",
      company: { name: "BAKALIA GREEK DELI FOOD" },
      orders: [],
      ordersSummaryByStatus: [],
      invoices: {
        active: { count: 0, net: 0, vat: 0, gross: 0 },
        credit_noted: { count: 0, sum: 0 },
        cancelled: { count: 0, sum: 0 },
        byPaymentMethod: [],
      },
      payments: { byMethod: [], total: 0, rows: [] },
      expectedCod: { count: 0, total: 0, rows: [] },
      econtShipments: [],
      outstanding: { totalRemaining: 0, totalCount: 0, top10: [] },
      topProducts: [],
      outputPath,
    });
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.statSync(outputPath).size).toBeGreaterThan(500);
  });

  it("renders the Еконт section when shipments are present (cod + standard mix)", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(TEST_OUTPUT_DIR, "econt.pdf");
    await generateDailyReportPdf({
      date: "2026-04-30",
      generatedBy: "admin@mertm.bg",
      company: { name: "BAKALIA GREEK DELI FOOD" },
      orders: [],
      ordersSummaryByStatus: [],
      invoices: {
        active: { count: 0, net: 0, vat: 0, gross: 0 },
        credit_noted: { count: 0, sum: 0 },
        cancelled: { count: 0, sum: 0 },
        byPaymentMethod: [],
      },
      payments: { byMethod: [], total: 0, rows: [] },
      expectedCod: { count: 0, total: 0, rows: [] },
      econtShipments: [
        {
          order_number: 102,
          partner_name: "ВИКИ ВАТ ЕООД",
          total_amount: 2863.24,
          type: "cod",
          cod_amount: 2863.24,
          shipment_number: "1055146389563",
        },
        {
          order_number: 103,
          partner_name: "ЖОКЕР ЕНТ. ЕООД",
          total_amount: 229.99,
          type: "standard",
          cod_amount: null,
          shipment_number: "1055146425704",
        },
      ],
      outstanding: { totalRemaining: 0, totalCount: 0, top10: [] },
      topProducts: [],
      outputPath,
    });
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.statSync(outputPath).size).toBeGreaterThan(700);
  });
});
