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
      const [sql, params] = mockQuery.mock.calls[0];
      expect(String(sql)).toContain(
        "WHEN LOWER(COALESCE(p.name_bg, '')) = $3 THEN 0",
      );
      expect(String(sql)).toContain(
        "WHEN LOWER(COALESCE(p.name_bg, '')) LIKE $4 THEN 1",
      );
      expect(String(sql)).toContain("ELSE 2");
      expect(params).toEqual([
        "сирене фета",
        "%сирене фета%",
        "сирене фета",
        "сирене фета%",
        "сирене фета",
        10,
        0,
      ]);
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
      const [sql, params] = mockQuery.mock.calls[0];
      expect(String(sql)).toContain(
        "WHEN LOWER(COALESCE(p.sku, '')) = $3 THEN 0",
      );
      expect(String(sql)).toContain(
        "WHEN LOWER(COALESCE(p.sku, '')) LIKE $4 THEN 1",
      );
      expect(params).toEqual([
        "KOS06005",
        "%KOS06005%",
        "kos06005",
        "kos06005%",
        "KOS06005",
        10,
        0,
      ]);
    } finally {
      await app.close();
    }
  });
});
