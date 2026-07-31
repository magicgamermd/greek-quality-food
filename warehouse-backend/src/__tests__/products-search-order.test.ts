import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query } from "../db.js";
import productRoutes from "../routes/products.js";

const mockQuery = vi.mocked(query);

function resultRows<T>(rows: T[]) {
  return { rows } as any;
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

  await app.register(productRoutes, { prefix: "/products" });
  return app;
}

describe("products search ordering", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("ranks exact and prefix matches before generic contains matches in catalog search", async () => {
    mockQuery
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(resultRows([{ total: "0" }]))
      .mockResolvedValueOnce(resultRows([{ total: "0" }]))
      .mockResolvedValueOnce(resultRows([{ total: "0" }]));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/products?search=%D1%81%D0%B8%D1%80%D0%B5%D0%BD%D0%B5%20%D1%84%D0%B5%D1%82%D0%B0&limit=10&catalog=true",
      });

      expect(res.statusCode).toBe(200);
      const [sql, params = []] = mockQuery.mock.calls[0];
      // Номерата на параметрите ($N) зависят от броя думи в търсенето
      // (word-split-ът яде по 4 параметъра на дума) — затова маркерите
      // се проверяват без конкретни индекси. Падаше точно на това.
      expect(String(sql)).toMatch(
        /WHEN LOWER\(COALESCE\(p\.name_bg, ''\)\) = \$\d+ THEN 0/,
      );
      expect(String(sql)).toMatch(
        /WHEN LOWER\(COALESCE\(p\.name_bg, ''\)\) LIKE \$\d+ THEN 1/,
      );
      expect(String(sql)).toContain("ELSE 2");
      // Класиране: точното и префиксното съвпадение са в параметрите
      // (multi-word търсенето се разбива на думи + пълната фраза за
      // exact/prefix ранкинга).
      expect(params).toEqual(expect.arrayContaining(["сирене", "фета"]));
      expect(params).toEqual(
        expect.arrayContaining(["сирене фета", "сирене фета%"]),
      );
      expect(params.slice(-2)).toEqual([10, 0]);
    } finally {
      await app.close();
    }
  });

  it("supports exact SKU search in the products catalog via q alias", async () => {
    mockQuery
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(resultRows([{ total: "0" }]))
      .mockResolvedValueOnce(resultRows([{ total: "0" }]))
      .mockResolvedValueOnce(resultRows([{ total: "0" }]));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/products?q=KOS06005&limit=10&catalog=true",
      });

      expect(res.statusCode).toBe(200);
      const [sql, params = []] = mockQuery.mock.calls[0];
      // Без конкретни $N — виж коментара в горния тест.
      expect(String(sql)).toMatch(
        /WHEN LOWER\(COALESCE\(p\.sku, ''\)\) = \$\d+ THEN 0/,
      );
      expect(String(sql)).toMatch(
        /WHEN LOWER\(COALESCE\(p\.sku, ''\)\) LIKE \$\d+ THEN 1/,
      );
      // q alias-ът минава през същия search пайплайн: думата за
      // съвпадение + exact/prefix за класирането + пагинация.
      expect(params).toEqual(
        expect.arrayContaining(["KOS06005", "kos06005", "kos06005%"]),
      );
      expect(params.slice(-2)).toEqual([10, 0]);
    } finally {
      await app.close();
    }
  });
});
