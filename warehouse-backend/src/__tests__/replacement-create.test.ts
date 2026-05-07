import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import orderRoutes from "../routes/orders.js";

// Match the pattern used in incoming-confirm-inventory.test.ts and
// payments-razpiska.test.ts: mock the db module, then drive the route
// via app.inject. Each test wires up a clientQuery sequence matching the
// real INSERT/SELECT order in POST /orders.
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
      role: "admin", // admin bypasses ORDERS_MANAGE check via hasPermission
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(orderRoutes, { prefix: "/orders" });
  return app;
}

// Builds a clientQuery mock that walks through the POST /orders flow for a
// 2-line replacement order (one give, one return). This mirrors the SQL
// sequence in src/routes/orders.ts:
//
//   0  SELECT * FROM partners WHERE id = $1
//   1  SELECT product_id, price FROM price_list_items   (only if partner.price_list_id)
//      — skipped here; partner has no price list.
//   2  SELECT id, selling_price, ... FROM products WHERE id = ANY($1)
//   3  validateRequestedStock: SELECT SUM(quantity) FROM inventory ... per unique stockable product
//      For replacement orders we expect ONLY give lines to be checked.
//   4  INSERT INTO orders ... RETURNING *
//   5  INSERT INTO order_items (give line) RETURNING *
//   6  INSERT INTO order_items (return line) RETURNING *
//   7  UPDATE orders SET total_amount = $1
//   8  INSERT INTO notifications (order_created)
function setupReplacementMocks(opts: {
  partner: { id: number; partner_type: string; vat_number?: string | null };
  products: Array<{ id: number; selling_price?: string }>;
  inventoryStock?: Record<number, number>;
}) {
  const partner = {
    id: opts.partner.id,
    name: "Test Partner",
    price_list_id: null,
    price_group: null,
    partner_type: opts.partner.partner_type,
    vat_number: opts.partner.vat_number ?? null,
  };
  const productRows = opts.products.map((p) => ({
    id: p.id,
    selling_price: p.selling_price ?? "0",
    group_price: null,
    name_bg: `Product ${p.id}`,
    name_en: `Product EN ${p.id}`,
    sku: `SKU-${p.id}`,
    purchase_price: null,
  }));

  const stock = opts.inventoryStock ?? {};
  const inventoryRow = (productId: number) =>
    rows([{ total: String(stock[productId] ?? 999) }]);

  const clientQuery = vi
    .fn()
    .mockImplementation(async (sql: string, params: any[] = []) => {
      const text = String(sql);
      if (text.includes("FROM partners WHERE id")) return rows([partner]);
      if (text.includes("FROM price_list_items")) return rows([]);
      if (text.includes("FROM products WHERE id = ANY"))
        return rows(productRows);
      if (text.includes("FROM inventory WHERE product_id")) {
        return inventoryRow(params[0]);
      }
      if (text.includes("INSERT INTO orders")) {
        // Capture is_replacement param so the assertion stage can verify it.
        const isReplacementIdx = params.length - 2; // is_replacement appears just before status; safer to read by name
        return rows([
          {
            id: 9000,
            order_number: 9000,
            partner_id: params[0],
            status: params[params.length - 1],
            is_replacement: params.includes(true),
            total_amount: 0,
          },
        ]);
      }
      if (text.includes("INSERT INTO order_items")) {
        // Last param is is_returning per the new INSERT shape (or it's
        // before line_status — we'll figure out the order during impl).
        return rows([
          {
            id: Math.floor(Math.random() * 100000),
            order_id: params[0],
            product_id: params[1],
            quantity: params[2],
            unit_price: params[3],
            discount_percent: params[4],
            total_price: params[5],
            line_status: params[9] ?? "normal",
            is_returning: params[10] ?? false,
          },
        ]);
      }
      if (text.includes("UPDATE orders SET total_amount")) return rows([]);
      if (text.includes("INSERT INTO notifications")) return rows([]);
      return rows([]);
    });

  mockTransaction.mockImplementation(async (callback: any) =>
    callback({ query: clientQuery }),
  );

  return clientQuery;
}

