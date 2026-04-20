import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query } from "../db.js";
import inventoryRoutes from "../routes/inventory.js";

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

  await app.register(inventoryRoutes, { prefix: "/inventory" });
  return app;
}

describe("inventory search ordering", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("ranks exact and prefix product matches before generic contains matches", async () => {
    mockQuery
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(resultRows([{ total: "0" }]));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/inventory?search=%D1%81%D0%B8%D1%80%D0%B5%D0%BD%D0%B5%20%D1%84%D0%B5%D1%82%D0%B0&limit=25",
      });

      expect(res.statusCode).toBe(200);
      expect(mockQuery).toHaveBeenCalledTimes(2);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(String(sql)).toContain(
        "WHEN LOWER(COALESCE(p.name_bg, '')) = $3 THEN 0",
      );
      expect(String(sql)).toContain(
        "WHEN LOWER(COALESCE(p.name_bg, '')) LIKE $4 THEN 1",
      );
      expect(String(sql)).toContain("ELSE 2");
      expect(String(sql)).toContain("LIMIT $5 OFFSET $6");
      expect(params).toEqual([
        "сирене фета",
        "%сирене фета%",
        "сирене фета",
        "сирене фета%",
        25,
        0,
      ]);
    } finally {
      await app.close();
    }
  });

  it("supports SKU search and no-expiry inventory filter", async () => {
    mockQuery
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(resultRows([{ total: "0" }]));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/inventory?search=10001&no_expiry=true&limit=25",
      });

      expect(res.statusCode).toBe(200);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(String(sql)).toContain(
        "WHEN LOWER(COALESCE(p.sku, '')) = $3 THEN 0",
      );
      expect(String(sql)).toContain(
        "COUNT(inv.product_id) > 0 AND COUNT(CASE WHEN inv.batch_id IS NULL OR b.expiry_date IS NULL THEN 1 END) > 0",
      );
      expect(params).toEqual(["10001", "%10001%", "10001", "10001%", 25, 0]);
    } finally {
      await app.close();
    }
  });
});
