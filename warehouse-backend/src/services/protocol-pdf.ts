// Acceptance protocol PDF — "Приемо-предавателен протокол".
//
// Built from scratch with pdfkit, mirroring the layout pattern used by
// document-pdf.ts (header → table → totals → signature lines). This is
// NOT a template-overlay document — the entire layout is drawn
// programmatically so the same code produces a consistent PDF whether
// it's the first or the n-th regeneration.

import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { formatEurAmount, formatEurUnitPrice } from "../utils/currency.js";

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

export interface ProtocolItem {
  name_bg: string;
  quantity: number | string;
  unit: string;
  unit_price: number | string;
  total_price: number | string;
}

export interface ProtocolData {
  protocolNumber: string; // e.g. "PR-0000037"
  orderNumber: string | number;
  invoiceNumber?: string | null;
  stockDispatchNumber?: string | null;
  date: string; // ISO yyyy-mm-dd
  place: string;
  seller: {
    name: string;
    eik: string;
    vat_number?: string | null;
    address?: string | null;
    email?: string | null;
    mol?: string | null;
    rep: string;
  };
  buyer: {
    name: string;
    eik?: string | null;
    vat_number?: string | null;
    address?: string | null;
    email?: string | null;
    mol?: string | null;
    rep: string;
  };
  items: ProtocolItem[];
  totalAmount: number;
  outputPath: string;
  // Settings → Документи toggle (migration 069). When true, the "Общо"
  // line prints both the BGN equivalent and the EUR figure.
  showBgn?: boolean;
}

const PROTOCOL_EUR_TO_BGN = 1.95583;

