import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import orderRoutes from "../routes/orders.js";

// Mirror the mocking pattern from payments-route-filters.test.ts: mock
// the db module and inspect the SQL captured by the mock to verify the
// is_replacement filter clause is added to the WHERE.
vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query } from "../db.js";

const mockQuery = vi.mocked(query);

const resultRows = <T>(rows: T[]) => ({ rows }) as any;

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
  await app.register(orderRoutes, { prefix: "/orders" });
  return app;
}

describe("GET /orders — is_replacement filter", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("filters to replacements when is_replacement=true", async () => {
    // Main list + count query both return empty rows. The count query
    // expects { total: '0' }; an empty array is fine for length checks.
    mockQuery.mockResolvedValue(resultRows([]));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/orders?is_replacement=true",
      });
      expect(res.statusCode).toBe(200);

      // Find the GET /orders main list query (it joins orders with partners).
      const listCall = mockQuery.mock.calls.find((call: any[]) => {
        const text = String(call[0]);
        return text.includes("FROM orders o") && text.includes("partner_name");
      });
      expect(listCall).toBeDefined();

      const [sql, params] = listCall! as [string, any[]];
      // SQL must include the filter clause
      expect(sql).toMatch(/o\.is_replacement\s*=\s*\$\d+/);
      // The bound value must be the boolean true
      expect(params).toContain(true);
    } finally {
      await app.close();
    }
  });

  it("filters to non-replacements when is_replacement=false", async () => {
    mockQuery.mockResolvedValue(resultRows([]));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/orders?is_replacement=false",
      });
      expect(res.statusCode).toBe(200);

      const listCall = mockQuery.mock.calls.find((call: any[]) => {
        const text = String(call[0]);
        return text.includes("FROM orders o") && text.includes("partner_name");
      });
      expect(listCall).toBeDefined();

      const [sql, params] = listCall! as [string, any[]];
      expect(sql).toMatch(/o\.is_replacement\s*=\s*\$\d+/);
      expect(params).toContain(false);
    } finally {
      await app.close();
    }
  });

  it("does not add the filter when is_replacement is omitted", async () => {
    mockQuery.mockResolvedValue(resultRows([]));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/orders",
      });
      expect(res.statusCode).toBe(200);

      const listCall = mockQuery.mock.calls.find((call: any[]) => {
        const text = String(call[0]);
        return text.includes("FROM orders o") && text.includes("partner_name");
      });
      expect(listCall).toBeDefined();

      const [sql, params] = listCall! as [string, any[]];
      // No is_replacement clause when param is omitted.
      expect(sql).not.toMatch(/o\.is_replacement\s*=\s*\$/);
      // No boolean true/false in the param array (limit/offset are numbers).
      expect(params).not.toContain(true);
      expect(params).not.toContain(false);
    } finally {
      await app.close();
    }
  });
});
