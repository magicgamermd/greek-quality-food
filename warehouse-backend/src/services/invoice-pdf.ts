import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { formatEurAmount, toEurAmount } from "../utils/currency.js";
import { mapUnit } from "./units.js";

// Resolve font paths — works in both src/ and dist/
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

function formatVatRate(rate: number): string {
  if (!Number.isFinite(rate)) return "0";
  const rounded = Math.round(rate * 100) / 100;
  return rounded.toFixed(2).replace(/\.?0+$/, "");
}

interface InvoiceItem {
  name_bg: string;
  name_en: string;
  sku: string;
  unit: string;
  brand?: string | null;
  quantity: string | number;
  unit_price: string | number;
  // Отстъпка % за реда (0–100). Липсваща стойност се третира като 0.
  // Самият total_price вече е post-discount (смята се при INSERT в DB),
  // така че това поле е само за визуално показване в колоната "Отст. %".
  discount_percent?: string | number | null;
  total_price: string | number;
}

interface CompanySettings {
  company_name: string;
  address: string;
  city?: string;
  eik: string;
  vat_number: string;
  iban: string;
  phone: string;
  email: string;
  bank_name?: string;
  bic?: string;
  mol?: string;
}

interface InvoiceData {
  invoice: {
    invoice_number: string;
    invoice_date: string;
    total_net: string | number;
    total_vat: string | number;
    total_gross: string | number;
    currency?: string | null;
    /** Payment method — defaults to "bank" if not set (most common for B2B) */
    payment_method?: "cash" | "bank" | "cod" | null;
    /** Optional override label — if set, used verbatim instead of mapping */
    payment_method_label?: string | null;
    /** ЗДДС чл. 114, ал. 1, т.12 — reason when VAT is not charged */
    vat_exemption_reason?: string | null;
    /** ЗДДС чл. 116 — reason for credit note issuance */
    credit_note_reason?: string | null;
    /** Place of transaction (falls back to company.city) */
    transaction_place?: string | null;
    /** Legal basis for the transaction */
    transaction_basis?: string | null;
    /** Buyer name override for individual customers who want the invoice on a specific name */
    client_display_name?: string | null;
  };
  partner: {
    name: string;
    eik?: string;
    vat_number?: string;
    address?: string;
    city?: string;
    contact_person?: string;
    phone?: string;
    card_number?: string;
    bank_name?: string;
    bic?: string;
    iban?: string;
    partner_type?: string | null;
  };
  company: CompanySettings;
  items: InvoiceItem[];
  vatRate: number;
  includeVat?: boolean;
  documentType?: "invoice" | "credit_note";
  relatedInvoiceNumber?: string;
  sourceCurrency?: string | null;
  outputPath: string;
  /**
   * Number of identical „Оригинал"-labeled pages to render. Default `1`.
   * When `2`, both pages get the „Оригинал" label.
   */
  copies?: 1 | 2;
}

function formatEur(
  num: number | string,
  sourceCurrency?: string | null,
): string {
  return formatEurAmount(num, sourceCurrency);
}

function formatDate(date: string): string {
  const d = new Date(date);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function toNum(v: string | number): number {
  return typeof v === "string" ? parseFloat(v) : v;
}

// Ensure space before house number in addresses
function normalizeAddress(addr: string): string {
  return addr.replace(/([a-zA-Zа-яА-ЯёЁ])(\d)/g, "$1 $2");
}

// ── Number to words (Bulgarian) ──
function numberToWordsBG(n: number): string {
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

  if (n === 0) return "нула евро";

  // Handle negative amounts (credit notes) — recurse on absolute value + prefix
  if (n < 0) {
    const abs = numberToWordsBG(-n);
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

  if (decimals > 0) {
    words += ` евро и ${String(decimals).padStart(2, "0")} цента`;
  } else {
    words += " евро";
  }

  return words;
}

// ── Thin horizontal line helper ──
function drawLine(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  width: number,
  lineWidth = 0.5,
) {
  doc
    .moveTo(x, y)
    .lineTo(x + width, y)
    .lineWidth(lineWidth)
    .strokeColor("#000")
    .stroke();
}

interface InvoiceTableColumn {
  header: string;
  w: number;
  align: "left" | "right" | "center";
  wrap: boolean;
}

interface InvoicePartyField {
  label: string;
  value: string;
  bold?: boolean;
}

export function wrapTextToLines(
  doc: PDFKit.PDFDocument,
  text: string,
  width: number,
): string[] {
  const normalized = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!normalized) return [""];

  const lines: string[] = [];
  const paragraphs = normalized.split("\n");

  const pushWrappedWord = (word: string) => {
    let rest = word;
    while (rest) {
      let slice = rest;
      while (slice.length > 1 && doc.widthOfString(slice) > width) {
        slice = slice.slice(0, -1);
      }
      lines.push(slice);
      rest = rest.slice(slice.length);
    }
  };

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }

    let currentLine = "";
    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (doc.widthOfString(candidate) <= width) {
        currentLine = candidate;
        continue;
      }

      if (currentLine) {
        lines.push(currentLine);
        currentLine = "";
      }

      if (doc.widthOfString(word) <= width) {
        currentLine = word;
      } else {
        pushWrappedWord(word);
      }
    }

    if (currentLine) lines.push(currentLine);
  }

  return lines.length ? lines : [""];
}

