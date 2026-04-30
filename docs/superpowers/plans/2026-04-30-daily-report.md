# Daily Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a printable end-of-day PDF (Дневен отчет) generated from the Dashboard. Single endpoint `GET /api/reports/daily-pdf?date=YYYY-MM-DD` aggregates orders + invoices + payments + Econt shipments + outstanding + top products and streams a PDF. New Dashboard button opens a date picker, downloads via authed blob fetch.

**Architecture:** New service `daily-report-pdf.ts` (pdfkit, mirrors `offer-pdf.ts`). New route plugin `routes/reports.ts` runs 6 aggregation queries, builds `DailyReportData`, calls the service, streams the result. Frontend gets a dialog on `Dashboard.tsx` that fetches the PDF as a blob (auth-aware) and opens it in a new tab. All amounts in EUR via existing `formatEurAmount`. Permission `REPORTS_VIEW` already exists in `lib/permissions.ts` (default: admin + accountant).

**Tech Stack:** Fastify + TypeScript + Zod + pdfkit + Vitest (backend); React + TanStack Query + shadcn/ui Dialog (frontend).

**Spec:** [docs/superpowers/specs/2026-04-30-daily-report-design.md](../specs/2026-04-30-daily-report-design.md)

**Branch:** `feature/MERTM-daily-report` from `main`.

---

## Pre-flight

```bash
git checkout main && git pull
git checkout -b feature/MERTM-daily-report
cd warehouse-backend && npx vitest run 2>&1 | tail -10   # baseline
cd ../warehouse-frontend && npx tsc --noEmit 2>&1 | tail -5
```

Expected: backend ~300+ tests passing (2-3 pre-existing failures in `payments-razpiska` / `negative-inventory` are unrelated and continue to fail throughout this batch — not regressions). Frontend type-check clean.

---

## File Structure

**Backend (create):**

- `warehouse-backend/src/services/daily-report-pdf.ts` — pdfkit PDF renderer. Pure function `generateDailyReportPdf(data, outputPath)`.
- `warehouse-backend/src/routes/reports.ts` — Fastify plugin exporting `reportsRoutes`. Single endpoint `GET /daily-pdf`.
- `warehouse-backend/src/__tests__/reports-daily.test.ts` — integration tests (403/400/happy/future-date).

**Backend (modify):**

- `warehouse-backend/src/index.ts` — register `reportsRoutes` under prefix `/reports`.
- `warehouse-backend/src/services/offer-pdf.ts` — bug fix: replace `fmtBGN` (лв.) with `formatEurAmount` (€).

**Frontend (modify):**

- `warehouse-frontend/src/pages/Dashboard.tsx` — add "Дневен отчет" button + date dialog + authed-blob download.

**No new files on frontend** — the dialog is a 30-line block inline; if a third caller appears later, extract.

---

## Task 1: PDF service — types + stub

**Why first:** Lock the data shape before the route knows what to assemble. Pure function with no DB access — easy to test.

**Files:**

- Create: `warehouse-backend/src/services/daily-report-pdf.ts`
- Create: `warehouse-backend/src/__tests__/daily-report-pdf.test.ts`

- [ ] **Step 1: Write the failing service test**

```typescript
// warehouse-backend/src/__tests__/daily-report-pdf.test.ts
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
      },
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
      payments: { byMethod: [], total: 0 },
      econtShipments: [],
      outstanding: { totalRemaining: 0, totalCount: 0, top10: [] },
      topProducts: [],
      outputPath,
    });
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.statSync(outputPath).size).toBeGreaterThan(500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd warehouse-backend && npx vitest run src/__tests__/daily-report-pdf.test.ts
```

Expected: FAIL because `../services/daily-report-pdf.js` doesn't exist.

- [ ] **Step 3: Create the service file**

`warehouse-backend/src/services/daily-report-pdf.ts`:

```typescript
// ====================================================================
// ДНЕВЕН ОТЧЕТ (Daily Report) PDF
// --------------------------------------------------------------------
// Generates an A4 portrait PDF summarizing the day's activity:
//   1) Orders list + summary by status
//   2) Invoices (issued today) + payment-method breakdown
//   3) Payments (received today) by method
//   4) Econt shipments (only if any)
//   5) Outstanding invoices snapshot at end-of-day
//   6) Top 5 products by quantity
// All amounts in EUR via formatEurAmount.
// ====================================================================
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { formatEurAmount } from "../utils/currency.js";

function getFontPath(filename: string): string {
  const candidates = [
    path.resolve(__dirname, "..", "fonts", filename),
    path.resolve(__dirname, "..", "..", "src", "fonts", filename),
    path.resolve(process.cwd(), "src", "fonts", filename),
    path.resolve(process.cwd(), "dist", "fonts", filename),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `Font not found: ${filename}. Checked: ${candidates.join(", ")}`,
  );
}

const FONT_REGULAR = getFontPath("Roboto-Regular.ttf");
const FONT_BOLD = getFontPath("Roboto-Bold.ttf");

const STATUS_LABEL_BG: Record<string, string> = {
  pending: "Чакаща",
  quoted: "Оферта",
  confirmed: "Потвърдена",
  processing: "В обработка",
  fulfilled: "Изпълнена",
  invoiced: "Фактурирана",
  cancelled: "Анулирана",
};

const PAYMENT_LABEL_BG: Record<string, string> = {
  cash: "В брой",
  bank: "Банков превод",
  cod: "Наложен платеж",
};

export interface DailyReportData {
  date: string; // ISO yyyy-mm-dd
  generatedBy: string; // email of issuing user
  company: { name: string };
  orders: Array<{
    order_number: number;
    partner_name: string;
    total_amount: number;
    status: string;
    payment_method: string | null;
    invoice_number: string | null;
    invoice_status: string | null;
  }>;
  ordersSummaryByStatus: Array<{
    status: string;
    count: number;
    sum: number;
  }>;
  invoices: {
    active: { count: number; net: number; vat: number; gross: number };
    credit_noted: { count: number; sum: number };
    cancelled: { count: number; sum: number };
    byPaymentMethod: Array<{ method: string; count: number; sum: number }>;
  };
  payments: {
    byMethod: Array<{ method: string; count: number; sum: number }>;
    total: number;
  };
  econtShipments: Array<{
    order_number: number;
    partner_name: string;
    total_amount: number;
    type: "cod" | "standard";
    cod_amount: number | null;
    shipment_number: string;
  }>;
  outstanding: {
    totalRemaining: number;
    totalCount: number;
    top10: Array<{
      invoice_number: string;
      invoice_date: string;
      partner_name: string;
      gross: number;
      paid: number;
      remaining: number;
      days_overdue: number;
    }>;
  };
  topProducts: Array<{
    name: string;
    sku: string | null;
    qty: number;
    total: number;
  }>;
  outputPath: string;
}

function formatDateBg(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso;
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

export async function generateDailyReportPdf(
  data: DailyReportData,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 40, bottom: 40, left: 40, right: 40 },
    });
    const stream = fs.createWriteStream(data.outputPath);
    doc.pipe(stream);

    doc.registerFont("Main", FONT_REGULAR);
    doc.registerFont("MainBold", FONT_BOLD);

    const L = 40;
    const pageW = doc.page.width - 80;

    // ── Header ───────────────────────────────────────────
    doc.font("MainBold").fontSize(16).fillColor("#0f172a");
    doc.text("МЕРТ-М — Дневен отчет", L, doc.y, {
      width: pageW,
      align: "center",
    });
    doc.moveDown(0.2);
    doc.font("Main").fontSize(10).fillColor("#475569");
    doc.text(formatDateBg(data.date), L, doc.y, {
      width: pageW,
      align: "center",
    });
    doc.moveDown(0.1);
    doc
      .fontSize(8)
      .text(
        `Генериран от: ${data.generatedBy} на ${formatDateBg(new Date().toISOString().slice(0, 10))} ${new Date().toTimeString().slice(0, 5)}`,
        L,
        doc.y,
        { width: pageW, align: "center" },
      );
    doc.fillColor("#0f172a");
    doc.moveDown(0.8);

    const sectionHeader = (title: string) => {
      doc.font("MainBold").fontSize(11).fillColor("#0f172a");
      doc
        .moveTo(L, doc.y)
        .lineTo(L + pageW, doc.y)
        .lineWidth(0.5)
        .strokeColor("#94a3b8")
        .stroke();
      doc.moveDown(0.2);
      doc.text(title, L, doc.y, { width: pageW });
      doc.moveDown(0.3);
      doc.font("Main").fontSize(9).fillColor("#0f172a");
    };

    // ── Раздел 1: Поръчки днес ───────────────────────────
    sectionHeader("ПОРЪЧКИ ДНЕС");
    if (data.orders.length === 0) {
      doc.fillColor("#64748b").text("Няма поръчки за този ден.", L, doc.y);
      doc.fillColor("#0f172a").moveDown(0.6);
    } else {
      const cols = [
        { header: "№", w: 35, align: "right" as const },
        {
          header: "Партньор",
          w: pageW - 35 - 70 - 75 - 65 - 75,
          align: "left" as const,
        },
        { header: "Сума", w: 70, align: "right" as const },
        { header: "Статус", w: 75, align: "left" as const },
        { header: "Плащане", w: 65, align: "left" as const },
        { header: "Фактура", w: 75, align: "left" as const },
      ];
      const rowH = 14;
      let cx = L;
      const headerY = doc.y;
      doc.font("MainBold").fontSize(8).fillColor("#475569");
      for (const c of cols) {
        doc.text(c.header, cx + 2, headerY, {
          width: c.w - 4,
          align: c.align,
        });
        cx += c.w;
      }
      doc.y = headerY + rowH;
      doc
        .moveTo(L, doc.y - 2)
        .lineTo(L + pageW, doc.y - 2)
        .lineWidth(0.3)
        .strokeColor("#cbd5e1")
        .stroke();

      doc.font("Main").fontSize(8.5).fillColor("#0f172a");
      for (const o of data.orders) {
        const y = doc.y;
        // Auto-page-break: if we'd overflow the page, add a new page and
        // re-draw the section title only (table is consistent).
        if (y + rowH > doc.page.height - 60) {
          doc.addPage();
          doc.y = 40;
          sectionHeader("ПОРЪЧКИ ДНЕС (продължение)");
          cx = L;
          const hY = doc.y;
          doc.font("MainBold").fontSize(8).fillColor("#475569");
          for (const c of cols) {
            doc.text(c.header, cx + 2, hY, { width: c.w - 4, align: c.align });
            cx += c.w;
          }
          doc.y = hY + rowH;
          doc.font("Main").fontSize(8.5).fillColor("#0f172a");
        }
        const cells = [
          String(o.order_number),
          o.partner_name.length > 30
            ? o.partner_name.slice(0, 28) + "…"
            : o.partner_name,
          formatEurAmount(o.total_amount),
          STATUS_LABEL_BG[o.status] ?? o.status,
          o.payment_method
            ? (PAYMENT_LABEL_BG[o.payment_method] ?? o.payment_method)
            : "—",
          o.invoice_number ?? "—",
        ];
        cx = L;
        const rowY = doc.y;
        cells.forEach((val, i) => {
          doc.text(val, cx + 2, rowY, {
            width: cols[i].w - 4,
            align: cols[i].align,
          });
          cx += cols[i].w;
        });
        doc.y = rowY + rowH;
      }
      doc
        .moveTo(L, doc.y)
        .lineTo(L + pageW, doc.y)
        .lineWidth(0.3)
        .strokeColor("#cbd5e1")
        .stroke();
      doc.moveDown(0.3);

      const totalCount = data.orders.length;
      const totalSum = data.orders.reduce((s, o) => s + o.total_amount, 0);
      doc.font("MainBold").fontSize(9).fillColor("#0f172a");
      doc.text(
        `Общо: ${totalCount} поръчки     ${formatEurAmount(totalSum)}`,
        L,
        doc.y,
        { width: pageW, align: "right" },
      );
      doc.moveDown(0.4);
      doc.font("Main").fontSize(9).fillColor("#475569");
      doc.text("Обобщение по статус:", L, doc.y);
      for (const s of data.ordersSummaryByStatus) {
        if (s.count === 0) continue;
        doc.text(
          `   ${STATUS_LABEL_BG[s.status] ?? s.status}: ${s.count} бр.    ${formatEurAmount(s.sum)}`,
          L,
          doc.y,
        );
      }
      doc.fillColor("#0f172a").moveDown(0.6);
    }

    // ── Раздел 2: Фактури днес ───────────────────────────
    sectionHeader("ФАКТУРИ ДНЕС");
    const inv = data.invoices;
    doc.fontSize(9).fillColor("#0f172a");
    doc.text(
      `Активни:    ${inv.active.count}     ${formatEurAmount(inv.active.gross)}  (нето: ${formatEurAmount(inv.active.net)} + ДДС: ${formatEurAmount(inv.active.vat)})`,
      L,
      doc.y,
    );
    doc.text(
      `Сторнирани: ${inv.credit_noted.count}     ${formatEurAmount(inv.credit_noted.sum)}`,
      L,
      doc.y,
    );
    doc.text(
      `Анулирани:  ${inv.cancelled.count}     ${formatEurAmount(inv.cancelled.sum)}`,
      L,
      doc.y,
    );
    doc.moveDown(0.3);
    if (inv.byPaymentMethod.length > 0) {
      doc
        .fillColor("#475569")
        .text("По метод на плащане (само активни):", L, doc.y);
      for (const m of inv.byPaymentMethod) {
        doc.text(
          `   ${PAYMENT_LABEL_BG[m.method] ?? m.method}: ${m.count} фактури    ${formatEurAmount(m.sum)}`,
          L,
          doc.y,
        );
      }
    }
    doc.fillColor("#0f172a").moveDown(0.6);

    // ── Раздел 3: Постъпления ───────────────────────────
    sectionHeader("ПОСТЪПЛЕНИЯ ДНЕС (реално получени)");
    if (data.payments.byMethod.length === 0) {
      doc
        .fillColor("#64748b")
        .text("Няма записани плащания за този ден.", L, doc.y);
      doc.fillColor("#0f172a");
    } else {
      for (const m of data.payments.byMethod) {
        doc.text(
          `   ${PAYMENT_LABEL_BG[m.method] ?? m.method}: ${formatEurAmount(m.sum)}`,
          L,
          doc.y,
        );
      }
      doc.moveDown(0.2);
      doc
        .font("MainBold")
        .text(`   Общо: ${formatEurAmount(data.payments.total)}`, L, doc.y);
      doc.font("Main");
    }
    doc.moveDown(0.6);

    // ── Раздел 4: Еконт доставки (only if any) ───────────
    if (data.econtShipments.length > 0) {
      sectionHeader("ЕКОНТ ДОСТАВКИ");
      const codCount = data.econtShipments.filter(
        (s) => s.type === "cod",
      ).length;
      const codSum = data.econtShipments
        .filter((s) => s.type === "cod")
        .reduce((s, x) => s + (x.cod_amount ?? 0), 0);
      const stdCount = data.econtShipments.length - codCount;
      doc.text(
        `Общо товарителници днес: ${data.econtShipments.length}`,
        L,
        doc.y,
      );
      doc.text(
        `   Наложен платеж: ${codCount}  (сума: ${formatEurAmount(codSum)})`,
        L,
        doc.y,
      );
      doc.text(`   Обикновена (Еконт): ${stdCount}`, L, doc.y);
      doc.moveDown(0.3);
      const cols = [
        { header: "№", w: 35, align: "right" as const },
        {
          header: "Партньор",
          w: pageW - 35 - 70 - 75 - 130,
          align: "left" as const,
        },
        { header: "Сума", w: 70, align: "right" as const },
        { header: "Тип", w: 75, align: "left" as const },
        { header: "Т-ца №", w: 130, align: "left" as const },
      ];
      const headerY = doc.y;
      let cx = L;
      doc.font("MainBold").fontSize(8).fillColor("#475569");
      for (const c of cols) {
        doc.text(c.header, cx + 2, headerY, {
          width: c.w - 4,
          align: c.align,
        });
        cx += c.w;
      }
      doc.y = headerY + 14;
      doc.font("Main").fontSize(8.5).fillColor("#0f172a");
      for (const s of data.econtShipments) {
        const rowY = doc.y;
        const cells = [
          String(s.order_number),
          s.partner_name.length > 28
            ? s.partner_name.slice(0, 26) + "…"
            : s.partner_name,
          formatEurAmount(s.total_amount),
          s.type === "cod" ? "Наложен пл." : "Еконт",
          s.shipment_number,
        ];
        cx = L;
        cells.forEach((val, i) => {
          doc.text(val, cx + 2, rowY, {
            width: cols[i].w - 4,
            align: cols[i].align,
          });
          cx += cols[i].w;
        });
        doc.y = rowY + 14;
      }
      doc.moveDown(0.6);
    }

    // ── Раздел 5: Неплатени фактури ─────────────────────
    sectionHeader("НЕПЛАТЕНИ ФАКТУРИ (към края на деня)");
    doc.text(
      `Общ остатък: ${formatEurAmount(data.outstanding.totalRemaining)}  (${data.outstanding.totalCount} фактури)`,
      L,
      doc.y,
    );
    doc.moveDown(0.3);
    if (data.outstanding.top10.length > 0) {
      doc.fillColor("#475569").text("Top 10 най-стари:", L, doc.y);
      doc.fillColor("#0f172a");
      const cols = [
        { header: "№", w: 70, align: "left" as const },
        { header: "Дата", w: 60, align: "left" as const },
        {
          header: "Партньор",
          w: pageW - 70 - 60 - 70 - 70 - 70 - 30,
          align: "left" as const,
        },
        { header: "Сума", w: 70, align: "right" as const },
        { header: "Платено", w: 70, align: "right" as const },
        { header: "Остатък", w: 70, align: "right" as const },
        { header: "Дни", w: 30, align: "right" as const },
      ];
      const headerY = doc.y;
      let cx = L;
      doc.font("MainBold").fontSize(7.5).fillColor("#475569");
      for (const c of cols) {
        doc.text(c.header, cx + 2, headerY, {
          width: c.w - 4,
          align: c.align,
        });
        cx += c.w;
      }
      doc.y = headerY + 12;
      doc.font("Main").fontSize(8).fillColor("#0f172a");
      for (const r of data.outstanding.top10) {
        const rowY = doc.y;
        const cells = [
          r.invoice_number,
          formatDateBg(r.invoice_date),
          r.partner_name.length > 24
            ? r.partner_name.slice(0, 22) + "…"
            : r.partner_name,
          formatEurAmount(r.gross),
          formatEurAmount(r.paid),
          formatEurAmount(r.remaining),
          String(r.days_overdue),
        ];
        cx = L;
        cells.forEach((val, i) => {
          doc.text(val, cx + 2, rowY, {
            width: cols[i].w - 4,
            align: cols[i].align,
          });
          cx += cols[i].w;
        });
        doc.y = rowY + 12;
      }
    }
    doc.moveDown(0.6);

    // ── Раздел 6: Top 5 артикула ────────────────────────
    sectionHeader("TOP 5 АРТИКУЛА ЗА ДЕНЯ");
    if (data.topProducts.length === 0) {
      doc.fillColor("#64748b").text("Няма продадени артикули.", L, doc.y);
      doc.fillColor("#0f172a");
    } else {
      data.topProducts.forEach((p, idx) => {
        doc.text(
          `${idx + 1}. ${p.name}${p.sku ? `  [${p.sku}]` : ""}    ${p.qty} бр.    ${formatEurAmount(p.total)}`,
          L,
          doc.y,
          { width: pageW },
        );
      });
    }
    doc.moveDown(1);

    // ── Footer ──────────────────────────────────────────
    doc.font("Main").fontSize(8.5).fillColor("#475569");
    doc.text(
      "Изготвил: ____________________     Подпис: ____________________",
      L,
      doc.y,
      { width: pageW },
    );

    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", (err) => reject(err));
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd warehouse-backend && npx vitest run src/__tests__/daily-report-pdf.test.ts
```

