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

  it("propagates confirmed incoming quantities into per-batch inventory", async () => {
    // GQF: партидно проследяване. За всеки ред без подаден batch_number
    // confirm създава нова партида (INSERT batches), upsert-ва наличност
    // по (product_id, batch_id, warehouse_id) и връзва входящия ред към
    // партидата (UPDATE incoming_items SET batch_id).
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
            batch_number: null,
            expiry_date: null,
            quantity: 5,
            unit_price: 8.5,
            selling_price: 11.4,
          },
          {
            id: 2,
            product_id: 902,
            batch_id: null,
            batch_number: null,
            expiry_date: null,
            quantity: 2,
            unit_price: 12.2,
          },
        ]),
      )
      // Item 1 (no batch_number → авто-номер по ред, lookup then INSERT):
      .mockResolvedValueOnce(resultRows([])) // 2: SELECT batches (АВТО-88-1) → none
      .mockResolvedValueOnce(resultRows([{ id: 7001 }])) // 3: INSERT batches → id
      .mockResolvedValueOnce(resultRows([])) // 4: INSERT inventory (per batch)
      .mockResolvedValueOnce(resultRows([])) // 5: UPDATE incoming_items SET batch_id
      .mockResolvedValueOnce(resultRows([])) // 6: UPDATE purchase_price item 1
      .mockResolvedValueOnce(resultRows([])) // 7: SELECT pendingLines item 1
      // Item 2:
      .mockResolvedValueOnce(resultRows([])) // 8: SELECT batches (АВТО-88-2) → none
      .mockResolvedValueOnce(resultRows([{ id: 7002 }])) // 9: INSERT batches → id
      .mockResolvedValueOnce(resultRows([])) // 10: INSERT inventory (per batch)
      .mockResolvedValueOnce(resultRows([])) // 11: UPDATE incoming_items SET batch_id
      .mockResolvedValueOnce(resultRows([])) // 12: UPDATE purchase_price item 2
      .mockResolvedValueOnce(resultRows([])) // 13: SELECT pendingLines item 2
      .mockResolvedValueOnce(resultRows([])); // 14: INSERT notifications stock_in

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildAppWithRole("admin");
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

      // Item 1 → no batch_number: lookup по авто-номер ПО РЕД, после INSERT.
      expect(String(clientQuery.mock.calls[2][0])).toContain(
        "SELECT id FROM batches WHERE product_id = $1 AND batch_number = $2",
      );
      expect(clientQuery.mock.calls[2][1]).toEqual([501, "АВТО-88-1"]);
      const batchSql1 = String(clientQuery.mock.calls[3][0]);
      expect(batchSql1).toContain("INSERT INTO batches");
      expect(clientQuery.mock.calls[3][1]).toEqual([
        501,
        "АВТО-88-1",
        null,
        5,
        8.5,
        "88",
      ]);

      // Inventory upsert keyed on (product_id, batch_id, warehouse_id).
      const invSql1 = String(clientQuery.mock.calls[4][0]);
      expect(invSql1).toContain("INSERT INTO inventory");
      expect(invSql1).toContain(
        "ON CONFLICT (product_id, batch_id, warehouse_id)",
      );
      expect(clientQuery.mock.calls[4][1]).toEqual([501, 1, 7001, 5]);

      // Incoming line gets linked to the resolved batch.
      expect(String(clientQuery.mock.calls[5][0])).toContain(
        "UPDATE incoming_items SET batch_id = $1",
      );
      expect(clientQuery.mock.calls[5][1]).toEqual([7001, 1]);

      expect(String(clientQuery.mock.calls[6][0])).toContain(
        "UPDATE products SET purchase_price = $1",
      );
      expect(clientQuery.mock.calls[6][1]).toEqual([8.5, 501]);

      // Batch F1 — pendingLines lookup for product 501.
      expect(String(clientQuery.mock.calls[7][0])).toContain(
        "FROM order_items oi",
      );
      expect(String(clientQuery.mock.calls[7][0])).toContain(
        "line_status IN ('paid_not_taken', 'awaiting')",
      );
      expect(clientQuery.mock.calls[7][1]).toEqual([501]);

      // Item 2 → product 902, same per-batch pattern (авто-номер по ред 2).
      expect(clientQuery.mock.calls[8][1]).toEqual([902, "АВТО-88-2"]);
      expect(String(clientQuery.mock.calls[9][0])).toContain(
        "INSERT INTO batches",
      );
      expect(clientQuery.mock.calls[9][1]).toEqual([
        902,
        "АВТО-88-2",
        null,
        2,
        12.2,
        "88",
      ]);
      expect(String(clientQuery.mock.calls[10][0])).toContain(
        "INSERT INTO inventory",
      );
      expect(clientQuery.mock.calls[10][1]).toEqual([902, 1, 7002, 2]);
      expect(clientQuery.mock.calls[11][1]).toEqual([7002, 2]);
      expect(String(clientQuery.mock.calls[12][0])).toContain(
        "UPDATE products SET purchase_price = $1",
      );
      expect(clientQuery.mock.calls[12][1]).toEqual([12.2, 902]);
      expect(clientQuery.mock.calls[13][1]).toEqual([902]);

      expect(String(clientQuery.mock.calls[14][0])).toContain(
        "INSERT INTO notifications",
      );
      expect(clientQuery.mock.calls[14][1]).toEqual([
        "Incoming goods #88 confirmed. 2 items added to stock.",
      ]);

      // No NULL-batch inventory upsert any more.
      const nullBatchUpserts = clientQuery.mock.calls.filter((call: any[]) =>
        String(call[0]).includes("WHERE batch_id IS NULL"),
      );
      expect(nullBatchUpserts).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("reuses an existing batch when batch_number matches", async () => {
    // Подаден batch_number, който вече съществува за продукта → namira go
    // (SELECT batches), UPDATE-ва партидата (без нов INSERT) и пак upsert-ва
    // наличност по партида.
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        resultRows([{ id: 88, status: "pending", invoice_number: "INV-88" }]),
      )
      .mockResolvedValueOnce(
        resultRows([
          {
            id: 1,
            product_id: 501,
            batch_id: null,
            batch_number: "L-2026-01",
            expiry_date: "2026-12-31",
            quantity: 5,
            unit_price: 8.5,
          },
        ]),
      )
      .mockResolvedValueOnce(resultRows([{ id: 4242 }])) // SELECT batches → found
      .mockResolvedValueOnce(resultRows([])) // UPDATE batches
      .mockResolvedValueOnce(resultRows([])) // INSERT inventory (per batch)
      .mockResolvedValueOnce(resultRows([])) // UPDATE incoming_items SET batch_id
      .mockResolvedValueOnce(resultRows([])) // UPDATE purchase_price
      .mockResolvedValueOnce(resultRows([])) // SELECT pendingLines
      .mockResolvedValueOnce(resultRows([])); // INSERT notifications

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildAppWithRole("admin");
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/incoming/88/confirm",
      });

      expect(res.statusCode).toBe(200);

      // Find-by-number, not create.
      expect(String(clientQuery.mock.calls[2][0])).toContain(
        "SELECT id FROM batches WHERE product_id = $1 AND batch_number = $2",
      );
      expect(clientQuery.mock.calls[2][1]).toEqual([501, "L-2026-01"]);

      const updBatchSql = String(clientQuery.mock.calls[3][0]);
      expect(updBatchSql).toContain("UPDATE batches");
      expect(updBatchSql).toContain("quantity = quantity + $5");
      expect(clientQuery.mock.calls[3][1]).toEqual([
        4242,
        "2026-12-31",
        8.5,
        "88",
        5,
      ]);

      // No INSERT INTO batches when one is reused.
      const batchInserts = clientQuery.mock.calls.filter((call: any[]) =>
        String(call[0]).includes("INSERT INTO batches"),
      );
      expect(batchInserts).toHaveLength(0);

      expect(clientQuery.mock.calls[4][1]).toEqual([501, 1, 4242, 5]);
    } finally {
      await app.close();
    }
  });

  it("normalizes a DATE-typed expiry (JS Date from pg) instead of throwing on .trim()", async () => {
    // Регресия: PostgreSQL DATE колона се чете от драйвера като JS Date,
    // НЕ като string. Старият код правеше (item.expiry_date ?? "").trim(),
    // но Date няма .trim() → TypeError → 500 и доставката не се
    // потвърждаваше (прод: 50TIE00450, всеки ред със срок). Confirm трябва
    // да нормализира Date → 'YYYY-MM-DD' (локални компоненти, без TZ дрифт).
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        resultRows([
          { id: 77, status: "pending", invoice_number: "50TIE00450" },
        ]),
      )
      .mockResolvedValueOnce(
        resultRows([
          {
            id: 1,
            product_id: 502,
            batch_id: null,
            batch_number: null,
            // Точно каквото node-postgres връща за DATE колона: JS Date на
            // локална полунощ (не ISO string).
            expiry_date: new Date(2026, 6, 14),
            quantity: 3,
            unit_price: 9.9,
          },
        ]),
      )
      .mockResolvedValueOnce(resultRows([])) // SELECT batches (АВТО-77-1) → none
      .mockResolvedValueOnce(resultRows([{ id: 7101 }])) // INSERT batches → id
      .mockResolvedValueOnce(resultRows([])) // INSERT inventory (per batch)
      .mockResolvedValueOnce(resultRows([])) // UPDATE incoming_items SET batch_id
      .mockResolvedValueOnce(resultRows([])) // UPDATE purchase_price
      .mockResolvedValueOnce(resultRows([])) // SELECT pendingLines
      .mockResolvedValueOnce(resultRows([])); // INSERT notifications

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildAppWithRole("admin");
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/incoming/77/confirm",
      });

      // Преди фикса: 500 (TypeError: (item.expiry_date ?? "").trim ...).
      expect(res.statusCode).toBe(200);

      // Партидата се създава с нормализиран срок 'YYYY-MM-DD' (без TZ отместване).
      const batchSql = String(clientQuery.mock.calls[3][0]);
      expect(batchSql).toContain("INSERT INTO batches");
      expect(clientQuery.mock.calls[3][1]).toEqual([
        502,
        "АВТО-77-1",
        "2026-07-14",
        3,
        9.9,
        "77",
      ]);
    } finally {
      await app.close();
    }
  });

  it("confirms a delivery with TWO lines of the SAME product (separate auto batches per line)", async () => {
    // Регресия (прод: Документ 110, доставка id=4): ръчна доставка с два
    // реда на един и същ продукт (различни лотове/срокове), без номера на
    // партиди. Старият авто-номер АВТО-{доставка}-{продукт} се дублираше на
    // втория ред → duplicate key ux_batches_product_number → 500 и целият
    // confirm се проваляше. Сега авто-номерът е ПО РЕД: АВТО-{доставка}-{ред}.
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        resultRows([{ id: 4, status: "pending", invoice_number: "110" }]),
      )
      .mockResolvedValueOnce(
        resultRows([
          {
            id: 24,
            product_id: 34,
            batch_id: null,
            batch_number: null,
            expiry_date: "2027-03-31",
            quantity: 16.635,
            unit_price: 9.25,
          },
          {
            id: 25,
            product_id: 34,
            batch_id: null,
            batch_number: null,
            expiry_date: "2027-05-31",
            quantity: 60.539,
            unit_price: 10.0,
          },
        ]),
      )
      // Item 24:
      .mockResolvedValueOnce(resultRows([])) // SELECT batches (АВТО-4-24) → none
      .mockResolvedValueOnce(resultRows([{ id: 9001 }])) // INSERT batches
      .mockResolvedValueOnce(resultRows([])) // INSERT inventory
      .mockResolvedValueOnce(resultRows([])) // UPDATE incoming_items SET batch_id
      .mockResolvedValueOnce(resultRows([])) // UPDATE purchase_price
      .mockResolvedValueOnce(resultRows([])) // SELECT pendingLines
      // Item 25:
      .mockResolvedValueOnce(resultRows([])) // SELECT batches (АВТО-4-25) → none
      .mockResolvedValueOnce(resultRows([{ id: 9002 }])) // INSERT batches
      .mockResolvedValueOnce(resultRows([])) // INSERT inventory
      .mockResolvedValueOnce(resultRows([])) // UPDATE incoming_items SET batch_id
      .mockResolvedValueOnce(resultRows([])) // UPDATE purchase_price
      .mockResolvedValueOnce(resultRows([])) // SELECT pendingLines
      .mockResolvedValueOnce(resultRows([])); // INSERT notifications

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildAppWithRole("admin");
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/incoming/4/confirm",
      });

      expect(res.statusCode).toBe(200);

      // Двата реда създават ДВЕ отделни партиди с различни авто-номера
      // (по ред), всяка със собствения си срок.
      const batchInserts = clientQuery.mock.calls.filter((call: any[]) =>
        String(call[0]).includes("INSERT INTO batches"),
      );
      expect(batchInserts).toHaveLength(2);
      expect(batchInserts[0][1]).toEqual([
        34,
        "АВТО-4-24",
        "2027-03-31",
        16.635,
        9.25,
        "4",
      ]);
      expect(batchInserts[1][1]).toEqual([
        34,
        "АВТО-4-25",
        "2027-05-31",
        60.539,
        10.0,
        "4",
      ]);
    } finally {
      await app.close();
    }
  });

  it("2-цифрена година от OCR (година 0027) се коригира до 2027 при confirm", async () => {
    // Прод (I20869): OCR извади срок „27-03-31" → записан като година 0027.
    // Confirm-ът го подаваше обратно като „27-03-31" → Postgres:
    // date/time field value out of range. Нормализаторът вече коригира
    // века: година < 100 → +2000.
    const ocrDate = new Date(2000, 2, 31); // 31 март
    ocrDate.setFullYear(27); // година 0027 — както pg връща DATE 0027-03-31
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        resultRows([{ id: 92, status: "pending", invoice_number: "I20869" }]),
      )
      .mockResolvedValueOnce(
        resultRows([
          {
            id: 60,
            product_id: 700,
            batch_id: null,
            batch_number: null,
            expiry_date: ocrDate,
            quantity: 10,
            unit_price: 2.5,
          },
        ]),
      )
      .mockResolvedValueOnce(resultRows([])) // SELECT batches (АВТО) → няма
      .mockResolvedValueOnce(resultRows([{ id: 9900 }])) // INSERT batches
      .mockResolvedValueOnce(resultRows([])) // INSERT inventory
      .mockResolvedValueOnce(resultRows([])) // UPDATE incoming_items batch_id
      .mockResolvedValueOnce(resultRows([])) // UPDATE purchase_price
      .mockResolvedValueOnce(resultRows([])) // SELECT pendingLines
      .mockResolvedValueOnce(resultRows([])); // INSERT notifications

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildAppWithRole("admin");
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/incoming/92/confirm",
      });

      expect(res.statusCode).toBe(200);
      // Партидата се създава с коригиран век: 2027-03-31, не 27-03-31.
      expect(clientQuery.mock.calls[3][1]).toEqual([
        700,
        "АВТО-92-60",
        "2027-03-31",
        10,
        2.5,
        "92",
      ]);
    } finally {
      await app.close();
    }
  });

  it("ред без свързан продукт → чист 400 с името на реда (не 500 NOT NULL)", async () => {
    // OCR-сканирана доставка може да носи ред, който не е свързан към
    // продукт (product_id NULL). Confirm-ът опитваше да създаде партида с
    // NULL продукт → NOT NULL violation → 500 без обяснение. Сега: 400 с
    // ясно съобщение кой ред да се свърже.
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        resultRows([{ id: 91, status: "pending", invoice_number: "I20869" }]),
      )
      .mockResolvedValueOnce(
        resultRows([
          {
            id: 50,
            product_id: null,
            product_name_raw: "ΠΑΣΤΑ ΦΥΛΛΟ ΧΩΡΙΑΤΙΚΟ",
            quantity: 10,
            unit_price: 2.5,
            batch_number: null,
            expiry_date: null,
          },
        ]),
      );

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildAppWithRole("admin");
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/incoming/91/confirm",
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("без свързан продукт");
      expect(res.json().message).toContain("ΠΑΣΤΑ ΦΥΛΛΟ ΧΩΡΙΑΤΙΚΟ");
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

    const app = await buildAppWithRole("admin");
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

    const app = await buildAppWithRole("admin");
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
