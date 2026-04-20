import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { query } from "../db.js";
import * as iconv from "iconv-lite";

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

/** Format date as DD.MM.YYYY for Delta Pro */
export function formatDate(date: Date | string): string {
  if (typeof date === "string") {
    const dateOnlyMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/);
    if (dateOnlyMatch) {
      const [, year, month, day] = dateOnlyMatch;
      return `${day}.${month}.${year}`;
    }
  }

  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

/** Extract numeric part from invoice number and pad to 10 digits */
export function formatDocNumber(invoiceNumber: string): string {
  // Strip any non-digit prefix (GF-2026-, КИ-, etc.)
  const numericPart = invoiceNumber.replace(/^[^0-9]*/g, "").replace(/-/g, "");
  return numericPart.padStart(10, "0");
}

/**
 * Determine VAT group code:
 *   11 = EU reverse charge (Greek/foreign supplier)
 *   8  = No VAT / exempt
 *   16 = Standard 20% Bulgarian VAT
 */
export function getVatGroup(
  vatNumber: string | null,
  includeVat?: boolean,
): number {
  if (vatNumber && (vatNumber.startsWith("EL") || vatNumber.startsWith("GR"))) {
    return 11;
  }
  if (includeVat === false) {
    return 8;
  }
  return 16;
}

/** Build a single pipe-delimited line */
function buildLine(fields: (string | number)[]): string {
  return fields.join("|");
}

export interface DocLineParams {
  typeCode: number;
  date: string;
  docNum: string;
  docType: string;
  amount: string;
  vatGroup: number;
  company: string;
  mol: string;
  city: string;
  address: string;
  vatNumber: string;
  eik: string;
  reason: string;
  vatAmount: string;
}

/** Build the main document line (type 1/2/7/9) */
export function buildDocLine(doc: DocLineParams): string {
  return buildLine([
    doc.typeCode,
    doc.date,
    doc.docNum,
    doc.docType,
    doc.amount,
    doc.vatGroup,
    doc.company,
    doc.mol,
    doc.city,
    doc.address,
    doc.vatNumber,
    doc.eik,
    "   ",
    doc.reason,
    " ",
    doc.vatAmount,
  ]);
}

/** Build the VAT/payment line (type 10) that follows each document */
export function buildVatLine(doc: DocLineParams): string {
  return buildLine([
    10,
    doc.date,
    doc.docNum,
    doc.docType,
    doc.amount,
    8,
    doc.company,
    doc.mol,
    doc.city,
    doc.address,
    doc.vatNumber,
    doc.eik,
    "   ",
    "Плащане в брой",
    " ",
    "0.00",
  ]);
}

