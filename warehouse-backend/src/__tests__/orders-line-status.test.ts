// Batch F1 — line_status flow integration tests.
//
// Covers the new logic added by Batch F1:
//   - POST /orders/:id/fulfill — branches on order_items.line_status:
//     * 'awaiting'        → skip entirely (no stock change, no COGS)
//     * 'paid_not_taken'  → deduct with allowNegative=true
//     * 'normal'          → deduct with allowNegative=false (pre-check)
//   - POST /orders/:id/items/:itemId/handover (paid_not_taken → normal)
//   - POST /orders/:id/items/:itemId/confirm-from-awaiting
//     (awaiting → normal + deduct stock now, refuses 409 on insufficient)
//   - GET /orders ?has_paid_not_taken=true / ?has_awaiting=true filter params
//     wire EXISTS clauses into the WHERE.
//
// Pattern matches orders-quotation.test.ts: vi.mock('../db.js') + auth
// injected via onRequest hook.
import Fastify, { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(async () => ({ rows: [] })),
  transaction: vi.fn(),
}));

import { query, transaction } from "../db.js";
import orderRoutes from "../routes/orders.js";

const mockTransaction = vi.mocked(transaction);
const mockQuery = vi.mocked(query);

function rows<T>(list: T[]) {
  return { rows: list, rowCount: list.length } as any;
}

async function buildApp(): Promise<FastifyInstance> {
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

describe("Batch F1 — line_status flows in /fulfill", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockTransaction.mockReset();
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] } as any);
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("skips awaiting lines entirely (no inventory UPDATE issued)", async () => {
    // Two items: one normal, one awaiting. Only the normal line should hit
    // the deductProductStock path.
    const clientQuery = vi
      .fn()
      // 1. SELECT * FROM orders WHERE id = $1 FOR UPDATE
      .mockResolvedValueOnce(
        rows([
          { id: 50, status: "pending", partner_id: 1, total_amount: "30" },
        ]),
      )
      // 2. SELECT * FROM order_items WHERE order_id = $1
      .mockResolvedValueOnce(
        rows([
          {
            id: 601,
            order_id: 50,
            product_id: 7,
            quantity: "2",
            unit_price: "10",
            line_status: "normal",
          },
          {
            id: 602,
            order_id: 50,
            product_id: 8,
            quantity: "5",
            unit_price: "20",
            line_status: "awaiting",
          },
        ]),
      )
      // 3. deductProductStock pre-check (normal, allowNegative=false)
      .mockResolvedValueOnce(rows([{ qty: "10" }]))
      // 4. UPDATE inventory ... RETURNING quantity
      .mockResolvedValueOnce(rows([{ quantity: "8" }]))
      // 5. SELECT purchase_price FROM products
      .mockResolvedValueOnce(rows([{ purchase_price: "5" }]))
      // 6. UPDATE order_items SET cost_unit_price (only for normal line)
      .mockResolvedValueOnce(rows([]))
      // 7. UPDATE orders SET status='fulfilled'
      .mockResolvedValueOnce(rows([]))
      // 8. INSERT INTO notifications
      .mockResolvedValueOnce(rows([]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/orders/50/fulfill",
    });
    expect(res.statusCode).toBe(200);

    // Only ONE UPDATE inventory should have fired (for the normal line).
    const inventoryUpdates = clientQuery.mock.calls.filter((c: any[]) =>
      String(c[0]).includes("UPDATE inventory"),
    );
    expect(inventoryUpdates).toHaveLength(1);

    // The single deduct should target product 7 (the normal line), not 8.
    expect(inventoryUpdates[0]![1]).toEqual([2, 7]);

    // No UPDATE order_items SET cost_unit_price for product 8.
    const costSnapshots = clientQuery.mock.calls.filter((c: any[]) =>
      String(c[0]).includes("SET cost_unit_price"),
    );
    expect(costSnapshots).toHaveLength(1);
    expect(costSnapshots[0]![1]).toEqual([5, 601]);
  });

  it("on a paid_not_taken line, allows inventory to go negative (no pre-check SELECT)", async () => {
    // Inventory currently 0; a paid_not_taken line for qty=3 should still
    // deduct (allowNegative=true), so the helper does NOT issue the
    // pre-check SELECT — it goes straight to the UPDATE.
    const clientQuery = vi
      .fn()
      // 1. SELECT * FROM orders WHERE id = $1 FOR UPDATE
      .mockResolvedValueOnce(
        rows([
          { id: 51, status: "pending", partner_id: 1, total_amount: "30" },
        ]),
      )
      // 2. SELECT * FROM order_items WHERE order_id = $1
      .mockResolvedValueOnce(
        rows([
          {
            id: 701,
            order_id: 51,
            product_id: 9,
            quantity: "3",
            unit_price: "10",
            line_status: "paid_not_taken",
          },
        ]),
      )
      // 3. UPDATE inventory ... RETURNING quantity → -3
      .mockResolvedValueOnce(rows([{ quantity: "-3" }]))
      // 4. SELECT purchase_price FROM products
      .mockResolvedValueOnce(rows([{ purchase_price: "5" }]))
      // 5. UPDATE order_items SET cost_unit_price
      .mockResolvedValueOnce(rows([]))
      // 6. UPDATE orders SET status='fulfilled'
      .mockResolvedValueOnce(rows([]))
      // 7. INSERT INTO notifications
      .mockResolvedValueOnce(rows([]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/orders/51/fulfill",
    });
    expect(res.statusCode).toBe(200);

    // No pre-check SELECT against inventory — allowNegative=true skips it.
    const preCheckSelects = clientQuery.mock.calls.filter(
      (c: any[]) =>
        String(c[0]).includes("COALESCE(SUM(quantity)") &&
        String(c[0]).includes("FROM inventory"),
    );
    expect(preCheckSelects).toHaveLength(0);

    // The UPDATE inventory must still fire (deducts the stock).
    const inventoryUpdates = clientQuery.mock.calls.filter((c: any[]) =>
      String(c[0]).includes("UPDATE inventory"),
    );
    expect(inventoryUpdates).toHaveLength(1);
    expect(inventoryUpdates[0]![1]).toEqual([3, 9]);
  });
});

