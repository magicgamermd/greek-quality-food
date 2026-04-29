// Integration tests for the order_items product-name snapshot (Batch B).
//
// Three scenarios for the WRITE path (this file):
//   1. POST /orders writes snapshot from current products row.
//   2. PUT /orders/:id with new line writes snapshot from CURRENT product
//      values (not the original order's date).
//   3. Editing qty does not modify the snapshot (DELETE+re-INSERT path
//      always re-snapshots, but the test guards the SQL doesn't carry the
//      snapshot column in any UPDATE statement).
//
// Read-path tests live in this same file under a second describe block
// added by Task 9 (snapshot wins over current product name after rename).
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

function rows<T>(list: T[]) {
  return { rows: list } as any;
}

async function buildApp(role = "admin"): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = {
      id: role === "admin" ? "u-admin" : "u-sales",
      email: "x@y",
      role,
    };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(ordersRoutes, { prefix: "/orders" });
  return app;
}

const partner = {
  id: 1,
  name: "Test Partner",
  price_group: null,
  price_list_id: null,
};

describe("order_items snapshot — write path", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    mockQuery.mockReset();
    mockTx.mockReset();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it("POST /orders writes name_bg/name_en/sku snapshot from current products", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(rows([partner]))
      .mockResolvedValueOnce(
        rows([
          {
            id: 100,
            selling_price: "20",
            group_price: null,
            name_bg: "СЕГА Скара",
            name_en: "NOW Grill",
            sku: "GR-100",
            purchase_price: "10",
          },
        ]),
      )
      .mockResolvedValueOnce(rows([{ total: "5" }]))
      .mockResolvedValueOnce(
        rows([{ id: 42, partner_id: 1, status: "pending", order_number: 42 }]),
      )
      // INSERT INTO order_items RETURNING *
      .mockResolvedValueOnce(
        rows([
          {
            id: 1001,
            order_id: 42,
            product_id: 100,
            name_bg_snapshot: "СЕГА Скара",
            name_en_snapshot: "NOW Grill",
            sku_snapshot: "GR-100",
          },
        ]),
      )
      .mockResolvedValueOnce(rows([])) // UPDATE total_amount
      .mockResolvedValueOnce(rows([])); // INSERT notification

    mockTx.mockImplementation(async (cb: any) => cb({ query: clientQuery }));

    app = await buildApp("admin");
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        partner_id: 1,
        items: [{ product_id: 100, quantity: 1, unit_price: 20 }],
      },
    });

    expect(res.statusCode).toBe(201);

    const insertCall = clientQuery.mock.calls.find((c: any[]) =>
      String(c[0]).includes("INSERT INTO order_items"),
    );
    expect(insertCall).toBeDefined();
    const sql = String(insertCall![0]);
    // SQL must mention all three snapshot columns
    expect(sql).toMatch(/name_bg_snapshot/);
    expect(sql).toMatch(/name_en_snapshot/);
    expect(sql).toMatch(/sku_snapshot/);
    // Bind values must carry the current product's strings
    const params = insertCall![1] as any[];
    expect(params).toContain("СЕГА Скара");
    expect(params).toContain("NOW Grill");
    expect(params).toContain("GR-100");
  });

  it("PUT /orders/:id rebuilds order_items with snapshot from CURRENT products", async () => {
    // Top-level pre-flight queries (auth → SELECT order)
    mockQuery.mockResolvedValueOnce(
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

    const clientQuery = vi
      .fn()
      // 1. UPDATE orders SET ... RETURNING *
      .mockResolvedValueOnce(
        rows([{ id: 1, status: "pending", partner_id: 1, invoice_id: null }]),
      )
      // 2. SELECT * FROM partners
      .mockResolvedValueOnce(rows([partner]))
      // 3. SELECT id, name_bg, name_en, sku, selling_price, purchase_price FROM products
      .mockResolvedValueOnce(
        rows([
          {
            id: 100,
            name_bg: "RENAMED скара",
            name_en: "RENAMED grill",
            sku: "GR-100",
            selling_price: "20",
            purchase_price: "10",
          },
        ]),
      )
      // 4. DELETE FROM order_items WHERE order_id = $1
      .mockResolvedValueOnce(rows([]))
      // 5. validateRequestedStock
      .mockResolvedValueOnce(rows([{ total: "5" }]))
      // 6. INSERT INTO order_items RETURNING *
      .mockResolvedValueOnce(
        rows([
          {
            id: 9001,
            order_id: 1,
            product_id: 100,
            name_bg_snapshot: "RENAMED скара",
          },
        ]),
      )
      // 7. UPDATE orders SET total_amount
      .mockResolvedValueOnce(rows([]))
      // 8. INSERT notification
      .mockResolvedValueOnce(rows([]));

    mockTx.mockImplementation(async (cb: any) => cb({ query: clientQuery }));

    app = await buildApp("admin");
    const res = await app.inject({
      method: "PUT",
      url: "/orders/1",
      payload: {
        items: [{ product_id: 100, quantity: 1, unit_price: 20 }],
      },
    });

    expect(res.statusCode).toBe(200);

    const insertCall = clientQuery.mock.calls.find((c: any[]) =>
      String(c[0]).includes("INSERT INTO order_items"),
    );
    expect(insertCall).toBeDefined();
    expect(String(insertCall![0])).toMatch(/name_bg_snapshot/);
    const params = insertCall![1] as any[];
    expect(params).toContain("RENAMED скара");
    expect(params).toContain("RENAMED grill");
  });

  it("PUT /orders/:id field-only edit does not touch snapshot in any UPDATE", async () => {
    // Top-level: SELECT order
    mockQuery.mockResolvedValueOnce(
      rows([
        {
          id: 1,
          status: "pending",
          partner_id: 1,
          invoice_id: null,
        },
      ]),
    );

    const clientQuery = vi
      .fn()
      // UPDATE orders SET ... RETURNING * (notes change only)
      .mockResolvedValueOnce(
        rows([
          {
            id: 1,
            status: "pending",
            partner_id: 1,
            notes: "edited",
            invoice_id: null,
          },
        ]),
      );

    mockTx.mockImplementation(async (cb: any) => cb({ query: clientQuery }));

    app = await buildApp("admin");
    const res = await app.inject({
      method: "PUT",
      url: "/orders/1",
      payload: { notes: "edited" },
    });

    expect(res.statusCode).toBe(200);

    // Crucial guard: no UPDATE statement must touch the snapshot columns.
    for (const call of clientQuery.mock.calls) {
      const sql = String(call[0]);
      if (sql.startsWith("UPDATE")) {
        expect(sql).not.toMatch(/name_bg_snapshot/);
        expect(sql).not.toMatch(/name_en_snapshot/);
        expect(sql).not.toMatch(/sku_snapshot/);
      }
    }
  });
});

