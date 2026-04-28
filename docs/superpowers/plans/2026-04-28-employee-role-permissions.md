# Employee Role + Per-User Permission Overrides — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `sales` role + 16-permission registry + per-user override system to MERT-M, with admin UI for permission management and `purchase_price` stripped from API responses for users without `inventory.view_purchase_price`.

**Architecture:** Permission set per user = role defaults XOR per-user overrides. Cached in Redis (TTL 60s, explicit invalidation). Backend strips sensitive fields based on permission. Frontend reads `/me` for permissions and gates UI via `<Can>` + `<RequirePermission>` components. Admin UI under `/settings/users/:id` shows permission matrix with per-row toggle.

**Tech Stack:** Fastify 5 / TS / pg / Redis 5 / Zod / Vitest 4 (backend); React 19 / TanStack Query 5 / Tailwind v4 / React Router (frontend); Playwright (E2E).

**Spec:** `docs/superpowers/specs/2026-04-28-employee-role-permissions-design.md`

---

## File Structure

### Created

**Backend:**

- `warehouse-backend/migrations/053_user_permissions.sql` — DB schema
- `warehouse-backend/src/lib/redis.ts` — Redis client singleton
- `warehouse-backend/src/lib/permissions.ts` — registry + helpers + middleware
- `warehouse-backend/src/routes/permissions.ts` — `GET /permissions/registry`
- `warehouse-backend/src/__tests__/permissions-helper.test.ts` — unit tests for the helper
- `warehouse-backend/src/__tests__/permissions-routes.test.ts` — integration tests for management endpoints
- `warehouse-backend/src/__tests__/role-regression.test.ts` — regression tests for legacy role behavior

**Frontend:**

- `warehouse-frontend/src/lib/permissions.ts` — TS Permission constants
- `warehouse-frontend/src/contexts/PermissionContext.tsx` — context + hook
- `warehouse-frontend/src/components/Can.tsx` — declarative gate
- `warehouse-frontend/src/components/RequirePermission.tsx` — route guard
- `warehouse-frontend/src/pages/admin/UsersListPage.tsx`
- `warehouse-frontend/src/pages/admin/UserDetailPage.tsx`
- `warehouse-frontend/src/pages/admin/components/PermissionMatrix.tsx`
- `warehouse-frontend/src/pages/admin/components/PermissionRow.tsx`
- `warehouse-frontend/src/pages/admin/components/OverrideDialog.tsx`
- `warehouse-frontend/src/pages/admin/components/RoleSelector.tsx`
- `warehouse-frontend/src/pages/admin/components/AuditTrail.tsx`

**E2E:**

- `e2e-tests/tests/permissions.spec.ts`

### Modified

**Backend:**

- `warehouse-backend/src/routes/auth.ts` — `/me` returns permissions
- `warehouse-backend/src/routes/users.ts` — add 3 permission management endpoints
- `warehouse-backend/src/index.ts` — register `/permissions` route
- `warehouse-backend/src/routes/invoices.ts` — replace 10 role checks
- `warehouse-backend/src/routes/orders.ts` — replace 8 role checks
- `warehouse-backend/src/routes/incoming.ts` — replace 7 role checks
- `warehouse-backend/src/routes/products.ts` — replace 3 role checks + strip price
- `warehouse-backend/src/routes/payments.ts` — replace 3 role checks
- `warehouse-backend/src/routes/partners.ts` — replace 3 role checks
- `warehouse-backend/src/routes/export.ts` — replace 2 role checks
- `warehouse-backend/src/routes/users.ts` — replace 1 role check
- `warehouse-backend/src/routes/settings.ts` — replace 1 role check
- `warehouse-backend/src/routes/import.ts` — replace 1 role check
- `warehouse-backend/src/routes/fiscal.ts` — replace 1 role check
- `warehouse-backend/src/routes/inventory.ts` — strip purchase_price from response

**Frontend:**

- `warehouse-frontend/src/App.tsx` — wrap in `<PermissionProvider>` + admin routes
- `warehouse-frontend/src/components/Layout.tsx` — replace `roles: [...]` with `permission`
- `warehouse-frontend/src/lib/api.ts` — 403 interceptor
- `warehouse-frontend/src/pages/Inventory.tsx` — `<Can>` around purchase price column
- `warehouse-frontend/src/pages/Products.tsx` — `<Can>` around purchase price + edit
- `warehouse-frontend/src/pages/Invoices.tsx` — `<Can>` around cancel button

---

## Patterns to follow (already in codebase)