Expected: 2/2 passing.

- [ ] **Step 5: Commit**

```bash
git add warehouse-backend/src/services/daily-report-pdf.ts warehouse-backend/src/__tests__/daily-report-pdf.test.ts
git commit -m "feat(reports): add generateDailyReportPdf service (6-section A4 PDF)"
```

---

## Task 2: Route plugin — date parsing + permission guard

**Files:**

- Create: `warehouse-backend/src/routes/reports.ts`

- [ ] **Step 1: Create the route file with the date schema**

```typescript
// warehouse-backend/src/routes/reports.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { query } from "../db.js";
import {
  PERMISSIONS,
  requirePermission,
  type Permission,
} from "../lib/permissions.js";
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
  requirePermission(PERMISSIONS.REPORTS_VIEW as Permission),
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

      // Aggregation queries — see Task 3 for the 6 SQL blocks
      const data: DailyReportData = await assembleDailyReportData(
        date,
        request,
      );

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

// Assembles DailyReportData by running the 6 aggregation queries.
// Defined in Task 3 — placeholder body returns empty data so this task
// commits compilable code. Task 3 replaces the body.
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
```

- [ ] **Step 2: Type-check**

```bash
cd warehouse-backend && npx tsc --noEmit 2>&1 | grep -E "^src/(routes/reports|services/daily-report)"
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add warehouse-backend/src/routes/reports.ts
git commit -m "feat(reports): add /reports/daily-pdf route (date parsing + permission guard)"
```

