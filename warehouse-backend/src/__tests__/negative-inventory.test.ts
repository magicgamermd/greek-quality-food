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

  it("fulfill изписва FEFO по партида (без guard върху наличността)", async () => {
    // GQF: order #42 has a single pending item (product 7, qty 3). FEFO
    // избира партида 60 (10 налични) и изписва 3. UPDATE inventory е по
    // партида и не носи стария >= guard.
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
            line_status: "normal",
            is_returning: false,
            batch_id: null,
          },
        ]),
      )
      // 3. allocateFefo SELECT
      .mockResolvedValueOnce(
        rows([
          {
            batch_id: 60,
            batch_number: "B-60",
            expiry_date: "2099-01-01",
            purchase_price: "5",
            available: "10",
          },
        ]),
      )
      // 4. UPDATE inventory (batch 60)
      .mockResolvedValueOnce(rows([]))
      // 5. UPDATE batches (batch 60)
      .mockResolvedValueOnce(rows([]))
      // 6. INSERT order_item_batches
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

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/orders/42/fulfill",
      });

      expect(res.statusCode).toBe(200);

      // The FEFO deduction UPDATE must NOT carry the old guard.
      const deductCall = clientQuery.mock.calls.find(
        (call: any[]) =>
          String(call[0]).includes("UPDATE inventory") &&
          String(call[0]).includes("SET quantity = quantity -"),
      );
      expect(deductCall).toBeDefined();
      expect(String(deductCall![0])).not.toMatch(/quantity\s*>=\s*\$/);
      expect(deductCall![1]).toEqual([3, 7, 1, 60]);
    } finally {
      await app.close();
    }
  });

  it("fulfill записва order_item_batches за разпределената партида", async () => {
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
            line_status: "normal",
            is_returning: false,
            batch_id: null,
          },
        ]),
      )
      // allocateFefo SELECT
      .mockResolvedValueOnce(
        rows([
          {
            batch_id: 61,
            batch_number: "B-61",
            expiry_date: "2099-01-01",
            purchase_price: "5",
            available: "5",
          },
        ]),
      )
      // UPDATE inventory
      .mockResolvedValueOnce(rows([]))
      // UPDATE batches
      .mockResolvedValueOnce(rows([]))
      // INSERT order_item_batches
      .mockResolvedValueOnce(rows([]))
      // UPDATE order_items snapshot
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

      const oibInsert = clientQuery.mock.calls.find((call: any[]) =>
        String(call[0]).includes("INSERT INTO order_item_batches"),
      );
      expect(oibInsert).toBeDefined();
      // [order_item_id, batch_id, quantity, unit_cost]
      expect(oibInsert![1]).toEqual([510, 61, 2, 5]);
    } finally {
      await app.close();
    }
  });

  it("fulfill блокира с 400 когато няма неизтекла партидна наличност", async () => {
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
            line_status: "normal",
            is_returning: false,
            batch_id: null,
          },
        ]),
      )
      // allocateFefo SELECT — no batches available → InsufficientStockError → 400
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

      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("paid_not_taken back-order: успява без наличност (минус срещу 'НАЧАЛНО')", async () => {
    // Платена линия без налична партида → НЕ блокира; изписва shortfall в
    // минус срещу откриващата партида и поръчката се изпълнява.
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        rows([
          { id: 45, status: "pending", partner_id: 1, total_amount: "30" },
        ]),
      )
      .mockResolvedValueOnce(
        rows([
          {
            id: 530,
            order_id: 45,
            product_id: 14,
            quantity: "3",
            unit_price: "10",
            line_status: "paid_not_taken",
            is_returning: false,
            batch_id: null,
          },
        ]),
      )
      // allocateFefo SELECT → нищо налично (shortfall=3)
      .mockResolvedValueOnce(rows([]))
      // getOrCreateOpeningBatch: SELECT откриваща → липсва
      .mockResolvedValueOnce(rows([]))
      // SELECT purchase_price FROM products
      .mockResolvedValueOnce(rows([{ purchase_price: "5" }]))
      // INSERT batches (НАЧАЛНО) RETURNING id
      .mockResolvedValueOnce(rows([{ id: 888 }]))
      // UPDATE inventory (откриваща) → rowCount 0 → INSERT branch
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      // INSERT inventory (откриваща, минус)
      .mockResolvedValueOnce(rows([]))
      // UPDATE batches (откриваща, минус)
      .mockResolvedValueOnce(rows([]))
      // INSERT order_item_batches
      .mockResolvedValueOnce(rows([]))
      // UPDATE order_items snapshot
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
        url: "/orders/45/fulfill",
      });

      expect(res.statusCode).toBe(200);

      // Минус наличност срещу откриващата партида (INSERT с -3).
      const invInsert = clientQuery.mock.calls.find((c: any[]) =>
        String(c[0]).includes("INSERT INTO inventory"),
      );
      expect(invInsert).toBeDefined();
      expect(invInsert![1]).toEqual([14, 888, 1, -3]);

      // order_item_batches ред за shortfall.
      const oibInsert = clientQuery.mock.calls.find((c: any[]) =>
        String(c[0]).includes("INSERT INTO order_item_batches"),
      );
      expect(oibInsert).toBeDefined();
      expect(oibInsert![1]).toEqual([530, 888, 3, 5]);
    } finally {
      await app.close();
    }
  });

  it("ИЗТЕКЛА партида → блок 400 (дори за paid_not_taken? не — нормална линия)", async () => {
    // Изтеклата партида се пропуска от FEFO. За НОРМАЛНА линия без друга
    // налична партида → InsufficientStockError → 400.
    const expired = "2000-01-01";
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        rows([
          { id: 46, status: "pending", partner_id: 1, total_amount: "10" },
        ]),
      )
      .mockResolvedValueOnce(
        rows([
          {
            id: 540,
            order_id: 46,
            product_id: 15,
            quantity: "1",
            unit_price: "10",
            line_status: "normal",
            is_returning: false,
            batch_id: null,
          },
        ]),
      )
      // allocateFefo SELECT → само изтекла партида (пропусната) → 400
      .mockResolvedValueOnce(
        rows([
          {
            batch_id: 77,
            batch_number: "OLD",
            expiry_date: expired,
            purchase_price: "5",
            available: "100",
          },
        ]),
      );

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/orders/46/fulfill",
      });

      expect(res.statusCode).toBe(400);
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
    const incomingModule: any = await import("../routes/incoming.js");
    const incomingRoutes = incomingModule.default ?? incomingModule;
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
      // INSERT INTO batches (no batch_number on the line → auto batch)
      .mockResolvedValueOnce(rows([{ id: 7001 }]))
      // INSERT INTO inventory ... ON CONFLICT DO UPDATE
      .mockResolvedValueOnce(rows([]))
      // UPDATE incoming_items SET batch_id
      .mockResolvedValueOnce(rows([]))
      // UPDATE products SET purchase_price
      .mockResolvedValueOnce(rows([]))
      // SELECT order_items pendingLines
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
