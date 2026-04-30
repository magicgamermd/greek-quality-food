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

function fmtEur(v: number | string): string {
  return formatEurAmount(v) + " €";
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
          fmtEur(o.total_amount),
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
        `Общо: ${totalCount} поръчки     ${fmtEur(totalSum)}`,
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
          `   ${STATUS_LABEL_BG[s.status] ?? s.status}: ${s.count} бр.    ${fmtEur(s.sum)}`,
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
      `Активни:    ${inv.active.count}     ${fmtEur(inv.active.gross)}  (нето: ${fmtEur(inv.active.net)} + ДДС: ${fmtEur(inv.active.vat)})`,
      L,
      doc.y,
    );
    doc.text(
      `Сторнирани: ${inv.credit_noted.count}     ${fmtEur(inv.credit_noted.sum)}`,
      L,
      doc.y,
    );
    doc.text(
      `Анулирани:  ${inv.cancelled.count}     ${fmtEur(inv.cancelled.sum)}`,
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
          `   ${PAYMENT_LABEL_BG[m.method] ?? m.method}: ${m.count} фактури    ${fmtEur(m.sum)}`,
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
          `   ${PAYMENT_LABEL_BG[m.method] ?? m.method}: ${fmtEur(m.sum)}`,
          L,
          doc.y,
        );
      }
      doc.moveDown(0.2);
      doc
        .font("MainBold")
        .text(`   Общо: ${fmtEur(data.payments.total)}`, L, doc.y);
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
        `   Наложен платеж: ${codCount}  (сума: ${fmtEur(codSum)})`,
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
          fmtEur(s.total_amount),
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
      `Общ остатък: ${fmtEur(data.outstanding.totalRemaining)}  (${data.outstanding.totalCount} фактури)`,
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
          fmtEur(r.gross),
          fmtEur(r.paid),
          fmtEur(r.remaining),
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
          `${idx + 1}. ${p.name}${p.sku ? `  [${p.sku}]` : ""}    ${p.qty} бр.    ${fmtEur(p.total)}`,
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