---

## Task 3: Aggregation queries

**Why separate task:** 6 SQL queries with non-trivial joins. Easier to review independently.

**Files:**

- Modify: `warehouse-backend/src/routes/reports.ts` — replace `assembleDailyReportData`

- [ ] **Step 1: Replace the placeholder body with the real aggregation**

Open `warehouse-backend/src/routes/reports.ts` and replace `assembleDailyReportData` with:

```typescript
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

  // 2) Orders summary by status (COUNT + SUM grouped by status)
  const { rows: orderSummaryRows } = await query(
    `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total_amount), 0)::numeric AS sum
       FROM orders WHERE DATE(order_date) = $1 GROUP BY status`,
    [date],
  );

  // 3) Invoices by status — active, credit-noted, cancelled
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

  // 6) Outstanding invoices snapshot at end of $date
  // Total remaining + count
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

  // Top 10 oldest unpaid invoices
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
```

- [ ] **Step 2: Type-check**

```bash
cd warehouse-backend && npx tsc --noEmit 2>&1 | grep -E "^src/routes/reports"
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add warehouse-backend/src/routes/reports.ts
git commit -m "feat(reports): wire 7 aggregation queries into assembleDailyReportData"
```

---

## Task 4: Register route plugin in `index.ts`

**Files:**

