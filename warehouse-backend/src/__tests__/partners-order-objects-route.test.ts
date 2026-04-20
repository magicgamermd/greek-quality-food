import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import partnerRoutes from "../routes/partners.js";

vi.mock("../db.js", () => ({
  query: vi.fn(),
}));

import { query } from "../db.js";

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

  await app.register(partnerRoutes, { prefix: "/partners" });
  return app;
}

describe("partner order objects route", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("returns partner-scoped reusable order objects", async () => {
    mockQuery
      .mockResolvedValueOnce(resultRows([{ id: 5 }]))
      .mockResolvedValueOnce(
        resultRows([
          {
            id: 11,
            partner_id: 5,
            object_name: "Store Sofia 11",
            object_code: "SOF-11",
            usage_count: 4,
            last_used_at: "2026-04-08T10:00:00.000Z",
          },
        ]),
      );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/partners/5/order-objects",
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        data: [
          {
            id: 11,
            partner_id: 5,
            object_name: "Store Sofia 11",
            object_code: "SOF-11",
            usage_count: 4,
            last_used_at: "2026-04-08T10:00:00.000Z",
          },
        ],
      });
      expect(mockQuery).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("rejects invalid partner id", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/partners/not-a-number/order-objects",
      });

      expect(res.statusCode).toBe(400);
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
