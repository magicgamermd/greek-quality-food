// Integration tests for the new invoice fields:
//   - vat_exemption_reason  (printed in 'Основание за сделката')
//   - invoice_note          (printed as 'Забележка' below totals)
//
// Strategy: rather than walk the entire create-invoice happy path
// through 8+ chained mock queries (brittle), we let the handler
// proceed until it hits the SQL we care about, capture the SQL +
// params, then throw a sentinel error to short-circuit. The route's
// transaction wrapper bubbles the error up; we assert the captured
// SQL inside the test.
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setex: vi.fn(async () => "OK"),
    del: vi.fn(async () => 0),
  })),
}));
vi.mock("../services/invoice-pdf.js", () => ({
  generateInvoicePdf: vi.fn(async () => undefined),
}));

import { query, transaction } from "../db.js";
import invoicesRoutes from "../routes/invoices.js";

const mockQuery = vi.mocked(query);
const mockTx = vi.mocked(transaction);

function rows<T>(list: T[], rowCount?: number) {
  return { rows: list, rowCount: rowCount ?? list.length } as any;
}

async function buildApp(role = "admin") {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u-admin", email: "admin@test", role };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(invoicesRoutes, { prefix: "/invoices" });
  return app;
}

describe("invoices extra fields — write path", () => {
  let app: any;

  beforeEach(() => {
    mockQuery.mockReset();
    mockTx.mockReset();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("POST /invoices INSERT carries vat_exemption_reason + invoice_note as bind params", async () => {
    let capturedInsert: { sql: string; params: any[] } | null = null;

    mockTx.mockImplementationOnce(async (cb: any) => {
      const clientQuery = async (sql: string, params: any[] = []) => {
        if (/^INSERT INTO invoices/.test(sql)) {
          capturedInsert = { sql, params };
          // Sentinel: stop here. The handler's transaction() will
          // re-throw and Fastify will return 500; that's expected.
          throw new Error("__CAPTURED__");
        }
        if (/^SELECT \* FROM orders WHERE id = \$1/.test(sql)) {
          return rows([
            {
              id: 1,
              partner_id: 7,
              status: "fulfilled",
              invoice_id: null,
              total_amount: "100",
              order_number: 42,
            },
          ]);
        }
        if (/FROM partners WHERE id = \$1/.test(sql)) {
          return rows([
            {
              id: 7,
              name: "Партньор",
              eik: "1",
              vat_number: null,
              partner_type: "company",
              address: "addr",
            },
          ]);
        }
        if (/FROM order_items oi/.test(sql)) {
          return rows([
            {
              id: 1001,
              order_id: 1,
              product_id: 10,
              name_bg: "Продукт",
              name_en: "Product",
              sku: "P-1",
              unit: "бр.",
              quantity: "1",
              unit_price: "100",
              discount_percent: "0",
              total_price: "100",
            },
          ]);
        }
        // Sequence / max-number lookup
        if (
          /nextval|invoice_number_seq|MAX|generate_invoice_number/i.test(sql)
        ) {
          return rows([
            {
              next_number: "0000000001",
              max: "0",
              generate_invoice_number: "0000000001",
            },
          ]);
        }
        // Settings (getCompanySettings reads through client.query when
        // called inside the transaction)
        if (/FROM settings/i.test(sql)) {
          return rows([
            {
              company_name: "MERT-M",
              eik: "1",
              vat_number: "BG1",
              address: "addr",
              email: "e@m",
            },
          ]);
        }
        // products SELECT (if any happens here)
        if (/FROM products/i.test(sql)) {
          return rows([{ id: 10, name_bg: "P", purchase_price: "50" }]);
        }
        return rows([]);
      };
      try {
        return await cb({ query: clientQuery });
      } catch (e: any) {
        if (e?.message === "__CAPTURED__") return undefined;
        throw e;
      }
    });

    // getCompanySettings sometimes uses top-level query()
    mockQuery.mockResolvedValue(
      rows([
        {
          company_name: "MERT-M",
          eik: "1",
          vat_number: "BG1",
          address: "addr",
        },
      ]),
    );

    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/invoices",
      payload: {
        order_id: 1,
        include_vat: false,
        payment_method: "bank",
        vat_exemption_reason: "EU reverse charge / обратно начисляване",
        invoice_note: "по проект Алфа",
      },
    });

    // The capture-and-throw pattern returns undefined from
    // transaction(); the handler reads `result.invoice` which is now
    // undefined → 500. We don't care about the response, only the
    // captured SQL.
    void res;

    expect(capturedInsert).not.toBeNull();
    const cap = capturedInsert as unknown as {
      sql: string;
      params: any[];
    };
    expect(cap.sql).toMatch(/vat_exemption_reason/);
    expect(cap.sql).toMatch(/invoice_note/);
    expect(cap.params).toContain("EU reverse charge / обратно начисляване");
    expect(cap.params).toContain("по проект Алфа");
  });
});

