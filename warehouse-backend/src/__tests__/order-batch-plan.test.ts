// Избор на партиди по ред (мигр. 107): складът задава от кои партиди и
// колко. Поръчка №363 (17.10.2026) — програмата изписа 00081026 (08.12), а
// физически беше дадена 00151226 (15.12): изборът във формата се изхвърляше.
//
// Mock-ът отговаря според текста на заявката (не по ред на извикване) и
// пази състоянието на склада, за да се види какво реално се изписва.
import Fastify, { FastifyInstance } from "fastify";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setex: vi.fn(async () => "OK"),
    del: vi.fn(async () => 0),
  })),
}));

const docItems: any[] = [];
vi.mock("../services/document-pdf.js", async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    generateCommercialDocPdf: vi.fn(async ({ outputPath, items }: any) => {
      docItems.length = 0;
      docItems.push(...items);
      fs.writeFileSync(outputPath, "%PDF-1.4\n%stub\n");
    }),
  };
});

import { query, transaction } from "../db.js";
import ordersRoutes from "../routes/orders.js";

const mockQuery = vi.mocked(query);
const mockTx = vi.mocked(transaction);
const rows = <T>(list: T[]) => ({ rows: list, rowCount: list.length }) as any;
const flat = (sql: unknown) => String(sql).replace(/\s+/g, " ").trim();

const PRODUCT = 77; // Портокалопита
const FRESH = 1350; // 00151226, 15.12.2026
const OLDER = 1303; // 00081026, 08.12.2026
const EXPIRED = 1111; // 00010126, отдавна изтекла

