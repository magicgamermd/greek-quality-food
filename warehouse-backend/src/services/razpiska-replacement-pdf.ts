// ====================================================================
// СТОКОВА РАЗПИСКА ЗА ЗАМЯНА (Replacement Stock Receipt)
// ====================================================================
//
// Visual style mirrors the regular `Стокова разписка` (`generateStockDispatchPdf`
// in document-pdf.ts): same serif title font, same right-aligned
// Номер/Дата info block, same recipient/company side-by-side boxes,
// same neutral grid table, same EUR-formatted totals block, and the
// same signatures footer. Only the document-specific parts differ —
// subtitle reads "за замяна на стоки", a small "ЗАМЯНА" pill sits in
// the top-right corner, and the items list is split into two sub-tables
// (Взема се / Връща се) with neutral header rows so a non-techy cashier
// can still see at a glance which lines were given and which were
// returned. Diff line replaces the regular "Общо" row.
//
// Returns a `Buffer` so the route caller can stream it directly.

import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { formatUnitPricePlain } from "../utils/currency.js";

// ── Fonts (same lookup pattern as document-pdf.ts) ──────────────────
function getFontPath(filename: string): string {
  const candidates = [
    path.resolve(__dirname, "..", "fonts", filename),
    path.resolve(__dirname, "..", "..", "src", "fonts", filename),
    path.resolve(process.cwd(), "src", "fonts", filename),
    path.resolve(process.cwd(), "dist", "fonts", filename),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Font not found: ${filename}`);
}

function getOptionalFontPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const FONT_REGULAR = getFontPath("Roboto-Regular.ttf");
const FONT_BOLD = getFontPath("Roboto-Bold.ttf");

// Serif fonts — same lookup chain document-pdf.ts uses, so the
// замяна razpiska prints with the same Times-style title the regular
// razpiska has. Falls back to Roboto when no system serif is available.
const SERIF_FONT_REGULAR =
  getOptionalFontPath([
    "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
    "/Library/Fonts/Times New Roman.ttf",
    "/usr/share/fonts/liberation/LiberationSerif-Regular.ttf",
    "/usr/share/fonts/TTF/LiberationSerif-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
    "/usr/share/fonts/liberation-fonts/LiberationSerif-Regular.ttf",
    "C:\\Windows\\Fonts\\times.ttf",
    path.resolve(process.cwd(), "src", "fonts", "Georgia.ttf"),
  ]) || FONT_REGULAR;
const SERIF_FONT_BOLD =
  getOptionalFontPath([
    "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
    "/Library/Fonts/Times New Roman Bold.ttf",
    "/usr/share/fonts/liberation/LiberationSerif-Bold.ttf",
    "/usr/share/fonts/TTF/LiberationSerif-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
    "/usr/share/fonts/liberation-fonts/LiberationSerif-Bold.ttf",
    "C:\\Windows\\Fonts\\timesbd.ttf",
    path.resolve(process.cwd(), "src", "fonts", "Georgia Bold.ttf"),
  ]) || FONT_BOLD;

// ── Types ───────────────────────────────────────────────────────────
export interface ReplacementPdfItem {
  product_name: string;
  product_code: string;
  quantity: number;
  unit_price: number;
  is_returning: boolean;
}

export interface ReplacementPdfPartner {
  name: string;
  egn_or_eik?: string | null;
  address?: string | null;
}

export interface ReplacementPdfOrder {
  id: number;
  number: string;
  date: Date;
  partner: ReplacementPdfPartner;
  items: ReplacementPdfItem[];
  /**
   * Signed difference (give − return). Positive = customer pays,
   * negative = warehouse refunds, zero = even swap.
   */
  total: number;
  /**
   * Payment / refund channel for the difference. Accepts both `bank` (the
   * value stored in the `payments.payment_method` enum) and the spec's
   * `bank_transfer` alias so callers don't have to translate.
   */
  payment_method?: "cash" | "pos" | "bank" | "bank_transfer";
}

// ── Helpers ─────────────────────────────────────────────────────────
function formatDate(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${date.getFullYear()}`;
}

function formatEUR(num: number): string {
  return num.toFixed(2);
}

function formatQty(num: number): string {
  return num.toFixed(3);
}

function normalizeAddress(addr: string): string {
  return addr?.replace(/([a-zA-Zа-яА-ЯёЁ])(\d)/g, "$1 $2") || "";
}

function paymentMethodBg(
  method: ReplacementPdfOrder["payment_method"],
): string {
  switch (method) {
    case "cash":
      return "брой";
    case "pos":
      return "POS";
    case "bank":
    case "bank_transfer":
      return "банков превод";
    default:
      return "";
  }
}

function lineSum(item: ReplacementPdfItem): number {
  return item.quantity * item.unit_price;
}

// ── Main entry ──────────────────────────────────────────────────────
export async function renderReplacementPdf(
  order: ReplacementPdfOrder,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 36, bottom: 36, left: 40, right: 40 },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.registerFont("Main", FONT_REGULAR);
    doc.registerFont("MainBold", FONT_BOLD);
    doc.registerFont("StockSerif", SERIF_FONT_REGULAR);
    doc.registerFont("StockSerifBold", SERIF_FONT_BOLD);

    const pageWidth = doc.page.width - 80;
    const leftCol = 40;

    // ── Heading: title (centered, serif, underlined) + Номер/Дата ──
    drawHeading(doc, leftCol, pageWidth, order.number, order.date);

    // ── ЗАМЯНА pill in the top-right corner ───────────────────────
    drawReplacementPill(doc, leftCol, pageWidth);

    // ── Recipient box (only — no supplier data passed currently) ──
    drawPartyBox(doc, leftCol, pageWidth, order.partner);

    // ── Two sections (give / return) ──────────────────────────────
    const giveItems = order.items.filter((it) => !it.is_returning);
    const returnItems = order.items.filter((it) => it.is_returning);

    const giveSum = drawSection(doc, leftCol, pageWidth, "Взема се", giveItems);
    doc.moveDown(0.5);
    const returnSum = drawSection(
      doc,
      leftCol,
      pageWidth,
      "Връща се",
      returnItems,
    );

    doc.moveDown(0.6);

    // ── Totals: signed Разлика, replacing the regular "Общо" row ─
    drawDiffBlock(
      doc,
      leftCol,
      pageWidth,
      giveSum,
      returnSum,
      order.payment_method,
    );

    doc.moveDown(0.8);

    // ── Descriptive sentence ──────────────────────────────────────
    const sentence = buildSentence(
      giveItems,
      returnItems,
      order.total,
      order.payment_method,
    );
    doc.font("StockSerif").fontSize(8.5).fillColor("#000");
    doc.text(sentence, leftCol, doc.y, { width: pageWidth, align: "left" });

    doc.moveDown(1.6);

    // ── Signatures (same layout as regular razpiska) ─────────────
    drawSignatures(doc, leftCol, pageWidth);

    doc.end();
  });
}

