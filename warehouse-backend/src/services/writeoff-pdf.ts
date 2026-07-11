import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { query } from "../db.js";
import { formatUnitPricePlain } from "../utils/currency.js";

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

export const WRITEOFF_REASON_BG: Record<string, string> = {
  expired: "Изтекъл срок на годност",
  damaged: "Повреда / Физическо увреждане",
  theft: "Липса / Открадване",
  count_correction: "Коригиране при инвентаризация",
  recall: "Изтегляне от пазара / Обратна връзка от доставчик",
  other: "Друго",
};

function formatDate(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function formatMoney(value: number | string | null | undefined): string {
  const num = typeof value === "string" ? parseFloat(value) : (value ?? 0);
  if (!Number.isFinite(num)) return "0.00";
  return num.toFixed(2);
}

function formatQuantity(value: number | string | null | undefined): string {
  const num = typeof value === "string" ? parseFloat(value) : (value ?? 0);
  if (!Number.isFinite(num)) return "0.000";
  return num.toFixed(3);
}

export interface WriteoffPdfData {
  document_number: string;
  written_off_at: string | Date;
  reason: string;
  notes: string | null;
  quantity: number | string;
  unit_cost: number | string;
  total_cost: number | string;
  product_name_bg: string;
  product_sku: string | null;
  product_unit: string | null;
  batch_number: string | null;
  batch_expiry: string | null;
  written_off_by_email: string;
  written_off_by_name: string | null;
  company: {
    company_name: string | null;
    eik: string | null;
    vat_number: string | null;
    address: string | null;
  };
  commission: {
    chair: string | null;
    member1: string | null;
    member2: string | null;
  };
}

/**
 * Load the full write-off payload from DB by id.
 * Returns null when the write-off is not found.
 */
export async function loadWriteoffPdfData(
  writeoffId: number,
): Promise<WriteoffPdfData | null> {
  const { rows } = await query(
    `SELECT w.id,
            w.document_number,
            w.written_off_at,
            w.reason,
            w.notes,
            w.quantity,
            w.unit_cost,
            w.total_cost,
            p.name_bg AS product_name_bg,
            p.sku AS product_sku,
            p.unit AS product_unit,
            b.batch_number,
            b.expiry_date AS batch_expiry,
            u.email AS written_off_by_email,
            u.name AS written_off_by_name
     FROM stock_writeoffs w
     JOIN products p ON p.id = w.product_id
     LEFT JOIN batches b ON b.id = w.batch_id
     JOIN users u ON u.id = w.written_off_by
     WHERE w.id = $1`,
    [writeoffId],
  );

  if (rows.length === 0) return null;
  const row = rows[0];

  const { rows: settingsRows } = await query(
    `SELECT company_name, eik, vat_number, address,
            writeoff_commission_chair,
            writeoff_commission_member1,
            writeoff_commission_member2
       FROM settings WHERE id = 1`,
  );
  const settingsRow = settingsRows[0] ?? {};
  const company = {
    company_name: settingsRow.company_name ?? null,
    eik: settingsRow.eik ?? null,
    vat_number: settingsRow.vat_number ?? null,
    address: settingsRow.address ?? null,
  };
  const commission = {
    chair: settingsRow.writeoff_commission_chair ?? null,
    member1: settingsRow.writeoff_commission_member1 ?? null,
    member2: settingsRow.writeoff_commission_member2 ?? null,
  };

  return {
    document_number: row.document_number,
    written_off_at: row.written_off_at,
    reason: row.reason,
    notes: row.notes,
    quantity: row.quantity,
    unit_cost: row.unit_cost,
    total_cost: row.total_cost,
    product_name_bg: row.product_name_bg,
    product_sku: row.product_sku,
    product_unit: row.product_unit,
    batch_number: row.batch_number,
    batch_expiry: row.batch_expiry,
    written_off_by_email: row.written_off_by_email,
    written_off_by_name: row.written_off_by_name,
    company,
    commission,
  };
}

/**
 * Render a "Протокол за бракуване" (write-off protocol) PDF per Закон за
 * счетоводството чл. 54 ал. 1. Returns a Buffer containing the PDF bytes.
 */
export async function renderWriteoffProtocolPdf(
  data: WriteoffPdfData,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 40, bottom: 40, left: 50, right: 50 },
      });

      doc.registerFont("Main", FONT_REGULAR);
      doc.registerFont("MainBold", FONT_BOLD);

      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const L = 50;
      const R = doc.page.width - 50;
      const pageW = R - L;

      // ── Title ──
      doc.font("MainBold").fontSize(16).fillColor("#000");
      doc.text("ПРОТОКОЛ ЗА БРАКУВАНЕ", L, 45, {
        width: pageW,
        align: "center",
      });

      doc.font("MainBold").fontSize(11);
      doc.text(`№ ${data.document_number}`, L, 70, {
        width: pageW / 2,
        align: "left",
      });
      doc.text(
        `Дата: ${formatDate(data.written_off_at)} г.`,
        L + pageW / 2,
        70,
        {
          width: pageW / 2,
          align: "right",
        },
      );

      let y = 100;

      // ── Company block ──
      const companyFields: Array<[string, string]> = [
        ["ФИРМА:", data.company.company_name || "—"],
        ["ЕИК:", data.company.eik || "—"],
        ["ДДС №:", data.company.vat_number || "—"],
        ["АДРЕС:", data.company.address || "—"],
      ];

      doc.font("Main").fontSize(9);
      for (const [label, value] of companyFields) {
        doc.font("Main").text(label, L, y, { width: 80, lineBreak: false });
        doc.font("MainBold").text(value, L + 85, y, {
          width: pageW - 85,
          lineBreak: false,
        });
        y += 14;
      }
      y += 6;

      // ── Preamble ──
      doc.font("Main").fontSize(9.5);
      doc.text(
        `Днес, ${formatDate(data.written_off_at)} г., долуподписаната комисия в състав:`,
        L,
        y,
        { width: pageW },
      );
      y += 18;

      // Commission names come from settings (configurable via Settings
      // page). If a role is unset we render an underscore placeholder
      // so the physical signature line remains — the name in ink is
      // what НАП cares about.
      const nameLine = (label: string, name: string | null) => {
        const filled = name?.trim();
        return filled
          ? `${label}: ${filled}  ____________________`
          : `${label}: ________________________________`;
      };

      doc.font("Main").fontSize(9);
      doc.text(nameLine("Председател", data.commission.chair), L, y, {
        width: pageW,
      });
      y += 14;
      doc.text(nameLine("Член        ", data.commission.member1), L, y, {
        width: pageW,
      });
      y += 14;
      doc.text(nameLine("Член        ", data.commission.member2), L, y, {
        width: pageW,
      });
      y += 18;

      doc.font("Main").fontSize(9.5);
      doc.text("констатира следното:", L, y, { width: pageW });
      y += 20;

      // ── Items table ──
      type Col = {
        header: string;
        w: number;
        align: "left" | "right" | "center";
      };
      // Rebalanced — числовите колони (Кол-во, Ед. цена, Стойност)
      // бяха с прекомерно празно пространство за типичните стойности
      // при бракуване (<1000 бр, <1000 лв). Прехвърляме ~33pt към
      // АРТИКУЛ за по-дълги продуктови имена с по-малко wrap.
      const cols: Col[] = [
        { header: "№", w: 24, align: "center" },
        {
          header: "АРТИКУЛ",
          w: pageW - (24 + 70 + 60 + 44 + 50 + 54),
          align: "left",
        },
        { header: "Партида", w: 70, align: "left" },
        { header: "Срок год.", w: 60, align: "center" },
        { header: "Кол-во", w: 44, align: "right" },
        { header: "Ед. цена", w: 50, align: "right" },
        { header: "Стойност", w: 54, align: "right" },
      ];

      // Header row
      const headerH = 20;
      doc.rect(L, y, pageW, headerH).lineWidth(0.5).stroke();
      doc.font("MainBold").fontSize(8.5);
      let xPos = L;
      for (const col of cols) {
        if (xPos > L) {
          doc
            .moveTo(xPos, y)
            .lineTo(xPos, y + headerH)
            .lineWidth(0.3)
            .stroke();
        }
        doc.text(col.header, xPos + 3, y + 6, {
          width: col.w - 6,
          align: col.align,
          lineBreak: false,
        });
        xPos += col.w;
      }
      y += headerH;

      // Single item row (one writeoff = one row)
      const productLabel = data.product_sku
        ? `${data.product_name_bg} (${data.product_sku})`
        : data.product_name_bg;
      const values: string[] = [
        "1",
        productLabel,
        data.batch_number || "—",
        data.batch_expiry ? formatDate(data.batch_expiry) : "—",
        `${formatQuantity(data.quantity)}${data.product_unit ? " " + data.product_unit : ""}`,
        formatUnitPricePlain(data.unit_cost),
        formatMoney(data.total_cost),
      ];

      // Compute row height based on wrapped product label
      doc.font("Main").fontSize(8.5);
      const wrappedProduct = doc.heightOfString(productLabel, {
        width: cols[1].w - 6,
      });
      const rowH = Math.max(22, Math.ceil(wrappedProduct) + 12);

      doc.rect(L, y, pageW, rowH).lineWidth(0.3).stroke();
      xPos = L;
      for (let i = 0; i < cols.length; i += 1) {
        const col = cols[i];
        if (xPos > L) {
          doc
            .moveTo(xPos, y)
            .lineTo(xPos, y + rowH)
            .lineWidth(0.3)
            .stroke();
        }
        doc.font("Main").fontSize(8.5);
        doc.text(values[i], xPos + 3, y + 6, {
          width: col.w - 6,
          align: col.align,
        });
        xPos += col.w;
      }
      y += rowH + 4;

      // ── Total ──
      doc.font("MainBold").fontSize(10);
      doc.text(`Общо: ${formatMoney(data.total_cost)} лв.`, L, y, {
        width: pageW,
        align: "right",
      });
      y += 22;

      // ── Reason ──
      doc.font("Main").fontSize(9.5);
      const reasonLabel = WRITEOFF_REASON_BG[data.reason] || data.reason;
      doc.text("ПРИЧИНА ЗА БРАКУВАНЕ: ", L, y, {
        width: pageW,
        continued: true,
      });
      doc.font("MainBold").text(reasonLabel);
      y += 16;

      if (data.notes && data.notes.trim()) {
        doc.font("Main").fontSize(9);
        doc.text(data.notes.trim(), L, y, { width: pageW });
        const notesH = doc.heightOfString(data.notes.trim(), { width: pageW });
        y += Math.ceil(notesH) + 8;
      } else {
        y += 4;
      }

      y += 8;

      // ── Legal basis ──
      doc.font("Main").fontSize(9);
      doc.text(
        "Настоящият протокол се съставя на основание чл. 54, ал. 1 от Закона за счетоводството.",
        L,
        y,
        { width: pageW },
      );
      y += 30;

      // ── Signatures ──
      const signer =
        data.written_off_by_name ||
        data.written_off_by_email.split("@")[0] ||
        "—";

      doc.font("Main").fontSize(9);
      doc.text("Съставил: _____________", L, y, {
        width: 180,
        lineBreak: false,
      });
      doc.text(`(${signer})`, L + 185, y, {
        width: 180,
        lineBreak: false,
      });
      doc.text(`Дата: ${formatDate(data.written_off_at)}`, L + 370, y, {
        width: pageW - 370,
        lineBreak: false,
      });
      y += 28;

      // Pre-fill commission names from settings in the footer signature
      // block too — if a name is configured it appears above the line,
      // so the signer knows which line is theirs when all 3 signatures
      // are on the same physical document.
      const footerLine = (name: string | null, fallback: string) =>
        name?.trim() ? `${name.trim()}  _____________` : fallback;

      doc.text(
        footerLine(data.commission.chair, "Председател: _____________"),
        L,
        y,
        { width: 260, lineBreak: false },
      );
      doc.text(
        footerLine(data.commission.member1, "Член 1:  _____________"),
        L + 280,
        y,
        { width: pageW - 280, lineBreak: false },
      );
      y += 18;
      doc.text(
        footerLine(data.commission.member2, "Член 2:  _____________"),
        L + 280,
        y,
        { width: pageW - 280, lineBreak: false },
      );

      // Footer
      doc.font("Main").fontSize(7).fillColor("#888");
      doc.text(
        "Документът е валиден без печат и подпис при електронно издаване.",
        L,
        doc.page.height - 50,
        { width: pageW, align: "center" },
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Public entry point: takes a writeoff id, loads everything it needs, returns
 * the rendered PDF as a Buffer. Throws when the writeoff is not found.
 */
export async function generateWriteoffProtocolPdf(
  writeoffId: number,
): Promise<Buffer> {
  const data = await loadWriteoffPdfData(writeoffId);
  if (!data) {
    const err: any = new Error("Протоколът за бракуване не е намерен");
    err.statusCode = 404;
    throw err;
  }
  return renderWriteoffProtocolPdf(data);
}

// ── Multi-line protocol (one НАП акт grouping many write-off lines) ──

export interface WriteoffProtocolLine {
  n: number;
  product_name_bg: string;
  product_sku: string | null;
  product_unit: string | null;
  batch_number: string | null;
  expiry_date: string | null;
  quantity: number | string;
  unit_cost: number | string;
  total_cost: number | string;
  reason: string;
}

export interface WriteoffProtocolData {
  protocol_number: string;
  written_off_at: string | Date;
  notes: string | null;
  written_off_by_email: string;
  written_off_by_name: string | null;
  company: {
    company_name: string | null;
    eik: string | null;
    vat_number: string | null;
    address: string | null;
  };
  commission: {
    chair: string | null;
    member1: string | null;
    member2: string | null;
  };
  lines: WriteoffProtocolLine[];
  total_cost: number;
}

/**
 * Load ALL write-off rows that share a protocol_number, plus company settings
 * and the configurable commission names. Returns null when no rows match.
 */
export async function loadWriteoffProtocolData(
  protocolNumber: string,
): Promise<WriteoffProtocolData | null> {
  const { rows } = await query(
    `SELECT w.id,
            w.written_off_at,
            w.reason,
            w.notes,
            w.quantity,
            w.unit_cost,
            w.total_cost,
            p.name_bg AS product_name_bg,
            p.sku AS product_sku,
            p.unit AS product_unit,
            b.batch_number,
            b.expiry_date AS batch_expiry,
            u.email AS written_off_by_email,
            u.name AS written_off_by_name
     FROM stock_writeoffs w
     JOIN products p ON p.id = w.product_id
     LEFT JOIN batches b ON b.id = w.batch_id
     JOIN users u ON u.id = w.written_off_by
     WHERE w.protocol_number = $1
     ORDER BY w.id ASC`,
    [protocolNumber],
  );

  if (rows.length === 0) return null;

  const { rows: settingsRows } = await query(
    `SELECT company_name, eik, vat_number, address,
            writeoff_commission_chair,
            writeoff_commission_member1,
            writeoff_commission_member2
       FROM settings WHERE id = 1`,
  );
  const settingsRow = settingsRows[0] ?? {};
  const company = {
    company_name: settingsRow.company_name ?? null,
    eik: settingsRow.eik ?? null,
    vat_number: settingsRow.vat_number ?? null,
    address: settingsRow.address ?? null,
  };
  const commission = {
    chair: settingsRow.writeoff_commission_chair ?? null,
    member1: settingsRow.writeoff_commission_member1 ?? null,
    member2: settingsRow.writeoff_commission_member2 ?? null,
  };

  const lines: WriteoffProtocolLine[] = rows.map((row: any, idx: number) => ({
    n: idx + 1,
    product_name_bg: row.product_name_bg,
    product_sku: row.product_sku,
    product_unit: row.product_unit,
    batch_number: row.batch_number,
    expiry_date: row.batch_expiry,
    quantity: row.quantity,
    unit_cost: row.unit_cost,
    total_cost: row.total_cost,
    reason: row.reason,
  }));

  const totalCost = Number(
    rows
      .reduce((sum: number, row: any) => sum + Number(row.total_cost ?? 0), 0)
      .toFixed(2),
  );

  return {
    protocol_number: protocolNumber,
    // Earliest write-off timestamp represents the date the act was drawn up.
    written_off_at: rows[0].written_off_at,
    notes: rows[0].notes ?? null,
    written_off_by_email: rows[0].written_off_by_email,
    written_off_by_name: rows[0].written_off_by_name,
    company,
    commission,
    lines,
    total_cost: totalCost,
  };
}

/**
 * Render a multi-line "Протокол за брак" PDF: the same company header,
 * commission block and signature layout as the single-line protocol, but with
 * a TABLE of all the lines instead of one product row.
 */
export async function renderWriteoffMultiProtocolPdf(
  data: WriteoffProtocolData,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 40, bottom: 40, left: 50, right: 50 },
      });

      doc.registerFont("Main", FONT_REGULAR);
      doc.registerFont("MainBold", FONT_BOLD);

      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const L = 50;
      const R = doc.page.width - 50;
      const pageW = R - L;

      // ── Title ──
      doc.font("MainBold").fontSize(16).fillColor("#000");
      doc.text(`ПРОТОКОЛ ЗА БРАК № ${data.protocol_number}`, L, 45, {
        width: pageW,
        align: "center",
      });

      doc.font("MainBold").fontSize(11);
      doc.text(`Дата: ${formatDate(data.written_off_at)} г.`, L, 72, {
        width: pageW,
        align: "right",
      });

      let y = 100;

      // ── Company block ──
      const companyFields: Array<[string, string]> = [
        ["ФИРМА:", data.company.company_name || "—"],
        ["ЕИК:", data.company.eik || "—"],
        ["ДДС №:", data.company.vat_number || "—"],
        ["АДРЕС:", data.company.address || "—"],
      ];

      doc.font("Main").fontSize(9);
      for (const [label, value] of companyFields) {
        doc.font("Main").text(label, L, y, { width: 80, lineBreak: false });
        doc.font("MainBold").text(value, L + 85, y, {
          width: pageW - 85,
          lineBreak: false,
        });
        y += 14;
      }
      y += 6;

      // ── Preamble + commission ──
      doc.font("Main").fontSize(9.5);
      doc.text(
        `Днес, ${formatDate(data.written_off_at)} г., долуподписаната комисия в състав:`,
        L,
        y,
        { width: pageW },
      );
      y += 18;

      const nameLine = (label: string, name: string | null) => {
        const filled = name?.trim();
        return filled
          ? `${label}: ${filled}  ____________________`
          : `${label}: ________________________________`;
      };

      doc.font("Main").fontSize(9);
      doc.text(nameLine("Председател", data.commission.chair), L, y, {
        width: pageW,
      });
      y += 14;
      doc.text(nameLine("Член        ", data.commission.member1), L, y, {
        width: pageW,
      });
      y += 14;
      doc.text(nameLine("Член        ", data.commission.member2), L, y, {
        width: pageW,
      });
      y += 18;

      doc.font("Main").fontSize(9.5);
      doc.text("констатира бракуването на следните стоки:", L, y, {
        width: pageW,
      });
      y += 20;

      // ── Items table ──
      type Col = {
        header: string;
        w: number;
        align: "left" | "right" | "center";
      };
      const reasonColW = 78;
      const cols: Col[] = [
        { header: "№", w: 20, align: "center" },
        {
          header: "Стока",
          w: pageW - (20 + 56 + 50 + 40 + 44 + 48 + reasonColW),
          align: "left",
        },
        { header: "Партида", w: 56, align: "left" },
        { header: "Годност", w: 50, align: "center" },
        { header: "Кол-во", w: 40, align: "right" },
        { header: "Ед. ст-ст", w: 44, align: "right" },
        { header: "Ст-ст", w: 48, align: "right" },
        { header: "Причина", w: reasonColW, align: "left" },
      ];

      const drawHeaderRow = (atY: number): number => {
        const headerH = 22;
        doc.rect(L, atY, pageW, headerH).lineWidth(0.5).stroke();
        doc.font("MainBold").fontSize(8);
        let xPos = L;
        for (const col of cols) {
          if (xPos > L) {
            doc
              .moveTo(xPos, atY)
              .lineTo(xPos, atY + headerH)
              .lineWidth(0.3)
              .stroke();
          }
          doc.text(col.header, xPos + 3, atY + 7, {
            width: col.w - 6,
            align: col.align,
            lineBreak: false,
          });
          xPos += col.w;
        }
        return atY + headerH;
      };

      y = drawHeaderRow(y);

      const reasonShortBg: Record<string, string> = {
        expired: "Изтекъл срок",
        damaged: "Повреда",
        theft: "Кражба/липса",
        count_correction: "Корекция",
        recall: "Изтегляне",
        other: "Друго",
      };

      for (const line of data.lines) {
        const productLabel = line.product_sku
          ? `${line.product_name_bg} (${line.product_sku})`
          : line.product_name_bg;
        const reasonLabel = reasonShortBg[line.reason] || line.reason;
        const values: string[] = [
          String(line.n),
          productLabel,
          line.batch_number || "—",
          line.expiry_date ? formatDate(line.expiry_date) : "—",
          `${formatQuantity(line.quantity)}${line.product_unit ? " " + line.product_unit : ""}`,
          formatUnitPricePlain(line.unit_cost),
          formatMoney(line.total_cost),
          reasonLabel,
        ];

        // Row height grows with the tallest wrapped cell (product/reason).
        doc.font("Main").fontSize(8);
        const productH = doc.heightOfString(productLabel, {
          width: cols[1].w - 6,
        });
        const reasonH = doc.heightOfString(reasonLabel, {
          width: cols[7].w - 6,
        });
        const rowH = Math.max(20, Math.ceil(Math.max(productH, reasonH)) + 10);

        // Page break before drawing a row that won't fit.
        if (y + rowH > doc.page.height - 140) {
          doc.addPage();
          y = 50;
          y = drawHeaderRow(y);
        }

        doc.rect(L, y, pageW, rowH).lineWidth(0.3).stroke();
        let xPos = L;
        for (let i = 0; i < cols.length; i += 1) {
          const col = cols[i];
          if (xPos > L) {
            doc
              .moveTo(xPos, y)
              .lineTo(xPos, y + rowH)
              .lineWidth(0.3)
              .stroke();
          }
          doc.font("Main").fontSize(8);
          doc.text(values[i], xPos + 3, y + 5, {
            width: col.w - 6,
            align: col.align,
          });
          xPos += col.w;
        }
        y += rowH;
      }
      y += 4;

      // ── Grand total ──
      doc.font("MainBold").fontSize(11);
      doc.text(`ОБЩА СТОЙНОСТ: ${formatMoney(data.total_cost)} лв.`, L, y, {
        width: pageW,
        align: "right",
      });
      y += 24;

      // ── Notes ──
      if (data.notes && data.notes.trim()) {
        doc.font("Main").fontSize(9);
        doc.text("Забележки: ", L, y, { width: pageW, continued: true });
        doc.font("MainBold").text(data.notes.trim());
        const notesH = doc.heightOfString(data.notes.trim(), { width: pageW });
        y += Math.ceil(notesH) + 10;
      }

      // ── Legal basis ──
      doc.font("Main").fontSize(9).fillColor("#000");
      doc.text(
        "Настоящият протокол се съставя на основание чл. 54, ал. 1 от Закона за счетоводството.",
        L,
        y,
        { width: pageW },
      );
      y += 30;

      // ── Signatures ──
      const signer =
        data.written_off_by_name ||
        data.written_off_by_email.split("@")[0] ||
        "—";

      doc.font("Main").fontSize(9);
      doc.text("Съставил: _____________", L, y, {
        width: 180,
        lineBreak: false,
      });
      doc.text(`(${signer})`, L + 185, y, { width: 180, lineBreak: false });
      doc.text(`Дата: ${formatDate(data.written_off_at)}`, L + 370, y, {
        width: pageW - 370,
        lineBreak: false,
      });
      y += 28;

      const footerLine = (name: string | null, fallback: string) =>
        name?.trim() ? `${name.trim()}  _____________` : fallback;

      doc.text(
        footerLine(data.commission.chair, "Председател: _____________"),
        L,
        y,
        { width: 260, lineBreak: false },
      );
      doc.text(
        footerLine(data.commission.member1, "Член 1:  _____________"),
        L + 280,
        y,
        { width: pageW - 280, lineBreak: false },
      );
      y += 18;
      doc.text(
        footerLine(data.commission.member2, "Член 2:  _____________"),
        L + 280,
        y,
        { width: pageW - 280, lineBreak: false },
      );

      // Footer
      doc.font("Main").fontSize(7).fillColor("#888");
      doc.text(
        "Документът е валиден без печат и подпис при електронно издаване.",
        L,
        doc.page.height - 50,
        { width: pageW, align: "center" },
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Public entry point for the multi-line protocol: takes a protocol_number,
 * loads all its lines, returns the rendered PDF as a Buffer. Throws (404) when
 * no rows share that protocol number.
 */
export async function generateWriteoffMultiProtocolPdf(
  protocolNumber: string,
): Promise<Buffer> {
  const data = await loadWriteoffProtocolData(protocolNumber);
  if (!data) {
    const err: any = new Error("Протоколът за брак не е намерен");
    err.statusCode = 404;
    throw err;
  }
  return renderWriteoffMultiProtocolPdf(data);
}
