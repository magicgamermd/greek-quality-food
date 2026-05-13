// ====================================================================
// МЕСЕЧЕН ОТЧЕТ (Monthly Report) PDF
// --------------------------------------------------------------------
// Generates an A4 portrait PDF summarising the month's activity:
//   1) KPI strip — общо плащания, в брой, по банка, ПОС, получен COD
//   2) Оборот по дни (per-day breakdown table)
//   3) Поръчки по статус (агрегиран ред)
//   4) Фактури — активни / кредитирани / анулирани + by method
//   5) Замени — брой + нетна разлика (без per-row, че за месец става
//      огромна таблица; кешъра отива в дневния за подробност)
//   6) Топ 5 партньори по оборот
//   7) Топ 10 продукти по количество
//   8) Неплатени фактури snapshot към края на месеца
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
  awaiting_stock: "Чака стока",
};

const PAYMENT_LABEL_BG: Record<string, string> = {
  cash: "В брой",
  bank: "Банков превод",
  cod: "Наложен платеж",
  pos: "ПОС",
};

const MONTH_NAMES_BG = [
  "януари",
  "февруари",
  "март",
  "април",
  "май",
  "юни",
  "юли",
  "август",
  "септември",
  "октомври",
  "ноември",
  "декември",
];

export interface MonthlyReportData {
  month: string; // ISO yyyy-mm
  generatedBy: string;
  company: { name: string };
  // Aggregate KPIs (already summed for the month)
  payments: {
    byMethod: Array<{ method: string; count: number; sum: number }>;
    total: number; // sum across all methods (cash+bank+pos+cod)
  };
  // Per-day breakdown — every day of the month has a row, even if 0.
  dailyBreakdown: Array<{
    day: number; // 1..31
    orderCount: number; // non-cancelled
    grossTotal: number; // sum of total_amount (signed for replacements)
    paid: number;
    unpaid: number;
  }>;
  ordersSummaryByStatus: Array<{
    status: string;
    count: number;
    sum: number;
  }>;
  invoices: {
    active: { count: number; net: number; vat: number; gross: number };
    creditNoted: { count: number; sum: number };
    cancelled: { count: number; sum: number };
    byPaymentMethod: Array<{ method: string; count: number; sum: number }>;
  };
  replacements: {
    count: number;
    netDiff: number; // signed sum of give − return
  };
  topPartners: Array<{
    partner_name: string;
    order_count: number;
    total: number;
  }>;
  topProducts: Array<{
    name: string;
    sku: string | null;
    qty: number;
    total: number;
  }>;
  outstanding: {
    totalCount: number;
    totalRemaining: number;
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
  // Неплатени стокови разписки (orders без фактура) — snapshot към края на
  // месеца. Същата логика както outstanding фактурите, но за orders, които
  // нямат `invoice_id`. Replacement orders с total < 0 (refund) се отчитат
  // спрямо |total| (auto-вкараният refund payment row покрива разликата).
  outstandingRazpiski: {
    totalCount: number;
    totalRemaining: number;
    top10: Array<{
      order_number: number | string;
      order_date: string;
      partner_name: string;
      gross: number; // signed if replacement
      paid: number;
      remaining: number;
      days_overdue: number;
      is_replacement: boolean;
    }>;
  };
  outputPath: string;
}

function fmtEur(v: number | string): string {
  return formatEurAmount(v) + " €";
}

function fmtSignedEur(v: number): string {
  if (Math.abs(v) < 0.005) return "0,00 €";
  return (v > 0 ? "+" : "") + formatEurAmount(v) + " €";
}

function formatMonthBg(iso: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const year = m[1];
  const monthIdx = parseInt(m[2], 10) - 1;
  const name = MONTH_NAMES_BG[monthIdx] ?? m[2];
  return `${name} ${year}`;
}

function formatInvoiceDateBg(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso;
  const [y, mm, d] = iso.slice(0, 10).split("-");
  return `${d}.${mm}.${y}`;
}

// Pixel-base truncation. pdfkit-s ellipsis опцията работи надеждно само
// при многоредови блокове; при едноредова cell с lineBreak: false и
// kirillic input (Roboto cyrillic glyphs са ~5.7pt при fontSize 9, vs
// 4.5pt за латиница), char-base truncate (.slice(0, N) + "…") често
// прелива колоната и redo-вете се припокриват. Binary-search-ваме до
// най-дългия prefix който се побира + ellipsis.
function truncateToWidth(
  doc: PDFKit.PDFDocument,
  text: string,
  maxWidth: number,
): string {
  if (!text) return text;
  if (doc.widthOfString(text) <= maxWidth) return text;
  const ellipsis = "…";
  const ellipsisW = doc.widthOfString(ellipsis);
  if (ellipsisW > maxWidth) return ""; // нямаме място дори за "…"
  let lo = 0;
  let hi = text.length;
  // Invariant: text.slice(0, lo) + … fits; text.slice(0, hi) + … may not.
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (doc.widthOfString(text.slice(0, mid)) + ellipsisW <= maxWidth) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return text.slice(0, lo).trimEnd() + ellipsis;
}

export async function generateMonthlyReportPdf(
  data: MonthlyReportData,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 40, bottom: 40, left: 40, right: 40 },
    });
    const stream = fs.createWriteStream(data.outputPath);
    doc.pipe(stream);
    stream.on("finish", () => resolve());
    stream.on("error", reject);

    doc.registerFont("Main", FONT_REGULAR);
    doc.registerFont("MainBold", FONT_BOLD);

    const L = 40;
    const pageW = doc.page.width - 80;

    // ── Header ───────────────────────────────────────────
    doc.font("MainBold").fontSize(16).fillColor("#0f172a");
    doc.text("Greek Quality Food — Месечен отчет на плащания", L, doc.y, {
      width: pageW,
      align: "left",
    });
    doc.moveDown(0.15);
    doc.font("Main").fontSize(9.5).fillColor("#64748b");
    doc.text(`За месец · ${formatMonthBg(data.month)}`, L, doc.y, {
      width: pageW,
      align: "left",
    });
    doc.fillColor("#0f172a");
    doc.moveDown(0.8);

    // ── KPI strip ────────────────────────────────────────
    // 5 равноширочни карти: общо плащания · в брой · по банка · ПОС ·
    // получен COD (наложен платеж който вече е в касата от куриерите).
    const cashSum = data.payments.byMethod
      .filter((m) => m.method === "cash")
      .reduce((s, m) => s + m.sum, 0);
    const bankSum = data.payments.byMethod
      .filter((m) => m.method === "bank")
      .reduce((s, m) => s + m.sum, 0);
    const posSum = data.payments.byMethod
      .filter((m) => m.method === "pos")
      .reduce((s, m) => s + m.sum, 0);
    const codSum = data.payments.byMethod
      .filter((m) => m.method === "cod")
      .reduce((s, m) => s + m.sum, 0);

    const kpiCards: Array<{ label: string; value: string; color: string }> = [
      {
        label: "Получени плащания",
        value: fmtEur(data.payments.total),
        color: "#10b981",
      },
      { label: "В брой", value: fmtEur(cashSum), color: "#0f172a" },
      { label: "По банка", value: fmtEur(bankSum), color: "#0f172a" },
      { label: "ПОС", value: fmtEur(posSum), color: "#7c3aed" },
      {
        label: "Получен COD",
        value: fmtEur(codSum),
        color: "#0ea5e9",
      },
    ];

    const kpiGap = 8;
    const kpiW = (pageW - kpiGap * (kpiCards.length - 1)) / kpiCards.length;
    const kpiH = 50;
    let kpiX = L;
    const kpiY = doc.y;
    for (const card of kpiCards) {
      doc
        .roundedRect(kpiX, kpiY, kpiW, kpiH, 4)
        .lineWidth(0.6)
        .strokeColor("#e2e8f0")
        .stroke();
      doc.font("Main").fontSize(8).fillColor("#64748b");
      doc.text(card.label, kpiX + 8, kpiY + 8, {
        width: kpiW - 16,
        align: "left",
      });
      doc.font("MainBold").fontSize(13).fillColor(card.color);
      doc.text(card.value, kpiX + 8, kpiY + 24, {
        width: kpiW - 16,
        align: "left",
      });
      kpiX += kpiW + kpiGap;
    }
    doc.fillColor("#0f172a");
    doc.y = kpiY + kpiH + 14;

    // ── Helpers ──────────────────────────────────────────
    const sectionHeader = (title: string) => {
      // Page-break check — ако заглавието и поне един ред под него няма да
      // се поберат на страницата, започваме нова. Без това заглавието виси
      // самичко в края на страницата.
      if (doc.y + 40 > doc.page.height - 60) {
        doc.addPage();
        doc.y = 40;
      }
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

    const ensureSpace = (rowH: number) => {
      if (doc.y + rowH > doc.page.height - 60) {
        doc.addPage();
        doc.y = 40;
      }
    };

    // ── Раздел 1: Оборот по дни ──────────────────────────
    sectionHeader("ОБОРОТ ПО ДНИ");
    if (data.dailyBreakdown.length === 0) {
      doc.fillColor("#64748b").text("Няма данни за този месец.", L, doc.y);
      doc.fillColor("#0f172a");
      doc.moveDown(0.6);
    } else {
      const cols = [
        { header: "Ден", w: 40, align: "left" as const },
        { header: "Поръчки", w: 70, align: "right" as const },
        { header: "Оборот", w: 110, align: "right" as const },
        { header: "Платено", w: 110, align: "right" as const },
        {
          header: "Неплатено",
          w: pageW - 40 - 70 - 110 - 110,
          align: "right" as const,
        },
      ];
      const rowH = 14;
      let cx = L;
      const headerY = doc.y;
      doc.font("MainBold").fontSize(8).fillColor("#475569");
      for (const c of cols) {
        doc.text(c.header, cx + 2, headerY, {
          width: c.w - 4,
          align: c.align,
          lineBreak: false,
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

      // Per-day rows. Дни без поръчки оставяме сиви, за да се вижда
      // визуално че периодът е пълен (месецът има 31 дни, не 12).
      doc.font("Main").fontSize(8.5);
      for (const row of data.dailyBreakdown) {
        ensureSpace(rowH);
        const rowY = doc.y;
        const empty = row.orderCount === 0;
        doc.fillColor(empty ? "#94a3b8" : "#0f172a");
        const cells = [
          String(row.day).padStart(2, "0"),
          empty ? "—" : String(row.orderCount),
          empty ? "—" : fmtEur(row.grossTotal),
          empty ? "—" : fmtEur(row.paid),
          empty ? "—" : fmtEur(row.unpaid),
        ];
        cx = L;
        cells.forEach((val, i) => {
          doc.text(val, cx + 2, rowY, {
            width: cols[i].w - 4,
            align: cols[i].align,
            lineBreak: false,
            ellipsis: true,
          });
          cx += cols[i].w;
        });
        doc.y = rowY + rowH;
      }
      doc
        .moveTo(L, doc.y)
        .lineTo(L + pageW, doc.y)
        .lineWidth(0.5)
        .strokeColor("#0f172a")
        .stroke();
      doc.moveDown(0.2);

      // Totals footer
      const totalOrders = data.dailyBreakdown.reduce(
        (s, r) => s + r.orderCount,
        0,
      );
      const totalGross = data.dailyBreakdown.reduce(
        (s, r) => s + r.grossTotal,
        0,
      );
      const totalPaid = data.dailyBreakdown.reduce((s, r) => s + r.paid, 0);
      const totalUnpaid = data.dailyBreakdown.reduce((s, r) => s + r.unpaid, 0);
      const footerY = doc.y;
      cx = L;
      const footerCells = [
        "Общо",
        String(totalOrders),
        fmtEur(totalGross),
        fmtEur(totalPaid),
        fmtEur(totalUnpaid),
      ];
      doc.font("MainBold").fontSize(9).fillColor("#0f172a");
      footerCells.forEach((val, i) => {
        doc.text(val, cx + 2, footerY, {
          width: cols[i].w - 4,
          align: cols[i].align,
          lineBreak: false,
        });
        cx += cols[i].w;
      });
      doc.y = footerY + 14;
      doc.font("Main").fontSize(9);
      doc.moveDown(0.6);
    }

    // ── Раздел 2: Поръчки по статус ──────────────────────
    sectionHeader("ПОРЪЧКИ ПО СТАТУС");
    if (data.ordersSummaryByStatus.length === 0) {
      doc.fillColor("#64748b").text("—", L, doc.y);
      doc.fillColor("#0f172a");
    } else {
      const cols = [
        { header: "Статус", w: 200, align: "left" as const },
        { header: "Брой", w: 100, align: "right" as const },
        { header: "Сума", w: pageW - 200 - 100, align: "right" as const },
      ];
      const rowH = 14;
      const headerY = doc.y;
      let cx = L;
      doc.font("MainBold").fontSize(8).fillColor("#475569");
      for (const c of cols) {
        doc.text(c.header, cx + 2, headerY, {
          width: c.w - 4,
          align: c.align,
          lineBreak: false,
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

      doc.font("Main").fontSize(9).fillColor("#0f172a");
      for (const r of data.ordersSummaryByStatus) {
        ensureSpace(rowH);
        const rowY = doc.y;
        const cells = [
          STATUS_LABEL_BG[r.status] ?? r.status,
          String(r.count),
          fmtEur(r.sum),
        ];
        cx = L;
        cells.forEach((val, i) => {
          doc.text(val, cx + 2, rowY, {
            width: cols[i].w - 4,
            align: cols[i].align,
            lineBreak: false,
          });
          cx += cols[i].w;
        });
        doc.y = rowY + rowH;
      }
    }
    doc.moveDown(0.6);

    // ── Раздел 3: Фактури за месеца ─────────────────────
    sectionHeader("ФАКТУРИ ЗА МЕСЕЦА");
    {
      const inv = data.invoices;
      doc.font("Main").fontSize(9).fillColor("#0f172a");
      const lines = [
        `Активни: ${inv.active.count} · нето ${fmtEur(inv.active.net)} · ДДС ${fmtEur(inv.active.vat)} · бруто ${fmtEur(inv.active.gross)}`,
        `Кредитирани: ${inv.creditNoted.count} · ${fmtEur(inv.creditNoted.sum)}`,
        `Анулирани: ${inv.cancelled.count} · ${fmtEur(inv.cancelled.sum)}`,
      ];
      for (const line of lines) {
        ensureSpace(13);
        doc.text(line, L, doc.y, { width: pageW });
        doc.moveDown(0.15);
      }
      if (inv.byPaymentMethod.length > 0) {
        doc.moveDown(0.2);
        doc.fillColor("#475569").font("MainBold").fontSize(8.5);
        doc.text("По начин на плащане:", L, doc.y, { width: pageW });
        doc.font("Main").fontSize(9).fillColor("#0f172a");
        for (const m of inv.byPaymentMethod) {
          ensureSpace(13);
          const label = PAYMENT_LABEL_BG[m.method] ?? m.method;
          doc.text(`  ${label}: ${m.count} бр. · ${fmtEur(m.sum)}`, L, doc.y, {
            width: pageW,
          });
          doc.moveDown(0.1);
        }
      }
    }
    doc.moveDown(0.6);

    // ── Раздел 4: Замени ────────────────────────────────
    sectionHeader("ЗАМЕНИ");
    {
      doc.font("Main").fontSize(9).fillColor("#0f172a");
      ensureSpace(14);
      doc.text(`Брой замени: ${data.replacements.count}`, L, doc.y, {
        width: pageW,
      });
      doc.moveDown(0.15);
      ensureSpace(14);
      doc.text("Нетна разлика: ", L, doc.y, {
        width: 120,
        continued: true,
      });
      doc
        .font("MainBold")
        .fillColor(data.replacements.netDiff < 0 ? "#dc2626" : "#0f172a");
      doc.text(fmtSignedEur(data.replacements.netDiff));
      doc.font("Main").fillColor("#0f172a");
      if (data.replacements.count > 0) {
        doc.moveDown(0.15);
        doc.fillColor("#64748b").fontSize(8);
        doc.text(
          "За подробен списък на замените виж дневния отчет на конкретния ден.",
          L,
          doc.y,
          { width: pageW },
        );
        doc.fillColor("#0f172a").fontSize(9);
      }
    }
    doc.moveDown(0.6);

    // ── Раздел 5: Топ 5 партньори ───────────────────────
    sectionHeader("ТОП 5 ПАРТНЬОРИ ПО ОБОРОТ");
    if (data.topPartners.length === 0) {
      doc.fillColor("#64748b").text("Няма данни.", L, doc.y);
      doc.fillColor("#0f172a");
    } else {
      const cols = [
        { header: "№", w: 22, align: "right" as const },
        {
          header: "Партньор",
          w: pageW - 22 - 90 - 110,
          align: "left" as const,
        },
        { header: "Поръчки", w: 90, align: "right" as const },
        { header: "Оборот", w: 110, align: "right" as const },
      ];
      const rowH = 14;
      const headerY = doc.y;
      let cx = L;
      doc.font("MainBold").fontSize(8).fillColor("#475569");
      for (const c of cols) {
        doc.text(c.header, cx + 2, headerY, {
          width: c.w - 4,
          align: c.align,
          lineBreak: false,
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

      doc.font("Main").fontSize(9).fillColor("#0f172a");
      data.topPartners.forEach((r, idx) => {
        ensureSpace(rowH);
        const rowY = doc.y;
        const cells = [
          String(idx + 1),
          truncateToWidth(doc, r.partner_name, cols[1].w - 4),
          String(r.order_count),
          fmtEur(r.total),
        ];
        cx = L;
        cells.forEach((val, i) => {
          doc.text(val, cx + 2, rowY, {
            width: cols[i].w - 4,
            height: rowH - 2,
            align: cols[i].align,
            lineBreak: false,
            ellipsis: true,
          });
          cx += cols[i].w;
        });
        doc.y = rowY + rowH;
      });
    }
    doc.moveDown(0.6);

    // ── Раздел 6: Топ 10 продукти ───────────────────────
    sectionHeader("ТОП 10 ПРОДУКТИ ПО КОЛИЧЕСТВО");
    if (data.topProducts.length === 0) {
      doc.fillColor("#64748b").text("Няма данни.", L, doc.y);
      doc.fillColor("#0f172a");
    } else {
      const cols = [
        { header: "№", w: 22, align: "right" as const },
        {
          header: "Продукт",
          w: pageW - 22 - 80 - 90 - 110,
          align: "left" as const,
        },
        { header: "SKU", w: 80, align: "left" as const },
        { header: "Количество", w: 90, align: "right" as const },
        { header: "Оборот", w: 110, align: "right" as const },
      ];
      const rowH = 14;
      const headerY = doc.y;
      let cx = L;
      doc.font("MainBold").fontSize(8).fillColor("#475569");
      for (const c of cols) {
        doc.text(c.header, cx + 2, headerY, {
          width: c.w - 4,
          align: c.align,
          lineBreak: false,
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

      doc.font("Main").fontSize(9).fillColor("#0f172a");
      data.topProducts.forEach((r, idx) => {
        ensureSpace(rowH);
        const rowY = doc.y;
        const cells = [
          String(idx + 1),
          truncateToWidth(doc, r.name, cols[1].w - 4),
          truncateToWidth(doc, r.sku ?? "—", cols[2].w - 4),
          formatEurAmount(r.qty).replace(",00", ""),
          fmtEur(r.total),
        ];
        cx = L;
        cells.forEach((val, i) => {
          doc.text(val, cx + 2, rowY, {
            width: cols[i].w - 4,
            height: rowH - 2,
            align: cols[i].align,
            lineBreak: false,
            ellipsis: true,
          });
          cx += cols[i].w;
        });
        doc.y = rowY + rowH;
      });
    }
    doc.moveDown(0.6);

    // ── Раздел 7: Неплатени фактури (snapshot) ──────────
    sectionHeader("НЕПЛАТЕНИ ФАКТУРИ (към края на месеца)");
    {
      doc.font("Main").fontSize(9).fillColor("#0f172a");
      ensureSpace(14);
      doc.text(
        `Общо неплатени: ${data.outstanding.totalCount} фактури · ${fmtEur(data.outstanding.totalRemaining)}`,
        L,
        doc.y,
        { width: pageW },
      );
      doc.moveDown(0.3);

      if (data.outstanding.top10.length > 0) {
        doc.font("MainBold").fontSize(8.5).fillColor("#475569");
        doc.text("Топ 10 най-просрочени:", L, doc.y, { width: pageW });
        doc.moveDown(0.15);
        const cols = [
          { header: "Фактура", w: 80, align: "left" as const },
          { header: "Дата", w: 65, align: "left" as const },
          {
            header: "Партньор",
            w: pageW - 80 - 65 - 80 - 80 - 60,
            align: "left" as const,
          },
          { header: "Бруто", w: 80, align: "right" as const },
          { header: "Остатък", w: 80, align: "right" as const },
          { header: "Дни", w: 60, align: "right" as const },
        ];
        const rowH = 14;
        const headerY = doc.y;
        let cx = L;
        doc.font("MainBold").fontSize(8).fillColor("#475569");
        for (const c of cols) {
          doc.text(c.header, cx + 2, headerY, {
            width: c.w - 4,
            align: c.align,
            lineBreak: false,
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

        doc.font("Main").fontSize(9).fillColor("#0f172a");
        data.outstanding.top10.forEach((r) => {
          ensureSpace(rowH);
          const rowY = doc.y;
          const cells = [
            truncateToWidth(doc, r.invoice_number, cols[0].w - 4),
            formatInvoiceDateBg(r.invoice_date),
            truncateToWidth(doc, r.partner_name, cols[2].w - 4),
            fmtEur(r.gross),
            fmtEur(r.remaining),
            String(r.days_overdue),
          ];
          cx = L;
          cells.forEach((val, i) => {
            doc.text(val, cx + 2, rowY, {
              width: cols[i].w - 4,
              height: rowH - 2,
              align: cols[i].align,
              lineBreak: false,
              ellipsis: true,
            });
            cx += cols[i].w;
          });
          doc.y = rowY + rowH;
        });
      }
    }
    doc.moveDown(0.6);

    // ── Раздел 8: Неплатени стокови разписки (snapshot) ──
    // Поръчки без фактура (invoice_id IS NULL), не cancelled, paid <
    // |total|. Замените са включени и маркирани с "З" префикс пред №.
    sectionHeader("НЕПЛАТЕНИ СТОКОВИ РАЗПИСКИ (към края на месеца)");
    {
      doc.font("Main").fontSize(9).fillColor("#0f172a");
      ensureSpace(14);
      doc.text(
        `Общо неплатени: ${data.outstandingRazpiski.totalCount} разписки · ${fmtEur(data.outstandingRazpiski.totalRemaining)}`,
        L,
        doc.y,
        { width: pageW },
      );
      doc.moveDown(0.3);

      if (data.outstandingRazpiski.top10.length > 0) {
        doc.font("MainBold").fontSize(8.5).fillColor("#475569");
        doc.text("Топ 10 най-просрочени:", L, doc.y, { width: pageW });
        doc.moveDown(0.15);
        const cols = [
          { header: "№ Поръчка", w: 80, align: "left" as const },
          { header: "Дата", w: 65, align: "left" as const },
          {
            header: "Партньор",
            w: pageW - 80 - 65 - 80 - 80 - 60,
            align: "left" as const,
          },
          { header: "Сума", w: 80, align: "right" as const },
          { header: "Остатък", w: 80, align: "right" as const },
          { header: "Дни", w: 60, align: "right" as const },
        ];
        const rowH = 14;
        const headerY = doc.y;
        let cx = L;
        doc.font("MainBold").fontSize(8).fillColor("#475569");
        for (const c of cols) {
          doc.text(c.header, cx + 2, headerY, {
            width: c.w - 4,
            align: c.align,
            lineBreak: false,
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

        doc.font("Main").fontSize(9).fillColor("#0f172a");
        data.outstandingRazpiski.top10.forEach((r) => {
          ensureSpace(rowH);
          const rowY = doc.y;
          // "З" префикс на № за да е визуално различим а замяната от
          // обикновена razpiska — без да добавяме отделна колона "Тип"
          // което би стеснило партньора.
          const orderLabel = r.is_replacement
            ? `З #${r.order_number}`
            : `#${r.order_number}`;
          const cells = [
            truncateToWidth(doc, orderLabel, cols[0].w - 4),
            formatInvoiceDateBg(r.order_date),
            truncateToWidth(doc, r.partner_name, cols[2].w - 4),
            // gross е signed за замени (refund показваме с "-").
            r.is_replacement ? fmtSignedEur(r.gross) : fmtEur(r.gross),
            fmtEur(r.remaining),
            String(r.days_overdue),
          ];
          cx = L;
          cells.forEach((val, i) => {
            doc.text(val, cx + 2, rowY, {
              width: cols[i].w - 4,
              height: rowH - 2,
              align: cols[i].align,
              lineBreak: false,
              ellipsis: true,
            });
            cx += cols[i].w;
          });
          doc.y = rowY + rowH;
        });
      }
    }

    // ── Footer ──────────────────────────────────────────
    doc.moveDown(1);
    if (doc.y + 20 > doc.page.height - 60) {
      doc.addPage();
      doc.y = 40;
    }
    doc.font("Main").fontSize(7.5).fillColor("#94a3b8");
    const now = new Date();
    const ts =
      String(now.getDate()).padStart(2, "0") +
      "." +
      String(now.getMonth() + 1).padStart(2, "0") +
      "." +
      now.getFullYear() +
      " " +
      String(now.getHours()).padStart(2, "0") +
      ":" +
      String(now.getMinutes()).padStart(2, "0");
    doc.text(`Отпечатано: ${ts}    Издал: ${data.generatedBy}`, L, doc.y, {
      width: pageW,
      align: "left",
    });

    doc.end();
  });
}