- **Migration shape:** `migrations/049_payments_order_id.sql` (header comment explaining purpose, idempotent ALTERs)
- **Test setup:** `src/__tests__/payments-razpiska.test.ts` — `vi.mock("../db.js")`, Fastify inject, `onRequest` hook to inject `request.user`
- **Existing helper pattern:** `routes/invoices.ts:85` — `function canAccessInvoices(role: string)` (we'll replace these)
- **Frontend context pattern:** `src/contexts/AuthContext.tsx` — `createContext` + Provider + custom hook

---

# Phase 1 — Backend Foundation (5 tasks)

## Task 1: Database migration

**Files:**

- Create: `warehouse-backend/migrations/053_user_permissions.sql`

- [ ] **Step 1: Write the migration**

Content of `warehouse-backend/migrations/053_user_permissions.sql`:

```sql
-- 053_user_permissions.sql
-- Adds 'sales' role + per-user permission override table.
-- Purely additive: existing user roles are unchanged. Effective
-- permissions match prior behavior because role defaults computed
-- in code mirror today's scattered role checks.

BEGIN;

-- 1. Extend the role enum to include 'sales'
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'warehouse', 'accountant', 'sales'));

-- 2. New table for per-user permission overrides
CREATE TABLE IF NOT EXISTS user_permission_overrides (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission  TEXT NOT NULL,
  granted     BOOLEAN NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (user_id, permission)
);

CREATE INDEX IF NOT EXISTS idx_user_permission_overrides_user_id
  ON user_permission_overrides(user_id);

COMMIT;
```

- [ ] **Step 2: Apply migration**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
DATABASE_URL=$(grep "^DATABASE_URL=" .env | cut -d= -f2-)
psql "$DATABASE_URL" -f migrations/053_user_permissions.sql
```

Expected: `BEGIN`, `ALTER TABLE`, `ALTER TABLE`, `CREATE TABLE`, `CREATE INDEX`, `COMMIT` — no errors.

- [ ] **Step 3: Verify schema**

```bash
psql "$DATABASE_URL" -c "\d user_permission_overrides"
psql "$DATABASE_URL" -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='users_role_check';"
```

Expected: table has 7 columns, UNIQUE on `(user_id, permission)`; constraint includes `'sales'`.

- [ ] **Step 4: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/migrations/053_user_permissions.sql
git commit -m "feat(db): migration 053 — user_permission_overrides table + sales role"
```

---

## Task 2: Redis client singleton

**Files:**

- Create: `warehouse-backend/src/lib/redis.ts`

The codebase declares the `redis` package in `package.json` but no client is wired up. We add a singleton.

- [ ] **Step 1: Write the singleton**

Content of `warehouse-backend/src/lib/redis.ts`:

```typescript
import { createClient, type RedisClientType } from "redis";

let client: RedisClientType | null = null;
let connectPromise: Promise<RedisClientType> | null = null;

export async function getRedis(): Promise<RedisClientType> {
  if (client && client.isOpen) return client;
  if (connectPromise) return connectPromise;

  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      "REDIS_URL is not configured. Cannot use Redis-backed features.",
    );
  }

  connectPromise = (async () => {
    const c: RedisClientType = createClient({ url });
    c.on("error", (err) => {
      console.error("[redis] client error:", err);
    });
    await c.connect();
    client = c;
    return c;
  })();

  return connectPromise;
}

export async function closeRedis(): Promise<void> {
  if (client && client.isOpen) {
    await client.quit();
  }
  client = null;
  connectPromise = null;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx tsc --noEmit
```

Expected: no errors related to `lib/redis.ts`.

- [ ] **Step 3: Smoke test the connection**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
DATABASE_URL_DUMMY=x node --import tsx -e "
import { getRedis, closeRedis } from './src/lib/redis.ts';
const r = await getRedis();
await r.set('mertm:smoke', 'ok', { EX: 5 });
console.log('set ok');
const v = await r.get('mertm:smoke');
console.log('got:', v);
await closeRedis();
"
```

Expected output:

```
set ok
got: ok
```

- [ ] **Step 4: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/lib/redis.ts
git commit -m "feat(backend): Redis client singleton in lib/redis.ts"
```

---

## Task 3: Permission registry + role defaults

**Files:**

- Create: `warehouse-backend/src/lib/permissions.ts`

- [ ] **Step 1: Write the registry skeleton (constants only, no functions yet)**

Content of `warehouse-backend/src/lib/permissions.ts`:

```typescript
/**
 * Permission registry — central catalog of all permission flags.
 * Backend route checks reference these constants; admin UI gets the
 * full catalog via GET /permissions/registry.
 */

export const PERMISSIONS = {
  // Sales / commercial
  ORDERS_MANAGE: "orders.manage",
  INVOICES_MANAGE: "invoices.manage",
  INVOICES_CANCEL: "invoices.cancel",
  RAZPISKA_MANAGE: "razpiska.manage",
  ECONT_MANAGE: "econt.manage",
  // Inventory & stock
  INVENTORY_VIEW: "inventory.view",
  INVENTORY_VIEW_PURCHASE_PRICE: "inventory.view_purchase_price",
  INCOMING_MANAGE: "incoming.manage",
  // Master data
  PARTNERS_MANAGE: "partners.manage",
  PRODUCTS_VIEW: "products.view",
  PRODUCTS_MANAGE: "products.manage",
  // Accounting
  PAYMENTS_MANAGE: "payments.manage",
  REPORTS_VIEW: "reports.view",
  EXPORT_CREATE: "export.create",
  // System
  USERS_MANAGE: "users.manage",
  SETTINGS_MANAGE: "settings.manage",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export type UserRole = "admin" | "warehouse" | "accountant" | "sales";

/**
 * Role default permissions. Admin is special: the helper short-circuits
 * before consulting this map. Listing it here is intentional for
 * documentation / typing parity.
 */
export const ROLE_DEFAULTS: Record<UserRole, Permission[]> = {
  admin: Object.values(PERMISSIONS),
  accountant: [
    PERMISSIONS.INVOICES_MANAGE,
    PERMISSIONS.INVOICES_CANCEL,
    PERMISSIONS.RAZPISKA_MANAGE,
    PERMISSIONS.INVENTORY_VIEW,
    PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE,
    PERMISSIONS.INCOMING_MANAGE,
    PERMISSIONS.PARTNERS_MANAGE,
    PERMISSIONS.PRODUCTS_VIEW,
    PERMISSIONS.PAYMENTS_MANAGE,
    PERMISSIONS.REPORTS_VIEW,
    PERMISSIONS.EXPORT_CREATE,
  ],
  warehouse: [
    PERMISSIONS.ORDERS_MANAGE,
    PERMISSIONS.RAZPISKA_MANAGE,
    PERMISSIONS.ECONT_MANAGE,
    PERMISSIONS.INVENTORY_VIEW,
    PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE,
    PERMISSIONS.INCOMING_MANAGE,
    PERMISSIONS.PARTNERS_MANAGE,
    PERMISSIONS.PRODUCTS_VIEW,
    PERMISSIONS.PRODUCTS_MANAGE,
  ],
  sales: [
    PERMISSIONS.ORDERS_MANAGE,
    PERMISSIONS.INVOICES_MANAGE,
    PERMISSIONS.RAZPISKA_MANAGE,
    PERMISSIONS.ECONT_MANAGE,
    PERMISSIONS.INVENTORY_VIEW,
    // INVENTORY_VIEW_PURCHASE_PRICE intentionally excluded
    PERMISSIONS.PARTNERS_MANAGE,
    PERMISSIONS.PRODUCTS_VIEW,
    PERMISSIONS.PAYMENTS_MANAGE,
  ],
};

/**
 * Display metadata for the admin UI registry endpoint.
 * Order in this list determines display order in the matrix.
 */
export const PERMISSION_REGISTRY: Array<{
  permission: Permission;
  group: string;
  label: string;
  description: string;
}> = [
  // Продажби
  {
    permission: PERMISSIONS.ORDERS_MANAGE,
    group: "Продажби",
    label: "Поръчки — управление",
    description: "Създаване, редакция и отказ на поръчки",
  },
  {
    permission: PERMISSIONS.INVOICES_MANAGE,
    group: "Продажби",
    label: "Фактури — управление",
    description: "Създаване, редакция и email на фактури",
  },
  {
    permission: PERMISSIONS.INVOICES_CANCEL,
    group: "Продажби",
    label: "Анулиране фактури",
    description: "Анулиране на издадена фактура",
  },
  {
    permission: PERMISSIONS.RAZPISKA_MANAGE,
    group: "Продажби",
    label: "Стокови разписки",
    description: "Създаване и редакция на стокови разписки",
  },
  {
    permission: PERMISSIONS.ECONT_MANAGE,
    group: "Продажби",
    label: "Товарителници Еконт",
    description: "Създаване и tracking на товарителници",
  },
  // Складова видимост
  {
    permission: PERMISSIONS.INVENTORY_VIEW,
    group: "Складова видимост",
    label: "Складова наличност",
    description: "Виждане на наличности в склада",
  },
  {
    permission: PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE,
    group: "Складова видимост",
    label: "Доставни цени",
    description: "Виждане на доставни (cost) цени в каталога",
  },
  {
    permission: PERMISSIONS.INCOMING_MANAGE,
    group: "Складова видимост",
    label: "Входяща стока",
    description: "Сканиране и потвърждение на входящи фактури",
  },
  // Master data
  {
    permission: PERMISSIONS.PARTNERS_MANAGE,
    group: "Master data",
    label: "Партньори",
    description: "Виж/създай/редактирай партньори",
  },
  {
    permission: PERMISSIONS.PRODUCTS_VIEW,
    group: "Master data",
    label: "Продукти — виж",
    description: "Виждане на продуктовия каталог",
  },
  {
    permission: PERMISSIONS.PRODUCTS_MANAGE,
    group: "Master data",
    label: "Продукти — управление",
    description: "Създаване и редакция на продукти",
  },
  // Счетоводство
  {
    permission: PERMISSIONS.PAYMENTS_MANAGE,
    group: "Счетоводство",
    label: "Плащания",
    description: "Записване и преглед на плащания",
  },
  {
    permission: PERMISSIONS.REPORTS_VIEW,
    group: "Счетоводство",
    label: "Аналитики",
    description: "Dashboards + аналитични отчети",
  },
  {
    permission: PERMISSIONS.EXPORT_CREATE,
    group: "Счетоводство",
    label: "Делта Про експорт",
    description: "CP1251 експорт за счетоводна програма",
  },
  // Система
  {
    permission: PERMISSIONS.USERS_MANAGE,
    group: "Система",
    label: "Потребители",
    description: "Управление на потребители и техните разрешения",
  },
  {
    permission: PERMISSIONS.SETTINGS_MANAGE,
    group: "Система",
    label: "Настройки",
    description: "Системни настройки на приложението",
  },
];
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx tsc --noEmit
```

Expected: no errors related to `lib/permissions.ts`.

- [ ] **Step 3: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/lib/permissions.ts
git commit -m "feat(permissions): registry constants + role defaults + display metadata"
```

---

## Task 4: getUserPermissions() helper with caching

**Files:**

- Modify: `warehouse-backend/src/lib/permissions.ts` (append new exports)
- Create: `warehouse-backend/src/__tests__/permissions-helper.test.ts`

- [ ] **Step 1: Write the failing test**

Content of `warehouse-backend/src/__tests__/permissions-helper.test.ts`:

```typescript
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
    setEx: vi.fn(async (k: string, _ttl: number, v: string) => {
      store.set(k, v);
    }),
    del: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    isOpen: true,
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
    expect(redisMock.setEx).toHaveBeenCalledTimes(1);
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
```

- [ ] **Step 2: Run test (expect FAIL — functions don't exist yet)**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/permissions-helper.test.ts
```

Expected: FAIL with "getUserPermissions is not a function" or similar import error.

- [ ] **Step 3: Implement the helper**

Append to `warehouse-backend/src/lib/permissions.ts`:

```typescript
import { query } from "../db.js";
import { getRedis } from "./redis.js";

const CACHE_TTL_SECONDS = 60;
const CACHE_KEY_PREFIX = "perms:user:";

/**
 * Resolve the effective permission set for a user.
 * Checks Redis cache first; on miss, queries DB and caches.
 */
export async function getUserPermissions(
  userId: string,
): Promise<Set<Permission>> {
  const cacheKey = CACHE_KEY_PREFIX + userId;
  const redis = await getRedis();

  const cached = await redis.get(cacheKey);
  if (cached) {
    return new Set(JSON.parse(cached) as Permission[]);
  }

  const { rows } = await query(
    `
      SELECT u.role,
             COALESCE(json_agg(
               json_build_object('permission', upo.permission, 'granted', upo.granted)
             ) FILTER (WHERE upo.id IS NOT NULL), '[]') AS overrides
      FROM users u
      LEFT JOIN user_permission_overrides upo ON upo.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.id
    `,
    [userId],
  );

  if (rows.length === 0) return new Set();

  const role = rows[0].role as UserRole;
  const overrides = rows[0].overrides as Array<{
    permission: Permission;
    granted: boolean;
  }>;

  const effective = new Set<Permission>(ROLE_DEFAULTS[role] ?? []);
  for (const { permission, granted } of overrides) {
    if (granted) effective.add(permission);
    else effective.delete(permission);
  }

  await redis.setEx(
    cacheKey,
    CACHE_TTL_SECONDS,
    JSON.stringify([...effective]),
  );
  return effective;
}

export async function invalidateUserPermissions(userId: string): Promise<void> {
  const redis = await getRedis();
  await redis.del(CACHE_KEY_PREFIX + userId);
}

/**
 * Authorization check. Admin always returns true.
 */
export async function hasPermission(
  user: { id: string; role: string },
  perm: Permission,
): Promise<boolean> {
  if (user.role === "admin") return true;
  const perms = await getUserPermissions(user.id);
  return perms.has(perm);
}
```

- [ ] **Step 4: Run test (expect PASS)**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/permissions-helper.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/lib/permissions.ts \
        warehouse-backend/src/__tests__/permissions-helper.test.ts
git commit -m "feat(permissions): getUserPermissions + hasPermission helpers with Redis cache"
```

---

## Task 5: requirePermission middleware + stripFieldsForUser

**Files:**

- Modify: `warehouse-backend/src/lib/permissions.ts`
- Modify: `warehouse-backend/src/__tests__/permissions-helper.test.ts`

- [ ] **Step 1: Append failing tests for the middleware and strip helper**

Add at the end of `warehouse-backend/src/__tests__/permissions-helper.test.ts`:

```typescript
import Fastify from "fastify";
import { requirePermission, stripFieldsForUser } from "../lib/permissions.js";

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
```

- [ ] **Step 2: Run tests (expect FAIL — middleware/strip not implemented)**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/permissions-helper.test.ts
```

Expected: 5 new tests fail with "requirePermission is not a function" or "stripFieldsForUser is not a function".

- [ ] **Step 3: Implement middleware + strip helper**

Append to `warehouse-backend/src/lib/permissions.ts`:

```typescript
import type { FastifyReply, FastifyRequest } from "fastify";

export function requirePermission(perm: Permission) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    const allowed = await hasPermission(
      request.user as { id: string; role: string },
      perm,
    );
    if (!allowed) {
      reply.status(403).send({
        error: "Forbidden",
        required_permission: perm,
        message: `Missing permission: ${perm}`,
      });
    }
  };
}

/**
 * Remove sensitive fields from response rows when the user lacks the
 * required permission. Returns a new array of new objects (does not
 * mutate the input).
 */
export async function stripFieldsForUser<T extends Record<string, unknown>>(
  user: { id: string; role: string },
  rows: T[],
  rules: { permission: Permission; fields: string[] }[],
): Promise<T[]> {
  let result = rows;
  for (const rule of rules) {
    if (await hasPermission(user, rule.permission)) continue;
    result = result.map((row) => {
      const stripped = { ...row };
      for (const f of rule.fields) delete stripped[f];
      return stripped;
    });
  }
  return result;
}
```

- [ ] **Step 4: Run tests (expect PASS)**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/permissions-helper.test.ts
```

Expected: all 14 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/lib/permissions.ts \
        warehouse-backend/src/__tests__/permissions-helper.test.ts
git commit -m "feat(permissions): requirePermission middleware + stripFieldsForUser helper"
```

---

# Phase 2 — Refactor Backend Routes (4 tasks)

The plan is to refactor routes file-by-file. Each task replaces the existing role-checks with `requirePermission()` middleware (when the whole endpoint requires a permission) or inline `hasPermission()` calls (when only branches differ by role). Tests verify legacy roles keep working.

## Task 6: Refactor `users.ts` + `settings.ts` (admin-only routes)

**Files:**

- Modify: `warehouse-backend/src/routes/users.ts:23`
- Modify: `warehouse-backend/src/routes/settings.ts:38`

These are the smallest refactors — both gates become `requirePermission(USERS_MANAGE)` / `(SETTINGS_MANAGE)`.

- [ ] **Step 1: Read the current state of both gate sites**

```bash
cd /Users/magic/Projects/mert-m
sed -n '20,30p' warehouse-backend/src/routes/users.ts
sed -n '35,45p' warehouse-backend/src/routes/settings.ts
```

Note the exact handler signatures and the `request.user.role !== "admin"` early-return pattern.

- [ ] **Step 2: Refactor `users.ts:23`**

Replace the inline `if (request.user.role !== "admin")` block with the `preHandler` middleware. The current handler structure (per `users.ts`):

```typescript
// BEFORE:
app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
  await request.jwtVerify();
  if (request.user.role !== "admin") {
    return reply.status(403).send({ error: "Admin access required" });
  }
  // ... rest of handler
});
```

Becomes:

```typescript
// AFTER:
import { requirePermission, PERMISSIONS } from "../lib/permissions.js";

app.get(
  "/",
  {
    preHandler: [
      async (req) => {
        await req.jwtVerify();
      },
      requirePermission(PERMISSIONS.USERS_MANAGE),
    ],
  },
  async (request: FastifyRequest, reply: FastifyReply) => {
    // ... rest of handler unchanged
  },
);
```

Apply the same pattern to **all** four routes in `users.ts` (GET, POST, PATCH, DELETE) — every endpoint becomes gated by `USERS_MANAGE`.

- [ ] **Step 3: Refactor `settings.ts:38`**

Same pattern: replace `if (request.user.role !== "admin")` with `requirePermission(PERMISSIONS.SETTINGS_MANAGE)` in the `preHandler`.

- [ ] **Step 4: Run existing tests (expect PASS — no regression)**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/
```

Expected: all currently-passing tests still pass.

- [ ] **Step 5: Manual smoke test**

Restart backend (`./scripts/start-mertm.sh`) and verify:

```bash
# Admin should still access /users
curl -H "Authorization: Bearer <admin-jwt>" http://localhost:3004/users  # → 200

# Sales/warehouse user should get 403
curl -H "Authorization: Bearer <sales-jwt>" http://localhost:3004/users  # → 403, body { required_permission: "users.manage" }
```

- [ ] **Step 6: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/users.ts \
        warehouse-backend/src/routes/settings.ts
git commit -m "refactor(routes): users + settings use requirePermission middleware"
```

---

## Task 7: Refactor `invoices.ts` (10 sites)

**Files:**

- Modify: `warehouse-backend/src/routes/invoices.ts:85` (canAccessInvoices helper) and 9 inline checks at lines 121, 254, 286, 309, 446, 574, 691, 716, 855, 940.

Map of current behavior → target permission:

| Line(s)                      | Current check                                      | New permission                                                                                |
| ---------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 85 (helper)                  | `canAccessInvoices(role)`                          | DELETE — replace callers                                                                      |
| 121, 254, 286, 574, 691, 716 | `if (!canAccessInvoices(role))`                    | `requirePermission(INVOICES_MANAGE)` (preHandler)                                             |
| 309, 446, 855                | `if (role === "accountant")` (special-case branch) | `if (await hasPermission(req.user, INVOICES_CANCEL))` — these are the cancel-related branches |
| 940                          | `if (role !== "admin" && role !== "accountant")`   | `requirePermission(INVOICES_CANCEL)`                                                          |

- [ ] **Step 1: Read each site to map its semantics precisely**

```bash
cd /Users/magic/Projects/mert-m
for line in 85 121 254 286 309 446 574 691 716 855 940; do
  echo "--- line $line ---"
  sed -n "$((line-2)),$((line+5))p" warehouse-backend/src/routes/invoices.ts
done
```

For each site, write a one-line comment in a scratch buffer noting whether it gates a whole route or just a branch. The mapping table above is the planning hypothesis; verify before changing.

- [ ] **Step 2: Replace each site one at a time**

Add at top of file:

```typescript
import {
  requirePermission,
  hasPermission,
  PERMISSIONS,
} from "../lib/permissions.js";
```

Delete the local `canAccessInvoices` function (line 85) and convert each call into either:

- **Whole-route gate:** add `{ preHandler: [jwtVerify, requirePermission(PERMISSIONS.X)] }` to the route options and remove the inline check.
- **Inline branch:** replace `if (request.user.role === "accountant")` with `if (await hasPermission(request.user, PERMISSIONS.INVOICES_CANCEL))` (or the matching permission for that branch's purpose).

Important: re-derive `request.user` typing — Fastify's `request.user` is `any` after `jwtVerify` so casting may be needed for `hasPermission`.

- [ ] **Step 3: Run existing invoices tests (expect PASS)**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/ -t "invoice"
```

Expected: all pre-existing invoice tests still pass.

- [ ] **Step 4: Add a regression test for the sales role**

Append to a new file `warehouse-backend/src/__tests__/invoices-permissions.test.ts`:

```typescript
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ query: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setEx: vi.fn(async () => {}),
    del: vi.fn(async () => {}),
    isOpen: true,
  })),
}));

