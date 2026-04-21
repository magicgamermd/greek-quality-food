import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query } from "../db.js";

const createPaymentSchema = z.object({
  invoice_id: z.number().int(),
  amount: z.number().positive(),
  payment_method: z.enum(["cash", "bank", "card"]).default("bank"),
  bank_reference: z.string().optional(),
  paid_at: z.string().optional(), // ISO date
  matched_by_agent: z.boolean().default(false),
});

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

export default async function paymentRoutes(app: FastifyInstance) {
  // GET /payments — admin and accountant only
  app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (request.user.role === "warehouse") {
      return reply.status(403).send({ error: "Нямате достъп до плащания" });
    }

    const {
      invoice_id,
      method,
      payment_method,
      date_from,
      date_to,
      q,
      page,
      limit,
    } = request.query as any;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const offset = (pageNum - 1) * pageSize;

    let where = "WHERE 1=1";
    const params: any[] = [];
    let paramIdx = 1;

    if (invoice_id) {
      where += ` AND pay.invoice_id = $${paramIdx++}`;
      params.push(parseInt(invoice_id));
    }
    const effectiveMethod = payment_method || method;
    if (effectiveMethod) {
      where += ` AND pay.payment_method = $${paramIdx++}`;
      params.push(effectiveMethod);
    }
    if (date_from) {
      where += ` AND DATE(pay.paid_at) >= $${paramIdx++}`;
      params.push(date_from);
    }
    if (date_to) {
      where += ` AND DATE(pay.paid_at) <= $${paramIdx++}`;
      params.push(date_to);
    }
    if (q) {
      // Translit-aware on partner name; raw ILIKE for invoice_number / bank_reference
      where += ` AND (
        i.invoice_number ILIKE $${paramIdx}
        OR normalize_search(p.name) ILIKE '%' || normalize_search($${paramIdx + 1}) || '%'
        OR COALESCE(pay.bank_reference, '') ILIKE $${paramIdx}
      )`;
      const trimmed = String(q).trim();
      params.push(`%${trimmed}%`, trimmed);
      paramIdx += 2;
    }

    // `invoice_paid_total` е кумулативно платеното към МОМЕНТА на този ред
    // (не общото върху фактурата сега), за да може историята да отрази дали
    // при това плащане фактурата е била още частично, или вече напълно покрита.
    const sql = `
      WITH pay_cum AS (
        SELECT *,
               SUM(amount) OVER (
                 PARTITION BY invoice_id
                 ORDER BY paid_at ASC, id ASC
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               ) AS cumulative_paid
        FROM payments
      )
      SELECT pay.*, i.invoice_number, i.total_gross AS invoice_total_gross,
             p.name AS partner_name,
             pay.cumulative_paid::numeric AS invoice_paid_total
      FROM pay_cum pay
      JOIN invoices i ON i.id = pay.invoice_id
      JOIN partners p ON p.id = i.partner_id
      ${where}
      ORDER BY pay.paid_at DESC, pay.id DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;
    params.push(pageSize, offset);

    const { rows } = await query(sql, params);
    return { data: rows };
  });

  // POST /payments/auto-match — auto-match payment from email agent
  app.post(
    "/auto-match",
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAuth(request, reply);
      if (request.user.role === "warehouse") {
        return reply.status(403).send({ error: "Нямате достъп до плащания" });
      }

      const autoMatchSchema = z.object({
        amount: z.number().positive(),
        reference: z.string().optional(),
        payer: z.string().optional(),
        date: z.string().optional(),
        raw_subject: z.string().optional(),
      });

      const body = autoMatchSchema.parse(request.body);

      // Try to match by reference (invoice number)
      let matchedInvoice = null;

      if (body.reference) {
        // Try exact match on invoice_number
        const { rows } = await query(
          `SELECT i.*, p.name AS partner_name
         FROM invoices i
         JOIN partners p ON p.id = i.partner_id
         WHERE i.invoice_number ILIKE $1
           AND i.document_type = 'invoice'
           AND i.status = 'active'`,
          [`%${body.reference}%`],
        );
        if (rows.length === 1) {
          matchedInvoice = rows[0];
        }
      }

      // If no match by reference, try by payer name + amount
      if (!matchedInvoice && body.payer) {
        const { rows } = await query(
          `SELECT i.*, p.name AS partner_name
         FROM invoices i
         JOIN partners p ON p.id = i.partner_id
         LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) pay
           ON pay.invoice_id = i.id
         WHERE p.name ILIKE $1
           AND i.document_type = 'invoice'
           AND i.status = 'active'
           AND i.total_gross - COALESCE(pay.paid, 0) > 0
         ORDER BY ABS(i.total_gross - COALESCE(pay.paid, 0) - $2) ASC
         LIMIT 1`,
          [`%${body.payer}%`, body.amount],
        );
        if (rows.length === 1) {
          matchedInvoice = rows[0];
        }
      }

      // If no match found by payer, try by amount alone (unpaid invoices)
      if (!matchedInvoice) {
        const { rows } = await query(
          `SELECT i.*, p.name AS partner_name
         FROM invoices i
         JOIN partners p ON p.id = i.partner_id
         LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) pay
           ON pay.invoice_id = i.id
         WHERE i.document_type = 'invoice'
           AND i.status = 'active'
           AND ABS(i.total_gross - COALESCE(pay.paid, 0) - $1) < 0.02
         LIMIT 1`,
          [body.amount],
        );
        if (rows.length === 1) {
          matchedInvoice = rows[0];
        }
      }

      if (!matchedInvoice) {
        return reply.status(404).send({
          error: "No matching unpaid invoice found",
          amount: body.amount,
          reference: body.reference,
          payer: body.payer,
        });
      }

      // Check remaining balance
      const {
        rows: [{ total }],
      } = await query(
        "SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM payments WHERE invoice_id = $1",
        [matchedInvoice.id],
      );
      const alreadyPaid = parseFloat(total);
      const invoiceTotal = parseFloat(matchedInvoice.total_gross);
      const paymentAmount = Math.min(body.amount, invoiceTotal - alreadyPaid);

      if (paymentAmount <= 0) {
        return reply.status(400).send({
          error: "Invoice already fully paid",
          invoice_number: matchedInvoice.invoice_number,
        });
      }

      // Record the payment — always use current timestamp for paid_at
      const {
        rows: [payment],
      } = await query(
        `INSERT INTO payments (invoice_id, amount, payment_method, bank_reference, paid_at, matched_by_agent)
       VALUES ($1, $2, 'bank', $3, NOW(), true)
       RETURNING *`,
        [matchedInvoice.id, paymentAmount, body.reference || null],
      );

      const newTotal = alreadyPaid + paymentAmount;
      const status =
        newTotal >= invoiceTotal ? "fully paid" : "partial payment";

      await query(
        `INSERT INTO notifications (type, message) VALUES ('payment', $1)`,
        [
          `Auto-matched payment of ${paymentAmount} € for invoice ${matchedInvoice.invoice_number} from ${body.payer || "unknown"} (${status})`,
        ],
      );

      return reply.status(201).send({
        ...payment,
        matched_invoice: matchedInvoice.invoice_number,
        partner_name: matchedInvoice.partner_name,
        invoice_total: invoiceTotal,
        total_paid: newTotal,
        remaining: invoiceTotal - newTotal,
        match_status: status,
      });
    },
  );

  // POST /payments — record a payment
  app.post("/", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (request.user.role === "warehouse") {
      return reply.status(403).send({ error: "Insufficient permissions" });
    }

    const body = createPaymentSchema.parse(request.body);

    // Verify invoice exists
    const {
      rows: [invoice],
    } = await query("SELECT * FROM invoices WHERE id = $1", [body.invoice_id]);
    if (!invoice) {
      return reply.status(404).send({ error: "Invoice not found" });
    }
    if (invoice.document_type !== "invoice") {
      return reply
        .status(400)
        .send({ error: "Payments can be recorded only for invoices" });
    }
    if (invoice.status === "cancelled") {
      return reply
        .status(400)
        .send({ error: "Cannot record payment for cancelled invoice" });
    }

    // Check how much is already paid
    const {
      rows: [{ total }],
    } = await query(
      "SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM payments WHERE invoice_id = $1",
      [body.invoice_id],
    );

    const alreadyPaid = parseFloat(total);
    const invoiceTotal = parseFloat(invoice.total_gross);

    if (alreadyPaid + body.amount > invoiceTotal * 1.001) {
      return reply.status(400).send({
        error: "Payment exceeds invoice total",
        invoice_total: invoiceTotal,
        already_paid: alreadyPaid,
        attempted: body.amount,
      });
    }

    const { rows } = await query(
      `INSERT INTO payments (invoice_id, amount, payment_method, bank_reference, paid_at, matched_by_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        body.invoice_id,
        body.amount,
        body.payment_method,
        body.bank_reference,
        body.paid_at || new Date().toISOString(),
        body.matched_by_agent,
      ],
    );

    // Create notification
    const newTotal = alreadyPaid + body.amount;
    const status = newTotal >= invoiceTotal ? "fully paid" : "partial payment";
    await query(
      `INSERT INTO notifications (type, message)
       VALUES ('payment', $1)`,
      [
        `Payment of ${body.amount} € received for invoice ${invoice.invoice_number} (${status})`,
      ],
    );

    return reply.status(201).send({
      ...rows[0],
      invoice_total: invoiceTotal,
      total_paid: newTotal,
      remaining: invoiceTotal - newTotal,
    });
  });
}
