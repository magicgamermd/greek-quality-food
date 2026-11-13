// Смяна на цена в НЕИЗПЪЛНЕНА поръчка, чиято избрана партида междувременно
// е изчерпана (поръчка №453, 13.11.2026): стоката е излязла със стоковата
// разписка на 07.11, поръчката остава „Потвърдена“, а на 10.11 №466 изписва
// същата партида „Мини мартички“ → остават 0,18 кг. Редакцията проверяваше
// наново наличността на НЕПИПНАТОТО разпределение и отказваше смяната на
// цената: „налични 0.18, избрани 2.366“.
//
// Правилото: каквото поръчката вече е имала от партидата, не се проверява
// наново (нито наличност, нито срок) — нищо ново не се иска от склада.
// Проверява се само, когато се иска ПОВЕЧЕ от партидата или друга партида.
// Истинската проверка остава при изпълнение.
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
const flat = (sql: unknown) => String(sql).replace(/\s+/g, " ").trim();

const ORDER = 457; // №453
const PRODUCT = 1779; // Мини мартички
const PLANNED = 1416; // срок 06.06.2027, останали 0,18
const OTHER = 1083; // друга партида с 1 кг
const LAPSED = 965; // партида с изтекъл срок

interface StoredLine {
  product_id: number;
  quantity: number;
  batch_plan: { batch_id: number; quantity: number }[] | null;
}

function world({
  stored = [
    {
      product_id: PRODUCT,
      quantity: 2.366,
      batch_plan: [{ batch_id: PLANNED, quantity: 2.366 }],
    },
  ],
}: { stored?: StoredLine[] } = {}) {
  const stock = new Map<number, number>([
    [PLANNED, 0.18],
    [OTHER, 1],
    [LAPSED, 5],
  ]);
  const batches = new Map<number, any>([
    [
      PLANNED,
      {
        id: PLANNED,
        product_id: PRODUCT,
        batch_number: "АВТО-88-565",
        expiry_date: "2099-06-06",
      },
    ],
    [
      OTHER,
      {
        id: OTHER,
        product_id: PRODUCT,
        batch_number: "АВТО-34-231",
        expiry_date: "2099-04-14",
      },
    ],
    [
      LAPSED,
      {
        id: LAPSED,
        product_id: PRODUCT,
        batch_number: "08072026",
        expiry_date: "2000-03-05",
      },
    ],
  ]);
  const insertedLines: any[] = [];
  const order = {
    id: ORDER,
    order_number: 453,
    status: "confirmed",
    partner_id: 1,
    invoice_id: null,
  };
  let lineId = 3000;

  const handler = vi.fn(async (sql: string, params: any[] = []) => {
    const q = flat(sql);
    if (q.startsWith("SELECT * FROM orders WHERE id")) return rows([order]);
    if (q.startsWith("UPDATE orders SET updated_at")) return rows([order]);
    if (q.startsWith("UPDATE orders SET total_amount")) return rows([]);
    if (q.includes("FROM partners"))
      return rows([{ id: 1, name: "ДАР Г.Н. ООД", price_list_id: null }]);
    if (q.includes("FROM products") && q.includes("ANY"))
      return rows([
        {
          id: PRODUCT,
          name_bg: "Мини мартички. 55гр. - 45бр/каш.",
          name_en: "Mini",
          sku: "im212053",
          selling_price: "10.51",
          purchase_price: "5",
        },
      ]);
    // Досегашното разпределение на поръчката (преди да се изтрият редовете).
    if (q.startsWith("SELECT product_id, batch_plan FROM order_items"))
      return rows(
        stored
          .filter((line) => line.batch_plan)
          .map((line) => ({
            product_id: line.product_id,
            batch_plan: line.batch_plan,
          })),
      );
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
        unit_price: String(params[3]),
        batch_id: params[11],
        batch_plan: params[12],
      };
      insertedLines.push(row);
      return rows([row]);
    }
    if (q.includes("SUM(")) return rows([{ total: "21.32" }]);
    return rows([]);
  });

  return { handler, stock, batches, insertedLines };
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

const line = (overrides: Record<string, unknown> = {}) => ({
  product_id: PRODUCT,
  quantity: 2.366,
  unit_price: 9.392,
  batch_id: PLANNED,
  ...overrides,
});

