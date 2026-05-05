// ====================================================================
// ЗАЯВКА (Purchase Order) PDF
// --------------------------------------------------------------------
// Bilingual (Bulgarian + English) PDF — used as a "ready-to-screenshot"
// document the office staff sends to Chinese suppliers via WeChat. No
// prices: this module is purely a planning tool. The supplier matches
// items by SKU code (Кодове / Codes), so the code column is the widest
// and most prominent.
// ====================================================================
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

export interface PurchaseOrderPdfData {
  order_number: string;
  created_at: string | Date;
  expected_delivery_date?: string | Date | null;
  status: "note" | "draft" | "sent" | "received";
  label?: string | null;
  notes?: string | null;
  supplier_name: string;
  supplier_eik?: string | null;
  supplier_contact?: string | null;
  supplier_email?: string | null;
  supplier_phone?: string | null;
  supplier_address?: string | null;
  items: Array<{
    product_code?: string | null;
    product_name: string;
    product_unit?: string | null;
    quantity: number | string;
    notes?: string | null;
  }>;
}

function fmtDate(input: string | Date | null | undefined): string {
  if (!input) return "—";
  const d = typeof input === "string" ? new Date(input) : input;
  if (isNaN(d.getTime())) return "—";
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

const STATUS_LABELS: Record<string, string> = {
  note: "Бележка / Note",
  draft: "Чернова / Draft",
  sent: "Изпратена / Sent",
  received: "Получена / Received",
};

export async function generatePurchaseOrderPdf(
  data: PurchaseOrderPdfData,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 40, bottom: 40, left: 40, right: 40 },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.registerFont("Main", FONT_REGULAR);
    doc.registerFont("MainBold", FONT_BOLD);

    const L = 40;
    const pageW = doc.page.width - 80;

    // ── Title ──────────────────────────────────────────────
    const isNote = data.status === "note";
    const titleBg = isNote
      ? `БЕЛЕЖКА${data.label ? ` — ${data.label}` : ""}`
      : "ЗАЯВКА";
    const titleEn = isNote
      ? `NOTE${data.label ? ` — ${data.label}` : ""}`
      : "PURCHASE ORDER";

    doc.font("MainBold").fontSize(20).fillColor("#0f172a");
    doc.text(`${titleBg} / ${titleEn}`, L, doc.y, {
      width: pageW,
      align: "center",
    });
    doc.moveDown(0.2);
    doc.font("Main").fontSize(10).fillColor("#475569");
    if (!isNote) {
      doc.text(`№ ${data.order_number}`, L, doc.y, {
        width: pageW,
        align: "center",
      });
    }
    doc.fillColor("#0f172a");
    doc.moveDown(0.6);

    // ── Meta strip ─────────────────────────────────────────
    const metaY = doc.y;
    const metaCol = pageW / 3;
    const metaCell = (
      x: number,
      labelBg: string,
      labelEn: string,
      value: string,
    ) => {
      doc.font("Main").fontSize(7.5).fillColor("#64748b");
      doc.text(`${labelBg} / ${labelEn}`, x, metaY, { width: metaCol - 8 });
      doc.font("MainBold").fontSize(10).fillColor("#0f172a");
      doc.text(value, x, doc.y, { width: metaCol - 8 });
    };
    metaCell(L, "Дата", "Date", fmtDate(data.created_at));
    metaCell(
      L + metaCol,
      "Очаквана доставка",
      "Expected delivery",
      fmtDate(data.expected_delivery_date),
    );
    metaCell(
      L + metaCol * 2,
      "Статус",
      "Status",
      STATUS_LABELS[data.status] ?? data.status,
    );
    doc.moveDown(1);

    // ── Supplier block ─────────────────────────────────────
    doc
      .rect(L, doc.y, pageW, 1)
      .fillColor("#e2e8f0")
      .fill()
      .fillColor("#0f172a");
    doc.moveDown(0.4);

    doc.font("MainBold").fontSize(9).fillColor("#64748b");
    doc.text("ДОСТАВЧИК / SUPPLIER", L, doc.y, { width: pageW });
    doc.moveDown(0.3);

    const supplierLines: Array<[string, string]> = [
      ["Име / Name:", data.supplier_name],
      ["ЕИК / Tax ID:", data.supplier_eik || ""],
      ["Лице за контакт / Contact:", data.supplier_contact || ""],
      ["E-mail:", data.supplier_email || ""],
      ["Телефон / Phone:", data.supplier_phone || ""],
      ["Адрес / Address:", data.supplier_address || ""],
    ];
    for (const [label, value] of supplierLines) {
      if (!value) continue;
      doc.font("Main").fontSize(9).fillColor("#475569");
      doc.text(label, L, doc.y, { width: 130, continued: true });
      doc.font("MainBold").fillColor("#0f172a");
      doc.text(value, { width: pageW - 130 });
    }
    doc.moveDown(0.8);

    // ── Items table ────────────────────────────────────────
    // Code column gets the lion's share — Chinese suppliers identify
    // products primarily by SKU.
    const cols = [
      { headerBg: "№", headerEn: "#", w: 28, align: "right" as const },
      {
        headerBg: "Код",
        headerEn: "SKU / Code",
        w: 130,
        align: "left" as const,
      },
      {
        headerBg: "Наименование",
        headerEn: "Description",
        w: pageW - 28 - 130 - 70 - 70,
        align: "left" as const,
      },
      {
        headerBg: "Количество",
        headerEn: "Quantity",
        w: 70,
        align: "right" as const,
      },
      {
        headerBg: "Мярка",
        headerEn: "Unit",
        w: 70,
        align: "left" as const,
      },
    ];

    const headerY = doc.y;
    doc.rect(L, headerY, pageW, 28).fillColor("#0f172a").fill();
    let cx = L;
    doc.fillColor("#ffffff");
    for (const c of cols) {
      doc.font("MainBold").fontSize(8.5);
      doc.text(c.headerBg, cx + 4, headerY + 4, {
        width: c.w - 8,
        align: c.align,
      });
      doc.font("Main").fontSize(7);
      doc.text(c.headerEn, cx + 4, headerY + 16, {
        width: c.w - 8,
        align: c.align,
      });
      cx += c.w;
    }
    doc.fillColor("#0f172a");

    let rowY = headerY + 28;
    for (const [idx, item] of data.items.entries()) {
      // Estimate row height — name can wrap
      const nameH = doc
        .font("Main")
        .fontSize(9)
        .heightOfString(item.product_name, { width: cols[2].w - 8 });
      const codeH = doc
        .font("MainBold")
        .fontSize(10)
        .heightOfString(item.product_code || "—", { width: cols[1].w - 8 });
      const rowH = Math.max(nameH, codeH, 18) + 8;

      // Page break if needed
      if (rowY + rowH > doc.page.height - 60) {
        doc.addPage();
        rowY = 40;
      }

      // Zebra background
      if (idx % 2 === 0) {
        doc.rect(L, rowY, pageW, rowH).fillColor("#f8fafc").fill();
      }

      doc.fillColor("#0f172a");
      let cellX = L;
      doc.font("Main").fontSize(9);
      doc.text(String(idx + 1), cellX + 4, rowY + 6, {
        width: cols[0].w - 8,
        align: "right",
      });
      cellX += cols[0].w;

      doc.font("MainBold").fontSize(11);
      doc.text(item.product_code || "—", cellX + 4, rowY + 6, {
        width: cols[1].w - 8,
      });
      cellX += cols[1].w;

      doc.font("Main").fontSize(9);
      doc.text(item.product_name, cellX + 4, rowY + 6, {
        width: cols[2].w - 8,
      });
      cellX += cols[2].w;

      doc.font("MainBold").fontSize(10);
      doc.text(String(item.quantity), cellX + 4, rowY + 6, {
        width: cols[3].w - 8,
        align: "right",
      });
      cellX += cols[3].w;

      doc.font("Main").fontSize(9);
      doc.text(item.product_unit || "бр. / pcs", cellX + 4, rowY + 6, {
        width: cols[4].w - 8,
      });

      rowY += rowH;
    }

    // Bottom border
    doc
      .rect(L, headerY, pageW, rowY - headerY)
      .strokeColor("#cbd5e1")
      .stroke();

    doc.y = rowY + 12;

    // ── Notes ──────────────────────────────────────────────
    if (data.notes) {
      doc.font("MainBold").fontSize(9).fillColor("#64748b");
      doc.text("БЕЛЕЖКИ / NOTES", L, doc.y, { width: pageW });
      doc.moveDown(0.2);
      doc.font("Main").fontSize(9).fillColor("#0f172a");
      doc.text(data.notes, L, doc.y, { width: pageW });
      doc.moveDown(0.6);
    }

    // ── Totals row (count only, no prices) ─────────────────
    const totalQty = data.items.reduce(
      (s, i) => s + Number(i.quantity || 0),
      0,
    );
    doc.font("MainBold").fontSize(10).fillColor("#0f172a");
    doc.text(
      `Общо артикули / Total items: ${data.items.length}     ·     Общо количество / Total quantity: ${totalQty}`,
      L,
      doc.y,
      { width: pageW, align: "right" },
    );

    doc.end();
  });
}
