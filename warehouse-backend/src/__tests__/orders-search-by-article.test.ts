// Integration tests for the GET /orders ?article= filter (Batch C).
// Pattern follows orders-incoming-permissions.test.ts.
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const mockQuery = vi.mocked(query);

async function buildApp(role = "admin") {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u1", email: "x@y", role };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(ordersRoutes, { prefix: "/orders" });
  return app;
}

describe("GET /orders ?article= filter", () => {
  let app: any;

  beforeEach(() => mockQuery.mockReset());
  afterEach(async () => {
    if (app) await app.close();
  });

  it("does not apply the filter when ?article= is empty whitespace", async () => {
    // Permission check (admin short-circuits requirePermission, but
    // the GET /orders route uses requireAuth, not requirePermission,
    // so no permissions query happens here)
    mockQuery
      // 1. main SELECT
      .mockResolvedValueOnce({ rows: [] } as any)
      // 2. count SELECT
      .mockResolvedValueOnce({ rows: [{ total: "0" }] } as any);

    app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/orders?article=%20%20",
    });
    expect(res.statusCode).toBe(200);

    const sqlCall = mockQuery.mock.calls.find((c: any) =>
      String(c[0]).includes("SELECT o.*"),
    );
    expect(sqlCall).toBeDefined();
    expect(String(sqlCall![0])).not.toMatch(/EXISTS/);
  });

  it("applies EXISTS filter (snapshot columns) when ?article= is non-empty", async () => {
    mockQuery
      // 1. main SELECT
      .mockResolvedValueOnce({
        rows: [{ id: 1, partner_name: "Партньор" }],
      } as any)
      // 2. matched_items enrichment
      .mockResolvedValueOnce({
        rows: [{ order_id: 1, name_bg: "Скара X", sku: "MBG-1" }],
      } as any)
      // 3. count
      .mockResolvedValueOnce({ rows: [{ total: "1" }] } as any);

    app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/orders?article=%D1%81%D0%BA%D0%B0%D1%80%D0%B0", // "скара"
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const data = body.data;
    expect(Array.isArray(data)).toBe(true);
    expect(data[0].matched_items).toEqual([
      { name_bg: "Скара X", sku: "MBG-1" },
    ]);

    const mainSql = String(
      mockQuery.mock.calls.find((c: any) =>
        String(c[0]).includes("SELECT o.*"),
      )![0],
    );
    expect(mainSql).toMatch(/EXISTS/);
    // Crucial: must read from snapshot columns, not products JOIN.
    expect(mainSql).toMatch(/oi\.name_bg_snapshot/);
    expect(mainSql).toMatch(/oi\.sku_snapshot/);
    expect(mainSql).not.toMatch(/JOIN products p_oi/);
  });

  it("does NOT include matched_items when ?article= is absent", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, partner_name: "P" }],
      } as any)
      .mockResolvedValueOnce({ rows: [{ total: "1" }] } as any);

    app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/orders" });
    const body = JSON.parse(res.body);
    expect(body.data[0]).not.toHaveProperty("matched_items");
  });

  it("combines ?article= with ?date_from= / ?date_to=", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] } as any) // main
      .mockResolvedValueOnce({ rows: [{ total: "0" }] } as any); // count

    app = await buildApp();
    await app.inject({
      method: "GET",
      url: "/orders?article=%D1%81%D0%BA%D0%B0%D1%80%D0%B0&date_from=2026-04-01&date_to=2026-04-30",
    });

    const mainSql = String(
      mockQuery.mock.calls.find((c: any) =>
        String(c[0]).includes("SELECT o.*"),
      )![0],
    );
    expect(mainSql).toMatch(/EXISTS/);
    expect(mainSql).toMatch(/order_date.*>=/);
    expect(mainSql).toMatch(/order_date.*<=/);
  });
});
