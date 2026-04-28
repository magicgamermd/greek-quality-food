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
} from "../lib/permissions.js";

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