import { query } from "../db.js";
import invoiceRoutes from "../routes/invoices.js";

const mockQuery = vi.mocked(query);

async function buildApp(role: string, userId = "u1") {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: userId, email: "x@y", role };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(invoiceRoutes, { prefix: "/invoices" });
  return app;
}

describe("invoices route — sales role", () => {
  beforeEach(() => mockQuery.mockReset());

  it("sales user can list invoices (has invoices.manage)", async () => {
    mockQuery.mockResolvedValueOnce({ role: "sales", overrides: [] } as any);
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);

    const app = await buildApp("sales");
    try {
      const res = await app.inject({ method: "GET", url: "/invoices" });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("sales user cannot cancel invoice (lacks invoices.cancel)", async () => {
    mockQuery.mockResolvedValueOnce({ role: "sales", overrides: [] } as any);

    const app = await buildApp("sales");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/invoices/1/cancel",
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
```

- [ ] **Step 5: Run new tests (expect PASS)**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/invoices-permissions.test.ts
```

- [ ] **Step 6: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/invoices.ts \
        warehouse-backend/src/__tests__/invoices-permissions.test.ts
git commit -m "refactor(routes): invoices.ts replaces 10 role checks with permissions"
```

---

## Task 8: Refactor `orders.ts` + `incoming.ts` (15 sites)

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts:605, 981, 1223, 1271, 1363, 1870, 1974, 2054`
- Modify: `warehouse-backend/src/routes/incoming.ts:298 (canCancelIncoming helper), 785, 1962, 2032, 2139, 2199, 2264, 2304`

Mapping:

| File        | Line                        | Current                                                             | New permission                                      |
| ----------- | --------------------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| orders.ts   | 605, 981, 1223, 1271, 1363  | `if (role === "accountant")` (special branches in read paths)       | `if (await hasPermission(req.user, ORDERS_MANAGE))` |
| orders.ts   | 1870, 1974, 2054            | `if (role !== "admin" && role !== "warehouse")` (dispatch / cancel) | `requirePermission(ORDERS_MANAGE)`                  |
| incoming.ts | 298 (helper)                | `canCancelIncoming(role)`                                           | DELETE — callers use `INCOMING_MANAGE`              |
| incoming.ts | 785, 2032, 2139, 2199, 2264 | `if (role === "accountant")` (read branches)                        | inline `hasPermission(req.user, INCOMING_MANAGE)`   |
| incoming.ts | 1962                        | `if (!canCancelIncoming(role))`                                     | `requirePermission(INCOMING_MANAGE)`                |
| incoming.ts | 2304                        | `if (role !== "admin" && role !== "warehouse")`                     | `requirePermission(INCOMING_MANAGE)`                |

- [ ] **Step 1: Verify each line's exact context (the line numbers may have drifted)**

```bash
cd /Users/magic/Projects/mert-m
grep -n "request\.user\.role\|canCancelIncoming\|canAccessInvoices" warehouse-backend/src/routes/orders.ts
grep -n "request\.user\.role\|canCancelIncoming" warehouse-backend/src/routes/incoming.ts
```

- [ ] **Step 2: Refactor `orders.ts` site-by-site**

For each occurrence, replace per the mapping table. Add at top:

```typescript
import {
  requirePermission,
  hasPermission,
  PERMISSIONS,
} from "../lib/permissions.js";
```

Delete any uses of `canCancelIncoming` references (kept in `incoming.ts`).

- [ ] **Step 3: Refactor `incoming.ts` site-by-site**

Delete `canCancelIncoming` helper at line 298. Add the permissions import. Replace each site per the table.

- [ ] **Step 4: Run existing tests (expect PASS)**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/ -t "order|incoming"
```

- [ ] **Step 5: Add regression tests for sales user against orders + incoming**

Create `warehouse-backend/src/__tests__/orders-incoming-permissions.test.ts`:

```typescript
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ query: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setEx: vi.fn(async () => {}),
    del: vi.fn(async () => {}),
    isOpen: true,
  })),
}));

import { query } from "../db.js";
import ordersRoutes from "../routes/orders.js";
import incomingRoutes from "../routes/incoming.js";

const mockQuery = vi.mocked(query);

async function buildApp(routes: any, prefix: string, role: string) {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u1", email: "x@y", role };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(routes, { prefix });
  return app;
}

describe("orders permissions", () => {
  beforeEach(() => mockQuery.mockReset());

  it("sales user can list orders (has orders.manage)", async () => {
    mockQuery.mockResolvedValueOnce({ role: "sales", overrides: [] } as any);
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);

    const app = await buildApp(ordersRoutes, "/orders", "sales");
    try {
      const res = await app.inject({ method: "GET", url: "/orders" });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("incoming permissions", () => {
  beforeEach(() => mockQuery.mockReset());

  it("sales user gets 403 on incoming list (lacks incoming.manage)", async () => {
    mockQuery.mockResolvedValueOnce({ role: "sales", overrides: [] } as any);

    const app = await buildApp(incomingRoutes, "/incoming", "sales");
    try {
      const res = await app.inject({ method: "GET", url: "/incoming" });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("warehouse user can list incoming (has incoming.manage)", async () => {
    mockQuery.mockResolvedValueOnce({
      role: "warehouse",
      overrides: [],
    } as any);
    mockQuery.mockResolvedValueOnce({ rows: [] } as any);

    const app = await buildApp(incomingRoutes, "/incoming", "warehouse");
    try {
      const res = await app.inject({ method: "GET", url: "/incoming" });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
```

- [ ] **Step 6: Run new tests (expect PASS)**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/orders-incoming-permissions.test.ts
```

- [ ] **Step 7: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/orders.ts \
        warehouse-backend/src/routes/incoming.ts \
        warehouse-backend/src/__tests__/orders-incoming-permissions.test.ts
git commit -m "refactor(routes): orders + incoming replace 15 role checks with permissions"
```

---

## Task 9: Refactor remaining route files (16 sites)

**Files:**

- Modify: `warehouse-backend/src/routes/products.ts:455, 511, 573` (3 sites)
- Modify: `warehouse-backend/src/routes/payments.ts:27, 161, 297` (3 sites)
- Modify: `warehouse-backend/src/routes/partners.ts` (3 sites — locate via grep)
- Modify: `warehouse-backend/src/routes/export.ts:125, 282` (2 sites)
- Modify: `warehouse-backend/src/routes/import.ts` (1 site — locate via grep)
- Modify: `warehouse-backend/src/routes/fiscal.ts` (1 site — locate via grep)
- Modify: `warehouse-backend/src/routes/auth.ts:82` (1 site — `users.manage` gate on register)

Mapping:

| File        | Lines        | Current                                          | New permission                                                            |
| ----------- | ------------ | ------------------------------------------------ | ------------------------------------------------------------------------- |
| products.ts | 455, 511     | `accountant` branches                            | inline `hasPermission(PRODUCTS_MANAGE)`                                   |
| products.ts | 573          | `if (role !== "admin")`                          | `requirePermission(PRODUCTS_MANAGE)`                                      |
| payments.ts | 27, 161, 297 | `if (role === "warehouse")` (excluded branch)    | inline `hasPermission(PAYMENTS_MANAGE)` (warehouse lacks it)              |
| partners.ts | (3 sites)    | mixed                                            | inspect + map to `PARTNERS_MANAGE`                                        |
| export.ts   | 125, 282     | `if (role !== "admin" && role !== "accountant")` | `requirePermission(EXPORT_CREATE)`                                        |
| import.ts   | (1 site)     | inspect                                          | likely `requirePermission(PRODUCTS_MANAGE)` (importing products) — verify |
| fiscal.ts   | (1 site)     | inspect                                          | likely `requirePermission(INVOICES_MANAGE)` — verify                      |
| auth.ts     | 82           | `if (role !== "admin")` on register              | `requirePermission(USERS_MANAGE)`                                         |

- [ ] **Step 1: Locate all sites and verify counts**

```bash
cd /Users/magic/Projects/mert-m
grep -n "request\.user\.role" warehouse-backend/src/routes/products.ts \
                              warehouse-backend/src/routes/payments.ts \
                              warehouse-backend/src/routes/partners.ts \
                              warehouse-backend/src/routes/export.ts \
                              warehouse-backend/src/routes/import.ts \
                              warehouse-backend/src/routes/fiscal.ts \
                              warehouse-backend/src/routes/auth.ts
```

Expect ~15-16 lines total. For each, read the surrounding ±5 lines and confirm the mapping.

- [ ] **Step 2: Refactor file-by-file**

For each file:

1. Add `import { requirePermission, hasPermission, PERMISSIONS } from "../lib/permissions.js";`
2. Replace each role check per the mapping table.

Special cases:

- `payments.ts` warehouse exclusion is an inverse check — replace `if (role === "warehouse") return reply.status(403)` with the explicit `requirePermission(PAYMENTS_MANAGE)` middleware on the route. Cleaner.
- `auth.ts:82` — this is inside the `/auth/register` handler. Replace the inline check with `requirePermission(USERS_MANAGE)` in the route's `preHandler` array.

- [ ] **Step 3: Run existing tests (expect PASS)**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/
```

- [ ] **Step 4: Verify no role checks remain**

```bash
cd /Users/magic/Projects/mert-m
grep -rn "request\.user\.role" warehouse-backend/src/routes/ --include="*.ts" | wc -l
```

Expected: `0` (or only in lines that legitimately READ the role, e.g., to embed in JWT, not gate access — review each remaining hit individually).

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/products.ts \
        warehouse-backend/src/routes/payments.ts \
        warehouse-backend/src/routes/partners.ts \
        warehouse-backend/src/routes/export.ts \
        warehouse-backend/src/routes/import.ts \
        warehouse-backend/src/routes/fiscal.ts \
        warehouse-backend/src/routes/auth.ts
git commit -m "refactor(routes): replace remaining 16 role checks with permissions"
```

---

# Phase 3 — purchase_price stripping (1 task)

## Task 10: Strip purchase_price for users without permission

**Files:**

- Modify: `warehouse-backend/src/routes/inventory.ts:104` (the SELECT that includes `p.purchase_price`)
- Modify: `warehouse-backend/src/routes/products.ts` (locate query returning `purchase_price`)
- Modify: `warehouse-backend/src/routes/incoming.ts:769-770` (joined `p.purchase_price AS product_purchase_price`)

- [ ] **Step 1: Identify all SELECT statements returning `purchase_price`**

```bash
cd /Users/magic/Projects/mert-m
grep -rn "purchase_price\|product_purchase_price" warehouse-backend/src/routes/ --include="*.ts"
```

Group results by route file. For each, note the response shape — single object vs array vs nested.

- [ ] **Step 2: Apply strip to `inventory.ts`**

In the GET / handler around line 100-110, after the `query()` call returns `rows`, add:

```typescript
import { stripFieldsForUser, PERMISSIONS } from "../lib/permissions.js";

// ... in the handler:
const filtered = await stripFieldsForUser(request.user, rows, [
  {
    permission: PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE,
    fields: ["purchase_price"],
  },
]);
return filtered;
```

- [ ] **Step 3: Apply strip to `products.ts`**

Same pattern in the GET / handler. Verify the field name is `purchase_price` in the response.

- [ ] **Step 4: Apply strip to `incoming.ts`**

The joined column is aliased as `product_purchase_price`, so:

```typescript
const filtered = await stripFieldsForUser(request.user, rows, [
  {
    permission: PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE,
    fields: ["product_purchase_price"],
  },
]);
```

- [ ] **Step 5: Add integration test**

Create `warehouse-backend/src/__tests__/inventory-strip-price.test.ts`:

```typescript
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ query: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setEx: vi.fn(async () => {}),
    del: vi.fn(async () => {}),
    isOpen: true,
  })),
}));

import { query } from "../db.js";
import inventoryRoutes from "../routes/inventory.js";

const mockQuery = vi.mocked(query);

async function buildApp(role: string) {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u1", email: "x@y", role };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(inventoryRoutes, { prefix: "/inventory" });
  return app;
}

const sampleRow = {
  id: 1,
  sku: "SKU-1",
  name_bg: "Test product",
  total_stock: 10,
  selling_price: "100.00",
  purchase_price: "60.00",
};

describe("inventory purchase_price stripping", () => {
  beforeEach(() => mockQuery.mockReset());

  it("strips purchase_price for sales user", async () => {
    mockQuery.mockResolvedValueOnce({ role: "sales", overrides: [] } as any);
    mockQuery.mockResolvedValueOnce({ rows: [sampleRow] } as any);

    const app = await buildApp("sales");
    try {
      const res = await app.inject({ method: "GET", url: "/inventory" });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      const items = Array.isArray(data) ? data : (data.data ?? []);
      expect(items[0]).not.toHaveProperty("purchase_price");
      expect(items[0]).toHaveProperty("selling_price", "100.00");
    } finally {
      await app.close();
    }
  });

  it("keeps purchase_price for accountant user", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [sampleRow] } as any);

    const app = await buildApp("accountant");
    try {
      const res = await app.inject({ method: "GET", url: "/inventory" });
      const data = res.json();
      const items = Array.isArray(data) ? data : (data.data ?? []);
      expect(items[0].purchase_price).toBe("60.00");
    } finally {
      await app.close();
    }
  });

  it("keeps purchase_price for admin user", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [sampleRow] } as any);

    const app = await buildApp("admin");
    try {
      const res = await app.inject({ method: "GET", url: "/inventory" });
      const data = res.json();
      const items = Array.isArray(data) ? data : (data.data ?? []);
      expect(items[0].purchase_price).toBe("60.00");
    } finally {
      await app.close();
    }
  });
});
```

- [ ] **Step 6: Run test (expect PASS)**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/inventory-strip-price.test.ts
```

