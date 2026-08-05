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

// SQL-ът е форматиран на няколко реда — сравняваме без оглед на
// празните места, за да не гние тестът при преформатиране.
const flat = (sql: unknown) => String(sql).replace(/\s+/g, " ").trim();

function callWith(clientQuery: any, fragment: string) {
  return clientQuery.mock.calls.find((c: any[]) =>
    flat(c[0]).includes(fragment),
  );
}
function allCallsWith(clientQuery: any, fragment: string) {
  return clientQuery.mock.calls.filter((c: any[]) =>
    flat(c[0]).includes(fragment),
  );
}

const CONFIRMED = { id: 7, status: "confirmed", invoice_number: "36098" };

/** Един ред: 4 бр по партида 900, която още държи цялото количество. */
const UNTOUCHED_ITEM = {
  id: 30,
  product_id: 55,
  batch_id: 900,
  quantity: "4",
  product_name: "Маслини Каламон BLONDE",
  batch_quantity: "4",
  batch_delivery_id: 7,
  inv_quantity: "4",
};

describe("връщане на потвърдена доставка в чакаща", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("сваля количествата от партидата и наличността и връща статус pending", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(res([CONFIRMED])) // 0: header FOR UPDATE
      .mockResolvedValueOnce(res([])) // 1: няма кредитно известие
      .mockResolvedValueOnce(res([{ ...UNTOUCHED_ITEM, batch_quantity: "10" }])) // 2: редовете (партидата има и друга стока)
      .mockResolvedValueOnce(res([])) // 3: няма изписване по поръчка
      .mockResolvedValueOnce(res([], 1)) // 4: UPDATE batches −4
      .mockResolvedValueOnce(res([], 1)) // 5: UPDATE inventory −4
      .mockResolvedValueOnce(res([], 1)) // 6: развързване на реда
      .mockResolvedValueOnce(res([{ ...CONFIRMED, status: "pending" }])); // 7

    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/unconfirm",
      });

      expect(r.statusCode).toBe(200);
      expect(r.json().status).toBe("pending");

      const batchUpd = callWith(clientQuery, "UPDATE batches SET quantity");
      expect(batchUpd[1]).toEqual([4, 900]);
      const invUpd = callWith(clientQuery, "UPDATE inventory SET quantity");
      expect(invUpd[1]).toEqual([4, 55, 900]);

      // Редът се развързва от партидата, за да се пресвърже при ново
      // потвърждаване.
      expect(callWith(clientQuery, "SET batch_id = NULL")).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("трие авто-партидата, ако след връщането остава нула", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(res([CONFIRMED]))
      .mockResolvedValueOnce(res([]))
      .mockResolvedValueOnce(res([UNTOUCHED_ITEM])) // партида 4, връщаме 4 → 0
      .mockResolvedValueOnce(res([]))
      .mockResolvedValueOnce(res([], 1)) // UPDATE batches
      .mockResolvedValueOnce(res([], 1)) // UPDATE inventory
      .mockResolvedValueOnce(res([], 1)) // DELETE inventory
      .mockResolvedValueOnce(res([], 1)) // DELETE batch
      .mockResolvedValueOnce(res([], 1)) // развързване
      .mockResolvedValueOnce(res([{ ...CONFIRMED, status: "pending" }]));

    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/unconfirm",
      });

      expect(r.statusCode).toBe(200);
      expect(callWith(clientQuery, "DELETE FROM batches")).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("отказва, ако от стоката вече е изписано (наличността не стига)", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(res([CONFIRMED]))
      .mockResolvedValueOnce(res([]))
      .mockResolvedValueOnce(
        // От 4-те са останали 1 — три са излезли.
        res([{ ...UNTOUCHED_ITEM, batch_quantity: "1", inv_quantity: "1" }]),
      )
      .mockResolvedValueOnce(res([]));

    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/unconfirm",
      });

      expect(r.statusCode).toBe(409);
      // Съобщението трябва да казва КОЙ продукт спъва, не само „грешка".
      expect(r.json().message).toContain("Маслини Каламон BLONDE");
      expect(
        allCallsWith(clientQuery, "UPDATE batches SET quantity"),
      ).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("отказва, ако партида от доставката вече е изписана по поръчка", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(res([CONFIRMED]))
      .mockResolvedValueOnce(res([]))
      .mockResolvedValueOnce(res([UNTOUCHED_ITEM]))
      .mockResolvedValueOnce(
        res([{ order_id: 82, product_name: "Маслини Каламон BLONDE" }]),
      );

    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/unconfirm",
      });

      expect(r.statusCode).toBe(409);
      expect(r.json().message).toMatch(/поръчка/i);
      expect(
        allCallsWith(clientQuery, "UPDATE batches SET quantity"),
      ).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("отказва, ако по доставката има издадено кредитно известие", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(res([CONFIRMED]))
      .mockResolvedValueOnce(res([{ invoice_number: "KI-501" }]));

    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/unconfirm",
      });

      expect(r.statusCode).toBe(409);
      expect(r.json().message).toContain("KI-501");
    } finally {
      await app.close();
    }
  });

  it("отказва за доставка, която не е потвърдена", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(res([{ ...CONFIRMED, status: "pending" }]));
    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/unconfirm",
      });
      expect(r.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
