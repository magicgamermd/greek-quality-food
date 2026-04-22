import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import paymentRoutes from "../routes/payments.js";

vi.mock("../db.js", () => ({
  query: vi.fn(),
}));

import { query } from "../db.js";

const mockQuery = vi.mocked(query);

function resultRows<T>(rows: T[]) {
  return { rows } as any;
}

async function buildApp() {
  const app = Fastify();

  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-admin",
      email: "admin@test.local",
      role: "admin",
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });

  await app.register(paymentRoutes, { prefix: "/payments" });
  return app;
}

describe("payments route filters", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("applies method, date, and search filters", async () => {
    mockQuery.mockResolvedValueOnce(resultRows([]));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url:
          "/payments?payment_method=bank&date_from=2026-04-01&date_to=2026-04-30" +
          "&q=INV-123&limit=100",
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [] });
      expect(mockQuery).toHaveBeenCalledTimes(1);

      const [sql, params] = mockQuery.mock.calls[0] as [string, any[]];
      expect(sql).toContain("pay.payment_method = $1");
      expect(sql).toContain("DATE(pay.paid_at) >= $2");
      expect(sql).toContain("DATE(pay.paid_at) <= $3");
      expect(sql).toContain("i.invoice_number ILIKE $4");
      expect(sql).toContain("COALESCE(pay.bank_reference, '') ILIKE $4");
      expect(sql).toContain("pay.invoice_id IS NOT NULL");
      expect(params).toEqual([
        "bank",
        "2026-04-01",
        "2026-04-30",
        "%INV-123%",
        // Second q-bound param feeds normalize_search(p.name) via $5
        "INV-123",
        100,
        0,
      ]);
    } finally {
      await app.close();
    }
  });

  it("accepts limit up to 500 without clipping to 100", async () => {
    mockQuery.mockResolvedValueOnce(resultRows([]));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/payments?limit=500&type=invoice",
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.data)).toBe(true);

      const [, params] = mockQuery.mock.calls[0] as [string, any[]];
      // LIMIT is the second-to-last param, OFFSET is last. limit=500 must
      // reach the query unclipped (previously capped to 100).
      expect(params[params.length - 2]).toBe(500);
      expect(params[params.length - 1]).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("returns invoice_status for invoice payments", async () => {
    mockQuery.mockResolvedValueOnce(
      resultRows([
        {
          id: 1,
          invoice_id: 10,
          invoice_number: "INV-1",
          invoice_status: "active",
          partner_name: "Acme",
        },
      ]),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/payments?type=invoice&limit=10",
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data[0]).toHaveProperty("invoice_status");
      expect(["active", "cancelled"]).toContain(body.data[0].invoice_status);

      const [sql] = mockQuery.mock.calls[0] as [string, any[]];
      expect(sql).toContain("i.status AS invoice_status");
    } finally {
      await app.close();
    }
  });

  it("returns order_status for razpiska payments", async () => {
    mockQuery.mockResolvedValueOnce(
      resultRows([
        {
          id: 1,
          order_id: 20,
          order_number: 100,
          order_status: "confirmed",
          partner_name: "Acme",
        },
      ]),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/payments?type=razpiska&limit=10",
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data[0]).toHaveProperty("order_status");

      const [sql] = mockQuery.mock.calls[0] as [string, any[]];
      expect(sql).toContain("o.status AS order_status");
    } finally {
      await app.close();
    }
  });
});