- [ ] **Step 7: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/inventory.ts \
        warehouse-backend/src/routes/products.ts \
        warehouse-backend/src/routes/incoming.ts \
        warehouse-backend/src/__tests__/inventory-strip-price.test.ts
git commit -m "feat(api): strip purchase_price for users without inventory.view_purchase_price"
```

---

# Phase 4 — Permission Management API (5 tasks)

## Task 11: Enhance `/auth/me` to return permissions

**Files:**

- Modify: `warehouse-backend/src/routes/auth.ts:121` (the `/me` handler)

- [ ] **Step 1: Read current handler**

```bash
sed -n '120,140p' warehouse-backend/src/routes/auth.ts
```

- [ ] **Step 2: Add failing test**

Create `warehouse-backend/src/__tests__/auth-me-permissions.test.ts`:

```typescript
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ query: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setEx: vi.fn(async () => {}),
    del: vi.fn(async () => {}),
    isOpen: true,
  })),
}));

import { query } from "../db.js";
import authRoutes from "../routes/auth.js";

const mockQuery = vi.mocked(query);

async function buildApp(role: string) {
  const app = Fastify();
  app.register(import("@fastify/jwt"), { secret: "test-secret" });
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u1", email: "x@y.bg", role };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(authRoutes, { prefix: "/auth" });
  return app;
}

describe("GET /auth/me with permissions", () => {
  beforeEach(() => mockQuery.mockReset());

  it("returns user + permissions for sales role", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "u1",
          name: "Иван",
          email: "x@y.bg",
          role: "sales",
          created_at: new Date(),
        },
      ],
    } as any);
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: "sales", overrides: [] }],
    } as any);

    const app = await buildApp("sales");
    try {
      const res = await app.inject({ method: "GET", url: "/auth/me" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.user.email).toBe("x@y.bg");
      expect(body.permissions).toContain("orders.manage");
      expect(body.permissions).not.toContain("inventory.view_purchase_price");
    } finally {
      await app.close();
    }
  });
});
```

- [ ] **Step 3: Run test (expect FAIL — current /me doesn't include permissions)**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/auth-me-permissions.test.ts
```

- [ ] **Step 4: Modify the `/me` handler**

In `warehouse-backend/src/routes/auth.ts`, replace the `/me` handler:

```typescript
import { getUserPermissions } from "../lib/permissions.js";

// ... inside the route registration:
app.get("/me", async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await request.jwtVerify();
  } catch {
    return reply.status(401).send({ error: "Unauthorized" });
  }

  const { rows } = await query(
    "SELECT id, name, email, role, created_at FROM users WHERE id = $1",
    [request.user.id],
  );

  if (rows.length === 0) {
    return reply.status(404).send({ error: "User not found" });
  }

  const user = rows[0];
  const perms = await getUserPermissions(user.id);

  return {
    user,
    permissions: [...perms],
  };
});
```

- [ ] **Step 5: Run test (expect PASS)**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/auth-me-permissions.test.ts
```

- [ ] **Step 6: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/auth.ts \
        warehouse-backend/src/__tests__/auth-me-permissions.test.ts
git commit -m "feat(auth): /me returns effective permissions"
```

---

## Task 12: GET /permissions/registry endpoint

**Files:**

- Create: `warehouse-backend/src/routes/permissions.ts`
- Modify: `warehouse-backend/src/index.ts` (register the new route)

- [ ] **Step 1: Write failing test**

Create `warehouse-backend/src/__tests__/permissions-registry-route.test.ts`:

```typescript
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import permissionsRoutes from "../routes/permissions.js";

async function buildApp() {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u1", email: "x@y", role: "sales" };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(permissionsRoutes, { prefix: "/permissions" });
  return app;
}

describe("GET /permissions/registry", () => {
  it("returns the permission catalog with groups + bg labels", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/permissions/registry",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(16);
      const orders = body.find((p: any) => p.permission === "orders.manage");
      expect(orders).toMatchObject({
        permission: "orders.manage",
        group: "Продажби",
        label: "Поръчки — управление",
      });
    } finally {
      await app.close();
    }
  });
});
```

- [ ] **Step 2: Run test (expect FAIL — file doesn't exist)**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/permissions-registry-route.test.ts
```

- [ ] **Step 3: Create the route file**

Content of `warehouse-backend/src/routes/permissions.ts`:

```typescript
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { PERMISSION_REGISTRY } from "../lib/permissions.js";

export default async function permissionsRoutes(app: FastifyInstance) {
  app.get("/registry", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    return PERMISSION_REGISTRY;
  });
}
```

- [ ] **Step 4: Register the route in `src/index.ts`**

Find the route registration section (look for `app.register(usersRoutes`) and add:

```typescript
import permissionsRoutes from "./routes/permissions.js";

// ... near the other registrations:
app.register(permissionsRoutes, { prefix: "/permissions" });
```

- [ ] **Step 5: Run test (expect PASS)**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/permissions-registry-route.test.ts
```

- [ ] **Step 6: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/permissions.ts \
        warehouse-backend/src/index.ts \
        warehouse-backend/src/__tests__/permissions-registry-route.test.ts
git commit -m "feat(permissions): GET /permissions/registry endpoint"
```

---

## Task 13: GET /users/:id/permissions endpoint

**Files:**

- Modify: `warehouse-backend/src/routes/users.ts`

- [ ] **Step 1: Write failing test**

Create `warehouse-backend/src/__tests__/permissions-routes.test.ts`:

```typescript
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ query: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setEx: vi.fn(async () => {}),
    del: vi.fn(async () => {}),
    isOpen: true,
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
```

- [ ] **Step 2: Run test (expect FAIL — endpoint doesn't exist)**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/permissions-routes.test.ts
```

- [ ] **Step 3: Add the endpoint to `users.ts`**

Append within the `usersRoutes` plugin function:

```typescript
import {
  ROLE_DEFAULTS,
  getUserPermissions,
  PERMISSIONS,
  requirePermission,
} from "../lib/permissions.js";
import type { Permission, UserRole } from "../lib/permissions.js";

app.get(
  "/:id/permissions",
  {
    preHandler: [
      async (req) => {
        await req.jwtVerify();
      },
      requirePermission(PERMISSIONS.USERS_MANAGE),
    ],
  },
  async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const userResult = await query(
      "SELECT id, email, role, name FROM users WHERE id = $1",
      [id],
    );
    if (userResult.rows.length === 0) {
      return reply.status(404).send({ error: "User not found" });
    }
    const user = userResult.rows[0];

    const overridesResult = await query(
      `SELECT upo.permission, upo.granted, upo.reason, upo.created_at,
              c.id AS created_by_id, c.email AS created_by_email, c.name AS created_by_name
       FROM user_permission_overrides upo
       LEFT JOIN users c ON c.id = upo.created_by
       WHERE upo.user_id = $1
       ORDER BY upo.created_at DESC`,
      [id],
    );

    const overrides = overridesResult.rows.map((r) => ({
      permission: r.permission,
      granted: r.granted,
      reason: r.reason,
      created_at: r.created_at,
      created_by: r.created_by_id
        ? {
            id: r.created_by_id,
            email: r.created_by_email,
            name: r.created_by_name,
          }
        : null,
    }));

    const role = user.role as UserRole;
    const role_defaults = ROLE_DEFAULTS[role] ?? [];

    const effective = [...(await getUserPermissions(id))];

    return {
      user_id: id,
      role,
      role_defaults,
      overrides,
      effective,
    };
  },
);
```

- [ ] **Step 4: Run test (expect PASS)**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/permissions-routes.test.ts
```

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/users.ts \
        warehouse-backend/src/__tests__/permissions-routes.test.ts
git commit -m "feat(api): GET /users/:id/permissions returns role+overrides+effective"
```

---

## Task 14: PATCH /users/:id/permissions/:permission

**Files:**

- Modify: `warehouse-backend/src/routes/users.ts`
- Modify: `warehouse-backend/src/__tests__/permissions-routes.test.ts`

- [ ] **Step 1: Append failing tests**

Add to `permissions-routes.test.ts`:

```typescript
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
      // 400 (self_modification_forbidden takes precedence) or admin_lockout_protection — both are correct
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
```

- [ ] **Step 2: Run tests (expect FAIL)**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/permissions-routes.test.ts
```

- [ ] **Step 3: Implement the endpoint**

Add to `users.ts` after the GET /:id/permissions handler:

```typescript
import { z } from "zod";
import {
  invalidateUserPermissions,
  PERMISSION_REGISTRY,
} from "../lib/permissions.js";

const VALID_PERMISSION_VALUES = PERMISSION_REGISTRY.map((p) => p.permission);

const SetOverrideSchema = z.object({
  granted: z.boolean(),
  reason: z.string().max(255).optional(),
});

app.patch(
  "/:id/permissions/:permission",
  {
    preHandler: [
      async (req) => {
        await req.jwtVerify();
      },
      requirePermission(PERMISSIONS.USERS_MANAGE),
    ],
  },
  async (request: FastifyRequest, reply: FastifyReply) => {
    const { id, permission } = request.params as {
      id: string;
      permission: string;
    };

    if (!VALID_PERMISSION_VALUES.includes(permission as Permission)) {
      return reply.status(400).send({
        error: "unknown_permission",
        valid_permissions: VALID_PERMISSION_VALUES,
      });
    }

    const parsed = SetOverrideSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: "invalid_body", details: parsed.error.errors });
    }
    const { granted, reason } = parsed.data;

    const targetResult = await query(
      "SELECT id, role FROM users WHERE id = $1",
      [id],
    );
    if (targetResult.rows.length === 0) {
      return reply.status(404).send({ error: "User not found" });
    }
    const target = targetResult.rows[0];

    if (target.role === "admin") {
      return reply.status(400).send({ error: "admin_lockout_protection" });
    }
    if ((request.user as any).id === id) {
      return reply.status(400).send({ error: "self_modification_forbidden" });
    }

    const upsertResult = await query(
      `INSERT INTO user_permission_overrides (user_id, permission, granted, reason, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, permission)
       DO UPDATE SET granted = EXCLUDED.granted,
                     reason = EXCLUDED.reason,
                     created_by = EXCLUDED.created_by,
                     created_at = now()
       RETURNING id, granted, reason`,
      [id, permission, granted, reason ?? null, (request.user as any).id],
    );

    const auditResult = await query(
      `INSERT INTO audit_events (event_type, actor_user_id, target_type, target_id, payload, created_at)
       VALUES ('permission_override', $1, 'user', $2, $3::jsonb, now())
       RETURNING id`,
      [
        (request.user as any).id,
        id,
        JSON.stringify({
          permission,
          action: granted ? "grant" : "revoke",
          new: granted,
          reason: reason ?? null,
        }),
      ],
    );

    await invalidateUserPermissions(id);

    return {
      user_id: id,
      permission,
      granted,
      reason: reason ?? null,
      audit_event_id: auditResult.rows[0].id,
    };
  },
);
```

- [ ] **Step 4: Run tests (expect PASS)**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npx vitest run src/__tests__/permissions-routes.test.ts
```

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/users.ts \
        warehouse-backend/src/__tests__/permissions-routes.test.ts
