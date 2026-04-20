import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
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

describe("products duplicate SKU protection", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("returns 409 when creating a product with an existing SKU", async () => {
    mockQuery.mockResolvedValueOnce(
      resultRows([{ id: 42, name_bg: "Фета" }]),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/products",
        payload: {
          name_bg: "Ново сирене",
          name_en: "New cheese",
          sku: "10001",
          unit: "kg",
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: "duplicate_sku",
        message: 'SKU "10001" вече се използва от "Фета".',
      });
      expect(mockQuery.mock.calls[0]?.[1]).toEqual(["10001"]);
    } finally {
      await app.close();
    }
  });

  it("returns 409 when updating a product to an existing SKU", async () => {
    mockQuery.mockResolvedValueOnce(
      resultRows([{ id: 7, name_bg: "Маслини" }]),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/products/9",
        payload: { sku: "20002" },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: "duplicate_sku",
        message: 'SKU "20002" вече се използва от "Маслини".',
      });
      const [sql, params] = mockQuery.mock.calls[0];
      expect(String(sql)).toContain("sku = $1 AND id <> $2");
      expect(params).toEqual(["20002", 9]);
    } finally {
      await app.close();
    }
  });
});