import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query, transaction } from "../db.js";
import { generateInvoicePdf } from "../services/invoice-pdf.js";
import { restoreOrderItemsToInventory } from "../utils/order-stock.js";
import { formatEurAmount } from "../utils/currency.js";
import fs from "node:fs";
import path from "node:path";

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

const createInvoiceSchema = z.object({
  order_id: z.number().int(),
  vat_rate: z.number().default(20), // Bulgarian VAT 20%
  include_vat: z.boolean().default(true),
  // Optional — only meaningful when the order's partner is an individual.
  // If set, this name is printed on the invoice PDF instead of the partner's
  // generic name. Trim + normalise empty string → null so the DB stays clean.
  client_display_name: z
    .string()
    .trim()
    .max(255)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

const createCreditNoteSchema = z.object({
  related_invoice_id: z.number().int(),
  reason: z.string().trim().min(1).max(500),
  include_vat: z.boolean().optional(),
  // Return goods to inventory? Typically true for full reversal (returned goods),
  // false for discount/price-correction credit notes.
  restore_stock: z.boolean().optional(),
});

const sendEmailSchema = z.object({
  email: z.string().email().optional(), // Override partner email
});

const cancelInvoiceSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

function canAccessInvoices(role: string) {
  return role === "admin" || role === "accountant";
}

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
  };
}