git commit -m "feat(api): PATCH /users/:id/permissions/:permission with audit + cache invalidation"
```

---

## Task 15: DELETE /users/:id/permissions/:permission

**Files:**

- Modify: `warehouse-backend/src/routes/users.ts`
- Modify: `warehouse-backend/src/__tests__/permissions-routes.test.ts`

- [ ] **Step 1: Append failing test**

```typescript
describe("DELETE /users/:id/permissions/:permission", () => {
  beforeEach(() => mockQuery.mockReset());

  it("removes override + writes audit + invalidates cache", async () => {
    // Target user
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "u1", role: "sales" }],
    } as any);
    // Lookup previous override (for audit)
    mockQuery.mockResolvedValueOnce({
      rows: [{ permission: "invoices.cancel", granted: true }],
    } as any);
    // DELETE
    mockQuery.mockResolvedValueOnce({ rowCount: 1 } as any);
    // Audit insert
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 200 }] } as any);

    const app = await buildApp("admin");
    try {
      const res = await app.inject({
        method: "DELETE",
        url: "/users/u1/permissions/invoices.cancel",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.reset_to_default).toBe(true);
      expect(body.audit_event_id).toBe(200);
    } finally {
      await app.close();
    }
  });
});
```

- [ ] **Step 2: Run test (expect FAIL)**

- [ ] **Step 3: Implement the endpoint**

```typescript
app.delete(
  "/:id/permissions/:permission",
  {
    preHandler: [
      async (req) => {
        await req.jwtVerify();
      },
      requirePermission(PERMISSIONS.USERS_MANAGE),
    ],
  },
  async (request: FastifyRequest, reply: FastifyReply) => {
    const { id, permission } = request.params as {
      id: string;
      permission: string;
    };

    if (!VALID_PERMISSION_VALUES.includes(permission as Permission)) {
      return reply.status(400).send({ error: "unknown_permission" });
    }

    const targetResult = await query(
      "SELECT id, role FROM users WHERE id = $1",
      [id],
    );
    if (targetResult.rows.length === 0) {
      return reply.status(404).send({ error: "User not found" });
    }
    if (targetResult.rows[0].role === "admin") {
      return reply.status(400).send({ error: "admin_lockout_protection" });
    }
    if ((request.user as any).id === id) {
      return reply.status(400).send({ error: "self_modification_forbidden" });
    }

    const previousResult = await query(
      "SELECT permission, granted FROM user_permission_overrides WHERE user_id = $1 AND permission = $2",
      [id, permission],
    );
    const previous = previousResult.rows[0] ?? null;

    await query(
      "DELETE FROM user_permission_overrides WHERE user_id = $1 AND permission = $2",
      [id, permission],
    );

    const auditResult = await query(
      `INSERT INTO audit_events (event_type, actor_user_id, target_type, target_id, payload, created_at)
       VALUES ('permission_override', $1, 'user', $2, $3::jsonb, now())
       RETURNING id`,
      [
        (request.user as any).id,
        id,
        JSON.stringify({
          permission,
          action: "reset_to_default",
          previous: previous?.granted ?? null,
        }),
      ],
    );

    await invalidateUserPermissions(id);

    return {
      user_id: id,
      permission,
      reset_to_default: true,
      audit_event_id: auditResult.rows[0].id,
    };
  },
);
```

- [ ] **Step 4: Run test (expect PASS)**

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-backend/src/routes/users.ts \
        warehouse-backend/src/__tests__/permissions-routes.test.ts
git commit -m "feat(api): DELETE /users/:id/permissions/:permission resets to role default"
```

---

# Phase 5 — Frontend Permission Infrastructure (4 tasks)

## Task 16: Frontend Permission constants

**Files:**

- Create: `warehouse-frontend/src/lib/permissions.ts`

- [ ] **Step 1: Write the constants (mirror of backend)**

Content of `warehouse-frontend/src/lib/permissions.ts`:

```typescript
export const PERMISSIONS = {
  ORDERS_MANAGE: "orders.manage",
  INVOICES_MANAGE: "invoices.manage",
  INVOICES_CANCEL: "invoices.cancel",
  RAZPISKA_MANAGE: "razpiska.manage",
  ECONT_MANAGE: "econt.manage",
  INVENTORY_VIEW: "inventory.view",
  INVENTORY_VIEW_PURCHASE_PRICE: "inventory.view_purchase_price",
  INCOMING_MANAGE: "incoming.manage",
  PARTNERS_MANAGE: "partners.manage",
  PRODUCTS_VIEW: "products.view",
  PRODUCTS_MANAGE: "products.manage",
  PAYMENTS_MANAGE: "payments.manage",
  REPORTS_VIEW: "reports.view",
  EXPORT_CREATE: "export.create",
  USERS_MANAGE: "users.manage",
  SETTINGS_MANAGE: "settings.manage",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export type UserRole = "admin" | "warehouse" | "accountant" | "sales";

export interface PermissionRegistryEntry {
  permission: Permission;
  group: string;
  label: string;
  description: string;
}

export interface UserPermissionsResponse {
  user_id: string;
  role: UserRole;
  role_defaults: Permission[];
  overrides: Array<{
    permission: Permission;
    granted: boolean;
    reason: string | null;
    created_at: string;
    created_by: { id: string; email: string; name: string } | null;
  }>;
  effective: Permission[];
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/lib/permissions.ts
git commit -m "feat(frontend): Permission TypeScript constants + types"
```

---

## Task 17: PermissionContext + usePermissions hook

**Files:**

- Create: `warehouse-frontend/src/contexts/PermissionContext.tsx`

- [ ] **Step 1: Write the context**

Content of `warehouse-frontend/src/contexts/PermissionContext.tsx`:

```typescript
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Permission, UserRole } from "@/lib/permissions";

interface MeResponse {
  user: {
    id: string;
    email: string;
    name: string;
    role: UserRole;
  };
  permissions: Permission[];
}

interface PermissionContextValue {
  user: MeResponse["user"] | null;
  permissions: Set<Permission>;
  isLoading: boolean;
  hasPermission: (perm: Permission) => boolean;
  refresh: () => Promise<unknown>;
}

const PermissionContext = createContext<PermissionContextValue | null>(null);

export function PermissionProvider({ children }: { children: ReactNode }) {
  const { data, isLoading, refetch } = useQuery<MeResponse>({
    queryKey: ["me"],
    queryFn: () => api.get("/auth/me").then((r) => r.data),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: false,
  });

  const permissions = useMemo(
    () => new Set<Permission>(data?.permissions ?? []),
    [data?.permissions],
  );

  const hasPermission = useCallback(
    (perm: Permission) => {
      if (data?.user?.role === "admin") return true;
      return permissions.has(perm);
    },
    [permissions, data?.user?.role],
  );

  const value = useMemo<PermissionContextValue>(
    () => ({
      user: data?.user ?? null,
      permissions,
      isLoading,
      hasPermission,
      refresh: refetch,
    }),
    [data?.user, permissions, isLoading, hasPermission, refetch],
  );

  return (
    <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>
  );
}

export function usePermissions() {
  const ctx = useContext(PermissionContext);
  if (!ctx) {
    throw new Error("usePermissions must be used within PermissionProvider");
  }
  return ctx;
}
```

- [ ] **Step 2: Wrap App in `<PermissionProvider>`**

In `warehouse-frontend/src/App.tsx`, add the import and wrap the existing `<AuthProvider>` block (or place inside it, after auth):

```typescript
import { PermissionProvider } from "@/contexts/PermissionContext";

// In the JSX:
<AuthProvider>
  <PermissionProvider>
    {/* existing routes / layout */}
  </PermissionProvider>
</AuthProvider>
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/contexts/PermissionContext.tsx \
        warehouse-frontend/src/App.tsx
git commit -m "feat(frontend): PermissionContext provider + usePermissions hook"
```

---

## Task 18: `<Can>` and `<RequirePermission>` components

**Files:**

- Create: `warehouse-frontend/src/components/Can.tsx`
- Create: `warehouse-frontend/src/components/RequirePermission.tsx`

- [ ] **Step 1: Create `<Can>`**

Content of `warehouse-frontend/src/components/Can.tsx`:

```typescript
import type { ReactNode } from "react";
import { usePermissions } from "@/contexts/PermissionContext";
import type { Permission } from "@/lib/permissions";

interface CanProps {
  permission: Permission | Permission[];
  mode?: "any" | "all";
  fallback?: ReactNode;
  children: ReactNode;
}

export function Can({ permission, mode = "any", fallback = null, children }: CanProps) {
  const { hasPermission } = usePermissions();
  const perms = Array.isArray(permission) ? permission : [permission];
  const allowed =
    mode === "all" ? perms.every(hasPermission) : perms.some(hasPermission);
  return <>{allowed ? children : fallback}</>;
}
```

- [ ] **Step 2: Create `<RequirePermission>`**

Content of `warehouse-frontend/src/components/RequirePermission.tsx`:

```typescript
import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { usePermissions } from "@/contexts/PermissionContext";
import type { Permission } from "@/lib/permissions";

interface RequirePermissionProps {
  permission: Permission;
  children: ReactNode;
  redirectTo?: string;
}

export function RequirePermission({
  permission,
  children,
  redirectTo = "/",
}: RequirePermissionProps) {
  const { hasPermission, isLoading } = usePermissions();

  if (isLoading) {
    return <div className="p-8 text-muted-foreground">Зареждане...</div>;
  }

  if (!hasPermission(permission)) {
    return <Navigate to={redirectTo} replace />;
  }

  return <>{children}</>;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/components/Can.tsx \
        warehouse-frontend/src/components/RequirePermission.tsx
git commit -m "feat(frontend): Can + RequirePermission components"
```

---

## Task 19: Axios 403 interceptor + dynamic Sidebar

**Files:**

- Modify: `warehouse-frontend/src/lib/api.ts`
- Modify: `warehouse-frontend/src/components/Layout.tsx`

- [ ] **Step 1: Add 403 interceptor in api.ts**

Read the current `api.ts`:

```bash
cat warehouse-frontend/src/lib/api.ts
```

Add a response interceptor BEFORE the existing 401 dispatcher (so both can run):

```typescript
import { toast } from "sonner"; // or whatever toast lib the project uses

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (
      error.response?.status === 403 &&
      error.response.data?.required_permission
    ) {
      // Permissions changed mid-session; signal to PermissionProvider to refresh.
      window.dispatchEvent(new CustomEvent("permissions:revoked"));
      try {
        toast.warning("Разрешенията ти са променени. Опитай пак.");
      } catch {
        // toast lib not loaded — ignore
      }
    }
    return Promise.reject(error);
  },
);
```

Verify the toast import is correct by checking what other pages use:

```bash
grep -rn "from .sonner\"\|from .react-toastify" warehouse-frontend/src --include="*.ts" --include="*.tsx" | head -3
```

If no toast lib is in use, skip the toast call and rely on the event dispatch only.

- [ ] **Step 2: Listen for the event in PermissionContext**

Modify `PermissionContext.tsx`:

```typescript
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

// Inside PermissionProvider:
const queryClient = useQueryClient();
useEffect(() => {
  const handler = () => {
    queryClient.invalidateQueries({ queryKey: ["me"] });
  };
  window.addEventListener("permissions:revoked", handler);
  return () => window.removeEventListener("permissions:revoked", handler);
}, [queryClient]);
```

- [ ] **Step 3: Refactor Layout sidebar to use permissions**

In `warehouse-frontend/src/components/Layout.tsx`, find the `allNavItems` array. Replace each item's `roles: [...]` array with a `permission` field:

