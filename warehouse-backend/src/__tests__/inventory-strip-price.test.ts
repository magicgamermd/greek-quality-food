import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setex: vi.fn(async () => "OK"),
    del: vi.fn(async () => 0),
  })),
}));

import { query } from "../db.js";
import inventoryRoutes from "../routes/inventory.js";

const mockQuery = vi.mocked(query);

async function buildApp(role: string) {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u1", email: "x@y", role };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(inventoryRoutes, { prefix: "/inventory" });
  return app;
}

const sampleRow = {
  id: 1,
  sku: "SKU-1",
  name_bg: "Test product",
  total_stock: 10,
  selling_price: "100.00",
  purchase_price: "60.00",
};

describe("inventory purchase_price stripping", () => {
  beforeEach(() => mockQuery.mockReset());

  it("strips purchase_price for sales user", async () => {
    // Inventory GET fires data query then count query, then stripFieldsForUser
    // calls hasPermission -> getUserPermissions which queries the users table.
    mockQuery.mockResolvedValueOnce({ rows: [sampleRow] } as any); // data
    mockQuery.mockResolvedValueOnce({ rows: [{ total: "1" }] } as any); // count
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: "sales", overrides: [] }],
    } as any); // perms lookup

    const app = await buildApp("sales");
    try {
      const res = await app.inject({ method: "GET", url: "/inventory" });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      const items = Array.isArray(data) ? data : (data.data ?? []);
      expect(items[0]).not.toHaveProperty("purchase_price");
      expect(items[0]).toHaveProperty("selling_price", "100.00");
    } finally {
      await app.close();
    }
  });

  it("keeps purchase_price for accountant user", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [sampleRow] } as any); // data
    mockQuery.mockResolvedValueOnce({ rows: [{ total: "1" }] } as any); // count
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: "accountant", overrides: [] }],
    } as any); // perms lookup

    const app = await buildApp("accountant");
    try {
      const res = await app.inject({ method: "GET", url: "/inventory" });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      const items = Array.isArray(data) ? data : (data.data ?? []);
      expect(items[0].purchase_price).toBe("60.00");
    } finally {
      await app.close();
    }
  });

  it("keeps purchase_price for admin user", async () => {
    // Admin short-circuits hasPermission without DB lookup, so only data + count.
    mockQuery.mockResolvedValueOnce({ rows: [sampleRow] } as any); // data
    mockQuery.mockResolvedValueOnce({ rows: [{ total: "1" }] } as any); // count

    const app = await buildApp("admin");
    try {
      const res = await app.inject({ method: "GET", url: "/inventory" });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      const items = Array.isArray(data) ? data : (data.data ?? []);
      expect(items[0].purchase_price).toBe("60.00");
    } finally {
      await app.close();
    }
  });
});