export default async function invoiceRoutes(app: FastifyInstance) {
  // GET /invoices — admin and accountant only
  app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (!canAccessInvoices(request.user.role)) {
      return reply.status(403).send({ error: "Нямате достъп до фактури" });
    }

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
  });

  // GET /invoices/:id — single invoice
  app.get("/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (!canAccessInvoices(request.user.role)) {
      return reply.status(403).send({ error: "Нямате достъп до фактури" });
    }

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
  });

  // GET /invoices/unpaid
  app.get("/unpaid", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (!canAccessInvoices(request.user.role)) {
      return reply.status(403).send({ error: "Нямате достъп до фактури" });
    }

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
  });

  // POST /invoices — generate invoice for an order
  app.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (request.user.role === "accountant") {
      return reply.status(403).send({ error: "Insufficient permissions" });
    }

    const body = createInvoiceSchema.parse(request.body);

    const result = await transaction(async (client) => {
      // Get order with items
      const {
        rows: [order],
      } = await client.query("SELECT * FROM orders WHERE id = $1", [
        body.order_id,
      ]);

      if (!order) {
        throw Object.assign(new Error("Order not found"), { statusCode: 404 });
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

      const { rows: items } = await client.query(
        `SELECT oi.*, p.name_bg, p.name_en, p.sku, p.unit, p.brand
         FROM order_items oi
         JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = $1
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
      const clientDisplayName =
        partner?.partner_type === "individual"
          ? (body.client_display_name ?? null)
          : null;

      // Calculate totals
      const totalNet = items.reduce(
        (sum: number, i: any) => sum + parseFloat(i.total_price),
        0,
      );
      const effectiveVatRate = body.include_vat ? body.vat_rate : 0;
      const totalVat = body.include_vat ? totalNet * (body.vat_rate / 100) : 0;
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
            client_display_name)
         VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          invoiceNumber,
          order.partner_id,
          totalNet,
          totalVat,
          totalGross,
          body.include_vat,
          clientDisplayName,
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

      const pdfPath = path.join(invoicesDir, `${invoiceNumber}.pdf`);
      await generateInvoicePdf({
        invoice,
        partner,
        company,
        items,
        vatRate: effectiveVatRate,
        includeVat: body.include_vat,
        sourceCurrency: (invoice as any).currency ?? null,
        outputPath: pdfPath,
      });

      // Store PDF path
      await client.query("UPDATE invoices SET pdf_path = $1 WHERE id = $2", [
        pdfPath,
        invoice.id,
      ]);

      return { ...invoice, pdf_path: pdfPath };
    });

    return reply.status(201).send(result);
  });

  // PUT /invoices/:id/regenerate — recalculate invoice from current order items
  app.put(
    "/:id/regenerate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      if (request.user.role === "accountant") {
        return reply.status(403).send({ error: "Insufficient permissions" });
      }

      const { id } = request.params as { id: string };

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

        // Get current order items
        const { rows: items } = await client.query(
          `SELECT oi.*, p.name_bg, p.name_en, p.sku, p.unit, p.brand
           FROM order_items oi
           JOIN products p ON p.id = oi.product_id
           WHERE oi.order_id = $1
           ORDER BY oi.id`,
          [order.id],
        );

        const {
          rows: [partner],
        } = await client.query("SELECT * FROM partners WHERE id = $1", [
          order.partner_id,
        ]);

        // Recalculate totals
        const totalNet = items.reduce(
          (sum: number, i: any) => sum + parseFloat(i.total_price),
          0,
        );
        const includeVat = invoice.include_vat !== false;
        const vatRate = includeVat ? 20 : 0;
        const totalVat = includeVat ? totalNet * 0.2 : 0;
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

        // Update invoice record
        const {
          rows: [updated],
        } = await client.query(
          `UPDATE invoices SET total_net = $1, total_vat = $2, total_gross = $3
           WHERE id = $4 RETURNING *`,
          [totalNet, totalVat, totalGross, id],
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

  // POST /invoices/:id/cancel — annul issued invoice while preserving consumed number
  app.post(
    "/:id/cancel",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      if (!canAccessInvoices(request.user.role)) {
        return reply.status(403).send({ error: "Нямате достъп до фактури" });
      }

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
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      if (!canAccessInvoices(request.user.role)) {
        return reply.status(403).send({ error: "Нямате достъп до фактури" });
      }

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
  app.get("/:id/pdf", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (!canAccessInvoices(request.user.role)) {
      return reply.status(403).send({ error: "Нямате достъп до фактури" });
    }
    const { id } = request.params as { id: string };

    const {
      rows: [invoice],
    } = await query("SELECT * FROM invoices WHERE id = $1", [id]);

    if (!invoice) {
      return reply.status(404).send({ error: "Invoice not found" });
    }

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
        const { rows: rawItems } = await query(
          `SELECT oi.*, p.name_bg, p.name_en, p.sku, p.unit, p.brand
           FROM order_items oi
           JOIN products p ON p.id = oi.product_id
           WHERE oi.order_id = $1
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
          } = await query("SELECT invoice_number FROM invoices WHERE id = $1", [
            invoice.related_invoice_id,
          ]);
          relatedInvoiceNumber = parent?.invoice_number ?? null;
        }

        const company = await getCompanySettings();
        const invoicesDir = path.resolve("uploads", "invoices");
        fs.mkdirSync(invoicesDir, { recursive: true });
        const pdfPath = path.join(invoicesDir, `${invoice.invoice_number}.pdf`);
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
  });

  // POST /invoices/:id/send-email
  app.post(
    "/:id/send-email",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      if (request.user.role === "accountant") {
        return reply.status(403).send({ error: "Insufficient permissions" });
      }

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
          from: process.env.SMTP_FROM || "invoices@greekfoods.bg",
          to: recipientEmail,
          subject: `Invoice ${invoice.invoice_number} — Greek Foods`,
          text: `Уважаеми ${invoice.partner_name},\n\nПриложена е фактура ${invoice.invoice_number}.\n\nОбща сума: ${totalGrossEur} €.\n\nС уважение,\nBakalia Greek Deli Food`,
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
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      if (request.user.role !== "admin" && request.user.role !== "accountant") {
        return reply.status(403).send({ error: "Нямате достъп" });
      }

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

        // Generate credit note number atomically
        const {
          rows: [counter],
        } = await client.query(
          `UPDATE document_counters SET current_val = current_val + 1
           WHERE type = 'credit_note' RETURNING current_val`,
        );
        const cnNumber = `КИ-${String(counter.current_val).padStart(10, "0")}`;

        // Negate amounts from original invoice
        const totalNet = -Math.abs(parseFloat(original.total_net));
        const totalVat = includeVat
          ? -Math.abs(parseFloat(original.total_vat))
          : 0;
        const totalGross = totalNet + totalVat;

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

        // Load original order items for the PDF line items
        let pdfItems: any[] = [];
        let sourceOrderId: number | null = null;
        if (original.id) {
          // Find the order linked to this invoice
          const { rows: orders } = await client.query(
            "SELECT id FROM orders WHERE invoice_id = $1",
            [original.id],
          );
          if (orders.length > 0) {
            sourceOrderId = orders[0].id;
            const { rows: items } = await client.query(
              `SELECT oi.*, p.name_bg, p.name_en, p.sku, p.unit, p.brand
               FROM order_items oi
               JOIN products p ON p.id = oi.product_id
               WHERE oi.order_id = $1
               ORDER BY oi.id`,
              [orders[0].id],
            );
            // Negate quantities and amounts for credit note
            pdfItems = items.map((item: any) => ({
              ...item,
              quantity: -Math.abs(parseFloat(item.quantity)),
              unit_price: parseFloat(item.unit_price),
              total_price: -Math.abs(parseFloat(item.total_price)),
            }));
          }
        }

        // Optionally restore stock to inventory (full reversal of goods)
        if (body.restore_stock && sourceOrderId) {
          await restoreOrderItemsToInventory(client, sourceOrderId);
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