export default async function exportRoutes(app: FastifyInstance) {
  // GET /export/delta-pro — Delta Pro accounting export
  app.get(
    "/delta-pro",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);

      if (request.user.role !== "admin" && request.user.role !== "accountant") {
        return reply.status(403).send({ error: "Нямате достъп до експорт" });
      }

      const { from, to, type } = request.query as {
        from?: string;
        to?: string;
        type?: string;
      };

      if (!from || !to) {
        return reply
          .status(400)
          .send({ error: "Параметри 'from' и 'to' са задължителни" });
      }

      const exportType = type || "all";
      if (!["sales", "purchases", "all"].includes(exportType)) {
        return reply
          .status(400)
          .send({ error: "type трябва да е 'sales', 'purchases' или 'all'" });
      }

      const lines: string[] = [];

      // ── Sales: invoices → type 2 (invoice), 9 (credit_note), 7 (debit_note)
      if (exportType === "sales" || exportType === "all") {
        const { rows: invoices } = await query(
          `SELECT i.invoice_number, i.invoice_date, i.total_gross, i.total_vat,
                  i.include_vat, i.document_type,
                  p.name AS partner_name, p.contact_person, p.city, p.address,
                  p.vat_number, p.eik
           FROM invoices i
           JOIN partners p ON p.id = i.partner_id
           WHERE i.invoice_date >= $1 AND i.invoice_date <= $2
             AND i.status = 'active'
           ORDER BY i.invoice_date, i.invoice_number`,
          [from, to],
        );

        for (const inv of invoices) {
          const vatGroup = getVatGroup(inv.vat_number, inv.include_vat);

          let typeCode: number;
          let docTypeLabel: string;
          let reason: string;

          switch (inv.document_type) {
            case "credit_note":
              typeCode = 9;
              docTypeLabel = "КИ";
              reason = "Кредитно известие";
              break;
            case "debit_note":
              typeCode = 7;
              docTypeLabel = "Д-ги";
              reason = "Дебитно известие";
              break;
            default:
              typeCode = 2;
              docTypeLabel = "Ф-ра";
              reason = "Издадена фактура";
              break;
          }

          const vatAmount =
            vatGroup === 16 ? parseFloat(inv.total_vat).toFixed(2) : "0.00";

          const doc: DocLineParams = {
            typeCode,
            date: formatDate(inv.invoice_date),
            docNum: formatDocNumber(inv.invoice_number),
            docType: docTypeLabel,
            amount: parseFloat(inv.total_gross).toFixed(2),
            vatGroup,
            company: inv.partner_name || "",
            mol: inv.contact_person || "",
            city: inv.city || "",
            address: inv.address || "",
            vatNumber: inv.vat_number || "",
            eik: inv.eik || "",
            reason,
            vatAmount,
          };

          lines.push(buildDocLine(doc));
          lines.push(buildVatLine(doc));
        }
      }

      // ── Purchases: incoming_goods → type 1
      if (exportType === "purchases" || exportType === "all") {
        const { rows: purchases } = await query(
          `SELECT ig.invoice_number, ig.invoice_date, ig.total_amount,
                  s.name AS supplier_name, s.contact_person, s.address,
                  s.vat_number, s.eik
           FROM incoming_goods ig
           JOIN suppliers s ON s.id = ig.supplier_id
           WHERE ig.invoice_date >= $1 AND ig.invoice_date <= $2
             AND ig.status = 'confirmed'
           ORDER BY ig.invoice_date, ig.invoice_number`,
          [from, to],
        );

        for (const pur of purchases) {
          const vatGroup = getVatGroup(pur.vat_number);
          const totalAmount = parseFloat(pur.total_amount);
          // For BG with VAT: gross = net * 1.2 → VAT = gross / 6
          const vatAmount =
            vatGroup === 16 ? (totalAmount / 6).toFixed(2) : "0.00";

          const doc: DocLineParams = {
            typeCode: 1,
            date: formatDate(pur.invoice_date),
            docNum: formatDocNumber(pur.invoice_number || ""),
            docType: "Ф-ра",
            amount: totalAmount.toFixed(2),
            vatGroup,
            company: pur.supplier_name || "",
            mol: pur.contact_person || "",
            city: "",
            address: pur.address || "",
            vatNumber: pur.vat_number || "",
            eik: pur.eik || "",
            reason: "Получена фактура",
            vatAmount,
          };

          lines.push(buildDocLine(doc));
          lines.push(buildVatLine(doc));
        }
      }

      // Encode to CP1251 with Windows line endings
      const content = lines.join("\r\n");
      const encoded = iconv.encode(content, "win1251");

      const today = new Date().toISOString().split("T")[0];
      const filename = `export_${today}.xml`;

      return reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(Buffer.from(encoded));
    },
  );

  // GET /export/microinvest/writeoffs — CSV export of stock write-offs as
  // Microinvest Delta Pro "Брак" documents. Delta Pro's native .xml schema
  // has no stable public spec for брак-документи, so we emit a CSV that the
  // accountant imports via Delta Pro's generic CSV import wizard. Column
  // order matches what Delta Pro's "Операции → Брак" import expects.
  app.get(
    "/microinvest/writeoffs",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);

      if (request.user.role !== "admin" && request.user.role !== "accountant") {
        return reply.status(403).send({ error: "Нямате достъп до експорт" });
      }

      const { from, to } = request.query as { from?: string; to?: string };
      if (!from || !to) {
        return reply
          .status(400)
          .send({ error: "Параметри 'from' и 'to' са задължителни" });
      }

      const { rows } = await query(
        `SELECT w.document_number, w.written_off_at, w.quantity,
                w.unit_cost, w.total_cost, w.reason,
                p.sku, p.name_bg, p.unit,
                b.batch_number
         FROM stock_writeoffs w
         JOIN products p ON p.id = w.product_id
         LEFT JOIN batches b ON b.id = w.batch_id
         WHERE w.written_off_at::date >= $1
           AND w.written_off_at::date <= $2
         ORDER BY w.written_off_at, w.document_number`,
        [from, to],
      );

      const REASON_BG: Record<string, string> = {
        expired: "Изтекъл срок на годност",
        damaged: "Повреда",
        theft: "Липса",
        count_correction: "Коригиране при инвентаризация",
        recall: "Изтегляне от пазара",
        other: "Друго",
      };

      // CSV escape: wrap in quotes, double-up any embedded quotes.
      const esc = (v: unknown): string => {
        const s = v === null || v === undefined ? "" : String(v);
        if (/[",\n\r;]/.test(s)) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };

      const header = [
        "DocumentType",
        "DocumentNumber",
        "Date",
        "ProductCode",
        "ProductName",
        "Unit",
        "Quantity",
        "UnitCost",
        "TotalCost",
        "Reason",
        "BatchNumber",
      ].join(",");

      const lines: string[] = [header];
      for (const r of rows) {
        const dateIso =
          r.written_off_at instanceof Date
            ? r.written_off_at.toISOString().split("T")[0]
            : String(r.written_off_at).split("T")[0];
        const qty = parseFloat(r.quantity);
        const unitCost = parseFloat(r.unit_cost);
        const totalCost = parseFloat(r.total_cost);
        lines.push(
          [
            esc("Брак"),
            esc(r.document_number),
            esc(dateIso),
            esc(r.sku || ""),
            esc(r.name_bg || ""),
            esc(r.unit || ""),
            esc(qty.toFixed(3)),
            esc(unitCost.toFixed(4)),
            esc(totalCost.toFixed(2)),
            esc(REASON_BG[r.reason] || r.reason),
            esc(r.batch_number || ""),
          ].join(","),
        );
      }

      const content = lines.join("\r\n");
      const encoded = iconv.encode(content, "win1251");
      const today = new Date().toISOString().split("T")[0];
      const filename = `writeoffs_${today}.csv`;

      return reply
        .header("Content-Type", "text/csv; charset=windows-1251")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(Buffer.from(encoded));
    },
  );
}
