// Стойности на редове при запис на поръчка — точно закръгляне и чакащи
// редове. Mock-ът отговаря според SQL-а, а не по ред на извикване, за да не
// гние при добавена заявка.
import Fastify, { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setex: vi.fn(async () => "OK"),
    del: vi.fn(async () => 0),
  })),
}));

import { query, transaction } from "../db.js";
import ordersRoutes from "../routes/orders.js";

const mockQuery = vi.mocked(query);
const mockTx = vi.mocked(transaction);

const rows = <T>(list: T[]) => ({ rows: list, rowCount: list.length }) as any;
const flat = (sql: unknown) => String(sql).replace(/\s+/g, " ");

const partner = {
  id: 1,
  name: "ДАР Г.Н. ООД",
  price_group: null,
  price_list_id: null,
};
const product = {
  id: 100,
  name_bg: "Баклавички",
  name_en: "Baklava",
  sku: "D1002",
  selling_price: "6.317",
  purchase_price: "4",
};

/** client.query, който отговаря според текста на заявката. */
function sqlRoutedClient() {
  let insertedId = 9000;
  return vi.fn(async (sql: string, params: any[] = []) => {
    const q = flat(sql);
    if (q.startsWith("UPDATE orders SET total_amount")) return rows([]);
    if (q.includes("UPDATE orders SET") && q.includes("RETURNING"))
      return rows([
        { id: 1, status: "pending", partner_id: 1, invoice_id: null },
      ]);
    if (q.includes("FROM partners")) return rows([partner]);
    if (q.includes("FROM products")) return rows([product]);
    if (q.includes("INSERT INTO order_items"))
      return rows([
        { id: ++insertedId, order_id: params[0], product_id: params[1] },
      ]);
    if (q.includes("SUM(") || q.includes("inventory"))
      return rows([{ total: "100" }]);
    return rows([]);
  });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u-admin", email: "a@b", role: "admin" };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(ordersRoutes, { prefix: "/orders" });
  return app;
}

describe("редакция на поръчка — стойности на редове", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    mockQuery.mockReset();
    mockTx.mockReset();
    mockQuery.mockResolvedValue(
      rows([
        {
          id: 1,
          status: "pending",
          partner_id: 1,
          invoice_id: null,
          updated_at: new Date(),
        },
      ]),
    );
  });
  afterEach(async () => {
    await app?.close();
  });

  it("точна половин стотинка: 1.540 × 19.750 се записва 30.42 (не 30.41)", async () => {
    const client = sqlRoutedClient();
    mockTx.mockImplementation(async (cb: any) => cb({ query: client }));
    app = await buildApp();

    const res = await app.inject({
      method: "PUT",
      url: "/orders/1",
      payload: {
        items: [{ product_id: 100, quantity: 1.54, unit_price: 19.75 }],
      },
    });
    expect(res.statusCode).toBe(200);

    const insert = client.mock.calls.find((c) =>
      flat(c[0]).includes("INSERT INTO order_items"),
    );
    const params = insert![1] as any[];
    expect(params).toContain(30.42);
    expect(params).not.toContain(30.41);
  });

  it("чакащ ред не влиза в total_amount (както при създаване и във фактурата)", async () => {
    const client = sqlRoutedClient();
    mockTx.mockImplementation(async (cb: any) => cb({ query: client }));
    app = await buildApp();

    const res = await app.inject({
      method: "PUT",
      url: "/orders/1",
      payload: {
        items: [
          { product_id: 100, quantity: 2.8, unit_price: 6.317 },
          {
            product_id: 100,
            quantity: 5,
            unit_price: 10,
            line_status: "awaiting",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const totalUpdate = client.mock.calls.find((c) =>
      flat(c[0]).startsWith("UPDATE orders SET total_amount"),
    );
    // Само нормалният ред: 2.8 × 6.317 = 17.69. Преди ставаше 67.69.
    expect((totalUpdate![1] as any[])[0]).toBe(17.69);
  });
});
