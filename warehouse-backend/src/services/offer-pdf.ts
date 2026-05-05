// ====================================================================
// ОФЕРТА (Quotation / Offer) PDF
// --------------------------------------------------------------------
// Generates a single-page A4 offer (proforma) — title "ОФЕРТА" with a
// document number of the form OF-NNNNNNN, party headers (sender +
// receiver), itemized table (qty × price − discount = total), totals
// (net + VAT 20% + gross), and a footer note about validity.
// Used for quoted orders that don't yet deduct stock; the cashier prints
// it for the customer to take home and confirm later.
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

export interface OfferPdfData {
  /** e.g. "OF-0000037" */
  offerNumber: string;
  /** ISO date (yyyy-mm-dd) */
  date: string;
  partner: {
    name: string;
    eik?: string;
    vat_number?: string;
    address?: string;
    city?: string;
    contact_person?: string;
    phone?: string;
  };
  company: {
    name: string;
    eik: string;
    vat_number?: string;
    address: string;
    city?: string;
    phone?: string;
    email?: string;
    mol?: string;
  };
  items: Array<{
    name_bg: string;
    quantity: number | string;
    unit: string;
    unit_price: number | string;
    discount_percent?: number | string | null;
    total_price: number | string;
  }>;
  totalNet: number;
  totalVat: number;
  totalGross: number;
  outputPath: string;
  // Settings → Документи toggle (migration 069). When true, the totals
  // block prints a "BGN | EUR" two-column layout. Default false →
  // EUR-only, layout unchanged from before.
  showBgn?: boolean;
}

const OFFER_EUR_TO_BGN = 1.95583;

function fmtBgn(amountEur: number): string {
  const bgn = Math.round(amountEur * OFFER_EUR_TO_BGN * 100) / 100;
  return `${bgn.toFixed(2).replace(".", ",")} лв.`;
}

