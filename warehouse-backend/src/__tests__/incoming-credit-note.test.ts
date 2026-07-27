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

/** Намира първото извикване, чийто SQL съдържа фрагмента. */
function callWith(clientQuery: any, fragment: string) {
  return clientQuery.mock.calls.find((c: any[]) =>
    String(c[0]).includes(fragment),
  );
}

const CONFIRMED_DELIVERY = {
  id: 7,
  supplier_id: 21,
  invoice_number: "I20870",
  invoice_date: "2026-07-22",
  status: "confirmed",
  document_type: "invoice",
};

describe("входящо кредитно известие от доставчик", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("ценова корекция: КИ с отрицателна сума + нова цена по партидата и продукта", async () => {
    // Доставчикът е фактурирал 10 бр × 5.00, реалната цена е 4.00 →
    // издава КИ за разликата 10.00. Количествата НЕ се пипат.
    const clientQuery = vi
      .fn()
      // 0: SELECT оригиналната доставка FOR UPDATE
      .mockResolvedValueOnce(res([CONFIRMED_DELIVERY]))
      // 1: проверка за вече заведено КИ със същия номер
      .mockResolvedValueOnce(res([]))
      // 2: SELECT редовете на оригинала FOR UPDATE
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
      // 3: INSERT header на КИ
      .mockResolvedValueOnce(
        res([
          {
            id: 88,
            invoice_number: "KI-501",
            document_type: "credit_note",
            related_incoming_id: 7,
            total_amount: -10,
          },
        ]),
      )
      // 4: INSERT ред на КИ
      .mockResolvedValueOnce(res([{ id: 500 }]))
      // 5: UPDATE batches purchase_price
      .mockResolvedValueOnce(res([], 1))
      // 6: UPDATE products purchase_price
      .mockResolvedValueOnce(res([], 1));

    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/credit-note",
        payload: {
          credit_note_number: "KI-501",
          credit_note_date: "2026-07-27",
          reason: "Сгрешена цена по фактура I20870",
          items: [{ incoming_item_id: 30, new_unit_price: 4 }],
        },
      });

      expect(r.statusCode).toBe(201);
      expect(r.json().total_amount).toBeCloseTo(-10, 2);

      // Header: КИ тип, вързано към оригинала, ОТРИЦАТЕЛНА сума.
      const header = callWith(clientQuery, "INSERT INTO incoming_goods");
      expect(String(header[0])).toContain("credit_note");
      expect(header[1]).toEqual(
        expect.arrayContaining([21, "KI-501", "2026-07-27", 7, -10]),
      );

      // Редът на КИ спазва DB ограниченията: количество > 0 и цена >= 0
      // (chk_incoming_items_qty_pos / _price_nonneg). Кредитът е в
      // total_price. Тук: 10 бр × разлика 1.00 = −10.00.
      const cnItem = callWith(clientQuery, "INSERT INTO incoming_items");
      expect(cnItem[1][2]).toBe(10); // количество > 0
      expect(cnItem[1][3]).toBe(1); // разликата, положителна
      expect(cnItem[1][4]).toBeCloseTo(-10, 2); // стойност — отрицателна

      // Партидата и продуктът получават НОВАТА покупна цена.
      const batchUpd = callWith(
        clientQuery,
        "UPDATE batches SET purchase_price",
      );
      expect(batchUpd[1]).toEqual([4, 900]);
      const prodUpd = callWith(
        clientQuery,
        "UPDATE products SET purchase_price",
      );
      expect(prodUpd[1]).toEqual([4, 55]);

      // Оригиналната доставка остава каквато е издадена — без UPDATE по
      // редовете ѝ и без корекция на количества.
      expect(
        callWith(clientQuery, "UPDATE incoming_items SET"),
      ).toBeUndefined();
      expect(
        callWith(clientQuery, "UPDATE batches SET quantity"),
      ).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("върната стока: количеството слиза от партидата и наличността", async () => {
    // 4 от 10 бр се връщат на доставчика → КИ за 4 × 5.00 = 20.00.
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(res([CONFIRMED_DELIVERY]))
      .mockResolvedValueOnce(res([]))
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
      .mockResolvedValueOnce(
        res([
          {
            id: 89,
            invoice_number: "KI-502",
            document_type: "credit_note",
            related_incoming_id: 7,
            total_amount: -20,
          },
        ]),
      )
      .mockResolvedValueOnce(res([{ id: 501 }])) // INSERT ред на КИ
      .mockResolvedValueOnce(res([], 1)) // UPDATE batches quantity −4
      .mockResolvedValueOnce(res([], 1)); // UPDATE inventory quantity −4

    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/credit-note",
        payload: {
          credit_note_number: "KI-502",
          items: [{ incoming_item_id: 30, returned_quantity: 4 }],
        },
      });

      expect(r.statusCode).toBe(201);
      expect(r.json().total_amount).toBeCloseTo(-20, 2);

      // Редът пази ПОЛОЖИТЕЛНО количество (4) и цената на доставката;
      // кредитът е в стойността (−20). Отрицателно количество тук
      // чупеше chk_incoming_items_qty_pos в прод.
      const cnItem = callWith(clientQuery, "INSERT INTO incoming_items");
      expect(cnItem[1][2]).toBe(4);
      expect(cnItem[1][3]).toBeCloseTo(5, 2);
      expect(cnItem[1][4]).toBeCloseTo(-20, 2);

      // Наличността намалява с върнатото количество.
      const batchQty = callWith(clientQuery, "UPDATE batches SET quantity");
      expect(batchQty[1]).toEqual([-4, 900]);
      const invQty = callWith(clientQuery, "UPDATE inventory SET quantity");
      expect(invQty[1]).toEqual([-4, 55, 1, 900]);

      // Цената НЕ се пипа при връщане на стока.
      expect(
        callWith(clientQuery, "UPDATE batches SET purchase_price"),
      ).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("отказва КИ за НЕпотвърдена доставка (там просто се редактира)", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        res([{ ...CONFIRMED_DELIVERY, status: "pending" }]),
      );
    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/credit-note",
        payload: {
          credit_note_number: "KI-503",
          items: [{ incoming_item_id: 30, new_unit_price: 4 }],
        },
      });

      expect(r.statusCode).toBe(400);
      expect(r.json().message).toContain("потвърдена");
    } finally {
      await app.close();
    }
  });

  it("отказва повторно КИ със същия номер от същия доставчик", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(res([CONFIRMED_DELIVERY]))
      .mockResolvedValueOnce(res([{ id: 91, invoice_number: "KI-501" }]));
    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/credit-note",
        payload: {
          credit_note_number: "KI-501",
          items: [{ incoming_item_id: 30, new_unit_price: 4 }],
        },
      });

      expect(r.statusCode).toBe(409);
      expect(r.json().message).toContain("KI-501");
    } finally {
      await app.close();
    }
  });

  it("ред без корекция (нито нова цена, нито върнато количество) → 400", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(res([CONFIRMED_DELIVERY]))
      .mockResolvedValueOnce(res([]))
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
      );
    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/credit-note",
        payload: {
          credit_note_number: "KI-504",
          items: [{ incoming_item_id: 30 }],
        },
      });

      expect(r.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