describe("invoices extra fields — regenerate path", () => {
  let app: any;

  beforeEach(() => {
    mockQuery.mockReset();
    mockTx.mockReset();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("PUT /invoices/:id/regenerate UPDATE statement uses COALESCE for both new fields", async () => {
    let capturedUpdate: { sql: string; params: any[] } | null = null;

    mockTx.mockImplementationOnce(async (cb: any) => {
      const clientQuery = async (sql: string, params: any[] = []) => {
        if (/^UPDATE invoices\s+SET total_net/.test(sql)) {
          capturedUpdate = { sql, params };
          throw new Error("__CAPTURED__");
        }
        if (/SELECT.*FROM invoices/i.test(sql)) {
          return rows([
            {
              id: 555,
              invoice_number: "0000000001",
              partner_id: 7,
              status: "active",
              document_type: "invoice",
              include_vat: true,
              vat_exemption_reason: "OLD reason",
              invoice_note: "OLD note",
              payment_method: "bank",
            },
          ]);
        }
        if (/FROM orders/.test(sql)) {
          return rows([
            {
              id: 1,
              order_number: 1,
              partner_id: 7,
              total_amount: "100",
              invoice_id: 555,
            },
          ]);
        }
        if (/FROM partners WHERE id = \$1/.test(sql)) {
          return rows([
            {
              id: 7,
              name: "P",
              eik: "1",
              partner_type: "company",
              address: "addr",
              vat_number: null,
            },
          ]);
        }
        if (/FROM order_items oi/.test(sql)) {
          return rows([
            {
              id: 1001,
              order_id: 1,
              product_id: 10,
              name_bg: "Продукт",
              name_en: "Product",
              sku: "P-1",
              unit: "бр.",
              quantity: "1",
              unit_price: "100",
              total_price: "100",
              discount_percent: "0",
            },
          ]);
        }
        // Sum of payments for the invoice (regenerate flow checks this)
        if (/SUM\(amount\).*FROM payments/i.test(sql)) {
          return rows([{ total: "0" }]);
        }
        return rows([]);
      };
      try {
        return await cb({ query: clientQuery });
      } catch (e: any) {
        if (e?.message === "__CAPTURED__") return undefined;
        throw e;
      }
    });

    app = await buildApp();
    // Send NO override fields — regenerate must preserve existing values
    // via COALESCE in the SQL.
    const res = await app.inject({
      method: "PUT",
      url: "/invoices/555/regenerate",
      payload: {},
    });
    void res;

    expect(capturedUpdate).not.toBeNull();
    const cap = capturedUpdate as unknown as {
      sql: string;
      params: any[];
    };
    expect(cap.sql).toMatch(
      /vat_exemption_reason\s*=\s*COALESCE\(\$\d+, vat_exemption_reason\)/,
    );
    expect(cap.sql).toMatch(
      /invoice_note\s*=\s*COALESCE\(\$\d+, invoice_note\)/,
    );
    // Bind values for the two new COALESCE inputs must be null when the
    // body omits them — so the SQL falls back to the stored value.
    // Position: after [totalNet, totalVat, totalGross, payment_method].
    // We don't hardcode the index; just verify both null bind values
    // appear in params.
    expect(cap.params.filter((p) => p === null).length).toBeGreaterThanOrEqual(
      3,
    );
  });
});