function world(initialStock: Record<number, number> = {}) {
  const stock = new Map<number, number>(
    Object.entries({
      [FRESH]: 30.8,
      [OLDER]: 2.8,
      [EXPIRED]: 4,
      ...initialStock,
    }).map(([k, v]) => [Number(k), v]),
  );
  const batches = new Map<number, any>([
    [
      FRESH,
      {
        id: FRESH,
        product_id: PRODUCT,
        batch_number: "00151226",
        expiry_date: "2099-12-15",
        purchase_price: "4.5",
      },
    ],
    [
      OLDER,
      {
        id: OLDER,
        product_id: PRODUCT,
        batch_number: "00081026",
        expiry_date: "2099-12-08",
        purchase_price: "4.4",
      },
    ],
    [
      EXPIRED,
      {
        id: EXPIRED,
        product_id: PRODUCT,
        batch_number: "00010126",
        expiry_date: "2000-01-01",
        purchase_price: "4.0",
      },
    ],
  ]);
  const insertedLines: any[] = [];
  const deducted: {
    order_item_id: number;
    batch_id: number;
    quantity: number;
  }[] = [];
  let storedLines: any[] = [];
  let lineId = 2000;

  const handler = vi.fn(async (sql: string, params: any[] = []) => {
    const q = flat(sql);
    if (q.includes("INSERT INTO orders ("))
      return rows([
        {
          id: 501,
          order_number: 501,
          status: "pending",
          partner_id: 1,
          created_at: new Date(),
        },
      ]);
    if (q.startsWith("UPDATE orders SET total_amount")) return rows([]);
    if (q.includes("FROM partners"))
      return rows([
        {
          id: 1,
          name: "ФАНТАСТИКО ГРУП ООД",
          price_group: null,
          price_list_id: null,
        },
      ]);
    if (q.includes("FROM products") && q.includes("ANY"))
      return rows([
        {
          id: PRODUCT,
          name_bg: "Портокалопита",
          name_en: "Portokalopita",
          sku: "D1109",
          selling_price: "6.317",
          purchase_price: "4.5",
          is_service: false,
        },
      ]);
    // Проверката на избраните партиди при запис.
    if (
      q.startsWith(
        "SELECT b.id, b.product_id, b.batch_number, b.expiry_date, COALESCE(i.quantity, 0) AS available",
      )
    )
      return rows(
        (params[0] as number[])
          .filter((id) => batches.has(id))
          .map((id) => ({
            ...batches.get(id),
            available: String(stock.get(id) ?? 0),
          })),
      );
    if (q.includes("INSERT INTO order_items")) {
      const row = {
        id: ++lineId,
        order_id: params[0],
        product_id: params[1],
        quantity: String(params[2]),
        params,
      };
      insertedLines.push(row);
      return rows([row]);
    }
    // Изпълнение: редовете на поръчката.
    if (q.startsWith("SELECT * FROM order_items WHERE order_id"))
      return rows(storedLines);
    if (
      q.startsWith("SELECT * FROM orders WHERE id") ||
      (q.includes("FROM orders") && q.includes("FOR UPDATE"))
    )
      return rows([
        {
          id: 501,
          order_number: 501,
          status: "confirmed",
          partner_id: 1,
          invoice_id: null,
        },
      ]);
    // Точно изписване по разпределението.
    if (
      q.startsWith(
        "SELECT batch_number, expiry_date, purchase_price FROM batches",
      )
    )
      return rows(
        batches.has(params[0]) &&
          batches.get(params[0]).product_id === params[1]
          ? [batches.get(params[0])]
          : [],
      );
    if (q.startsWith("SELECT quantity FROM inventory"))
      return rows(
        stock.has(params[2])
          ? [{ quantity: String(stock.get(params[2])) }]
          : [],
      );
    if (q.startsWith("UPDATE inventory SET quantity = quantity - $1")) {
      stock.set(params[3], (stock.get(params[3]) ?? 0) - params[0]);
      return { rows: [], rowCount: 1 } as any;
    }
    if (q.includes("INSERT INTO order_item_batches")) {
      deducted.push({
        order_item_id: params[0],
        batch_id: params[1],
        quantity: params[2],
      });
      return rows([]);
    }
    // FEFO (не бива да се вика, когато има избор).
    if (
      q.includes("ORDER BY b.expiry_date ASC NULLS LAST, b.id ASC FOR UPDATE")
    )
      return rows([]);
    if (q.includes("SUM(")) return rows([{ total: "100" }]);
    if (q.includes("RETURNING"))
      return rows([{ id: 501, status: "fulfilled" }]);
    return rows([]);
  });

  return {
    handler,
    stock,
    insertedLines,
    deducted,
    setStoredLines: (lines: any[]) => (storedLines = lines),
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u-admin", email: "a@b", role: "admin" };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(ordersRoutes, { prefix: "/orders" });
  return app;
}

const fefoCalled = (handler: any) =>
  handler.mock.calls.some((c: any[]) =>
    flat(c[0]).includes(
      "ORDER BY b.expiry_date ASC NULLS LAST, b.id ASC FOR UPDATE",
    ),
  );

describe("създаване на поръчка с избрани партиди", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    mockQuery.mockReset();
    mockTx.mockReset();
  });
  afterEach(async () => {
    await app?.close();
  });

  function wire(w: ReturnType<typeof world>) {
    mockQuery.mockImplementation(w.handler as any);
    mockTx.mockImplementation(async (cb: any) => cb({ query: w.handler }));
  }

  it("5 от 15.12 + 5 от 08.12 → записва се разпределението", async () => {
    const w = world({ [OLDER]: 6 });
    wire(w);
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        partner_id: 1,
        items: [
          {
            product_id: PRODUCT,
            quantity: 10,
            unit_price: 6.317,
            batch_allocations: [
              { batch_id: FRESH, quantity: 5 },
              { batch_id: OLDER, quantity: 5 },
            ],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const params = w.insertedLines[0].params as any[];
    expect(params.at(-2)).toBe(FRESH); // batch_id = първата избрана
    expect(JSON.parse(params.at(-1))).toEqual([
      { batch_id: FRESH, quantity: 5 },
      { batch_id: OLDER, quantity: 5 },
    ]);
  });

  it("една избрана партида също се пази (досега се губеше)", async () => {
    const w = world();
    wire(w);
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        partner_id: 1,
        items: [
          {
            product_id: PRODUCT,
            quantity: 2.8,
            unit_price: 6.317,
            batch_id: FRESH,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const params = w.insertedLines[0].params as any[];
    expect(JSON.parse(params.at(-1))).toEqual([
      { batch_id: FRESH, quantity: 2.8 },
    ]);
  });

  it("без избор → автоматично, без нито една допълнителна заявка", async () => {
    const w = world();
    wire(w);
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        partner_id: 1,
        items: [{ product_id: PRODUCT, quantity: 2.8, unit_price: 6.317 }],
      },
    });
    expect(res.statusCode).toBe(201);
    const params = w.insertedLines[0].params as any[];
    expect(params.at(-2)).toBeNull();
    expect(params.at(-1)).toBeNull();
    expect(
      w.handler.mock.calls.some((c: any[]) =>
        flat(c[0]).includes("COALESCE(i.quantity, 0) AS available"),
      ),
    ).toBe(false);
  });

  it("сумата трябва да е равна на количеството", async () => {
    const w = world();
    wire(w);
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        partner_id: 1,
        items: [
          {
            product_id: PRODUCT,
            quantity: 10,
            unit_price: 6.317,
            batch_allocations: [
              { batch_id: FRESH, quantity: 5 },
              { batch_id: OLDER, quantity: 2.8 },
            ],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("не съвпада с количеството");
    expect(w.insertedLines).toHaveLength(0);
  });

  it("изтекла партида се отказва с номера ѝ", async () => {
    const w = world();
    wire(w);
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        partner_id: 1,
        items: [
          {
            product_id: PRODUCT,
            quantity: 2,
            unit_price: 6.317,
            batch_id: EXPIRED,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("00010126");
    expect(res.json().message).toContain("изтекъл срок");
  });

  it("наличността се смята сборно за всички редове от една партида", async () => {
    // 00081026 има 2.8; два реда искат по 2 от нея.
    const w = world();
    wire(w);
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        partner_id: 1,
        items: [
          {
            product_id: PRODUCT,
            quantity: 2,
            unit_price: 6.317,
            batch_id: OLDER,
          },
          {
            product_id: PRODUCT,
            quantity: 2,
            unit_price: 6.317,
            batch_id: OLDER,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("налични 2.8, избрани 4");
  });
});

describe("изпълнение по избраните партиди", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    mockQuery.mockReset();
    mockTx.mockReset();
  });
  afterEach(async () => {
    await app?.close();
  });

  const plannedLine = (plan: any[]) => ({
    id: 3001,
    order_id: 501,
    product_id: PRODUCT,
    quantity: "10.000",
    line_status: "normal",
    is_returning: false,
    batch_id: plan[0].batch_id,
    batch_plan: plan,
    name_bg_snapshot: "Портокалопита",
  });

  it("изписва точно избраното, не най-старата партида", async () => {
    const w = world({ [OLDER]: 6 });
    w.setStoredLines([
      plannedLine([
        { batch_id: FRESH, quantity: 5 },
        { batch_id: OLDER, quantity: 5 },
      ]),
    ]);
    mockQuery.mockImplementation(w.handler as any);
    mockTx.mockImplementation(async (cb: any) => cb({ query: w.handler }));
    app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/orders/501/fulfill",
    });
    expect(res.statusCode).toBe(200);
    expect(w.deducted.map((d) => [d.batch_id, d.quantity])).toEqual([
      [FRESH, 5],
      [OLDER, 5],
    ]);
    expect(w.stock.get(FRESH)).toBeCloseTo(25.8, 6);
    expect(w.stock.get(OLDER)).toBeCloseTo(1, 6);
    expect(fefoCalled(w.handler)).toBe(false);
  });

  it("ако междувременно избраната партида не стига → ясен отказ, без тиха подмяна", async () => {
    const w = world({ [OLDER]: 3 });
    w.setStoredLines([
      plannedLine([
        { batch_id: FRESH, quantity: 5 },
        { batch_id: OLDER, quantity: 5 },
      ]),
    ]);
    mockQuery.mockImplementation(w.handler as any);
    mockTx.mockImplementation(async (cb: any) => cb({ query: w.handler }));
    app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/orders/501/fulfill",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("Портокалопита");
    expect(res.json().message).toContain("00081026");
    expect(res.json().message).toContain("изберете партидите наново");
    expect(fefoCalled(w.handler)).toBe(false);
  });
});

