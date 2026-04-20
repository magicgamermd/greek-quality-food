// MERT-M Foundation — Task 7: orders route must be batch-free.
//
// The upstream plan describes this test file with a `/auth/login` +
// `build()` bootstrap using a seeded admin user (admin@mertm.bg). No seed
// script for that user exists in this repo, so a real login would fail at
// `beforeAll`. We instead use the project pattern: `vi.mock("../db.js")`
// + auth injected via `onRequest` hook (see `inventory-no-batch.test.ts`
// and `orders-metadata-filters.test.ts`). The assertions from the plan
// (no `batch_id`/`batch_number` on returned order items) remain unchanged.
import Fastify, { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(async () => ({ rows: [] })),
  transaction: vi.fn(),
}));

import { transaction } from "../db.js";
import orderRoutes from "../routes/orders.js";

const mockTransaction = vi.mocked(transaction);

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

describe("orders route (MERT-M, batch-free)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /orders creates an order; order_items have no batch_id/batch_number in response", async () => {
    // Stage the mocked transaction. Each client.query resolves in-order.
    // Partner has no price_list_id, so the price_list_items SELECT is
    // skipped. There is no partner_object_id / object_name / object_code,
    // so resolveOrderObjectSelection() returns early without hitting the DB.
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
      // 2. SELECT id, selling_price, group_price, name_bg FROM products
      .mockResolvedValueOnce(
        rows([{ id: 1, selling_price: "10", name_bg: "Test Product" }]),
      )
      // 3. SELECT COALESCE(SUM(quantity), 0)::numeric AS total FROM inventory
      //    (validateRequestedStock, per-product aggregate — must be >= qty)
      .mockResolvedValueOnce(rows([{ total: "5" }]))
      // 4. INSERT INTO orders ... RETURNING *
      .mockResolvedValueOnce(
        rows([
          {
            id: 101,
            partner_id: 1,
            status: "pending",
            order_number: 101,
          },
        ]),
      )
      // 5. INSERT INTO order_items ... RETURNING *
      //    (the NEW batch-free column list — no batch_id, no batch_number)
      .mockResolvedValueOnce(
        rows([
          {
            id: 1001,
            order_id: 101,
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
      },
    });

    expect(res.statusCode).toBe(201);
    const order = JSON.parse(res.body);
    expect(order.items?.[0]).not.toHaveProperty("batch_id");
    expect(order.items?.[0]).not.toHaveProperty("batch_number");

    // Also guard the INSERT SQL — batch_id column must not be emitted.
    const insertItemsCall = clientQuery.mock.calls.find((call: any[]) =>
      String(call[0]).includes("INSERT INTO order_items"),
    );
    expect(insertItemsCall).toBeDefined();
    expect(String(insertItemsCall![0])).not.toMatch(/\bbatch_id\b/);
    expect(String(insertItemsCall![0])).not.toMatch(/\bcost_source_batch_id\b/);
  });
});
