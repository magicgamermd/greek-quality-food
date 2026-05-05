import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { mapUnit } from "./units.js";

// ── Fonts ──────────────────────────────────────────────────────────
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

function getOptionalFontPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const FONT_REGULAR = getFontPath("Roboto-Regular.ttf");
const FONT_BOLD = getFontPath("Roboto-Bold.ttf");
const SERIF_FONT_REGULAR =
  getOptionalFontPath([
    // macOS
    "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
    "/Library/Fonts/Times New Roman.ttf",
    // Linux (Alpine with ttf-liberation installed via Dockerfile)
    "/usr/share/fonts/liberation/LiberationSerif-Regular.ttf",
    "/usr/share/fonts/TTF/LiberationSerif-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
    "/usr/share/fonts/liberation-fonts/LiberationSerif-Regular.ttf",
    // Windows
    "C:\\Windows\\Fonts\\times.ttf",
    // Bundled fallback
    path.resolve(process.cwd(), "src", "fonts", "Georgia.ttf"),
  ]) || FONT_REGULAR;
const SERIF_FONT_BOLD =
  getOptionalFontPath([
    // macOS
    "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
    "/Library/Fonts/Times New Roman Bold.ttf",
    // Linux (Alpine with ttf-liberation)
    "/usr/share/fonts/liberation/LiberationSerif-Bold.ttf",
    "/usr/share/fonts/TTF/LiberationSerif-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
    "/usr/share/fonts/liberation-fonts/LiberationSerif-Bold.ttf",
    // Windows
    "C:\\Windows\\Fonts\\timesbd.ttf",
    // Bundled fallback
    path.resolve(process.cwd(), "src", "fonts", "Georgia Bold.ttf"),
  ]) || FONT_BOLD;

// ── Helpers ────────────────────────────────────────────────────────
// mapUnit is imported from ./units — shared with invoice-pdf.ts

function toNum(v: string | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === "string" ? parseFloat(v) || 0 : v;
}