- Modify: `warehouse-backend/src/index.ts`

- [ ] **Step 1: Find the existing route registrations**

```bash
grep -n "app.register.*Routes" warehouse-backend/src/index.ts | head -10
```

Expected output: lines registering ordersRoutes / invoicesRoutes / etc. Note the file structure (likely a `await app.register(...)` block). Add the reports plugin near the others.

- [ ] **Step 2: Add the import + register call**

In `warehouse-backend/src/index.ts`, find the imports section and add:

```typescript
import reportsRoutes from "./routes/reports.js";
```

Find the route registration section (e.g., near `await app.register(invoiceRoutes, { prefix: "/invoices" });`) and add:

```typescript
await app.register(reportsRoutes, { prefix: "/reports" });
```

- [ ] **Step 3: Type-check + start the dev server briefly**

```bash
cd warehouse-backend && npx tsc --noEmit 2>&1 | grep -E "^src/index" | head -5
```

Expected: clean.

```bash
# Optional sanity: hit the health endpoint after restart to confirm no boot error.
# tsx watch should pick up the change automatically — check /tmp/mertm-backend.log
tail -20 /tmp/mertm-backend.log | grep -i "error\|fail" | head -5
```

Expected: no errors logged.

- [ ] **Step 4: Commit**

```bash
git add warehouse-backend/src/index.ts
git commit -m "feat(reports): register reportsRoutes under /reports prefix"
```

