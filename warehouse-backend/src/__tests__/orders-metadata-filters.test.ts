import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import orderRoutes from "../routes/orders.js";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query } from "../db.js";

const mockQuery = vi.mocked(query);

function resultRows<T>(rows: T[]) {
  return { rows } as any;
}

async function buildApp(options?: { coerceInvoicedToBoolean?: boolean }) {
  const app = Fastify();

  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-admin",
      email: "admin@test.local",
      role: "admin",
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });

  if (options?.coerceInvoicedToBoolean) {
    app.addHook("preHandler", async (request) => {
      const query = (request as any).query;
      if (!query || typeof query !== "object") return;

      if (query.invoiced === "true") query.invoiced = true;
      if (query.invoiced === "false") query.invoiced = false;
    });
  }

  await app.register(orderRoutes, { prefix: "/orders" });
  return app;
}

describe("orders metadata filters", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("applies invoiced/date/document/request/object filters in GET /orders", async () => {
    // Main SELECT + count query (always run for pagination).
    mockQuery.mockResolvedValueOnce(resultRows([]));
    mockQuery.mockResolvedValueOnce(resultRows([{ total: "0" }]));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url:
          "/orders?status=invoiced&partner_id=7&invoiced=false" +
          "&date_from=2026-04-01&date_to=2026-04-08" +
          "&invoice_number=INV-123&stock_dispatch_number=SR-0000007" +
          "&commercial_document_number=TD-0000007" +
          "&request_number=REQ-7&object_query=Store-22&q=Bakalia",
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        data: [],
        pagination: { page: 1, limit: 50, total: 0 },
      });
      expect(mockQuery).toHaveBeenCalledTimes(2);

      const [sql, params] = mockQuery.mock.calls[0] as [string, any[]];

      expect(sql).toContain("LEFT JOIN invoices inv");
      expect(sql).toContain("LEFT JOIN partner_order_objects po");
      expect(sql).toContain("o.invoice_id IS NULL");
      expect(sql).toContain("inv.invoice_number ILIKE");
      expect(sql).toContain("o.request_number ILIKE");
      expect(sql).toContain("commercial_document_number");
      // Free-text `q` now uses transliteration-aware partner match.
      expect(sql).toContain("normalize_search(p.name) ILIKE");

      expect(params.slice(0, 10)).toEqual([
        "invoiced",
        7,
        "2026-04-01",
        "2026-04-08",
        "%INV-123%",
        "%SR-0000007%",
        "%TD-0000007%",
        "%REQ-7%",
        "%Store-22%",
        "%Bakalia%",
      ]);
      expect(params.at(-2)).toBe(50);
      expect(params.at(-1)).toBe(0);
    } finally {
      await app.close();
    }
  });

  it.each([
    ["true", "AND o.invoice_id IS NOT NULL", "AND o.invoice_id IS NULL"],
    ["false", "AND o.invoice_id IS NULL", "AND o.invoice_id IS NOT NULL"],
  ])(
    "applies invoiced filter when query parser coerces to boolean (%s)",
    async (invoiced, expectedWhereClause, unexpectedWhereClause) => {
      // Main SELECT + count query (always run for pagination).
      mockQuery.mockResolvedValueOnce(resultRows([]));
      mockQuery.mockResolvedValueOnce(resultRows([{ total: "0" }]));

      const app = await buildApp({ coerceInvoicedToBoolean: true });
      try {
        const res = await app.inject({
          method: "GET",
          url: `/orders?invoiced=${invoiced}`,
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          data: [],
          pagination: { page: 1, limit: 50, total: 0 },
        });
        expect(mockQuery).toHaveBeenCalledTimes(2);

        const [sql, params] = mockQuery.mock.calls[0] as [string, any[]];
        expect(sql).toContain(expectedWhereClause);
        expect(sql).not.toContain(unexpectedWhereClause);
        expect(params.at(-2)).toBe(50);
        expect(params.at(-1)).toBe(0);
      } finally {
        await app.close();
      }
    },
  );
});
