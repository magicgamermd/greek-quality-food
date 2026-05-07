// ====================================================================
// СТОКОВА РАЗПИСКА ЗА ЗАМЯНА (Replacement Stock Receipt)
// ====================================================================
//
// Two-section razpiska generator for replacement orders (is_replacement = true).
// Mirrors the pdfkit-based pipeline of `services/document-pdf.ts` (the
// existing razpiska generator — `generateStockDispatchPdf`) — same fonts,
// same layout primitives — and adds a colored two-section layout:
//
//   1. ВЗЕМА СЕ (green)  — products the customer takes
//   2. ВРЪЩА СЕ (red)    — products the customer returns
//
// Plus a red "ЗАМЯНА" stamp in the top-right corner, the difference line,
// payment method line, descriptive sentence and signature lines.
//
// This generator returns a `Buffer` (rather than writing to disk) because
// the difference between this and the other razpiska is small enough that
// the route caller can just stream `reply.send(buf)` directly without an
// intermediate temp file.

import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";

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

const FONT_REGULAR = getFontPath("Roboto-Regular.ttf");
const FONT_BOLD = getFontPath("Roboto-Bold.ttf");

// ── Colors ──────────────────────────────────────────────────────────
const RED = "#c70d0d";
const GREEN = "#0f8a26";
const BLACK = "#000000";
const GRAY = "#666666";

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
function formatBgn(amount: number): string {
  return `${amount.toFixed(2)} лв`;
}

