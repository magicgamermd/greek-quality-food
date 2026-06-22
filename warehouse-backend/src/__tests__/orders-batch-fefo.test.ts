// GQF — orders route must изписва наличност по партиди (FEFO).
//
// New contract (replaces orders-no-batch.test.ts): on POST /orders/:id/fulfill
// the route uses allocateFefo() to pick batches First-Expired-First-Out,
// inserts order_item_batches rows matching the allocator output, snapshots
// order_items.batch_id / cost_unit_price / cost_source_batch_id, and the
// recorded COGS equals Σ(qty × unit_cost). Expired-only stock is blocked.
//
// Mocking style follows the old contract test: vi.mock('../db.js') + auth
// injected via an onRequest hook + a per-call mocked client.query sequence.
import Fastify, { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(async () => ({ rows: [] })),
  transaction: vi.fn(),
}));

import { transaction } from "../db.js";
import orderRoutes from "../routes/orders.js";

const mockTransaction = vi.mocked(transaction);

function rows<T>(list: T[]) {
  return { rows: list, rowCount: list.length } as any;
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-admin",
      email: "admin@gqf.bg",
      role: "admin",
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(orderRoutes, { prefix: "/orders" });
  return app;
}

describe("orders route (GQF — FEFO batch deduction)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockTransaction.mockReset();
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("fulfill изписва FEFO: записва order_item_batches, сетва batch_id/COGS", async () => {
    // FEFO избира 2 партиди за qty=10: 6 @ 2.00 (изтича скоро) + 4 @ 3.00.
    // Очакван COGS = 6*2 + 4*3 = 24; cost_unit_price = 24/10 = 2.4.
    const todayPlus10 = new Date(Date.now() + 10 * 86400000)
      .toISOString()
      .slice(0, 10);
    const farFuture = "2099-12-31";

    const clientQuery = vi
      .fn()
      // 1. SELECT * FROM orders ... FOR UPDATE
      .mockResolvedValueOnce(
        rows([{ id: 70, status: "pending", partner_id: 1 }]),
      )
      // 2. SELECT * FROM order_items WHERE order_id = $1
      .mockResolvedValueOnce(
        rows([
          {
            id: 900,
            order_id: 70,
            product_id: 5,
            quantity: "10",
            line_status: "normal",
            is_returning: false,
            batch_id: null,
          },
        ]),
      )
      // 3. allocateFefo SELECT ... FROM inventory JOIN batches ... FOR UPDATE
      .mockResolvedValueOnce(
        rows([
          {
            batch_id: 11,
            batch_number: "B-EARLY",
            expiry_date: todayPlus10,
            purchase_price: "2.00",
            available: "6",
          },
          {
            batch_id: 12,
            batch_number: "B-LATE",
            expiry_date: farFuture,
            purchase_price: "3.00",
            available: "100",
          },
        ]),
      )
      // 4. UPDATE inventory (batch 11)
      .mockResolvedValueOnce(rows([]))
      // 5. UPDATE batches (batch 11)
      .mockResolvedValueOnce(rows([]))
      // 6. INSERT order_item_batches (batch 11)
      .mockResolvedValueOnce(rows([]))
      // 7. UPDATE inventory (batch 12)
      .mockResolvedValueOnce(rows([]))
      // 8. UPDATE batches (batch 12)
      .mockResolvedValueOnce(rows([]))
      // 9. INSERT order_item_batches (batch 12)
      .mockResolvedValueOnce(rows([]))
      // 10. UPDATE order_items SET cost_unit_price, batch_id, cost_source_batch_id
      .mockResolvedValueOnce(rows([]))
      // 11. UPDATE orders SET status='fulfilled'
      .mockResolvedValueOnce(rows([]))
      // 12. INSERT INTO notifications
      .mockResolvedValueOnce(rows([]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/orders/70/fulfill",
    });
    expect(res.statusCode).toBe(200);

    // order_item_batches inserts match the two FEFO allocations.
    const oibInserts = clientQuery.mock.calls.filter((c: any[]) =>
      String(c[0]).includes("INSERT INTO order_item_batches"),
    );
    expect(oibInserts).toHaveLength(2);
    // [order_item_id, batch_id, quantity, unit_cost]
    expect(oibInserts[0]![1]).toEqual([900, 11, 6, 2]);
    expect(oibInserts[1]![1]).toEqual([900, 12, 4, 3]);

    // Inventory + batches decremented per allocation (FEFO order: 11 then 12).
    const invUpdates = clientQuery.mock.calls.filter((c: any[]) =>
      String(c[0]).includes("UPDATE inventory"),
    );
    expect(invUpdates).toHaveLength(2);
    expect(invUpdates[0]![1]).toEqual([6, 5, 1, 11]);
    expect(invUpdates[1]![1]).toEqual([4, 5, 1, 12]);

    // order_items snapshot: cost_unit_price = 24/10 = 2.4, batch_id = first
    // allocation (11), cost_source_batch_id = 11.
    const oiUpdate = clientQuery.mock.calls.find((c: any[]) =>
      String(c[0]).includes("UPDATE order_items"),
    );
    expect(oiUpdate).toBeDefined();
    expect(oiUpdate![1]).toEqual([2.4, 11, 900]);

    // Response carries the expiry warning for the soon-expiring batch.
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings.some((w: string) => w.includes("B-EARLY"))).toBe(true);
  });

  it("блокира изписване когато само изтекли партиди са налични", async () => {
    const expired = "2000-01-01";
    const clientQuery = vi
      .fn()
      // 1. SELECT * FROM orders ... FOR UPDATE
      .mockResolvedValueOnce(
        rows([{ id: 71, status: "pending", partner_id: 1 }]),
      )
      // 2. SELECT * FROM order_items
      .mockResolvedValueOnce(
        rows([
          {
            id: 901,
            order_id: 71,
            product_id: 6,
            quantity: "5",
            line_status: "normal",
            is_returning: false,
            batch_id: null,
          },
        ]),
      )
      // 3. allocateFefo SELECT — only an expired batch exists → throws.
      .mockResolvedValueOnce(
        rows([
          {
            batch_id: 20,
            batch_number: "B-OLD",
            expiry_date: expired,
            purchase_price: "1.50",
            available: "50",
          },
        ]),
      );

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/orders/71/fulfill",
    });

    // InsufficientStockError (expired skipped) → clean 400, no order_item_batches insert.
    expect(res.statusCode).toBe(400);
    const oibInserts = clientQuery.mock.calls.filter((c: any[]) =>
      String(c[0]).includes("INSERT INTO order_item_batches"),
    );
    expect(oibInserts).toHaveLength(0);
  });
});
