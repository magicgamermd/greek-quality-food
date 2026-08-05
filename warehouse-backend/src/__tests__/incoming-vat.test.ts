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

function callWith(clientQuery: any, fragment: string) {
  return clientQuery.mock.calls.find((c: any[]) =>
    String(c[0]).includes(fragment),
  );
}
function allCallsWith(clientQuery: any, fragment: string) {
  return clientQuery.mock.calls.filter((c: any[]) =>
    String(c[0]).includes(fragment),
  );
}

const PENDING = {
  id: 7,
  status: "pending",
  vat_rate: null,
  prices_include_vat: false,
};

/** 2 реда: 10 × 5.000 и 3 × 2.500 → без ДДС общо 57.50 */
const ITEMS = [
  { id: 30, quantity: "10", unit_price: "5.000", total_price: "50.00" },
  { id: 31, quantity: "3", unit_price: "2.500", total_price: "7.50" },
];

describe("ДДС по входяща доставка", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("режим към сумите: пази цените, само записва ставката", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(res([PENDING])) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce(
        res([{ ...PENDING, vat_rate: "20.00", prices_include_vat: false }]),
      ); // UPDATE header

    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/vat",
        payload: { mode: "totals", vat_rate: 20 },
      });

      expect(r.statusCode).toBe(200);
      expect(r.json().vat_rate).toBeCloseTo(20, 2);
      expect(r.json().prices_include_vat).toBe(false);

      // Нито един ред не е пипнат — цените остават без ДДС.
      expect(allCallsWith(clientQuery, "UPDATE incoming_items")).toHaveLength(
        0,
      );
    } finally {
      await app.close();
    }
  });

  it("режим към цените: умножава единичните цени веднъж и вдига флага", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(res([PENDING]))
      .mockResolvedValueOnce(res(ITEMS)) // SELECT редовете FOR UPDATE
      .mockResolvedValueOnce(res([], 1)) // UPDATE ред 30
      .mockResolvedValueOnce(res([], 1)) // UPDATE ред 31
      .mockResolvedValueOnce(res([{ total: "69.00" }])) // преизчисление на header
      .mockResolvedValueOnce(
        res([{ ...PENDING, vat_rate: "20.00", prices_include_vat: true }]),
      );

    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/vat",
        payload: { mode: "prices", vat_rate: 20 },
      });

      expect(r.statusCode).toBe(200);
      expect(r.json().prices_include_vat).toBe(true);

      const updates = allCallsWith(clientQuery, "UPDATE incoming_items");
      expect(updates).toHaveLength(2);
      // 5.000 × 1.20 = 6.000 (3 знака, както е колоната) и 10 × 6 = 60.00
      expect(updates[0][1][0]).toBeCloseTo(6, 3);
      expect(updates[0][1][1]).toBeCloseTo(60, 2);
      // 2.500 × 1.20 = 3.000 и 3 × 3 = 9.00
      expect(updates[1][1][0]).toBeCloseTo(3, 3);
      expect(updates[1][1][1]).toBeCloseTo(9, 2);
    } finally {
      await app.close();
    }
  });

  it("отказва второ прилагане към цените (иначе ×1.44)", async () => {
    const clientQuery = vi.fn().mockResolvedValueOnce(
      res([{ ...PENDING, vat_rate: "20.00", prices_include_vat: true }]),
    );
    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/vat",
        payload: { mode: "prices", vat_rate: 20 },
      });

      expect(r.statusCode).toBe(409);
      expect(r.json().message).toMatch(/вече/i);
      expect(allCallsWith(clientQuery, "UPDATE incoming_items")).toHaveLength(
        0,
      );
    } finally {
      await app.close();
    }
  });

  it("режим без ДДС: връща вградените цени обратно", async () => {
    const withVat = [
      { id: 30, quantity: "10", unit_price: "6.000", total_price: "60.00" },
      { id: 31, quantity: "3", unit_price: "3.000", total_price: "9.00" },
    ];
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(
        res([{ ...PENDING, vat_rate: "20.00", prices_include_vat: true }]),
      )
      .mockResolvedValueOnce(res(withVat))
      .mockResolvedValueOnce(res([], 1))
      .mockResolvedValueOnce(res([], 1))
      .mockResolvedValueOnce(res([{ total: "57.50" }]))
      .mockResolvedValueOnce(
        res([{ ...PENDING, vat_rate: null, prices_include_vat: false }]),
      );

    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/vat",
        payload: { mode: "none" },
      });

      expect(r.statusCode).toBe(200);
      const updates = allCallsWith(clientQuery, "UPDATE incoming_items");
      expect(updates).toHaveLength(2);
      // Обратно на 5.000 и 2.500 — точно откъдето тръгнахме.
      expect(updates[0][1][0]).toBeCloseTo(5, 3);
      expect(updates[1][1][0]).toBeCloseTo(2.5, 3);
    } finally {
      await app.close();
    }
  });

  it("отказва промяна на ДДС по ПОТВЪРДЕНА доставка", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(res([{ ...PENDING, status: "confirmed" }]));
    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/vat",
        payload: { mode: "prices", vat_rate: 20 },
      });

      expect(r.statusCode).toBe(400);
      expect(r.json().message).toMatch(/потвърден/i);
    } finally {
      await app.close();
    }
  });

  it("отказва ставка извън 0–100", async () => {
    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/vat",
        payload: { mode: "totals", vat_rate: 120 },
      });
      expect(r.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
