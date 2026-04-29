// Integration tests for the below-cost approval guard on POST /orders
// and the admin-only edit guard on PUT /orders/:id introduced by Batch A.
//
// Pattern follows orders-no-batch.test.ts: vi.mock the db module, mock
// transaction() to invoke the callback with a fake client whose `query`
// resolves a pre-staged sequence of rows.
import Fastify, { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setex: vi.fn(async () => "OK"),
    del: vi.fn(async () => 0),
  })),
}));

import { query, transaction } from "../db.js";
import orderRoutes from "../routes/orders.js";

const mockQuery = vi.mocked(query);
const mockTransaction = vi.mocked(transaction);

function rows<T>(list: T[]) {
  return { rows: list } as any;
}

async function buildApp(role: string): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: role === "admin" ? "u-admin" : "u-sales",
      email: role === "admin" ? "admin@mertm.bg" : "sales@mertm.bg",
      role,
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(orderRoutes, { prefix: "/orders" });
  return app;
}

const samplePartner = {
  id: 1,
  name: "Test Partner",
  price_group: null,
  price_list_id: null,
};

// products.purchase_price is 10 → unit_price=5 → effective=5 → below cost
const belowCostProduct = {
  id: 1,
  selling_price: "5",
  group_price: null,
  name_bg: "Скара",
  purchase_price: "10",
};

// products.purchase_price is 5 → unit_price=10 → effective=10 → above cost
const safeProduct = {
  id: 1,
  selling_price: "10",
  group_price: null,
  name_bg: "Скара",
  purchase_price: "5",
};

