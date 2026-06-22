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
    // the FEFO deduction path (deductBatched).
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
            is_returning: false,
            batch_id: null,
          },
          {
            id: 602,
            order_id: 50,
            product_id: 8,
            quantity: "5",
            unit_price: "20",
            line_status: "awaiting",
            is_returning: false,
            batch_id: null,
          },
        ]),
      )
      // 3. allocateFefo SELECT (one batch covers the whole qty)
      .mockResolvedValueOnce(
        rows([
          {
            batch_id: 30,
            batch_number: "B-7",
            expiry_date: "2099-01-01",
            purchase_price: "5",
            available: "10",
          },
        ]),
      )
      // 4. UPDATE inventory (batch 30)
      .mockResolvedValueOnce(rows([]))
      // 5. UPDATE batches (batch 30)
      .mockResolvedValueOnce(rows([]))
      // 6. INSERT order_item_batches (batch 30)
      .mockResolvedValueOnce(rows([]))
      // 7. UPDATE order_items SET cost_unit_price, batch_id, cost_source_batch_id
      .mockResolvedValueOnce(rows([]))
      // 8. UPDATE orders SET status='fulfilled'
      .mockResolvedValueOnce(rows([]))
      // 9. INSERT INTO notifications
      .mockResolvedValueOnce(rows([]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/orders/50/fulfill",
    });
    expect(res.statusCode).toBe(200);

    // Only ONE UPDATE inventory should have fired (for the normal line),
    // targeting product 7, warehouse 1, batch 30.
    const inventoryUpdates = clientQuery.mock.calls.filter((c: any[]) =>
      String(c[0]).includes("UPDATE inventory"),
    );
    expect(inventoryUpdates).toHaveLength(1);
    expect(inventoryUpdates[0]![1]).toEqual([2, 7, 1, 30]);

    // Exactly one order_item_batches insert (the awaiting line is skipped).
    const oibInserts = clientQuery.mock.calls.filter((c: any[]) =>
      String(c[0]).includes("INSERT INTO order_item_batches"),
    );
    expect(oibInserts).toHaveLength(1);
    expect(oibInserts[0]![1]).toEqual([601, 30, 2, 5]);

    // The cost snapshot UPDATE targets order_item 601 (cost 5*2/2 = 5).
    const costSnapshots = clientQuery.mock.calls.filter((c: any[]) =>
      String(c[0]).includes("SET cost_unit_price"),
    );
    expect(costSnapshots).toHaveLength(1);
    expect(costSnapshots[0]![1]).toEqual([5, 30, 601]);
  });

  it("on a paid_not_taken line, изписва FEFO по партида", async () => {
    // paid_not_taken вече минава през FEFO като всеки друг ред — стоката
    // трябва да съществува по партида.
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
            is_returning: false,
            batch_id: null,
          },
        ]),
      )
      // 3. allocateFefo SELECT
      .mockResolvedValueOnce(
        rows([
          {
            batch_id: 40,
            batch_number: "B-9",
            expiry_date: "2099-01-01",
            purchase_price: "5",
            available: "10",
          },
        ]),
      )
      // 4. UPDATE inventory (batch 40)
      .mockResolvedValueOnce(rows([]))
      // 5. UPDATE batches (batch 40)
      .mockResolvedValueOnce(rows([]))
      // 6. INSERT order_item_batches (batch 40)
      .mockResolvedValueOnce(rows([]))
      // 7. UPDATE order_items snapshot
      .mockResolvedValueOnce(rows([]))
      // 8. UPDATE orders SET status='fulfilled'
      .mockResolvedValueOnce(rows([]))
      // 9. INSERT INTO notifications
      .mockResolvedValueOnce(rows([]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/orders/51/fulfill",
    });
    expect(res.statusCode).toBe(200);

    // FEFO deduction fired for product 9, batch 40, qty 3.
    const inventoryUpdates = clientQuery.mock.calls.filter((c: any[]) =>
      String(c[0]).includes("UPDATE inventory"),
    );
    expect(inventoryUpdates).toHaveLength(1);
    expect(inventoryUpdates[0]![1]).toEqual([3, 9, 1, 40]);
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

  it("flips awaiting → normal AND изписва FEFO по партида", async () => {
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
            batch_id: null,
          },
        ]),
      )
      // 2. allocateFefo SELECT
      .mockResolvedValueOnce(
        rows([
          {
            batch_id: 50,
            batch_number: "B-A",
            expiry_date: "2099-01-01",
            purchase_price: "4",
            available: "5",
          },
        ]),
      )
      // 3. UPDATE inventory (batch 50)
      .mockResolvedValueOnce(rows([]))
      // 4. UPDATE batches (batch 50)
      .mockResolvedValueOnce(rows([]))
      // 5. INSERT order_item_batches (batch 50)
      .mockResolvedValueOnce(rows([]))
      // 6. UPDATE order_items SET line_status='normal', cost_unit_price, batch_id
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

    // FEFO deduction fired for product 7, batch 50, qty 2.
    const update = clientQuery.mock.calls.find((c: any[]) =>
      String(c[0]).includes("UPDATE inventory"),
    );
    expect(update).toBeDefined();
    expect(update![1]).toEqual([2, 7, 1, 50]);

    // order_item_batches insert recorded the allocation.
    const oibInsert = clientQuery.mock.calls.find((c: any[]) =>
      String(c[0]).includes("INSERT INTO order_item_batches"),
    );
    expect(oibInsert).toBeDefined();
    expect(oibInsert![1]).toEqual([1, 50, 2, 4]);
  });

  it("refuses 400 when stock is insufficient (FEFO)", async () => {
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
            batch_id: null,
          },
        ]),
      )
      // 2. allocateFefo SELECT — no available batches → InsufficientStockError → 400
      .mockResolvedValueOnce(rows([]));
    mockTransaction.mockImplementationOnce(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/orders/10/items/1/confirm-from-awaiting",
    });
    expect(res.statusCode).toBe(400);
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
