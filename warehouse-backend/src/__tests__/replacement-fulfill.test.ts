import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import orderRoutes from "../routes/orders.js";

// Mirror the mocking pattern from replacement-payment.test.ts: mock the db
// module, then drive POST /orders/:id/fulfill via app.inject. Each test
// captures the SQL sequence from clientQuery.mock.calls and asserts on the
// stock UPDATE statements (give lines decrement, return lines increment).
vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query, transaction } from "../db.js";

const mockQuery = vi.mocked(query);
const mockTransaction = vi.mocked(transaction);

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
  await app.register(orderRoutes, { prefix: "/orders" });
  return app;
}

type FakeItem = {
  id: number;
  product_id: number;
  quantity: number;
  is_returning: boolean;
  line_status?: string;
};

// Wires up clientQuery to drive the fulfill flow:
//   1  SELECT * FROM orders WHERE id = $1 FOR UPDATE   → return order
//   2  SELECT * FROM order_items WHERE order_id = $1   → return items
//   3+ deduct/refund per item → either UPDATE inventory ... quantity - $1
//                                     or UPDATE inventory ... quantity + $1
//   N  UPDATE orders SET status = 'fulfilled' ...
//   N+1 INSERT INTO notifications ...
function setupFulfillMocks(opts: { orderId: number; items: FakeItem[] }) {
  const order = {
    id: opts.orderId,
    status: "pending",
    is_replacement: opts.items.some((i) => i.is_returning),
  };

  const itemRows = opts.items.map((it) => ({
    id: it.id,
    order_id: opts.orderId,
    product_id: it.product_id,
    quantity: String(it.quantity),
    line_status: it.line_status ?? "normal",
    is_returning: it.is_returning,
  }));

  const clientQuery = vi
    .fn()
    .mockImplementation(async (sql: string, params: any[] = []) => {
      const text = String(sql);
      if (
        text.includes("FROM orders WHERE id = $1") &&
        text.includes("FOR UPDATE")
      ) {
        return rows([order]);
      }
      if (text.includes("FROM order_items WHERE order_id = $1")) {
        return rows(itemRows);
      }
      // deductProductStock pre-check (only used when allowNegative=false).
      if (text.includes("FROM inventory") && text.includes("SUM(quantity)")) {
        return rows([{ qty: "999" }]);
      }
      // The deduct UPDATE — we still need to return rowCount > 0 so the
      // helper does not fall into the INSERT branch.
      if (
        text.includes("UPDATE inventory") &&
        text.includes("SET quantity = quantity -")
      ) {
        return { rows: [{ quantity: "100" }], rowCount: 1 } as any;
      }
      // The refund UPDATE for return lines (the new path we are adding).
      if (
        text.includes("UPDATE inventory") &&
        text.includes("SET quantity = quantity +")
      ) {
        return { rows: [{ quantity: "100" }], rowCount: 1 } as any;
      }
      if (text.includes("FROM products WHERE id")) {
        return rows([{ purchase_price: "50" }]);
      }
      if (
        text.includes("UPDATE order_items") &&
        text.includes("SET cost_unit_price")
      ) {
        return rows([]);
      }
      if (text.includes("UPDATE orders SET status")) return rows([]);
      if (text.includes("INSERT INTO notifications")) return rows([]);
      return rows([]);
    });

  mockTransaction.mockImplementation(async (callback: any) =>
    callback({ query: clientQuery }),
  );

  return clientQuery;
}

function findInventoryUpdates(clientQuery: ReturnType<typeof vi.fn>) {
  return clientQuery.mock.calls.filter((call: any[]) =>
    String(call[0]).includes("UPDATE inventory"),
  );
}

describe("POST /orders/:id/fulfill — bidirectional replacement stock", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("decreases stock for give lines and increases for return lines", async () => {
    const clientQuery = setupFulfillMocks({
      orderId: 9100,
      items: [
        { id: 1, product_id: 101, quantity: 1, is_returning: false },
        { id: 2, product_id: 102, quantity: 1, is_returning: true },
      ],
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/orders/9100/fulfill",
      });
      expect(res.statusCode).toBe(200);

      const updates = findInventoryUpdates(clientQuery);
      // One UPDATE per item.
      expect(updates).toHaveLength(2);

      const decrementCall = updates.find((c: any[]) =>
        String(c[0]).includes("SET quantity = quantity -"),
      );
      const incrementCall = updates.find((c: any[]) =>
        String(c[0]).includes("SET quantity = quantity +"),
      );

      // Give line 101 → decrement
      expect(decrementCall).toBeDefined();
      expect(decrementCall![1]).toEqual(expect.arrayContaining([1, 101]));

      // Return line 102 → increment
      expect(incrementCall).toBeDefined();
      expect(incrementCall![1]).toEqual(expect.arrayContaining([1, 102]));
    } finally {
      await app.close();
    }
  });

  it("handles the same SKU in both sides (warranty case)", async () => {
    // Same product 200 appears as both give and return (warranty swap).
    // Net inventory effect should be zero: one decrement + one increment.
    const clientQuery = setupFulfillMocks({
      orderId: 9101,
      items: [
        { id: 10, product_id: 200, quantity: 1, is_returning: false },
        { id: 11, product_id: 200, quantity: 1, is_returning: true },
      ],
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/orders/9101/fulfill",
      });
      expect(res.statusCode).toBe(200);

      const updates = findInventoryUpdates(clientQuery);
      expect(updates).toHaveLength(2);

      const decrements = updates.filter((c: any[]) =>
        String(c[0]).includes("SET quantity = quantity -"),
      );
      const increments = updates.filter((c: any[]) =>
        String(c[0]).includes("SET quantity = quantity +"),
      );

      // Exactly one of each — net effect zero.
      expect(decrements).toHaveLength(1);
      expect(increments).toHaveLength(1);

      // Both target product 200 with quantity 1.
      expect(decrements[0]![1]).toEqual(expect.arrayContaining([1, 200]));
      expect(increments[0]![1]).toEqual(expect.arrayContaining([1, 200]));
    } finally {
      await app.close();
    }
  });
});