---

## Task 5: Integration tests for the route

**Files:**

- Create: `warehouse-backend/src/__tests__/reports-daily.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// warehouse-backend/src/__tests__/reports-daily.test.ts
//
// Integration tests for GET /reports/daily-pdf:
//   - admin happy path returns application/pdf
//   - non-permission user (warehouse) returns 403
//   - bad date format returns 400
//   - future date returns 200 (empty sections, still a valid PDF)
import Fastify, { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(async () => ({ rows: [] })),
  transaction: vi.fn(),
}));
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setex: vi.fn(async () => "OK"),
    del: vi.fn(async () => 0),
  })),
}));
vi.mock("../services/daily-report-pdf.js", () => ({
  generateDailyReportPdf: vi.fn(async (data: any) => {
    // Write a tiny stub PDF so fs.createReadStream has something to read.
    const fs = await import("node:fs");
    fs.writeFileSync(data.outputPath, "%PDF-1.4\n%test\n");
  }),
}));

import { query } from "../db.js";
import reportsRoutes from "../routes/reports.js";

const mockQuery = vi.mocked(query);

function rows<T>(list: T[]) {
  return { rows: list } as any;
}

async function buildApp(role = "admin"): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u1", email: "test@mertm.bg", role };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(reportsRoutes, { prefix: "/reports" });
  return app;
}

describe("GET /reports/daily-pdf", () => {
  let app: FastifyInstance;

  beforeEach(() => mockQuery.mockReset());
  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns 200 + application/pdf for admin with default date (today)", async () => {
    // 8 queries: company, orders list, orders summary, invoice stats, invoice
    // by method, payments by method, outstanding totals, outstanding top10,
    // top products. Stub them all with empty rows.
    mockQuery
      .mockResolvedValueOnce(rows([{ company_name: "Acme" }]))
      .mockResolvedValue(rows([]));

    app = await buildApp("admin");
    const res = await app.inject({ method: "GET", url: "/reports/daily-pdf" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
  });

  it("returns 200 for an explicit date in YYYY-MM-DD format", async () => {
    mockQuery
      .mockResolvedValueOnce(rows([{ company_name: "Acme" }]))
      .mockResolvedValue(rows([]));

    app = await buildApp("admin");
    const res = await app.inject({
      method: "GET",
      url: "/reports/daily-pdf?date=2026-04-30",
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 400 on invalid date format (/-separators)", async () => {
    app = await buildApp("admin");
    const res = await app.inject({
      method: "GET",
      url: "/reports/daily-pdf?date=2026/04/30",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/YYYY-MM-DD/);
  });

  it("returns 403 for warehouse role (no REPORTS_VIEW permission)", async () => {
    app = await buildApp("warehouse");
    const res = await app.inject({ method: "GET", url: "/reports/daily-pdf" });
    expect(res.statusCode).toBe(403);
  });

  it("returns 200 for a future date (sections are just empty)", async () => {
    mockQuery
      .mockResolvedValueOnce(rows([{ company_name: "Acme" }]))
      .mockResolvedValue(rows([]));

    app = await buildApp("admin");
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const res = await app.inject({
      method: "GET",
      url: `/reports/daily-pdf?date=${future}`,
    });
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run the tests — verify they pass**

```bash
cd warehouse-backend && npx vitest run src/__tests__/reports-daily.test.ts
```

Expected: 5/5 passing.

- [ ] **Step 3: Run the full backend test suite — no new regressions**

```bash
npx vitest run 2>&1 | tail -10
```

Expected: pre-existing failures (`payments-razpiska.test.ts`, occasionally `negative-inventory.test.ts`) only. Total passing should grow by 5 (this file) + 2 (Task 1's daily-report-pdf tests).

- [ ] **Step 4: Commit**

```bash
git add warehouse-backend/src/__tests__/reports-daily.test.ts
git commit -m "test(reports): integration tests for GET /reports/daily-pdf"
```

---

## Task 6: Frontend Dashboard button + dialog + download

**Files:**

- Modify: `warehouse-frontend/src/pages/Dashboard.tsx`

- [ ] **Step 1: Add state + imports**

Find the imports at the top of `Dashboard.tsx`. Add the following near the existing icon imports:

```typescript
import { Printer } from "lucide-react";
```

Find the existing imports for `useQuery` / `useNavigate` and add:

```typescript
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
```

(Skip imports that are already present — check first with grep.)

- [ ] **Step 2: Add component state inside the Dashboard component**

Inside the main `Dashboard` function, near the existing hooks:

```typescript
const [dailyReportOpen, setDailyReportOpen] = useState(false);
const [reportDate, setReportDate] = useState<string>(
  new Date().toISOString().slice(0, 10),
);

