// Редакция на изпълнена поръчка, чийто ред е изписан от 2 партиди
// (поръчка №280, 26.09.2026): 6 кг от 00170926 + ред 3 кг = 0,5 от
// 00170926 и 2,5 от 00250926. Редакцията връщаше стоката и искаше целите
// 3 кг пак от 00170926 → „Недостатъчна наличност … налични 0.5, искани 3“.
// Mock-ът пази наличността по партиди, за да се види истинската сметка.
import Fastify, { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setex: vi.fn(async () => "OK"),
    del: vi.fn(async () => 0),
  })),
}));

import { query, transaction } from "../db.js";
import ordersRoutes from "../routes/orders.js";

const mockQuery = vi.mocked(query);
const mockTx = vi.mocked(transaction);

const rows = <T>(list: T[]) => ({ rows: list, rowCount: list.length }) as any;
const flat = (sql: unknown) => String(sql).replace(/\s+/g, " ");

const OLD = 1181; // 00170926, срок 17.11
const NEW = 1245; // 00250926, срок 25.11
const PRODUCT = 4;

/** Склад и поръчка точно както бяха в прода преди редакцията. */
function warehouse() {
  const stock = new Map<number, number>([
    [OLD, 0],
    [NEW, 3.5],
  ]);
  const batchInfo = new Map<number, { batch_number: string }>([
    [OLD, { batch_number: "00170926" }],
    [NEW, { batch_number: "00250926" }],
  ]);
  const oldItems = [
    { id: 778, product_id: PRODUCT, quantity: "6.000", batch_id: OLD },
    { id: 779, product_id: PRODUCT, quantity: "3.000", batch_id: OLD },
  ];
  let oldAllocations = [
    { id: 1, order_item_id: 778, batch_id: OLD, quantity: "6.000" },
    { id: 2, order_item_id: 779, batch_id: OLD, quantity: "0.500" },
    { id: 3, order_item_id: 779, batch_id: NEW, quantity: "2.500" },
  ];
  const newAllocations: {
    order_item_id: number;
    batch_id: number;
    quantity: number;
  }[] = [];
  let insertedId = 900;

  const client = vi.fn(async (sql: string, params: any[] = []) => {
    const q = flat(sql);
    if (q.startsWith("UPDATE orders SET total_amount")) return rows([]);
    if (q.includes("UPDATE orders SET") && q.includes("RETURNING"))
      return rows([
        {
          id: 284,
          order_number: 280,
          status: "fulfilled",
          partner_id: 1,
          invoice_id: null,
        },
      ]);
    if (q.includes("FROM partners"))
      return rows([{ id: 1, name: "ДАР Г.Н. ООД", price_list_id: null }]);
    if (q.includes("FROM products"))
      return rows([
        {
          id: PRODUCT,
          name_bg: "Баклавички",
          name_en: "Baklava",
          sku: "D1002",
          selling_price: "7.9",
          purchase_price: "4",
        },
      ]);
    if (q.startsWith("SELECT * FROM order_items WHERE order_id"))
      return rows(oldItems);
    if (
      q.includes("FROM order_item_batches") &&
      q.includes("order_item_id = $1")
    )
      return rows(oldAllocations.filter((a) => a.order_item_id === params[0]));
    if (q.startsWith("DELETE FROM order_item_batches WHERE id")) {
      oldAllocations = oldAllocations.filter((a) => a.id !== params[0]);
      return rows([]);
    }
    if (q.startsWith("UPDATE inventory SET quantity = quantity + $1")) {
      stock.set(params[2], (stock.get(params[2]) ?? 0) + params[0]);
      return { rows: [], rowCount: 1 } as any;
    }
    if (q.startsWith("UPDATE inventory SET quantity = quantity - $1")) {
      stock.set(params[3], (stock.get(params[3]) ?? 0) - params[0]);
      return { rows: [], rowCount: 1 } as any;
    }
    if (q.includes("INSERT INTO order_items"))
      return rows([
        { id: ++insertedId, order_id: params[0], product_id: params[1] },
      ]);
    if (q.includes("INSERT INTO order_item_batches")) {
      newAllocations.push({
        order_item_id: params[0],
        batch_id: params[1],
        quantity: params[2],
      });
      return rows([]);
    }
    // Ръчна партида (стария път): наличност на една партида.
    if (q.includes("i.quantity AS available") && q.includes("FROM inventory i"))
      return rows([
        {
          batch_id: params[2],
          batch_number: batchInfo.get(params[2])?.batch_number,
          expiry_date: "2026-12-31",
          purchase_price: "4",
          available: String(stock.get(params[2]) ?? 0),
        },
      ]);
    // Запазено разпределение (новия път).
    if (q.startsWith("SELECT batch_number, purchase_price FROM batches"))
      return rows(
        params[1] === PRODUCT && batchInfo.has(params[0])
          ? [{ ...batchInfo.get(params[0]), purchase_price: "4" }]
          : [],
      );
    if (q.startsWith("SELECT quantity FROM inventory"))
      return rows(
        stock.has(params[2])
          ? [{ quantity: String(stock.get(params[2])) }]
          : [],
      );
    if (q.includes("SUM(quantity)"))
      return rows([
        { total: String([...stock.values()].reduce((a, b) => a + b, 0)) },
      ]);
    if (q.includes("RETURNING")) return rows([{ id: params.at(-1) }]);
    return rows([]);
  });

  return { client, stock, newAllocations };
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

describe("редакция на поръчка — ред от 2 партиди (№280)", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    mockQuery.mockReset();
    mockTx.mockReset();
    mockQuery.mockResolvedValue(
      rows([
        {
          id: 284,
          status: "fulfilled",
          partner_id: 1,
          invoice_id: null,
          updated_at: new Date(),
        },
      ]),
    );
  });
  afterEach(async () => {
    await app?.close();
  });

  it("старият payload (една партида за целия ред) дава точно грешката от прода", async () => {
    const { client } = warehouse();
    mockTx.mockImplementation(async (cb: any) => cb({ query: client }));
    app = await buildApp();

    const res = await app.inject({
      method: "PUT",
      url: "/orders/284",
      payload: {
        items: [
          { product_id: PRODUCT, quantity: 6, unit_price: 7.9, batch_id: OLD },
          { product_id: PRODUCT, quantity: 3, unit_price: 7.9, batch_id: OLD },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("налични 0.5, искани 3");
  });

  it("досегашното разпределение се запазва и складът остава същият", async () => {
    const { client, stock, newAllocations } = warehouse();
    mockTx.mockImplementation(async (cb: any) => cb({ query: client }));
    app = await buildApp();

    const res = await app.inject({
      method: "PUT",
      url: "/orders/284",
      payload: {
        items: [
          {
            product_id: PRODUCT,
            quantity: 6,
            unit_price: 7.9,
            batch_allocations: [{ batch_id: OLD, quantity: 6 }],
          },
          {
            product_id: PRODUCT,
            quantity: 3,
            unit_price: 8.1,
            batch_allocations: [
              { batch_id: OLD, quantity: 0.5 },
              { batch_id: NEW, quantity: 2.5 },
            ],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(stock.get(OLD)).toBeCloseTo(0, 6);
    expect(stock.get(NEW)).toBeCloseTo(3.5, 6);
    expect(newAllocations.map((a) => [a.batch_id, a.quantity])).toEqual([
      [OLD, 6],
      [OLD, 0.5],
      [NEW, 2.5],
    ]);
  });

  it("запазеното разпределение не минава през проверката за срок на ръчната партида", async () => {
    // Стоката вече е продадена — ако междувременно срокът е изтекъл,
    // редакцията (напр. на цена) пак трябва да мине.
    const { client } = warehouse();
    mockTx.mockImplementation(async (cb: any) => cb({ query: client }));
    app = await buildApp();

    const res = await app.inject({
      method: "PUT",
      url: "/orders/284",
      payload: {
        items: [
          {
            product_id: PRODUCT,
            quantity: 6,
            unit_price: 7.9,
            batch_allocations: [{ batch_id: OLD, quantity: 6 }],
          },
          {
            product_id: PRODUCT,
            quantity: 3,
            unit_price: 7.9,
            batch_allocations: [
              { batch_id: OLD, quantity: 0.5 },
              { batch_id: NEW, quantity: 2.5 },
            ],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const askedManualPath = client.mock.calls.some((c) =>
      flat(c[0]).includes("i.quantity AS available"),
    );
    expect(askedManualPath).toBe(false);
  });

  it("сума на разпределението ≠ количеството → 400, нищо не се изписва", async () => {
    const { client, newAllocations } = warehouse();
    mockTx.mockImplementation(async (cb: any) => cb({ query: client }));
    app = await buildApp();

    const res = await app.inject({
      method: "PUT",
      url: "/orders/284",
      payload: {
        items: [
          {
            product_id: PRODUCT,
            quantity: 6,
            unit_price: 7.9,
            batch_allocations: [{ batch_id: OLD, quantity: 5 }],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("не съвпада с количеството");
    expect(newAllocations).toHaveLength(0);
  });

  it("партида от друг продукт се отказва", async () => {
    const { client } = warehouse();
    mockTx.mockImplementation(async (cb: any) => cb({ query: client }));
    app = await buildApp();

    const res = await app.inject({
      method: "PUT",
      url: "/orders/284",
      payload: {
        items: [
          {
            product_id: PRODUCT,
            quantity: 6,
            unit_price: 7.9,
            batch_allocations: [{ batch_id: 999, quantity: 6 }],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("не е от този продукт");
  });
});
