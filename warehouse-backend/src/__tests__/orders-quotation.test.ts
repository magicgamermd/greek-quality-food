// Batch E — Quotation flow integration tests.
//
// Covers the new transitions added by Batch E:
//   - POST /orders with status='quoted' creates a quoted order
//   - POST /orders/:id/quote (pending → quoted)
//   - POST /orders/:id/unquote (quoted → pending)
//   - POST /orders/:id/fulfill rejects 400 on quoted orders
//   - GET /orders/:id/offer-pdf rejects 400 when status != quoted
//
// Pattern matches the rest of orders-*.test.ts: `vi.mock('../db.js')` +
// auth injected via onRequest. The offer-pdf service is mocked so the
// test never writes to disk.
import Fastify, { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(async () => ({ rows: [] })),
  transaction: vi.fn(),
}));

vi.mock("../services/offer-pdf.js", () => ({
  generateOfferPdf: vi.fn(async () => undefined),
}));

import { query, transaction } from "../db.js";
import orderRoutes from "../routes/orders.js";

const mockTransaction = vi.mocked(transaction);
const mockQuery = vi.mocked(query);

function rows<T>(list: T[]) {
  return { rows: list } as any;
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-admin",
      email: "admin@mertm.bg",
      role: "admin",
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(orderRoutes, { prefix: "/orders" });
  return app;
}

describe("Quotation flow", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockTransaction.mockReset();
    mockQuery.mockReset();
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /orders with status='quoted' inserts an order with status=quoted", async () => {
    const clientQuery = vi
      .fn()
      // 1. SELECT * FROM partners WHERE id = $1
      .mockResolvedValueOnce(
        rows([
          {
            id: 1,
            name: "Test Partner",
            price_group: null,
            price_list_id: null,
          },
        ]),
      )
      // 2. SELECT id, selling_price, name_bg, ... FROM products
      .mockResolvedValueOnce(
        rows([{ id: 1, selling_price: "10", name_bg: "Test Product" }]),
      )
      // 3. validateRequestedStock — SELECT SUM from inventory
      .mockResolvedValueOnce(rows([{ total: "5" }]))
      // 4. INSERT INTO orders ... RETURNING *
      .mockResolvedValueOnce(
        rows([
          {
            id: 200,
            partner_id: 1,
            status: "quoted",
            order_number: 200,
          },
        ]),
      )
      // 5. INSERT INTO order_items ... RETURNING *
      .mockResolvedValueOnce(
        rows([
          {
            id: 2001,
            order_id: 200,
            product_id: 1,
            quantity: "1",
            unit_price: "10",
            discount_percent: "0",
            total_price: "10",
          },
        ]),
      )
      // 6. UPDATE orders SET total_amount
      .mockResolvedValueOnce(rows([]))
      // 7. INSERT INTO notifications
      .mockResolvedValueOnce(rows([]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        partner_id: 1,
        items: [{ product_id: 1, quantity: 1, unit_price: 10 }],
        status: "quoted",
      },
    });

    expect(res.statusCode).toBe(201);

    // Confirm the INSERT SQL passes status as a parameter (last placeholder
    // before nextval) and the value is "quoted".
    const insertOrders = clientQuery.mock.calls.find((c: any[]) =>
      String(c[0]).includes("INSERT INTO orders"),
    );
    expect(insertOrders).toBeDefined();
    const params = insertOrders![1] as any[];
    // status sits in the params array; order_number is generated via
    // nextval() inside the SQL, not passed as a parameter. After
    // migration 077 the trailing slot belongs to is_replacement, so
    // status is the next-to-last param.
    expect(params).toContain("quoted");
    expect(params[params.length - 2]).toBe("quoted");
  });

  it("POST /orders/:id/quote moves pending → quoted", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) =>
      cb({
        query: vi
          .fn()
          .mockResolvedValueOnce(rows([{ id: 1, status: "pending" }]))
          .mockResolvedValueOnce(rows([{ id: 1, status: "quoted" }])),
      }),
    );
    const res = await app.inject({ method: "POST", url: "/orders/1/quote" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: 1, status: "quoted" });
  });

  it("POST /orders/:id/quote rejects 400 when status != pending", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) =>
      cb({
        query: vi
          .fn()
          .mockResolvedValueOnce(rows([{ id: 1, status: "confirmed" }])),
      }),
    );
    const res = await app.inject({ method: "POST", url: "/orders/1/quote" });
    expect(res.statusCode).toBe(400);
  });

  it("POST /orders/:id/unquote moves quoted → pending", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) =>
      cb({
        query: vi
          .fn()
          .mockResolvedValueOnce(rows([{ id: 1, status: "quoted" }]))
          .mockResolvedValueOnce(rows([{ id: 1, status: "pending" }])),
      }),
    );
    const res = await app.inject({ method: "POST", url: "/orders/1/unquote" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: 1, status: "pending" });
  });

  it("POST /orders/:id/unquote rejects 400 when status != quoted", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) =>
      cb({
        query: vi
          .fn()
          .mockResolvedValueOnce(rows([{ id: 1, status: "pending" }])),
      }),
    );
    const res = await app.inject({ method: "POST", url: "/orders/1/unquote" });
    expect(res.statusCode).toBe(400);
  });

  it("POST /orders/:id/fulfill rejects 400 for quoted orders", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) =>
      cb({
        query: vi
          .fn()
          .mockResolvedValueOnce(rows([{ id: 1, status: "quoted" }])),
      }),
    );
    const res = await app.inject({ method: "POST", url: "/orders/1/fulfill" });
    expect(res.statusCode).toBe(400);
  });

  it("GET /orders/:id/offer-pdf rejects 400 only for cancelled orders", async () => {
    // After Batch E follow-up, offers are also generatable for
    // confirmed/processing/fulfilled (informational). Only cancelled
    // orders are rejected.
    mockQuery
      .mockResolvedValueOnce(
        rows([{ id: 1, status: "cancelled", order_number: 42 }]),
      )
      .mockResolvedValueOnce(rows([])); // items
    const res = await app.inject({
      method: "GET",
      url: "/orders/1/offer-pdf",
    });
    expect(res.statusCode).toBe(400);
  });

  // The 200 success path (status==quoted → PDF streamed) requires an
  // actual file on disk because the route uses fs.createReadStream after
  // generateOfferPdf returns. Verifying the streamed bytes belongs in
  // manual E2E (Task 14); here we only assert the rejection paths to
  // keep the test focused on route-level behavior.
});