describe("order_items snapshot — read path", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    mockQuery.mockReset();
    mockTx.mockReset();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it("GET /orders/:id returns snapshot name even when product was renamed", async () => {
    // Top-level: SELECT order then SELECT items.
    mockQuery
      // 1. SELECT * FROM orders ... (drawer detail)
      .mockResolvedValueOnce(
        rows([
          {
            id: 1,
            partner_id: 1,
            status: "fulfilled",
            partner_name: "P",
            below_cost_approved_by_name: null,
          },
        ]),
      )
      // 2. SELECT oi.*, oi.name_bg_snapshot AS name_bg ... (items)
      .mockResolvedValueOnce(
        rows([
          {
            id: 1001,
            product_id: 100,
            quantity: "1",
            unit_price: "20",
            name_bg: "OLD скара (snapshot)",
            name_en: "OLD grill",
            sku: "GR-100",
            unit: "бр.",
          },
        ]),
      );

    app = await buildApp("admin");
    const res = await app.inject({ method: "GET", url: "/orders/1" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // The drawer payload's items array carries the snapshot name as
    // name_bg, regardless of what the live products row says today.
    expect(body.items).toHaveLength(1);
    expect(body.items[0].name_bg).toBe("OLD скара (snapshot)");
    expect(body.items[0].sku).toBe("GR-100");

    // Crucially: the SQL the route ran must read from the snapshot
    // column, not from products.name_bg.
    const itemsCall = mockQuery.mock.calls.find((c: any[]) =>
      String(c[0]).includes("FROM order_items"),
    );
    expect(itemsCall).toBeDefined();
    expect(String(itemsCall![0])).toMatch(/oi\.name_bg_snapshot/);
    expect(String(itemsCall![0])).not.toMatch(/COALESCE\(pr\.name_bg/);
  });
});