describe("POST /orders — replacement", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("creates a replacement order with one give + one return line", async () => {
    setupReplacementMocks({
      partner: { id: 1, partner_type: "individual" },
      products: [
        { id: 101, selling_price: "230" },
        { id: 102, selling_price: "200" },
      ],
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/orders",
        payload: {
          partner_id: 1,
          is_replacement: true,
          items: [
            {
              product_id: 101,
              quantity: 1,
              unit_price: 230,
              is_returning: false,
            },
            {
              product_id: 102,
              quantity: 1,
              unit_price: 200,
              is_returning: true,
            },
          ],
          payment_method: "cash",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.is_replacement).toBe(true);
      expect(body.items).toHaveLength(2);
      expect(body.items.find((i: any) => i.is_returning)).toBeTruthy();
      // Signed total: give 230 - return 200 = 30
      expect(body.total_amount).toBe(30);
    } finally {
      await app.close();
    }
  });

  it("rejects replacement with no give line", async () => {
    setupReplacementMocks({
      partner: { id: 1, partner_type: "individual" },
      products: [{ id: 101, selling_price: "100" }],
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/orders",
        payload: {
          partner_id: 1,
          is_replacement: true,
          items: [
            {
              product_id: 101,
              quantity: 1,
              unit_price: 100,
              is_returning: true,
            },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/поне един артикул/i);
    } finally {
      await app.close();
    }
  });

  it("rejects replacement with no return line", async () => {
    setupReplacementMocks({
      partner: { id: 1, partner_type: "individual" },
      products: [{ id: 101, selling_price: "100" }],
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/orders",
        payload: {
          partner_id: 1,
          is_replacement: true,
          items: [
            {
              product_id: 101,
              quantity: 1,
              unit_price: 100,
              is_returning: false,
            },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/поне един артикул/i);
    } finally {
      await app.close();
    }
  });

  it("rejects is_returning=true on a non-replacement order", async () => {
    setupReplacementMocks({
      partner: { id: 1, partner_type: "individual" },
      products: [{ id: 101, selling_price: "100" }],
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/orders",
        payload: {
          partner_id: 1,
          is_replacement: false,
          items: [
            {
              product_id: 101,
              quantity: 1,
              unit_price: 100,
              is_returning: true,
            },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/замяна/i);
    } finally {
      await app.close();
    }
  });

  it("computes negative total when return > give", async () => {
    setupReplacementMocks({
      partner: { id: 1, partner_type: "individual" },
      products: [
        { id: 101, selling_price: "150" },
        { id: 102, selling_price: "200" },
      ],
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/orders",
        payload: {
          partner_id: 1,
          is_replacement: true,
          items: [
            {
              product_id: 101,
              quantity: 1,
              unit_price: 150,
              is_returning: false,
            },
            {
              product_id: 102,
              quantity: 1,
              unit_price: 200,
              is_returning: true,
            },
          ],
          payment_method: "cash",
        },
      });

      expect(res.statusCode).toBe(201);
      // Signed total: give 150 - return 200 = -50 (we owe the customer)
      expect(res.json().total_amount).toBe(-50);
    } finally {
      await app.close();
    }
  });

  it("computes zero total when give == return", async () => {
    setupReplacementMocks({
      partner: { id: 1, partner_type: "individual" },
      products: [
        { id: 101, selling_price: "200" },
        { id: 102, selling_price: "200" },
      ],
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/orders",
        payload: {
          partner_id: 1,
          is_replacement: true,
          items: [
            {
              product_id: 101,
              quantity: 1,
              unit_price: 200,
              is_returning: false,
            },
            {
              product_id: 102,
              quantity: 1,
              unit_price: 200,
              is_returning: true,
            },
          ],
          // No payment_method needed when total == 0.
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().total_amount).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("handles multi-item totals on both sides", async () => {
    setupReplacementMocks({
      partner: { id: 1, partner_type: "individual" },
      products: [
        { id: 101, selling_price: "100" },
        { id: 102, selling_price: "50" },
      ],
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/orders",
        payload: {
          partner_id: 1,
          is_replacement: true,
          items: [
            {
              product_id: 101,
              quantity: 2,
              unit_price: 100,
              is_returning: false,
            },
            {
              product_id: 102,
              quantity: 3,
              unit_price: 50,
              is_returning: true,
            },
          ],
          payment_method: "cash",
        },
      });

      expect(res.statusCode).toBe(201);
      // Signed total: give 2×100 − return 3×50 = 200 − 150 = 50
      expect(res.json().total_amount).toBe(50);
    } finally {
      await app.close();
    }
  });

  it("rejects replacement for a VAT-registered partner", async () => {
    setupReplacementMocks({
      partner: { id: 1, partner_type: "customer", vat_number: "BG123456789" },
      products: [
        { id: 101, selling_price: "230" },
        { id: 102, selling_price: "200" },
      ],
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/orders",
        payload: {
          partner_id: 1,
          is_replacement: true,
          items: [
            {
              product_id: 101,
              quantity: 1,
              unit_price: 230,
              is_returning: false,
            },
            {
              product_id: 102,
              quantity: 1,
              unit_price: 200,
              is_returning: true,
            },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/ДДС/);
    } finally {
      await app.close();
    }
  });
});