function formatDate(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${date.getFullYear()}`;
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

    const pageWidth = doc.page.width - 80;
    const leftCol = 40;
    const rightEdge = leftCol + pageWidth;

    // ── Red stamp "ЗАМЯНА" in top-right corner ──────────────────────
    const stampWidth = 90;
    const stampHeight = 28;
    const stampX = rightEdge - stampWidth;
    const stampY = 30;
    doc
      .rect(stampX, stampY, stampWidth, stampHeight)
      .lineWidth(1.5)
      .strokeColor(RED)
      .stroke();
    doc.font("MainBold").fontSize(14).fillColor(RED);
    doc.text("ЗАМЯНА", stampX, stampY + 7, {
      width: stampWidth,
      align: "center",
      lineBreak: false,
    });
    doc.fillColor(BLACK);

    // ── Title (red) ─────────────────────────────────────────────────
    doc.font("MainBold").fontSize(15).fillColor(RED);
    doc.text(`СТОКОВА РАЗПИСКА ЗА ЗАМЯНА №${order.number}`, leftCol, 40, {
      width: pageWidth - stampWidth - 10,
      align: "left",
    });
    doc.fillColor(BLACK);

    // ── Sub-header: date + partner block ────────────────────────────
    doc.font("Main").fontSize(9).fillColor(BLACK);
    doc.text(`Дата: ${formatDate(order.date)}`, leftCol, doc.y + 4, {
      width: pageWidth,
    });

    doc.font("MainBold").fontSize(10);
    doc.text(`Клиент: ${order.partner.name}`, leftCol, doc.y + 2, {
      width: pageWidth,
    });

    if (order.partner.egn_or_eik) {
      doc.font("Main").fontSize(9);
      doc.text(`ЕГН/ЕИК: ${order.partner.egn_or_eik}`, leftCol, doc.y + 1, {
        width: pageWidth,
      });
    }
    if (order.partner.address) {
      doc.font("Main").fontSize(9);
      doc.text(`Адрес: ${order.partner.address}`, leftCol, doc.y + 1, {
        width: pageWidth,
      });
    }

    doc.moveDown(0.4);
    doc
      .moveTo(leftCol, doc.y)
      .lineTo(rightEdge, doc.y)
      .lineWidth(0.5)
      .strokeColor("#888")
      .stroke();
    doc.moveDown(0.4);

    // ── Two sections (give / return) ────────────────────────────────
    const giveItems = order.items.filter((it) => !it.is_returning);
    const returnItems = order.items.filter((it) => it.is_returning);

    const giveSum = drawSection(
      doc,
      leftCol,
      pageWidth,
      "ВЗЕМА СЕ",
      GREEN,
      giveItems,
    );
    doc.moveDown(0.5);
    const returnSum = drawSection(
      doc,
      leftCol,
      pageWidth,
      "ВРЪЩА СЕ",
      RED,
      returnItems,
    );

    doc.moveDown(0.6);
    doc
      .moveTo(leftCol, doc.y)
      .lineTo(rightEdge, doc.y)
      .lineWidth(0.5)
      .strokeColor("#888")
      .stroke();
    doc.moveDown(0.4);

    // ── Difference + payment ────────────────────────────────────────
    let diffLabel: string;
    let diffColor = BLACK;
    if (order.total > 0) {
      diffLabel = `Разлика за плащане: +${formatBgn(order.total)}`;
      diffColor = GREEN;
    } else if (order.total < 0) {
      diffLabel = `За връщане на клиента: ${formatBgn(Math.abs(order.total))}`;
      diffColor = RED;
    } else {
      diffLabel = "Размяна без доплащане (равна)";
    }
    doc.font("MainBold").fontSize(12).fillColor(diffColor);
    doc.text(diffLabel, leftCol, doc.y, { width: pageWidth });
    doc.fillColor(BLACK);

    if (order.total !== 0 && order.payment_method) {
      const verb = order.total > 0 ? "Платено в" : "Възстановено в";
      const methodLabel = paymentMethodBg(order.payment_method);
      doc.font("Main").fontSize(10).fillColor(BLACK);
      doc.text(
        `${verb} ${methodLabel}: ${formatBgn(Math.abs(order.total))}`,
        leftCol,
        doc.y + 2,
        { width: pageWidth },
      );
    }

    doc.moveDown(0.8);

    // ── Descriptive sentence ────────────────────────────────────────
    const giveLine = giveItems
      .map(
        (i) =>
          `${i.quantity} бр. ${i.product_name} на стойност ${formatBgn(lineSum(i))}`,
      )
      .join("; ");
    const returnLine = returnItems
      .map(
        (i) =>
          `${i.quantity} бр. ${i.product_name} на стойност ${formatBgn(lineSum(i))}`,
      )
      .join("; ");

    let sentence: string;
    const isBank =
      order.payment_method === "bank" ||
      order.payment_method === "bank_transfer";
    if (order.total > 0) {
      const verb =
        order.payment_method === "cash"
          ? "е заплатена в брой от клиента"
          : order.payment_method === "pos"
            ? "е заплатена с POS терминал от клиента"
            : isBank
              ? "е заплатена по банков път от клиента"
              : "е заплатена от клиента";
      sentence = `Със настоящата стокова разписка клиентът взема: ${giveLine}. Клиентът връща: ${returnLine}. Разликата от ${formatBgn(order.total)} ${verb}.`;
    } else if (order.total < 0) {
      const verb =
        order.payment_method === "cash"
          ? "е възстановена на клиента в брой"
          : order.payment_method === "pos"
            ? "е възстановена на клиента по POS"
            : isBank
              ? "е възстановена на клиента по банков път"
              : "е възстановена на клиента";
      sentence = `Със настоящата стокова разписка клиентът взема: ${giveLine}. Клиентът връща: ${returnLine}. Разликата от ${formatBgn(Math.abs(order.total))} ${verb}.`;
    } else {
      sentence = `Със настоящата стокова разписка клиентът взема: ${giveLine}. Клиентът връща: ${returnLine}. Размяната е равностойностна — без доплащане.`;
    }
    doc.font("Main").fontSize(9).fillColor(GRAY);
    doc.text(sentence, leftCol, doc.y, {
      width: pageWidth,
      align: "left",
    });
    doc.fillColor(BLACK);

    doc.moveDown(2);

    // ── Signatures ──────────────────────────────────────────────────
    const sigY = Math.max(doc.y, doc.page.height - 100);
    const halfWidth = (pageWidth - 30) / 2;
    const sigLineWidth = halfWidth - 50;

    doc.font("Main").fontSize(9).fillColor(BLACK);
    doc.text("Предал:", leftCol, sigY, {
      width: 50,
      lineBreak: false,
    });
    doc
      .moveTo(leftCol + 48, sigY + 11)
      .lineTo(leftCol + 48 + sigLineWidth, sigY + 11)
      .lineWidth(0.5)
      .strokeColor(BLACK)
      .stroke();

    const rightSigX = leftCol + halfWidth + 30;
    doc.text("Приел:", rightSigX, sigY, {
      width: 50,
      lineBreak: false,
    });
    doc
      .moveTo(rightSigX + 48, sigY + 11)
      .lineTo(rightSigX + 48 + sigLineWidth, sigY + 11)
      .lineWidth(0.5)
      .strokeColor(BLACK)
      .stroke();

    doc.font("Main").fontSize(7).fillColor(GRAY);
    doc.text("(име и подпис)", leftCol, sigY + 16, {
      width: halfWidth,
      align: "left",
    });
    doc.text("(име и подпис)", rightSigX, sigY + 16, {
      width: halfWidth,
      align: "left",
    });
    doc.fillColor(BLACK);

    doc.end();
  });
}

// ── Section renderer ────────────────────────────────────────────────
// Header bar + items table + sum row. Returns the section's total so
// the caller can use it for the descriptive sentence.
function drawSection(
  doc: PDFKit.PDFDocument,
  leftCol: number,
  pageWidth: number,
  label: string,
  color: string,
  items: ReplacementPdfItem[],
): number {
  const headerHeight = 18;
  const startY = doc.y;

  // Colored section header bar
  doc.rect(leftCol, startY, pageWidth, headerHeight).fill(color);
  doc.fillColor("#ffffff").font("MainBold").fontSize(11);
  doc.text(label, leftCol + 8, startY + 4, {
    width: pageWidth - 16,
    align: "left",
    lineBreak: false,
  });
  doc.fillColor("#000000");

  doc.y = startY + headerHeight;

  // Table column widths (must sum to pageWidth)
  // № | Артикул | Код | Кол. | Ед. цена | Стойност
  const cols = [
    { header: "№", width: 28, align: "right" as const },
    {
      header: "Артикул",
      width: pageWidth - 28 - 90 - 50 - 70 - 80,
      align: "left" as const,
    },
    { header: "Код", width: 90, align: "left" as const },
    { header: "Кол.", width: 50, align: "right" as const },
    { header: "Ед. цена", width: 70, align: "right" as const },
    { header: "Стойност", width: 80, align: "right" as const },
  ];

  // Column header row (faint background)
  const colHeaderHeight = 14;
  const colHeaderY = doc.y;
  doc.rect(leftCol, colHeaderY, pageWidth, colHeaderHeight).fill("#f0f0f0");
  doc.fillColor("#000000").font("MainBold").fontSize(8);
  let cellX = leftCol;
  for (const col of cols) {
    doc.text(col.header, cellX + 3, colHeaderY + 3, {
      width: col.width - 6,
      align: col.align,
      lineBreak: false,
    });
    cellX += col.width;
  }
  doc.y = colHeaderY + colHeaderHeight;

  // Item rows
  let total = 0;
  doc.font("Main").fontSize(9).fillColor("#000000");
  for (let idx = 0; idx < items.length; idx += 1) {
    const item = items[idx];
    const sum = lineSum(item);
    total += sum;

    const rowY = doc.y;
    const rowHeight = 16;

    // Row border (top + bottom kept thin)
    doc
      .rect(leftCol, rowY, pageWidth, rowHeight)
      .lineWidth(0.3)
      .strokeColor("#cccccc")
      .stroke();

    const values = [
      String(idx + 1),
      item.product_name,
      item.product_code,
      String(item.quantity),
      item.unit_price.toFixed(2),
      sum.toFixed(2),
    ];

    cellX = leftCol;
    for (let colIdx = 0; colIdx < cols.length; colIdx += 1) {
      const col = cols[colIdx];
      doc.font("Main").fontSize(9).fillColor("#000000");
      doc.text(values[colIdx], cellX + 3, rowY + 3, {
        width: col.width - 6,
        align: col.align,
        lineBreak: false,
        ellipsis: true,
      });
      cellX += col.width;
    }
    doc.y = rowY + rowHeight;
  }

  // Sum row
  const sumRowY = doc.y;
  const sumRowHeight = 18;
  doc.rect(leftCol, sumRowY, pageWidth, sumRowHeight).fill("#f7f7f7");
  doc.fillColor("#000000").font("MainBold").fontSize(10);
  // "Сума:" label spans first three columns; value goes in the last
  const labelWidth =
    cols[0].width +
    cols[1].width +
    cols[2].width +
    cols[3].width +
    cols[4].width -
    6;
  doc.text("Сума:", leftCol + 6, sumRowY + 4, {
    width: labelWidth,
    align: "right",
    lineBreak: false,
  });
  doc.text(
    formatBgn(total),
    leftCol + pageWidth - cols[5].width + 3,
    sumRowY + 4,
    {
      width: cols[5].width - 6,
      align: "right",
      lineBreak: false,
    },
  );
  doc.y = sumRowY + sumRowHeight;
  doc.fillColor("#000000");

  return total;
}
