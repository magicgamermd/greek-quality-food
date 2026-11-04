// Редакция на партньор (04.11.2026: „не можем да редактираме партньорите“).
// Освен че моливчето беше извън екрана, записът падаше за партньори със
// стар ЕИК от импорта („2062119169“, „10394675B“), за празна отстъпка и
// с грешка 500 и суров JSON вместо разбираем текст.
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import partnerRoutes from "../routes/partners.js";
import {
  normalizeEik,
  partnerUpdateSchema,
} from "../routes/partner-schemas.js";

vi.mock("../db.js", () => ({
  query: vi.fn(),
}));

import { query } from "../db.js";

const mockQuery = vi.mocked(query);

function rows<T>(list: T[]) {
  return { rows: list, rowCount: list.length } as any;
}

async function put(id: number, payload: Record<string, unknown>) {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = { id: "u-admin", email: "a@t", role: "admin" };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(partnerRoutes, { prefix: "/partners" });
  try {
    return await app.inject({ method: "PUT", url: `/partners/${id}`, payload });
  } finally {
    await app.close();
  }
}

/** Заявките към базата: текущият ЕИК, после UPDATE. */
function db(currentEik: string | null) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  mockQuery.mockImplementation(async (sql: any, params: any = []) => {
    calls.push({ sql: String(sql), params });
    if (/SELECT eik FROM partners/.test(String(sql))) {
      return rows([{ eik: currentEik }]);
    }
    if (/^UPDATE partners/.test(String(sql))) {
      return rows([{ id: 644, name: "КРЕЙЗИ КЪМПАНИ ЕООД" }]);
    }
    return rows([]);
  });
  return calls;
}

const update = (calls: Array<{ sql: string; params: any[] }>) =>
  calls.find((c) => /^UPDATE partners/.test(c.sql));

describe("PUT /partners/:id — редакция", () => {
  beforeEach(() => mockQuery.mockReset());

  it("стар ЕИК от импорта, непроменен → записът минава, ЕИК не се пипа", async () => {
    const calls = db("2062119169");
    const res = await put(644, {
      name: "КРЕЙЗИ КЪМПАНИ ЕООД",
      eik: "2062119169",
      phone: "0888 123 456",
      discount_percent: "",
    });
    expect(res.statusCode).toBe(200);
    const sql = update(calls)!;
    expect(sql.sql).not.toMatch(/\beik =/);
    expect(sql.sql).toMatch(/phone =/);
    // празната отстъпка става 0, не грешка 500
    expect(sql.params).toContain(0);
  });

  it("нов невалиден ЕИК → 400 с разбираем текст (не 500 със суров JSON)", async () => {
    const calls = db("205024473");
    const res = await put(489, { name: "Биляна 2018-ЕООД", eik: "12345" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("ЕИК: ЕИК трябва да е 9 или 13 цифри");
    expect(update(calls)).toBeUndefined();
  });

  it("„ВG205024473“ (кирилско В) и „BG 201872808“ → само цифрите", async () => {
    const calls = db("ВG205024473");
    const res = await put(489, { name: "Биляна 2018-ЕООД", eik: "205024473" });
    // нормализираният стар ЕИК съвпада → не се пипа
    expect(res.statusCode).toBe(200);
    expect(update(calls)!.sql).not.toMatch(/\beik =/);
    expect(normalizeEik("BG 201872808")).toBe("201872808");
    expect(normalizeEik("ВG205024473")).toBe("205024473");
  });

  it("отстъпка извън 0–100 → 400", async () => {
    db("123456789");
    const res = await put(1, { name: "X", discount_percent: "150" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Отстъпка %/);
  });

  it("схемата: „12,5“ → 12.5, празно → 0", () => {
    const comma = partnerUpdateSchema.safeParse({ discount_percent: "12,5" });
    expect(comma.success && comma.data.discount_percent).toBe(12.5);
    const empty = partnerUpdateSchema.safeParse({ discount_percent: "" });
    expect(empty.success && empty.data.discount_percent).toBe(0);
  });
});
