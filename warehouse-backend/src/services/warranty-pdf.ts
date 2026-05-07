// Гаранционна карта — overlays auto-filled fields onto the existing
// `warranty-card-template.pdf` so the printed result keeps the same
// design the cashier expects (header, ГАРАНЦИОННИ УСЛОВИЯ, ГАРАНЦИЯТА
// ОТПАДА ПРИ, signature blocks, OLX QR). Only the variable fields are
// drawn — serial number, buyer name, purchase date, warranty months,
// and the list of items in "Вид стока". For warranties with more items
// than the template's slot can hold, a continuation page is appended
// with a table of all items.

import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
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

function getTemplatePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "assets", "warranty-card-template.pdf"),
    path.resolve(__dirname, "..", "..", "assets", "warranty-card-template.pdf"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("warranty-card-template.pdf not found");
}

export interface WarrantyItem {
  name_bg: string;
  sku?: string | null;
  quantity: number | string;
  unit: string;
}

export interface WarrantyCardData {
  serial_number: string;
  /** ISO yyyy-mm-dd of purchase. Maps to "Дата на покупката". */
  purchase_date: string;
  /** Default 12 — printed in "Гар. срок (месеци)". */
  warranty_months: number;
  buyer_name: string;
  buyer_eik?: string | null;
  buyer_address?: string | null;
  /** Kept for API symmetry with the legacy interface; the template has
   *  МЕРТ-М hard-printed in the header so we don't redraw seller data. */
  seller?: { name: string; eik: string; address: string; phone?: string };
  items: WarrantyItem[];
  /** Goods-receipt number (SR-NNNNNNN). When the warranty covers more
   *  than one item, the "Вид стока" slot prints "По опис - <ref>" and
   *  the full list goes on the continuation page. */
  stock_dispatch_number?: string | null;
  outputPath: string;
}

// Coordinates measured from `warranty-card-template.pdf` (A4, 842 pt
// page height). pdf-lib uses bottom-origin Y, so y_pdflib = 842 - y_top.
//
// Labels in the template (with their baselines):
//   "Купувач / име на купувача:"  x=41,  baseline y_pdflib=595
//   "Дата на покупката:"           x=312, baseline y_pdflib=595
//   "Гар. срок (месеци):"          x=41,  baseline y_pdflib=558
//   "Вид стока:"                   x=312, baseline y_pdflib=558
//
// Each label sits above an underline strip the cashier was meant to
// hand-fill. We draw the auto-fill text just ABOVE the underline,
// aligned with the label's left edge.
const PAGE_H = 841.89;
const SERIAL_POSITION = { x: 395, y: 772 };
const BUYER_NAME_POSITION = { x: 42, y: 580 }; // under label, on underline
const PURCHASE_DATE_POSITION = { x: 312, y: 580 };
const WARRANTY_MONTHS_POSITION = { x: 42, y: 543 };
const ITEMS_POSITION = { x: 312, y: 543, w: 240, lineHeight: 11 };
// Width of the buyer / date underline slots — keeps long values from
// spilling onto the next column.
const BUYER_NAME_MAX_W = 260;
// Heuristic: how many items fit in the template's "Вид стока" slot
// without crossing into the conditions block below it.
const ITEMS_INLINE_LIMIT = 2;

function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function describeItem(it: WarrantyItem): string {
  const qty =
    typeof it.quantity === "number"
      ? it.quantity.toString()
      : String(it.quantity);
  const head = it.name_bg;
  const tail = `${qty} ${it.unit || "бр"}`;
  return `${head} — ${tail}`;
}

