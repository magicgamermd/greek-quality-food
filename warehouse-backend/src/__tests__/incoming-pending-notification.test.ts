// Batch F1 — task 11
// PUT /incoming/:id/confirm now scans for matching open lines and emits a
// 'pending_order_ready' notification per matching order_items row whose
// line_status is paid_not_taken or awaiting (and whose order isn't
// cancelled). Payload carries the typed context the bell / future toast
// can consume.

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query, transaction } from "../db.js";
import incomingRoutes from "../routes/incoming.js";

const mockQuery = vi.mocked(query);
const mockTransaction = vi.mocked(transaction);

function rows<T>(list: T[]) {
  return { rows: list, rowCount: list.length } as any;
}

async function buildApp() {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-warehouse",
      email: "warehouse@test.local",
      role: "admin",
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(incomingRoutes, { prefix: "/incoming" });
  return app;
}

describe("Batch F1 — incoming confirm pending_order_ready notifications", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("fires one pending_order_ready notification per matching open line", async () => {
    // Single incoming item bringing product 501. Two open order lines are
    // waiting on it — one paid_not_taken, one awaiting. Both should get a
    // pending_order_ready notification.
    const clientQuery = vi
      .fn()
      // 0. UPDATE incoming_goods → confirmed
      .mockResolvedValueOnce(
        rows([{ id: 88, status: "pending", invoice_number: "INV-88" }]),
      )
      // 1. SELECT incoming_items
      .mockResolvedValueOnce(
        rows([
          {
            id: 1,
            product_id: 501,
            quantity: 5,
            unit_price: 8.5,
          },
        ]),
      )
      // 2. INSERT batches (no batch_number on the line → auto batch)
      .mockResolvedValueOnce(rows([{ id: 7001 }]))
      // 3. INSERT inventory (per-batch UPSERT)
      .mockResolvedValueOnce(rows([]))
      // 4. UPDATE incoming_items SET batch_id
      .mockResolvedValueOnce(rows([]))
      // 5. UPDATE products SET purchase_price (unit_price > 0)
      .mockResolvedValueOnce(rows([]))
      // 6. SELECT order_items pendingLines — 2 matching rows
      .mockResolvedValueOnce(
        rows([
          {
            item_id: 1001,
            order_id: 50,
            product_id: 501,
            quantity: "2",
            line_status: "paid_not_taken",
            product_name: "Hendi 123",
            partner_name: "Partner A",
          },
          {
            item_id: 1002,
            order_id: 51,
            product_id: 501,
            quantity: "1",
            line_status: "awaiting",
            product_name: "Hendi 123",
            partner_name: "Partner B",
          },
        ]),
      )
      // 7. INSERT notifications (pending_order_ready) — line 1
      .mockResolvedValueOnce(rows([]))
      // 8. INSERT notifications (pending_order_ready) — line 2
      .mockResolvedValueOnce(rows([]))
      // 9. INSERT notifications (stock_in summary)
      .mockResolvedValueOnce(rows([]));

    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/incoming/88/confirm",
      });
      expect(res.statusCode).toBe(200);

      const pendingNotifInserts = clientQuery.mock.calls.filter(
        (c: any[]) =>
          String(c[0]).includes("INSERT INTO notifications") &&
          String(c[0]).includes("pending_order_ready"),
      );
      expect(pendingNotifInserts).toHaveLength(2);

      // First notification — paid_not_taken line.
      const [msg1, payload1] = pendingNotifInserts[0]![1] as [string, string];
      expect(msg1).toContain("Поръчка #50");
      expect(msg1).toContain("Partner A");
      expect(msg1).toContain("Hendi 123");
      expect(JSON.parse(payload1)).toMatchObject({
        order_id: 50,
        order_item_id: 1001,
        product_id: 501,
        line_status: "paid_not_taken",
        partner_name: "Partner A",
      });

      // Second notification — awaiting line.
      const [, payload2] = pendingNotifInserts[1]![1] as [string, string];
      expect(JSON.parse(payload2)).toMatchObject({
        order_id: 51,
        order_item_id: 1002,
        line_status: "awaiting",
        partner_name: "Partner B",
      });
    } finally {
      await app.close();
    }
  });

  it("emits no pending_order_ready notification when no open lines match", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(rows([{ id: 89, status: "pending" }]))
      .mockResolvedValueOnce(
        rows([{ id: 1, product_id: 999, quantity: 3, unit_price: 5 }]),
      )
      .mockResolvedValueOnce(rows([{ id: 7001 }])) // INSERT batches
      .mockResolvedValueOnce(rows([])) // INSERT inventory (per batch)
      .mockResolvedValueOnce(rows([])) // UPDATE incoming_items SET batch_id
      .mockResolvedValueOnce(rows([])) // UPDATE products purchase_price
      .mockResolvedValueOnce(rows([])) // SELECT pendingLines → empty
      .mockResolvedValueOnce(rows([])); // INSERT notifications stock_in

    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/incoming/89/confirm",
      });
      expect(res.statusCode).toBe(200);

      const pendingNotifInserts = clientQuery.mock.calls.filter((c: any[]) =>
        String(c[0]).includes("pending_order_ready"),
      );
      expect(pendingNotifInserts).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("excludes cancelled orders from the pending lines lookup", async () => {
    // The SELECT used for pendingLines must filter out cancelled orders
    // (regression guard against accidentally notifying about a cancelled
    // order's leftover line_status).
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(rows([{ id: 90, status: "pending" }]))
      .mockResolvedValueOnce(
        rows([{ id: 1, product_id: 7, quantity: 1, unit_price: 5 }]),
      )
      .mockResolvedValueOnce(rows([{ id: 7001 }])) // INSERT batches
      .mockResolvedValueOnce(rows([])) // INSERT inventory (per batch)
      .mockResolvedValueOnce(rows([])) // UPDATE incoming_items SET batch_id
      .mockResolvedValueOnce(rows([])) // UPDATE products purchase_price
      .mockResolvedValueOnce(rows([])) // SELECT pendingLines
      .mockResolvedValueOnce(rows([])); // INSERT notifications stock_in

    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      await app.inject({
        method: "PUT",
        url: "/incoming/90/confirm",
      });

      const pendingSelect = clientQuery.mock.calls.find(
        (c: any[]) =>
          String(c[0]).includes("FROM order_items oi") &&
          String(c[0]).includes("line_status"),
      );
      expect(pendingSelect).toBeDefined();
      expect(String(pendingSelect![0])).toMatch(
        /o\.status NOT IN \('cancelled'\)/,
      );
      expect(String(pendingSelect![0])).toMatch(
        /line_status IN \('paid_not_taken', 'awaiting'\)/,
      );
    } finally {
      await app.close();
    }
  });
});
