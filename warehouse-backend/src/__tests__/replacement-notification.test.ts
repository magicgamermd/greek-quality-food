import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import orderRoutes from "../routes/orders.js";

// Mirrors replacement-payment.test.ts: drive POST /orders via app.inject
// and inspect the captured INSERT INTO notifications calls.
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

function setupMocks(opts: {
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
      if (text.includes("INSERT INTO payments")) return rows([{ id: 555 }]);
      return rows([]);
    });

  mockTransaction.mockImplementation(async (callback: any) =>
    callback({ query: clientQuery }),
  );

  return clientQuery;
}

function findReplacementNotificationInsert(
  clientQuery: ReturnType<typeof vi.fn>,
) {
  return clientQuery.mock.calls.find((call: any[]) => {
    const text = String(call[0]);
    return (
      text.includes("INSERT INTO notifications") &&
      text.includes("replacement_ready_for_packaging")
    );
  });
}

describe("POST /orders — replacement notification", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("emits replacement_ready_for_packaging notification when is_replacement=true", async () => {
    const clientQuery = setupMocks({
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

      const notifCall = findReplacementNotificationInsert(clientQuery);
      expect(notifCall).toBeDefined();

      const params = notifCall![1] as any[];
      // Find the JSON-serialized payload param.
      const jsonParam = params.find(
        (p: any) =>
          typeof p === "string" && p.startsWith("{") && p.includes("order_id"),
      );
      expect(jsonParam).toBeDefined();
      const payload = JSON.parse(jsonParam as string);
      expect(payload).toMatchObject({
        order_id: 9000,
        is_replacement: true,
      });
    } finally {
      await app.close();
    }
  });

  it("does NOT emit replacement notification for normal orders", async () => {
    const clientQuery = setupMocks({
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
          items: [
            {
              product_id: 101,
              quantity: 2,
              unit_price: 100,
            },
          ],
        },
      });
      expect(res.statusCode).toBe(201);

      const notifCall = findReplacementNotificationInsert(clientQuery);
      expect(notifCall).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