describe("POST /orders below-cost guard", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it("rejects 400 when below-cost lines and allow_below_cost is false (sales user)", async () => {
    // ordersManagePreHandler.requirePermission(ORDERS_MANAGE) → sales has it
    mockQuery.mockResolvedValueOnce(rows([{ role: "sales", overrides: [] }]));

    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(rows([samplePartner])) // SELECT partners
      .mockResolvedValueOnce(rows([belowCostProduct])) // SELECT products
      .mockResolvedValueOnce(rows([{ total: "5" }])); // validateRequestedStock

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    app = await buildApp("sales");
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        partner_id: 1,
        items: [{ product_id: 1, quantity: 1, unit_price: 5 }],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Below cost not approved");
    expect(body.below_cost_items).toHaveLength(1);
    expect(body.below_cost_items[0]).toMatchObject({
      product_id: 1,
      product_name: "Скара",
      effective_price: 5,
      purchase_price: 10,
      loss_per_unit: 5,
    });
    // Crucially: no INSERT INTO orders happened
    const insertCall = clientQuery.mock.calls.find((c: any[]) =>
      String(c[0]).includes("INSERT INTO orders"),
    );
    expect(insertCall).toBeUndefined();
  });

  it("rejects 403 when allow_below_cost=true but user lacks BELOW_COST_OVERRIDE", async () => {
    // (1) ORDERS_MANAGE check for sales
    mockQuery.mockResolvedValueOnce(rows([{ role: "sales", overrides: [] }]));
    // (2) BELOW_COST_OVERRIDE check for sales — no override
    mockQuery.mockResolvedValueOnce(rows([{ role: "sales", overrides: [] }]));

    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(rows([samplePartner]))
      .mockResolvedValueOnce(rows([belowCostProduct]))
      .mockResolvedValueOnce(rows([{ total: "5" }]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    app = await buildApp("sales");
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        partner_id: 1,
        items: [{ product_id: 1, quantity: 1, unit_price: 5 }],
        allow_below_cost: true,
      },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.required_permission).toBe("orders.below_cost_override");
  });

  it("accepts 201 when allow_below_cost=true and user is admin (writes audit)", async () => {
    // Admin short-circuits ORDERS_MANAGE and BELOW_COST_OVERRIDE — no
    // top-level query() calls.
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(rows([samplePartner]))
      .mockResolvedValueOnce(rows([belowCostProduct]))
      .mockResolvedValueOnce(rows([{ total: "5" }]))
      // INSERT INTO orders RETURNING *
      .mockResolvedValueOnce(
        rows([
          {
            id: 42,
            partner_id: 1,
            status: "pending",
            order_number: 42,
            below_cost_approved_by: "u-admin",
          },
        ]),
      )
      // INSERT INTO order_items RETURNING *
      .mockResolvedValueOnce(
        rows([
          {
            id: 1001,
            order_id: 42,
            product_id: 1,
            quantity: "1",
            unit_price: "5",
            discount_percent: "0",
            total_price: "5",
          },
        ]),
      )
      // UPDATE orders SET total_amount
      .mockResolvedValueOnce(rows([]))
      // INSERT INTO notifications
      .mockResolvedValueOnce(rows([]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    app = await buildApp("admin");
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        partner_id: 1,
        items: [{ product_id: 1, quantity: 1, unit_price: 5 }],
        allow_below_cost: true,
      },
    });

    expect(res.statusCode).toBe(201);
    // The INSERT INTO orders SQL must include the new audit columns
    const insertCall = clientQuery.mock.calls.find((c: any[]) =>
      String(c[0]).includes("INSERT INTO orders"),
    );
    expect(insertCall).toBeDefined();
    expect(String(insertCall![0])).toMatch(/below_cost_approved_by/);
    expect(String(insertCall![0])).toMatch(/below_cost_approved_at/);
    expect(String(insertCall![0])).toMatch(/below_cost_details/);
    // The audit values must be non-null in the bind params
    const params = insertCall![1] as any[];
    expect(params[20]).toBe("u-admin"); // below_cost_approved_by
    expect(params[21]).toBeInstanceOf(Date); // below_cost_approved_at
    expect(typeof params[22]).toBe("string"); // below_cost_details (JSON)
    expect(JSON.parse(params[22] as string)[0]).toMatchObject({
      product_id: 1,
      effective_price: 5,
      purchase_price: 10,
    });
  });

  it("accepts 201 with no audit when no lines are below cost", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(rows([samplePartner]))
      .mockResolvedValueOnce(rows([safeProduct]))
      .mockResolvedValueOnce(rows([{ total: "5" }]))
      .mockResolvedValueOnce(
        rows([
          {
            id: 43,
            partner_id: 1,
            status: "pending",
            order_number: 43,
          },
        ]),
      )
      .mockResolvedValueOnce(
        rows([{ id: 1002, order_id: 43, product_id: 1, total_price: "10" }]),
      )
      .mockResolvedValueOnce(rows([]))
      .mockResolvedValueOnce(rows([]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    app = await buildApp("admin");
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        partner_id: 1,
        items: [{ product_id: 1, quantity: 1, unit_price: 10 }],
      },
    });

    expect(res.statusCode).toBe(201);
    const insertCall = clientQuery.mock.calls.find((c: any[]) =>
      String(c[0]).includes("INSERT INTO orders"),
    );
    const params = insertCall![1] as any[];
    expect(params[20]).toBeNull(); // below_cost_approved_by
    expect(params[21]).toBeNull(); // below_cost_approved_at
    expect(params[22]).toBeNull(); // below_cost_details
  });
});

