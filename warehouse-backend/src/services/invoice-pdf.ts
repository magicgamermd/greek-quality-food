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
    payment_method?: "cash" | "bank" | "cod" | "pos" | null;
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
    /** ЕГН of the named individual receiver (mutually exclusive with partner override) */
    client_display_egn?: string | null;
    /** Address of the named individual receiver (mutually exclusive with partner override) */
    client_display_address?: string | null;
    /** Свободен текст към фактура (например "по проект X"), printed below totals */
    invoice_note?: string | null;
  };
  partner: {
    name: string;
    eik?: string;
    vat_number?: string;
    address?: string;
    city?: string;
    contact_person?: string;
    phone?: string;
    email?: string;
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
  documentType?: "invoice" | "credit_note" | "proforma";
  relatedInvoiceNumber?: string;
  sourceCurrency?: string | null;
  outputPath: string;
  /**
   * Number of identical „Оригинал"-labeled pages to render. Default `1`.
   * When `2`, both pages get the „Оригинал" label.
   */
  copies?: 1 | 2;
  /**
   * Print variant. original=1 page „Оригинал"; copy=1 page no caption;
   * both=page1 „Оригинал"+page2 no caption. Takes precedence over `copies`.
   */
  variant?: "original" | "copy" | "both";
  /**
   * Settings → Документи toggle. When true, the totals block prints the
   * BGN equivalent in parentheses next to the EUR figure (fixed BNB
   * rate of 1 EUR = 1.95583 BGN). The default `false` keeps EUR-only
   * output.
   */
  showBgn?: boolean;
}

// Officially-fixed conversion rate adopted by Bulgaria when joining the
// eurozone on 2026-01-01. Fixed forever, so we can hard-code it.
const EUR_TO_BGN = 1.95583;

function formatEur(
  num: number | string,
  sourceCurrency?: string | null,
): string {
  return formatEurAmount(num, sourceCurrency);
}

