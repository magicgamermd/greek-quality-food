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
    // Per-order rows for the cashier-style table — every order from
    // the day, including those without any recorded payment yet.
    // `payment_status` summarises the paid_amount/total_amount ratio.
    rows: Array<{
      order_number: number;
      partner_name: string;
      order_date: string; // ISO yyyy-mm-ddT…
      total_amount: number;
      paid_amount: number;
      payment_count: number;
      last_paid_at: string | null;
      method: string | null;
      invoice_number: string | null;
      invoice_status: string | null;
      payment_status: "paid" | "partial" | "unpaid" | "cancelled";
    }>;
  };
  // "Очакван наложен платеж" — Econt COD shipments sent today whose
  // money is still in transit with the courier. Tracked separately so
  // the cashier can see the gap between cash in hand and money owed.
  expectedCod: {
    count: number;
    total: number;
    rows: Array<{
      order_number: number;
      partner_name: string;
      shipped_at: string;
      shipment_number: string;
      cod_amount: number;
    }>;
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
    // Per the cashier-shared sample: a left-aligned title, a quiet
    // subtitle line under it, then a 3-card KPI strip summarising
    // the day's money flow.
    doc.font("MainBold").fontSize(16).fillColor("#0f172a");
    doc.text("МЕРТ-М — Дневен отчет на плащания", L, doc.y, {
      width: pageW,
      align: "left",
    });
    doc.moveDown(0.15);
    doc.font("Main").fontSize(9.5).fillColor("#64748b");
    doc.text(`По разписки · ${formatDateBg(data.date)}`, L, doc.y, {
      width: pageW,
      align: "left",
    });
    doc.fillColor("#0f172a");
    doc.moveDown(0.8);

    // ── KPI strip ────────────────────────────────────────
    // Four equally-sized cards: Получени общо · В брой · По банка/Карта
    // · Наложен платеж (очакван). The last card is the new addition
    // requested by МЕРТ-М — money already shipped via Econt that's
    // still in transit with the courier.
    const cashSum = data.payments.byMethod
      .filter((m) => m.method === "cash")
      .reduce((s, m) => s + m.sum, 0);
    const bankSum = data.payments.byMethod
      .filter((m) => m.method === "bank" || m.method === "card")
      .reduce((s, m) => s + m.sum, 0);

    const kpiCards: Array<{
      label: string;
      value: string;
      color: string;
    }> = [
      {
        label: "Получени плащания",
        value: fmtEur(data.payments.total),
        color: "#10b981", // emerald
      },
      { label: "В брой", value: fmtEur(cashSum), color: "#0f172a" },
      {
        label: "По банка / Карта",
        value: fmtEur(bankSum),
        color: "#0f172a",
      },
      {
        label: "Наложен платеж (очакван)",
        value: fmtEur(data.expectedCod.total),
        color: "#f59e0b", // amber — money in transit, not yet in the till
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

    // ── Раздел 3: Поръчки + плащания (детайлна таблица) ────
    sectionHeader("ПОРЪЧКИ И ПЛАЩАНИЯ ДНЕС");
    if (data.payments.rows.length === 0) {
      doc.fillColor("#64748b").text("Няма поръчки за този ден.", L, doc.y);
      doc.fillColor("#0f172a");
    } else {
      // Per-order table — every order from the day, regardless of
      // payment state. Status column tells the cashier which orders
      // are paid in full / partial / unpaid / cancelled. The bottom
      // summary still totals only the actual cash that hit the till
      // (KPI cards drive that, computed from `payments.byMethod`).
      const cols = [
        { header: "№", w: 22, align: "right" as const },
        { header: "Поръчка", w: 55, align: "left" as const },
        {
          header: "Партньор",
          w: pageW - 22 - 55 - 65 - 70 - 65 - 65 - 70,
          align: "left" as const,
        },
        { header: "Дата", w: 65, align: "left" as const },
        { header: "Начин", w: 70, align: "left" as const },
        { header: "Сума", w: 65, align: "right" as const },
        { header: "Платено", w: 65, align: "right" as const },
        { header: "Статус", w: 70, align: "left" as const },
      ];
      const rowH = 14;
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
      doc.y = headerY + rowH;
      doc
        .moveTo(L, doc.y - 2)
        .lineTo(L + pageW, doc.y - 2)
        .lineWidth(0.3)
        .strokeColor("#cbd5e1")
        .stroke();

      const STATUS_LABEL: Record<string, string> = {
        paid: "Платена",
        partial: "Частично",
        unpaid: "Неплатена",
        cancelled: "Анулирана",
      };
      const STATUS_COLOR: Record<string, string> = {
        paid: "#16a34a", // green
        partial: "#f59e0b", // amber
        unpaid: "#64748b", // slate
        cancelled: "#dc2626", // red
      };

      doc.font("Main").fontSize(8.5).fillColor("#0f172a");
      data.payments.rows.forEach((r, idx) => {
        if (doc.y + rowH > doc.page.height - 60) {
          doc.addPage();
          doc.y = 40;
        }
        const rowY = doc.y;
        // order_date arrives as ISO; slice(0,10) gives yyyy-mm-dd which
        // formatDateBg converts to dd.mm.yyyy.
        const dateStr = formatDateBg(r.order_date.slice(0, 10));
        const isCancelled = r.payment_status === "cancelled";
        const cells = [
          String(idx + 1),
          `#${r.order_number}`,
          r.partner_name.length > 26
            ? r.partner_name.slice(0, 24) + "…"
            : r.partner_name,
          dateStr,
          r.method ? (PAYMENT_LABEL_BG[r.method] ?? r.method) : "—",
          fmtEur(r.total_amount),
          r.paid_amount > 0 ? fmtEur(r.paid_amount) : "—",
          STATUS_LABEL[r.payment_status] ?? r.payment_status,
        ];
        cx = L;
        cells.forEach((val, i) => {
          // Last column (Статус) gets the per-status color so the
          // cashier can scan the column visually. Cancelled rows
          // additionally paint the order # cell red.
          if (i === cols.length - 1) {
            doc.fillColor(STATUS_COLOR[r.payment_status] ?? "#0f172a");
            doc.font("MainBold");
          } else if (isCancelled && i === 1) {
            doc.fillColor("#dc2626");
          }
          doc.text(val, cx + 2, rowY, {
            width: cols[i].w - 4,
            align: cols[i].align,
          });
          if (i === cols.length - 1) {
            doc.fillColor("#0f172a").font("Main");
          } else if (isCancelled && i === 1) {
            doc.fillColor("#0f172a");
          }
          cx += cols[i].w;
        });
        doc.y = rowY + rowH;
      });
      doc
        .moveTo(L, doc.y)
        .lineTo(L + pageW, doc.y)
        .lineWidth(0.3)
        .strokeColor("#cbd5e1")
        .stroke();
      doc.moveDown(0.4);

      // Footer summary block, right-aligned, three rows.
      const summaryX = L + pageW - 220;
      doc.font("Main").fontSize(9).fillColor("#0f172a");
      doc.text("В брой:", summaryX, doc.y, { width: 130, align: "right" });
      doc.font("MainBold").text(fmtEur(cashSum), summaryX + 130, doc.y - 11, {
        width: 90,
        align: "right",
      });
      doc.font("Main").text("По банка / Карта:", summaryX, doc.y, {
        width: 130,
        align: "right",
      });
      doc.font("MainBold").text(fmtEur(bankSum), summaryX + 130, doc.y - 11, {
        width: 90,
        align: "right",
      });
      doc
        .moveTo(summaryX + 70, doc.y - 1)
        .lineTo(summaryX + 220, doc.y - 1)
        .lineWidth(0.4)
        .strokeColor("#94a3b8")
        .stroke();
      doc
        .font("MainBold")
        .fontSize(10)
        .text("Общо:", summaryX, doc.y, { width: 130, align: "right" });
      doc
        .font("MainBold")
        .text(fmtEur(data.payments.total), summaryX + 130, doc.y - 12, {
          width: 90,
          align: "right",
        });
      doc.font("Main").fontSize(9).fillColor("#0f172a");
    }
    doc.moveDown(0.8);

    // ── Раздел 3b: Очакван наложен платеж ───────────────
    // Econt COD shipments dispatched today whose money is still in
    // transit with the courier — surfaced as a separate table so the
    // cashier can see what's expected from couriers vs what hit the
    // till today.
    if (data.expectedCod.rows.length > 0) {
      sectionHeader("ОЧАКВАН НАЛОЖЕН ПЛАТЕЖ (товарителници)");
      doc.fontSize(9).fillColor("#475569");
      doc.text(
        `Изпратени днес товарителници с наложен платеж: ${data.expectedCod.count}     Очаквана сума: ${fmtEur(data.expectedCod.total)}`,
        L,
        doc.y,
      );
      doc.moveDown(0.3);

      const cols = [
        { header: "№", w: 22, align: "right" as const },
        { header: "Поръчка", w: 60, align: "left" as const },
        {
          header: "Партньор",
          w: pageW - 22 - 60 - 130 - 75,
          align: "left" as const,
        },
        { header: "Товарителница", w: 130, align: "left" as const },
        { header: "Сума", w: 75, align: "right" as const },
      ];
      const rowH = 14;
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
      doc.y = headerY + rowH;
      doc
        .moveTo(L, doc.y - 2)
        .lineTo(L + pageW, doc.y - 2)
        .lineWidth(0.3)
        .strokeColor("#cbd5e1")
        .stroke();

      doc.font("Main").fontSize(8.5).fillColor("#0f172a");
      data.expectedCod.rows.forEach((r, idx) => {
        if (doc.y + rowH > doc.page.height - 60) {
          doc.addPage();
          doc.y = 40;
        }
        const rowY = doc.y;
        const cells = [
          String(idx + 1),
          `#${r.order_number}`,
          r.partner_name.length > 32
            ? r.partner_name.slice(0, 30) + "…"
            : r.partner_name,
          r.shipment_number,
          fmtEur(r.cod_amount),
        ];
        cx = L;
        cells.forEach((val, i) => {
          doc.text(val, cx + 2, rowY, {
            width: cols[i].w - 4,
            align: cols[i].align,
          });
          cx += cols[i].w;
        });
        doc.y = rowY + rowH;
      });
      doc.moveDown(0.6);
    }

    // ── Footer ──────────────────────────────────────────
    // Sample-style attribution line: "Отпечатано: 05.05.2026 13:13 ·
    // Плащания: 10". Lives at the bottom of the last page so the
    // cashier can verify the print belongs to the right session. The
    // signature lines from the previous template were dropped per
    // cashier feedback — this is a self-check report, not a hand-off
    // document.
    doc.moveDown(0.4);
    const now = new Date();
    const printedTs = `${formatDateBg(now.toISOString().slice(0, 10))} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    doc.fontSize(8).fillColor("#94a3b8");
    doc.text(
      `Отпечатано: ${printedTs} · Плащания: ${data.payments.rows.length}` +
        (data.expectedCod.count > 0
          ? ` · Очаквани: ${data.expectedCod.count}`
          : ""),
      L,
      doc.y,
      { width: pageW, align: "right" },
    );

    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", (err) => reject(err));
  });
}
