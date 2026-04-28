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
import invoiceRoutes from "../routes/invoices.js";

const mockQuery = vi.mocked(query);

async function buildApp(role: string, userId = "u1") {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: userId, email: "x@y", role };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(invoiceRoutes, { prefix: "/invoices" });
  return app;
}

describe("invoices route — sales role permissions", () => {
  beforeEach(() => mockQuery.mockReset());

  it("sales user can list invoices (has invoices.manage)", async () => {
    // permission lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: "sales", overrides: [] }],
    } as any);
    // actual list query (data)
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);
    // count query
    mockQuery.mockResolvedValueOnce({ rows: [{ total: "0" }] } as any);

    const app = await buildApp("sales");
    try {
      const res = await app.inject({ method: "GET", url: "/invoices" });
      expect([200, 304]).toContain(res.statusCode);
    } finally {
      await app.close();
    }
  });

  it("sales user gets 403 on cancel (lacks invoices.cancel)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: "sales", overrides: [] }],
    } as any);

    const app = await buildApp("sales");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/invoices/1/cancel",
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