function toNum(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function formatDateBg(iso: string): string {
  // yyyy-mm-dd → dd.mm.yyyy
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso;
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

function fmtEur(v: number | string): string {
  return formatEurAmount(v) + " €";
}

export async function generateOfferPdf(data: OfferPdfData): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 36, bottom: 36, left: 40, right: 40 },
    });
    const stream = fs.createWriteStream(data.outputPath);
    doc.pipe(stream);

    doc.registerFont("Main", FONT_REGULAR);
    doc.registerFont("MainBold", FONT_BOLD);

    const L = 40;
    const pageW = doc.page.width - 80;
    const colW = pageW / 2 - 8;

    // ── Title ──────────────────────────────────────────────
    doc.font("MainBold").fontSize(18).fillColor("#0f172a");
    doc.text("ОФЕРТА", L, doc.y, { width: pageW, align: "center" });
    doc.moveDown(0.2);
    doc.font("Main").fontSize(10).fillColor("#475569");
    doc.text(
      `№ ${data.offerNumber}    ·    Дата: ${formatDateBg(data.date)}`,
      L,
      doc.y,
      { width: pageW, align: "center" },
    );
    doc.fillColor("#0f172a");
    doc.moveDown(1.2);

    // ── Party headers ──────────────────────────────────────
    const partyTop = doc.y;
    const drawParty = (
      x: number,
      title: string,
      lines: Array<[string, string | undefined]>,
    ) => {
      doc.font("MainBold").fontSize(8).fillColor("#64748b");
      doc.text(title, x, partyTop, { width: colW });
      let y = doc.y + 2;
      for (const [label, value] of lines) {
        if (!value) continue;
        doc.font("Main").fontSize(8.5).fillColor("#334155");
        doc.text(label, x, y, { width: 70, continued: false });
        doc.font("MainBold").fillColor("#0f172a");
        doc.text(value, x + 70, y, { width: colW - 70 });
        y = doc.y + 1;
      }
      return y;
    };

    const senderEnd = drawParty(L, "ИЗПРАЩАЧ (Доставчик)", [
      ["Фирма:", data.company.name],
      ["ЕИК:", data.company.eik],
      ["ДДС №:", data.company.vat_number],
      [
        "Адрес:",
        [data.company.address, data.company.city].filter(Boolean).join(", "),
      ],
      ["Телефон:", data.company.phone],
      ["E-mail:", data.company.email],
      ["МОЛ:", data.company.mol],
    ]);

    const receiverEnd = drawParty(L + colW + 16, "ПОЛУЧАТЕЛ (Клиент)", [
      ["Фирма/Име:", data.partner.name],
      ["ЕИК:", data.partner.eik],
      ["ДДС №:", data.partner.vat_number],
      [
        "Адрес:",
        [data.partner.address, data.partner.city].filter(Boolean).join(", "),
      ],
      ["Телефон:", data.partner.phone],
      ["Лице за контакт:", data.partner.contact_person],
    ]);

    doc.y = Math.max(senderEnd, receiverEnd) + 12;

    // ── Items table ────────────────────────────────────────
    const cols = [
      { header: "№", w: 24, align: "right" },
      { header: "Стока", w: pageW - 24 - 50 - 70 - 60 - 80, align: "left" },
      { header: "Кол.", w: 50, align: "right" },
      { header: "Ед. цена", w: 70, align: "right" },
      { header: "Отст. %", w: 60, align: "right" },
      { header: "Сума", w: 80, align: "right" },
    ];
    const headerY = doc.y;
    let cx = L;
    doc.font("MainBold").fontSize(8.5).fillColor("#0f172a");
    for (const c of cols) {
      doc.text(c.header, cx + 2, headerY + 4, {
        width: c.w - 4,
        align: c.align as any,
      });
      cx += c.w;
    }
    const rowH = 16;
    doc
      .moveTo(L, headerY + rowH)
      .lineTo(L + pageW, headerY + rowH)
      .lineWidth(0.5)
      .strokeColor("#cbd5e1")
      .stroke();
    doc.y = headerY + rowH + 2;

    doc.font("Main").fontSize(8.5).fillColor("#0f172a");
    data.items.forEach((it, idx) => {
      const y = doc.y;
      const cells = [
        String(idx + 1),
        it.name_bg || "—",
        toNum(it.quantity).toLocaleString("bg-BG", {
          minimumFractionDigits: 0,
          maximumFractionDigits: 3,
        }),
        fmtEur(toNum(it.unit_price)),
        toNum(it.discount_percent) > 0
          ? toNum(it.discount_percent).toFixed(0) + "%"
          : "—",
        fmtEur(toNum(it.total_price)),
      ];
      cx = L;
      cells.forEach((val, i) => {
        doc.text(val, cx + 2, y + 2, {
          width: cols[i].w - 4,
          align: cols[i].align as any,
        });
        cx += cols[i].w;
      });
      doc.y = y + rowH;
      doc
        .moveTo(L, doc.y)
        .lineTo(L + pageW, doc.y)
        .lineWidth(0.3)
        .strokeColor("#e2e8f0")
        .stroke();
      doc.y += 2;
    });

    // ── Totals ─────────────────────────────────────────────
    // Two-column "BGN | EUR" layout when the toggle is on, single EUR
    // column otherwise. Matches the invoice + Стокова разписка
    // formatting so all transaction documents stay visually aligned.
    doc.moveDown(0.6);
    const showBgn = data.showBgn === true;
    const labelW = 130;
    const eurW = 90;
    const bgnW = showBgn ? 90 : 0;
    const colGap = showBgn ? 10 : 0;
    const totalsBlockW = labelW + bgnW + colGap + eurW + 5;
    const totalsX = L + pageW - totalsBlockW;
    const bgnX = totalsX + labelW + 5;
    const eurX = bgnX + bgnW + colGap;

    if (showBgn) {
      const y = doc.y;
      doc.font("MainBold").fontSize(8).fillColor("#475569");
      doc.text("BGN", bgnX, y, { width: bgnW, align: "right" });
      doc.text("EUR", eurX, y, { width: eurW, align: "right" });
      doc.y = y + 12;
    }

    const totalLine = (label: string, amountEur: number, bold = false) => {
      const y = doc.y;
      doc
        .font(bold ? "MainBold" : "Main")
        .fontSize(9)
        .fillColor("#0f172a");
      doc.text(label, totalsX, y, { width: labelW, align: "right" });
      if (showBgn) {
        doc.text(fmtBgn(amountEur), bgnX, y, {
          width: bgnW,
          align: "right",
        });
      }
      doc.text(fmtEur(amountEur), eurX, y, {
        width: eurW,
        align: "right",
      });
      doc.y = y + 14;
    };
    totalLine("Сума без ДДС:", data.totalNet);
    totalLine("ДДС 20%:", data.totalVat);
    doc
      .moveTo(totalsX + labelW - 60, doc.y - 2)
      .lineTo(totalsX + totalsBlockW, doc.y - 2)
      .lineWidth(0.5)
      .strokeColor("#94a3b8")
      .stroke();
    totalLine("Обща сума:", data.totalGross, true);

    // ── Footer note ────────────────────────────────────────
    doc.moveDown(2);
    doc.font("Main").fontSize(8.5).fillColor("#475569");
    doc.text("Цените са валидни до уговаряне.", L, doc.y, {
      width: pageW,
      align: "left",
    });
    doc.moveDown(0.4);
    doc.fontSize(7.5).fillColor("#64748b");
    doc.text(
      "Документът има информативен характер. Не е данъчен документ; не подлежи на осчетоводяване. " +
        "Изготвен е въз основа на текущите наличности и цени към датата на издаване.",
      L,
      doc.y,
      { width: pageW, align: "left" },
    );

    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", (err) => reject(err));
  });
}
