import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ query: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setex: vi.fn(async () => "OK"),
    del: vi.fn(async () => 0),
  })),
}));

import { query } from "../db.js";
import authRoutes from "../routes/auth.js";

const mockQuery = vi.mocked(query);

async function buildApp(role: string) {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u1", email: "x@y.bg", role };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(authRoutes, { prefix: "/auth" });
  return app;
}

describe("GET /auth/me with permissions", () => {
  beforeEach(() => mockQuery.mockReset());

  it("returns user + permissions for sales role", async () => {
    // First query: SELECT user by id
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "u1",
          name: "Иван",
          email: "x@y.bg",
          role: "sales",
          created_at: new Date(),
        },
      ],
    } as any);
    // Second query: getUserPermissions -> role + overrides lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: "sales", overrides: [] }],
    } as any);

    const app = await buildApp("sales");
    try {
      const res = await app.inject({ method: "GET", url: "/auth/me" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.user.email).toBe("x@y.bg");
      expect(body.permissions).toContain("orders.manage");
      expect(body.permissions).not.toContain("inventory.view_purchase_price");
    } finally {
      await app.close();
    }
  });
});
