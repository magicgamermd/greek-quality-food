import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub db.js so booting the full app doesn't open a real Postgres pool.
// /agent/health calls SELECT 1 — return a successful empty rowset so the
// handler treats the database as connected.
vi.mock("../db.js", () => ({
  default: { end: vi.fn().mockResolvedValue(undefined) },
  query: vi.fn(async () => ({ rows: [] })),
  getClient: vi.fn(),
  transaction: vi.fn(),
}));

describe("/agent routes", () => {
  const originalKey = process.env.INTERNAL_API_KEY;

  beforeEach(() => {
    delete process.env.INTERNAL_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.INTERNAL_API_KEY;
    } else {
      process.env.INTERNAL_API_KEY = originalKey;
    }
    vi.resetModules();
  });

  it("GET /agent/health without auth returns non-200", async () => {
    const { build } = await import("../index.js");
    const app = await build();
    try {
      const res = await app.inject({ method: "GET", url: "/agent/health" });
      expect(res.statusCode).not.toBe(200);
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("GET /agent/health with valid INTERNAL_API_KEY returns ok=true and service id", async () => {
    process.env.INTERNAL_API_KEY = "test-internal-key-agent";

    // Re-import build() so the onRequest hook re-registers with the freshly
    // set INTERNAL_API_KEY (the hook is wired only when the env var is
    // present at build time).
    vi.resetModules();
    const { build } = await import("../index.js");

    const app = await build();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/agent/health",
        headers: { authorization: "Bearer test-internal-key-agent" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.service).toBe("gqf-agent-api");
      expect(body.actor).toEqual({ id: "ai-service", role: "admin" });
    } finally {
      await app.close();
    }
  });

  it("GET /agent/health with wrong INTERNAL_API_KEY returns 401", async () => {
    process.env.INTERNAL_API_KEY = "test-internal-key-agent";

    vi.resetModules();
    const { build } = await import("../index.js");

    const app = await build();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/agent/health",
        headers: { authorization: "Bearer wrong-key" },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
