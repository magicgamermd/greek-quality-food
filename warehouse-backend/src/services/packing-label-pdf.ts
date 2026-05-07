// Packing label PDF — internal "stick on the box" label that warehouse
// staff print while preparing an order so the package can be matched
// back to its order on pickup or before the Econt waybill is generated.
//
// Generated DIRECTLY at the Zebra label's physical size (4 × 4 inches,
// 288 × 288 pt at 72 pt/inch) so the content fills the whole label
// without scaling. Replaces the previous A4-landscape-with-content-in-
// top-left layout that was meant to be physically scaled by the printer
// driver — that approach left the label mostly blank with tiny text
// because the driver couldn't align the corner zone reliably.

import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";

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
  throw new Error(`Font not found: ${filename}`);
}

const FONT_REGULAR = getFontPath("Roboto-Regular.ttf");
const FONT_BOLD = getFontPath("Roboto-Bold.ttf");

export interface PackingLabelItem {
  name_bg: string;
  quantity: number | string;
  unit: string;
}

export interface PackingLabelData {
  orderNumber: string | number;
  partnerName: string;
  preparedAt: Date;
  items: PackingLabelItem[];
  deliveryLabel: string;
  notes?: string | null;
  outputPath: string;
}

function formatDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()} ${hh}:${min}`;
}

function formatQty(v: number | string): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!Number.isFinite(n)) return String(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, "");
}

// Page geometry — 4×4 inch label at 72 pt/inch
const PAGE_W = 288;
const PAGE_H = 288;
const MARGIN = 8;
const CONTENT_W = PAGE_W - MARGIN * 2;

export async function generatePackingLabelPdf(
  data: PackingLabelData,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [PAGE_W, PAGE_H],
      margin: 0,
    });
    doc.registerFont("Main", FONT_REGULAR);
    doc.registerFont("MainBold", FONT_BOLD);

    const out = fs.createWriteStream(data.outputPath);
    doc.pipe(out);
    out.on("finish", () => resolve());
    out.on("error", reject);

    let y = MARGIN;
    const L = MARGIN;

    // Order number — big and bold, full width, centred. Visible from
    // across the warehouse.
    doc.font("MainBold").fontSize(20).fillColor("#000");
    doc.text(`ПОРЪЧКА #${data.orderNumber}`, L, y, {
      width: CONTENT_W,
      align: "center",
    });
    y +=
      doc.heightOfString(`ПОРЪЧКА #${data.orderNumber}`, {
        width: CONTENT_W,
      }) + 4;

    // Heavy divider under the title
    doc
      .moveTo(L, y)
      .lineTo(L + CONTENT_W, y)
      .strokeColor("#000")
      .lineWidth(1)
      .stroke();
    y += 5;

    // Partner name — second-largest text. Truncated to ~2 lines if long.
    doc.font("MainBold").fontSize(11);
    const partnerName = data.partnerName || "—";
    doc.text(partnerName, L, y, {
      width: CONTENT_W,
      align: "left",
      ellipsis: true,
      height: 26,
    });
    y += Math.min(
      26,
      doc.heightOfString(partnerName, { width: CONTENT_W }) + 1,
    );

    // Delivery type + prepared timestamp on a single compact line so
    // the items block has more vertical room.
    doc.font("Main").fontSize(8).fillColor("#444");
    doc.text(data.deliveryLabel, L, y, {
      width: CONTENT_W,
      lineBreak: false,
      ellipsis: true,
    });
    y += 10;
    doc.text(`Подготвена: ${formatDate(data.preparedAt)}`, L, y, {
      width: CONTENT_W,
      lineBreak: false,
    });
    y += 12;
    doc.fillColor("#000");

    // Light divider before items
    doc
      .moveTo(L, y)
      .lineTo(L + CONTENT_W, y)
      .strokeColor("#aaa")
      .lineWidth(0.4)
      .stroke();
    y += 4;

    // Items header
    doc.font("MainBold").fontSize(9);
    doc.text("Артикули:", L, y, { width: CONTENT_W });
    y += 11;

    // Items list — squeeze rows into whatever vertical space remains.
    // Bottom budget reserves room for the "Общо артикули" footer.
    const qtyW = 50;
    const nameW = CONTENT_W - qtyW - 4;
    const bottomBudget = 24;
    const maxY = PAGE_H - MARGIN - bottomBudget;

    doc.font("Main").fontSize(8);
    let truncated = 0;
    for (let i = 0; i < data.items.length; i++) {
      const it = data.items[i];
      const nameH = doc.heightOfString(it.name_bg, { width: nameW });
      if (y + nameH > maxY) {
        truncated = data.items.length - i;
        break;
      }
      doc.text(it.name_bg, L, y, { width: nameW });
      doc.text(`${formatQty(it.quantity)} ${it.unit}`, L + nameW + 4, y, {
        width: qtyW,
        align: "right",
      });
      y += Math.max(nameH, 9) + 1;
    }

    if (truncated > 0) {
      doc.font("Main").fontSize(8).fillColor("#666");
      doc.text(`… и още ${truncated} арт.`, L, y, {
        width: CONTENT_W,
        lineBreak: false,
      });
      doc.fillColor("#000");
      y += 10;
    }

    // Footer divider + total count
    if (y < maxY + 4) {
      doc
        .moveTo(L, y)
        .lineTo(L + CONTENT_W, y)
        .strokeColor("#000")
        .lineWidth(0.5)
        .stroke();
      y += 3;
    }
    doc.font("MainBold").fontSize(9);
    doc.text(`Общо артикули: ${data.items.length}`, L, PAGE_H - MARGIN - 11, {
      width: CONTENT_W,
      align: "left",
      lineBreak: false,
    });

    doc.end();
  });
}
