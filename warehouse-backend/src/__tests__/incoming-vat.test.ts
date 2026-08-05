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

const flat = (sql: unknown) => String(sql).replace(/\s+/g, " ").trim();

function allCallsWith(clientQuery: any, fragment: string) {
  return clientQuery.mock.calls.filter((c: any[]) =>
    flat(c[0]).includes(fragment),
  );
}

const PENDING = { id: 7, status: "pending", vat_rate: null };

describe("ДДС ставка по входяща доставка", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("записва ставката и НЕ пипа нито един ред", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(res([PENDING]))
      .mockResolvedValueOnce(
        res([{ id: 7, vat_rate: "20.00", total_amount: "57.50" }]),
      );

    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/vat",
        payload: { mode: "set", vat_rate: 20 },
      });

      expect(r.statusCode).toBe(200);
      expect(r.json().vat_rate).toBeCloseTo(20, 2);
      // Ядрото на изискването: цените остават непокътнати. По-ранна
      // версия ги умножаваше и така слагаше ДДС в себестойността.
      expect(allCallsWith(clientQuery, "UPDATE incoming_items")).toHaveLength(
        0,
      );
      expect(allCallsWith(clientQuery, "unit_price")).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("нулева ставка е позволена (гръцки доставчик, ВОП)", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(res([PENDING]))
      .mockResolvedValueOnce(
        res([{ id: 7, vat_rate: "0.00", total_amount: "57.50" }]),
      );
    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/vat",
        payload: { mode: "set", vat_rate: 0 },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().vat_rate).toBeCloseTo(0, 2);
    } finally {
      await app.close();
    }
  });

  it("режим none маха ставката, пак без да пипа цени", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(res([{ ...PENDING, vat_rate: "20.00" }]))
      .mockResolvedValueOnce(
        res([{ id: 7, vat_rate: null, total_amount: "57.50" }]),
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
      expect(r.json().vat_rate).toBeNull();
      expect(allCallsWith(clientQuery, "UPDATE incoming_items")).toHaveLength(
        0,
      );
    } finally {
      await app.close();
    }
  });

  it("отказва промяна по ПОТВЪРДЕНА доставка", async () => {
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
        payload: { mode: "set", vat_rate: 20 },
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
        payload: { mode: "set", vat_rate: 120 },
      });
      expect(r.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('старият режим „prices" вече не съществува', async () => {
    // Регресия: ако някой го върне, цените пак ще носят ДДС в
    // себестойността. Заявката трябва да се отхвърли като невалидна.
    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/incoming/7/vat",
        payload: { mode: "prices", vat_rate: 20 },
      });
      expect(r.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
