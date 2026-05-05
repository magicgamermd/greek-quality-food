// Purchase Orders (Заявки) — CRUD + status transitions + convert-to-incoming.
//
// Pattern matches orders-line-status.test.ts: vi.mock('../db.js') +
// auth injected via onRequest hook. Permission check is bypassed by
// stubbing it for the admin role (admin always passes hasPermission).

import Fastify, { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(async () => ({ rows: [] })),
  transaction: vi.fn(),
}));

vi.mock("../services/purchase-order-pdf.js", () => ({
  generatePurchaseOrderPdf: vi.fn(async () => Buffer.from("%PDF-stub")),
}));

import { query, transaction } from "../db.js";
import purchaseOrderRoutes from "../routes/purchase-orders.js";

const mockQuery = vi.mocked(query);
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
  await app.register(purchaseOrderRoutes, { prefix: "/purchase-orders" });
  return app;
}

describe("Purchase Orders — CRUD", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET / returns list with formatted ZA-XXXXX numbers", async () => {
    mockQuery.mockResolvedValueOnce(
      rows([
        {
          id: 5,
          supplier_id: 1,
          supplier_name: "ChinaSupply Co",
          status: "draft",
          item_count: 3,
          total_quantity: 50,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]),
    );
    const res = await app.inject({ method: "GET", url: "/purchase-orders" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].order_number).toBe("ZA-00005");
  });

  it("POST / creates draft + items in a transaction, returns 201 with full order", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) => {
      const client = {
        query: vi
          .fn()
          // INSERT INTO purchase_orders
          .mockResolvedValueOnce(rows([{ id: 7, supplier_id: 2 }]))
          // INSERT items × 2
          .mockResolvedValueOnce(rows([]))
          .mockResolvedValueOnce(rows([])),
      };
      return cb(client as any);
    });
    // loadOrderWithItems — order then items
    mockQuery
      .mockResolvedValueOnce(
        rows([
          {
            id: 7,
            supplier_id: 2,
            status: "draft",
            supplier_name: "S",
          },
        ]),
      )
      .mockResolvedValueOnce(rows([{ id: 1 }, { id: 2 }]));

    const res = await app.inject({
      method: "POST",
      url: "/purchase-orders",
      payload: {
        supplier_id: 2,
        status: "draft", // ← explicit draft for this legacy test
        items: [
          { product_id: 10, quantity: 5 },
          { product_id: 11, quantity: 3 },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBe(7);
    expect(body.order_number).toBe("ZA-00007");
  });

  it("POST / rejects empty items (400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/purchase-orders",
      payload: { supplier_id: 1, items: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /:id/send transitions draft → sent", async () => {
    mockQuery
      .mockResolvedValueOnce(rows([{ id: 3 }])) // UPDATE returns row
      .mockResolvedValueOnce(rows([{ id: 3, status: "sent" }])) // load order
      .mockResolvedValueOnce(rows([])); // items

    const res = await app.inject({
      method: "POST",
      url: "/purchase-orders/3/send",
    });
    expect(res.statusCode).toBe(200);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/status\s*=\s*'sent'/);
    expect(sql).toMatch(/status\s*=\s*'draft'/);
  });

  it("POST /:id/send rejects when order not in draft (no row returned)", async () => {
    mockQuery.mockResolvedValueOnce(rows([])); // 0 rows updated
    const res = await app.inject({
      method: "POST",
      url: "/purchase-orders/9/send",
    });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE /:id allows draft, blocks non-draft", async () => {
    // Draft → 204
    mockQuery
      .mockResolvedValueOnce(rows([{ status: "draft" }]))
      .mockResolvedValueOnce(rows([]));
    let res = await app.inject({
      method: "DELETE",
      url: "/purchase-orders/4",
    });
    expect(res.statusCode).toBe(204);

    // Sent → 400
    mockQuery.mockResolvedValueOnce(rows([{ status: "sent" }]));
    res = await app.inject({ method: "DELETE", url: "/purchase-orders/5" });
    expect(res.statusCode).toBe(400);
  });

  it("POST /:id/convert-to-incoming creates incoming_goods + flips status", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) => {
      const client = {
        query: vi
          .fn()
          // SELECT FOR UPDATE
          .mockResolvedValueOnce(
            rows([{ id: 8, supplier_id: 2, status: "sent" }]),
          )
          // SELECT items
          .mockResolvedValueOnce(
            rows([
              { product_id: 10, quantity: 5 },
              { product_id: 11, quantity: 2 },
            ]),
          )
          // INSERT INTO incoming_goods
          .mockResolvedValueOnce(rows([{ id: 99 }]))
          // INSERT incoming_items × 2
          .mockResolvedValueOnce(rows([]))
          .mockResolvedValueOnce(rows([]))
          // UPDATE purchase_orders
          .mockResolvedValueOnce(rows([])),
      };
      return cb(client as any);
    });
    // loadOrderWithItems
    mockQuery
      .mockResolvedValueOnce(
        rows([{ id: 8, status: "received", supplier_name: "S" }]),
      )
      .mockResolvedValueOnce(rows([]));

    const res = await app.inject({
      method: "POST",
      url: "/purchase-orders/8/convert-to-incoming",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.incoming_goods_id).toBe(99);
  });

  it("POST /:id/convert-to-incoming refuses when status='draft'", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) => {
      const client = {
        query: vi
          .fn()
          .mockResolvedValueOnce(
            rows([{ id: 8, supplier_id: 2, status: "draft" }]),
          ),
      };
      return cb(client as any);
    });
    const res = await app.inject({
      method: "POST",
      url: "/purchase-orders/8/convert-to-incoming",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Изпратена/);
  });

  it("POST /merge folds source orders into oldest, sums duplicate products", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) => {
      const client = {
        query: vi
          .fn()
          // SELECT FOR UPDATE — 2 drafts, same supplier
          .mockResolvedValueOnce(
            rows([
              {
                id: 7,
                supplier_id: 2,
                status: "draft",
                notes: "first",
                expected_delivery_date: "2026-06-01",
                created_at: "2026-05-01T10:00:00Z",
              },
              {
                id: 9,
                supplier_id: 2,
                status: "draft",
                notes: "second",
                expected_delivery_date: null,
                created_at: "2026-05-02T10:00:00Z",
              },
            ]),
          )
          // SELECT items from source orders (id=9): same product as master + new
          .mockResolvedValueOnce(
            rows([
              { product_id: 10, quantity: "3", notes: null },
              { product_id: 11, quantity: "2", notes: null },
            ]),
          )
          // SELECT master items (id=7)
          .mockResolvedValueOnce(
            rows([{ id: 100, product_id: 10, quantity: "5" }]),
          )
          // UPDATE existing master row (product 10: 5+3=8)
          .mockResolvedValueOnce(rows([]))
          // INSERT new row (product 11)
          .mockResolvedValueOnce(rows([]))
          // UPDATE master notes/expected
          .mockResolvedValueOnce(rows([]))
          // DELETE source orders
          .mockResolvedValueOnce(rows([])),
      };
      return cb(client as any);
    });
    // loadOrderWithItems for the master after merge
    mockQuery
      .mockResolvedValueOnce(
        rows([{ id: 7, supplier_id: 2, status: "draft", supplier_name: "S" }]),
      )
      .mockResolvedValueOnce(rows([]));

    const res = await app.inject({
      method: "POST",
      url: "/purchase-orders/merge",
      payload: { ids: [7, 9] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(7);
  });

  it("POST /merge rejects when suppliers differ", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) => {
      const client = {
        query: vi.fn().mockResolvedValueOnce(
          rows([
            { id: 1, supplier_id: 2, status: "draft", created_at: new Date() },
            { id: 2, supplier_id: 5, status: "draft", created_at: new Date() },
          ]),
        ),
      };
      return cb(client as any);
    });
    const res = await app.inject({
      method: "POST",
      url: "/purchase-orders/merge",
      payload: { ids: [1, 2] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/доставчик/);
  });

  it("POST /merge rejects when any order is not in draft", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) => {
      const client = {
        query: vi.fn().mockResolvedValueOnce(
          rows([
            { id: 1, supplier_id: 2, status: "draft", created_at: new Date() },
            { id: 2, supplier_id: 2, status: "sent", created_at: new Date() },
          ]),
        ),
      };
      return cb(client as any);
    });
    const res = await app.inject({
      method: "POST",
      url: "/purchase-orders/merge",
      payload: { ids: [1, 2] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/бележки и чернови/);
  });

  it("POST /merge rejects empty ids", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/purchase-orders/merge",
      payload: { ids: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /merge accepts a single note and converts it to a draft order", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) => {
      const client = {
        query: vi
          .fn()
          // SELECT FOR UPDATE — 1 note
          .mockResolvedValueOnce(
            rows([
              {
                id: 7,
                supplier_id: 2,
                status: "note",
                notes: null,
                label: "Кухня",
                expected_delivery_date: null,
                created_at: "2026-05-01T10:00:00Z",
              },
            ]),
          )
          // SELECT items from sources (none — single source is the master)
          .mockResolvedValueOnce(rows([]))
          // SELECT master items
          .mockResolvedValueOnce(
            rows([{ id: 100, product_id: 10, quantity: "5" }]),
          )
          // UPDATE master row → status='draft', merged_from_count=1
          .mockResolvedValueOnce(rows([])),
      };
      return cb(client as any);
    });
    mockQuery
      .mockResolvedValueOnce(
        rows([{ id: 7, supplier_id: 2, status: "draft", supplier_name: "S" }]),
      )
      .mockResolvedValueOnce(rows([]));

    const res = await app.inject({
      method: "POST",
      url: "/purchase-orders/merge",
      payload: { ids: [7] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(7);
  });

  it("POST /merge accepts notes (not just drafts) for multi-source", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) => {
      const client = {
        query: vi
          .fn()
          .mockResolvedValueOnce(
            rows([
              {
                id: 7,
                supplier_id: 2,
                status: "note",
                notes: null,
                label: null,
                expected_delivery_date: null,
                created_at: "2026-05-01T10:00:00Z",
              },
              {
                id: 9,
                supplier_id: 2,
                status: "note",
                notes: null,
                label: null,
                expected_delivery_date: null,
                created_at: "2026-05-02T10:00:00Z",
              },
            ]),
          )
          .mockResolvedValueOnce(
            rows([{ product_id: 11, quantity: "2", notes: null }]),
          )
          .mockResolvedValueOnce(
            rows([{ id: 100, product_id: 10, quantity: "5" }]),
          )
          .mockResolvedValueOnce(rows([])) // INSERT new (product 11)
          .mockResolvedValueOnce(rows([])) // UPDATE master (status=draft, merged_from_count=2)
          .mockResolvedValueOnce(rows([])), // DELETE source
      };
      return cb(client as any);
    });
    mockQuery
      .mockResolvedValueOnce(
        rows([{ id: 7, status: "draft", supplier_name: "S" }]),
      )
      .mockResolvedValueOnce(rows([]));

    const res = await app.inject({
      method: "POST",
      url: "/purchase-orders/merge",
      payload: { ids: [7, 9] },
    });
    expect(res.statusCode).toBe(200);
  });

  it("POST /merge rejects if any source is not a note or draft", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) => {
      const client = {
        query: vi.fn().mockResolvedValueOnce(
          rows([
            { id: 1, supplier_id: 2, status: "note", created_at: new Date() },
            { id: 2, supplier_id: 2, status: "sent", created_at: new Date() },
          ]),
        ),
      };
      return cb(client as any);
    });
    const res = await app.inject({
      method: "POST",
      url: "/purchase-orders/merge",
      payload: { ids: [1, 2] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /?period=this-week filters by created_at >= start of week", async () => {
    mockQuery.mockResolvedValueOnce(rows([]));
    const res = await app.inject({
      method: "GET",
      url: "/purchase-orders?period=this-week",
    });
    expect(res.statusCode).toBe(200);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/created_at\s*>=\s*\$\d/);
  });

  it("GET /?period=today applies a tighter created_at filter", async () => {
    mockQuery.mockResolvedValueOnce(rows([]));
    await app.inject({
      method: "GET",
      url: "/purchase-orders?period=today",
    });
    const params = mockQuery.mock.calls[0][1] as unknown[];
    // Today's 00:00:00 should be the bound — params include a Date or ISO string.
    expect(params.length).toBeGreaterThan(0);
  });

  it("GET /?period=all applies no created_at filter", async () => {
    mockQuery.mockResolvedValueOnce(rows([]));
    await app.inject({
      method: "GET",
      url: "/purchase-orders?period=all",
    });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).not.toMatch(/created_at\s*>=/);
  });

  it("GET /?search=hendi adds ILIKE on supplier name + product name + sku", async () => {
    mockQuery.mockResolvedValueOnce(rows([]));
    await app.inject({
      method: "GET",
      url: "/purchase-orders?search=hendi",
    });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/ILIKE/);
    // Search should match supplier name OR an item product
    expect(sql).toMatch(/s\.name\s+ILIKE/);
    expect(sql).toMatch(/EXISTS/); // subquery on items
  });

  it("GET /:id/pdf returns application/pdf", async () => {
    mockQuery
      .mockResolvedValueOnce(
        rows([
          {
            id: 12,
            supplier_id: 1,
            status: "sent",
            supplier_name: "S",
            created_at: new Date(),
          },
        ]),
      )
      .mockResolvedValueOnce(rows([]));

    const res = await app.inject({
      method: "GET",
      url: "/purchase-orders/12/pdf",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toMatch(/ZA-00012\.pdf/);
  });

  it("POST / defaults to status='note' when not provided", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) => {
      const client = {
        query: vi.fn().mockResolvedValueOnce(rows([{ id: 7 }])),
      };
      return cb(client as any);
    });
    mockQuery
      .mockResolvedValueOnce(
        rows([{ id: 7, status: "note", supplier_name: "S" }]),
      )
      .mockResolvedValueOnce(rows([]));

    const res = await app.inject({
      method: "POST",
      url: "/purchase-orders",
      payload: {
        supplier_id: 2,
        items: [{ product_id: 10, quantity: 5 }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("note");
  });

  it("POST / accepts an explicit status='draft' for backwards compat", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) => {
      const client = {
        query: vi.fn().mockResolvedValueOnce(rows([{ id: 8 }])),
      };
      return cb(client as any);
    });
    mockQuery
      .mockResolvedValueOnce(
        rows([{ id: 8, status: "draft", supplier_name: "S" }]),
      )
      .mockResolvedValueOnce(rows([]));

    const res = await app.inject({
      method: "POST",
      url: "/purchase-orders",
      payload: {
        supplier_id: 2,
        status: "draft",
        items: [{ product_id: 10, quantity: 5 }],
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("POST / accepts a label for notes", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) => {
      const client = {
        query: vi
          .fn()
          .mockResolvedValueOnce(rows([{ id: 9, label: "Кухня в Хемус" }])),
      };
      return cb(client as any);
    });
    mockQuery
      .mockResolvedValueOnce(
        rows([
          { id: 9, status: "note", label: "Кухня в Хемус", supplier_name: "S" },
        ]),
      )
      .mockResolvedValueOnce(rows([]));

    const res = await app.inject({
      method: "POST",
      url: "/purchase-orders",
      payload: {
        supplier_id: 2,
        label: "Кухня в Хемус",
        items: [{ product_id: 10, quantity: 5 }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().label).toBe("Кухня в Хемус");
  });

  it("PATCH /:id allows editing a note (status='note')", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) => {
      const client = {
        query: vi
          .fn()
          // SELECT FOR UPDATE
          .mockResolvedValueOnce(rows([{ id: 5, status: "note" }]))
          // UPDATE purchase_orders
          .mockResolvedValueOnce(rows([]))
          // DELETE items + INSERT items
          .mockResolvedValueOnce(rows([]))
          .mockResolvedValueOnce(rows([])),
      };
      return cb(client as any);
    });
    mockQuery
      .mockResolvedValueOnce(
        rows([{ id: 5, status: "note", supplier_name: "S" }]),
      )
      .mockResolvedValueOnce(rows([]));

    const res = await app.inject({
      method: "PATCH",
      url: "/purchase-orders/5",
      payload: {
        label: "Updated label",
        items: [{ product_id: 10, quantity: 3 }],
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("PATCH /:id rejects sent orders (unchanged behavior)", async () => {
    mockTransaction.mockImplementationOnce(async (cb: any) => {
      const client = {
        query: vi.fn().mockResolvedValueOnce(rows([{ id: 5, status: "sent" }])),
      };
      return cb(client as any);
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/purchase-orders/5",
      payload: { label: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE /:id allows note deletion", async () => {
    mockQuery
      .mockResolvedValueOnce(rows([{ status: "note" }]))
      .mockResolvedValueOnce(rows([]));
    const res = await app.inject({
      method: "DELETE",
      url: "/purchase-orders/4",
    });
    expect(res.statusCode).toBe(204);
  });
});
