// warehouse-backend/src/__tests__/negative-inventory.test.ts
//
// MERT-M: back-order support — inventory.quantity is allowed to go
// negative. Follows the project pattern from
// incoming-confirm-inventory.test.ts: vi.mock("../db.js"), auth
// injected via onRequest hook, assertions on the SQL that the route
// issues to the mocked client.
import Fastify, { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("orders route — back-order / negative inventory", () => {
  beforeEach(() => {
    mockTransaction.mockReset();
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] } as any);
  });

  it("fulfill allows inventory.quantity to go negative (UPDATE drops the >= guard)", async () => {
    // Order #42 has a single pending item (product 7, qty 3). Stock is 0.
    // After the change, deductProductStock must UPDATE without the
    // `quantity >= $1` guard so the row lands at -3.
    const clientQuery = vi
      .fn()
      // 1. SELECT * FROM orders WHERE id = $1 FOR UPDATE
      .mockResolvedValueOnce(
        rows([
          {
            id: 42,
            status: "pending",
            partner_id: 1,
            total_amount: "30",
          },
        ]),
      )
      // 2. SELECT * FROM order_items WHERE order_id = $1
      .mockResolvedValueOnce(
        rows([
          {
            id: 501,
            order_id: 42,
            product_id: 7,
            quantity: "3",
            unit_price: "10",
          },
        ]),
      )
      // 3. deductProductStock UPDATE inventory ... RETURNING quantity
      //    Current stock is 0 → new stock is -3. Row IS returned.
      .mockResolvedValueOnce(rows([{ quantity: "-3" }]))
      // 4. SELECT purchase_price FROM products WHERE id = $1
      .mockResolvedValueOnce(rows([{ purchase_price: "5" }]))
      // 5. UPDATE order_items SET cost_unit_price ... (one per item)
      .mockResolvedValueOnce(rows([]))
      // 6. UPDATE orders SET status='fulfilled', fulfilled_at = NOW() ...
      .mockResolvedValueOnce(rows([]))
      // 7. INSERT INTO notifications
      .mockResolvedValueOnce(rows([]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/orders/42/fulfill",
      });

      expect(res.statusCode).toBe(200);

      // The deductProductStock UPDATE must NOT carry the old guard.
      const deductCall = clientQuery.mock.calls.find(
        (call: any[]) =>
          String(call[0]).includes("UPDATE inventory") &&
          String(call[0]).includes("SET quantity = quantity -"),
      );
      expect(deductCall).toBeDefined();
      expect(String(deductCall![0])).not.toMatch(/quantity\s*>=\s*\$/);
    } finally {
      await app.close();
    }
  });

  it("fulfill falls back to INSERT when inventory row is missing entirely", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        rows([
          { id: 43, status: "pending", partner_id: 1, total_amount: "20" },
        ]),
      )
      .mockResolvedValueOnce(
        rows([
          {
            id: 510,
            order_id: 43,
            product_id: 8,
            quantity: "2",
            unit_price: "10",
          },
        ]),
      )
      // UPDATE inventory ... RETURNING quantity → 0 rows (no match)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      // INSERT INTO inventory ... VALUES ($1, 1, $2, NULL)
      .mockResolvedValueOnce(rows([]))
      // SELECT purchase_price
      .mockResolvedValueOnce(rows([{ purchase_price: "5" }]))
      // UPDATE order_items SET cost_unit_price
      .mockResolvedValueOnce(rows([]))
      // UPDATE orders SET status='fulfilled'
      .mockResolvedValueOnce(rows([]))
      // INSERT INTO notifications
      .mockResolvedValueOnce(rows([]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/orders/43/fulfill",
      });

      expect(res.statusCode).toBe(200);

      const insertCall = clientQuery.mock.calls.find((call: any[]) =>
        String(call[0]).includes("INSERT INTO inventory"),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall![1]).toEqual([8, -2]);
    } finally {
      await app.close();
    }
  });

  it("insufficient_stock error is no longer thrown on fulfillment", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        rows([
          { id: 44, status: "pending", partner_id: 1, total_amount: "100" },
        ]),
      )
      .mockResolvedValueOnce(
        rows([
          {
            id: 520,
            order_id: 44,
            product_id: 9,
            quantity: "10",
            unit_price: "10",
          },
        ]),
      )
      .mockResolvedValueOnce(rows([{ quantity: "-10" }]))
      .mockResolvedValueOnce(rows([{ purchase_price: "5" }]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/orders/44/fulfill",
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty("error", "insufficient_stock");
    } finally {
      await app.close();
    }
  });

  it("POST /orders succeeds with warnings.oversell when stock is insufficient", async () => {
    const clientQuery = vi
      .fn()
      // 1. SELECT * FROM partners
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
        rows([{ id: 7, selling_price: "10", name_bg: "Test Product" }]),
      )
      // 3. validateRequestedStock → SELECT COALESCE(SUM(quantity), 0)
      .mockResolvedValueOnce(rows([{ total: "0" }]))
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
      .mockResolvedValueOnce(
        rows([
          {
            id: 1001,
            order_id: 101,
            product_id: 7,
            quantity: "3",
            unit_price: "10",
            discount_percent: "0",
            total_price: "30",
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

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/orders",
        payload: {
          partner_id: 1,
          items: [{ product_id: 7, quantity: 3, unit_price: 10 }],
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.warnings?.oversell).toBeDefined();
      expect(body.warnings.oversell).toEqual([
        {
          product_id: 7,
          available: 0,
          requested: 3,
          final_stock: -3,
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it("confirming incoming goods offsets a negative inventory balance", async () => {
    // Inventory row for product 7 currently at -3. Incoming goods #99
    // carries qty 10. After confirm, the row must go from -3 to 7 via
    // the existing ON CONFLICT upsert — we only assert that the route
    // does NOT emit any conditional that would filter negatives out
    // (the upsert SQL is the same for all starting values).
    //
    // NOTE: This test lives in this file (not incoming-confirm-inventory.test.ts)
    // because its purpose is to guard back-order semantics as a whole.
    // We re-import the incoming route locally to avoid mutating the
    // outer file's top-level registration.
    const incomingRoutes = (await import("../routes/incoming.js")).default;
    const app = Fastify();
    app.addHook("onRequest", async (request) => {
      (request as any).user = {
        id: "u-warehouse",
        email: "warehouse@test.local",
        role: "admin",
      };
      (request as any).jwtVerify = async () => (request as any).user;
    });
    await app.register(incomingRoutes, { prefix: "/incoming" });

    const clientQuery = vi
      .fn()
      // UPDATE incoming_goods → row returned (was pending)
      .mockResolvedValueOnce(
        rows([{ id: 99, status: "pending", invoice_number: "INV-99" }]),
      )
      // SELECT * FROM incoming_items
      .mockResolvedValueOnce(
        rows([
          {
            id: 1,
            product_id: 7,
            batch_id: null,
            quantity: 10,
            unit_price: 5,
          },
        ]),
      )
      // INSERT INTO inventory ... ON CONFLICT DO UPDATE
      .mockResolvedValueOnce(rows([]))
      // UPDATE products SET purchase_price
      .mockResolvedValueOnce(rows([]))
      // INSERT INTO notifications
      .mockResolvedValueOnce(rows([]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    try {
      const res = await app.inject({
        method: "PUT",
        url: "/incoming/99/confirm",
      });
      expect(res.statusCode).toBe(200);

      const insertInv = clientQuery.mock.calls.find((call: any[]) =>
        String(call[0]).includes("INSERT INTO inventory"),
      );
      expect(insertInv).toBeDefined();
      const sql = String(insertInv![0]);
      // The upsert must not gate on `quantity >= 0` anywhere — the
      // math has to apply unconditionally so negatives get offset.
      expect(sql).toMatch(/ON CONFLICT/);
      expect(sql).not.toMatch(/WHERE\s+inventory\.quantity\s*>=\s*0/);
      expect(sql).not.toMatch(/HAVING\s+.*quantity\s*>=\s*0/);
    } finally {
      await app.close();
    }
  });

  it("cancelling a fulfilled order adds the quantity back (may turn -1 into 2)", async () => {
    // Order 50 was fulfilled with qty 3 of product 7. Inventory is -1.
    // Cancelling it calls the inline restore loop in DELETE /orders/:id →
    // the ON CONFLICT upsert adds 3 and the row becomes 2.
    //
    // The DELETE handler has two separate transaction() calls:
    //   1st: SELECT * FROM orders WHERE id = $1 FOR UPDATE (lock check)
    //   2nd: re-lock + restore items + UPDATE orders SET status='cancelled'
    // Module-level query() handles the initial snapshot SELECT and the
    // final notifications INSERT — those are covered by mockQuery default.

    // 1st transaction: just the FOR UPDATE lock
    const lockQuery = vi.fn().mockResolvedValueOnce(
      rows([
        {
          id: 50,
          status: "fulfilled",
          partner_id: 1,
          total_amount: "30",
          invoice_id: null,
        },
      ]),
    );

    // 2nd transaction: re-lock + items + inventory upsert + cancel
    const cancelQuery = vi
      .fn()
      // SELECT id FROM orders WHERE id = $1 FOR UPDATE (re-lock)
      .mockResolvedValueOnce(rows([{ id: 50 }]))
      // SELECT product_id, quantity FROM order_items
      .mockResolvedValueOnce(
        rows([
          {
            id: 601,
            order_id: 50,
            product_id: 7,
            quantity: "3",
          },
        ]),
      )
      // INSERT INTO inventory ON CONFLICT DO UPDATE (restore)
      .mockResolvedValueOnce(rows([]))
      // UPDATE orders SET status='cancelled'
      .mockResolvedValueOnce(rows([]));

    let callCount = 0;
    mockTransaction.mockImplementation(async (callback: any) => {
      callCount++;
      if (callCount === 1) return callback({ query: lockQuery });
      return callback({ query: cancelQuery });
    });

    // Module-level query: first call is the snapshot SELECT (returns row),
    // subsequent call is notifications INSERT (default empty rows is fine).
    mockQuery
      .mockResolvedValueOnce(rows([{ id: 50 }]))
      .mockResolvedValueOnce(rows([]));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/orders/50",
      });

      expect(res.statusCode).toBe(200);

      const upsert = cancelQuery.mock.calls.find((call: any[]) =>
        String(call[0]).includes("INSERT INTO inventory"),
      );
      expect(upsert).toBeDefined();
      // The restore path must not filter on quantity sign either.
      expect(String(upsert![0])).not.toMatch(/quantity\s*>=\s*0/);
    } finally {
      await app.close();
    }
  });

  it("POST /orders omits warnings.oversell when all items have sufficient stock", async () => {
    const clientQuery = vi
      .fn()
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
      .mockResolvedValueOnce(
        rows([{ id: 7, selling_price: "10", name_bg: "Test Product" }]),
      )
      .mockResolvedValueOnce(rows([{ total: "10" }])) // plenty of stock
      .mockResolvedValueOnce(
        rows([
          { id: 102, partner_id: 1, status: "pending", order_number: 102 },
        ]),
      )
      .mockResolvedValueOnce(
        rows([
          {
            id: 1002,
            order_id: 102,
            product_id: 7,
            quantity: "3",
            unit_price: "10",
            discount_percent: "0",
            total_price: "30",
          },
        ]),
      )
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/orders",
        payload: {
          partner_id: 1,
          items: [{ product_id: 7, quantity: 3, unit_price: 10 }],
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.warnings?.oversell).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