// ── Heading ─────────────────────────────────────────────────────────
// Mirrors `drawStockDispatchHeading` in document-pdf.ts: serif title
// centered + underlined, subtitle below, Номер/Дата info block on the
// right.
function drawHeading(
  doc: PDFKit.PDFDocument,
  leftCol: number,
  pageWidth: number,
  docNumber: string,
  docDate: Date,
) {
  const titleY = 34;
  const infoWidth = 170;
  const titleWidth = pageWidth - infoWidth - 12;
  const infoX = leftCol + pageWidth - infoWidth;

  doc.font("StockSerifBold").fontSize(14).fillColor("#000");
  doc.text("Стокова разписка", leftCol, titleY, {
    width: titleWidth,
    align: "center",
    underline: true,
  });
  doc.font("StockSerif").fontSize(10.5);
  doc.text("за замяна на стоки", leftCol, titleY + 18, {
    width: titleWidth,
    align: "center",
  });

  doc.font("StockSerifBold").fontSize(9);
  doc.text("Номер:", infoX, titleY + 2, { width: 48, lineBreak: false });
  doc.font("StockSerif").fontSize(9);
  doc.text(docNumber, infoX + 48, titleY + 2, {
    width: infoWidth - 48,
    align: "left",
  });
  doc.font("StockSerifBold").fontSize(9);
  doc.text("Дата:", infoX, titleY + 18, { width: 48, lineBreak: false });
  doc.font("StockSerif").fontSize(9);
  doc.text(formatDate(docDate), infoX + 48, titleY + 18, {
    width: infoWidth - 48,
    align: "left",
  });

  doc.y = titleY + 42;
}

// ── ЗАМЯНА pill (subtle, neutral border, small) ──────────────────────
// Replaces the previous bright-red stamp box. Lives BELOW the title
// block, right-aligned, so it doesn't overlap the centered heading.
function drawReplacementPill(
  doc: PDFKit.PDFDocument,
  leftCol: number,
  pageWidth: number,
) {
  const pillWidth = 70;
  const pillHeight = 16;
  const x = leftCol + pageWidth - pillWidth;
  const y = doc.y;
  doc
    .roundedRect(x, y, pillWidth, pillHeight, 8)
    .lineWidth(0.5)
    .strokeColor("#000")
    .stroke();
  doc.font("StockSerifBold").fontSize(8.5).fillColor("#000");
  doc.text("ЗАМЯНА", x, y + 3.5, {
    width: pillWidth,
    align: "center",
    lineBreak: false,
  });
  doc.y = y + pillHeight + 6;
}

