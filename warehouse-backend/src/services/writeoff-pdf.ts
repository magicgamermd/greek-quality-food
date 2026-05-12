import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { query } from "../db.js";

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
        formatMoney(data.unit_cost),
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