function formatProtocolBgn(amountEur: number): string {
  const bgn = Math.round(amountEur * PROTOCOL_EUR_TO_BGN * 100) / 100;
  return `${bgn.toFixed(2).replace(".", ",")} лв.`;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

export async function generateProtocolPdf(data: ProtocolData): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    doc.registerFont("Main", FONT_REGULAR);
    doc.registerFont("MainBold", FONT_BOLD);

    const out = fs.createWriteStream(data.outputPath);
    doc.pipe(out);
    out.on("finish", () => resolve());
    out.on("error", reject);

    const L = 50;
    const pageW = doc.page.width - 100;
    let y = 60;

    // Title
    doc.font("MainBold").fontSize(16);
    doc.text("ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ", L, y, {
      width: pageW,
      align: "center",
    });
    y += 22;
    doc.font("MainBold").fontSize(11);
    doc.text(`№ ${data.protocolNumber}`, L, y, {
      width: pageW,
      align: "center",
    });
    y += 26;

    // Place + date
    doc.font("Main").fontSize(10);
    doc.text(`Място: ${data.place}`, L, y, { width: pageW / 2 });
    doc.text(`Дата: ${formatDate(data.date)}`, L + pageW / 2, y, {
      width: pageW / 2,
      align: "right",
    });
    y += 22;

    // Reference
    const refs: string[] = [`поръчка № ${data.orderNumber}`];
    if (data.invoiceNumber) refs.push(`фактура № ${data.invoiceNumber}`);
    if (data.stockDispatchNumber)
      refs.push(`стокова разписка № ${data.stockDispatchNumber}`);
    doc.text(
      `С настоящия протокол страните установяват, че Предалият предаде, а Приелият прие следните стоки/услуги съгласно ${refs.join(", ")}:`,
      L,
      y,
      { width: pageW, align: "justify" },
    );
    y += 40;

    // Items table
    const colsX = [L, L + 250, L + 310, L + 380, L + 460];
    doc.font("MainBold").fontSize(9);
    doc.text("Артикул", colsX[0], y);
    doc.text("К-во", colsX[1], y, { width: 50, align: "right" });
    doc.text("Ед.", colsX[2], y, { width: 50, align: "left" });
    doc.text("Ед.цена", colsX[3], y, { width: 70, align: "right" });
    doc.text("Сума", colsX[4], y, { width: 70, align: "right" });
    y += 14;
    doc
      .moveTo(L, y)
      .lineTo(L + pageW, y)
      .stroke();
    y += 4;
    doc.font("Main").fontSize(9);
    for (const item of data.items) {
      doc.text(item.name_bg, colsX[0], y, { width: 240 });
      doc.text(String(item.quantity), colsX[1], y, {
        width: 50,
        align: "right",
      });
      doc.text(item.unit, colsX[2], y, { width: 50, align: "left" });
      doc.text(formatEurUnitPrice(item.unit_price), colsX[3], y, {
        width: 70,
        align: "right",
      });
      doc.text(formatEurAmount(item.total_price), colsX[4], y, {
        width: 70,
        align: "right",
      });
      y += 14;
    }
    doc
      .moveTo(L, y)
      .lineTo(L + pageW, y)
      .stroke();
    y += 8;

    // Total — when the dual-currency toggle is on, append the BGN
    // equivalent so the protocol's bottom line matches the matching
    // invoice/Стокова разписка that the customer signs alongside.
    doc.font("MainBold").fontSize(10);
    const totalLine = data.showBgn
      ? `Общо: ${formatProtocolBgn(data.totalAmount)} / ${formatEurAmount(data.totalAmount)}`
      : `Общо: ${formatEurAmount(data.totalAmount)}`;
    doc.text(totalLine, L, y, {
      width: pageW,
      align: "right",
    });
    y += 26;

    // Statement
    doc.font("Main").fontSize(10);
    doc.text("Стоките/услугите са приети без забележки.", L, y, {
      width: pageW,
    });
    y += 36;

    // Parties — ПРЕДАЛ (доставчик) и ПРИЕЛ (получател) показват едни и
    // същи основни редове, винаги (дори празни): ЕИК, ДДС, Адрес, Email,
    // МОЛ. Симетричен бланкет, както при фактурата и стоковата разписка.
    // "Представител" остава отделен ред (подписващото лице).
    doc.font("MainBold").fontSize(10);
    doc.text("ПРЕДАЛ:", L, y);
    doc.text("ПРИЕЛ:", L + pageW / 2, y);
    y += 14;

    const colW = pageW / 2;
    const labelW = 70;
    // Draws one party's labelled rows starting at column origin `x`, on its
    // own running cursor; returns the y after the last row so the two
    // columns can be re-aligned to whichever is taller.
    const drawPartyRows = (
      x: number,
      party: {
        name: string;
        eik?: string | null;
        vat_number?: string | null;
        address?: string | null;
        email?: string | null;
        mol?: string | null;
        rep: string;
      },
    ): number => {
      let py = y;
      // Name — bold, no label.
      doc.font("MainBold").fontSize(9);
      doc.text(party.name || "", x, py, { width: colW - 10 });
      py = doc.y + 2;
      const rows: Array<[string, string]> = [
        ["ЕИК:", party.eik || ""],
        ["ДДС №:", party.vat_number || ""],
        ["Адрес:", party.address || ""],
        ["Email:", party.email || ""],
        ["МОЛ:", party.mol || ""],
        ["Представител:", party.rep || ""],
      ];
      for (const [label, value] of rows) {
        doc.font("Main").fontSize(9);
        doc.text(label, x, py, { width: labelW, lineBreak: false });
        doc.text(value, x + labelW, py, { width: colW - labelW - 10 });
        py = doc.y + 2;
      }
      return py;
    };

    const sellerEnd = drawPartyRows(L, {
      name: data.seller.name,
      eik: data.seller.eik,
      vat_number: data.seller.vat_number,
      address: data.seller.address,
      email: data.seller.email,
      mol: data.seller.mol,
      rep: data.seller.rep,
    });
    const buyerEnd = drawPartyRows(L + pageW / 2, {
      name: data.buyer.name,
      eik: data.buyer.eik,
      vat_number: data.buyer.vat_number,
      address: data.buyer.address,
      email: data.buyer.email,
      mol: data.buyer.mol,
      rep: data.buyer.rep,
    });
    y = Math.max(sellerEnd, buyerEnd) + 38;

    // Signature lines
    doc.font("Main").fontSize(9);
    doc.text("_______________________", L, y);
    doc.text("_______________________", L + pageW / 2, y);
    y += 12;
    doc.text("(подпис)", L, y);
    doc.text("(подпис)", L + pageW / 2, y);

    doc.end();
  });
}