// ── Party box ───────────────────────────────────────────────────────
// Mirrors the recipient half of `drawStockDispatchPartyBoxes`. We only
// have the recipient (no company snapshot is passed in for replacement
// orders yet), so we render a single full-width box rather than two
// half-width ones — keeps the look consistent with razpiska without
// inventing supplier data we don't have.
function drawPartyBox(
  doc: PDFKit.PDFDocument,
  leftCol: number,
  pageWidth: number,
  partner: ReplacementPdfPartner,
) {
  const padding = 6;
  const labelWidth = 60;
  const startY = doc.y;
  const textWidth = pageWidth - padding * 2;
  const valueWidth = textWidth - labelWidth;

  type Row = { label: string; value: string; bold?: boolean };
  const rows: Row[] = [
    { label: "", value: partner.name || "—", bold: true },
    ...(partner.egn_or_eik
      ? [{ label: "ЕГН/ЕИК", value: partner.egn_or_eik }]
      : []),
    ...(partner.address
      ? [{ label: "Адрес", value: normalizeAddress(partner.address) }]
      : []),
  ];

  // Measure
  let measureY = startY + padding;
  doc.font("StockSerifBold").fontSize(9);
  measureY +=
    Math.ceil(doc.heightOfString("Получател", { width: textWidth })) + 3;
  for (const row of rows) {
    doc
      .font(row.bold ? "StockSerifBold" : "StockSerif")
      .fontSize(row.bold ? 9 : 8.4);
    const h = Math.ceil(
      doc.heightOfString(row.value || " ", { width: valueWidth }),
    );
    measureY += Math.max(11, h) + 2;
  }
  const boxHeight = measureY - startY + padding;

  // Draw
  doc
    .rect(leftCol, startY, pageWidth, boxHeight)
    .lineWidth(0.35)
    .strokeColor("#000")
    .stroke();
  let y = startY + padding;
  doc.font("StockSerifBold").fontSize(9).fillColor("#000");
  doc.text("Получател", leftCol + padding, y, { width: textWidth });
  y = doc.y + 3;
  for (const row of rows) {
    doc.font("StockSerif").fontSize(8.4);
    if (row.label) {
      doc.text(row.label, leftCol + padding, y, {
        width: labelWidth,
        lineBreak: false,
      });
    }
    doc
      .font(row.bold ? "StockSerifBold" : "StockSerif")
      .fontSize(row.bold ? 9 : 8.4);
    doc.text(row.value, leftCol + padding + labelWidth, y, {
      width: valueWidth,
      align: "left",
    });
    y +=
      Math.max(
        11,
        Math.ceil(doc.heightOfString(row.value || " ", { width: valueWidth })),
      ) + 2;
  }
  doc.y = startY + boxHeight + 10;
}

