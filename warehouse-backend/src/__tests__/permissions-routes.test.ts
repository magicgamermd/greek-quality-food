import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ query: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setex: vi.fn(async () => "OK"),
    del: vi.fn(async () => 0),
  })),
}));

import { query } from "../db.js";
import usersRoutes from "../routes/users.js";

const mockQuery = vi.mocked(query);

async function buildApp(role: string, userId = "admin1") {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: userId, email: "x@y", role };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(usersRoutes, { prefix: "/users" });
  return app;
}

describe("GET /users/:id/permissions", () => {
  beforeEach(() => mockQuery.mockReset());

  it("returns role defaults + overrides + effective for non-admin user", async () => {
    // Lookup target user
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "u1", email: "ivan@mertm.bg", role: "sales", name: "Иван" }],
    } as any);
    // Lookup overrides with creator user join
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          permission: "invoices.cancel",
          granted: true,
          reason: "Test",
          created_at: new Date(),
          created_by_id: "admin1",
          created_by_email: "admin@mertm.bg",
          created_by_name: "Админ",
        },
      ],
    } as any);
    // getUserPermissions cache-miss query
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          role: "sales",
          overrides: [{ permission: "invoices.cancel", granted: true }],
        },
      ],
    } as any);

    const app = await buildApp("admin");
    try {
      const res = await app.inject({
        method: "GET",
        url: "/users/u1/permissions",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.user_id).toBe("u1");
      expect(body.role).toBe("sales");
      expect(body.role_defaults).toContain("orders.manage");
      expect(body.overrides).toHaveLength(1);
      expect(body.effective).toContain("invoices.cancel");
    } finally {
      await app.close();
    }
  });

  it("returns 403 when actor lacks users.manage", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: "sales", overrides: [] }],
    } as any);

    const app = await buildApp("sales", "u1");
    try {
      const res = await app.inject({
        method: "GET",
        url: "/users/other/permissions",
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

describe("PATCH /users/:id/permissions/:permission", () => {
  beforeEach(() => mockQuery.mockReset());

  it("upserts override + writes audit + invalidates cache", async () => {
    // Target user lookup
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "u1", role: "sales" }],
    } as any);
    // UPSERT
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, granted: true, reason: "Test" }],
    } as any);
    // Audit insert
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 100 }],
    } as any);

    const app = await buildApp("admin");
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/users/u1/permissions/invoices.cancel",
        payload: { granted: true, reason: "Test" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.user_id).toBe("u1");
      expect(body.permission).toBe("invoices.cancel");
      expect(body.granted).toBe(true);
      expect(body.audit_event_id).toBe(100);
    } finally {
      await app.close();
    }
  });

  it("rejects 400 when target is admin (lockout protection)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "admin2", role: "admin" }],
    } as any);

    const app = await buildApp("admin");
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/users/admin2/permissions/invoices.cancel",
        payload: { granted: false },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("admin_lockout_protection");
    } finally {
      await app.close();
    }
  });

  it("rejects 400 when target is self", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "admin1", role: "admin" }],
    } as any);

    const app = await buildApp("admin", "admin1");
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/users/admin1/permissions/users.manage",
        payload: { granted: false },
      });
      expect([400]).toContain(res.statusCode);
    } finally {
      await app.close();
    }
  });

  it("rejects 400 for unknown permission", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "u1", role: "sales" }],
    } as any);

    const app = await buildApp("admin");
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/users/u1/permissions/bogus.permission",
        payload: { granted: true },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
