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
import ordersRoutes from "../routes/orders.js";
import incomingRoutes from "../routes/incoming.js";

const mockQuery = vi.mocked(query);

async function buildApp(routes: any, prefix: string, role: string) {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u1", email: "x@y", role };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(routes, { prefix });
  return app;
}

describe("orders permissions", () => {
  beforeEach(() => mockQuery.mockReset());

  it("sales user can list orders (has orders.manage)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: "sales", overrides: [] }],
    } as any);
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);

    const app = await buildApp(ordersRoutes, "/orders", "sales");
    try {
      const res = await app.inject({ method: "GET", url: "/orders" });
      expect([200, 304]).toContain(res.statusCode);
    } finally {
      await app.close();
    }
  });
});

describe("incoming permissions", () => {
  beforeEach(() => mockQuery.mockReset());

  it("sales user gets 403 on incoming list (lacks incoming.manage)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: "sales", overrides: [] }],
    } as any);

    const app = await buildApp(incomingRoutes, "/incoming", "sales");
    try {
      const res = await app.inject({ method: "GET", url: "/incoming" });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("warehouse user can list incoming (has incoming.manage)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: "warehouse", overrides: [] }],
    } as any);
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);

    const app = await buildApp(incomingRoutes, "/incoming", "warehouse");
    try {
      const res = await app.inject({ method: "GET", url: "/incoming" });
      expect([200, 304]).toContain(res.statusCode);
    } finally {
      await app.close();
    }
  });
});