// ── Section (Взема се / Връща се) ───────────────────────────────────
// Same look as the regular razpiska items table (thin black grid,
// serif body font), with a small label row above so the cashier can
// tell give from return at a glance. No saturated colour bars — just a
// neutral row with the section name on the left and its sum on the
// right.
function drawSection(
  doc: PDFKit.PDFDocument,
  leftCol: number,
  pageWidth: number,
  label: string,
  items: ReplacementPdfItem[],
): number {
  // Section label band (neutral)
  const labelY = doc.y;
  const labelHeight = 16;
  doc.rect(leftCol, labelY, pageWidth, labelHeight).fill("#f0f0f0");
  doc.fillColor("#000").font("StockSerifBold").fontSize(9.5);
  doc.text(label, leftCol + 6, labelY + 4, {
    width: pageWidth - 12,
    align: "left",
    lineBreak: false,
  });
  doc.y = labelY + labelHeight;

  // Column layout — same proportions as the regular razpiska's
  // [№ / Код / Стока / Мярка / Кол. / Цена / Ст-ст], stripped of
  // Валута + Отстъпка which замяна doesn't track per-line.
  const cols: Array<{
    header: string;
    width: number;
    align: "left" | "right" | "center";
  }> = [
    { header: "№", width: 22, align: "right" },
    { header: "Код", width: 80, align: "left" },
    {
      header: "Стока",
      width: pageWidth - (22 + 80 + 50 + 70 + 70),
      align: "left",
    },
    { header: "Кол.", width: 50, align: "right" },
    { header: "Ед. цена", width: 70, align: "right" },
    { header: "Ст-ст", width: 70, align: "right" },
  ];

  // Header row
  const headerY = doc.y;
  const headerH = 16;
  doc
    .rect(leftCol, headerY, pageWidth, headerH)
    .lineWidth(0.35)
    .strokeColor("#000")
    .stroke();
  doc.font("StockSerifBold").fontSize(8).fillColor("#000");
  let x = leftCol;
  for (const col of cols) {
    doc.text(col.header, x + 3, headerY + 4, {
      width: col.width - 6,
      align: col.align,
      lineBreak: false,
    });
    x += col.width;
  }
  doc.y = headerY + headerH;

  if (items.length === 0) {
    const rowY = doc.y;
    const rowH = 16;
    doc
      .rect(leftCol, rowY, pageWidth, rowH)
      .lineWidth(0.35)
      .strokeColor("#000")
      .stroke();
    doc.font("StockSerif").fontSize(8.4).fillColor("#666");
    doc.text("(няма артикули)", leftCol + 6, rowY + 4, {
      width: pageWidth - 12,
      align: "left",
      lineBreak: false,
    });
    doc.fillColor("#000");
    doc.y = rowY + rowH;
    return 0;
  }

  // Body rows
  let total = 0;
  doc.font("StockSerif").fontSize(8.4).fillColor("#000");
  for (let idx = 0; idx < items.length; idx += 1) {
    const item = items[idx];
    const sum = lineSum(item);
    total += sum;

    const rowY = doc.y;
    const rowH = 16;
    doc
      .rect(leftCol, rowY, pageWidth, rowH)
      .lineWidth(0.35)
      .strokeColor("#000")
      .stroke();

    const values = [
      String(idx + 1),
      item.product_code || "",
      item.product_name || "—",
      formatQty(item.quantity),
      formatUnitPricePlain(item.unit_price),
      formatEUR(sum),
    ];
    let cellX = leftCol;
    for (let c = 0; c < cols.length; c += 1) {
      const col = cols[c];
      doc.font("StockSerif").fontSize(8.4).fillColor("#000");
      doc.text(values[c], cellX + 3, rowY + 4, {
        width: col.width - 6,
        align: col.align,
        lineBreak: false,
        ellipsis: true,
      });
      cellX += col.width;
    }
    doc.y = rowY + rowH;
  }

  // Section subtotal row
  const subY = doc.y;
  const subH = 16;
  doc
    .rect(leftCol, subY, pageWidth, subH)
    .lineWidth(0.35)
    .strokeColor("#000")
    .stroke();
  const valueColW = cols[cols.length - 1].width;
  const labelW = pageWidth - valueColW;
  doc.font("StockSerifBold").fontSize(9).fillColor("#000");
  doc.text("Сума:", leftCol + 6, subY + 4, {
    width: labelW - 12,
    align: "right",
    lineBreak: false,
  });
  doc.text(`${formatEUR(total)} €`, leftCol + labelW, subY + 4, {
    width: valueColW - 6,
    align: "right",
    lineBreak: false,
  });
  doc.y = subY + subH;
  return total;
}

// ── Diff block ──────────────────────────────────────────────────────
// Same right-aligned style as the regular razpiska totals block, but
// rendering the signed difference instead of Сума/ДДС/Общо. Method
// of payment goes on the row below when present.
function drawDiffBlock(
  doc: PDFKit.PDFDocument,
  leftCol: number,
  pageWidth: number,
  giveSum: number,
  returnSum: number,
  paymentMethod: ReplacementPdfOrder["payment_method"],
) {
  const diff = giveSum - returnSum;
  const isZero = Math.abs(diff) < 0.005;
  const labelWidth = 130;
  const valueWidth = 80;
  const blockWidth = labelWidth + valueWidth;
  const x = leftCol + pageWidth - blockWidth;
  const valueX = x + labelWidth;

  let y = doc.y;
  const rowH = 14;
  const drawRow = (label: string, value: string, bold = false) => {
    const fontName = bold ? "StockSerifBold" : "StockSerif";
    const fontSize = bold ? 10 : 9;
    doc.font(fontName).fontSize(fontSize).fillColor("#000");
    doc.text(label, x, y, { width: labelWidth, align: "left" });
    doc.text(value, valueX, y, { width: valueWidth, align: "right" });
    y += rowH;
  };

  drawRow("Взема се (сума):", `${formatEUR(giveSum)} €`);
  drawRow("Връща се (сума):", `${formatEUR(returnSum)} €`);

  doc
    .moveTo(x, y - 1)
    .lineTo(x + blockWidth, y - 1)
    .lineWidth(0.35)
    .strokeColor("#000")
    .stroke();

  if (isZero) {
    drawRow("Разлика:", `${formatEUR(0)} €`, true);
  } else if (diff > 0) {
    drawRow("За доплащане:", `+${formatEUR(diff)} €`, true);
  } else {
    drawRow("За връщане:", `−${formatEUR(Math.abs(diff))} €`, true);
  }

  if (!isZero && paymentMethod) {
    const verb = diff > 0 ? "Платено в" : "Възстановено в";
    const m = paymentMethodBg(paymentMethod);
    doc.font("StockSerif").fontSize(8.5).fillColor("#000");
    doc.text(`${verb} ${m}`, x, y + 1, {
      width: blockWidth,
      align: "right",
    });
    y += rowH;
  }

  doc.y = y + 2;
}

