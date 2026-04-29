import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../db.js", () => ({ query: vi.fn(), transaction: vi.fn() }));
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
const mockTransaction = vi.mocked(transaction);

const rows = <T>(r: T[]) => ({ rows: r }) as any;

// buildApp mirrors production's setErrorHandler (statusCode || 500) and adds
// a ZodError → 400 fallback so schema-level rejections surface as user errors
// in tests. Production-side this is a known gap; the assertion here documents
// the intended user-facing behaviour.
async function buildApp(role = "admin") {
  const app = Fastify();
  app.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: error.errors[0]?.message ?? "Validation error",
      });
    }
    const statusCode = error.statusCode || 500;
    return reply
      .status(statusCode)
      .send({ error: error.message || "Internal error" });
  });
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u1", email: "x@y", role };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(invoicesRoutes, { prefix: "/invoices" });
  return app;
}

// Helpers ────────────────────────────────────────────────────────────────────

function makeOrderRow(partnerId = 11) {
  return {
    id: 1,
    partner_id: partnerId,
    invoice_id: null,
    status: "confirmed",
  };
}

function makeIndividualPartner(id = 11) {
  return { id, partner_type: "individual", name: "Физическо лице" };
}

function makeCompanyPartner(id = 22, eik = "200000001") {
  return {
    id,
    partner_type: "company",
    name: "Тестова Фирма ООД",
    eik,
  };
}

const SETTINGS_ROW = {
  company_name: "MERT-M EOOD",
  address: "София",
  eik: "123",
  vat_number: "BG123",
  iban: "BG00",
  phone: "0888",
  email: "x@y",
};

/**
 * Builds a transaction mock + assertion harness for the POST /invoices flow.
 * The caller supplies (partner_type, eikLookupRow) — everything else returns
 * canned data. Records every SQL/params pair on `txQueries` for inspection.
 */
function buildTxMock(opts: {
  partner: { id: number; partner_type: string };
  /** What `SELECT id FROM partners WHERE eik = $1` returns (undefined → empty). */
  eikLookup?: { id: number };
  /** id assigned when INSERT INTO partners runs. */
  newPartnerId?: number;
  /** invoice id returned by the INSERT. */
  invoiceId?: number;
}) {
  const txQueries: Array<{ sql: string; params?: any[] }> = [];
  const txClient = {
    query: vi.fn(async (sql: string, params?: any[]) => {
      txQueries.push({ sql: String(sql), params });
      const s = String(sql);

      if (s.includes("FROM orders WHERE id")) {
        return rows([makeOrderRow(opts.partner.id)]);
      }
      if (s.includes("FROM order_items oi")) {
        return rows([
          {
            id: 1,
            product_id: 1,
            quantity: 1,
            unit_price: "100",
            total_price: "100",
            name_bg: "Артикул",
            name_en: "Item",
            sku: "X1",
            unit: "бр",
          },
        ]);
      }
      // partner lookup — returns the order's partner first, then on re-fetch
      // returns the new (override) partner. We disambiguate by looking at
      // what id the route last used: the first FROM partners WHERE id IS the
      // order partner; subsequent ones are the override re-fetch.
      if (s.includes("FROM partners WHERE id")) {
        const callIdx = txQueries.filter((q) =>
          q.sql.includes("FROM partners WHERE id"),
        ).length;
        if (callIdx === 1) return rows([opts.partner]);
        // Re-fetch for PDF generation — return whatever id was passed.
        return rows([{ id: params?.[0], partner_type: "company" }]);
      }
      if (s.includes("FROM partners WHERE eik")) {
        return opts.eikLookup ? rows([opts.eikLookup]) : rows([]);
      }
      if (s.includes("INSERT INTO partners")) {
        return rows([{ id: opts.newPartnerId ?? 999 }]);
      }
      if (s.includes("generate_invoice_number")) {
        return rows([{ generate_invoice_number: "MM-2026-0001" }]);
      }
      if (s.includes("INSERT INTO invoices")) {
        return rows([
          {
            id: opts.invoiceId ?? 5001,
            invoice_number: "MM-2026-0001",
            partner_id: params?.[1],
            client_display_name: params?.[6],
          },
        ]);
      }
      if (s.includes("UPDATE orders SET invoice_id")) return rows([]);
      if (s.includes("UPDATE invoices SET pdf_path")) return rows([]);
      return rows([]);
    }),
  };
  mockTransaction.mockImplementation(async (cb: any) => cb(txClient as any));
  return { txQueries, txClient };
}

// Tests ──────────────────────────────────────────────────────────────────────