```typescript
import { PERMISSIONS, type Permission } from "@/lib/permissions";
import { usePermissions } from "@/contexts/PermissionContext";

const allNavItems: Array<{
  to: string;
  icon: any;
  label: string;
  permission?: Permission;
}> = [
  { to: "/", icon: LayoutDashboard, label: "Табло" }, // visible to all
  {
    to: "/products",
    icon: Package,
    label: "Продукти",
    permission: PERMISSIONS.PRODUCTS_VIEW,
  },
  {
    to: "/inventory",
    icon: Warehouse,
    label: "Склад",
    permission: PERMISSIONS.INVENTORY_VIEW,
  },
  {
    to: "/incoming",
    icon: PackagePlus,
    label: "Приемане на стоки",
    permission: PERMISSIONS.INCOMING_MANAGE,
  },
  {
    to: "/orders",
    icon: ShoppingCart,
    label: "Поръчки",
    permission: PERMISSIONS.ORDERS_MANAGE,
  },
  {
    to: "/warehouse",
    icon: Boxes,
    label: "Склад пакетиране",
    permission: PERMISSIONS.ORDERS_MANAGE,
  },
  {
    to: "/partners",
    icon: Users,
    label: "Партньори",
    permission: PERMISSIONS.PARTNERS_MANAGE,
  },
  {
    to: "/suppliers",
    icon: Truck,
    label: "Доставчици",
    permission: PERMISSIONS.PARTNERS_MANAGE,
  },
  {
    to: "/invoices",
    icon: FileText,
    label: "Фактури",
    permission: PERMISSIONS.INVOICES_MANAGE,
  },
  {
    to: "/payments",
    icon: CreditCard,
    label: "Плащания",
    permission: PERMISSIONS.PAYMENTS_MANAGE,
  },
  {
    to: "/analytics",
    icon: BarChart3,
    label: "Анализи",
    permission: PERMISSIONS.REPORTS_VIEW,
  },
  {
    to: "/settings",
    icon: Settings,
    label: "Настройки",
    permission: PERMISSIONS.SETTINGS_MANAGE,
  },
];
```

Replace the existing role-based filtering:

```typescript
const { hasPermission } = usePermissions();
const visibleNavItems = allNavItems.filter(
  (item) => !item.permission || hasPermission(item.permission),
);
```

(Remove the previous `user.role`-based `.filter` if present.)

- [ ] **Step 4: Smoke test in browser**

```bash
cd /Users/magic/Projects/mert-m
./scripts/start-mertm.sh
open http://localhost:5174
```

Login as admin → all 12 menu items visible. Logout, login as a sales user (create one via `/users` API or set role manually in DB) → ~7 items visible.

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/lib/api.ts \
        warehouse-frontend/src/contexts/PermissionContext.tsx \
        warehouse-frontend/src/components/Layout.tsx
git commit -m "feat(frontend): permissions-driven sidebar + 403 interceptor"
```

---

# Phase 6 — Refactor Existing Frontend Pages (3 tasks)

## Task 20: Hide purchase_price in Inventory + Products + Dashboard

**Files:**

- Modify: `warehouse-frontend/src/pages/Inventory.tsx`
- Modify: `warehouse-frontend/src/pages/Products.tsx`
- Modify: `warehouse-frontend/src/pages/Dashboard.tsx`

- [ ] **Step 1: Inventory.tsx — wrap purchase_price column**

Locate the `<TableHead>Доставна цена</TableHead>` element and the matching `<TableCell>{row.purchase_price}</TableCell>` cell. Wrap each in:

```tsx
import { Can } from "@/components/Can";
import { PERMISSIONS } from "@/lib/permissions";

// header:
<Can permission={PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE}>
  <TableHead>Доставна цена</TableHead>
</Can>

// cell:
<Can permission={PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE}>
  <TableCell>{row.purchase_price ?? "—"}</TableCell>
</Can>
```

- [ ] **Step 2: Products.tsx — same**

Wrap the cost column header + cells with `<Can permission={PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE}>`. Also wrap the "Edit" button with `<Can permission={PERMISSIONS.PRODUCTS_MANAGE}>`.

- [ ] **Step 3: Dashboard.tsx — wrap margin/cost widgets**

Locate any KPI cards or charts that display margin / cost / `purchase_price`. Wrap each individual widget in `<Can permission={PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE}>`.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend
npx tsc --noEmit
```

- [ ] **Step 5: Smoke test**

Login as sales user; verify Inventory, Products, Dashboard show no purchase_price columns or margin widgets.

- [ ] **Step 6: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/pages/Inventory.tsx \
        warehouse-frontend/src/pages/Products.tsx \
        warehouse-frontend/src/pages/Dashboard.tsx
git commit -m "feat(frontend): hide purchase_price columns + margin widgets for unauthorised users"
```

---

## Task 21: Hide invoice cancel button + accountant-only actions

**Files:**

- Modify: `warehouse-frontend/src/pages/Invoices.tsx`

- [ ] **Step 1: Wrap cancel button**

Find any `<Button>` that triggers invoice cancellation. Wrap it:

```tsx
import { Can } from "@/components/Can";
import { PERMISSIONS } from "@/lib/permissions";

<Can permission={PERMISSIONS.INVOICES_CANCEL}>
  <Button variant="destructive" onClick={handleCancel}>
    Анулирай
  </Button>
</Can>;
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend
npx tsc --noEmit
```

- [ ] **Step 3: Smoke test**

Login as sales user → no Cancel button on invoice row. Login as accountant → Cancel button visible.

- [ ] **Step 4: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/pages/Invoices.tsx
git commit -m "feat(frontend): hide invoice cancel button for users without invoices.cancel"
```

---

# Phase 7 — Admin Permission Management UI (5 tasks)

## Task 22: UsersListPage scaffold

**Files:**

- Create: `warehouse-frontend/src/pages/admin/UsersListPage.tsx`
- Modify: `warehouse-frontend/src/App.tsx` (add route)

- [ ] **Step 1: Write the page**

Content of `warehouse-frontend/src/pages/admin/UsersListPage.tsx`:

```tsx
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ChevronRight } from "lucide-react";

interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  role: "admin" | "warehouse" | "accountant" | "sales";
  has_overrides?: boolean;
  overrides_count?: number;
}

export function UsersListPage() {
  const { data, isLoading, error } = useQuery<AdminUserRow[]>({
    queryKey: ["admin", "users"],
    queryFn: () =>
      api
        .get("/users")
        .then((r) => (Array.isArray(r.data) ? r.data : (r.data?.data ?? []))),
  });

  if (isLoading) return <div className="p-8">Зареждане...</div>;
  if (error)
    return <div className="p-8 text-red-600">Грешка при зареждане.</div>;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Потребители</h1>
        <Link
          to="/settings/users/new"
          className="px-3 py-1.5 rounded bg-[#f97316] text-white text-sm"
        >
          + Нов user
        </Link>
      </div>

      <div className="border rounded-lg overflow-hidden bg-white">
        {(data ?? []).map((u) => (
          <Link
            key={u.id}
            to={`/settings/users/${u.id}`}
            className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 border-b last:border-0"
          >
            <div>
              <div className="font-medium">{u.name}</div>
              <div className="text-sm text-gray-500">{u.email}</div>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm bg-gray-100 px-2 py-1 rounded">
                {u.role}
              </span>
              <span className="text-sm text-gray-500">
                {u.overrides_count
                  ? `${u.overrides_count} overrides`
                  : u.role === "admin"
                    ? "—"
                    : "default"}
              </span>
              <ChevronRight className="h-4 w-4 text-gray-400" />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add route in App.tsx**

```tsx
import { UsersListPage } from "@/pages/admin/UsersListPage";
import { RequirePermission } from "@/components/RequirePermission";
import { PERMISSIONS } from "@/lib/permissions";

// In the routes section:
<Route
  path="/settings/users"
  element={
    <RequirePermission permission={PERMISSIONS.USERS_MANAGE}>
      <UsersListPage />
    </RequirePermission>
  }
/>;
```

- [ ] **Step 3: Backend: enhance GET /users to include `overrides_count`**

In `warehouse-backend/src/routes/users.ts`, modify the GET / handler to LEFT JOIN against `user_permission_overrides`:

```typescript
const { rows } = await query(`
  SELECT u.id, u.email, u.name, u.role, u.created_at,
         COUNT(upo.id)::int AS overrides_count
  FROM users u
  LEFT JOIN user_permission_overrides upo ON upo.user_id = u.id
  GROUP BY u.id
  ORDER BY u.email
`);
return rows.map((r: any) => ({
  ...r,
  has_overrides: r.overrides_count > 0,
}));
```

- [ ] **Step 4: Smoke test**

Login as admin → navigate to `/settings/users` → list of users renders.

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/pages/admin/UsersListPage.tsx \
        warehouse-frontend/src/App.tsx \
        warehouse-backend/src/routes/users.ts
git commit -m "feat(admin): UsersListPage at /settings/users + overrides count in API"
```

---

## Task 23: PermissionRow + PermissionMatrix components

**Files:**

- Create: `warehouse-frontend/src/pages/admin/components/PermissionRow.tsx`
- Create: `warehouse-frontend/src/pages/admin/components/PermissionMatrix.tsx`

- [ ] **Step 1: Write PermissionRow**

Content of `warehouse-frontend/src/pages/admin/components/PermissionRow.tsx`:

```tsx
import type { Permission, PermissionRegistryEntry } from "@/lib/permissions";

interface OverrideInfo {
  granted: boolean;
  reason: string | null;
}

interface PermissionRowProps {
  entry: PermissionRegistryEntry;
  effective: boolean;
  override: OverrideInfo | null;
  isFromRoleDefault: boolean;
  roleLabel: string;
  disabled: boolean;
  onToggle: (permission: Permission, currentlyEffective: boolean) => void;
  onReset: (permission: Permission) => void;
}

export function PermissionRow({
  entry,
  effective,
  override,
  isFromRoleDefault,
  roleLabel,
  disabled,
  onToggle,
  onReset,
}: PermissionRowProps) {
  return (
    <div className="border rounded p-3 mb-2 bg-white">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3 flex-1">
          <input
            type="checkbox"
            checked={effective}
            disabled={disabled}
            onChange={() => onToggle(entry.permission, effective)}
            className="mt-1"
          />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <div className="font-medium">{entry.label}</div>
              {override && (
                <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                  ✏️ override
                </span>
              )}
            </div>
            <div className="text-sm text-gray-500">{entry.description}</div>
            <div className="text-xs text-gray-400 mt-1">
              default {isFromRoleDefault ? "✓" : "✗"} от {roleLabel}
              {override?.reason && (
                <span className="ml-2 italic">— „{override.reason}"</span>
              )}
            </div>
          </div>
        </div>
        {override && (
          <button
            onClick={() => onReset(entry.permission)}
            disabled={disabled}
            className="text-xs text-blue-600 hover:underline"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write PermissionMatrix**

Content of `warehouse-frontend/src/pages/admin/components/PermissionMatrix.tsx`:

```tsx
import { useMemo } from "react";
import { PermissionRow } from "./PermissionRow";
import type {
  Permission,
  PermissionRegistryEntry,
  UserPermissionsResponse,
} from "@/lib/permissions";

interface PermissionMatrixProps {
  registry: PermissionRegistryEntry[];
  data: UserPermissionsResponse;
  disabled: boolean;
  onToggle: (permission: Permission, currentlyEffective: boolean) => void;
  onReset: (permission: Permission) => void;
}

