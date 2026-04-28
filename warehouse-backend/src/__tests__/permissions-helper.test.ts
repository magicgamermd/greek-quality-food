import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ query: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(),
}));

import { query } from "../db.js";
import { getRedis } from "../lib/redis.js";
import {
  getUserPermissions,
  hasPermission,
  invalidateUserPermissions,
  PERMISSIONS,
  requirePermission,
  stripFieldsForUser,
} from "../lib/permissions.js";
import Fastify from "fastify";

const mockQuery = vi.mocked(query);
const mockGetRedis = vi.mocked(getRedis);

function makeRedisMock() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    setex: vi.fn(async (k: string, _ttl: number, v: string) => {
      store.set(k, v);
      return "OK";
    }),
    del: vi.fn(async (k: string) => {
      const had = store.has(k);
      store.delete(k);
      return had ? 1 : 0;
    }),
  } as any;
}

describe("getUserPermissions", () => {
  let redisMock: ReturnType<typeof makeRedisMock>;

  beforeEach(() => {
    redisMock = makeRedisMock();
    mockGetRedis.mockResolvedValue(redisMock);
    mockQuery.mockReset();
  });

  it("returns role defaults when no overrides present", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: "sales", overrides: [] }],
    } as any);

    const perms = await getUserPermissions("u1");

    expect(perms.has(PERMISSIONS.ORDERS_MANAGE)).toBe(true);
    expect(perms.has(PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE)).toBe(false);
  });

  it("applies grant overrides on top of role defaults", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          role: "sales",
          overrides: [
            { permission: PERMISSIONS.INVOICES_CANCEL, granted: true },
          ],
        },
      ],
    } as any);

    const perms = await getUserPermissions("u1");
    expect(perms.has(PERMISSIONS.INVOICES_CANCEL)).toBe(true);
  });

  it("applies revoke overrides on top of role defaults", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          role: "sales",
          overrides: [
            { permission: PERMISSIONS.ORDERS_MANAGE, granted: false },
          ],
        },
      ],
    } as any);

    const perms = await getUserPermissions("u1");
    expect(perms.has(PERMISSIONS.ORDERS_MANAGE)).toBe(false);
  });

  it("returns empty set for unknown user", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);
    const perms = await getUserPermissions("nope");
    expect(perms.size).toBe(0);
  });

  it("caches result and avoids second DB call", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: "sales", overrides: [] }],
    } as any);

    await getUserPermissions("u1");
    await getUserPermissions("u1");

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(redisMock.setex).toHaveBeenCalledTimes(1);
  });

  it("invalidateUserPermissions forces fresh DB query", async () => {
    mockQuery.mockResolvedValue({
      rows: [{ role: "sales", overrides: [] }],
    } as any);

    await getUserPermissions("u1");
    await invalidateUserPermissions("u1");
    await getUserPermissions("u1");

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(redisMock.del).toHaveBeenCalledWith("perms:user:u1");
  });
});

describe("hasPermission", () => {
  beforeEach(() => {
    mockGetRedis.mockResolvedValue(makeRedisMock());
    mockQuery.mockReset();
  });

  it("returns true for admin without consulting DB", async () => {
    const result = await hasPermission(
      { id: "admin1", role: "admin" },
      PERMISSIONS.SETTINGS_MANAGE,
    );
    expect(result).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns true when role default includes the permission", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: "sales", overrides: [] }],
    } as any);

    const result = await hasPermission(
      { id: "u1", role: "sales" },
      PERMISSIONS.ORDERS_MANAGE,
    );
    expect(result).toBe(true);
  });

  it("returns false when role default does not include and no override", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: "sales", overrides: [] }],
    } as any);

    const result = await hasPermission(
      { id: "u1", role: "sales" },
      PERMISSIONS.SETTINGS_MANAGE,
    );
    expect(result).toBe(false);
  });
});

describe("requirePermission middleware", () => {
  beforeEach(() => {
    mockGetRedis.mockResolvedValue(makeRedisMock());
    mockQuery.mockReset();
  });

  async function buildApp(role: string, userId = "u1") {
    const app = Fastify();
    app.addHook("onRequest", async (req) => {
      (req as any).user = { id: userId, email: "x@y", role };
    });
    app.get(
      "/protected",
      { preHandler: requirePermission(PERMISSIONS.SETTINGS_MANAGE) },
      async () => ({ ok: true }),
    );
    return app;
  }

  it("allows admin through without consulting DB", async () => {
    const app = await buildApp("admin");
    try {
      const res = await app.inject({ method: "GET", url: "/protected" });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("returns 403 when user lacks the permission", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: "sales", overrides: [] }],
    } as any);

    const app = await buildApp("sales");
    try {
      const res = await app.inject({ method: "GET", url: "/protected" });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        error: "Forbidden",
        required_permission: PERMISSIONS.SETTINGS_MANAGE,
      });
    } finally {
      await app.close();
    }
  });
});

describe("stripFieldsForUser", () => {
  beforeEach(() => {
    mockGetRedis.mockResolvedValue(makeRedisMock());
    mockQuery.mockReset();
  });

  it("removes purchase_price for sales user", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: "sales", overrides: [] }],
    } as any);

    const rows = [
      { id: 1, name: "Mixer", purchase_price: 200, selling_price: 350 },
    ];
    const filtered = await stripFieldsForUser(
      { id: "u1", role: "sales" },
      rows,
      [
        {
          permission: PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE,
          fields: ["purchase_price"],
        },
      ],
    );

    expect(filtered[0]).not.toHaveProperty("purchase_price");
    expect(filtered[0]).toHaveProperty("selling_price", 350);
  });

  it("keeps purchase_price for admin without consulting DB", async () => {
    const rows = [{ id: 1, purchase_price: 200 }];
    const filtered = await stripFieldsForUser(
      { id: "admin1", role: "admin" },
      rows,
      [
        {
          permission: PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE,
          fields: ["purchase_price"],
        },
      ],
    );
    expect(filtered[0].purchase_price).toBe(200);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("keeps purchase_price for sales user with grant override", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          role: "sales",
          overrides: [
            {
              permission: PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE,
              granted: true,
            },
          ],
        },
      ],
    } as any);

    const rows = [{ id: 1, purchase_price: 200 }];
    const filtered = await stripFieldsForUser(
      { id: "u1", role: "sales" },
      rows,
      [
        {
          permission: PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE,
          fields: ["purchase_price"],
        },
      ],
    );
    expect(filtered[0].purchase_price).toBe(200);
  });
});