export async function generateWarrantyCardPdf(
  data: WarrantyCardData,
): Promise<void> {
  const templateBytes = fs.readFileSync(getTemplatePath());
  const pdfDoc = await PDFDocument.load(templateBytes);
  pdfDoc.registerFontkit(fontkit);

  const regularBytes = fs.readFileSync(getFontPath("Roboto-Regular.ttf"));
  const boldBytes = fs.readFileSync(getFontPath("Roboto-Bold.ttf"));
  const fontRegular = await pdfDoc.embedFont(regularBytes);
  const fontBold = await pdfDoc.embedFont(boldBytes);

  const page = pdfDoc.getPages()[0];
  const accent = rgb(0.1, 0.23, 0.43);
  const black = rgb(0, 0, 0);

  // 1) Serial number (top-right)
  page.drawText(`Сериен №: ${data.serial_number}`, {
    x: SERIAL_POSITION.x,
    y: SERIAL_POSITION.y,
    size: 10,
    font: fontBold,
    color: accent,
  });

  // 2) Buyer name (truncate to fit the underlined slot — ~33 chars).
  // EIK or address aren't on the template; appended in parens after the
  // name when present so they still surface on the printed card.
  const buyerLine = [
    data.buyer_name,
    data.buyer_eik ? `(ЕИК ${data.buyer_eik})` : null,
  ]
    .filter(Boolean)
    .join(" ");
  page.drawText(buyerLine.slice(0, 36), {
    x: BUYER_NAME_POSITION.x,
    y: BUYER_NAME_POSITION.y,
    size: 10,
    font: fontRegular,
    color: black,
  });

  // 3) Purchase date
  page.drawText(formatDate(data.purchase_date), {
    x: PURCHASE_DATE_POSITION.x,
    y: PURCHASE_DATE_POSITION.y,
    size: 10,
    font: fontRegular,
    color: black,
  });

  // 4) Warranty months
  page.drawText(String(data.warranty_months), {
    x: WARRANTY_MONTHS_POSITION.x,
    y: WARRANTY_MONTHS_POSITION.y,
    size: 10,
    font: fontRegular,
    color: black,
  });

  // 5) Вид стока — single item is printed inline; for any multi-item
  // warranty we instead reference the goods-receipt by its number
  // ("По опис - SR-XXXXXXX") and put the full list on a continuation
  // page. Keeps the template's slot from overflowing into the
  // ГАРАНЦИОННИ УСЛОВИЯ block below.
  const isMulti = data.items.length > 1;
  if (!isMulti && data.items.length === 1) {
    page.drawText(describeItem(data.items[0]).slice(0, 40), {
      x: ITEMS_POSITION.x,
      y: ITEMS_POSITION.y,
      size: 9,
      font: fontRegular,
      color: black,
    });
  } else if (isMulti) {
    const ref = data.stock_dispatch_number || data.serial_number;
    page.drawText(`По опис - ${ref}`, {
      x: ITEMS_POSITION.x,
      y: ITEMS_POSITION.y,
      size: 9,
      font: fontBold,
      color: black,
    });
  }

  // 6) Continuation page when items overflow the inline slot. A
  // standalone full-list table that referees back to the serial on
  // page 1 — keeps the original template untouched while supporting
  // any number of items.
  if (isMulti) {
    const cont = pdfDoc.addPage([595.28, 841.89]); // A4
    let y = 800;
    cont.drawText("ГАРАНЦИОННА КАРТА — пълен списък артикули", {
      x: 50,
      y,
      size: 14,
      font: fontBold,
      color: accent,
    });
    y -= 18;
    cont.drawText(`Към гаранция № ${data.serial_number}`, {
      x: 50,
      y,
      size: 10,
      font: fontRegular,
      color: black,
    });
    y -= 24;

    // Header row
    cont.drawText("№", { x: 50, y, size: 10, font: fontBold });
    cont.drawText("Артикул", { x: 80, y, size: 10, font: fontBold });
    cont.drawText("Код", { x: 360, y, size: 10, font: fontBold });
    cont.drawText("Кол.", { x: 470, y, size: 10, font: fontBold });
    cont.drawText("Ед.", { x: 510, y, size: 10, font: fontBold });
    y -= 4;
    cont.drawLine({
      start: { x: 50, y },
      end: { x: 545, y },
      thickness: 0.6,
      color: rgb(0.5, 0.55, 0.6),
    });
    y -= 14;

    for (let i = 0; i < data.items.length; i++) {
      if (y < 60) {
        const more = pdfDoc.addPage([595.28, 841.89]);
        y = 800;
        more.drawText(
          `ГАРАНЦИОННА КАРТА — пълен списък артикули (продължение)`,
          {
            x: 50,
            y,
            size: 12,
            font: fontBold,
            color: accent,
          },
        );
        y -= 24;
      }
      const it = data.items[i];
      cont.drawText(String(i + 1), { x: 50, y, size: 9, font: fontRegular });
      cont.drawText(it.name_bg.slice(0, 50), {
        x: 80,
        y,
        size: 9,
        font: fontRegular,
      });
      cont.drawText((it.sku || "—").slice(0, 18), {
        x: 360,
        y,
        size: 9,
        font: fontRegular,
      });
      cont.drawText(String(it.quantity), {
        x: 470,
        y,
        size: 9,
        font: fontRegular,
      });
      cont.drawText(it.unit || "бр", { x: 510, y, size: 9, font: fontRegular });
      y -= 14;
    }
  }

  const out = await pdfDoc.save();
  fs.writeFileSync(data.outputPath, out);
}