export function calculateLineSegments(
  totalLines: number,
  capacityPerPage: number[],
): number[] {
  let remaining = Math.max(0, totalLines);
  const segments: number[] = [];

  for (const capacity of capacityPerPage) {
    if (remaining <= 0) break;
    const safeCapacity = Math.max(1, Math.floor(capacity));
    const segment = Math.min(remaining, safeCapacity);
    segments.push(segment);
    remaining -= segment;
  }

  while (remaining > 0) {
    const fallback = Math.max(1, Math.floor(capacityPerPage.at(-1) ?? 1));
    const segment = Math.min(remaining, fallback);
    segments.push(segment);
    remaining -= segment;
  }

  return segments;
}

export function measurePartyFieldsHeight(
  doc: PDFKit.PDFDocument,
  fields: InvoicePartyField[],
  valueWidth: number,
  options?: { fontSize?: number; minFieldHeight?: number; gap?: number },
): number {
  const fontSize = options?.fontSize ?? 7.5;
  const minFieldHeight = options?.minFieldHeight ?? 11;
  const gap = options?.gap ?? 1.5;

  doc.fontSize(fontSize);
  let totalHeight = 0;

  for (const field of fields) {
    const valueHeight = doc.heightOfString(field.value || " ", {
      width: valueWidth,
      align: "left",
    });
    totalHeight += Math.max(minFieldHeight, Math.ceil(valueHeight)) + gap;
  }

  return totalHeight;
}

function drawPartyFields(
  doc: PDFKit.PDFDocument,
  x: number,
  startY: number,
  labelWidth: number,
  valueWidth: number,
  fields: InvoicePartyField[],
): number {
  let y = startY;
  const fontSize = 7.5;
  const gap = 1.5;
  const minFieldHeight = 11;

  for (const field of fields) {
    const valueHeight = doc.heightOfString(field.value || " ", {
      width: valueWidth,
      align: "left",
    });
    const rowHeight = Math.max(minFieldHeight, Math.ceil(valueHeight));

    doc.font("Main").fontSize(fontSize);
    if (field.label) {
      doc.text(field.label, x, y, { width: labelWidth, lineBreak: false });
    }

    doc.font(field.bold ? "MainBold" : "Main").fontSize(fontSize);
    doc.text(field.value, x + labelWidth, y, {
      width: valueWidth,
      align: "left",
    });

    y += rowHeight + gap;
  }

  return y;
}

/** Measure the height needed to draw party fields inside a box (title + fields + padding). */
function measurePartyBox(
  doc: PDFKit.PDFDocument,
  title: string,
  fields: InvoicePartyField[],
  innerWidth: number,
  labelWidth: number,
): number {
  const padding = 6;
  const fontSize = 7.5;
  const gap = 1.5;
  const minFieldHeight = 11;
  const valueWidth = innerWidth - labelWidth - padding * 2;

  doc.font("MainBold").fontSize(8);
  const titleHeight = Math.ceil(
    doc.heightOfString(title, { width: innerWidth - padding * 2 }),
  );

  let height = padding + titleHeight + 4; // title + small gap
  for (const field of fields) {
    doc.font(field.bold ? "MainBold" : "Main").fontSize(fontSize);
    const vh = Math.ceil(
      doc.heightOfString(field.value || " ", { width: valueWidth }),
    );
    height += Math.max(minFieldHeight, vh) + gap;
  }
  return height + padding;
}

