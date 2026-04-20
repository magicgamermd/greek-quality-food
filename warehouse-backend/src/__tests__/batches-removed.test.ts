import { describe, it, expect, vi } from "vitest";

// Stub db.js so building the full app doesn't try to connect to Postgres.
// We only care about whether routes are registered, not what they return
// when hit with a real query.
vi.mock("../db.js", () => ({
  default: { end: vi.fn().mockResolvedValue(undefined) },
  query: vi.fn(),
  getClient: vi.fn(),
  transaction: vi.fn(),
}));

import { build } from "../index.js";

describe("batches route removal (MERT-M)", () => {
  it("GET /batches returns 404 — endpoint no longer registered", async () => {
    const app = await build();
    try {
      const res = await app.inject({ method: "GET", url: "/batches" });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("GET /inventory/write-offs returns 404 — endpoint no longer registered", async () => {
    const app = await build();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/inventory/write-offs",
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
