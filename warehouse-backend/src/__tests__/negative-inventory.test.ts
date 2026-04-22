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

import { transaction } from "../db.js";
import orderRoutes from "../routes/orders.js";

const mockTransaction = vi.mocked(transaction);

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
});
