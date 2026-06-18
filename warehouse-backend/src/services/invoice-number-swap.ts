// Atomic swap of invoice_number values between 2 or 3 existing invoices.
//
// The invoices.invoice_number column has a UNIQUE constraint. We cannot
// directly set A=B then B=A in two UPDATEs because the first UPDATE
// collides with B's existing value. Workaround: three-step UPDATE inside
// a single transaction, using temp placeholder values that cannot collide
// with real invoice numbers.
//
// Validation rejects: missing numbers, proforma, cancelled invoices,
// invoices with credit notes against them, and duplicate inputs.

import { transaction } from "../db.js";

export type SwapInvoiceNumbersError =
  | { kind: "DUPLICATE_INPUT"; numbers: string[] }
  | { kind: "MISSING_NUMBERS"; numbers: string[] }
  | { kind: "PROFORMA"; numbers: string[] }
  | { kind: "CANCELLED"; numbers: string[] }
  | { kind: "HAS_CREDIT_NOTE"; numbers: string[] };

export class SwapInvoiceNumbersValidationError extends Error {
  constructor(public readonly detail: SwapInvoiceNumbersError) {
    super(JSON.stringify(detail));
    this.name = "SwapInvoiceNumbersValidationError";
  }
}

export interface SwapResult {
  swapped: Array<{
    id: number;
    old_number: string;
    new_number: string;
    order_id: number | null;
    partner_name: string | null;
  }>;
  cycle_length: number;
}

interface InvoiceRow {
  id: number;
  invoice_number: string;
  document_type: string;
  status: string;
  order_id: number | null;
  partner_name: string | null;
}

/**
 * Atomically rotate invoice_number values among the given numbers.
 *
 *   2 inputs → A↔B straight swap.
 *   3 inputs → cycle A→B→C→A: index 0 receives index 1's number,
 *              index 1 receives index 2's, index 2 receives index 0's.
 *
 * Throws SwapInvoiceNumbersValidationError on any validation failure;
 * the transaction is rolled back.
 */
export async function swapInvoiceNumbers(
  numbers: string[],
): Promise<SwapResult> {
  // Precondition: numbers.length is between 2 and 3.
  // Enforced by the Zod schema at the route layer (POST /invoices/swap-numbers).
  // N=1 would silently produce a no-op rotation; do not bypass that guard.

  // 1) Duplicate-input check (cheap, fail before tx)
  const uniq = new Set(numbers);
  if (uniq.size !== numbers.length) {
    throw new SwapInvoiceNumbersValidationError({
      kind: "DUPLICATE_INPUT",
      numbers,
    });
  }

  return await transaction(async (client) => {
    // 2) Load the invoices to be swapped. Join orders + partners to
    //    surface order_id and partner_name for the success payload.
    const { rows: invoices } = await client.query(
      `SELECT
         i.id, i.invoice_number, i.document_type, i.status,
         o.id AS order_id, p.name AS partner_name
       FROM invoices i
       LEFT JOIN orders   o ON o.invoice_id = i.id
       LEFT JOIN partners p ON p.id = i.partner_id
       WHERE i.invoice_number = ANY($1::text[])`,
      [numbers],
    );

    // 3) Validate: all numbers found
    if (invoices.length !== numbers.length) {
      const found = new Set(invoices.map((r: InvoiceRow) => r.invoice_number));
      throw new SwapInvoiceNumbersValidationError({
        kind: "MISSING_NUMBERS",
        numbers: numbers.filter((n) => !found.has(n)),
      });
    }

    // 4) Validate: no proforma
    const proforma = invoices
      .filter((r: InvoiceRow) => r.document_type === "proforma")
      .map((r: InvoiceRow) => r.invoice_number);
    if (proforma.length > 0) {
      throw new SwapInvoiceNumbersValidationError({
        kind: "PROFORMA",
        numbers: proforma,
      });
    }

    // 5) Validate: no cancelled
    const cancelled = invoices
      .filter((r: InvoiceRow) => r.status === "cancelled")
      .map((r: InvoiceRow) => r.invoice_number);
    if (cancelled.length > 0) {
      throw new SwapInvoiceNumbersValidationError({
        kind: "CANCELLED",
        numbers: cancelled,
      });
    }

    // 6) Validate: no invoice has a credit note against it
    const ids = invoices.map((r: InvoiceRow) => r.id);
    const { rows: cns } = await client.query<{ related_invoice_id: number }>(
      `SELECT related_invoice_id
       FROM invoices
       WHERE document_type = 'credit_note'
         AND related_invoice_id = ANY($1::int[])`,
      [ids],
    );
    if (cns.length > 0) {
      const blockedIds = new Set(cns.map((r) => r.related_invoice_id));
      const blockedNumbers = invoices
        .filter((r: InvoiceRow) => blockedIds.has(r.id))
        .map((r: InvoiceRow) => r.invoice_number);
      throw new SwapInvoiceNumbersValidationError({
        kind: "HAS_CREDIT_NOTE",
        numbers: blockedNumbers,
      });
    }

    // 7) Build the rotation map.
    //    For input [A, B]:    A.id → B.invoice_number, B.id → A.invoice_number
    //    For input [A, B, C]: A.id → B.invoice_number, B.id → C.invoice_number,
    //                         C.id → A.invoice_number
    //
    //    Re-sort invoices to match the input order (PostgreSQL doesn't
    //    guarantee order for WHERE x = ANY(...)).
    const byNumber = new Map<string, InvoiceRow>(
      invoices.map((r: InvoiceRow) => [r.invoice_number, r]),
    );
    const ordered = numbers.map((n) => byNumber.get(n)!);

    const targets: Array<{ id: number; oldNumber: string; newNumber: string }> =
      [];
    for (let i = 0; i < ordered.length; i++) {
      const src = ordered[i];
      const dst = ordered[(i + 1) % ordered.length];
      targets.push({
        id: src.id,
        oldNumber: src.invoice_number,
        newNumber: dst.invoice_number,
      });
    }

    // 8) Step A: move every participant to a temporary placeholder
    //    value that cannot collide with any real invoice_number.
    //    invoices.invoice_number is VARCHAR(100); the placeholder below is
    //    short and uses a sentinel prefix, so it never collides with a real
    //    10-digit number and always fits the column.
    for (const t of targets) {
      await client.query(
        `UPDATE invoices SET invoice_number = $1 WHERE id = $2`,
        [`__SWAP_TMP__${t.id}`, t.id],
      );
    }

    // 9) Step B: set each to its target number.
    for (const t of targets) {
      await client.query(
        `UPDATE invoices SET invoice_number = $1 WHERE id = $2`,
        [t.newNumber, t.id],
      );
    }

    // 9b) Invalidate cached PDFs. The on-disk PDF files were named by the
    //     OLD number and pdf_path still points at them, so a print after the
    //     swap would serve the pre-swap file (wrong number). Clearing
    //     pdf_path forces lazy regeneration from current data on next print.
    //     The route also deletes the stale on-disk files (named by number).
    await client.query(
      `UPDATE invoices SET pdf_path = NULL WHERE id = ANY($1::int[])`,
      [ids],
    );

    // 10) Build response in the order matching `targets` (which mirrors
    //     `numbers` input order, so callers see a predictable shape).
    return {
      cycle_length: numbers.length,
      swapped: targets.map((t) => {
        const inv = ordered.find((r) => r.id === t.id)!;
        return {
          id: t.id,
          old_number: t.oldNumber,
          new_number: t.newNumber,
          order_id: inv.order_id ?? null,
          partner_name: inv.partner_name ?? null,
        };
      }),
    };
  });
}