/**
 * Draws a bordered box containing a title ("Получател" / "Доставчик")
 * and the party fields underneath.
 */
function drawPartyBox(
  doc: PDFKit.PDFDocument,
  x: number,
  startY: number,
  boxWidth: number,
  boxHeight: number,
  title: string,
  fields: InvoicePartyField[],
  labelWidth: number,
): void {
  const padding = 6;

  doc
    .rect(x, startY, boxWidth, boxHeight)
    .lineWidth(0.5)
    .strokeColor("#000")
    .stroke();

  // Title
  doc.font("MainBold").fontSize(8);
  doc.text(title, x + padding, startY + padding, {
    width: boxWidth - padding * 2,
    lineBreak: false,
  });

  const titleHeight = Math.ceil(
    doc.heightOfString(title, { width: boxWidth - padding * 2 }),
  );

  const fieldsStartY = startY + padding + titleHeight + 4;
  const valueWidth = boxWidth - labelWidth - padding * 2;

  drawPartyFields(
    doc,
    x + padding,
    fieldsStartY,
    labelWidth,
    valueWidth,
    fields,
  );
}

function buildInvoicePartyFields(
  party: InvoiceData["partner"],
  company: InvoiceData["company"],
  clientDisplayName?: string | null,
): { buyerFields: InvoicePartyField[]; supplierFields: InvoicePartyField[] } {
  const buyerAddressParts = [
    party.city ? `гр. ${party.city}` : "",
    party.address ? normalizeAddress(party.address) : "",
  ].filter(Boolean);

  const isIndividualBuyer = party.partner_type === "individual";
  const buyerName =
    (clientDisplayName && clientDisplayName.trim().length > 0
      ? clientDisplayName.trim()
      : party.name) || "Физическо лице — краен потребител";
  const buyerLabel = isIndividualBuyer ? "Клиент:" : "МП:";

  const buyerFields: InvoicePartyField[] = [
    { label: buyerLabel, value: buyerName, bold: true },
    ...(!isIndividualBuyer && party.eik
      ? [{ label: "ЕИК:", value: party.eik }]
      : []),
    ...(!isIndividualBuyer && party.vat_number
      ? [{ label: "ДДС номер:", value: party.vat_number }]
      : []),
    ...(buyerAddressParts.length
      ? [{ label: "Адрес:", value: buyerAddressParts.join("\n") }]
      : []),
    ...(!isIndividualBuyer && party.contact_person
      ? [{ label: "МОЛ:", value: party.contact_person }]
      : []),
    ...(party.phone ? [{ label: "Тел:", value: party.phone }] : []),
    ...(!isIndividualBuyer && party.card_number
      ? [{ label: "Кл.номер:", value: party.card_number }]
      : []),
    ...(!isIndividualBuyer && party.bank_name
      ? [{ label: "Банка:", value: party.bank_name }]
      : []),
    ...(!isIndividualBuyer && party.bic
      ? [{ label: "BIC:", value: party.bic }]
      : []),
    ...(!isIndividualBuyer && party.iban
      ? [{ label: "IBAN:", value: party.iban }]
      : []),
  ];

  const supplierAddress = normalizeAddress(company.address);
  // Bank info (Банка/BIC/IBAN) intentionally omitted here — shown in the
  // payment section at the bottom of the invoice to avoid duplication.
  const supplierFields: InvoicePartyField[] = [
    { label: "", value: company.company_name, bold: true },
    { label: "ЕИК:", value: company.eik },
    ...(company.vat_number
      ? [{ label: "ДДС номер:", value: company.vat_number }]
      : []),
    ...(supplierAddress ? [{ label: "Адрес:", value: supplierAddress }] : []),
    ...(company.phone ? [{ label: "Тел:", value: company.phone }] : []),
    ...(company.email ? [{ label: "Email:", value: company.email }] : []),
    ...(company.mol ? [{ label: "МОЛ:", value: company.mol }] : []),
  ];

  return { buyerFields, supplierFields };
}

function drawInvoiceTableHeader(
  doc: PDFKit.PDFDocument,
  left: number,
  top: number,
  pageWidth: number,
  columns: InvoiceTableColumn[],
): number {
  const headerH = 16;
  doc.rect(left, top, pageWidth, headerH).lineWidth(0.5).stroke();
  doc.fontSize(7).font("MainBold");

  let xPos = left;
  for (const col of columns) {
    if (xPos > left) {
      doc
        .moveTo(xPos, top)
        .lineTo(xPos, top + headerH)
        .lineWidth(0.3)
        .stroke();
    }
    doc.text(col.header, xPos + 2, top + 4, {
      width: col.w - 4,
      align: col.align,
    });
    xPos += col.w;
  }

  return top + headerH;
}