describe("POST /invoices partner_override", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
    // getCompanySettings call (SELECT * FROM settings WHERE id = 1)
    mockQuery.mockResolvedValue(rows([SETTINGS_ROW]));
  });

  it("uses override partner_id directly when provided", async () => {
    const { txQueries } = buildTxMock({
      partner: makeIndividualPartner(),
    });

    const app = await buildApp("admin");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/invoices",
        payload: {
          order_id: 1,
          payment_method: "bank",
          partner_override: { partner_id: 99 },
        },
      });
      expect(res.statusCode).toBe(201);

      const invoiceInsert = txQueries.find((q) =>
        q.sql.includes("INSERT INTO invoices"),
      );
      expect(invoiceInsert).toBeDefined();
      // partner_id is the 2nd $-param in the INSERT
      expect(invoiceInsert?.params?.[1]).toBe(99);

      // No INSERT INTO partners — the existing partner_id was used as-is.
      const partnerInsert = txQueries.find((q) =>
        q.sql.includes("INSERT INTO partners"),
      );
      expect(partnerInsert).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("reuses partner with matching EIK (no new INSERT)", async () => {
    const { txQueries } = buildTxMock({
      partner: makeIndividualPartner(),
      eikLookup: { id: 77 }, // existing match
    });

    const app = await buildApp("admin");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/invoices",
        payload: {
          order_id: 1,
          payment_method: "bank",
          partner_override: {
            name: "Същата Фирма ООД",
            eik: "204711222",
          },
        },
      });
      expect(res.statusCode).toBe(201);

      const partnerInsert = txQueries.find((q) =>
        q.sql.includes("INSERT INTO partners"),
      );
      expect(partnerInsert).toBeUndefined();

      const invoiceInsert = txQueries.find((q) =>
        q.sql.includes("INSERT INTO invoices"),
      );
      expect(invoiceInsert?.params?.[1]).toBe(77);
    } finally {
      await app.close();
    }
  });

  it("inserts new partner with partner_type='company' when EIK is unknown", async () => {
    const { txQueries } = buildTxMock({
      partner: makeIndividualPartner(),
      eikLookup: undefined, // empty SELECT
      newPartnerId: 555,
    });

    const app = await buildApp("admin");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/invoices",
        payload: {
          order_id: 1,
          payment_method: "bank",
          partner_override: {
            name: "Нова Фирма ЕООД",
            eik: "204711333",
            vat_number: "BG204711333",
            address: "ул. Тест 1",
            city: "София",
            contact_person: "Иван",
            phone: "0888",
          },
        },
      });
      expect(res.statusCode).toBe(201);

      const partnerInsert = txQueries.find((q) =>
        q.sql.includes("INSERT INTO partners"),
      );
      expect(partnerInsert).toBeDefined();
      // partner_type='company' is hard-coded in the SQL string
      expect(partnerInsert?.sql).toMatch(/'company'/);
      expect(partnerInsert?.params).toEqual([
        "Нова Фирма ЕООД",
        "204711333",
        "BG204711333",
        "ул. Тест 1",
        "София",
        "Иван",
        "0888",
      ]);

      const invoiceInsert = txQueries.find((q) =>
        q.sql.includes("INSERT INTO invoices"),
      );
      // The freshly minted partner id (555) flows into the invoice.
      expect(invoiceInsert?.params?.[1]).toBe(555);
    } finally {
      await app.close();
    }
  });

  it("rejects 400 when order partner is not individual", async () => {
    buildTxMock({
      partner: makeCompanyPartner(11, "111111111"),
    });

    const app = await buildApp("admin");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/invoices",
        payload: {
          order_id: 1,
          payment_method: "bank",
          partner_override: { partner_id: 99 },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/individual/i);
    } finally {
      await app.close();
    }
  });

  it("forces client_display_name to NULL when override is active", async () => {
    const { txQueries } = buildTxMock({
      partner: makeIndividualPartner(),
    });

    const app = await buildApp("admin");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/invoices",
        payload: {
          order_id: 1,
          payment_method: "bank",
          client_display_name: "Иван Петров",
          partner_override: { partner_id: 99 },
        },
      });
      expect(res.statusCode).toBe(201);

      const invoiceInsert = txQueries.find((q) =>
        q.sql.includes("INSERT INTO invoices"),
      );
      // client_display_name is the 7th $-param (index 6)
      expect(invoiceInsert?.params?.[6]).toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe("PUT /invoices/:id/regenerate", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("rejects 400 when partner_override is supplied", async () => {
    const app = await buildApp("admin");
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/invoices/1/regenerate",
        payload: { partner_override: { partner_id: 99 } },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