describe("PUT /orders/:id edit-after-fulfill guard", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it("rejects 403 on PUT for fulfilled order when sales user lacks ORDERS_EDIT_AFTER_FULFILL", async () => {
    // (1) ORDERS_MANAGE check passes for sales
    mockQuery.mockResolvedValueOnce(rows([{ role: "sales", overrides: [] }]));
    // (2) SELECT * FROM orders WHERE id = $1 — returns fulfilled order
    mockQuery.mockResolvedValueOnce(
      rows([{ id: 1, status: "fulfilled", partner_id: 1 }]),
    );
    // (3) hasPermission(ORDERS_EDIT_AFTER_FULFILL) lookup for sales
    mockQuery.mockResolvedValueOnce(rows([{ role: "sales", overrides: [] }]));

    app = await buildApp("sales");
    const res = await app.inject({
      method: "PUT",
      url: "/orders/1",
      payload: { notes: "trying to edit" },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.required_permission).toBe("orders.edit_after_fulfill");
  });

  it("rejects 403 on PUT for invoiced order for non-admin", async () => {
    mockQuery.mockResolvedValueOnce(rows([{ role: "sales", overrides: [] }]));
    mockQuery.mockResolvedValueOnce(
      rows([{ id: 1, status: "invoiced", partner_id: 1 }]),
    );
    mockQuery.mockResolvedValueOnce(rows([{ role: "sales", overrides: [] }]));

    app = await buildApp("sales");
    const res = await app.inject({
      method: "PUT",
      url: "/orders/1",
      payload: { notes: "edit attempt" },
    });

    expect(res.statusCode).toBe(403);
  });

  it("admin can PUT a fulfilled order (gate short-circuits)", async () => {
    // Admin: ORDERS_MANAGE skips DB. SELECT * FROM orders is the only
    // top-level query before the transaction.
    mockQuery.mockResolvedValueOnce(
      rows([{ id: 1, status: "fulfilled", partner_id: 1, invoice_id: null }]),
    );

    // No items in the body → transaction does only the field UPDATE.
    const clientQuery = vi.fn().mockResolvedValueOnce(
      rows([
        {
          id: 1,
          status: "fulfilled",
          notes: "edited by admin",
          partner_id: 1,
          invoice_id: null,
        },
      ]),
    );

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    app = await buildApp("admin");
    const res = await app.inject({
      method: "PUT",
      url: "/orders/1",
      payload: { notes: "edited by admin" },
    });

    expect(res.statusCode).toBe(200);
  });

  it("GET /orders?below_cost_only=true filters to approved-below-cost orders", async () => {
    // Data SELECT
    mockQuery.mockResolvedValueOnce(rows([{ id: 1, partner_name: "X" }]));
    // Count SELECT
    mockQuery.mockResolvedValueOnce(rows([{ total: "1" }]));

    app = await buildApp("admin");
    const res = await app.inject({
      method: "GET",
      url: "/orders?below_cost_only=true",
    });

    expect(res.statusCode).toBe(200);
    // Both SQL strings must contain the WHERE filter.
    const dataCall = mockQuery.mock.calls[0]!;
    expect(String(dataCall[0])).toMatch(/below_cost_approved_at IS NOT NULL/);
    const countCall = mockQuery.mock.calls[1]!;
    expect(String(countCall[0])).toMatch(/below_cost_approved_at IS NOT NULL/);
  });

  it("GET /orders without below_cost_only returns all orders (no filter)", async () => {
    mockQuery.mockResolvedValueOnce(rows([{ id: 1 }, { id: 2 }]));
    mockQuery.mockResolvedValueOnce(rows([{ total: "2" }]));

    app = await buildApp("admin");
    const res = await app.inject({ method: "GET", url: "/orders" });

    expect(res.statusCode).toBe(200);
    const dataCall = mockQuery.mock.calls[0]!;
    expect(String(dataCall[0])).not.toMatch(
      /below_cost_approved_at IS NOT NULL/,
    );
  });

  it("non-admin can still PUT a pending order", async () => {
    mockQuery.mockResolvedValueOnce(rows([{ role: "sales", overrides: [] }]));
    mockQuery.mockResolvedValueOnce(
      rows([{ id: 1, status: "pending", partner_id: 1, invoice_id: null }]),
    );

    const clientQuery = vi.fn().mockResolvedValueOnce(
      rows([
        {
          id: 1,
          status: "pending",
          notes: "edited",
          partner_id: 1,
          invoice_id: null,
        },
      ]),
    );

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    app = await buildApp("sales");
    const res = await app.inject({
      method: "PUT",
      url: "/orders/1",
      payload: { notes: "edited" },
    });

    expect(res.statusCode).toBe(200);
  });
});
