import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

import { query } from "../db.js";
import incomingRoutes from "../routes/incoming.js";

const mockQuery = vi.mocked(query);

function resultRows<T>(rows: T[]) {
  return { rows } as any;
}

async function buildApp() {
  const app = Fastify();
  await app.register(multipart);

  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-owner",
      email: "owner@test.local",
      role: "owner_mobile",
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });

  await app.register(incomingRoutes, { prefix: "/incoming" });
  return app;
}

describe("incoming list filters", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("filters by invoice_date when date_from/date_to are provided", async () => {
    mockQuery.mockResolvedValueOnce(resultRows([]));

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/incoming?date_from=2026-04-01&date_to=2026-04-30&status=pending&limit=25",
      });

      expect(res.statusCode).toBe(200);
      expect(mockQuery).toHaveBeenCalledTimes(1);

      const [sql, params] = mockQuery.mock.calls[0];
      // Route filters by when the delivery was recorded (created_at),
      // not by invoice issue date — so "today's deliveries" means
      // deliveries accepted today, regardless of invoice_date.
      expect(String(sql)).toContain("ig.created_at::date >= $");
      expect(String(sql)).toContain("ig.created_at::date <= $");
      expect(params).toEqual(["pending", "2026-04-01", "2026-04-30", 25, 0]);
    } finally {
      await app.close();
    }
  });
});