export function PermissionMatrix({
  registry,
  data,
  disabled,
  onToggle,
  onReset,
}: PermissionMatrixProps) {
  const roleDefaults = useMemo(
    () => new Set(data.role_defaults),
    [data.role_defaults],
  );
  const effective = useMemo(() => new Set(data.effective), [data.effective]);
  const overridesMap = useMemo(() => {
    const m = new Map<
      Permission,
      { granted: boolean; reason: string | null }
    >();
    for (const o of data.overrides) {
      m.set(o.permission, { granted: o.granted, reason: o.reason });
    }
    return m;
  }, [data.overrides]);

  const groups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, PermissionRegistryEntry[]>();
    for (const entry of registry) {
      if (!map.has(entry.group)) {
        map.set(entry.group, []);
        order.push(entry.group);
      }
      map.get(entry.group)!.push(entry);
    }
    return order.map((g) => ({ group: g, entries: map.get(g)! }));
  }, [registry]);

  return (
    <div>
      {groups.map(({ group, entries }) => (
        <div key={group} className="mb-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">{group}</h3>
          {entries.map((entry) => (
            <PermissionRow
              key={entry.permission}
              entry={entry}
              effective={effective.has(entry.permission)}
              override={overridesMap.get(entry.permission) ?? null}
              isFromRoleDefault={roleDefaults.has(entry.permission)}
              roleLabel={data.role}
              disabled={disabled}
              onToggle={onToggle}
              onReset={onReset}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/pages/admin/components/PermissionRow.tsx \
        warehouse-frontend/src/pages/admin/components/PermissionMatrix.tsx
git commit -m "feat(admin): PermissionMatrix + PermissionRow components"
```

---

## Task 24: OverrideDialog + RoleSelector + AuditTrail components

**Files:**

- Create: `warehouse-frontend/src/pages/admin/components/OverrideDialog.tsx`
- Create: `warehouse-frontend/src/pages/admin/components/RoleSelector.tsx`
- Create: `warehouse-frontend/src/pages/admin/components/AuditTrail.tsx`

- [ ] **Step 1: OverrideDialog**

Content of `warehouse-frontend/src/pages/admin/components/OverrideDialog.tsx`:

```tsx
import { useState, useEffect } from "react";
import type { Permission } from "@/lib/permissions";

interface OverrideDialogProps {
  open: boolean;
  permission: Permission | null;
  permissionLabel: string;
  newGranted: boolean;
  userName: string;
  onConfirm: (reason: string | null) => void;
  onCancel: () => void;
}

export function OverrideDialog({
  open,
  permission,
  permissionLabel,
  newGranted,
  userName,
  onConfirm,
  onCancel,
}: OverrideDialogProps) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) setReason("");
  }, [open, permission]);

  if (!open) return null;

  const action = newGranted ? "Грантни" : "Отнеми";

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-md w-full">
        <h3 className="text-lg font-semibold mb-2">
          {action} `{permissionLabel}` за {userName}
        </h3>
        <p className="text-sm text-gray-500 mb-4">
          Permission: <code className="text-xs">{permission}</code>
        </p>

        <label className="block mb-4">
          <span className="text-sm font-medium">Бележка (незадължителна):</span>
          <input
            type="text"
            maxLength={255}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="напр. Временно за инвентаризация"
            className="mt-1 w-full border rounded px-3 py-2 text-sm"
          />
        </label>

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded border text-sm"
          >
            Отказ
          </button>
          <button
            onClick={() => onConfirm(reason.trim() || null)}
            className="px-3 py-1.5 rounded bg-[#f97316] text-white text-sm"
          >
            Потвърди
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: RoleSelector**

Content of `warehouse-frontend/src/pages/admin/components/RoleSelector.tsx`:

```tsx
import { useState } from "react";
import type { UserRole } from "@/lib/permissions";

interface RoleSelectorProps {
  current: UserRole;
  disabled: boolean;
  onChange: (newRole: UserRole) => void;
}

const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Admin",
  accountant: "Accountant (Счетоводител)",
  warehouse: "Warehouse (Склад)",
  sales: "Sales (Служител)",
};

export function RoleSelector({
  current,
  disabled,
  onChange,
}: RoleSelectorProps) {
  const [pending, setPending] = useState<UserRole | null>(null);

  return (
    <div>
      <select
        value={current}
        disabled={disabled}
        onChange={(e) => setPending(e.target.value as UserRole)}
        className="border rounded px-3 py-1.5 text-sm"
      >
        {(Object.keys(ROLE_LABELS) as UserRole[]).map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </select>

      {pending && pending !== current && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md">
            <h3 className="text-lg font-semibold mb-2">Смяна на роля</h3>
            <p className="text-sm mb-4">
              Промяната на ролята <strong>изтрива всички overrides</strong> за
              този user. Сигурен ли си?
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPending(null)}
                className="px-3 py-1.5 border rounded text-sm"
              >
                Отказ
              </button>
              <button
                onClick={() => {
                  onChange(pending);
                  setPending(null);
                }}
                className="px-3 py-1.5 rounded bg-[#f97316] text-white text-sm"
              >
                Промени
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: AuditTrail**

Content of `warehouse-frontend/src/pages/admin/components/AuditTrail.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

interface AuditEvent {
  id: number;
  event_type: string;
  actor_email: string;
  payload: {
    permission?: string;
    action?: "grant" | "revoke" | "reset_to_default";
    reason?: string | null;
    new_role?: string;
    previous_role?: string;
  };
  created_at: string;
}

interface AuditTrailProps {
  userId: string;
}

export function AuditTrail({ userId }: AuditTrailProps) {
  const { data, isLoading } = useQuery<AuditEvent[]>({
    queryKey: ["audit", "user", userId],
    queryFn: () =>
      api
        .get(`/audit/user/${userId}?limit=10`)
        .then((r) => (Array.isArray(r.data) ? r.data : (r.data?.data ?? []))),
    enabled: !!userId,
    retry: false,
  });

  if (isLoading)
    return <div className="text-sm text-gray-500">Зареждане...</div>;
  if (!data || data.length === 0) {
    return (
      <div className="text-sm text-gray-500">Няма история на промените.</div>
    );
  }

  return (
    <ul className="space-y-2">
      {data.map((e) => (
        <li key={e.id} className="text-sm border rounded p-2 bg-white">
          <div className="text-xs text-gray-400">
            {new Date(e.created_at).toLocaleString("bg-BG")}
          </div>
          <div>
            <strong>{e.actor_email}</strong>{" "}
            {e.payload.action === "grant"
              ? "грантна"
              : e.payload.action === "revoke"
                ? "отне"
                : "ресетна"}{" "}
            <code className="text-xs">{e.payload.permission}</code>
            {e.payload.reason && (
              <em className="ml-2 text-gray-500">— „{e.payload.reason}"</em>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Add backend endpoint for `/audit/user/:id`**

In `warehouse-backend/src/routes/users.ts` (or a new audit route file), add:

```typescript
app.get(
  "/:id/audit",
  {
    preHandler: [
      async (req) => {
        await req.jwtVerify();
      },
      requirePermission(PERMISSIONS.USERS_MANAGE),
    ],
  },
  async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const limit = Math.min(
      parseInt((request.query as any).limit ?? "10", 10) || 10,
      100,
    );
    const { rows } = await query(
      `SELECT ae.id, ae.event_type, ae.payload, ae.created_at,
              u.email AS actor_email
       FROM audit_events ae
       LEFT JOIN users u ON u.id = ae.actor_user_id
       WHERE ae.target_type = 'user' AND ae.target_id = $1
         AND ae.event_type IN ('permission_override', 'role_change')
       ORDER BY ae.created_at DESC
       LIMIT $2`,
      [id, limit],
    );
    return rows;
  },
);
```

Note: AuditTrail.tsx queries `/audit/user/${userId}` — adjust endpoint path to `/users/${userId}/audit`:

```tsx
queryFn: () => api.get(`/users/${userId}/audit?limit=10`).then(...)
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /Users/magic/Projects/mert-m/warehouse-frontend
npx tsc --noEmit
cd ../warehouse-backend
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/pages/admin/components/OverrideDialog.tsx \
        warehouse-frontend/src/pages/admin/components/RoleSelector.tsx \
        warehouse-frontend/src/pages/admin/components/AuditTrail.tsx \
        warehouse-backend/src/routes/users.ts
git commit -m "feat(admin): OverrideDialog + RoleSelector + AuditTrail + audit endpoint"
```

---

## Task 25: UserDetailPage — wire it all together

**Files:**

- Create: `warehouse-frontend/src/pages/admin/UserDetailPage.tsx`
- Modify: `warehouse-frontend/src/App.tsx` (add detail route)

- [ ] **Step 1: Write the page**

Content of `warehouse-frontend/src/pages/admin/UserDetailPage.tsx`:

```tsx
import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ArrowLeft } from "lucide-react";
import { PermissionMatrix } from "./components/PermissionMatrix";
import { OverrideDialog } from "./components/OverrideDialog";
import { RoleSelector } from "./components/RoleSelector";
import { AuditTrail } from "./components/AuditTrail";
import { usePermissions } from "@/contexts/PermissionContext";
import type {
  Permission,
  PermissionRegistryEntry,
  UserPermissionsResponse,
  UserRole,
} from "@/lib/permissions";

interface UserSummary {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  created_at: string;
}

export function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { user: currentUser } = usePermissions();

  const userQuery = useQuery<UserSummary>({
    queryKey: ["admin", "user", id],
    queryFn: () => api.get(`/users/${id}`).then((r) => r.data),
    enabled: !!id,
  });
  const permsQuery = useQuery<UserPermissionsResponse>({
    queryKey: ["admin", "user", id, "permissions"],
    queryFn: () => api.get(`/users/${id}/permissions`).then((r) => r.data),
    enabled: !!id,
  });
  const registryQuery = useQuery<PermissionRegistryEntry[]>({
    queryKey: ["permissions", "registry"],
    queryFn: () => api.get("/permissions/registry").then((r) => r.data),
    staleTime: Infinity,
  });

  const [dialog, setDialog] = useState<{
    open: boolean;
    permission: Permission | null;
    label: string;
    newGranted: boolean;
  }>({ open: false, permission: null, label: "", newGranted: true });

  const setOverride = useMutation({
    mutationFn: ({
      permission,
      granted,
      reason,
    }: {
      permission: Permission;
      granted: boolean;
      reason: string | null;
    }) =>
      api
        .patch(`/users/${id}/permissions/${permission}`, { granted, reason })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["admin", "user", id, "permissions"],
      });
      queryClient.invalidateQueries({ queryKey: ["audit", "user", id] });
    },
  });

  const resetOverride = useMutation({
    mutationFn: (permission: Permission) =>
      api.delete(`/users/${id}/permissions/${permission}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["admin", "user", id, "permissions"],
      });
      queryClient.invalidateQueries({ queryKey: ["audit", "user", id] });
    },
  });

  const changeRole = useMutation({
    mutationFn: (role: UserRole) =>
      api.patch(`/users/${id}`, { role }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "user", id] });
      queryClient.invalidateQueries({
        queryKey: ["admin", "user", id, "permissions"],
      });
    },
  });

  if (!id) return <div className="p-8">Invalid user id.</div>;
  if (userQuery.isLoading || permsQuery.isLoading || registryQuery.isLoading) {
    return <div className="p-8">Зареждане...</div>;
  }
  if (!userQuery.data || !permsQuery.data || !registryQuery.data) {
    return <div className="p-8 text-red-600">Грешка при зареждане.</div>;
  }

  const user = userQuery.data;
  const perms = permsQuery.data;
  const registry = registryQuery.data;

  const isAdminTarget = user.role === "admin";
  const isSelfTarget = currentUser?.id === id;
  const matrixDisabled =
    isAdminTarget ||
    isSelfTarget ||
    setOverride.isPending ||
    resetOverride.isPending;

  const handleToggle = (
    permission: Permission,
    currentlyEffective: boolean,
  ) => {
    const entry = registry.find((r) => r.permission === permission)!;
    setDialog({
      open: true,
      permission,
      label: entry.label,
      newGranted: !currentlyEffective,
    });
  };

  const handleConfirm = (reason: string | null) => {
    if (!dialog.permission) return;
    setOverride.mutate({
      permission: dialog.permission,
      granted: dialog.newGranted,
      reason,
    });
    setDialog({ open: false, permission: null, label: "", newGranted: true });
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Link
        to="/settings/users"
        className="flex items-center gap-1 text-sm text-blue-600 mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Users
      </Link>

      <div className="bg-white border rounded-lg p-4 mb-6">
        <h1 className="text-xl font-semibold">{user.name}</h1>
        <div className="text-sm text-gray-500">{user.email}</div>
        <div className="text-xs text-gray-400 mt-1">
          Created: {new Date(user.created_at).toLocaleDateString("bg-BG")}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <span className="text-sm">Роля:</span>
          <RoleSelector
            current={user.role}
            disabled={isSelfTarget || changeRole.isPending}
            onChange={(role) => changeRole.mutate(role)}
          />
        </div>
      </div>

      {isAdminTarget && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded text-sm">
          Admin има всички разрешения. За да управляваш правата му, смени ролята
          първо.
        </div>
      )}
      {isSelfTarget && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded text-sm">
          Не можеш да променяш собствените си разрешения.
        </div>
      )}

      <h2 className="text-lg font-semibold mb-3">Разрешения</h2>
      <PermissionMatrix
        registry={registry}
        data={perms}
        disabled={matrixDisabled}
        onToggle={handleToggle}
        onReset={(permission) => resetOverride.mutate(permission)}
      />

      <h2 className="text-lg font-semibold mt-8 mb-3">Audit история</h2>
      <AuditTrail userId={id} />

      <OverrideDialog
        open={dialog.open}
        permission={dialog.permission}
        permissionLabel={dialog.label}
        newGranted={dialog.newGranted}
        userName={user.name}
        onConfirm={handleConfirm}
        onCancel={() =>
          setDialog({
            open: false,
            permission: null,
            label: "",
            newGranted: true,
          })
        }
      />
    </div>
  );
}
```

- [ ] **Step 2: Add the route in App.tsx**

```tsx
import { UserDetailPage } from "@/pages/admin/UserDetailPage";

<Route
  path="/settings/users/:id"
  element={
    <RequirePermission permission={PERMISSIONS.USERS_MANAGE}>
      <UserDetailPage />
    </RequirePermission>
  }
/>;
```

- [ ] **Step 3: Backend: ensure GET /users/:id exists**

Verify:

```bash
grep -n 'app\.get.*"/:id"' warehouse-backend/src/routes/users.ts
```

If not present, add a simple handler:

```typescript
app.get(
  "/:id",
  {
    preHandler: [
      async (req) => {
        await req.jwtVerify();
      },
      requirePermission(PERMISSIONS.USERS_MANAGE),
    ],
  },
  async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { rows } = await query(
      "SELECT id, name, email, role, created_at FROM users WHERE id = $1",
      [id],
    );
    if (rows.length === 0)
      return reply.status(404).send({ error: "User not found" });
    return rows[0];
  },
);
```

Also ensure PATCH /:id invalidates the user's permission cache when role changes:

```typescript
import { invalidateUserPermissions } from "../lib/permissions.js";

