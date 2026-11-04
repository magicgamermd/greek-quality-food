// Групи на продукти и партньори (Microinvest, 04.11.2026): нова група,
// преименуване, сливане и масово местене — и че името не се повтаря без
// значение главни/малки букви (и на кирилица).
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(),
  transaction: vi.fn(),
}));

// Правата на роля без админ се четат от базата през кеш в Redis.
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setex: vi.fn(async () => "OK"),
    del: vi.fn(async () => 0),
  })),
}));

import { query, transaction } from "../db.js";
import {
  groupNameKey,
  groupRoutes,
  PARTNER_GROUPS,
  PRODUCT_GROUPS,
} from "../routes/groups.js";

const mockQuery = vi.mocked(query);
const mockTransaction = vi.mocked(transaction);

function rows<T>(list: T[], rowCount = list.length) {
  return { rows: list, rowCount } as any;
}

type Call = { sql: string; params: any[] };

async function call(
  kind: typeof PRODUCT_GROUPS,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
  role = "admin",
) {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = { id: "u-1", email: "a@t", role };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(groupRoutes(kind), { prefix: "/g" });
  try {
    return await app.inject({ method, url: `/g${url}`, payload });
  } finally {
    await app.close();
  }
}

/** Базата: съществуващите групи + запис на всяка заявка. */
function db(existing: Array<{ id: number; name: string }>) {
  const calls: Call[] = [];
  const handle = async (sql: any, params: any = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (/^SELECT id, name FROM (product|partner)_groups$/.test(text.trim())) {
      return rows(existing);
    }
    if (/INSERT INTO (product|partner)_groups/.test(text)) {
      return rows([{ id: 99, name: params[0], supplier_id: null }]);
    }
    if (/^UPDATE (product|partner)_groups SET name/.test(text.trim())) {
      return rows([{ id: Number(params[1]), name: params[0] }]);
    }
    if (/SELECT id FROM (product|partner)_groups WHERE id = ANY/.test(text)) {
      return rows(params[0].map((id: number) => ({ id })));
    }
    if (/SELECT id FROM (product|partner)_groups WHERE id = \$1/.test(text)) {
      return rows(existing.filter((g) => g.id === Number(params[0])));
    }
    if (/^UPDATE (products|partners) SET/.test(text.trim())) {
      return rows([], 3);
    }
    if (/^DELETE FROM/.test(text.trim())) {
      return rows([{ id: Number(params[0]) }]);
    }
    return rows([]);
  };
  mockQuery.mockImplementation(handle);
  mockTransaction.mockImplementation(async (fn: any) =>
    fn({ query: handle } as any),
  );
  return calls;
}

describe("групи — имена", () => {
  it("главни/малки и интервалите не правят нова група", () => {
    expect(groupNameKey("  ТЕСТ   група ")).toBe(groupNameKey("тест група"));
    expect(groupNameKey("VLASTI")).toBe(groupNameKey("Vlasti"));
  });
});

