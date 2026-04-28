import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import invoiceRoutes from "../routes/invoices.js";
import paymentRoutes from "../routes/payments.js";
import inventoryRoutes from "../routes/inventory.js";
import incomingRoutes from "../routes/incoming.js";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setex: vi.fn(async () => "OK"),
    del: vi.fn(async () => 0),
  })),
}));

import { query } from "../db.js";

type Role = "admin" | "warehouse" | "accountant";

const mockQuery = vi.mocked(query);

function resultRows<T>(rows: T[]) {
  return { rows } as any;
}

async function buildAppWithRole(
  role: Role,
  registerRoute: any,
  prefix: string,
) {
  const app = Fastify();

  app.addHook("onRequest", async (request) => {
    (request as any).user = { id: "u-warehouse", email: "w@test.local", role };
    (request as any).jwtVerify = async () => (request as any).user;
  });

  await app.register(registerRoute, { prefix });
  return app;
}

describe("warehouse role route guards", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("forbids warehouse from invoices list", async () => {
    // permission lookup — warehouse role lacks INVOICES_MANAGE
    mockQuery.mockResolvedValueOnce(
      resultRows([{ role: "warehouse", overrides: [] }]),
    );

    const app = await buildAppWithRole("warehouse", invoiceRoutes, "/invoices");
    try {
      const res = await app.inject({ method: "GET", url: "/invoices" });

      expect(res.statusCode).toBe(403);
      // No business-logic queries should have been issued — only the
      // permission lookup (1 call) before the 403.
      expect(mockQuery).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("forbids warehouse from payments list", async () => {
    const app = await buildAppWithRole("warehouse", paymentRoutes, "/payments");
    try {
      const res = await app.inject({ method: "GET", url: "/payments" });

      expect(res.statusCode).toBe(403);
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("allows warehouse to read inventory list", async () => {
    mockQuery
      .mockResolvedValueOnce(resultRows([]))
      .mockResolvedValueOnce(resultRows([{ total: "0" }]));

    const app = await buildAppWithRole(
      "warehouse",
      inventoryRoutes,
      "/inventory",
    );
    try {
      const res = await app.inject({ method: "GET", url: "/inventory" });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        data: [],
        pagination: { page: 1, limit: 50, total: 0 },
      });
      expect(mockQuery).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("allows warehouse to read incoming list", async () => {
    mockQuery.mockResolvedValueOnce(resultRows([]));

    const app = await buildAppWithRole(
      "warehouse",
      incomingRoutes,
      "/incoming",
    );
    try {
      const res = await app.inject({ method: "GET", url: "/incoming" });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: [] });
      expect(mockQuery).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