function formatDate(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()}`;
}

function formatEUR(num: number): string {
  return num.toFixed(2);
}

function formatQty(num: number): string {
  return num.toFixed(3);
}

function formatDiscount(num: number): string {
  if (num <= 0) return "";
  return Number.isInteger(num) ? `${num.toFixed(0)}%` : `${num.toFixed(1)}%`;
}

function normalizeAddress(addr: string): string {
  return addr?.replace(/([a-zA-Zа-яА-ЯёЁ])(\d)/g, "$1 $2") || "";
}

// Bulgarian number-to-words (simplified)
function numberToWordsBG(n: number, currency: "EUR" | "BGN" = "EUR"): string {
  const ones = [
    "",
    "едно",
    "две",
    "три",
    "четири",
    "пет",
    "шест",
    "седем",
    "осем",
    "девет",
  ];
  const teens = [
    "десет",
    "единадесет",
    "дванадесет",
    "тринадесет",
    "четиринадесет",
    "петнадесет",
    "шестнадесет",
    "седемнадесет",
    "осемнадесет",
    "деветнадесет",
  ];
  const tens = [
    "",
    "",
    "двадесет",
    "тридесет",
    "четиридесет",
    "петдесет",
    "шестдесет",
    "седемдесет",
    "осемдесет",
    "деветдесет",
  ];
  const hundreds = [
    "",
    "сто",
    "двеста",
    "триста",
    "четиристотин",
    "петстотин",
    "шестстотин",
    "седемстотин",
    "осемстотин",
    "деветстотин",
  ];

  if (n === 0) return currency === "BGN" ? "нула лева" : "нула евро";

  // Negative amounts (e.g. credit notes) — recurse on abs + "Минус" prefix
  if (n < 0) {
    const abs = numberToWordsBG(-n, currency);
    return "Минус " + abs.charAt(0).toLowerCase() + abs.slice(1);
  }

  const integer = Math.floor(n);
  const decimals = Math.round((n - integer) * 100);

  function convertBelow1000(num: number): string {
    if (num === 0) return "";
    let w = "";
    if (num >= 100) {
      w += hundreds[Math.floor(num / 100)];
      const rem = num % 100;
      if (rem >= 10 && rem < 20) {
        w += " и " + teens[rem - 10];
      } else if (rem > 0) {
        const t = Math.floor(rem / 10);
        const o = rem % 10;
        if (t > 0) w += " и " + tens[t];
        if (o > 0) w += (t > 0 ? " и " : " и ") + ones[o];
      }
    } else if (num >= 10 && num < 20) {
      w += teens[num - 10];
    } else if (num >= 20) {
      w += tens[Math.floor(num / 10)];
      const o = num % 10;
      if (o > 0) w += " и " + ones[o];
    } else {
      w += ones[num];
    }
    return w.trim();
  }

  let words = "";
  if (integer >= 1000) {
    const thousands = Math.floor(integer / 1000);
    if (thousands === 1) {
      words += "хиляда";
    } else {
      words += convertBelow1000(thousands) + " хиляди";
    }
    const rem = integer % 1000;
    if (rem > 0) {
      words += " " + convertBelow1000(rem);
    }
  } else {
    words = convertBelow1000(integer);
  }

  words = words.trim();
  words = words.charAt(0).toUpperCase() + words.slice(1);

  if (currency === "BGN") {
    if (decimals > 0) {
      words += ` лева и ${String(decimals).padStart(2, "0")} ст.`;
    } else {
      words += " лева";
    }
  } else if (decimals > 0) {
    words += ` евро и ${String(decimals).padStart(2, "0")} цента`;
  } else {
    words += " евро";
  }

  return words;
}

// ── Interfaces ─────────────────────────────────────────────────────
interface CompanyInfo {
  company_name: string;
  address: string;
  city?: string;
  eik: string;
  vat_number?: string;
  phone?: string;
  mol?: string;
  vet_reg_number?: string; // Ветеринарен регистрационен №
}

interface PartnerInfo {
  name: string;
  eik?: string;
  vat_number?: string;
  address?: string;
  city?: string;
  phone?: string;
  mol?: string;
}

interface DocItem {
  sku?: string;
  name_bg?: string;
  name_en?: string;
  brand?: string;
  unit?: string;
  quantity: number;
  unit_price?: number;
  total_price?: number;
  discount_percent?: number;
  currency?: string;
  batch_number?: string | null;
  expiry_date?: string | null;
}

interface StockDispatchData {
  doc_number: string;
  doc_date: string;
  company: CompanyInfo;
  partner: PartnerInfo;
  warehouse_name?: string;
  items: DocItem[];
  vat_rate: number;
  // "net" (default): prices in table are without VAT, totals show Сума + ДДС + Общо
  // "gross": prices in table already include VAT, totals show only Общо (no VAT line)
  pricing_mode?: "net" | "gross";
  outputPath: string;
  // Settings → Документи toggle (migration 069). When true, the totals
  // block prints a "BGN | EUR" two-column layout matching the Microinvest
  // sample МЕРТ-М shared. Default false → EUR-only, unchanged from before.
  show_bgn?: boolean;
}

interface CommercialDocData {
  doc_number: string;
  doc_date: string;
  company: CompanyInfo;
  partner: PartnerInfo;
  items: DocItem[];
  outputPath: string;
}

interface IncomingStockReceiptItem {
  sku?: string;
  name_bg?: string;
  name_en?: string;
  unit?: string;
  quantity: number;
  unit_price?: number;
  total_price?: number;
  discount_percent?: number;
  currency?: string;
}

interface IncomingStockReceiptData {
  doc_number: string;
  doc_date: string;
  reference_number?: string | null;
  buyer: PartnerInfo;
  supplier: PartnerInfo;
  warehouse_name?: string;
  items: IncomingStockReceiptItem[];
  outputPath: string;
}

// ── Draw two-column boxed header (Buyer/Seller) ────────────────────
function drawPartyHeaders(
  doc: PDFKit.PDFDocument,
  company: CompanyInfo,
  partner: PartnerInfo,
  leftCol: number,
  rightCol: number,
  colWidth: number,
  warehouseName?: string,
) {
  const startY = doc.y;
  const padding = 6;
  const labelWidth = 52;
  const innerWidth = colWidth - padding * 2;
  const valueWidth = innerWidth - labelWidth;
  const fieldGap = 1.5;
  const minFieldHeight = 11;
  const titleGap = 4;

  type Field = { label: string; value: string; bold?: boolean };

  const partnerFields: Field[] = [
    { label: "", value: partner.name || "—", bold: true },
    ...(partner.eik ? [{ label: "ЕИК:", value: partner.eik }] : []),
    ...(partner.vat_number
      ? [{ label: "ДДС:", value: partner.vat_number }]
      : []),
    ...(partner.city ? [{ label: "Град:", value: partner.city }] : []),
    ...(partner.address
      ? [{ label: "Адрес:", value: normalizeAddress(partner.address) }]
      : []),
    ...(partner.phone ? [{ label: "Тел:", value: partner.phone }] : []),
    ...(partner.mol ? [{ label: "МОЛ:", value: partner.mol }] : []),
  ];
  const companyFields: Field[] = [
    { label: "", value: company.company_name || "—", bold: true },
    { label: "ЕИК:", value: company.eik },
    ...(company.vat_number
      ? [{ label: "ДДС:", value: company.vat_number }]
      : []),
    ...(company.city ? [{ label: "Град:", value: company.city }] : []),
    ...(company.address
      ? [{ label: "Адрес:", value: normalizeAddress(company.address) }]
      : []),
    ...(company.phone ? [{ label: "Тел:", value: company.phone }] : []),
    ...(company.mol ? [{ label: "МОЛ:", value: company.mol }] : []),
  ];

  const measureBox = (title: string, fields: Field[]): number => {
    doc.font("MainBold").fontSize(8);
    const titleH = Math.ceil(doc.heightOfString(title, { width: innerWidth }));
    let h = padding + titleH + titleGap;
    for (const f of fields) {
      doc.font(f.bold ? "MainBold" : "Main").fontSize(7.5);
      const vh = Math.ceil(
        doc.heightOfString(f.value || " ", { width: valueWidth }),
      );
      h += Math.max(minFieldHeight, vh) + fieldGap;
    }
    return h + padding;
  };

  const boxHeight = Math.max(
    measureBox("Получател", partnerFields),
    measureBox("Доставчик", companyFields),
  );

  const drawBox = (x: number, title: string, fields: Field[]) => {
    doc
      .rect(x, startY, colWidth, boxHeight)
      .lineWidth(0.5)
      .strokeColor("#000")
      .stroke();

    doc.font("MainBold").fontSize(8);
    doc.text(title, x + padding, startY + padding, {
      width: innerWidth,
      lineBreak: false,
    });
    const titleH = Math.ceil(doc.heightOfString(title, { width: innerWidth }));

    let y = startY + padding + titleH + titleGap;
    for (const field of fields) {
      doc.font("Main").fontSize(7.5);
      const valueHeight = doc.heightOfString(field.value || " ", {
        width: valueWidth,
      });
      const rowHeight = Math.max(minFieldHeight, Math.ceil(valueHeight));
      if (field.label) {
        doc.text(field.label, x + padding, y, {
          width: labelWidth,
          lineBreak: false,
        });
      }
      doc.font(field.bold ? "MainBold" : "Main").fontSize(7.5);
      doc.text(field.value, x + padding + labelWidth, y, {
        width: valueWidth,
        align: "left",
      });
      y += rowHeight + fieldGap;
    }
  };

  drawBox(leftCol, "Получател", partnerFields);
  drawBox(rightCol, "Доставчик", companyFields);

  doc.y = startY + boxHeight + 6;

  if (warehouseName) {
    doc.font("Main").fontSize(7.5);
    doc.text(`Обект: ${warehouseName}`, leftCol, doc.y, {
      width: colWidth * 2 + 20,
    });
    doc.moveDown(0.3);
  }
}

interface TableColumn {
  header: string;
  width: number;
  align: "left" | "right" | "center";
  wrap?: boolean;
}

function fitToCell(
  doc: PDFKit.PDFDocument,
  value: string,
  maxWidth: number,
): string {
  const normalized = (value || "").toString().trim();
  if (!normalized) return "";
  if (doc.widthOfString(normalized) <= maxWidth) return normalized;

  const suffix = "...";
  let end = normalized.length;
  while (end > 0) {
    const candidate = `${normalized.slice(0, end)}${suffix}`;
    if (doc.widthOfString(candidate) <= maxWidth) return candidate;
    end -= 1;
  }
  return suffix;
}

function wrapTextLines(
  doc: PDFKit.PDFDocument,
  value: string,
  maxWidth: number,
): string[] {
  const normalized = (value || "").toString().replace(/\r\n/g, "\n").trim();
  if (!normalized) return [""];

  const lines: string[] = [];
  const paragraphs = normalized.split("\n");

  const pushLongWord = (word: string) => {
    let rest = word;
    while (rest) {
      let chunk = rest;
      while (chunk.length > 1 && doc.widthOfString(chunk) > maxWidth) {
        chunk = chunk.slice(0, -1);
      }
      lines.push(chunk);
      rest = rest.slice(chunk.length);
    }
  };

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (doc.widthOfString(candidate) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      if (doc.widthOfString(word) <= maxWidth) {
        current = word;
      } else {
        pushLongWord(word);
        current = "";
      }
    }
    if (current) lines.push(current);
  }

  return lines.length ? lines : [""];
}

function drawDocumentHeading(
  doc: PDFKit.PDFDocument,
  leftCol: number,
  pageWidth: number,
  title: string,
  docNumber: string,
  docDate: string,
  subtitle?: string,
) {
  doc.fontSize(14).font("MainBold");
  doc.text(title, leftCol, 30, { width: pageWidth, align: "center" });

  if (subtitle) {
    doc.fontSize(9).font("Main");
    doc.text(subtitle, leftCol, doc.y + 1, {
      width: pageWidth,
      align: "center",
    });
  }

  doc.fontSize(8).font("Main");
  doc.text(
    `Номер: ${docNumber}          Дата: ${formatDate(docDate)}`,
    leftCol,
    doc.y + 6,
    { width: pageWidth, align: "right" },
  );
  doc.moveDown(0.6);
}

function drawGridTable(
  doc: PDFKit.PDFDocument,
  leftCol: number,
  topY: number,
  columns: TableColumn[],
  rows: string[][],
  options?: {
    onPageBreak?: () => number;
    bottomY?: number;
    style?: {
      headerFillColor?: string | null;
      borderColor?: string;
      borderWidth?: number;
      zebraFillColor?: string | null;
      headerFontSize?: number;
      bodyFontSize?: number;
      horizontalPadding?: number;
      verticalPadding?: number;
      minRowHeight?: number;
      headerHeight?: number;
      bodyFontName?: string;
      headerFontName?: string;
    };
  },
) {
  const style = options?.style;
  const headerHeight = style?.headerHeight ?? 15;
  const minRowHeight = style?.minRowHeight ?? 15;
  const horizontalPadding = style?.horizontalPadding ?? 2;
  const verticalPadding = style?.verticalPadding ?? 4;
  const bodyFontSize = style?.bodyFontSize ?? 7;
  const headerFontSize = style?.headerFontSize ?? 7.2;
  const borderColor = style?.borderColor ?? "#444";
  const borderWidth = style?.borderWidth ?? 0.5;
  const headerFillColor =
    style?.headerFillColor === undefined ? "#ececec" : style.headerFillColor;
  const zebraFillColor =
    style?.zebraFillColor === undefined ? "#f9f9f9" : style.zebraFillColor;
  const bodyFontName = style?.bodyFontName ?? "Main";
  const headerFontName = style?.headerFontName ?? "MainBold";
  const tableWidth = columns.reduce((sum, col) => sum + col.width, 0);
  const wrapColumnIndex = columns.findIndex((col) => col.wrap);
  const getContentWidth = (col: TableColumn) =>
    Math.max(1, col.width - horizontalPadding * 2);
  const bottomY = options?.bottomY ?? doc.page.height - doc.page.margins.bottom;

  const drawHeader = (headerTopY: number) => {
    if (headerFillColor) {
      doc
        .rect(leftCol, headerTopY, tableWidth, headerHeight)
        .fill(headerFillColor);
      doc.fillColor("#000");
    }
    doc.lineWidth(borderWidth).strokeColor(borderColor);
    doc.rect(leftCol, headerTopY, tableWidth, headerHeight).stroke();

    let headerX = leftCol;
    for (let i = 0; i < columns.length; i += 1) {
      if (i > 0) {
        doc
          .moveTo(headerX, headerTopY)
          .lineTo(headerX, headerTopY + headerHeight)
          .stroke();
      }
      doc.font(headerFontName).fontSize(headerFontSize).fillColor("#000");
      doc.text(columns[i].header, headerX + 2, headerTopY + 4, {
        width: columns[i].width - 4,
        align: columns[i].align,
        lineBreak: false,
      });
      headerX += columns[i].width;
    }

    doc.strokeColor("#000");
    return headerTopY + headerHeight;
  };

  let rowTop = drawHeader(topY);
  doc.font(bodyFontName).fontSize(bodyFontSize);
  const lineHeight = doc.currentLineHeight(true);

  const startNewPage = () => {
    if (!options?.onPageBreak) {
      throw new Error("Table overflowed page without onPageBreak handler");
    }
    rowTop = drawHeader(options.onPageBreak());
    doc.font(bodyFontName).fontSize(bodyFontSize);
  };

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx += 1) {
    const row = rows[rowIdx];
    const wrappedLines =
      wrapColumnIndex >= 0
        ? wrapTextLines(
            doc,
            (row[wrapColumnIndex] ?? "").toString(),
            getContentWidth(columns[wrapColumnIndex]),
          )
        : [""];
    let lineOffset = 0;
    let isFirstSegment = true;

    while (lineOffset < wrappedLines.length) {
      const availableHeight = bottomY - rowTop;
      if (availableHeight < minRowHeight) {
        startNewPage();
        continue;
      }

      const availableLines = Math.max(
        1,
        Math.floor((availableHeight - verticalPadding * 2) / lineHeight),
      );
      const segmentLineCount = Math.min(
        wrappedLines.length - lineOffset,
        availableLines,
      );
      const rowHeight = Math.max(
        minRowHeight,
        Math.ceil(segmentLineCount * lineHeight + verticalPadding * 2),
      );

      if (zebraFillColor && rowIdx % 2 === 0) {
        doc.rect(leftCol, rowTop, tableWidth, rowHeight).fill(zebraFillColor);
        doc.fillColor("#000");
      }

      doc.lineWidth(borderWidth).strokeColor(borderColor);
      doc.rect(leftCol, rowTop, tableWidth, rowHeight).stroke();

      let cellX = leftCol;
      for (let colIdx = 0; colIdx < columns.length; colIdx += 1) {
        const col = columns[colIdx];
        if (colIdx > 0) {
          doc
            .moveTo(cellX, rowTop)
            .lineTo(cellX, rowTop + rowHeight)
            .stroke();
        }

        const width = getContentWidth(col);
        const rawValue = (row[colIdx] ?? "").toString().trim();
        const text = col.wrap
          ? wrappedLines
              .slice(lineOffset, lineOffset + segmentLineCount)
              .join("\n")
          : isFirstSegment
            ? fitToCell(doc, rawValue, width)
            : "";

        doc.font(bodyFontName).fontSize(bodyFontSize).fillColor("#000");
        doc.text(text, cellX + horizontalPadding, rowTop + verticalPadding, {
          width,
          align: col.align,
          lineBreak: !!col.wrap,
          height: rowHeight - verticalPadding * 2,
        });
        cellX += col.width;
      }

      rowTop += rowHeight;
      lineOffset += segmentLineCount;
      isFirstSegment = false;

      if (lineOffset < wrappedLines.length) {
        startNewPage();
      }
    }
  }

  doc.y = rowTop + 8;
}

function drawTotalsBlock(
  doc: PDFKit.PDFDocument,
  leftCol: number,
  pageWidth: number,
  totalNet: number,
  vatAmount: number,
  totalGross: number,
) {
  const blockWidth = 180;
  const labelWidth = 75;
  const valueWidth = blockWidth - labelWidth;
  const x = leftCol + pageWidth - blockWidth;
  let y = doc.y;

  const row = (label: string, value: number, bold = false) => {
    doc.font(bold ? "MainBold" : "Main").fontSize(bold ? 9 : 8);
    doc.text(label, x, y, { width: labelWidth, align: "left" });
    doc.text(`${formatEUR(value)} EUR`, x + labelWidth, y, {
      width: valueWidth,
      align: "right",
    });
    y += bold ? 13 : 12;
  };

  row("Сума:", totalNet);
  row("ДДС:", vatAmount);

  doc
    .moveTo(x, y - 1)
    .lineTo(x + blockWidth, y - 1)
    .lineWidth(0.5)
    .stroke();
  row("Общо:", totalGross, true);

  doc.y = y + 1;
}

function drawSignatures(
  doc: PDFKit.PDFDocument,
  leftCol: number,
  pageWidth: number,
  composedBy?: string,
) {
  const gap = 10;
  const colWidth = (pageWidth - gap * 2) / 3;
  const firstCol = leftCol;
  const secondCol = firstCol + colWidth + gap;
  const thirdCol = secondCol + colWidth + gap;
  const startY = doc.y;

  const drawField = (label: string, x: number, y: number) => {
    doc.text(label, x, y, { width: colWidth, align: "left" });
    const lineStart = x + 42;
    const lineY = y + 8;
    doc
      .moveTo(lineStart, lineY)
      .lineTo(x + colWidth, lineY)
      .lineWidth(0.5)
      .stroke();
  };

  doc.font("Main").fontSize(7.5);

  drawField("Получил:", firstCol, startY);
  drawField("Съставил:", secondCol, startY);
  drawField("Шифър:", secondCol, startY + 13);
  drawField("Предал:", thirdCol, startY);

  if (composedBy) {
    doc.fontSize(6.7).font("Main");
    doc.text(composedBy, secondCol + 44, startY - 1, {
      width: colWidth - 44,
      lineBreak: false,
    });
  }

  doc.font("Main").fontSize(6.2);
  doc.text("(име, подпис и печат)", firstCol, startY + 16, {
    width: colWidth,
    align: "left",
  });
  doc.text("(име и подпис)", thirdCol, startY + 16, {
    width: colWidth,
    align: "left",
  });

  doc.y = startY + 30;
}

function formatPartyLines(party: PartnerInfo): string[] {
  const lines: string[] = [];
  if (party.eik) lines.push(`ЕИК: ${party.eik}`);
  if (party.vat_number) lines.push(`ИН по ДДС: ${party.vat_number}`);
  if (party.city) lines.push(`Град: ${party.city}`);
  if (party.address) lines.push(`Адрес: ${normalizeAddress(party.address)}`);
  if (party.phone) lines.push(`Телефон: ${party.phone}`);
  if (party.mol) lines.push(`МОЛ: ${party.mol}`);
  return lines;
}

function drawIncomingPartyBoxes(
  doc: PDFKit.PDFDocument,
  leftCol: number,
  pageWidth: number,
  buyer: PartnerInfo,
  supplier: PartnerInfo,
  warehouseName?: string,
) {
  const gap = 10;
  const boxWidth = (pageWidth - gap) / 2;
  const leftX = leftCol;
  const rightX = leftX + boxWidth + gap;
  const padding = 4;
  const lineGap = 1.5;
  const startY = doc.y;
  const textWidth = boxWidth - padding * 2;

  const buyerLines = [buyer.name || "—", ...formatPartyLines(buyer)];
  const supplierLines = [supplier.name || "—", ...formatPartyLines(supplier)];

  const measureBoxHeight = (label: string, lines: string[]) => {
    let height = padding * 2;
    height +=
      Math.ceil(doc.heightOfString(label, { width: textWidth })) + lineGap;
    for (const [index, line] of lines.entries()) {
      const fontName = index === 0 ? "MainBold" : "Main";
      const fontSize = index === 0 ? 8 : 7.5;
      doc.font(fontName).fontSize(fontSize);
      height +=
        Math.ceil(doc.heightOfString(line || " ", { width: textWidth })) +
        lineGap;
    }
    return height;
  };

  const boxHeight = Math.max(
    measureBoxHeight("Получател / Купувач:", buyerLines),
    measureBoxHeight("Доставчик:", supplierLines),
  );

  const drawBox = (label: string, lines: string[], x: number) => {
    doc.rect(x, startY, boxWidth, boxHeight).lineWidth(0.5).stroke();

    let y = startY + padding;
    doc.font("MainBold").fontSize(8);
    doc.text(label, x + padding, y, { width: textWidth });
    y = doc.y + lineGap;

    for (const [index, line] of lines.entries()) {
      doc
        .font(index === 0 ? "MainBold" : "Main")
        .fontSize(index === 0 ? 8 : 7.5);
      doc.text(line, x + padding, y, { width: textWidth });
      y = doc.y + lineGap;
    }
  };

  drawBox("Получател / Купувач:", buyerLines, leftX);
  drawBox("Доставчик:", supplierLines, rightX);

  doc.y = startY + boxHeight + 4;
  if (warehouseName) {
    doc.font("Main").fontSize(7.5);
    doc.text(`Обект / склад: ${warehouseName}`, leftCol, doc.y, {
      width: pageWidth,
    });
    doc.moveDown(0.2);
  }
}

function drawIncomingTotalsBlock(
  doc: PDFKit.PDFDocument,
  leftCol: number,
  pageWidth: number,
  subtotal: number,
  discountTotal: number,
  total: number,
) {
  const blockWidth = 220;
  const labelWidth = 112;
  const valueWidth = blockWidth - labelWidth;
  const x = leftCol + pageWidth - blockWidth;
  let y = doc.y;

  const row = (
    label: string,
    value: number,
    bold = false,
    options?: { negative?: boolean },
  ) => {
    doc.font(bold ? "MainBold" : "Main").fontSize(bold ? 9 : 8);
    doc.text(label, x, y, { width: labelWidth, align: "left" });
    const prefix = options?.negative ? "-" : "";
    doc.text(`${prefix}${formatEUR(value)} EUR`, x + labelWidth, y, {
      width: valueWidth,
      align: "right",
    });
    y += bold ? 13 : 12;
  };

  row("Междинна сума:", subtotal);
  row("Отстъпка:", discountTotal, false, { negative: discountTotal > 0 });
  doc
    .moveTo(x, y - 1)
    .lineTo(x + blockWidth, y - 1)
    .lineWidth(0.5)
    .stroke();
  row("Общо:", total, true);

  doc.y = y + 1;
}

// ====================================================================
// ВХОДЯЩА СТОКОВА РАЗПИСКА (Incoming Stock Receipt)
// ====================================================================
export async function generateIncomingStockReceiptPdf(
  data: IncomingStockReceiptData,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 30, bottom: 30, left: 40, right: 40 },
    });

    const stream = fs.createWriteStream(data.outputPath);
    doc.pipe(stream);

    doc.registerFont("Main", FONT_REGULAR);
    doc.registerFont("MainBold", FONT_BOLD);

    const pageWidth = doc.page.width - 80;
    const leftCol = 40;

    drawDocumentHeading(
      doc,
      leftCol,
      pageWidth,
      "Стокова разписка",
      data.doc_number,
      data.doc_date,
      "за доставка на стоки",
    );

    if (data.reference_number) {
      doc.font("Main").fontSize(7.5);
      doc.text(
        `Основание: фактура № ${data.reference_number}`,
        leftCol,
        doc.y + 2,
        {
          width: pageWidth,
          align: "right",
        },
      );
      doc.moveDown(0.2);
    }

    drawIncomingPartyBoxes(
      doc,
      leftCol,
      pageWidth,
      data.buyer,
      data.supplier,
      data.warehouse_name,
    );

    doc.moveDown(0.4);
    doc
      .moveTo(leftCol, doc.y)
      .lineTo(leftCol + pageWidth, doc.y)
      .lineWidth(0.5)
      .stroke();
    doc.moveDown(0.3);

    let subtotal = 0;
    let discountTotal = 0;
    let total = 0;
    const rows: string[][] = [];

    for (let idx = 0; idx < data.items.length; idx += 1) {
      const item = data.items[idx];
      const qty = toNum(item.quantity);
      const price = toNum(item.unit_price);
      const baseTotal = qty * price;
      const rawLineTotal = toNum(item.total_price);
      const lineTotal = rawLineTotal > 0 ? rawLineTotal : baseTotal;
      const inferredDiscount =
        baseTotal > 0
          ? Math.max(0, ((baseTotal - lineTotal) / baseTotal) * 100)
          : 0;
      const discountPercent =
        item.discount_percent != null
          ? Math.max(0, toNum(item.discount_percent))
          : inferredDiscount;
      const discountAmount = Math.max(0, baseTotal - lineTotal);
      const currency = (item.currency || "EUR").toUpperCase();

      subtotal += baseTotal;
      discountTotal += discountAmount;
      total += lineTotal;

      rows.push([
        String(idx + 1),
        item.sku || "",
        item.name_bg || item.name_en || "—",
        mapUnit(item.unit || "бр"),
        qty.toFixed(3),
        formatEUR(price),
        currency,
        formatEUR(discountPercent),
        formatEUR(lineTotal),
      ]);
    }

    // Rebalanced for Стока column: widened Код to fit 12-digit
    // Microinvest SKUs, shrank numeric + currency/discount columns
    // which had visible slack for typical values, all slack goes
    // to Стока (RESIDUAL) so product names wrap less.
    const columns: TableColumn[] = [
      { header: "№", width: 22, align: "right" },
      { header: "Код", width: 60, align: "left" },
      {
        header: "Стока",
        width: pageWidth - (22 + 60 + 38 + 42 + 50 + 36 + 38 + 52),
        align: "left",
        wrap: true,
      },
      { header: "Мярка", width: 38, align: "left" },
      { header: "Кол.", width: 42, align: "right" },
      { header: "Ед. цена", width: 50, align: "right" },
      { header: "Валута", width: 36, align: "center" },
      { header: "Отст. %", width: 38, align: "right" },
      { header: "Стойност", width: 52, align: "right" },
    ];
    drawGridTable(doc, leftCol, doc.y, columns, rows, {
      onPageBreak: () => {
        doc.addPage();
        drawDocumentHeading(
          doc,
          leftCol,
          pageWidth,
          "Стокова разписка",
          data.doc_number,
          data.doc_date,
          "за доставка на стоки",
        );
        doc.font("Main").fontSize(7.5);
        doc.text("Продължение", leftCol, doc.y, {
          width: pageWidth,
          align: "center",
        });
        doc.moveDown(0.3);
        return doc.y;
      },
    });

    drawIncomingTotalsBlock(
      doc,
      leftCol,
      pageWidth,
      subtotal,
      discountTotal,
      total,
    );

    doc.font("Main").fontSize(7);
    doc.text("Всички стойности са в EUR.", leftCol, doc.y, {
      width: pageWidth,
    });
    doc.moveDown(0.2);

    doc.font("Main").fontSize(7.5);
    doc.text(`Словом: ${numberToWordsBG(total)}`, leftCol, doc.y, {
      width: pageWidth,
    });

    doc.moveDown(1.5);
    drawSignatures(doc, leftCol, pageWidth);

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

// ====================================================================
// СТОКОВА РАЗПИСКА (Stock Dispatch Note)
// ====================================================================
function drawStockDispatchHeading(
  doc: PDFKit.PDFDocument,
  leftCol: number,
  pageWidth: number,
  docNumber: string,
  docDate: string,
) {
  const titleY = 34;
  const infoWidth = 170;
  const titleWidth = pageWidth - infoWidth - 12;
  const infoX = leftCol + pageWidth - infoWidth;
  const centerX = leftCol;

  doc.font("StockSerifBold").fontSize(14);
  doc.text("Стокова разписка", centerX, titleY, {
    width: titleWidth,
    align: "center",
    underline: true,
  });
  doc.font("StockSerif").fontSize(10.5);
  doc.text("за продажба на стоки", centerX, titleY + 18, {
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

function drawStockDispatchPartyBoxes(
  doc: PDFKit.PDFDocument,
  leftCol: number,
  pageWidth: number,
  recipient: PartnerInfo,
  supplier: CompanyInfo,
  warehouseName?: string,
) {
  const gap = 10;
  const boxWidth = (pageWidth - gap) / 2;
  const leftX = leftCol;
  const rightX = leftX + boxWidth + gap;
  const startY = doc.y + 4;
  const padding = 4;
  const labelWidth = 40;
  const textWidth = boxWidth - padding * 2;
  const valueWidth = textWidth - labelWidth;
  const rowGap = 2;

  // Phone line intentionally dropped from both party blocks per МЕРТ-М
  // preference. МОЛ is rendered ONLY when populated (no empty "МОЛ" label
  // when the company / partner doesn't have one).
  // "Град" was dropped per cashier feedback — the city is already part of
  // the address line and the redundant row was eating vertical space.
  // Replaced by "ДДС №" so the recipient block carries the VAT id needed
  // on a Стокова разписка that doubles as a tax-relevant document.
  const rowsForPartner = (party: PartnerInfo) => [
    { label: "", value: party.name || "—", bold: true },
    { label: "ЕИК", value: party.eik || "" },
    ...(party.vat_number ? [{ label: "ДДС №", value: party.vat_number }] : []),
    { label: "Адрес", value: normalizeAddress(party.address || "") },
    ...(party.mol ? [{ label: "МОЛ", value: party.mol }] : []),
  ];
  const rowsForCompany = (party: CompanyInfo) => [
    { label: "", value: party.company_name || "—", bold: true },
    { label: "ЕИК", value: party.eik || "" },
    ...(party.vat_number ? [{ label: "ДДС №", value: party.vat_number }] : []),
    { label: "Адрес", value: normalizeAddress(party.address || "") },
    ...(party.mol ? [{ label: "МОЛ", value: party.mol }] : []),
  ];

  const measureBoxHeight = (
    title: string,
    rows: Array<{ label: string; value: string; bold?: boolean }>,
  ) => {
    let y = startY + padding;
    doc.font("StockSerifBold").fontSize(9);
    y +=
      Math.ceil(doc.heightOfString(title, { width: textWidth })) + rowGap + 1;
    for (const row of rows) {
      doc
        .font(row.bold ? "StockSerifBold" : "StockSerif")
        .fontSize(row.bold ? 9 : 8.4);
      const valueHeight = Math.ceil(
        doc.heightOfString(row.value || " ", { width: valueWidth }),
      );
      y += Math.max(11, valueHeight) + rowGap;
    }
    return y - startY + padding;
  };

  const recipientRows = rowsForPartner(recipient);
  const supplierRows = rowsForCompany(supplier);
  const boxHeight = Math.max(
    measureBoxHeight("Получател", recipientRows),
    measureBoxHeight("Доставчик", supplierRows),
  );

  const drawBox = (
    x: number,
    title: string,
    rows: Array<{ label: string; value: string; bold?: boolean }>,
  ) => {
    doc
      .rect(x, startY, boxWidth, boxHeight)
      .lineWidth(0.35)
      .strokeColor("#000")
      .stroke();
    let y = startY + padding;
    doc.font("StockSerifBold").fontSize(9);
    doc.text(title, x + padding, y, { width: textWidth, align: "left" });
    y = doc.y + rowGap + 1;

    for (const row of rows) {
      doc.font("StockSerif").fontSize(8.2);
      if (row.label) {
        doc.text(`${row.label}`, x + padding, y, {
          width: labelWidth,
          lineBreak: false,
        });
      }
      doc
        .font(row.bold ? "StockSerifBold" : "StockSerif")
        .fontSize(row.bold ? 9 : 8.2);
      doc.text(row.value || "", x + padding + labelWidth, y, {
        width: valueWidth,
        align: "left",
      });
      y +=
        Math.max(
          11,
          Math.ceil(
            doc.heightOfString(row.value || " ", { width: valueWidth }),
          ),
        ) + rowGap;
    }
  };

  drawBox(leftX, "Получател", recipientRows);
  drawBox(rightX, "Доставчик", supplierRows);

  doc.font("StockSerif").fontSize(8.6);
  doc.text(`Обект: ${warehouseName || ""}`, leftCol, startY + boxHeight + 6, {
    width: pageWidth,
  });
  doc.y = startY + boxHeight + 18;
}

function ensurePageSpace(
  doc: PDFKit.PDFDocument,
  requiredHeight: number,
  onPageBreak: () => void,
) {
  const available = doc.page.height - doc.page.margins.bottom - doc.y;
  if (available < requiredHeight) {
    doc.addPage();
    onPageBreak();
  }
}

// Officially-fixed BNB conversion rate (Bulgaria's eurozone entry,
// 2026-01-01). Hard-coded so every PDF uses the same number without
// looking it up at render time.
const STOCK_DISPATCH_EUR_TO_BGN = 1.95583;

function formatBgnLeva(amountEur: number): string {
  const bgn = Math.round(amountEur * STOCK_DISPATCH_EUR_TO_BGN * 100) / 100;
  return `${bgn.toFixed(2).replace(".", ",")} лв.`;
}

function drawStockDispatchTotalsBlock(
  doc: PDFKit.PDFDocument,
  leftCol: number,
  pageWidth: number,
  subtotalEur: number,
  vatEur: number,
  totalEur: number,
  pricingMode: "net" | "gross" = "net",
  showBgn: boolean = false,
) {
  // Two-column "BGN | EUR" layout when the toggle is on, single EUR
  // column otherwise. Matches the sample template the cashier
  // shared — small BGN/EUR header row above the figures, both
  // columns right-aligned, "Общо" row in bold.
  const labelWidth = 60;
  const eurColW = 70;
  const bgnColW = showBgn ? 80 : 0;
  const colGap = showBgn ? 10 : 0;
  const blockWidth = labelWidth + bgnColW + colGap + eurColW;
  const x = leftCol + pageWidth - blockWidth;
  const bgnX = x + labelWidth;
  const eurX = bgnX + bgnColW + colGap;
  const rowHeight = 13;
  let y = doc.y;

  if (showBgn) {
    doc.font("StockSerifBold").fontSize(8);
    doc.text("BGN", bgnX, y, { width: bgnColW, align: "right" });
    doc.text("EUR", eurX, y, { width: eurColW, align: "right" });
    y += rowHeight;
  }

  const drawRow = (label: string, eurValue: number, bold = false) => {
    const fontName = bold ? "StockSerifBold" : "StockSerif";
    const fontSize = bold ? 9 : 8.4;
    doc.font(fontName).fontSize(fontSize);
    doc.text(label, x, y, { width: labelWidth, align: "left" });
    if (showBgn) {
      doc.text(formatBgnLeva(eurValue), bgnX, y, {
        width: bgnColW,
        align: "right",
      });
    }
    doc.text(`${formatEUR(eurValue)} €`, eurX, y, {
      width: eurColW,
      align: "right",
    });
    y += rowHeight;
  };

  if (pricingMode === "gross") {
    drawRow("Общо", totalEur, true);
  } else {
    drawRow("Сума", subtotalEur);
    drawRow("ДДС", vatEur);
    doc
      .moveTo(x, y - 1)
      .lineTo(x + blockWidth, y - 1)
      .lineWidth(0.35)
      .strokeColor("#000")
      .stroke();
    drawRow("Общо", totalEur, true);
  }
  doc.y = y + 2;
}

function drawStockDispatchSignatures(
  doc: PDFKit.PDFDocument,
  leftCol: number,
  pageWidth: number,
) {
  const startY = doc.y;
  const rightX = leftCol + pageWidth - 210;
  const lineWidth = 112;

  doc.font("StockSerif").fontSize(8.5);
  doc.text("Получил:", leftCol, startY, { width: 46, lineBreak: false });
  doc
    .moveTo(leftCol + 44, startY + 9)
    .lineTo(leftCol + 44 + lineWidth, startY + 9)
    .lineWidth(0.35)
    .strokeColor("#000")
    .stroke();

  doc.font("StockSerif").fontSize(8.4);
  doc.text("Съставил: Служебен потребител, Шифър:", rightX, startY, {
    width: 210,
    align: "left",
  });
  doc
    .moveTo(rightX + 172, startY + 9)
    .lineTo(rightX + 208, startY + 9)
    .lineWidth(0.35)
    .strokeColor("#000")
    .stroke();

  doc.text("Предал:", rightX + 118, startY + 26, {
    width: 40,
    lineBreak: false,
  });
  doc
    .moveTo(rightX + 157, startY + 35)
    .lineTo(rightX + 157 + 53, startY + 35)
    .lineWidth(0.35)
    .strokeColor("#000")
    .stroke();

  doc.y = startY + 42;
}

export async function generateStockDispatchPdf(
  data: StockDispatchData,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 30, bottom: 30, left: 40, right: 40 },
    });

    const stream = fs.createWriteStream(data.outputPath);
    doc.pipe(stream);

    doc.registerFont("Main", FONT_REGULAR);
    doc.registerFont("MainBold", FONT_BOLD);
    doc.registerFont("StockSerif", SERIF_FONT_REGULAR);
    doc.registerFont("StockSerifBold", SERIF_FONT_BOLD);

    const pageWidth = doc.page.width - 80;
    const leftCol = 40;
    const reservedFooterSpace = 132;

    const drawContinuationHeading = () => {
      drawStockDispatchHeading(
        doc,
        leftCol,
        pageWidth,
        data.doc_number,
        data.doc_date,
      );
      doc.font("StockSerif").fontSize(8.2);
      doc.text("Продължение", leftCol, doc.y + 2, {
        width: pageWidth,
        align: "center",
      });
      doc.y += 14;
    };

    drawStockDispatchHeading(
      doc,
      leftCol,
      pageWidth,
      data.doc_number,
      data.doc_date,
    );
    drawStockDispatchPartyBoxes(
      doc,
      leftCol,
      pageWidth,
      data.partner,
      data.company,
      data.warehouse_name,
    );

    // МЕРТ-М: order_items.unit_price is GROSS (price already includes VAT).
    // - pricing_mode="gross" (default for Стокова разписка): show price
    //   AS-IS, single "Общо" line at the bottom (no VAT breakdown).
    // - pricing_mode="net": divide gross price by (1+vat) to display net
    //   base + VAT line + total breakdown.
    const pricingMode: "net" | "gross" = data.pricing_mode ?? "gross";
    const vatMultiplier = 1 + data.vat_rate / 100;
    let subtotalEur = 0;
    const rows: string[][] = [];
    for (let idx = 0; idx < data.items.length; idx += 1) {
      const item = data.items[idx];
      const qty = toNum(item.quantity);
      const price = toNum(item.unit_price);
      const baseTotal = qty * price;
      const explicitTotal = toNum(item.total_price);
      const lineTotal = explicitTotal > 0 ? explicitTotal : baseTotal;
      const inferredDiscount =
        baseTotal > 0
          ? Math.max(0, ((baseTotal - lineTotal) / baseTotal) * 100)
          : 0;
      const discount =
        item.discount_percent != null
          ? Math.max(0, toNum(item.discount_percent))
          : inferredDiscount;
      subtotalEur += lineTotal;

      // gross mode → display the stored price; net mode → strip VAT.
      const displayPrice =
        pricingMode === "gross" ? price : price / vatMultiplier;
      const displayLineTotal =
        pricingMode === "gross" ? lineTotal : lineTotal / vatMultiplier;

      rows.push([
        String(idx + 1),
        item.sku || "",
        item.name_bg || item.name_en || "—",
        mapUnit(item.unit || "бр"),
        formatQty(qty),
        formatEUR(displayPrice),
        (item.currency || "EUR").toUpperCase(),
        formatDiscount(discount),
        formatEUR(displayLineTotal),
      ]);
    }

    // Same rebalance pattern as стокова разписка — широк Код за
    // 12-цифрените SKU, компактни числа, остатъкът за Стока.
    const columns: TableColumn[] = [
      { header: "№", width: 22, align: "right" },
      { header: "Код", width: 60, align: "left" },
      {
        header: "Стока",
        width: pageWidth - (22 + 60 + 38 + 42 + 50 + 36 + 44 + 48),
        align: "left",
        wrap: true,
      },
      { header: "Мярка", width: 38, align: "center" },
      { header: "Кол.", width: 42, align: "right" },
      { header: "Цена", width: 50, align: "right" },
      { header: "Валута", width: 36, align: "center" },
      { header: "Отстъпка", width: 44, align: "right" },
      { header: "Ст-ст", width: 48, align: "right" },
    ];

    drawGridTable(doc, leftCol, doc.y, columns, rows, {
      bottomY: doc.page.height - doc.page.margins.bottom - reservedFooterSpace,
      onPageBreak: () => {
        doc.addPage();
        drawContinuationHeading();
        return doc.y;
      },
      style: {
        headerFillColor: null,
        zebraFillColor: null,
        borderColor: "#000",
        borderWidth: 0.35,
        headerFontSize: 8,
        bodyFontSize: 7.6,
        horizontalPadding: 2,
        verticalPadding: 4,
        minRowHeight: 15,
        headerHeight: 15,
        bodyFontName: "StockSerif",
        headerFontName: "StockSerifBold",
      },
    });

    // subtotalEur is the sum of GROSS line totals (price stored gross).
    // For "gross" mode the total IS the gross sum (no breakdown).
    // For "net" mode we extract the net base + VAT from the gross sum.
    const totalGrossEur = subtotalEur;
    const totalNetEur =
      pricingMode === "gross" ? subtotalEur : subtotalEur / vatMultiplier;
    const vatAmountEur = totalGrossEur - totalNetEur;

    ensurePageSpace(doc, 110, drawContinuationHeading);
    drawStockDispatchTotalsBlock(
      doc,
      leftCol,
      pageWidth,
      totalNetEur,
      vatAmountEur,
      totalGrossEur,
      pricingMode,
      data.show_bgn === true,
    );

    doc.font("StockSerif").fontSize(8.5);
    doc.text(
      `Словом: ${numberToWordsBG(totalGrossEur, "EUR")}`,
      leftCol,
      doc.y,
      {
        width: pageWidth - 220,
        align: "left",
      },
    );
    doc.moveDown(1.2);

    ensurePageSpace(doc, 55, drawContinuationHeading);
    drawStockDispatchSignatures(doc, leftCol, pageWidth);

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

// ====================================================================
// ТЪРГОВСКИ ДОКУМЕНТ (Commercial Document)
// ====================================================================
export async function generateCommercialDocPdf(
  data: CommercialDocData,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 30, bottom: 30, left: 40, right: 40 },
    });

    const stream = fs.createWriteStream(data.outputPath);
    doc.pipe(stream);

    doc.registerFont("Main", FONT_REGULAR);
    doc.registerFont("MainBold", FONT_BOLD);

    const pageWidth = doc.page.width - 80;
    const leftCol = 40;
    const rightCol = doc.page.width / 2 + 10;
    const colWidth = pageWidth / 2 - 10;

    drawDocumentHeading(
      doc,
      leftCol,
      pageWidth,
      "Търговски документ",
      data.doc_number,
      data.doc_date,
      "за продажба на стоки",
    );

    // Breathing room between title and boxed party headers
    doc.moveDown(1.2);

    // ── Parties ──
    drawPartyHeaders(
      doc,
      data.company,
      data.partner,
      leftCol,
      rightCol,
      colWidth,
    );

    // Veterinary registration number
    if (data.company.vet_reg_number) {
      doc.font("Main").fontSize(7.5);
      doc.text(
        `Ветеринарен регистрационен №: ${data.company.vet_reg_number}`,
        leftCol,
        doc.y + 2,
        { width: pageWidth },
      );
    }

    doc.moveDown(0.4);
    doc
      .moveTo(leftCol, doc.y)
      .lineTo(leftCol + pageWidth, doc.y)
      .lineWidth(0.5)
      .stroke();
    doc.moveDown(0.3);

    const rows: string[][] = [];
    for (let idx = 0; idx < data.items.length; idx += 1) {
      const item = data.items[idx];
      const qty = toNum(item.quantity);
      const expiryStr = item.expiry_date ? formatDate(item.expiry_date) : "-";

      rows.push([
        String(idx + 1),
        item.sku || "",
        item.name_bg || item.name_en || "—",
        mapUnit(item.unit || "бр"),
        item.batch_number || "-",
        expiryStr,
        qty.toFixed(3),
      ]);
    }

    // Search/expiry + qty-only variant — Кол. колоната беше 63pt
    // за стойности като "3.000" (~20pt). Прибираме 15pt, Мярка/
    // Годност/Партида по малко всеки — всичко отива в Стока.
    const columns: TableColumn[] = [
      { header: "№", width: 22, align: "right" },
      { header: "Код", width: 60, align: "left" },
      {
        header: "Стока",
        width: pageWidth - (22 + 60 + 40 + 68 + 64 + 48),
        align: "left",
        wrap: true,
      },
      { header: "Мярка", width: 40, align: "left" },
      { header: "Партида", width: 68, align: "left" },
      { header: "Годност", width: 64, align: "center" },
      { header: "Кол.", width: 48, align: "right" },
    ];
    drawGridTable(doc, leftCol, doc.y, columns, rows, {
      onPageBreak: () => {
        doc.addPage();
        drawDocumentHeading(
          doc,
          leftCol,
          pageWidth,
          "Търговски документ за продажба на стоки",
          data.doc_number,
          data.doc_date,
        );
        doc.font("Main").fontSize(7.5);
        doc.text("Продължение", leftCol, doc.y, {
          width: pageWidth,
          align: "center",
        });
        doc.moveDown(0.3);
        return doc.y;
      },
    });

    doc.fontSize(6.8).font("Main");
    doc.text(
      "Декларирам, че горепосочените продукти са предназначени за човешка консумация и са произведени съгласно регламентите на ЕС, касаещи безопасността на храните.",
      leftCol,
      doc.y,
      { width: pageWidth },
    );

    doc.moveDown(1.5);

    drawSignatures(doc, leftCol, pageWidth);

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}