export async function generateInvoicePdf(data: InvoiceData): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 30, bottom: 30, left: 40, right: 40 },
    });

    const stream = fs.createWriteStream(data.outputPath);
    doc.pipe(stream);

    const copies = data.copies ?? 1;

    // Register Cyrillic-capable fonts
    doc.registerFont("Main", FONT_REGULAR);
    doc.registerFont("MainBold", FONT_BOLD);

    const pageMargins = { top: 30, bottom: 30, left: 40, right: 40 };
    const L = pageMargins.left; // left margin
    const pageW = doc.page.width - pageMargins.left - pageMargins.right; // usable width
    const R = L + pageW; // right edge
    const midX = L + pageW / 2;

    const isCreditNote = data.documentType === "credit_note";
    const showVat = data.includeVat !== false;
    const sourceCurrency = data.invoice.currency ?? data.sourceCurrency ?? null;
    const co = data.company;
    const partner = data.partner;

    const vatRateLabel = formatVatRate(data.vatRate);
    // Код column is widened to comfortably fit Microinvest 12-digit SKUs
    // (e.g. 010503320002) at fontSize 7 — the previous 44pt cell was
    // ~3pt shy of the text width and PDFKit silently wrapped despite
    // lineBreak:false, pushing the tail onto the next row and breaking
    // the table grid. Стока column absorbs the extra width so the total
    // table stays the same.
    // Column balance tuned for typical Bulgarian invoices (суми под
    // 10 000 лв/€). Стойност е фиксирано на 48/52pt, което все още
    // побира 99 999,99 (~34pt при fontSize 7) с комфортен padding.
    // Целият остатък от page width отива към Стока, така продуктовите
    // имена се wrap-ват минимално.
    // "Отст. %" колона е добавена между Цена и ДДС / Стойност. 36pt
    // побира "100.0%" (~28pt при fontSize 7) с комфортен padding.
    // Стока абсорбира намалението.
    const colDefs: InvoiceTableColumn[] = showVat
      ? [
          { header: "№", w: 18, align: "center", wrap: false },
          { header: "Код", w: 56, align: "left", wrap: false },
          {
            header: "Стока",
            w: pageW - 18 - 56 - 42 - 34 - 46 - 36 - 42 - 48,
            align: "left",
            wrap: true,
          },
          { header: "Мярка", w: 42, align: "left", wrap: false },
          { header: "Кол.", w: 34, align: "right", wrap: false },
          { header: "Цена", w: 46, align: "right", wrap: false },
          { header: "Отст.%", w: 36, align: "right", wrap: false },
          {
            header: `ДДС ${vatRateLabel}%`,
            w: 42,
            align: "center",
            wrap: false,
          },
          {
            header: "Стойност",
            w: 48,
            align: "right",
            wrap: false,
          },
        ]
      : [
          { header: "№", w: 18, align: "center", wrap: false },
          { header: "Код", w: 60, align: "left", wrap: false },
          {
            header: "Стока",
            w: pageW - 18 - 60 - 44 - 36 - 50 - 36 - 52,
            align: "left",
            wrap: true,
          },
          { header: "Мярка", w: 44, align: "left", wrap: false },
          { header: "Кол.", w: 36, align: "right", wrap: false },
          { header: "Цена", w: 50, align: "right", wrap: false },
          { header: "Отст.%", w: 36, align: "right", wrap: false },
          {
            header: "Стойност",
            w: 52,
            align: "right",
            wrap: false,
          },
        ];
    const wrapColIndex = colDefs.findIndex((col) => col.wrap);
    const rowPaddingY = 3;
    const minRowH = 14;
    const footerText =
      "Документът е валиден без печат и подпис при електронно издаване.";
    const { buyerFields, supplierFields } = buildInvoicePartyFields(
      partner,
      co,
      data.invoice.client_display_name ?? null,
    );

    const drawPageHeader = (
      copyLabel: string | null,
      continuation = false,
    ): { tableStartY: number; rightColX: number; rValW: number } => {
      let y = 35;
      const title = isCreditNote ? "Кредитно Известие" : "Фактура";
      const colW = pageW / 2 - 10;
      const leftColX = L;
      const rightColX = midX + 10;
      const labelW = 65;
      const rLabelW = 70;
      const valW = colW - labelW;
      const rValW = colW - rLabelW;

      // Main title
      doc.fillColor("#000").fontSize(14).font("MainBold");
      doc.text(title, L, y, { align: "center", width: pageW });

      // Right side: Номер + Дата, aligned with title top
      doc.fontSize(9).font("MainBold");
      doc.text(`Номер ${data.invoice.invoice_number}`, R - 180, y, {
        width: 180,
        align: "right",
      });
      doc.text(
        `Дата ${formatDate(data.invoice.invoice_date)}`,
        R - 180,
        y + 18,
        {
          width: 180,
          align: "right",
        },
      );

      // Copy label ("Оригинал" / "Копие") — smaller, right under main title
      if (copyLabel) {
        doc.fontSize(9).font("Main").fillColor("#555");
        doc.text(copyLabel, L, y + 20, {
          align: "center",
          width: pageW,
        });
        doc.fillColor("#000");
      }

      if (isCreditNote && data.relatedInvoiceNumber) {
        doc.fontSize(8).font("Main");
        doc.text(`Към фактура: ${data.relatedInvoiceNumber}`, R - 180, y + 36, {
          width: 180,
          align: "right",
        });
      }

      // Leave breathing room before the party boxes
      y += 52;

      if (continuation) {
        doc.fontSize(7.5).font("Main");
        doc.text("Продължение", L, y, { width: pageW, align: "center" });
        y += 14;
        return { tableStartY: y, rightColX, rValW };
      }

      // Boxed party blocks — same style as stokova razpiska
      const leftBoxH = measurePartyBox(
        doc,
        "Получател",
        buyerFields,
        colW,
        labelW,
      );
      const rightBoxH = measurePartyBox(
        doc,
        "Доставчик",
        supplierFields,
        colW,
        rLabelW,
      );
      const boxH = Math.max(leftBoxH, rightBoxH);

      drawPartyBox(
        doc,
        leftColX,
        y,
        colW,
        boxH,
        "Получател",
        buyerFields,
        labelW,
      );
      drawPartyBox(
        doc,
        rightColX,
        y,
        colW,
        boxH,
        "Доставчик",
        supplierFields,
        rLabelW,
      );
      y += boxH + 6;

      // ЗДДС чл. 114, ал. 1, т. 12+13 — legal basis + place of transaction
      doc.fontSize(7.5).font("Main");
      const basisText =
        data.invoice.transaction_basis ||
        (data.includeVat === false
          ? data.invoice.vat_exemption_reason ||
            "Освободена доставка по чл. 28 ЗДДС"
          : "Продажба на стоки съгласно сключения договор");
      doc.text("Основание за сделката: ", L, y, {
        width: pageW,
        continued: true,
      });
      doc.font("MainBold").text(basisText, { width: pageW - 120 });
      y += 11;

      doc.font("Main");
      const placeText =
        data.invoice.transaction_place ||
        co.city ||
        (co.address ? co.address.split(",").pop()?.trim() : null) ||
        "София, България";
      doc.text("Място на сделката: ", L, y, {
        width: pageW,
        continued: true,
      });
      doc.font("MainBold").text(placeText, { width: pageW - 120 });
      y += 14;

      // Credit note basis (чл. 116 ЗДДС)
      if (
        data.documentType === "credit_note" &&
        data.invoice.credit_note_reason
      ) {
        doc.font("Main");
        doc.text("Основание за издаване (КИ): ", L, y, {
          width: pageW,
          continued: true,
        });
        doc.font("MainBold").text(data.invoice.credit_note_reason, {
          width: pageW - 180,
        });
        y += 14;
      }

      return { tableStartY: y, rightColX, rValW };
    };

    const drawFooter = () => {
      doc.fillColor("#888").fontSize(6).font("Main");
      doc.text(footerText, L, doc.page.height - 40, {
        width: pageW,
        align: "center",
      });
      doc.fillColor("#000");
    };

    const renderCopy = (copyLabel: string | null) => {
      let { tableStartY, rightColX, rValW } = drawPageHeader(copyLabel);
      let rowY = drawInvoiceTableHeader(doc, L, tableStartY, pageW, colDefs);
      const tableBodyBottom = doc.page.height - pageMargins.bottom;

      doc.font("Main").fontSize(7);
      const lineHeight = doc.currentLineHeight(true);

      const startNewTablePage = () => {
        drawFooter();
        doc.addPage({ size: "A4", margins: pageMargins });
        const header = drawPageHeader(copyLabel, true);
        rightColX = header.rightColX;
        rValW = header.rValW;
        rowY = drawInvoiceTableHeader(
          doc,
          L,
          header.tableStartY,
          pageW,
          colDefs,
        );
        doc.font("Main").fontSize(7);
      };

      for (let idx = 0; idx < data.items.length; idx += 1) {
        const item = data.items[idx];
        const qty = toNum(item.quantity);
        const price = toNum(item.unit_price);
        const total = toNum(item.total_price);
        const description = item.name_bg || item.name_en;
        const unit = mapUnit(item.unit);
        // Форматираме отстъпката компактно: 0 → "—" (видимо различно от
        // реално 0% ако някой го въведе изрично), иначе "10%" или "12.5%".
        const discountPct = toNum(item.discount_percent ?? 0);
        const discountLabel =
          discountPct > 0
            ? `${Number.isInteger(discountPct) ? discountPct.toFixed(0) : discountPct.toFixed(1)}%`
            : "—";
        const values = showVat
          ? [
              String(idx + 1),
              item.sku || "",
              description,
              unit,
              qty.toFixed(3),
              formatEur(price, sourceCurrency),
              discountLabel,
              `${vatRateLabel}%`,
              formatEur(total, sourceCurrency),
            ]
          : [
              String(idx + 1),
              item.sku || "",
              description,
              unit,
              qty.toFixed(3),
              formatEur(price, sourceCurrency),
              discountLabel,
              formatEur(total, sourceCurrency),
            ];

        const wrapCol = colDefs[wrapColIndex];
        const descriptionLines = wrapTextToLines(
          doc,
          values[wrapColIndex],
          wrapCol.w - 4,
        );
        let lineOffset = 0;
        let firstSegment = true;

        while (lineOffset < descriptionLines.length) {
          const availableHeight = tableBodyBottom - rowY;
          if (availableHeight < minRowH) {
            startNewTablePage();
            continue;
          }

          const availableLines = Math.max(
            1,
            Math.floor((availableHeight - rowPaddingY * 2) / lineHeight),
          );
          const segmentLineCount = Math.min(
            descriptionLines.length - lineOffset,
            availableLines,
          );
          const rowH = Math.max(
            minRowH,
            Math.ceil(segmentLineCount * lineHeight + rowPaddingY * 2),
          );

          doc.rect(L, rowY, pageW, rowH).lineWidth(0.3).stroke();

          let xPos = L;
          for (let i = 0; i < colDefs.length; i += 1) {
            const col = colDefs[i];
            if (xPos > L) {
              doc
                .moveTo(xPos, rowY)
                .lineTo(xPos, rowY + rowH)
                .lineWidth(0.3)
                .stroke();
            }

            const rawContent = col.wrap
              ? descriptionLines
                  .slice(lineOffset, lineOffset + segmentLineCount)
                  .join("\n")
              : firstSegment
                ? values[i]
                : "";

            // Defensive ellipsis: PDFKit's `lineBreak: false` is not
            // a hard guarantee — if the string is still wider than the
            // cell (long SKUs, very wide унит labels) it can sneak onto
            // a second line and push the row layout out of sync. For
            // non-wrap columns we pre-measure and truncate with "…" to
            // keep every row strictly single-line.
            const contentMaxW = col.w - 4;
            const content =
              !col.wrap && rawContent
                ? (() => {
                    if (doc.widthOfString(rawContent) <= contentMaxW) {
                      return rawContent;
                    }
                    let t = rawContent;
                    while (
                      t.length > 1 &&
                      doc.widthOfString(t + "…") > contentMaxW
                    ) {
                      t = t.slice(0, -1);
                    }
                    return t + "…";
                  })()
                : rawContent;

            doc.text(
              content,
              xPos + 2,
              rowY + rowPaddingY,
              col.wrap
                ? {
                    width: contentMaxW,
                    align: col.align,
                    height: rowH - rowPaddingY * 2,
                  }
                : { width: contentMaxW, align: col.align, lineBreak: false },
            );
            xPos += col.w;
          }

          rowY += rowH;
          lineOffset += segmentLineCount;
          firstSegment = false;

          if (lineOffset < descriptionLines.length) {
            startNewTablePage();
          }
        }
      }

      let y = rowY + 10;
      const totalsX = R - 200;
      const totalNet = toEurAmount(data.invoice.total_net, sourceCurrency);
      const totalVat = toEurAmount(data.invoice.total_vat, sourceCurrency);
      const totalGross = toEurAmount(data.invoice.total_gross, sourceCurrency);
      const estimatedFooterHeight = 135;

      if (y + estimatedFooterHeight > doc.page.height - pageMargins.bottom) {
        startNewTablePage();
        y = rowY + 10;
      }

      if (showVat) {
        doc.fontSize(8).font("Main");
        doc.text(`Данъчна основа ${vatRateLabel}%:`, totalsX, y, {
          width: 130,
        });
        doc.font("MainBold").text(formatEur(totalNet), totalsX + 130, y, {
          width: 65,
          align: "right",
        });
        y += 13;

        doc
          .font("Main")
          .text(`ДДС ${vatRateLabel}%:`, totalsX, y, { width: 130 });
        doc.font("MainBold").text(formatEur(totalVat), totalsX + 130, y, {
          width: 65,
          align: "right",
        });
        y += 13;
      }

      doc.font("MainBold").fontSize(9);
      doc.text("Сума за получаване:", totalsX, y, { width: 130 });
      doc.text(formatEur(totalGross), totalsX + 130, y, {
        width: 65,
        align: "right",
      });
      y += 18;

      drawLine(doc, L, y, pageW, 0.5);
      y += 8;

      doc.fontSize(8).font("Main");
      doc.text("Начин на плащане:", L, y, { width: 90 });
      const paymentLabel =
        data.invoice.payment_method_label ||
        (data.invoice.payment_method === "cash"
          ? "В брой"
          : data.invoice.payment_method === "cod"
            ? "Наложен платеж"
            : "Банков превод");
      doc.font("MainBold").text(paymentLabel, L + 90, y, { width: 200 });
      y += 13;

      doc.font("Main").text("С сума:", L, y, { width: 40 });
      doc
        .font("MainBold")
        .text(numberToWordsBG(totalGross), L + 40, y, { width: pageW - 40 });
      y += 15;

      doc.font("Main").fontSize(7.5);
      doc.text(
        `Дата на данъчно събитие: ${formatDate(data.invoice.invoice_date)}`,
        L,
        y,
        { width: pageW },
      );
      y += 11;
      doc.text("Основание за издаване:", L, y, { width: pageW });
      y += 15;

      drawLine(doc, L, y, pageW, 0.5);
      y += 10;

      const sigColW = pageW / 2 - 5;
      doc.fontSize(7.5).font("Main");
      doc.text("Получател:", L, y, { width: 60 });
      doc
        .font("MainBold")
        .text(partner.contact_person || "________________", L + 60, y, {
          width: sigColW - 60,
        });

      doc.font("Main").fontSize(7.5);
      doc.text("Банка:", rightColX, y, { width: 40 });
      doc
        .font("MainBold")
        .text(co.bank_name || "", rightColX + 40, y, { width: rValW });
      y += 12;

      doc.font("Main").fontSize(7.5);
      doc.text("BIC:", rightColX, y, { width: 40 });
      doc
        .font("MainBold")
        .text(co.bic || "", rightColX + 40, y, { width: rValW });
      y += 12;

      doc.font("Main").fontSize(7.5);
      doc.text("IBAN:", rightColX, y, { width: 40 });
      doc
        .font("MainBold")
        .text(co.iban || "", rightColX + 40, y, { width: rValW });
      y += 18;

      // "Съставил" — ЗДДС чл. 114, ал. 6 (отговорно лице за издаването)
      doc.fontSize(7.5).font("Main");
      doc.text("Съставил:", L, y, { width: 60 });
      doc.font("MainBold").text(co.mol || "________________", L + 60, y, {
        width: sigColW - 60,
      });
      y += 14;

      doc.fontSize(7).font("Main");
      doc.text("Фактурата не подлежи на подпис.", L, y, { width: pageW });
      y += 15;

      drawFooter();
    };

    renderCopy("Оригинал");
    if (copies === 2) {
      doc.addPage({ size: "A4", margins: pageMargins });
      renderCopy("Оригинал");
    }

    doc.end();

    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}
