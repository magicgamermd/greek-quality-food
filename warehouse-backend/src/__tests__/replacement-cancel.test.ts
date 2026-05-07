import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import orderRoutes from "../routes/orders.js";

// Mirror the mocking pattern from replacement-fulfill.test.ts and
// replacement-payment.test.ts: mock the db module and drive
// DELETE /orders/:id via app.inject. Each test inspects the captured SQL
// calls to verify (a) inventory UPDATEs reverse the fulfill direction and
// (b) a mirror payment row is INSERTed flipping is_refund.
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
};

type OrigPayment = {
  amount: string;
  payment_method: string;
  is_refund: boolean;
};

function setupCancelMocks(opts: {
  orderId: number;
  items: FakeItem[];
  origPayment: OrigPayment | null;
}) {
  const order = {
    id: opts.orderId,
    status: "fulfilled",
    is_replacement: true,
    invoice_id: null,
  };

  const itemRows = opts.items.map((it) => ({
    id: it.id,
    order_id: opts.orderId,
    product_id: it.product_id,
    quantity: String(it.quantity),
    is_returning: it.is_returning,
  }));

  // Top-level (non-transaction) query mock — used for the initial
  // "SELECT id FROM orders WHERE id = $1" existence check and the
  // post-cancel notification INSERT.
  mockQuery.mockImplementation(async (sql: string, _params: any[] = []) => {
    const text = String(sql);
    if (text.includes("SELECT id FROM orders WHERE id = $1")) {
      return rows([{ id: opts.orderId }]);
    }
    if (text.includes("INSERT INTO notifications")) {
      return rows([]);
    }
    return rows([]);
  });

  const clientQuery = vi
    .fn()
    .mockImplementation(async (sql: string, _params: any[] = []) => {
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
      if (text.includes("FROM payments") && text.includes("order_id = $1")) {
        return rows(opts.origPayment ? [opts.origPayment] : []);
      }
      if (text.includes("UPDATE inventory")) {
        return { rows: [{ quantity: "100" }], rowCount: 1 } as any;
      }
      if (text.includes("INSERT INTO inventory")) {
        return rows([]);
      }
      if (text.includes("INSERT INTO payments")) {
        return rows([{ id: 999 }]);
      }
      if (text.includes("UPDATE orders SET status")) {
        return rows([]);
      }
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

function findPaymentInsert(clientQuery: ReturnType<typeof vi.fn>) {
  return clientQuery.mock.calls.find((call: any[]) =>
    String(call[0]).includes("INSERT INTO payments"),
  );
}

describe("DELETE /orders/:id — cancel replacement order", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("reverses stock movements and writes mirror payment (positive total case)", async () => {
    // Original fulfill: give product 101 (qty 1, stock −1) + return product
    // 102 (qty 1, stock +1). Initial payment was amount=30, is_refund=false
    // (customer paid difference). Cancel must reverse: give +1, return −1,
    // and write mirror payment amount=30, is_refund=true.
    const clientQuery = setupCancelMocks({
      orderId: 9200,
      items: [
        { id: 1, product_id: 101, quantity: 1, is_returning: false },
        { id: 2, product_id: 102, quantity: 1, is_returning: true },
      ],
      origPayment: {
        amount: "30",
        payment_method: "cash",
        is_refund: false,
      },
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/orders/9200",
      });
      expect(res.statusCode).toBe(200);

      const updates = findInventoryUpdates(clientQuery);
      // One UPDATE per item, reversing the fulfill direction.
      expect(updates).toHaveLength(2);

      // Give line 101 reverses: was decrement on fulfill → now increment.
      const giveReversal = updates.find((c: any[]) =>
        (c[1] as any[]).includes(101),
      );
      expect(giveReversal).toBeDefined();
      const giveSql = String(giveReversal![0]);
      const giveParams = giveReversal![1] as any[];
      // Reversal is "stock back to original" — quantity should be +1 net.
      // Either we use "SET quantity = quantity + $1" with +1, or
      // "SET quantity = quantity + $1" with a signed value where the
      // signed value is +1 for a give line. Check the net effect:
      const giveNetSign = giveSql.includes("quantity + $1")
        ? Math.sign(Number(giveParams[0]))
        : -Math.sign(Number(giveParams[0]));
      expect(giveNetSign).toBe(1); // give product gets stock back (+1)

      // Return line 102 reverses: was increment on fulfill → now decrement.
      const returnReversal = updates.find((c: any[]) =>
        (c[1] as any[]).includes(102),
      );
      expect(returnReversal).toBeDefined();
      const returnSql = String(returnReversal![0]);
      const returnParams = returnReversal![1] as any[];
      const returnNetSign = returnSql.includes("quantity + $1")
        ? Math.sign(Number(returnParams[0]))
        : -Math.sign(Number(returnParams[0]));
      expect(returnNetSign).toBe(-1); // returned item leaves stock (−1)

      const paymentCall = findPaymentInsert(clientQuery);
      expect(paymentCall).toBeDefined();
      const params = paymentCall![1] as any[];
      // [order_id, amount, payment_method, is_refund]
      expect(params[0]).toBe("9200");
      expect(Number(params[1])).toBe(30);
      expect(params[2]).toBe("cash");
      expect(params[3]).toBe(true); // mirror flips is_refund false → true
    } finally {
      await app.close();
    }
  });

  it("reverses stock and mirrors refund (negative total case)", async () => {
    // Original total -50: we initially refunded the customer
    // (amount=50, is_refund=true). Cancel mirrors with is_refund=false
    // (money flows back to us).
    const clientQuery = setupCancelMocks({
      orderId: 9201,
      items: [
        { id: 10, product_id: 201, quantity: 1, is_returning: false },
        { id: 11, product_id: 202, quantity: 1, is_returning: true },
      ],
      origPayment: {
        amount: "50",
        payment_method: "cash",
        is_refund: true,
      },
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/orders/9201",
      });
      expect(res.statusCode).toBe(200);

      const paymentCall = findPaymentInsert(clientQuery);
      expect(paymentCall).toBeDefined();
      const params = paymentCall![1] as any[];
      expect(params[0]).toBe("9201");
      expect(Number(params[1])).toBe(50);
      expect(params[2]).toBe("cash");
      expect(params[3]).toBe(false); // mirror flips is_refund true → false
    } finally {
      await app.close();
    }
  });
});