describe("Batch F1 — POST /orders/:id/items/:itemId/handover", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockTransaction.mockReset();
    mockQuery.mockReset();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("flips paid_not_taken → normal without re-deducting stock", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        rows([{ id: 1, order_id: 10, line_status: "paid_not_taken" }]),
      )
      .mockResolvedValueOnce(
        rows([{ id: 1, order_id: 10, line_status: "normal" }]),
      );
    mockTransaction.mockImplementationOnce(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/orders/10/items/1/handover",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      id: 1,
      line_status: "normal",
    });

    // No inventory side-effects: no UPDATE inventory / INSERT inventory /
    // SELECT purchase_price calls.
    const inventoryHits = clientQuery.mock.calls.filter((c: any[]) =>
      /inventory|purchase_price/i.test(String(c[0])),
    );
    expect(inventoryHits).toHaveLength(0);
  });

  it("rejects 400 on a non-paid_not_taken line", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        rows([{ id: 1, order_id: 10, line_status: "normal" }]),
      );
    mockTransaction.mockImplementationOnce(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/orders/10/items/1/handover",
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when the item does not belong to the given order", async () => {
    const clientQuery = vi.fn().mockResolvedValueOnce(rows([]));
    mockTransaction.mockImplementationOnce(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/orders/10/items/999/handover",
    });
    expect(res.statusCode).toBe(404);
  });

  it("flips pending_pickup → normal (warehouse confirmation, миграция 079)", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        rows([{ id: 1, order_id: 10, line_status: "pending_pickup" }]),
      )
      .mockResolvedValueOnce(
        rows([{ id: 1, order_id: 10, line_status: "normal" }]),
      );
    mockTransaction.mockImplementationOnce(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/orders/10/items/1/handover",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      id: 1,
      line_status: "normal",
    });
  });
});

