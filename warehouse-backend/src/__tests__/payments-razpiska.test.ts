import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import paymentRoutes from "../routes/payments.js";

vi.mock("../db.js", () => ({ query: vi.fn() }));
import { query } from "../db.js";

const mockQuery = vi.mocked(query);
const rows = <T>(r: T[]) => ({ rows: r }) as any;

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

describe("razpiska payments", () => {
  beforeEach(() => mockQuery.mockReset());

  it("POST /payments with order_id inserts razpiska payment", async () => {
    mockQuery
      .mockResolvedValueOnce(
        rows([
          {
            id: 42,
            order_number: 100,
            invoice_id: null,
            status: "confirmed",
            total_amount: "500.00",
          },
        ]),
      )
      .mockResolvedValueOnce(rows([{ total: "0" }]))
      .mockResolvedValueOnce(
        rows([
          { id: 1, order_id: 42, amount: "200.00", payment_method: "bank" },
        ]),
      )
      .mockResolvedValueOnce(rows([]));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/payments",
        payload: { order_id: 42, amount: 200, payment_method: "bank" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        order_id: 42,
        order_total: 500,
        total_paid: 200,
        remaining: 300,
      });
    } finally {
      await app.close();
    }
  });

  it("POST /payments rejects order_id when order has invoice_id", async () => {
    mockQuery.mockResolvedValueOnce(
      rows([
        { id: 42, invoice_id: 7, status: "confirmed", total_amount: "500" },
      ]),
    );
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/payments",
        payload: { order_id: 42, amount: 100 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/invoice_id instead/);
    } finally {
      await app.close();
    }
  });

  it("POST /payments rejects cancelled order", async () => {
    mockQuery.mockResolvedValueOnce(
      rows([
        {
          id: 42,
          invoice_id: null,
          status: "cancelled",
          total_amount: "500",
        },
      ]),
    );
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/payments",
        payload: { order_id: 42, amount: 100 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/cancelled/i);
    } finally {
      await app.close();
    }
  });

  it("POST /payments rejects exceeding order total", async () => {
    mockQuery
      .mockResolvedValueOnce(
        rows([
          {
            id: 42,
            order_number: 100,
            invoice_id: null,
            status: "confirmed",
            total_amount: "500.00",
          },
        ]),
      )
      .mockResolvedValueOnce(rows([{ total: "400.00" }]));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/payments",
        payload: { order_id: 42, amount: 150 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        order_total: 500,
        already_paid: 400,
      });
    } finally {
      await app.close();
    }
  });

  it("GET /payments?type=razpiska uses orders JOIN and order partition", async () => {
    mockQuery.mockResolvedValueOnce(rows([]));
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/payments?type=razpiska",
      });
      expect(res.statusCode).toBe(200);
      const [sql] = mockQuery.mock.calls[0] as [string, any[]];
      expect(sql).toContain("JOIN orders o");
      expect(sql).toContain("JOIN partners p ON p.id = o.partner_id");
      expect(sql).toContain("PARTITION BY order_id");
      expect(sql).toContain("pay.order_id IS NOT NULL");
      expect(sql).toContain("pay.invoice_id IS NULL");
    } finally {
      await app.close();
    }
  });

  it("GET /payments (default) filters to invoice_id IS NOT NULL", async () => {
    mockQuery.mockResolvedValueOnce(rows([]));
    const app = await buildApp();
    try {
      await app.inject({ method: "GET", url: "/payments" });
      const [sql] = mockQuery.mock.calls[0] as [string, any[]];
      expect(sql).toContain("JOIN invoices i");
      expect(sql).toContain("pay.invoice_id IS NOT NULL");
    } finally {
      await app.close();
    }
  });
});
