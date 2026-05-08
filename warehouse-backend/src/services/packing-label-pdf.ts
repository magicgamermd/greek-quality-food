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
  // Замяна: true → линията се връща ОТ клиента; false/undefined → линията
  // се дава НА клиента. Игнорира се за обикновени поръчки.
  is_returning?: boolean;
}

export interface PackingLabelData {
  orderNumber: string | number;
  partnerName: string;
  preparedAt: Date;
  items: PackingLabelItem[];
  deliveryLabel: string;
  notes?: string | null;
  outputPath: string;
  // Когато true, бележката се рендерира с "ЗАМЯНА" значка и две секции
  // — "Дай на клиента" и "Приеми обратно" — разделени по `is_returning`.
  isReplacement?: boolean;
  // Когато true, бележката е за финално ПРЕДАВАНЕ на платена-невзета
  // стока (миграция 079, pending_pickup линии). Показва се различен
  // badge "ПРЕДАВАНЕ" + sub-line "Платена невзета стока".
  isPickupHandover?: boolean;
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
    const isReplacement = Boolean(data.isReplacement);
    const isPickupHandover = Boolean(data.isPickupHandover);

    // Order number — big and bold, full width, centred. Visible from
    // across the warehouse. За замяна/предаване слагаме малко по-малък
    // шрифт за заглавието, така че значката да се събере на същия ред.
    const titleFontSize = isReplacement || isPickupHandover ? 18 : 20;
    doc.font("MainBold").fontSize(titleFontSize).fillColor("#000");
    doc.text(`ПОРЪЧКА #${data.orderNumber}`, L, y, {
      width: CONTENT_W,
      align: "center",
    });
    y +=
      doc.heightOfString(`ПОРЪЧКА #${data.orderNumber}`, {
        width: CONTENT_W,
      }) + 4;

    // Status badge — inverted pill, centred под заглавието. Без емоджи,
    // защото Roboto няма емоджи глифове и ще рендерира кутийки на
    // термалния принтер. Замяна и предаване се изключват взаимно
    // (replacement не може да бъде в pickup mode).
    const badgeLabel = isReplacement
      ? "ЗАМЯНА"
      : isPickupHandover
        ? "ПРЕДАВАНЕ"
        : null;
    if (badgeLabel) {
      doc.font("MainBold").fontSize(10);
      const badgeTextW = doc.widthOfString(badgeLabel);
      const badgeW = badgeTextW + 14;
      const badgeH = 14;
      const badgeX = L + (CONTENT_W - badgeW) / 2;
      doc.roundedRect(badgeX, y, badgeW, badgeH, 3).fillColor("#000").fill();
      doc.fillColor("#fff").text(badgeLabel, badgeX, y + 2, {
        width: badgeW,
        align: "center",
        lineBreak: false,
      });
      doc.fillColor("#000");
      y += badgeH + 3;
      // Sub-line за pickup — обяснение какво вижда работника на склада.
      // Замяната няма sub-line, за да остави място за двете секции.
      if (isPickupHandover) {
        doc.font("Main").fontSize(8).fillColor("#444");
        doc.text("Платена невзета стока", L, y, {
          width: CONTENT_W,
          align: "center",
          lineBreak: false,
        });
        doc.fillColor("#000");
        y += 11;
      }
    }

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

    // Items list — squeeze rows into whatever vertical space remains.
    // Bottom budget reserves room for the "Общо артикули" footer.
    const qtyW = 50;
    const nameW = CONTENT_W - qtyW - 4;
    const bottomBudget = 24;
    const maxY = PAGE_H - MARGIN - bottomBudget;

    // Render a list of items; returns the new y and how many were
    // truncated for lack of vertical space. Caller draws the "още X"
    // hint after BOTH sections (so we don't waste a line per section).
    const renderItems = (
      list: PackingLabelItem[],
      startY: number,
    ): { y: number; truncated: number } => {
      let cursor = startY;
      doc.font("Main").fontSize(8).fillColor("#000");
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        const nameH = doc.heightOfString(it.name_bg, { width: nameW });
        if (cursor + nameH > maxY) {
          return { y: cursor, truncated: list.length - i };
        }
        doc.text(it.name_bg, L, cursor, { width: nameW });
        doc.text(
          `${formatQty(it.quantity)} ${it.unit}`,
          L + nameW + 4,
          cursor,
          {
            width: qtyW,
            align: "right",
          },
        );
        cursor += Math.max(nameH, 9) + 1;
      }
      return { y: cursor, truncated: 0 };
    };

    let truncated = 0;
    if (isReplacement) {
      const giveItems = data.items.filter((i) => !i.is_returning);
      const returnItems = data.items.filter((i) => Boolean(i.is_returning));

      // Section 1 — give to customer
      doc.font("MainBold").fontSize(9).fillColor("#000");
      doc.text("Дай на клиента:", L, y, { width: CONTENT_W });
      y += 11;
      if (giveItems.length === 0) {
        doc.font("Main").fontSize(8).fillColor("#666");
        doc.text("— няма —", L, y, { width: CONTENT_W });
        doc.fillColor("#000");
        y += 10;
      } else {
        const r1 = renderItems(giveItems, y);
        y = r1.y;
        truncated += r1.truncated;
      }

      y += 2;

      // Section 2 — return from customer
      if (y + 11 <= maxY) {
        doc.font("MainBold").fontSize(9).fillColor("#000");
        doc.text("Приеми обратно:", L, y, { width: CONTENT_W });
        y += 11;
      }
      if (returnItems.length === 0) {
        doc.font("Main").fontSize(8).fillColor("#666");
        doc.text("— няма —", L, y, { width: CONTENT_W });
        doc.fillColor("#000");
        y += 10;
      } else {
        const r2 = renderItems(returnItems, y);
        y = r2.y;
        truncated += r2.truncated;
      }
    } else {
      doc.font("MainBold").fontSize(9);
      doc.text("Артикули:", L, y, { width: CONTENT_W });
      y += 11;

      const r = renderItems(data.items, y);
      y = r.y;
      truncated = r.truncated;
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

    // Footer divider + total count. За замяна показваме две числа
    // (give / return), за обикновена поръчка — общо.
    if (y < maxY + 4) {
      doc
        .moveTo(L, y)
        .lineTo(L + CONTENT_W, y)
        .strokeColor("#000")
        .lineWidth(0.5)
        .stroke();
      y += 3;
    }
    doc.font("MainBold").fontSize(9).fillColor("#000");
    let footerText: string;
    if (isReplacement) {
      const giveCount = data.items.filter((i) => !i.is_returning).length;
      const returnCount = data.items.filter((i) =>
        Boolean(i.is_returning),
      ).length;
      footerText = `Дай: ${giveCount}  •  Приеми: ${returnCount}`;
    } else {
      footerText = `Общо артикули: ${data.items.length}`;
    }
    doc.text(footerText, L, PAGE_H - MARGIN - 11, {
      width: CONTENT_W,
      align: "left",
      lineBreak: false,
    });

    doc.end();
  });
}