describe("търговски документ преди изпълнение", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    mockQuery.mockReset();
    mockTx.mockReset();
    docItems.length = 0;
  });
  afterEach(async () => {
    await app?.close();
  });

  it("печата избраните партиди — по ред за всяка, с количеството ѝ", async () => {
    const line = {
      id: 3001,
      order_id: 501,
      product_id: PRODUCT,
      quantity: "10.000",
      line_status: "normal",
      batch_id: FRESH,
      batch_plan: [
        { batch_id: FRESH, quantity: 5 },
        { batch_id: OLDER, quantity: 5 },
      ],
      sku: "D1109",
      name_bg: "Портокалопита",
      unit: "kg",
    };
    mockQuery.mockImplementation((async (sql: string) => {
      const q = flat(sql);
      if (
        q.startsWith("SELECT * FROM orders WHERE id") ||
        (q.includes("FROM orders o") && q.includes("WHERE o.id"))
      )
        return rows([
          {
            id: 501,
            order_number: 501,
            status: "confirmed",
            partner_id: 1,
            order_date: "2026-10-26",
          },
        ]);
      if (q.startsWith("SELECT oi.*")) return rows([line]);
      if (q.startsWith("SELECT id, batch_number, expiry_date FROM batches"))
        return rows([
          { id: FRESH, batch_number: "00151226", expiry_date: "2026-12-15" },
          { id: OLDER, batch_number: "00081026", expiry_date: "2026-12-08" },
        ]);
      if (q.includes("FROM partners"))
        return rows([{ id: 1, name: "ФАНТАСТИКО ГРУП ООД" }]);
      return rows([]);
    }) as any);
    mockTx.mockImplementation(async (cb: any) =>
      cb({ query: vi.fn(async () => rows([])) }),
    );
    app = await buildApp();

    const res = await app.inject({
      method: "GET",
      url: "/orders/501/commercial-doc-pdf",
    });
    expect(res.statusCode).toBe(200);
    expect(
      docItems.map((d) => [d.batch_number, d.expiry_date, d.quantity]),
    ).toEqual([
      ["00081026", "2026-12-08", 5],
      ["00151226", "2026-12-15", 5],
    ]);
    // FEFO прогнозата не се вика, когато има избор.
    expect(mockTx).not.toHaveBeenCalled();
  });
});