// Convert an EUR amount to its BGN equivalent and format it as
// "92,00 лв." — half-up rounded to 2 decimals so it matches what an
// auditor gets from multiplying the EUR figure by 1.95583 with a
// calculator.
function formatBgn(amountEur: number): string {
  const bgn = Math.round(amountEur * EUR_TO_BGN * 100) / 100;
  return `${bgn.toFixed(2).replace(".", ",")} лв.`;
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
  clientDisplayEgn?: string | null,
  clientDisplayAddress?: string | null,
): { buyerFields: InvoicePartyField[]; supplierFields: InvoicePartyField[] } {
  const isIndividualBuyer = party.partner_type === "individual";
  // Individual receivers can override the address with a free-text one
  // (e.g. retail customer with no partner row). Companies always use the
  // partner row's stored address — overrides on legal entities are done
  // by changing the receiving partner, not the address text.
  const overrideAddr = (clientDisplayAddress ?? "").trim();
  const buyerAddressParts =
    isIndividualBuyer && overrideAddr.length > 0
      ? [overrideAddr]
      : [
          party.city ? `гр. ${party.city}` : "",
          party.address ? normalizeAddress(party.address) : "",
        ].filter(Boolean);

  const buyerName =
    (clientDisplayName && clientDisplayName.trim().length > 0
      ? clientDisplayName.trim()
      : party.name) || "Физическо лице — краен потребител";
  const buyerLabel = isIndividualBuyer ? "Клиент:" : "МП:";
  const overrideEgn = (clientDisplayEgn ?? "").trim();

  const buyerFields: InvoicePartyField[] = [
    { label: "", value: buyerName, bold: true },
    // Получателят показва СЪЩИТЕ полета като доставчика — винаги, дори
    // празни (по желание на magic): симетричен бланкет. "МП" етикетът
    // на името е премахнат (само получер шрифт, както при доставчика).
    { label: "ЕИК:", value: party.eik || "" },
    ...(isIndividualBuyer && overrideEgn.length > 0
      ? [{ label: "ЕГН:", value: overrideEgn }]
      : []),
    { label: "ДДС номер:", value: party.vat_number || "" },
    { label: "Адрес:", value: buyerAddressParts.join("\n") },
    { label: "Email:", value: party.email || "" },
    { label: "МОЛ:", value: party.contact_person || "" },
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
    // Телефон intentionally omitted from supplier block — МЕРТ-М prefers a
    // cleaner header without a public phone line. Email + МОЛ stay
    // conditional and only render when populated.
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
    const isProforma = data.documentType === "proforma";
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
    // "Отст. %" колона беше показвана между Цена и ДДС / Стойност, но
    // според бизнес изискването на МЕРТ-М на печатния документ не се
    // изписва per-line отстъпка — клиентът вижда само финалната цена
    // (post-discount). Внедрено като част от "Обща отстъпка €" feature-а:
    // касиерът въвежда "колко лева да сваля", системата разпределя като
    // % per item, но сметката остава едноциф. Стока абсорбира освободения
    // pt range.
    const colDefs: InvoiceTableColumn[] = showVat
      ? [
          { header: "№", w: 18, align: "center", wrap: false },
          { header: "Код", w: 56, align: "left", wrap: false },
          {
            header: "Стока",
            w: pageW - 18 - 56 - 42 - 34 - 46 - 42 - 48,
            align: "left",
            wrap: true,
          },
          { header: "Мярка", w: 42, align: "left", wrap: false },
          { header: "Кол.", w: 34, align: "right", wrap: false },
          { header: "Цена", w: 46, align: "right", wrap: false },
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
            w: pageW - 18 - 60 - 44 - 36 - 50 - 52,
            align: "left",
            wrap: true,
          },
          { header: "Мярка", w: 44, align: "left", wrap: false },
          { header: "Кол.", w: 36, align: "right", wrap: false },
          { header: "Цена", w: 50, align: "right", wrap: false },
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
      data.invoice.client_display_egn ?? null,
      data.invoice.client_display_address ?? null,
    );

    const drawPageHeader = (
      copyLabel: string | null,
      continuation = false,
    ): { tableStartY: number; rightColX: number; rValW: number } => {
      let y = 35;
      const title = isCreditNote
        ? "Кредитно Известие"
        : isProforma
          ? "Проформа Фактура"
          : "Фактура";
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

      // GQF: order_items.total_price е NET (без ДДС). Greek Quality
      // Food пази unit_price като net стойност и ДДС се добавя отгоре.
      // Затова "Цена" + "Стойност" колоните в таблицата показват NET
      // (както въведено от касиера), а Данъчна основа / ДДС / Сума за
      // получаване в footer-а изчисляват разбивката:
      //   Данъчна основа 20% = sum(line.total_price)  // вече NET
      //   ДДС 20%             = base × 0.20
      //   Сума за получаване = base + vat
      for (let idx = 0; idx < data.items.length; idx += 1) {
        const item = data.items[idx];
        const qty = toNum(item.quantity);
        const netTotal = toNum(item.total_price);
        // Discount колоната е премахната → показваме EFFECTIVE цена
        // (post-discount), за да съответства Цена × Кол = Стойност на
        // печатния документ. При qty=0 fallback-ваме към storage-натия
        // unit_price (per-unit net).
        const effectiveNetPrice =
          qty > 0 ? netTotal / qty : toNum(item.unit_price);
        const price = effectiveNetPrice;
        const total = netTotal;
        const description = item.name_bg || item.name_en;
        const unit = mapUnit(item.unit);
        // Per-line discount колоната беше премахната — на печатния
        // документ се показват само финалните цени (post-discount). Виж
        // colDefs горе за обяснението.
        const values = showVat
          ? [
              String(idx + 1),
              item.sku || "",
              description,
              unit,
              qty.toFixed(3),
              formatEur(price, sourceCurrency),
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
      // Two-column BGN | EUR totals when the Настройки → Документи
      // toggle is on, single EUR column otherwise. Layout matches the
      // sample provided by МЕРТ-М: a small "BGN" / "EUR" header row
      // above the figures, both columns right-aligned and bold for
      // amounts, with the final "Сума за получаване" / "Общо" row in
      // a slightly bigger weight.
      const showBgn = data.showBgn === true;
      const labelWidth = 130;
      const eurColW = 70;
      const bgnColW = showBgn ? 80 : 0;
      const colGap = showBgn ? 10 : 0;
      const totalsBlockW = labelWidth + bgnColW + colGap + eurColW;
      const totalsX = R - totalsBlockW;
      const bgnX = totalsX + labelWidth;
      const eurX = bgnX + bgnColW + colGap;
      const totalNet = toEurAmount(data.invoice.total_net, sourceCurrency);
      const totalVat = toEurAmount(data.invoice.total_vat, sourceCurrency);
      const totalGross = toEurAmount(data.invoice.total_gross, sourceCurrency);
      const estimatedFooterHeight = 135 + (showBgn ? 12 : 0);

      if (y + estimatedFooterHeight > doc.page.height - pageMargins.bottom) {
        startNewTablePage();
        y = rowY + 10;
      }

      // BGN / EUR column header strip. Only drawn when both columns are
      // present — keeps EUR-only invoices visually unchanged.
      if (showBgn) {
        doc.font("MainBold").fontSize(8);
        doc.text("BGN", bgnX, y, { width: bgnColW, align: "right" });
        doc.text("EUR", eurX, y, { width: eurColW, align: "right" });
        y += 12;
      }

      const drawTotalsRow = (
        label: string,
        amountEur: number,
        opts?: { bigger?: boolean },
      ) => {
        const labelFontSize = opts?.bigger ? 9 : 8;
        const valueFontSize = opts?.bigger ? 9 : 8;
        doc
          .font(opts?.bigger ? "MainBold" : "Main")
          .fontSize(labelFontSize)
          .text(label, totalsX, y, { width: labelWidth });
        if (showBgn) {
          doc
            .font("MainBold")
            .fontSize(valueFontSize)
            .text(formatBgn(amountEur), bgnX, y, {
              width: bgnColW,
              align: "right",
            });
        }
        doc
          .font("MainBold")
          .fontSize(valueFontSize)
          .text(formatEur(amountEur, sourceCurrency), eurX, y, {
            width: eurColW,
            align: "right",
          });
        y += opts?.bigger ? 14 : 13;
      };

      if (showVat) {
        drawTotalsRow("Данъчна основа:", totalNet);
        drawTotalsRow(`ДДС ${vatRateLabel}%:`, totalVat);
      }
      drawTotalsRow("Сума за получаване:", totalGross, { bigger: true });
      y += 4;

      // Free-text invoice note (e.g. "по проект Алфа"). Rendered below
      // the totals block on the left, before the payment-method line.
      const noteText = data.invoice.invoice_note?.trim();
      if (noteText) {
        doc.fontSize(7.5).font("Main");
        doc.text("Забележка: ", L, y, { width: 70, continued: true });
        doc.font("MainBold").text(noteText, { width: pageW - 70 });
        y += 14;
      }

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
            : data.invoice.payment_method === "pos"
              ? "ПОС"
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

      // ── Боксов подпис-footer: Получил | Банка | Съставил (пунктирани кутии) ──
      const sgap = 10;
      const sboxW = (pageW - sgap * 2) / 3;
      const sb1 = L;
      const sb2 = L + sboxW + sgap;
      const sb3 = L + (sboxW + sgap) * 2;
      const boxH = 54;
      const pad = 5;
      doc.save();
      doc.lineWidth(0.5).dash(2, { space: 2 });
      doc.rect(sb1, y, sboxW, boxH).stroke();
      doc.rect(sb2, y, sboxW, boxH).stroke();
      doc.rect(sb3, y, sboxW, boxH).stroke();
      doc.undash();
      doc.restore();

      const ty = y + pad;
      const innerW = sboxW - pad * 2;
      // Кутия 1 — Получил
      doc.fontSize(7.5).font("Main");
      doc.text("Получил:", sb1 + pad, ty, { width: innerW, lineBreak: false });
      doc
        .font("MainBold")
        .text(partner.contact_person || "", sb1 + pad + 44, ty, {
          width: innerW - 44,
          lineBreak: false,
        });
      doc.font("Main").text("ЕГН/Л.К.:", sb1 + pad, ty + 12, {
        width: innerW,
        lineBreak: false,
      });
      doc
        .fontSize(6.2)
        .fillColor("#666")
        .text("Отговарящ за операцията", sb1 + pad, y + boxH - 10, {
          width: innerW,
        });
      doc.fillColor("#000");
      // Кутия 2 — Банка
      doc.fontSize(7.5).font("Main");
      doc.text("Банка:", sb2 + pad, ty, { width: 38, lineBreak: false });
      doc.font("MainBold").text(co.bank_name || "", sb2 + pad + 38, ty, {
        width: innerW - 38,
        lineBreak: false,
      });
      doc
        .font("Main")
        .text("BIC:", sb2 + pad, ty + 13, { width: 38, lineBreak: false });
      doc.font("MainBold").text(co.bic || "", sb2 + pad + 38, ty + 13, {
        width: innerW - 38,
        lineBreak: false,
      });
      doc
        .font("Main")
        .text("IBAN:", sb2 + pad, ty + 26, { width: 38, lineBreak: false });
      doc.font("MainBold").text(co.iban || "", sb2 + pad + 38, ty + 26, {
        width: innerW - 38,
        lineBreak: false,
      });
      // Кутия 3 — Съставил (ЗДДС чл. 114, ал. 6)
      doc.fontSize(7.5).font("Main");
      doc.text("Съставил:", sb3 + pad, ty, { width: innerW, lineBreak: false });
      doc.font("MainBold").text(co.mol || "", sb3 + pad + 48, ty, {
        width: innerW - 48,
        lineBreak: false,
      });
      doc.font("Main").text("Шифър:", sb3 + pad, ty + 12, {
        width: innerW,
        lineBreak: false,
      });
      doc
        .fontSize(6.2)
        .fillColor("#666")
        .text("Отговарящ за операцията", sb3 + pad, y + boxH - 10, {
          width: innerW,
        });
      doc.fillColor("#000");
      y += boxH + 8;

      doc.fontSize(7).font("Main");
      doc.text("Фактурата не подлежи на подпис.", L, y, { width: pageW });
      y += 15;

      drawFooter();
    };

    const variant = data.variant ?? (copies === 2 ? "both" : "original");
    if (variant === "copy") {
      renderCopy(null);
    } else {
      renderCopy("Оригинал");
      if (variant === "both") {
        doc.addPage({ size: "A4", margins: pageMargins });
        renderCopy(null);
      }
    }

    doc.end();

    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}