// inside the existing PATCH handler, after the UPDATE query:
if (body.role !== undefined && body.role !== existingUser.role) {
  // role changed; clear cache
  await invalidateUserPermissions(id);
  // also clear all overrides — role change resets the slate
  await query("DELETE FROM user_permission_overrides WHERE user_id = $1", [id]);
}
```

- [ ] **Step 4: Smoke test**

```bash
cd /Users/magic/Projects/mert-m && ./scripts/start-mertm.sh
```

In the browser, login as admin → navigate `/settings/users/<uuid>` → verify permission matrix renders, toggling a permission opens the dialog, audit history appears.

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add warehouse-frontend/src/pages/admin/UserDetailPage.tsx \
        warehouse-frontend/src/App.tsx \
        warehouse-backend/src/routes/users.ts
git commit -m "feat(admin): UserDetailPage with PermissionMatrix + RoleSelector + AuditTrail"
```

---

# Phase 8 — E2E Tests (1 task)

## Task 26: E2E test scenario for sales user + admin permission management

**Files:**

- Create: `e2e-tests/tests/permissions.spec.ts`

- [ ] **Step 1: Set up a sales test user via DB seed**

Add a seed step in the test that creates `sales@mertm.bg` if missing. We can either:

- Pre-seed via SQL in `e2e-tests/global-setup.ts`, OR
- Create on-the-fly in the test using an admin-authenticated API call.

Use the API approach — simpler:

Append to `e2e-tests/tests/helpers/auth.ts`:

```typescript
export async function ensureSalesUser(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<string> {
  // Login as admin to get token
  const loginRes = await request.post(`${BACKEND_BASE_URL}/auth/login`, {
    data: {
      email: process.env.E2E_ADMIN_EMAIL ?? "admin@mertm.bg",
      password: process.env.E2E_ADMIN_PASSWORD ?? "36PWyyfdpxIt08VXlGjle1zf",
    },
  });
  const adminToken = (await loginRes.json()).token;

  // Try to create the sales user; ignore conflict
  await request.post(`${BACKEND_BASE_URL}/users`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { name: "Sales Test", email, password, role: "sales" },
  });

  // Login as sales user, return token
  const salesRes = await request.post(`${BACKEND_BASE_URL}/auth/login`, {
    data: { email, password },
  });
  return (await salesRes.json()).token;
}
```

(import `BACKEND_BASE_URL` and `APIRequestContext` to match the existing helper imports.)

- [ ] **Step 2: Write the E2E test**

Content of `e2e-tests/tests/permissions.spec.ts`:

```typescript
import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsAdmin } from "./helpers/auth";
import { ensureSalesUser } from "./helpers/auth";

const SALES_EMAIL = "sales-e2e@mertm.bg";
const SALES_PASSWORD = "SalesE2EPass123!";

const BACKEND_BASE_URL =
  process.env.E2E_BACKEND_BASE_URL ?? "http://127.0.0.1:3004";

test.describe("Permission system — sales role", () => {
  test("sales user does not see purchase price column in inventory", async ({
    page,
    request,
  }) => {
    await ensureSalesUser(request, SALES_EMAIL, SALES_PASSWORD);

    await page.goto("/login");
    await page.fill('input[type="email"]', SALES_EMAIL);
    await page.fill('input[type="password"]', SALES_PASSWORD);
    await page.locator('button[type="submit"]').first().click();

    await expect(page).toHaveURL(/\/(?:[?#].*)?$/, { timeout: 10_000 });
    await page.goto("/inventory");

    await expect(
      page.locator("th", { hasText: "Доставна цена" }),
    ).not.toBeVisible();
    await expect(
      page.locator("th", { hasText: "Продажна цена" }),
    ).toBeVisible();
  });

  test("sales user sidebar omits restricted menu items", async ({
    page,
    request,
  }) => {
    await ensureSalesUser(request, SALES_EMAIL, SALES_PASSWORD);

    await page.goto("/login");
    await page.fill('input[type="email"]', SALES_EMAIL);
    await page.fill('input[type="password"]', SALES_PASSWORD);
    await page.locator('button[type="submit"]').first().click();

    await expect(page).toHaveURL(/\/(?:[?#].*)?$/);

    await expect(
      page.locator("nav a", { hasText: "Анализи" }),
    ).not.toBeVisible();
    await expect(
      page.locator("nav a", { hasText: "Настройки" }),
    ).not.toBeVisible();
    await expect(
      page.locator("nav a", { hasText: "Приемане на стоки" }),
    ).not.toBeVisible();
    await expect(page.locator("nav a", { hasText: "Поръчки" })).toBeVisible();
    await expect(page.locator("nav a", { hasText: "Фактури" })).toBeVisible();
  });

  test("admin can grant invoices.cancel override to sales user", async ({
    page,
    request,
  }) => {
    await ensureSalesUser(request, SALES_EMAIL, SALES_PASSWORD);

    // Find the sales user id via API
    const adminLoginRes = await request.post(`${BACKEND_BASE_URL}/auth/login`, {
      data: {
        email: process.env.E2E_ADMIN_EMAIL ?? "admin@mertm.bg",
        password: process.env.E2E_ADMIN_PASSWORD ?? "36PWyyfdpxIt08VXlGjle1zf",
      },
    });
    const adminToken = (await adminLoginRes.json()).token;
    const usersRes = await request.get(`${BACKEND_BASE_URL}/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const list = await usersRes.json();
    const items = Array.isArray(list) ? list : (list.data ?? []);
    const sales = items.find((u: any) => u.email === SALES_EMAIL);
    expect(sales).toBeDefined();

    // Login admin in browser
    await loginAsAdmin(page);
    await page.goto(`/settings/users/${sales.id}`);

    // Toggle invoices.cancel
    const row = page.locator(":has-text('Анулиране фактури')").first();
    await row.locator('input[type="checkbox"]').check();

    // Confirm dialog
    await page.fill('input[placeholder*="инвентаризац"]', "E2E test grant");
    await page.click('button:has-text("Потвърди")');

    // Verify override appears
    await expect(page.locator("text=✏️ override").first()).toBeVisible({
      timeout: 5_000,
    });
  });

  test("admin lockout protection: cannot modify another admin", async ({
    page,
    request,
  }) => {
    // Create a second admin via API
    const adminLoginRes = await request.post(`${BACKEND_BASE_URL}/auth/login`, {
      data: {
        email: process.env.E2E_ADMIN_EMAIL ?? "admin@mertm.bg",
        password: process.env.E2E_ADMIN_PASSWORD ?? "36PWyyfdpxIt08VXlGjle1zf",
      },
    });
    const adminToken = (await adminLoginRes.json()).token;

    await request.post(`${BACKEND_BASE_URL}/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: {
        name: "Second Admin",
        email: "admin2-e2e@mertm.bg",
        password: "Admin2E2EPass123!",
        role: "admin",
      },
    });

    const usersRes = await request.get(`${BACKEND_BASE_URL}/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const list = await usersRes.json();
    const items = Array.isArray(list) ? list : (list.data ?? []);
    const admin2 = items.find((u: any) => u.email === "admin2-e2e@mertm.bg");
    expect(admin2).toBeDefined();

    await loginAsAdmin(page);
    await page.goto(`/settings/users/${admin2.id}`);

    await expect(
      page.locator("text=Admin има всички разрешения"),
    ).toBeVisible();
  });
});
```

- [ ] **Step 3: Run the test**

```bash
cd /Users/magic/Projects/mert-m/e2e-tests
npx playwright test tests/permissions.spec.ts
```

Expected: all 4 tests pass against a running dev stack.

- [ ] **Step 4: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add e2e-tests/tests/permissions.spec.ts \
        e2e-tests/tests/helpers/auth.ts
git commit -m "test(e2e): permission system scenarios — sales role + admin matrix + lockout"
```

---

# Phase 9 — Production Rollout (1 task)

## Task 27: Final verification + deploy gate

**Files:** none (operational task)

- [ ] **Step 1: Run the full backend test suite**

```bash
cd /Users/magic/Projects/mert-m/warehouse-backend
npm test
```

Expected: ALL tests pass, including the legacy ones (regression check).

- [ ] **Step 2: Run TypeScript checks across both backend and frontend**

```bash
cd /Users/magic/Projects/mert-m
(cd warehouse-backend && npx tsc --noEmit) && \
(cd warehouse-frontend && npx tsc --noEmit)
```

Expected: zero new errors. Pre-existing errors in `warehouse-backend/src/__tests__/negative-inventory.test.ts` (Fastify register overload) may remain — note them in the deploy notes but do not block.

- [ ] **Step 3: Manual smoke checklist**

Run `./scripts/start-mertm.sh` and walk through:

- [ ] Existing admin@mertm.bg logs in; sees all 12 menu items; can use /settings/users/\* page
- [ ] Existing accountant user logs in; everything works as before — invoices, reports, exports accessible
- [ ] Existing warehouse user logs in; everything works as before — incoming, dispatch accessible, no payments
- [ ] Admin creates `sales-test@mertm.bg` via /users API or admin UI
- [ ] Sales user logs in; sidebar has 7 items; /inventory has no Доставна цена column
- [ ] Sales user `curl http://localhost:3004/inventory` (with their JWT) returns JSON without `purchase_price` field
- [ ] Sales user navigates to /settings → redirected to /
- [ ] Sales user creates a new order, invoice, razpiska, Econt label — all work
- [ ] Admin grants `invoices.cancel` to sales user via /settings/users/:id; sales user sees Cancel button after window-focus
- [ ] Admin revokes `orders.manage` from sales user; sales user gets 403 + toast on next attempted action; sidebar updates
- [ ] Audit log on user detail shows the grant + revoke entries
- [ ] Try to revoke `users.manage` from another admin via the UI → matrix is read-only with banner

- [ ] **Step 4: Update STATUS.md**

Append the feature to STATUS.md "Done" section:

```markdown
- `<commit>` Employee role + per-user permission overrides (Phase 1-9 complete) — DB migration 053, 16-permission registry, Redis-cached helper, /me + /permissions/registry + /users/:id/permissions endpoints, frontend Can/RequirePermission, admin UI at /settings/users/:id, E2E tests for sales user
```

Add the deploy date and note that the next admin training should walk through the new /settings/users/:id flow.

- [ ] **Step 5: Commit STATUS update**

```bash
cd /Users/magic/Projects/mert-m
git add STATUS.md
git commit -m "docs(status): record employee role + permission overrides feature complete"
```

- [ ] **Step 6: (When deploying to production)**

```bash
# 1. Backup DB before migration
DATABASE_URL=$(grep "^DATABASE_URL=" warehouse-backend/.env | cut -d= -f2-)
pg_dump "$DATABASE_URL" -Fc > /tmp/mertm-pre-perm-migration-$(date +%Y%m%d).dump

# 2. Apply migration
psql "$DATABASE_URL" -f warehouse-backend/migrations/053_user_permissions.sql

# 3. Restart backend to pick up new code
./scripts/start-mertm.sh

# 4. Verify health
curl http://localhost:3004/health
curl http://localhost:3004/permissions/registry  # requires JWT

# 5. Roll back plan if needed
psql "$DATABASE_URL" -c "DROP TABLE user_permission_overrides; ALTER TABLE users DROP CONSTRAINT users_role_check; ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','warehouse','accountant'));"
# then revert the code by checking out the parent commit of the feature branch
```

---

# Final Self-Review Checklist (run before declaring done)

- [ ] Every spec section has at least one task implementing it (use spec §1-15 as the checklist)
- [ ] Every backend `requirePermission(PERMISSIONS.X)` reference uses an existing constant from the registry (no typos)
- [ ] Every frontend `<Can permission={PERMISSIONS.X}>` reference uses an existing constant
- [ ] No file path is wrong (run `find . -name "<filename>"` to verify before editing)
- [ ] Each task ends with a commit
- [ ] No "TBD", "TODO", "fill in details" remain in this plan
- [ ] Migration number is the next available (`ls warehouse-backend/migrations/ | tail -3` should show 053 as next)

---

## Summary

**27 tasks across 9 phases** producing **27 commits** (one per task) on branch `feature/MERTM-employee-role-permissions` (or the existing feature branch if continuing).

**Estimated effort:** 21 work-days for one developer (matches spec §12 estimate). Subagent-driven execution should complete in ~2-3 wall days with parallel task review.

The plan reproduces every behavioral guarantee from the spec — particularly the zero-regression target for existing admin/accountant/warehouse users (Tasks 6-9 + manual smoke checklist Task 27).