describe("/product-groups", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("нова група: името се чисти от излишни интервали", async () => {
    const calls = db([{ id: 1, name: "VLASTI" }]);
    const res = await call(PRODUCT_GROUPS, "POST", "/", {
      name: "  Сирена   Гърция ",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.name).toBe("Сирена Гърция");
    const insert = calls.find((c) => /INSERT INTO product_groups/.test(c.sql));
    expect(insert?.params).toEqual(["Сирена Гърция"]);
  });

  it("същото име с малки букви на кирилица → 409, не втора група", async () => {
    const calls = db([{ id: 5, name: "Магазин Русе" }]);
    const res = await call(PRODUCT_GROUPS, "POST", "/", {
      name: "магазин  русе",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Група „Магазин Русе“ вече има");
    expect(calls.some((c) => /INSERT INTO/.test(c.sql))).toBe(false);
  });

  it("празно име → 400 на български", async () => {
    db([]);
    const res = await call(PRODUCT_GROUPS, "POST", "/", { name: "   " });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Въведете име на групата");
  });

  it("преименуване в име на друга група → 409; в своето → минава", async () => {
    db([
      { id: 1, name: "VLASTI" },
      { id: 2, name: "IOANNOY" },
    ]);
    const clash = await call(PRODUCT_GROUPS, "PUT", "/2", { name: "vlasti" });
    expect(clash.statusCode).toBe(409);
    const own = await call(PRODUCT_GROUPS, "PUT", "/1", { name: "Vlasti" });
    expect(own.statusCode).toBe(200);
    expect(own.json().data).toEqual({ id: 1, name: "Vlasti" });
  });

  it("масово местене: само избраните, null = без група", async () => {
    const calls = db([{ id: 3, name: "FARM KOUKAKIS" }]);
    const res = await call(PRODUCT_GROUPS, "POST", "/move", {
      ids: [10, 11, 12],
      group_id: null,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.moved).toBe(3);
    const update = calls.find((c) => /^UPDATE products SET/.test(c.sql.trim()));
    expect(update?.sql).toMatch(/product_group_id = \$1::int/);
    expect(update?.params).toEqual([null, [10, 11, 12]]);
  });

  it("местене в несъществуваща група → 404; без избрани → 400", async () => {
    db([{ id: 3, name: "FARM KOUKAKIS" }]);
    const missing = await call(PRODUCT_GROUPS, "POST", "/move", {
      ids: [1],
      group_id: 77,
    });
    expect(missing.statusCode).toBe(404);
    const empty = await call(PRODUCT_GROUPS, "POST", "/move", {
      ids: [],
      group_id: 3,
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe("Няма избрани редове");
  });

  it("сливане: цялата група отива в другата, празната се изтрива", async () => {
    const calls = db([
      { id: 1, name: "A" },
      { id: 2, name: "B" },
    ]);
    const res = await call(PRODUCT_GROUPS, "POST", "/1/merge", {
      target_id: 2,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ moved: 3, target_id: 2 });
    const move = calls.find((c) => /^UPDATE products SET/.test(c.sql.trim()));
    expect(move?.params).toEqual([2, 1]);
    const del = calls.find((c) =>
      /^DELETE FROM product_groups/.test(c.sql.trim()),
    );
    expect(del?.params).toEqual([1]);
  });

  it("сливане със себе си → 400", async () => {
    db([{ id: 1, name: "A" }]);
    const res = await call(PRODUCT_GROUPS, "POST", "/1/merge", {
      target_id: 1,
    });
    expect(res.statusCode).toBe(400);
  });

  it("изтриване: членовете остават без група", async () => {
    const calls = db([{ id: 4, name: "Стара" }]);
    const res = await call(PRODUCT_GROUPS, "DELETE", "/4");
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ id: 4, released: 3 });
    const release = calls.find((c) =>
      /^UPDATE products SET/.test(c.sql.trim()),
    );
    expect(release?.sql).toMatch(/product_group_id = NULL/);
  });

  it("роля без право (Еконт) → 403 при запис", async () => {
    mockQuery.mockImplementation(async (sql: any) =>
      /FROM users u/.test(String(sql))
        ? rows([{ role: "econt", overrides: [] }])
        : rows([]),
    );
    const res = await call(
      PRODUCT_GROUPS,
      "POST",
      "/",
      { name: "X" },
      "econt",
    );
    expect(res.statusCode).toBe(403);
  });
});

describe("/partner-groups", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("списък: подреден по български, с броя партньори и без група", async () => {
    mockQuery.mockImplementation(async (sql: any) => {
      const text = String(sql);
      if (/FROM partner_groups g/.test(text)) {
        return rows([
          { id: 2, name: "Ресторант", supplier_id: null, member_count: 34 },
          { id: 3, name: "вериги", supplier_id: null, member_count: 2 },
          { id: 1, name: "Магазин", supplier_id: null, member_count: 11 },
        ]);
      }
      return rows([{ total_count: 424, ungrouped_count: 377 }]);
    });
    const res = await call(PARTNER_GROUPS, "GET", "/");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.map((g: any) => g.name)).toEqual([
      "вериги",
      "Магазин",
      "Ресторант",
    ]);
    expect(body.total_count).toBe(424);
    expect(body.ungrouped_count).toBe(377);
  });

  it("местене на партньори пипа partners, не products", async () => {
    const calls = db([{ id: 1, name: "Магазин" }]);
    const res = await call(PARTNER_GROUPS, "POST", "/move", {
      ids: [597],
      group_id: 1,
    });
    expect(res.statusCode).toBe(200);
    const update = calls.find((c) => /^UPDATE partners SET/.test(c.sql.trim()));
    expect(update?.sql).toMatch(/partner_group_id = \$1::int/);
    expect(calls.some((c) => /UPDATE products/.test(c.sql))).toBe(false);
  });
});
