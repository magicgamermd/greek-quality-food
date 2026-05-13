import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query, transaction } from "../db.js";
import {
  requirePermission,
  hasPermission,
  PERMISSIONS,
} from "../lib/permissions.js";
import { generateInvoicePdf } from "../services/invoice-pdf.js";
import {
  restoreOrderItemsToInventory,
  restorePartialItemsToInventory,
} from "../utils/order-stock.js";
import { formatEurAmount } from "../utils/currency.js";
import { invoicePaymentMethodSchema } from "../lib/invoice-payment-method.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

function resolveInvoicePdfPath(invoice: {
  pdf_path?: string | null;
  invoice_number?: string | null;
}) {
  const candidatePaths = new Set<string>();

  if (invoice.pdf_path) {
    candidatePaths.add(invoice.pdf_path);
    if (!path.isAbsolute(invoice.pdf_path)) {
      candidatePaths.add(path.resolve(invoice.pdf_path));
      candidatePaths.add(path.resolve(process.cwd(), invoice.pdf_path));
    }

    const basename = path.basename(invoice.pdf_path);
    if (basename) {
      candidatePaths.add(path.resolve("uploads", "invoices", basename));
      candidatePaths.add(
        path.resolve(process.cwd(), "uploads", "invoices", basename),
      );
    }
  }

  if (invoice.invoice_number) {
    const fallbackFilename = `${invoice.invoice_number}.pdf`;
    candidatePaths.add(path.resolve("uploads", "invoices", fallbackFilename));
    candidatePaths.add(
      path.resolve(process.cwd(), "uploads", "invoices", fallbackFilename),
    );
  }

  for (const candidate of candidatePaths) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Resolve a partner override into a numeric partner_id.
 * - {partner_id} → returned as-is (existing partner picked from catalog).
 * - new-partner data → SELECT by EIK; reuse existing or INSERT new with
 *   partner_type='legal_entity' (matches the rest of the system; the
 *   override flow is only used for individual → company invoicing).
 *
 * Runs inside the same transaction client as the surrounding invoice INSERT
 * so that a rollback unwinds the partner row too. Once committed, the new
 * partner stays in the catalog permanently and shows up in the regular
 * "Партньори" list / autocompletes.
 */
async function resolveOverridePartner(
  client: { query: (sql: string, params: any[]) => Promise<{ rows: any[] }> },
  override: any,
): Promise<number> {
  if ("partner_id" in override) return override.partner_id;

  const eik = override.eik.trim();
  const {
    rows: [existing],
  } = await client.query(`SELECT id FROM partners WHERE eik = $1 LIMIT 1`, [
    eik,
  ]);
  if (existing) return existing.id;

  const {
    rows: [created],
  } = await client.query(
    `INSERT INTO partners
       (name, eik, vat_number, address, city, contact_person, phone, email, partner_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'legal_entity')
     RETURNING id`,
    [
      override.name.trim(),
      eik,
      override.vat_number ?? null,
      override.address ?? null,
      override.city ?? null,
      override.contact_person ?? null,
      override.phone ?? null,
      override.email ?? null,
    ],
  );
  return created.id;
}

const createInvoiceSchema = z.object({
  order_id: z.number().int(),
  vat_rate: z.number().default(20), // Bulgarian VAT 20%
  include_vat: z.boolean().default(true),
  payment_method: invoicePaymentMethodSchema,
  // Optional — only meaningful when the order's partner is an individual.
  // If set, this name is printed on the invoice PDF instead of the partner's
  // generic name. Trim + normalise empty string → null so the DB stays clean.
  client_display_name: z
    .string()
    .trim()
    .max(255)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  // Optional EGN/ЕГН + address for a named individual receiver. Same
  // mutual-exclusivity rules as client_display_name (cleared when an
  // override partner is in effect).
  client_display_egn: z
    .string()
    .trim()
    .max(20)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  client_display_address: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  // Legal basis printed in the "Основание за сделката" line of the PDF
  // when the invoice is issued without VAT. Free text; empty → null.
  vat_exemption_reason: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  // Free-text note (e.g. "по проект Алфа") printed below the totals.
  invoice_note: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  // Optional override for invoice_date — e.g. when something was sold on
  // Saturday but the cashier wants the paperwork dated Friday so the
  // weekly accounting flow stays clean. Sequential invoice number is NOT
  // affected; only invoice_date changes. Frontend gates this behind a
  // hidden "−/+" keyboard chord so the field doesn't surface during the
  // normal flow. Format: ISO YYYY-MM-DD.
  invoice_date_override: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  // Batch D — Issue invoice in the name of a different (company) partner when
  // the order's partner is an individual. Either pick an existing partner by
  // id, or supply full new-partner data — server upserts by EIK.
  partner_override: z
    .union([
      z.object({ partner_id: z.number().int().positive() }),
      z.object({
        name: z.string().trim().min(1).max(255),
        eik: z.string().trim().min(1).max(50),
        vat_number: z.string().trim().max(50).optional(),
        address: z.string().trim().max(500).optional(),
        city: z.string().trim().max(100).optional(),
        contact_person: z.string().trim().max(255).optional(),
        phone: z.string().trim().max(50).optional(),
        email: z.string().trim().max(255).optional(),
      }),
    ])
    .optional(),
});

const regenerateInvoiceSchema = z.object({
  payment_method: invoicePaymentMethodSchema.optional(),
  // For regenerate, an absent field means "keep the previously stored
  // value" — handled via COALESCE in the UPDATE. Empty string is
  // treated the same as absent (no override). Length capped to match
  // createInvoiceSchema.
  vat_exemption_reason: z.string().trim().max(500).optional(),
  invoice_note: z.string().trim().max(2000).optional(),
  // Batch D — partner cannot be changed on regenerate. Forbid the field
  // outright so accidental clients (e.g. copy-paste from create flow) get a
  // 400 instead of a silent no-op.
  partner_override: z
    .never({
      invalid_type_error: "Partner cannot be changed on regenerate.",
    })
    .optional(),
});

const createCreditNoteSchema = z.object({
  related_invoice_id: z.number().int(),
  reason: z.string().trim().min(1).max(500),
  include_vat: z.boolean().optional(),
  // Return goods to inventory? Typically true for full reversal (returned goods),
  // false for discount/price-correction credit notes.
  restore_stock: z.boolean().optional(),
  // НОВО (partial credit note) — ако е подадено, КИ-то покрива САМО
  // избраните редове с указаните количества (per-line частично сторниране).
  // Без `items` поведението е backward-compatible: пълно КИ за всички
  // редове на оригиналната поръчка/фактура.
  // - order_item_id трябва да е от поръчката, свързана с related_invoice_id
  // - quantity > 0 AND ≤ оригиналното количество на реда
  // - цената се заключва на оригиналната (audit safety) — не я приемаме
  //   от клиента
  items: z
    .array(
      z.object({
        order_item_id: z.number().int().positive(),
        quantity: z.number().positive(),
      }),
    )
    .min(1)
    .optional(),
});

const sendEmailSchema = z.object({
  email: z.string().email().optional(), // Override partner email
});

const cancelInvoiceSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

// Query schema for GET /invoices/:id/pdf
// copies=1 (or absent) → serve cached on-disk PDF
// copies=2            → generate to a temp file, stream, do not cache
const pdfQuerySchema = z.object({
  copies: z
    .union([z.literal("1"), z.literal("2")])
    .optional()
    .transform((v) => (v ? (Number(v) as 1 | 2) : 1)),
  // Cache-busting param used by the frontend (ignored for caching purposes)
  t: z.string().optional(),
});

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

const jwtVerify = async (request: FastifyRequest) => {
  await request.jwtVerify();
};

const invoiceManagePreHandler = [
  jwtVerify,
  requirePermission(PERMISSIONS.INVOICES_MANAGE),
];

const invoiceCancelPreHandler = [
  jwtVerify,
  requirePermission(PERMISSIONS.INVOICES_CANCEL),
];

async function getCompanySettings(): Promise<{
  company_name: string;
  address: string;
  eik: string;
  vat_number: string;
  iban: string;
  phone: string;
  email: string;
  bank_name?: string;
  bic?: string;
  mol?: string;
  show_bgn_on_invoice?: boolean;
}> {
  const { rows } = await query("SELECT * FROM settings WHERE id = 1");
  const s = rows[0] || {};
  return {
    company_name: s.company_name || "BAKALIA GREEK DELI FOOD",
    address: s.address || "ул. Калогяново 14, 1618 София, България",
    eik: s.eik || "202860357",
    vat_number: s.vat_number || "BG202860357",
    iban: s.iban || "",
    phone: s.phone || "00886291003",
    email: s.email || "",
    bank_name: s.bank_name || undefined,
    bic: s.bic || undefined,
    mol: s.mol || undefined,
    show_bgn_on_invoice: s.show_bgn_on_invoice === true,
  };
}

export default async function invoiceRoutes(app: FastifyInstance) {
  // GET /invoices — admin and accountant only
  app.get(
    "/",
    { preHandler: invoiceManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const {
        partner_id,
        document_type,
        status,
        payment_status,
        date_from,
        date_to,
        q,
        invoice_number,
        page,
        limit,
      } = request.query as any;
      const pageNum = Math.max(1, parseInt(page) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 50));
      const offset = (pageNum - 1) * pageSize;

      const conditions: string[] = [];
      const havingConditions: string[] = [];
      const params: any[] = [];
      let paramIdx = 1;
      const paymentStatusSql = `CASE WHEN i.status = 'cancelled' THEN 'cancelled'
                 WHEN COALESCE(SUM(pay.amount), 0) >= i.total_gross THEN 'paid'
                 WHEN COALESCE(SUM(pay.amount), 0) > 0 THEN 'partial'
                 ELSE 'unpaid' END`;

      if (partner_id) {
        conditions.push(`i.partner_id = $${paramIdx++}`);
        params.push(parseInt(partner_id));
      }
      if (document_type) {
        conditions.push(`i.document_type = $${paramIdx++}`);
        params.push(document_type);
      }
      if (status) {
        conditions.push(`i.status = $${paramIdx++}`);
        params.push(status);
      }
      if (date_from) {
        conditions.push(`DATE(i.invoice_date) >= $${paramIdx++}`);
        params.push(date_from);
      }
      if (date_to) {
        conditions.push(`DATE(i.invoice_date) <= $${paramIdx++}`);
        params.push(date_to);
      }
      if (invoice_number) {
        conditions.push(`i.invoice_number ILIKE $${paramIdx++}`);
        params.push(`%${String(invoice_number).trim()}%`);
      }
      if (q) {
        // Transliteration-aware partner name match (Cyrillic ↔ Latin)
        conditions.push(
          `(i.invoice_number ILIKE $${paramIdx} OR normalize_search(p.name) ILIKE '%' || normalize_search($${paramIdx + 1}) || '%')`,
        );
        params.push(`%${String(q).trim()}%`, String(q).trim());
        paramIdx += 2;
      }
      if (payment_status) {
        havingConditions.push(`${paymentStatusSql} = $${paramIdx++}`);
        params.push(payment_status);
      }
      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const having =
        havingConditions.length > 0
          ? `HAVING ${havingConditions.join(" AND ")}`
          : "";

      // Snapshot WHERE-clause params before adding ORDER/LIMIT args for count query.
      const filterParams = [...params];

      // When searching free-text `q`, rank by partner-name similarity DESC.
      let orderClause = "ORDER BY i.created_at DESC";
      if (q) {
        orderClause = `ORDER BY similarity(normalize_search(p.name), normalize_search($${paramIdx})) DESC, i.created_at DESC`;
        params.push(String(q).trim());
        paramIdx++;
      }

      const sql = `
      SELECT i.*, p.name AS partner_name,
             COALESCE(SUM(pay.amount), 0)::numeric AS paid_amount,
             ${paymentStatusSql} AS payment_status,
             ri.invoice_number AS related_invoice_number,
             cn.id AS credit_note_id,
             cn.invoice_number AS credit_note_number
      FROM invoices i
      JOIN partners p ON p.id = i.partner_id
      LEFT JOIN payments pay ON pay.invoice_id = i.id
      LEFT JOIN invoices ri ON ri.id = i.related_invoice_id
      LEFT JOIN invoices cn ON cn.related_invoice_id = i.id
          AND cn.document_type = 'credit_note'
      ${where}
      GROUP BY i.id, p.name, ri.invoice_number, cn.id, cn.invoice_number
      ${having}
      ${orderClause}
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
      params.push(pageSize, offset);

      const { rows } = await query(sql, params);

      // Count total for pagination (HAVING requires COUNT over the grouped set)
      const countSql = having
        ? `SELECT COUNT(*) AS total FROM (
          SELECT i.id
          FROM invoices i
          JOIN partners p ON p.id = i.partner_id
          LEFT JOIN payments pay ON pay.invoice_id = i.id
          ${where}
          GROUP BY i.id
          ${having}
        ) sub`
        : `SELECT COUNT(DISTINCT i.id) AS total
         FROM invoices i
         JOIN partners p ON p.id = i.partner_id
         ${where}`;
      const { rows: countRows } = await query(countSql, filterParams);
      const total = parseInt(countRows[0]?.total || "0");

      return {
        data: rows,
        pagination: { page: pageNum, limit: pageSize, total },
      };
    },
  );

  // GET /invoices/:id — single invoice
  app.get(
    "/:id",
    { preHandler: invoiceManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const {
        rows: [invoice],
      } = await query(
        `SELECT i.*, p.name AS partner_name,
              COALESCE(SUM(pay.amount), 0)::numeric AS paid_amount,
              CASE WHEN i.status = 'cancelled' THEN 'cancelled'
                   WHEN COALESCE(SUM(pay.amount), 0) >= i.total_gross THEN 'paid'
                   WHEN COALESCE(SUM(pay.amount), 0) > 0 THEN 'partial'
                   ELSE 'unpaid' END AS payment_status
       FROM invoices i
       JOIN partners p ON p.id = i.partner_id
       LEFT JOIN payments pay ON pay.invoice_id = i.id
       WHERE i.id = $1
       GROUP BY i.id, p.name`,
        [id],
      );

      if (!invoice) {
        return reply.status(404).send({ error: "Invoice not found" });
      }
      return invoice;
    },
  );

  // GET /invoices/unpaid
  app.get(
    "/unpaid",
    { preHandler: invoiceManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { rows } = await query(`
      SELECT i.*, p.name AS partner_name,
             COALESCE(SUM(pay.amount), 0)::numeric AS paid_amount,
             i.total_gross - COALESCE(SUM(pay.amount), 0) AS remaining
      FROM invoices i
      JOIN partners p ON p.id = i.partner_id
      LEFT JOIN payments pay ON pay.invoice_id = i.id
      WHERE i.document_type = 'invoice' AND i.status = 'active'
      GROUP BY i.id, p.name
      HAVING COALESCE(SUM(pay.amount), 0) < i.total_gross
      ORDER BY i.invoice_date ASC
    `);

      return { data: rows, count: rows.length };
    },
  );

  // POST /invoices — generate invoice for an order
  app.post(
    "/",
    { preHandler: invoiceManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = createInvoiceSchema.parse(request.body);

      const result = await transaction(async (client) => {
        // Get order with items
        const {
          rows: [order],
        } = await client.query("SELECT * FROM orders WHERE id = $1", [
          body.order_id,
        ]);

        if (!order) {
          throw Object.assign(new Error("Order not found"), {
            statusCode: 404,
          });
        }
        if (order.invoice_id) {
          throw Object.assign(
            new Error("Invoice already exists for this order"),
            { statusCode: 409 },
          );
        }
        if (
          order.status !== "confirmed" &&
          order.status !== "processing" &&
          order.status !== "fulfilled"
        ) {
          throw Object.assign(
            new Error(
              "Поръчката трябва да е потвърдена, в обработка или изпълнена преди генериране на фактура",
            ),
            { statusCode: 400 },
          );
        }

        // Skip awaiting lines — these are placeholders for goods that
        // haven't arrived yet (migration 072) and don't belong on the
        // invoice. They live on the order for visibility but the
        // child order owns the active workflow.
        const { rows: items } = await client.query(
          `SELECT oi.*,
                  oi.name_bg_snapshot AS name_bg,
                  oi.name_en_snapshot AS name_en,
                  oi.sku_snapshot     AS sku,
                  p.unit, p.brand
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = $1
           AND oi.line_status != 'awaiting'
         ORDER BY oi.id`,
          [body.order_id],
        );

        const {
          rows: [partner],
        } = await client.query("SELECT * FROM partners WHERE id = $1", [
          order.partner_id,
        ]);

        // Only accept a display-name override when the buyer is an individual.
        // Storing it on legal-entity invoices would make the DB state misleading
        // even though the PDF ignores it.
        let invoicePartnerId: number = order.partner_id;
        let clientDisplayName: string | null =
          partner?.partner_type === "individual"
            ? (body.client_display_name ?? null)
            : null;
        let clientDisplayEgn: string | null =
          partner?.partner_type === "individual"
            ? (body.client_display_egn ?? null)
            : null;
        let clientDisplayAddress: string | null =
          partner?.partner_type === "individual"
            ? (body.client_display_address ?? null)
            : null;

        // Batch D — partner override.
        //
        // Two paths to the override receiver, in priority order:
        //   1. `orders.invoice_partner_id` (migration 068) — auto-saved
        //      the moment the cashier picked "Издай на фирма" via
        //      PUT /orders/:id/invoice-partner, so it already applies to
        //      every transaction document and survives invoice deletion.
        //   2. `body.partner_override` (legacy) — kept for backward
        //      compatibility with older clients that send the override
        //      inline at invoice creation time. Persisted onto the order
        //      so subsequent docs see it too.
        //
        // Either way the order's `partner_id` is left alone; the invoice
        // points to the resolved company partner.
        if (order.invoice_partner_id) {
          if (partner?.partner_type !== "individual") {
            throw Object.assign(
              new Error(
                "Invoice partner override is allowed only for individual orders",
              ),
              { statusCode: 400 },
            );
          }
          invoicePartnerId = order.invoice_partner_id;
          clientDisplayName = null;
          clientDisplayEgn = null;
          clientDisplayAddress = null;
        } else if (body.partner_override) {
          if (partner?.partner_type !== "individual") {
            throw Object.assign(
              new Error(
                "partner_override is allowed only for individual orders",
              ),
              { statusCode: 400 },
            );
          }
          invoicePartnerId = await resolveOverridePartner(
            client,
            body.partner_override,
          );
          // Mirror the legacy override onto the order so downstream
          // documents stay consistent if it lands here first.
          await client.query(
            "UPDATE orders SET invoice_partner_id = $1 WHERE id = $2",
            [invoicePartnerId, body.order_id],
          );
          clientDisplayName = null;
          clientDisplayEgn = null;
          clientDisplayAddress = null;
        }

        // GQF: order_items.total_price е NET (без ДДС). Greek Quality
        // Food пази цените като net стойности — за разлика от MERT-M,
        // където са gross. ДДС се добавя ОТГОРЕ:
        //   total_net = sum(line.total_price)
        //   total_vat = total_net × vat_rate
        //   total_gross = total_net + total_vat
        const totalNetLines = items.reduce(
          (sum: number, i: any) => sum + parseFloat(i.total_price),
          0,
        );
        const effectiveVatRate = body.include_vat ? body.vat_rate : 0;
        const totalNet = totalNetLines;
        const totalVat = body.include_vat
          ? (totalNet * body.vat_rate) / 100
          : 0;
        const totalGross = totalNet + totalVat;

        // Generate invoice number
        const {
          rows: [{ generate_invoice_number: invoiceNumber }],
        } = await client.query("SELECT generate_invoice_number()");

        // Create invoice record
        const {
          rows: [invoice],
        } = await client.query(
          `INSERT INTO invoices
           (invoice_number, invoice_date, partner_id,
            total_net, total_vat, total_gross, include_vat,
            client_display_name, client_display_egn, client_display_address,
            payment_method, vat_exemption_reason, invoice_note)
         VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
          [
            invoiceNumber,
            body.invoice_date_override ?? null,
            invoicePartnerId,
            totalNet,
            totalVat,
            totalGross,
            body.include_vat,
            clientDisplayName,
            clientDisplayEgn,
            clientDisplayAddress,
            body.payment_method,
            body.vat_exemption_reason ?? null,
            body.invoice_note ?? null,
          ],
        );

        // Link order to invoice. Do NOT auto-change status — invoicing is
        // orthogonal to the warehouse flow (pending → confirmed → processing →
        // fulfilled). "Фактурирана" is now a flag (invoice_id IS NOT NULL), not
        // a linear status.
        await client.query(
          "UPDATE orders SET invoice_id = $1, updated_at = NOW() WHERE id = $2",
          [invoice.id, body.order_id],
        );

        // Generate PDF
        const company = await getCompanySettings();
        const invoicesDir = path.resolve("uploads", "invoices");
        fs.mkdirSync(invoicesDir, { recursive: true });

        // Re-fetch the partner row for the PDF whenever the resolved
        // invoice partner differs from the order's own partner. The override
        // can land here via TWO paths — `body.partner_override` (legacy
        // inline) OR `orders.invoice_partner_id` (persisted, set by
        // PUT /orders/:id/invoice-partner before invoice issue, and
        // surviving previous invoice deletions). Without this re-fetch,
        // re-issuing a deleted invoice on a previously-overridden order
        // would print the original individual on the PDF even though
        // invoice.partner_id correctly points to the company.
        let invoicePartner = partner;
        if (invoicePartnerId !== order.partner_id) {
          const { rows } = await client.query(
            "SELECT * FROM partners WHERE id = $1",
            [invoicePartnerId],
          );
          invoicePartner = rows[0] ?? partner;
        }

        const pdfPath = path.join(invoicesDir, `${invoiceNumber}.pdf`);
        await generateInvoicePdf({
          invoice,
          partner: invoicePartner,
          company,
          items,
          vatRate: effectiveVatRate,
          includeVat: body.include_vat,
          sourceCurrency: (invoice as any).currency ?? null,
          outputPath: pdfPath,
          showBgn: company.show_bgn_on_invoice === true,
        });

        // Store PDF path
        await client.query("UPDATE invoices SET pdf_path = $1 WHERE id = $2", [
          pdfPath,
          invoice.id,
        ]);

        return { ...invoice, pdf_path: pdfPath };
      });

      return reply.status(201).send(result);
    },
  );

  // PUT /invoices/:id/regenerate — recalculate invoice from current order items
  app.put(
    "/:id/regenerate",
    { preHandler: invoiceManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = regenerateInvoiceSchema.parse(request.body || {});

      const result = await transaction(async (client) => {
        // Get invoice
        const {
          rows: [invoice],
        } = await client.query("SELECT * FROM invoices WHERE id = $1", [id]);

        if (!invoice) {
          throw Object.assign(new Error("Invoice not found"), {
            statusCode: 404,
          });
        }
        if (invoice.document_type !== "invoice") {
          throw Object.assign(new Error("Only invoices can be regenerated"), {
            statusCode: 400,
          });
        }
        if (invoice.status === "cancelled") {
          throw Object.assign(
            new Error("Cancelled invoice cannot be regenerated"),
            {
              statusCode: 400,
            },
          );
        }

        // Find the order linked to this invoice
        const {
          rows: [order],
        } = await client.query("SELECT * FROM orders WHERE invoice_id = $1", [
          id,
        ]);

        if (!order) {
          throw Object.assign(new Error("No order linked to this invoice"), {
            statusCode: 400,
          });
        }

        // Get current order items — skip awaiting lines (migration 072,
        // doc generation never includes them).
        const { rows: items } = await client.query(
          `SELECT oi.*,
                  oi.name_bg_snapshot AS name_bg,
                  oi.name_en_snapshot AS name_en,
                  oi.sku_snapshot     AS sku,
                  p.unit, p.brand
           FROM order_items oi
           LEFT JOIN products p ON p.id = oi.product_id
           WHERE oi.order_id = $1
             AND oi.line_status != 'awaiting'
           ORDER BY oi.id`,
          [order.id],
        );

        // Use the invoice's own partner_id, not order.partner_id. When a
        // partner override was applied at issuance (Batch D — individual
        // order, invoice on a company), invoice.partner_id holds the
        // company while order.partner_id is still the individual. Reading
        // order.partner_id here would regenerate the PDF with the
        // individual's data instead of the company's.
        const {
          rows: [partner],
        } = await client.query("SELECT * FROM partners WHERE id = $1", [
          invoice.partner_id,
        ]);

        // GQF: order_items.total_price е NET (без ДДС). Recalculate
        // съответства на POST /invoices: total_vat = total_net × rate,
        // total_gross = total_net + total_vat.
        const totalNetLines = items.reduce(
          (sum: number, i: any) => sum + parseFloat(i.total_price),
          0,
        );
        const includeVat = invoice.include_vat !== false;
        const vatRate = includeVat ? 20 : 0;
        const totalNet = totalNetLines;
        const totalVat = includeVat ? (totalNet * vatRate) / 100 : 0;
        const totalGross = totalNet + totalVat;

        const {
          rows: [{ total: paidTotal }],
        } = await client.query(
          "SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM payments WHERE invoice_id = $1",
          [id],
        );
        if (parseFloat(paidTotal) > totalGross + 0.001) {
          throw Object.assign(
            new Error(
              "Invoice cannot be regenerated: recorded payments exceed recalculated total",
            ),
            { statusCode: 409 },
          );
        }

        // Update invoice record. payment_method / vat_exemption_reason /
        // invoice_note are updated only when the regenerate request
        // explicitly carries a value — absent means "preserve". Empty
        // string is treated as absent (the FE sends undefined when the
        // user clears the input but doesn't intend to override).
        const overrideExemption =
          body.vat_exemption_reason && body.vat_exemption_reason.length > 0
            ? body.vat_exemption_reason
            : null;
        const overrideNote =
          body.invoice_note && body.invoice_note.length > 0
            ? body.invoice_note
            : null;
        const {
          rows: [updated],
        } = await client.query(
          `UPDATE invoices
             SET total_net = $1,
                 total_vat = $2,
                 total_gross = $3,
                 payment_method = COALESCE($4, payment_method),
                 vat_exemption_reason = COALESCE($5, vat_exemption_reason),
                 invoice_note = COALESCE($6, invoice_note)
           WHERE id = $7 RETURNING *`,
          [
            totalNet,
            totalVat,
            totalGross,
            body.payment_method ?? null,
            overrideExemption,
            overrideNote,
            id,
          ],
        );

        // Regenerate PDF
        const company = await getCompanySettings();
        const invoicesDir = path.resolve("uploads", "invoices");
        fs.mkdirSync(invoicesDir, { recursive: true });

        const pdfPath = path.join(invoicesDir, `${invoice.invoice_number}.pdf`);
        await generateInvoicePdf({
          invoice: updated,
          partner,
          company,
          items,
          vatRate,
          includeVat,
          sourceCurrency: (updated as any).currency ?? null,
          outputPath: pdfPath,
          showBgn: company.show_bgn_on_invoice === true,
        });

        await client.query("UPDATE invoices SET pdf_path = $1 WHERE id = $2", [
          pdfPath,
          id,
        ]);

        return { ...updated, pdf_path: pdfPath };
      });

      return result;
    },
  );

  // DELETE /invoices/:id — physically remove an invoice issued by mistake.
  // Allowed only BEFORE the order is fulfilled (no goods shipped → no legal
  // record needed). Once shipped, the only way out is /cancel (annul +
  // credit note). Deletion frees the invoice number; generate_invoice_number()
  // recomputes from MAX(invoice_number) so the next call reuses the slot.
  app.delete(
    "/:id",
    { preHandler: invoiceCancelPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const result = await transaction(async (client) => {
        const {
          rows: [invoice],
        } = await client.query(
          "SELECT * FROM invoices WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (!invoice) {
          throw Object.assign(new Error("Invoice not found"), {
            statusCode: 404,
          });
        }
        if (invoice.document_type !== "invoice") {
          throw Object.assign(
            new Error("Само изходящи фактури могат да се изтриват"),
            { statusCode: 400 },
          );
        }
        if (invoice.status === "cancelled") {
          throw Object.assign(
            new Error("Анулираните фактури не могат да се изтриват"),
            { statusCode: 400 },
          );
        }

        // Block delete if any payment exists (matching the cancel guard).
        const {
          rows: [{ total: paidTotal }],
        } = await client.query(
          "SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM payments WHERE invoice_id = $1",
          [id],
        );
        if (parseFloat(paidTotal) > 0.001) {
          throw Object.assign(
            new Error(
              "Не може да изтриете фактура с регистрирани плащания. Първо ги премахнете.",
            ),
            { statusCode: 400 },
          );
        }

        // Block delete if a credit note references this invoice.
        const {
          rows: [{ count: refCount }],
        } = await client.query(
          "SELECT COUNT(*)::int AS count FROM invoices WHERE related_invoice_id = $1",
          [id],
        );
        if (refCount > 0) {
          throw Object.assign(
            new Error(
              "Не може да изтриете фактура с издадено КИ. Анулирайте я вместо това.",
            ),
            { statusCode: 400 },
          );
        }

        // Block if any order linked to this invoice is fulfilled — by then
        // the invoice has legal force and may only be annulled.
        const { rows: linkedOrders } = await client.query(
          "SELECT id, status FROM orders WHERE invoice_id = $1",
          [id],
        );
        const fulfilledOrder = linkedOrders.find(
          (o: any) => o.status === "fulfilled" || o.status === "invoiced",
        );
        if (fulfilledOrder) {
          throw Object.assign(
            new Error(
              "Поръчката вече е изпълнена — не може да изтриете фактурата. Използвайте 'Анулирай'.",
            ),
            { statusCode: 400 },
          );
        }

        // FK orders.invoice_id ON DELETE SET NULL → order keeps existing,
        // FK invoice_number_reservations ON DELETE CASCADE → resv row removed,
        // generate_invoice_number() will recompute MAX from invoices and the
        // next /invoices POST may reuse this slot.
        await client.query("DELETE FROM invoices WHERE id = $1", [id]);

        return {
          deleted: true,
          freed_invoice_number: invoice.invoice_number,
        };
      });

      return reply.send(result);
    },
  );

  // POST /invoices/:id/cancel — annul issued invoice while preserving consumed number
  app.post(
    "/:id/cancel",
    { preHandler: invoiceCancelPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = cancelInvoiceSchema.parse(request.body || {});

      const result = await transaction(async (client) => {
        const {
          rows: [invoice],
        } = await client.query(
          "SELECT * FROM invoices WHERE id = $1 FOR UPDATE",
          [id],
        );

        if (!invoice) {
          throw Object.assign(new Error("Invoice not found"), {
            statusCode: 404,
          });
        }
        if (invoice.document_type !== "invoice") {
          throw Object.assign(
            new Error("Only outgoing invoices can be cancelled"),
            { statusCode: 400 },
          );
        }
        if (invoice.status === "cancelled") {
          throw Object.assign(new Error("Invoice already cancelled"), {
            statusCode: 400,
          });
        }

        const {
          rows: [{ total: paidTotal }],
        } = await client.query(
          "SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM payments WHERE invoice_id = $1",
          [id],
        );
        if (parseFloat(paidTotal) > 0.001) {
          throw Object.assign(
            new Error("Invoice with recorded payments cannot be cancelled"),
            { statusCode: 409 },
          );
        }

        const { rows: relatedCreditNotes } = await client.query(
          "SELECT id FROM invoices WHERE related_invoice_id = $1 AND document_type = 'credit_note' LIMIT 1",
          [id],
        );
        if (relatedCreditNotes.length > 0) {
          throw Object.assign(
            new Error("Invoice with existing credit note cannot be cancelled"),
            { statusCode: 409 },
          );
        }

        const {
          rows: [cancelledInvoice],
        } = await client.query(
          `UPDATE invoices
           SET status = 'cancelled',
               cancelled_at = NOW(),
               cancel_reason = $1,
               cancelled_by = $2
           WHERE id = $3
           RETURNING *`,
          [body.reason || null, request.user.id, id],
        );

        const {
          rows: [order],
        } = await client.query(
          "SELECT id, order_number, status FROM orders WHERE invoice_id = $1 FOR UPDATE",
          [id],
        );

        if (order) {
          await restoreOrderItemsToInventory(client, order.id);

          await client.query(
            `UPDATE orders
             SET invoice_id = NULL,
                 annulled_invoice_id = $2,
                 annulled_invoice_number = $3,
                 annulled_invoice_at = NOW(),
                 annulled_invoice_reason = $4,
                 status = 'cancelled',
                 updated_at = NOW()
             WHERE id = $1`,
            [order.id, invoice.id, invoice.invoice_number, body.reason],
          );
        }

        await client.query(
          `INSERT INTO notifications (type, message) VALUES ('invoice_cancelled', $1)`,
          [
            `Фактура ${invoice.invoice_number} е анулирана. Причина: ${body.reason}${
              order ? ` (поръчка #${order.order_number || order.id})` : ""
            }`,
          ],
        );

        return {
          invoice: cancelledInvoice,
          order_id: order?.id ?? null,
        };
      });

      return result;
    },
  );

  // PATCH /invoices/:id/mark-sent
  app.patch(
    "/:id/mark-sent",
    { preHandler: invoiceManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const {
        rows: [invoice],
      } = await query("SELECT status FROM invoices WHERE id = $1", [id]);
      if (!invoice) {
        return reply.status(404).send({ error: "Invoice not found" });
      }
      if (invoice.status === "cancelled") {
        return reply
          .status(400)
          .send({ error: "Cancelled invoice cannot be marked as sent" });
      }

      await query("UPDATE invoices SET sent_at = NOW() WHERE id = $1", [id]);
      return reply.send({ ok: true });
    },
  );

  // GET /invoices/:id/pdf — download PDF (auto-regenerates if missing on disk)
  app.get(
    "/:id/pdf",
    { preHandler: invoiceManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const {
        rows: [invoice],
      } = await query("SELECT * FROM invoices WHERE id = $1", [id]);

      if (!invoice) {
        return reply.status(404).send({ error: "Invoice not found" });
      }

      // Parse and validate the ?copies query parameter.
      // Validation happens after the invoice lookup so that an unauthorized
      // request (no permission) still gets 403 rather than 400.
      const parsedQuery = pdfQuerySchema.safeParse(request.query);
      if (!parsedQuery.success) {
        return reply.status(400).send({
          error: "Невалидна стойност за copies. Допустими стойности: 1 или 2.",
        });
      }
      const copies = parsedQuery.data.copies; // 1 | 2

      // ── copies=2 path: generate to temp file, stream buffer, keep cache ──
      if (copies === 2) {
        try {
          const isCreditNote = invoice.document_type === "credit_note";
          const orderLookupInvoiceId = isCreditNote
            ? invoice.related_invoice_id
            : invoice.id;

          if (isCreditNote && !invoice.related_invoice_id) {
            return reply.status(404).send({
              error: "PDF not yet generated (credit note has no parent)",
            });
          }

          const {
            rows: [order],
          } = await query("SELECT * FROM orders WHERE invoice_id = $1", [
            orderLookupInvoiceId,
          ]);
          if (!order) {
            return reply
              .status(404)
              .send({ error: "PDF not yet generated (no linked order)" });
          }
          // Skip awaiting lines — see migration 072. Doc reissue path.
          const { rows: rawItems } = await query(
            `SELECT oi.*,
                    oi.name_bg_snapshot AS name_bg,
                    oi.name_en_snapshot AS name_en,
                    oi.sku_snapshot     AS sku,
                    p.unit, p.brand
             FROM order_items oi
             LEFT JOIN products p ON p.id = oi.product_id
             WHERE oi.order_id = $1
               AND oi.line_status != 'awaiting'
             ORDER BY oi.id`,
            [order.id],
          );
          const items = isCreditNote
            ? rawItems.map((item: any) => ({
                ...item,
                quantity: -Math.abs(parseFloat(item.quantity)),
                unit_price: parseFloat(item.unit_price),
                total_price: -Math.abs(parseFloat(item.total_price)),
              }))
            : rawItems;

          const {
            rows: [partner],
          } = await query("SELECT * FROM partners WHERE id = $1", [
            order.partner_id,
          ]);
          if (!partner) {
            return reply
              .status(404)
              .send({ error: "PDF not yet generated (partner missing)" });
          }

          let relatedInvoiceNumber: string | null = null;
          if (isCreditNote) {
            const {
              rows: [parent],
            } = await query(
              "SELECT invoice_number FROM invoices WHERE id = $1",
              [invoice.related_invoice_id],
            );
            relatedInvoiceNumber = parent?.invoice_number ?? null;
          }

          const company = await getCompanySettings();
          const includeVat = invoice.include_vat !== false;

          // Generate to a uniquely-named temp file — do NOT write to the
          // on-disk invoice cache so the 1-page version stays intact.
          const tmpPath = path.join(
            os.tmpdir(),
            `gqf-invoice-${invoice.id}-2copies-${randomUUID()}.pdf`,
          );
          try {
            await generateInvoicePdf({
              invoice,
              partner,
              company,
              items,
              vatRate: includeVat ? 20 : 0,
              includeVat,
              documentType: isCreditNote ? "credit_note" : "invoice",
              relatedInvoiceNumber: relatedInvoiceNumber ?? undefined,
              sourceCurrency: (invoice as any).currency ?? null,
              outputPath: tmpPath,
              copies: 2,
              showBgn: company.show_bgn_on_invoice === true,
            });
            const buf = await fs.promises.readFile(tmpPath);
            const filename2 = `${invoice.invoice_number}.pdf`;
            const encodedFilename2 = encodeURIComponent(filename2);
            return reply
              .header("Content-Type", "application/pdf")
              .header(
                "Content-Disposition",
                `inline; filename="${encodedFilename2}"; filename*=UTF-8''${encodedFilename2}`,
              )
              .header("Cache-Control", "no-store, must-revalidate")
              .header("Pragma", "no-cache")
              .send(buf);
          } finally {
            // Always clean up the temp file, even if generateInvoicePdf throws.
            await fs.promises.unlink(tmpPath).catch(() => {});
          }
        } catch (err: any) {
          request.log.error({ err }, "Failed to generate 2-copy invoice PDF");
          return reply
            .status(500)
            .send({ error: "Неуспешно генериране на 2 копия PDF." });
        }
      }

      // ── copies=1 path (default): serve cached file or regenerate to disk ──
      let resolvedPdfPath = resolveInvoicePdfPath(invoice);

      // Auto-regenerate if the file is missing (e.g. after container rebuild
      // wiped the uploads directory, or manual deletion).
      if (!resolvedPdfPath) {
        try {
          const isCreditNote = invoice.document_type === "credit_note";
          // Credit notes point at a parent invoice via related_invoice_id;
          // their line items are negated copies of the parent's order items.
          // Regular invoices are linked directly to an order.
          const orderLookupInvoiceId = isCreditNote
            ? invoice.related_invoice_id
            : invoice.id;

          if (isCreditNote && !invoice.related_invoice_id) {
            return reply.status(404).send({
              error: "PDF not yet generated (credit note has no parent)",
            });
          }

          const {
            rows: [order],
          } = await query("SELECT * FROM orders WHERE invoice_id = $1", [
            orderLookupInvoiceId,
          ]);
          if (!order) {
            return reply
              .status(404)
              .send({ error: "PDF not yet generated (no linked order)" });
          }
          // Skip awaiting lines — see migration 072. Credit note path.
          const { rows: rawItems } = await query(
            `SELECT oi.*,
                    oi.name_bg_snapshot AS name_bg,
                    oi.name_en_snapshot AS name_en,
                    oi.sku_snapshot     AS sku,
                    p.unit, p.brand
           FROM order_items oi
           LEFT JOIN products p ON p.id = oi.product_id
           WHERE oi.order_id = $1
             AND oi.line_status != 'awaiting'
           ORDER BY oi.id`,
            [order.id],
          );
          // For credit notes, negate qty + total (unit price stays positive)
          // to mirror the numbers rendered at issuance time.
          const items = isCreditNote
            ? rawItems.map((item: any) => ({
                ...item,
                quantity: -Math.abs(parseFloat(item.quantity)),
                unit_price: parseFloat(item.unit_price),
                total_price: -Math.abs(parseFloat(item.total_price)),
              }))
            : rawItems;

          const {
            rows: [partner],
          } = await query("SELECT * FROM partners WHERE id = $1", [
            order.partner_id,
          ]);
          if (!partner) {
            return reply
              .status(404)
              .send({ error: "PDF not yet generated (partner missing)" });
          }

          // For credit notes, look up the parent's invoice_number so the
          // PDF header can show "Към фактура: 0000000003".
          let relatedInvoiceNumber: string | null = null;
          if (isCreditNote) {
            const {
              rows: [parent],
            } = await query(
              "SELECT invoice_number FROM invoices WHERE id = $1",
              [invoice.related_invoice_id],
            );
            relatedInvoiceNumber = parent?.invoice_number ?? null;
          }

          const company = await getCompanySettings();
          const invoicesDir = path.resolve("uploads", "invoices");
          fs.mkdirSync(invoicesDir, { recursive: true });
          const pdfPath = path.join(
            invoicesDir,
            `${invoice.invoice_number}.pdf`,
          );
          const includeVat = invoice.include_vat !== false;
          await generateInvoicePdf({
            invoice,
            partner,
            company,
            items,
            vatRate: includeVat ? 20 : 0,
            includeVat,
            documentType: isCreditNote ? "credit_note" : "invoice",
            relatedInvoiceNumber: relatedInvoiceNumber ?? undefined,
            sourceCurrency: (invoice as any).currency ?? null,
            outputPath: pdfPath,
            showBgn: company.show_bgn_on_invoice === true,
          });
          await query("UPDATE invoices SET pdf_path = $1 WHERE id = $2", [
            pdfPath,
            id,
          ]);
          resolvedPdfPath = pdfPath;
        } catch (err: any) {
          request.log.error({ err }, "Failed to auto-regenerate invoice PDF");
          return reply
            .status(500)
            .send({ error: "Неуспешно авто-регенериране на PDF." });
        }
      }

      const stream = fs.createReadStream(resolvedPdfPath);
      const filename = `${invoice.invoice_number}.pdf`;
      const encodedFilename = encodeURIComponent(filename);
      return (
        reply
          .header("Content-Type", "application/pdf")
          .header(
            "Content-Disposition",
            `inline; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`,
          )
          // Prevent browser from serving a cached copy after the PDF was
          // regenerated — the URL /:id/pdf stays the same but the file
          // on disk changes after "Регенерирай".
          .header("Cache-Control", "no-store, must-revalidate")
          .header("Pragma", "no-cache")
          .send(stream)
      );
    },
  );

  // POST /invoices/:id/send-email
  app.post(
    "/:id/send-email",
    { preHandler: invoiceManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = sendEmailSchema.parse(request.body || {});

      const {
        rows: [invoice],
      } = await query(
        `SELECT i.*, p.name AS partner_name, p.email AS partner_email
       FROM invoices i
       JOIN partners p ON p.id = i.partner_id
       WHERE i.id = $1`,
        [id],
      );

      if (!invoice) {
        return reply.status(404).send({ error: "Invoice not found" });
      }
      if (invoice.status === "cancelled") {
        return reply
          .status(400)
          .send({ error: "Cancelled invoice cannot be sent by email" });
      }

      const recipientEmail = body.email || invoice.partner_email;
      if (!recipientEmail) {
        return reply.status(400).send({ error: "No email address available" });
      }

      if (!invoice.pdf_path || !fs.existsSync(invoice.pdf_path)) {
        return reply.status(400).send({ error: "PDF not yet generated" });
      }

      // Send email via SMTP
      try {
        const totalGrossEur = formatEurAmount(
          invoice.total_gross,
          (invoice as any).currency ?? null,
        );

        // Dynamic import to avoid hard dependency
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const nodemailer = require("nodemailer");
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT || "587"),
          secure: false,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        });

        await transporter.sendMail({
          from: process.env.SMTP_FROM || "invoices@greek-quality-food.bg",
          to: recipientEmail,
          subject: `Фактура ${invoice.invoice_number} — Greek Quality Food`,
          text: `Уважаеми ${invoice.partner_name},\n\nПриложена е фактура ${invoice.invoice_number}.\n\nОбща сума: ${totalGrossEur} лв.\n\nС уважение,\nGreek Quality Food ЕООД`,
          attachments: [
            {
              filename: `${invoice.invoice_number}.pdf`,
              path: invoice.pdf_path,
            },
          ],
        });

        await query("UPDATE invoices SET sent_at = NOW() WHERE id = $1", [id]);

        return { message: "Invoice sent", email: recipientEmail };
      } catch (err: any) {
        return reply.status(500).send({
          error: "Failed to send email",
          details: err.message,
        });
      }
    },
  );

  // POST /invoices/credit-note — create credit note for an existing invoice
  app.post(
    "/credit-note",
    { preHandler: invoiceCancelPreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = createCreditNoteSchema.parse(request.body);

      const result = await transaction(async (client) => {
        // Lock the target invoice row first to serialize concurrent
        // credit-note / cancel operations against the same invoice.
        await client.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [
          body.related_invoice_id,
        ]);

        // Load original invoice with items
        const {
          rows: [original],
        } = await client.query(
          `SELECT i.*, p.name AS partner_name
           FROM invoices i
           JOIN partners p ON p.id = i.partner_id
           WHERE i.id = $1 AND i.document_type = 'invoice' AND i.status = 'active'`,
          [body.related_invoice_id],
        );

        if (!original) {
          throw Object.assign(new Error("Original invoice not found"), {
            statusCode: 404,
          });
        }

        // Check if credit note already exists for this invoice
        const { rows: existingCN } = await client.query(
          "SELECT id FROM invoices WHERE related_invoice_id = $1 AND document_type = 'credit_note'",
          [body.related_invoice_id],
        );
        if (existingCN.length > 0) {
          throw Object.assign(
            new Error("Credit note already exists for this invoice"),
            { statusCode: 409 },
          );
        }

        // Determine include_vat: use body override or match original
        const includeVat =
          body.include_vat !== undefined
            ? body.include_vat
            : original.include_vat;

        // Load order_items на свързаната поръчка ПРЕДИ да решим totals.
        // За partial КИ имаме нужда от оригиналните количества и цени, за
        // да validate-нем заявените редове и да изчислим scaled totals.
        // Skip awaiting lines (миграция 072) — те още не са били доставени
        // и не трябва да участват в нито full, нито partial КИ.
        let sourceOrderId: number | null = null;
        let allOrderItems: any[] = [];
        if (original.id) {
          const { rows: orders } = await client.query(
            "SELECT id FROM orders WHERE invoice_id = $1",
            [original.id],
          );
          if (orders.length > 0) {
            sourceOrderId = orders[0].id;
            const { rows: items } = await client.query(
              `SELECT oi.*,
                      oi.name_bg_snapshot AS name_bg,
                      oi.name_en_snapshot AS name_en,
                      oi.sku_snapshot     AS sku,
                      p.unit, p.brand
               FROM order_items oi
               LEFT JOIN products p ON p.id = oi.product_id
               WHERE oi.order_id = $1
                 AND oi.line_status != 'awaiting'
               ORDER BY oi.id`,
              [sourceOrderId],
            );
            allOrderItems = items;
          }
        }

        // Build {selectedItems, totals} according to full vs partial mode.
        // - Full (no body.items): всички order_items с пълно количество;
        //   totals идват от parent invoice-а директно (backward-compat).
        // - Partial (body.items present): validate per-line + изчисли
        //   totals от избраните items × partial quantity × оригинална
        //   unit_price.
        const isPartial = Boolean(body.items && body.items.length > 0);
        type SelectedItem = any & { _partialQty: number };
        let selectedItems: SelectedItem[] = [];
        let totalNet: number;
        let totalVat: number;
        let totalGross: number;

        if (isPartial) {
          if (allOrderItems.length === 0) {
            throw Object.assign(
              new Error(
                "Cannot create partial credit note: invoice has no linked order with items",
              ),
              { statusCode: 400 },
            );
          }
          const byId = new Map<number, any>(
            allOrderItems.map((it) => [it.id, it]),
          );
          for (const req of body.items!) {
            const oi = byId.get(req.order_item_id);
            if (!oi) {
              throw Object.assign(
                new Error(
                  `order_item ${req.order_item_id} is not part of this invoice`,
                ),
                { statusCode: 400 },
              );
            }
            const orig = parseFloat(oi.quantity);
            if (req.quantity > orig + 0.0001) {
              throw Object.assign(
                new Error(
                  `quantity ${req.quantity} exceeds original ${orig} for order_item ${oi.id}`,
                ),
                { statusCode: 400 },
              );
            }
            selectedItems.push({ ...oi, _partialQty: req.quantity });
          }
          // GQF: order_items.unit_price е NET (без ДДС). При partial
          // credit note: sumNet = sum(qty × unit_price), ДДС се добавя
          // отгоре. Mirror на invoice creation logic.
          let sumNetRaw = 0;
          for (const sel of selectedItems) {
            sumNetRaw += sel._partialQty * parseFloat(sel.unit_price);
          }
          sumNetRaw = Math.round(sumNetRaw * 100) / 100;
          const sumVat = includeVat ? Math.round(sumNetRaw * 20) / 100 : 0;
          const sumGross = sumNetRaw + sumVat;
          totalNet = -Math.abs(sumNetRaw);
          totalVat = -Math.abs(Math.round(sumVat * 100) / 100);
          totalGross = -Math.abs(Math.round(sumGross * 100) / 100);
        } else {
          // Full credit note — negate parent invoice totals (backward-compat)
          selectedItems = allOrderItems.map((it) => ({
            ...it,
            _partialQty: parseFloat(it.quantity),
          }));
          totalNet = -Math.abs(parseFloat(original.total_net));
          totalVat = includeVat ? -Math.abs(parseFloat(original.total_vat)) : 0;
          totalGross = totalNet + totalVat;
        }

        // Generate credit note number atomically. Използваме UPSERT, за да
        // работи дори ако wipe / новa миграция остави document_counters
        // без ред 'credit_note' (миграция 004 seed-ва го с ON CONFLICT
        // DO NOTHING, така че при празна таблица seed-ът не се повтаря
        // автоматично).
        const {
          rows: [counter],
        } = await client.query(
          `INSERT INTO document_counters (type, current_val)
           VALUES ('credit_note', 1)
           ON CONFLICT (type) DO UPDATE
             SET current_val = document_counters.current_val + 1
           RETURNING current_val`,
        );
        const cnNumber = `КИ-${String(counter.current_val).padStart(10, "0")}`;

        // Create credit note record
        const {
          rows: [creditNote],
        } = await client.query(
          `INSERT INTO invoices (
            invoice_number, invoice_date, partner_id,
            total_net, total_vat, total_gross,
            include_vat, document_type, related_invoice_id, credit_note_reason
          ) VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, 'credit_note', $7, $8)
          RETURNING *`,
          [
            cnNumber,
            original.partner_id,
            totalNet,
            totalVat,
            totalGross,
            includeVat,
            body.related_invoice_id,
            body.reason,
          ],
        );

        // Load partner for PDF
        const {
          rows: [partner],
        } = await client.query("SELECT * FROM partners WHERE id = $1", [
          original.partner_id,
        ]);

        // Build PDF items от selectedItems — negate quantities + total_price.
        // unit_price остава положителна (КИ-то показва "цена × −количество").
        const pdfItems = selectedItems.map((sel) => {
          const unitPrice = parseFloat(sel.unit_price);
          const partialQty = sel._partialQty;
          return {
            ...sel,
            quantity: -Math.abs(partialQty),
            unit_price: unitPrice,
            total_price: -Math.abs(
              Math.round(partialQty * unitPrice * 100) / 100,
            ),
          };
        });

        // Optionally restore stock to inventory.
        // Full mode → restore цялата поръчка (както досега).
        // Partial mode → restore само избраните количества от селективния
        // helper, който намира батчите по order_item_id.
        if (body.restore_stock) {
          if (isPartial) {
            await restorePartialItemsToInventory(
              client,
              body.items!.map((it) => ({
                order_item_id: it.order_item_id,
                quantity: it.quantity,
              })),
            );
          } else if (sourceOrderId) {
            await restoreOrderItemsToInventory(client, sourceOrderId);
          }
        }

        // Generate PDF
        const company = await getCompanySettings();
        const invoicesDir = path.resolve("uploads", "invoices");
        fs.mkdirSync(invoicesDir, { recursive: true });

        const pdfPath = path.join(invoicesDir, `${cnNumber}.pdf`);
        await generateInvoicePdf({
          invoice: creditNote,
          partner,
          company,
          items: pdfItems,
          vatRate: includeVat ? 20 : 0,
          includeVat,
          documentType: "credit_note",
          relatedInvoiceNumber: original.invoice_number,
          sourceCurrency: (creditNote as any).currency ?? null,
          outputPath: pdfPath,
          showBgn: company.show_bgn_on_invoice === true,
        });

        // Store PDF path
        await client.query("UPDATE invoices SET pdf_path = $1 WHERE id = $2", [
          pdfPath,
          creditNote.id,
        ]);

        return { ...creditNote, pdf_path: pdfPath };
      });

      return reply.status(201).send(result);
    },
  );
}
