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

// pg-подобен резултат: rowCount е нужен на adjustBatchStock (UPDATE
// inventory → ако 0, вмъква нов ред).
function res<T>(rows: T[], rowCount: number | null = rows.length) {
  return { rows, rowCount } as any;
}

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
  await app.register(incomingRoutes, { prefix: "/incoming" });
  return app;
}

describe("editing a CONFIRMED delivery propagates to batches/inventory", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("PATCH /:id/items: qty delta + expiry + price reach the linked batch and inventory", async () => {
    const clientQuery = vi
      .fn()
      // 0: SELECT incoming_goods FOR UPDATE → потвърдена
      .mockResolvedValueOnce(res([{ id: 7, status: "confirmed" }]))
      // 1: SELECT current item FOR UPDATE
      .mockResolvedValueOnce(
        res([
          {
            id: 30,
            product_id: 55,
            batch_id: 900,
            quantity: "10",
            unit_price: "5.00",
          },
        ]),
      )
      // 2: UPDATE batches quantity += delta (2)
      .mockResolvedValueOnce(res([], 1))
      // 3: UPDATE inventory quantity += delta
      .mockResolvedValueOnce(res([], 1))
      // 4: UPDATE batches SET expiry_date
      .mockResolvedValueOnce(res([], 1))
      // 5: UPDATE batches SET purchase_price
      .mockResolvedValueOnce(res([], 1))
      // 6: UPDATE products SET purchase_price
      .mockResolvedValueOnce(res([], 1))
      // 7: UPDATE incoming_items (row + total_price)
      .mockResolvedValueOnce(res([], 1));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "PATCH",
        url: "/incoming/7/items",
        payload: {
          items: [
            {
              id: 30,
              quantity: 12,
              unit_price: 6.5,
              expiry_date: "2027-01-15",
            },
          ],
        },
      });

      expect(r.statusCode).toBe(200);

      // Количество: delta = 12 - 10 = +2 върху партидата и наличността.
      expect(String(clientQuery.mock.calls[2][0])).toContain(
        "UPDATE batches SET quantity = quantity + $1",
      );
      expect(clientQuery.mock.calls[2][1]).toEqual([2, 900]);
      expect(String(clientQuery.mock.calls[3][0])).toContain(
        "UPDATE inventory SET quantity = quantity + $1",
      );
      expect(clientQuery.mock.calls[3][1]).toEqual([2, 55, 1, 900]);

      // Срокът отива върху партидата.
      expect(String(clientQuery.mock.calls[4][0])).toContain(
        "UPDATE batches SET expiry_date = $1",
      );
      expect(clientQuery.mock.calls[4][1]).toEqual(["2027-01-15", 900]);

      // Цената отива върху партидата (COGS) + продукта.
      expect(String(clientQuery.mock.calls[5][0])).toContain(
        "UPDATE batches SET purchase_price = $1",
      );
      expect(clientQuery.mock.calls[5][1]).toEqual([6.5, 900]);
      expect(String(clientQuery.mock.calls[6][0])).toContain(
        "UPDATE products SET purchase_price = $1",
      );
      expect(clientQuery.mock.calls[6][1]).toEqual([6.5, 55]);

      // Редът се обновява с преизчислен total_price = 12 * 6.5 = 78.
      const itemsSql = String(clientQuery.mock.calls[7][0]);
      expect(itemsSql).toContain("UPDATE incoming_items SET");
      expect(itemsSql).toContain("total_price");
      expect(clientQuery.mock.calls[7][1]).toEqual([
        12,
        6.5,
        "2027-01-15",
        78,
        "7",
        30,
      ]);
    } finally {
      await app.close();
    }
  });

  it("PATCH /:id/items: renaming to a colliding batch number returns 409, not 500", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(res([{ id: 7, status: "confirmed" }]))
      .mockResolvedValueOnce(
        res([
          {
            id: 30,
            product_id: 55,
            batch_id: 900,
            quantity: "10",
            unit_price: "5.00",
          },
        ]),
      )
      // Колизия: друга партида на същия продукт вече носи номера.
      .mockResolvedValueOnce(res([{ id: 777 }]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "PATCH",
        url: "/incoming/7/items",
        payload: { items: [{ id: 30, batch_number: "L-2026-09" }] },
      });

      expect(r.statusCode).toBe(409);
      expect(r.json().message).toContain("вече съществува");
    } finally {
      await app.close();
    }
  });

  it("DELETE /:id/items/:itemId on confirmed reverses the batch stock before deleting", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(res([{ id: 7, status: "confirmed" }]))
      // SELECT line FOR UPDATE
      .mockResolvedValueOnce(
        res([{ id: 31, product_id: 55, batch_id: 901, quantity: "4" }]),
      )
      // UPDATE batches -= 4
      .mockResolvedValueOnce(res([], 1))
      // UPDATE inventory -= 4
      .mockResolvedValueOnce(res([], 1))
      // DELETE incoming_items
      .mockResolvedValueOnce(res([], 1));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "DELETE",
        url: "/incoming/7/items/31",
      });

      expect(r.statusCode).toBe(200);
      expect(clientQuery.mock.calls[2][1]).toEqual([-4, 901]);
      expect(clientQuery.mock.calls[3][1]).toEqual([-4, 55, 1, 901]);
      expect(String(clientQuery.mock.calls[4][0])).toContain(
        "DELETE FROM incoming_items",
      );
    } finally {
      await app.close();
    }
  });

  it("POST /:id/items on confirmed creates the batch and inventory immediately", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(res([{ id: 7, status: "confirmed" }]))
      // SELECT products
      .mockResolvedValueOnce(res([{ id: 55 }]))
      // INSERT incoming_items RETURNING *
      .mockResolvedValueOnce(
        res([
          {
            id: 77,
            incoming_goods_id: 7,
            product_id: 55,
            quantity: 6,
            unit_price: 4.2,
            batch_number: null,
            expiry_date: "2027-02-02",
          },
        ]),
      )
      // applyIncomingLineToStock: SELECT batches (АВТО-7-77) → няма
      .mockResolvedValueOnce(res([]))
      // INSERT batches → id
      .mockResolvedValueOnce(res([{ id: 950 }]))
      // INSERT inventory
      .mockResolvedValueOnce(res([], 1))
      // UPDATE incoming_items SET batch_id
      .mockResolvedValueOnce(res([], 1))
      // UPDATE products SET purchase_price
      .mockResolvedValueOnce(res([], 1));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/items",
        payload: {
          product_id: 55,
          quantity: 6,
          unit_price: 4.2,
          expiry_date: "2027-02-02",
        },
      });

      expect(r.statusCode).toBe(201);
      expect(r.json().item.batch_id).toBe(950);

      // Партидата се създава с авто-номер ПО РЕД и срока на реда.
      expect(clientQuery.mock.calls[3][1]).toEqual([55, "АВТО-7-77"]);
      expect(String(clientQuery.mock.calls[4][0])).toContain(
        "INSERT INTO batches",
      );
      expect(clientQuery.mock.calls[4][1]).toEqual([
        55,
        "АВТО-7-77",
        "2027-02-02",
        6,
        4.2,
        "7",
      ]);
      expect(String(clientQuery.mock.calls[5][0])).toContain(
        "INSERT INTO inventory",
      );
      expect(clientQuery.mock.calls[5][1]).toEqual([55, 1, 950, 6]);
      expect(clientQuery.mock.calls[6][1]).toEqual([950, 77]);
      expect(String(clientQuery.mock.calls[7][0])).toContain(
        "UPDATE products SET purchase_price",
      );
    } finally {
      await app.close();
    }
  });

  it("still rejects edits on cancelled deliveries", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(res([{ id: 7, status: "cancelled" }]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "PATCH",
        url: "/incoming/7/items",
        payload: { items: [{ id: 30, quantity: 2 }] },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toContain("чакащи или потвърдени");
    } finally {
      await app.close();
    }
  });
});