// New 2-step pickup flow added by миграция 079.
describe("POST /orders/:id/items/:itemId/send-to-warehouse (миграция 079)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockTransaction.mockReset();
    mockQuery.mockReset();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("flips paid_not_taken → pending_pickup and emits notification", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        rows([{ id: 1, order_id: 10, line_status: "paid_not_taken" }]),
      )
      .mockResolvedValueOnce(
        rows([{ id: 1, order_id: 10, line_status: "pending_pickup" }]),
      )
      .mockResolvedValueOnce(rows([])); // notification insert
    mockTransaction.mockImplementationOnce(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/orders/10/items/1/send-to-warehouse",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      id: 1,
      line_status: "pending_pickup",
    });
    // Notification insert трябва да присъства
    const notif = clientQuery.mock.calls.find((c: any[]) =>
      /INSERT INTO notifications/i.test(String(c[0])),
    );
    expect(notif).toBeDefined();
  });

  it("rejects 400 if the line is already pending_pickup or normal", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        rows([{ id: 1, order_id: 10, line_status: "pending_pickup" }]),
      );
    mockTransaction.mockImplementationOnce(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/orders/10/items/1/send-to-warehouse",
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when the item does not belong to the given order", async () => {
    const clientQuery = vi.fn().mockResolvedValueOnce(rows([]));
    mockTransaction.mockImplementationOnce(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/orders/10/items/999/send-to-warehouse",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Batch F1 — POST /orders/:id/items/:itemId/confirm-from-awaiting", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockTransaction.mockReset();
    mockQuery.mockReset();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("flips awaiting → normal AND deducts stock (allowNegative=false)", async () => {
    const clientQuery = vi
      .fn()
      // 1. SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE
      .mockResolvedValueOnce(
        rows([
          {
            id: 1,
            order_id: 10,
            product_id: 7,
            quantity: "2",
            line_status: "awaiting",
          },
        ]),
      )
      // 2. deductProductStock pre-check (allowNegative=false)
      .mockResolvedValueOnce(rows([{ qty: "5" }]))
      // 3. UPDATE inventory ... RETURNING quantity
      .mockResolvedValueOnce(rows([{ quantity: "3" }]))
      // 4. SELECT purchase_price FROM products
      .mockResolvedValueOnce(rows([{ purchase_price: "4" }]))
      // 5. UPDATE order_items SET line_status='normal', cost_unit_price=$1
      .mockResolvedValueOnce(
        rows([
          { id: 1, order_id: 10, line_status: "normal", cost_unit_price: "4" },
        ]),
      );
    mockTransaction.mockImplementationOnce(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/orders/10/items/1/confirm-from-awaiting",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      line_status: "normal",
    });

    // Pre-check SELECT did fire (allowNegative=false).
    const preCheck = clientQuery.mock.calls.find((c: any[]) =>
      String(c[0]).includes("COALESCE(SUM(quantity)"),
    );
    expect(preCheck).toBeDefined();

    // UPDATE inventory was called with quantity=2, product=7.
    const update = clientQuery.mock.calls.find((c: any[]) =>
      String(c[0]).includes("UPDATE inventory"),
    );
    expect(update).toBeDefined();
    expect(update![1]).toEqual([2, 7]);
  });

  it("refuses 409 when stock is insufficient", async () => {
    const clientQuery = vi
      .fn()
      // 1. SELECT * FROM order_items
      .mockResolvedValueOnce(
        rows([
          {
            id: 1,
            order_id: 10,
            product_id: 7,
            quantity: "5",
            line_status: "awaiting",
          },
        ]),
      )
      // 2. pre-check returns 1 → 1 < 5 ⇒ throws 409
      .mockResolvedValueOnce(rows([{ qty: "1" }]));
    mockTransaction.mockImplementationOnce(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/orders/10/items/1/confirm-from-awaiting",
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects 400 on a non-awaiting line", async () => {
    const clientQuery = vi.fn().mockResolvedValueOnce(
      rows([
        {
          id: 1,
          order_id: 10,
          product_id: 7,
          quantity: "1",
          line_status: "paid_not_taken",
        },
      ]),
    );
    mockTransaction.mockImplementationOnce(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/orders/10/items/1/confirm-from-awaiting",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("Batch F1 — GET /orders filter pills", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockTransaction.mockReset();
    mockQuery.mockReset();
    // Default: every query returns []. Tests below override per-call.
    mockQuery.mockResolvedValue({ rows: [] } as any);
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("?has_paid_not_taken=true adds an EXISTS clause for paid_not_taken", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/orders?has_paid_not_taken=true",
    });
    expect(res.statusCode).toBe(200);

    const sqls = mockQuery.mock.calls.map((c: any[]) => String(c[0]));
    const matched = sqls.filter((s) =>
      /EXISTS[\s\S]+oi\.line_status\s*=\s*'paid_not_taken'/i.test(s),
    );
    expect(matched.length).toBeGreaterThan(0);
  });

  it("?has_awaiting=true adds an EXISTS clause for awaiting", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/orders?has_awaiting=true",
    });
    expect(res.statusCode).toBe(200);

    const sqls = mockQuery.mock.calls.map((c: any[]) => String(c[0]));
    const matched = sqls.filter((s) =>
      /EXISTS[\s\S]+oi\.line_status\s*=\s*'awaiting'/i.test(s),
    );
    expect(matched.length).toBeGreaterThan(0);
  });

  it("no filter param → no line_status EXISTS clause in the SQL", async () => {
    const res = await app.inject({ method: "GET", url: "/orders" });
    expect(res.statusCode).toBe(200);

    const sqls = mockQuery.mock.calls.map((c: any[]) => String(c[0]));
    const matched = sqls.filter((s) => /oi\.line_status/i.test(s));
    expect(matched).toHaveLength(0);
  });
});