const downloadDailyReport = async () => {
  try {
    const res = await api.get(`/reports/daily-pdf?date=${reportDate}`, {
      responseType: "blob",
    });
    const blob = new Blob([res.data], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setDailyReportOpen(false);
  } catch (err: any) {
    toast.error(err?.response?.data?.error || "Грешка при сваляне на отчета");
  }
};
```

- [ ] **Step 3: Add the trigger button + dialog JSX**

In the Dashboard JSX, find the page header (typically `<h1>Tablo</h1>` or similar). Add the button next to the heading. The exact location depends on the existing layout — pick a spot in the top-right.

Sample placement (adapt to whatever the current Dashboard header is):

```tsx
<div className="flex items-center justify-between">
  <div>
    <h1 className="text-2xl font-bold text-gray-900">Табло</h1>
    {/* …existing description… */}
  </div>
  <Can permission={PERMISSIONS.REPORTS_VIEW}>
    <Button
      variant="outline"
      onClick={() => setDailyReportOpen(true)}
      title="Дневен отчет (PDF)"
    >
      <Printer className="h-4 w-4" />
      Дневен отчет
    </Button>
  </Can>
</div>
```

At the end of the Dashboard component (before the final `</div>`), add the dialog:

```tsx
<Dialog open={dailyReportOpen} onOpenChange={setDailyReportOpen}>
  <DialogContent className="max-w-sm">
    <DialogHeader>
      <DialogTitle>Дневен отчет</DialogTitle>
    </DialogHeader>
    <div className="py-2 space-y-1.5">
      <Label className="text-xs">За дата</Label>
      <Input
        type="date"
        value={reportDate}
        onChange={(e) => setReportDate(e.target.value)}
        max={new Date().toISOString().slice(0, 10)}
      />
    </div>
    <DialogFooter>
      <Button variant="outline" onClick={() => setDailyReportOpen(false)}>
        Отказ
      </Button>
      <Button
        onClick={() => void downloadDailyReport()}
        className="bg-[#f97316] hover:bg-[#ea580c]"
      >
        <Printer className="h-4 w-4" />
        Свали PDF
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- [ ] **Step 4: Type-check + lint**

```bash
cd warehouse-frontend && npx tsc --noEmit 2>&1 | grep -E "^src/pages/Dashboard" | head -5
```

Expected: clean.

- [ ] **Step 5: Manual smoke (optional, deferred to Task 8)**

If the dev stack is up: open `http://localhost:5174/`, verify the new button is in the top-right and clicking it opens the dialog. Real PDF download is verified in Task 8.

- [ ] **Step 6: Commit**

```bash
git add warehouse-frontend/src/pages/Dashboard.tsx
git commit -m "feat(dashboard): add 'Дневен отчет' button + date dialog + authed PDF download"
```

---

## Task 7: Bug fix — `offer-pdf.ts` currency

**Why now:** Same PR, small, related (the daily-report PDF uses `formatEurAmount`; the offer PDF is the only sibling that doesn't).

**Files:**

- Modify: `warehouse-backend/src/services/offer-pdf.ts`

- [ ] **Step 1: Inspect the current `fmtBGN` function and call sites**

```bash
grep -n "fmtBGN\|лв\\." warehouse-backend/src/services/offer-pdf.ts | head -20
```

Expected: the helper definition and 4–5 call sites in totals + items table.

- [ ] **Step 2: Replace the helper + import**

Open `warehouse-backend/src/services/offer-pdf.ts`. Add to the imports (right after `fs` / `path`):

```typescript
import { formatEurAmount } from "../utils/currency.js";
```

Remove the `fmtBGN` helper definition entirely:

```typescript
function fmtBGN(v: number): string {
  /* …delete this block… */
}
```

- [ ] **Step 3: Replace every `fmtBGN(...)` call with `formatEurAmount(...)`**

Use a global find-replace in the file: `fmtBGN(` → `formatEurAmount(`. There should be 4–5 occurrences. Verify:

```bash
grep -n "fmtBGN\|formatEurAmount" warehouse-backend/src/services/offer-pdf.ts
```

Expected: zero `fmtBGN` matches; 4–5 `formatEurAmount` matches.

- [ ] **Step 4: Run the existing offer-pdf tests (Batch E)**

```bash
cd warehouse-backend && npx vitest run src/__tests__/orders-quotation.test.ts
```

Expected: 7/7 still passing (the tests don't assert on currency text, so the change is transparent at the integration layer).

- [ ] **Step 5: Manual visual sanity (optional)**

If dev stack is up: open a quoted order's drawer, click "Регенерирай оферта", verify the PDF shows "€" instead of "лв.".

- [ ] **Step 6: Commit**

```bash
git add warehouse-backend/src/services/offer-pdf.ts
git commit -m "fix(offer-pdf): use formatEurAmount (€) instead of fmtBGN (лв.)"
```

---

## Task 8: End-to-end manual verification

**Files:** none — verification only.

- [ ] **Step 1: Boot the dev stack**

```bash
./scripts/start-mertm.sh --status
# If anything is down:
./scripts/start-mertm.sh
```

- [ ] **Step 2: Verify happy path**

1. Open `http://localhost:5174/` (logged in as admin).
2. Confirm the new "Дневен отчет" button is visible in the top-right of Табло.
3. Click it → dialog appears with today's date pre-filled, max = today.
4. Click "Свали PDF" → new tab opens with a PDF.
5. Verify the PDF header shows "МЕРТ-М — Дневен отчет" + today's date in dd.mm.yyyy format.
6. Scroll the PDF — confirm 6 sections present (or section 4 absent if no Econt waybills today).
7. Spot-check that all amounts show "€" suffix (no "лв.").

- [ ] **Step 3: Verify a past date**

In the dialog, change date to yesterday → "Свали PDF" → PDF should reflect yesterday's data.

- [ ] **Step 4: Verify permission gating (optional, requires non-admin login)**

Login as a warehouse-role user → Dashboard → "Дневен отчет" button should NOT be visible (gated by `<Can permission={REPORTS_VIEW}>`).

- [ ] **Step 5: Verify offer-pdf bug fix**

Open any quoted order → drawer → "Регенерирай оферта" → confirm PDF shows "€" instead of "лв.".

- [ ] **Step 6: No commit needed — verification only**

If anything fails, fix and re-commit. Done if all green.

---

## Task 9: Update STATUS.md

**Files:**

- Modify: `STATUS.md`

- [ ] **Step 1: Add the section**

Find the "## Done — Recent Sessions" header. Insert at the top (newest first):

```markdown
**Daily Report (Дневен отчет)** (2026-04-30, branch `feature/MERTM-daily-report` from main):

- New endpoint `GET /api/reports/daily-pdf?date=YYYY-MM-DD` returns a 6-section A4 PDF: Поръчки (per-order list + summary by status), Фактури (active/credit-noted/cancelled + per-payment-method breakdown), Постъпления (real cash inflow by method), Еконт доставки (only if any), Неплатени (top 10 oldest unpaid AS OF end-of-day), Top 5 артикула.
- New service `services/daily-report-pdf.ts` mirroring `offer-pdf.ts`; auto-page-break for long order lists.
- 7 aggregation SQL queries inside `assembleDailyReportData` — uses Batch B's `name_bg_snapshot` / `sku_snapshot` for top products.
- Permission `REPORTS_VIEW` already in registry (admin + accountant); warehouse blocked.
- Frontend Dashboard gets a "Дневен отчет" button (gated by `<Can permission={REPORTS_VIEW}>`) → date-picker dialog → authed blob fetch → opens PDF in new tab.
- All amounts in EUR via existing `formatEurAmount`.
- 5 integration tests (`reports-daily.test.ts`): admin happy default + explicit date, 400 invalid format, 403 warehouse, 200 future date.
- 2 unit tests (`daily-report-pdf.test.ts`): non-empty PDF for a populated day, valid PDF for an empty day.
- Bonus bug fix: `services/offer-pdf.ts` was using `fmtBGN` (" лв.") — switched to `formatEurAmount` (" €") to match the rest of the codebase.
- BE+FE type-check clean; new tests 7/7 passing.
- **Open item:** manual E2E (Task 8 in plan, 5-step script) deferred to post-merge user verification.
```

- [ ] **Step 2: Commit**

```bash
git add STATUS.md
git commit -m "docs(status): Daily Report — printable end-of-day PDF from Dashboard"
```

---

## Self-Review

**1. Spec coverage check:**

- §3 PDF layout (header + 6 sections) → Task 1 (service implements all 6 + auto-page-break)
- §4 endpoint + permission gate → Task 2 + Task 4
- §4 7 aggregation queries → Task 3
- §5 frontend Dashboard trigger → Task 6
- §6 tests → Tasks 1 (unit) + 5 (integration)
- §7 offer-pdf bug → Task 7

All spec sections covered.

**2. Placeholder scan:** No "TBD" / "TODO" / "implement appropriate X" — every step shows actual code or commands.

**3. Type consistency:** `DailyReportData` shape consistent across Task 1 (definition), Task 2 (placeholder), Task 3 (real assembly). Permission name `REPORTS_VIEW` consistent. SQL field aliases (active_count / active_net / etc.) match the JS destructuring in Task 3.

**4. Notes for the implementing engineer:**

- The plan says "pre-existing failures continue to fail throughout this batch — not regressions". Two known: `src/__tests__/payments-razpiska.test.ts` (math mismatch, last touched April 21) and occasionally `src/__tests__/negative-inventory.test.ts` (TypeScript error in helper signature). Both are unrelated and have been documented in earlier batches.
- `_migrations` table doesn't need a row — there's no SQL migration in this batch (everything reads existing tables).
- `data/reports/` directory under `process.cwd()` is created on demand. Ensure it's in `.gitignore` (`warehouse-backend/data/` is already excluded; verify with `git check-ignore -q warehouse-backend/data/`).