describe("редакция на неизпълнена поръчка с изчерпана избрана партида", () => {
  let app: FastifyInstance;
  beforeEach(() => vi.clearAllMocks());
  afterEach(async () => {
    await app?.close();
  });

  function wire(w: ReturnType<typeof world>) {
    mockQuery.mockImplementation(w.handler as any);
    mockTx.mockImplementation(async (cb: any) => cb({ query: w.handler }));
  }

  const save = (items: unknown[]) =>
    app.inject({
      method: "PUT",
      url: `/orders/${ORDER}`,
      payload: { items },
    });

  it("№453: само цената е сменена → записва се, разпределението остава", async () => {
    const w = world();
    wire(w);
    app = await buildApp();
    const res = await save([line()]);
    expect(res.statusCode).toBe(200);
    expect(w.insertedLines).toHaveLength(1);
    expect(w.insertedLines[0].unit_price).toBe("9.392");
    expect(w.insertedLines[0].batch_id).toBe(PLANNED);
    expect(JSON.parse(w.insertedLines[0].batch_plan)).toEqual([
      { batch_id: PLANNED, quantity: 2.366 },
    ]);
  });

  it("казва, че партидата вече не стига — преди изпълнение да се избере наново", async () => {
    const w = world();
    wire(w);
    app = await buildApp();
    const res = await save([line()]);
    const notes: string[] = res.json().warnings?.batch_plan ?? [];
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Мини мартички");
    expect(notes[0]).toContain("налични 0.18");
    expect(notes[0]).toContain("2.366");
  });

  it("партидата стига → без предупреждение", async () => {
    const w = world();
    w.stock.set(PLANNED, 10);
    wire(w);
    app = await buildApp();
    const res = await save([line()]);
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings?.batch_plan).toBeUndefined();
  });

  it("по-малко от същата партида → минава", async () => {
    const w = world();
    wire(w);
    app = await buildApp();
    const res = await save([line({ quantity: 2 })]);
    expect(res.statusCode).toBe(200);
    expect(w.insertedLines[0].quantity).toBe("2");
  });

  it("ПОВЕЧЕ от същата партида → отказ, както досега", async () => {
    const w = world();
    wire(w);
    app = await buildApp();
    const res = await save([line({ quantity: 3 })]);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("налични 0.18, избрани 3");
    expect(w.insertedLines).toHaveLength(0);
  });

  it("друга партида без достатъчно → отказ, както досега", async () => {
    const w = world();
    wire(w);
    app = await buildApp();
    const res = await save([line({ batch_id: OTHER })]);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("налични 1, избрани 2.366");
  });

  it("старото количество не се брои два пъти: два реда от партидата над досегашното → отказ", async () => {
    const w = world();
    wire(w);
    app = await buildApp();
    const res = await save([line(), line({ quantity: 1 })]);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("налични 0.18, избрани 3.366");
  });

  it("редът е разделен на два от същата партида със същия сбор → минава", async () => {
    const w = world();
    wire(w);
    app = await buildApp();
    const res = await save([line({ quantity: 1.366 }), line({ quantity: 1 })]);
    expect(res.statusCode).toBe(200);
    expect(w.insertedLines).toHaveLength(2);
  });

  it("избраната партида е изтекла междувременно → цената пак се сменя, с предупреждение", async () => {
    const w = world({
      stored: [
        {
          product_id: PRODUCT,
          quantity: 2,
          batch_plan: [{ batch_id: LAPSED, quantity: 2 }],
        },
      ],
    });
    wire(w);
    app = await buildApp();
    const res = await save([line({ quantity: 2, batch_id: LAPSED })]);
    expect(res.statusCode).toBe(200);
    const notes: string[] = res.json().warnings?.batch_plan ?? [];
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("изтекъл срок");
  });

  it("повече от изтекла партида → отказ", async () => {
    const w = world({
      stored: [
        {
          product_id: PRODUCT,
          quantity: 2,
          batch_plan: [{ batch_id: LAPSED, quantity: 2 }],
        },
      ],
    });
    wire(w);
    app = await buildApp();
    const res = await save([line({ quantity: 3, batch_id: LAPSED })]);
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("изтекъл срок");
  });

  it("ред без избрана партида (автоматично) → нищо не се проверява", async () => {
    const w = world({
      stored: [{ product_id: PRODUCT, quantity: 2.366, batch_plan: null }],
    });
    wire(w);
    app = await buildApp();
    const res = await save([line({ batch_id: undefined })]);
    expect(res.statusCode).toBe(200);
    expect(w.insertedLines[0].batch_plan).toBeNull();
  });
});