// ── Descriptive sentence ────────────────────────────────────────────
function buildSentence(
  giveItems: ReplacementPdfItem[],
  returnItems: ReplacementPdfItem[],
  total: number,
  paymentMethod: ReplacementPdfOrder["payment_method"],
): string {
  const giveLine = giveItems
    .map(
      (i) =>
        `${i.quantity} бр. ${i.product_name} на стойност ${formatEUR(lineSum(i))} €`,
    )
    .join("; ");
  const returnLine = returnItems
    .map(
      (i) =>
        `${i.quantity} бр. ${i.product_name} на стойност ${formatEUR(lineSum(i))} €`,
    )
    .join("; ");

  const isBank = paymentMethod === "bank" || paymentMethod === "bank_transfer";

  if (total > 0) {
    const verb =
      paymentMethod === "cash"
        ? "е заплатена в брой от клиента"
        : paymentMethod === "pos"
          ? "е заплатена с POS терминал от клиента"
          : isBank
            ? "е заплатена по банков път от клиента"
            : "е заплатена от клиента";
    return `Със настоящата стокова разписка клиентът взема: ${giveLine}. Клиентът връща: ${returnLine}. Разликата от ${formatEUR(total)} € ${verb}.`;
  }
  if (total < 0) {
    const verb =
      paymentMethod === "cash"
        ? "е възстановена на клиента в брой"
        : paymentMethod === "pos"
          ? "е възстановена на клиента по POS"
          : isBank
            ? "е възстановена на клиента по банков път"
            : "е възстановена на клиента";
    return `Със настоящата стокова разписка клиентът взема: ${giveLine}. Клиентът връща: ${returnLine}. Разликата от ${formatEUR(Math.abs(total))} € ${verb}.`;
  }
  return `Със настоящата стокова разписка клиентът взема: ${giveLine}. Клиентът връща: ${returnLine}. Размяната е равностойностна — без доплащане.`;
}

// ── Signatures ──────────────────────────────────────────────────────
// Same Получил/Предал layout as the regular razpiska's
// `drawStockDispatchSignatures`, sized for the cashier's existing print
// muscle memory.
function drawSignatures(
  doc: PDFKit.PDFDocument,
  leftCol: number,
  pageWidth: number,
) {
  const startY = Math.max(doc.y, doc.page.height - 90);
  const rightX = leftCol + pageWidth - 210;
  const lineWidth = 112;

  doc.font("StockSerif").fontSize(8.5).fillColor("#000");
  doc.text("Получил:", leftCol, startY, { width: 46, lineBreak: false });
  doc
    .moveTo(leftCol + 44, startY + 9)
    .lineTo(leftCol + 44 + lineWidth, startY + 9)
    .lineWidth(0.35)
    .strokeColor("#000")
    .stroke();

  doc.font("StockSerif").fontSize(8.4);
  doc.text("Предал:", rightX, startY, { width: 50, lineBreak: false });
  doc
    .moveTo(rightX + 48, startY + 9)
    .lineTo(rightX + 48 + lineWidth, startY + 9)
    .lineWidth(0.35)
    .strokeColor("#000")
    .stroke();

  doc.font("StockSerif").fontSize(7).fillColor("#666");
  doc.text("(име и подпис)", leftCol + 44, startY + 12, {
    width: lineWidth,
    align: "left",
  });
  doc.text("(име и подпис)", rightX + 48, startY + 12, {
    width: lineWidth,
    align: "left",
  });
  doc.fillColor("#000");
}
