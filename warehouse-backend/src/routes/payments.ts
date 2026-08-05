import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "../lib/pagination.js";
import { z } from "zod";
import { query } from "../db.js";
import { requirePermission, PERMISSIONS } from "../lib/permissions.js";

// Fields that may be corrected on an existing payment.
// paid_at is intentionally excluded — NAP cash-book requires the original
// timestamp recorded by the cashier; silently ignore it if sent.
const updatePaymentSchema = z.object({
  amount: z.number().positive().optional(),
  payment_method: z.string().min(1).optional(),
  bank_reference: z.string().nullable().optional(),
});

const createPaymentSchema = z
  .object({
    invoice_id: z.number().int().optional(),
    order_id: z.number().int().optional(),
    amount: z.number().positive(),
    // 'cod' is required for orders shipped via Econt with наложен платеж —
    // the cashier records the payment with method=cod once the courier
    // confirms collection (orders.ts already aggregates SUM(amount) WHERE
    // payment_method='cod' into paid_cod_amount, so it must be writable).
    payment_method: z.enum(["cash", "bank", "pos", "cod"]).default("bank"),
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
      const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(limit) || DEFAULT_PAGE_SIZE),
    );
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
        // GQF: orders.total_amount е НЕТО (без ДДС). Razpiska плащането
        // събира GROSS (нето × 1.2 = 20% ДДС отгоре) — точно както
        // RecordPaymentModal изчислява сумата за касиера. Затова cap-ът
        // е GROSS; иначе плащане с включено ДДС се отхвърля като
        // "Payment exceeds order total" (бъгът от 2026-06-18).
        const orderTotal = parseFloat(order.total_amount) * 1.2;
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

  // PUT /payments/:id — correct a misrecorded payment (amount / method / reference).
  // Re-validates that the new running total does not exceed the parent
  // order or invoice total (excluding the row being edited, refund-aware).
  // Cannot edit paid_at — NAP cash-book requirement; field is silently ignored.
  app.put(
    "/:id",
    { preHandler: paymentsManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const paymentId = Number(id);
      if (!Number.isInteger(paymentId) || paymentId <= 0) {
        return reply.status(400).send({ error: "Invalid payment id" });
      }

      const body = updatePaymentSchema.parse(request.body);
      if (Object.keys(body).length === 0) {
        return reply.status(400).send({ error: "No fields to update" });
      }

      const {
        rows: [existing],
      } = await query("SELECT * FROM payments WHERE id = $1", [paymentId]);
      if (!existing) {
        return reply.status(404).send({ error: "Payment not found" });
      }

      // Overpay re-validation: sum of all OTHER payments on the same
      // order/invoice plus the new amount must not exceed the total.
      // Refund rows are counted as negative (signed SUM).
      const newAmount = body.amount ?? Number(existing.amount);

      if (existing.order_id) {
        const {
          rows: [order],
        } = await query("SELECT * FROM orders WHERE id = $1", [
          existing.order_id,
        ]);
        if (!order) {
          return reply.status(404).send({ error: "Order not found" });
        }
        if (order.status === "cancelled") {
          return reply
            .status(400)
            .send({ error: "Cannot edit payment on cancelled order" });
        }
        const {
          rows: [{ total: paidExcluding }],
        } = await query(
          // Signed SUM excluding the row being edited so refund rows are
          // correctly accounted for before the overpayment check.
          "SELECT COALESCE(SUM(CASE WHEN is_refund THEN -amount ELSE amount END), 0)::numeric AS total FROM payments WHERE order_id = $1 AND id <> $2",
          [existing.order_id, paymentId],
        );
        // GQF orders store total_amount as NET; razpiska payments cover GROSS
        // (нето × 1.2 = 20% ДДС отгоре) — must match the POST cap, else a
        // normally fully-paid (GROSS) order can't have its payment edited.
        // Math.abs guards refund-originated negative replacement-order totals.
        const orderTotal = Math.abs(Number(order.total_amount)) * 1.2;
        if (Number(paidExcluding) + newAmount > orderTotal * 1.001) {
          return reply.status(400).send({
            error: "Updated amount exceeds order total",
            order_total: orderTotal,
            already_paid_excluding_this: Number(paidExcluding),
            attempted: newAmount,
          });
        }
      } else if (existing.invoice_id) {
        const {
          rows: [invoice],
        } = await query("SELECT * FROM invoices WHERE id = $1", [
          existing.invoice_id,
        ]);
        if (!invoice) {
          return reply.status(404).send({ error: "Invoice not found" });
        }
        if (invoice.status === "cancelled") {
          return reply
            .status(400)
            .send({ error: "Cannot edit payment on cancelled invoice" });
        }
        const {
          rows: [{ total: paidExcluding }],
        } = await query(
          "SELECT COALESCE(SUM(CASE WHEN is_refund THEN -amount ELSE amount END), 0)::numeric AS total FROM payments WHERE invoice_id = $1 AND id <> $2",
          [existing.invoice_id, paymentId],
        );
        const invoiceTotal = Number(invoice.total_gross);
        if (Number(paidExcluding) + newAmount > invoiceTotal * 1.001) {
          return reply.status(400).send({
            error: "Updated amount exceeds invoice total",
            invoice_total: invoiceTotal,
            already_paid_excluding_this: Number(paidExcluding),
            attempted: newAmount,
          });
        }
      }

      // Build a dynamic UPDATE that only touches the provided fields.
      const sets: string[] = [];
      const params: any[] = [];
      let p = 1;
      if (body.amount !== undefined) {
        sets.push(`amount = $${p++}`);
        params.push(body.amount);
      }
      if (body.payment_method !== undefined) {
        sets.push(`payment_method = $${p++}`);
        params.push(body.payment_method);
      }
      if (body.bank_reference !== undefined) {
        sets.push(`bank_reference = $${p++}`);
        params.push(body.bank_reference);
      }
      params.push(paymentId);

      const {
        rows: [updated],
      } = await query(
        `UPDATE payments SET ${sets.join(", ")} WHERE id = $${p} RETURNING *`,
        params,
      );

      return reply.send(updated);
    },
  );

  // DELETE /payments/:id — hard-delete an incorrectly recorded payment.
  // paid_amount on orders/invoices is computed at read-time via SUM(payments),
  // so there is no cached value to invalidate.
  // Also removes "twin" order-linked rows created by the 2026-05-26 double-
  // payment bug when the deleted payment belonged to an invoice.
  app.delete(
    "/:id",
    { preHandler: paymentsManagePreHandler },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const paymentId = Number(id);
      if (!Number.isInteger(paymentId) || paymentId <= 0) {
        return reply.status(400).send({ error: "Invalid payment id" });
      }

      const {
        rows: [existing],
      } = await query("SELECT * FROM payments WHERE id = $1", [paymentId]);
      if (!existing) {
        return reply.status(404).send({ error: "Payment not found" });
      }

      await query("DELETE FROM payments WHERE id = $1", [paymentId]);

      // Defense-in-depth against the 2026-05-26 double-payment bug: if the
      // deleted payment was on an invoice, also delete order-linked twin rows
      // that share the same amount / method / is_refund flag and whose order
      // has the same invoice_id. Without this, the cashier deletes the invoice
      // payment but the twin order row keeps the order showing as "paid".
      if (existing.invoice_id) {
        const { rowCount: twinCount, rows: twins } = await query(
          `DELETE FROM payments
            WHERE invoice_id IS NULL
              AND is_refund = $4
              AND payment_method = $1
              AND amount = $2
              AND order_id IN (SELECT id FROM orders WHERE invoice_id = $3)
            RETURNING id`,
          [
            existing.payment_method,
            existing.amount,
            existing.invoice_id,
            existing.is_refund,
          ],
        );
        if (twinCount && twinCount > 0) {
          request.log.info(
            {
              deleted_payment: paymentId,
              twin_ids: twins.map((t: any) => t.id),
            },
            "[payment-delete] also removed twin order_id-linked payments",
          );
        }
      }

      return reply.send({ deleted: true, id: paymentId });
    },
  );
}
