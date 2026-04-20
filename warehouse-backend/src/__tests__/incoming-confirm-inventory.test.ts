import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import incomingRoutes from "../routes/incoming.js";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query, transaction } from "../db.js";

const mockQuery = vi.mocked(query);
const mockTransaction = vi.mocked(transaction);

function resultRows<T>(rows: T[]) {
  return { rows } as any;
}

async function buildAppWithRole(role: "admin" | "warehouse") {
  const app = Fastify();

  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-warehouse",
      email: "warehouse@test.local",
      role,
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });

  await app.register(incomingRoutes, { prefix: "/incoming" });
  return app;
}

describe("incoming confirm inventory propagation", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("propagates confirmed incoming quantities into inventory (batch-free)", async () => {
    // MERT-M: no batch logic. Inventory upsert uses the partial unique
    // index `inventory_product_warehouse_nobatch_uidx` keyed on
    // (product_id, warehouse_id) WHERE batch_id IS NULL. No
    // `UPDATE batches` step any more, and incoming_items.batch_id is
    // always NULL.
    const clientQuery = vi
      .fn()
      // 0: atomic UPDATE incoming_goods SET status='confirmed' RETURNING *
      .mockResolvedValueOnce(
        resultRows([{ id: 88, status: "pending", invoice_number: "INV-88" }]),
      )
      // 1: SELECT * FROM incoming_items
      .mockResolvedValueOnce(
        resultRows([
          {
            id: 1,
            product_id: 501,
            batch_id: null,
            quantity: 5,
            unit_price: 8.5,
            selling_price: 11.4,
          },
          {
            id: 2,
            product_id: 902,
            batch_id: null,
            quantity: 2,
            unit_price: 12.2,
          },
        ]),
      )
      // 2..6: per-item INSERT inventory + UPDATE products, then the
      // final INSERT notifications.
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(resultRows([]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildAppWithRole("warehouse");
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/incoming/88/confirm",
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        message: "Stock confirmed and added to inventory",
        items_count: 2,
      });

      //   0: UPDATE incoming_goods SET status='confirmed' ... RETURNING *
      //   1: SELECT * FROM incoming_items WHERE incoming_goods_id = $1
      //   2: INSERT INTO inventory (product 501, qty 5) — partial-index upsert
      //   3: UPDATE products SET purchase_price = 8.5 WHERE id = 501
      //   4: INSERT INTO inventory (product 902, qty 2)
      //   5: UPDATE products SET purchase_price = 12.2 WHERE id = 902
      //   6: INSERT INTO notifications
      expect(clientQuery).toHaveBeenCalledTimes(7);

      expect(String(clientQuery.mock.calls[0][0])).toContain(
        "UPDATE incoming_goods",
      );
      expect(String(clientQuery.mock.calls[0][0])).toContain(
        "status = 'pending'",
      );
      expect(clientQuery.mock.calls[0][1]).toEqual(["88"]);

      expect(String(clientQuery.mock.calls[1][0])).toContain(
        "FROM incoming_items",
      );

      // Item 1 → product 501, partial-index conflict target
      const invSql1 = String(clientQuery.mock.calls[2][0]);
      expect(invSql1).toContain("INSERT INTO inventory");
      expect(invSql1).toContain("ON CONFLICT (product_id, warehouse_id)");
      expect(invSql1).toContain("WHERE batch_id IS NULL");
      // Args: [product_id, warehouse_id=1, quantity] — no batch_id param.
      expect(clientQuery.mock.calls[2][1]).toEqual([501, 1, 5]);

      // No UPDATE batches between inventory and products — the next call
      // is the product-price update.
      expect(String(clientQuery.mock.calls[3][0])).toContain(
        "UPDATE products SET purchase_price = $1",
      );
      expect(clientQuery.mock.calls[3][1]).toEqual([8.5, 501]);

      // Item 2 → product 902 — same pattern, no batch step.
      expect(String(clientQuery.mock.calls[4][0])).toContain(
        "INSERT INTO inventory",
      );
      expect(clientQuery.mock.calls[4][1]).toEqual([902, 1, 2]);

      expect(String(clientQuery.mock.calls[5][0])).toContain(
        "UPDATE products SET purchase_price = $1",
      );
      expect(clientQuery.mock.calls[5][1]).toEqual([12.2, 902]);

      expect(String(clientQuery.mock.calls[6][0])).toContain(
        "INSERT INTO notifications",
      );
      expect(clientQuery.mock.calls[6][1]).toEqual([
        "Incoming goods #88 confirmed. 2 items added to stock.",
      ]);

      // Also guard: no UPDATE batches anywhere in the confirm flow.
      const batchUpdates = clientQuery.mock.calls.filter((call: any[]) =>
        String(call[0]).includes("UPDATE batches"),
      );
      expect(batchUpdates).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("rejects a second confirm attempt once the delivery is already confirmed", async () => {
    // Route uses an atomic UPDATE WHERE status='pending' RETURNING * first.
    // An already-confirmed row fails the WHERE → 0 rows returned. The
    // fallback SELECT then reports the real current status so the route
    // can throw a 400 with that status in the message.
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(resultRows([])) // UPDATE matched 0 rows (not pending)
      .mockResolvedValueOnce(resultRows([{ status: "confirmed" }])); // status probe

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildAppWithRole("warehouse");
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/incoming/89/confirm",
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain(
        "Cannot confirm: status is confirmed",
      );
      expect(clientQuery).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("returns confirmed delivery details without batch/expiry metadata", async () => {
    // MERT-M: no batches JOIN in GET /incoming/:id. The response carries
    // product + incoming_item columns only.
    mockQuery
      .mockResolvedValueOnce(
        resultRows([
          {
            id: 90,
            supplier_id: 3,
            supplier_name: "Demo Supplier",
            invoice_number: "INV-90",
            status: "confirmed",
          },
        ]),
      )
      .mockResolvedValueOnce(
        resultRows([
          {
            id: 11,
            incoming_goods_id: 90,
            product_id: 501,
            quantity: 5,
            unit_price: 8.5,
          },
        ]),
      );

    const app = await buildAppWithRole("warehouse");
    try {
      const res = await app.inject({
        method: "GET",
        url: "/incoming/90",
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        id: 90,
        status: "confirmed",
        items: [{ id: 11, product_id: 501, quantity: 5 }],
      });
      expect(body.items[0]).not.toHaveProperty("batch_number");
      expect(body.items[0]).not.toHaveProperty("expiry_date");

      // And guard the SQL — no batches JOIN.
      const itemsSql = String(mockQuery.mock.calls[1][0]);
      expect(itemsSql).not.toMatch(/JOIN\s+batches\b/i);
      expect(itemsSql).not.toMatch(/\bb\.batch_number\b/);
      expect(itemsSql).not.toMatch(/\bb\.expiry_date\b/);
    } finally {
      await app.close();
    }
  });
});
