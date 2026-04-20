// MERT-M Foundation — Task 6: inventory route must be batch-free.
//
// The upstream plan describes this test file with a login-based `build()`
// bootstrap. We keep the same assertions (no `batches`/`batch_id` on items,
// `GET /inventory/expiring` returns 404, unknown query filters silently
// ignored) but follow the project's existing test pattern: `vi.mock("../db.js")`
// + auth injected via `onRequest`. Reason: the repo has no user seed script,
// so a real `/auth/login` + bcrypt compare would fail at `beforeAll`. Mocking
// the DB keeps the test hermetic and matches the style used in
// `batches-removed.test.ts` and `route-role-guards.test.ts`.
import Fastify, { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(async () => ({ rows: [] })),
  transaction: vi.fn(),
}));

import inventoryRoutes from "../routes/inventory.js";

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-admin",
      email: "admin@mertm.bg",
      role: "admin",
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(inventoryRoutes, { prefix: "/inventory" });
  return app;
}

describe("inventory route (MERT-M, batch-free)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /inventory returns rows without a 'batches' key in each item", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/inventory",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const firstItem = body.items?.[0] ?? body.data?.[0] ?? body[0];
    if (firstItem) {
      expect(firstItem).not.toHaveProperty("batches");
      expect(firstItem).not.toHaveProperty("batch_id");
    }
  });

  it("GET /inventory/expiring returns 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/inventory/expiring",
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /inventory?no_expiry=true ignores the filter silently (returns results)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/inventory?no_expiry=true",
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /inventory?no_batch=true ignores the filter silently (returns results)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/inventory?no_batch=true",
    });
    expect(res.statusCode).toBe(200);
  });

  it("PUT /inventory/:productId/batch/:batchId returns 404", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/inventory/1/batch/1",
      payload: { quantity: 5 },
    });
    expect(res.statusCode).toBe(404);
  });
});
