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

  it("propagates confirmed incoming quantities into inventory while preserving batch linkage", async () => {
    const clientQuery = vi
      .fn()
      // Call 0: atomic UPDATE incoming_goods SET status='confirmed' RETURNING *
      .mockResolvedValueOnce(
        resultRows([{ id: 88, status: "pending", invoice_number: "INV-88" }]),
      )
      // Call 1: SELECT * FROM incoming_items
      .mockResolvedValueOnce(
        resultRows([
          {
            id: 1,
            product_id: 501,
            batch_id: 701,
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
      // Calls 2..7: per-item upserts + UPDATE batches + UPDATE products,
      // then final INSERT notifications.
      .mockResolvedValueOnce(resultRows([]))
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

      // NEW flow (post-refactor): a single atomic UPDATE ... RETURNING *
      // replaces the old SELECT-status + final UPDATE pair. There is no
      // separate body-schema default for update_selling_price here (request
      // sends no body), so selling_price UPDATE is skipped.
      //
      //   0: UPDATE incoming_goods SET status='confirmed' ... RETURNING *
      //   1: SELECT * FROM incoming_items WHERE incoming_goods_id = $1
      //   2: INSERT INTO inventory (product 501, batch 701, qty 5) — ON CONFLICT upsert
      //   3: UPDATE batches SET quantity = quantity + 5 WHERE id = 701
      //   4: UPDATE products SET purchase_price = 8.5 WHERE id = 501
      //   5: INSERT INTO inventory (product 902, batch null, qty 2)
      //   6: UPDATE products SET purchase_price = 12.2 WHERE id = 902
      //   7: INSERT INTO notifications
      expect(clientQuery).toHaveBeenCalledTimes(8);

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

      // Item 1 → product 501, batch 701
      expect(String(clientQuery.mock.calls[2][0])).toContain(
        "INSERT INTO inventory",
      );
      expect(String(clientQuery.mock.calls[2][0])).toContain("ON CONFLICT");
      // Args: [product_id, batch_id, warehouse_id=1, quantity]
      expect(clientQuery.mock.calls[2][1]).toEqual([501, 701, 1, 5]);

      // Batch quantity is bumped via a dedicated UPDATE (not implicitly by
      // the inventory upsert). This guards against accidental double-decrement
      // regressions if the ON CONFLICT branch is ever changed.
      expect(String(clientQuery.mock.calls[3][0])).toContain(
        "UPDATE batches SET quantity = quantity + $1",
      );
      expect(clientQuery.mock.calls[3][1]).toEqual([5, 701]);

      expect(String(clientQuery.mock.calls[4][0])).toContain(
        "UPDATE products SET purchase_price = $1",
      );
      expect(clientQuery.mock.calls[4][1]).toEqual([8.5, 501]);

      // Item 2 → product 902, batch_id null → NO UPDATE batches call
      expect(String(clientQuery.mock.calls[5][0])).toContain(
        "INSERT INTO inventory",
      );
      expect(clientQuery.mock.calls[5][1]).toEqual([902, null, 1, 2]);

      expect(String(clientQuery.mock.calls[6][0])).toContain(
        "UPDATE products SET purchase_price = $1",
      );
      expect(clientQuery.mock.calls[6][1]).toEqual([12.2, 902]);

      expect(String(clientQuery.mock.calls[7][0])).toContain(
        "INSERT INTO notifications",
      );
      expect(clientQuery.mock.calls[7][1]).toEqual([
        "Incoming goods #88 confirmed. 2 items added to stock.",
      ]);
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

  it("returns batch and expiry metadata on confirmed delivery details", async () => {
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
            batch_id: 701,
            batch_number: "LOT-701",
            expiry_date: "2026-12-01",
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
      expect(res.json()).toMatchObject({
        id: 90,
        status: "confirmed",
        items: [
          {
            id: 11,
            batch_id: 701,
            batch_number: "LOT-701",
            expiry_date: "2026-12-01",
          },
        ],
      });
    } finally {
      await app.close();
    }
  });
});
