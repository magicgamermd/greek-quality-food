import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { query } from "../db.js";
import { requirePermission, PERMISSIONS } from "../lib/permissions.js";

const createPaymentSchema = z
  .object({
    invoice_id: z.number().int().optional(),
    order_id: z.number().int().optional(),
    amount: z.number().positive(),
    payment_method: z.enum(["cash", "bank", "card"]).default("bank"),
    bank_reference: z.string().optional(),
    paid_at: z.string().optional(), // ISO date
    matched_by_agent: z.boolean().default(false),
  })
  .refine((d) => !!d.invoice_id !== !!d.order_id, {
    message: "Must provide exactly one of invoice_id or order_id",
  });

async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  await request.jwtVerify();
}

const jwtVerify = async (request: FastifyRequest) => {
  await request.jwtVerify();
};

const paymentsManagePreHandler = [
  jwtVerify,
  requirePermission(PERMISSIONS.PAYMENTS_MANAGE),
];

export default async function paymentRoutes(app: FastifyInstance) {
  // GET /payments — admin and accountant only
  app.get(
    "/",
    { preHandler: paymentsManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const {
        invoice_id,
        order_id,
        method,
        payment_method,
        date_from,
        date_to,
        q,
        page,
        limit,
        type: rawType,
      } = request.query as any;
      const type = rawType === "razpiska" ? "razpiska" : "invoice";
      const pageNum = Math.max(1, parseInt(page) || 1);
      const pageSize = Math.min(500, Math.max(1, parseInt(limit) || 50));
      const offset = (pageNum - 1) * pageSize;

      let where = "WHERE 1=1";
      const params: any[] = [];
      let paramIdx = 1;

      if (invoice_id) {
        where += ` AND pay.invoice_id = $${paramIdx++}`;
        params.push(parseInt(invoice_id));
      }
      if (order_id) {
        where += ` AND pay.order_id = $${paramIdx++}`;
        params.push(parseInt(order_id));
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
        const trimmed = String(q).trim();
        if (type === "razpiska") {
          // Razpiska search: order_number + partner name (translit) + bank_reference
          where += ` AND (
          o.order_number::text ILIKE $${paramIdx}
          OR normalize_search(p.name) ILIKE '%' || normalize_search($${paramIdx + 1}) || '%'
          OR COALESCE(pay.bank_reference, '') ILIKE $${paramIdx}
        )`;
        } else {
          // Invoice search: invoice_number + partner name (translit) + bank_reference
          where += ` AND (
          i.invoice_number ILIKE $${paramIdx}
          OR normalize_search(p.name) ILIKE '%' || normalize_search($${paramIdx + 1}) || '%'
          OR COALESCE(pay.bank_reference, '') ILIKE $${paramIdx}
        )`;
        }
        params.push(`%${trimmed}%`, trimmed);
        paramIdx += 2;
      }

      if (type === "razpiska") {
        where += ` AND pay.invoice_id IS NULL AND pay.order_id IS NOT NULL`;
        const sql = `
        WITH pay_cum AS (
          SELECT *,
                 SUM(amount) OVER (
                   PARTITION BY order_id
                   ORDER BY paid_at ASC, id ASC
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                 ) AS cumulative_paid
          FROM payments
          WHERE order_id IS NOT NULL AND invoice_id IS NULL
        )
        SELECT pay.*, o.order_number, o.total_amount AS order_total,
               o.status AS order_status,
               p.name AS partner_name,
               pay.cumulative_paid::numeric AS order_paid_total
        FROM pay_cum pay
        JOIN orders o ON o.id = pay.order_id
        JOIN partners p ON p.id = o.partner_id
        ${where}
        ORDER BY pay.paid_at DESC, pay.id DESC
        LIMIT $${paramIdx++} OFFSET $${paramIdx++}
      `;
        params.push(pageSize, offset);
        const { rows } = await query(sql, params);
        return { data: rows };
      }

      where += ` AND pay.invoice_id IS NOT NULL`;

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
        WHERE invoice_id IS NOT NULL
      )
      SELECT pay.*, i.invoice_number, i.total_gross AS invoice_total_gross,
             i.status AS invoice_status,
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
    },
  );

  // POST /payments/auto-match — auto-match payment from email agent
  app.post(
    "/auto-match",
    { preHandler: paymentsManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
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
  app.post(
    "/",
    { preHandler: paymentsManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = createPaymentSchema.parse(request.body);

      // Razpiska branch — payment tied to an order without invoice
      if (body.order_id) {
        const {
          rows: [order],
        } = await query("SELECT * FROM orders WHERE id = $1", [body.order_id]);
        if (!order) return reply.status(404).send({ error: "Order not found" });
        if (order.status === "cancelled") {
          return reply
            .status(400)
            .send({ error: "Cannot record payment for cancelled order" });
        }
        if (order.invoice_id) {
          return reply.status(400).send({
            error: "Order has invoice — use invoice_id instead of order_id",
          });
        }

        const {
          rows: [{ total: orderPaidTotal }],
        } = await query(
          "SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM payments WHERE order_id = $1",
          [body.order_id],
        );
        const alreadyPaidOrder = parseFloat(orderPaidTotal);
        // Razpiska (no-invoice) payment cap is the order's stored
        // total_amount as-is — there's no VAT line to collect for a
        // shipment receipt, only the agreed price.
        const orderTotal = parseFloat(order.total_amount);
        if (alreadyPaidOrder + body.amount > orderTotal * 1.001) {
          return reply.status(400).send({
            error: "Payment exceeds order total",
            order_total: orderTotal,
            already_paid: alreadyPaidOrder,
            attempted: body.amount,
          });
        }

        const {
          rows: [payment],
        } = await query(
          `INSERT INTO payments (order_id, amount, payment_method, bank_reference, paid_at, matched_by_agent)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
          [
            body.order_id,
            body.amount,
            body.payment_method,
            body.bank_reference,
            body.paid_at || new Date().toISOString(),
            body.matched_by_agent,
          ],
        );

        const newOrderTotal = alreadyPaidOrder + body.amount;
        const status =
          newOrderTotal >= orderTotal ? "fully paid" : "partial payment";
        await query(
          `INSERT INTO notifications (type, message) VALUES ('payment_razpiska', $1)`,
          [
            `Плащане по СР ${body.amount} лв за поръчка #${order.order_number ?? order.id} (${status})`,
          ],
        );

        return reply.status(201).send({
          ...payment,
          order_total: orderTotal,
          total_paid: newOrderTotal,
          remaining: orderTotal - newOrderTotal,
        });
      }

      // Verify invoice exists
      const {
        rows: [invoice],
      } = await query("SELECT * FROM invoices WHERE id = $1", [
        body.invoice_id,
      ]);
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
      const status =
        newTotal >= invoiceTotal ? "fully paid" : "partial payment";
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
    },
  );
}
