# Batch A — Permission features Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship two related permission features — admin-only override for selling below cost, and admin-only edit lock on `fulfilled`/`invoiced` orders — both with hard backend enforcement and JSONB audit trail.

**Architecture:** Two new permissions registered in the existing permission system (`BELOW_COST_OVERRIDE`, `ORDERS_EDIT_AFTER_FULFILL`); both default-enabled only for the `admin` role. Three audit columns on `orders` (`below_cost_approved_by`, `below_cost_approved_at`, `below_cost_details JSONB`). A pure helper computes below-cost lines on both backend and frontend. Frontend mirrors the permission constants and gates UI accordingly; reports filter exposes a query param `?below_cost_only=true`.

**Tech Stack:** PostgreSQL 16, Fastify+TypeScript backend, Vitest for unit/integration tests, React+Vite+TanStack Query frontend, ConfirmDialog component already in repo.

**Spec:** [docs/superpowers/specs/2026-04-29-batch-a-permission-features-design.md](../specs/2026-04-29-batch-a-permission-features-design.md)

---

## Pre-flight

- Branch is already `feature/MERTM-tester-attachments-buttons` (current). Confirm this is acceptable, or rebase to a fresh `feature/MERTM-batch-a-permissions` branch first.
- Backend dev server runs via `./scripts/start-mertm.sh` on port 3004.
- Tests run with `npm test` from `warehouse-backend/` (Vitest).
- Run all migrations: `./warehouse-backend/scripts/run-migrations.sh` (or `docker exec -i mertm-postgres-1 psql -U warehouse -d mertm_warehouse < migrations/056_*.sql`).

---

## Task 1: Migration 056 — orders audit columns

**Files:**

- Create: `warehouse-backend/migrations/056_orders_below_cost_audit.sql`

**Step 1: Write the migration**

```sql
-- 056_orders_below_cost_audit.sql
-- Adds audit columns to orders for the below-cost approval feature.
-- Set when an admin approves selling at least one line below products.purchase_price.
-- Customer-facing PDFs do NOT show these fields — internal audit only.

BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS below_cost_approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS below_cost_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS below_cost_details JSONB;

CREATE INDEX IF NOT EXISTS idx_orders_below_cost_approved_at
  ON orders(below_cost_approved_at)
  WHERE below_cost_approved_at IS NOT NULL;

COMMIT;
```

**Step 2: Apply migration**

Run:

```bash
docker exec -i mertm-postgres-1 psql -U warehouse -d mertm_warehouse \
  -v ON_ERROR_STOP=1 --single-transaction \
  < warehouse-backend/migrations/056_orders_below_cost_audit.sql

docker exec mertm-postgres-1 psql -U warehouse -d mertm_warehouse -tAc \
  "INSERT INTO _migrations (name) VALUES ('056_orders_below_cost_audit.sql') ON CONFLICT DO NOTHING"
```

Expected: `BEGIN`, three `ALTER TABLE`, optional `CREATE INDEX`, `COMMIT`.

**Step 3: Verify schema**

Run:

```bash
docker exec mertm-postgres-1 psql -U warehouse -d mertm_warehouse -tAc \
  "SELECT column_name, data_type FROM information_schema.columns
   WHERE table_name='orders' AND column_name LIKE 'below_cost%' ORDER BY column_name"
```

Expected output:

```
below_cost_approved_at|timestamp with time zone
below_cost_approved_by|uuid
below_cost_details|jsonb
```

**Step 4: Commit**

```bash
git add warehouse-backend/migrations/056_orders_below_cost_audit.sql
git commit -m "feat(db): add below-cost approval audit columns to orders (056)"
```

---

## Task 2: Register two new permissions

**Files:**

- Modify: `warehouse-backend/src/lib/permissions.ts:12-34` (add to PERMISSIONS); `:88-195` (add to PERMISSION_REGISTRY); ROLE_DEFAULTS already covers admin via `Object.values(PERMISSIONS)` — only verify other roles do NOT receive them.
- Modify: `warehouse-frontend/src/lib/permissions.ts:1-18` (mirror)

**Step 1: Add permissions to backend constants**

In `warehouse-backend/src/lib/permissions.ts`, extend the `PERMISSIONS` object:

```ts
export const PERMISSIONS = {
  // …existing entries unchanged…
  USERS_MANAGE: "users.manage",
  SETTINGS_MANAGE: "settings.manage",
  // Sales overrides (admin-only by default)
  BELOW_COST_OVERRIDE: "orders.below_cost_override",
  ORDERS_EDIT_AFTER_FULFILL: "orders.edit_after_fulfill",
} as const;
```

**Step 2: Add registry entries (Bulgarian labels)**

Append to `PERMISSION_REGISTRY` (group `"Продажби"`):

```ts
  {
    permission: PERMISSIONS.BELOW_COST_OVERRIDE,
    group: "Продажби",
    label: "Продажба под доставна цена",
    description: "Одобрение на поръчки с артикули под cost (admin override)",
  },
  {
    permission: PERMISSIONS.ORDERS_EDIT_AFTER_FULFILL,
    group: "Продажби",
    label: "Редакция на приключени поръчки",
    description: "Редакция на артикули в поръчки със статус 'Изпълнена' или 'Фактурирана'",
  },
```

**Step 3: Mirror in frontend**

In `warehouse-frontend/src/lib/permissions.ts`, extend the `PERMISSIONS` object identically:

```ts
export const PERMISSIONS = {
  // …existing entries…
  SETTINGS_MANAGE: "settings.manage",
  BELOW_COST_OVERRIDE: "orders.below_cost_override",
  ORDERS_EDIT_AFTER_FULFILL: "orders.edit_after_fulfill",
} as const;
```

**Step 4: Verify ROLE_DEFAULTS — non-admin roles must NOT include these**

`ROLE_DEFAULTS.admin` is `Object.values(PERMISSIONS)` so it auto-includes the new entries. Confirm `accountant`, `warehouse`, `sales` arrays do NOT mention the new permissions — they should not.

**Step 5: Commit**

```bash
git add warehouse-backend/src/lib/permissions.ts warehouse-frontend/src/lib/permissions.ts
git commit -m "feat(perms): register BELOW_COST_OVERRIDE + ORDERS_EDIT_AFTER_FULFILL permissions"
```

---

## Task 3: Below-cost helper (pure function) + unit test

**Files:**

- Create: `warehouse-backend/src/utils/below-cost.ts`
- Create: `warehouse-backend/src/__tests__/below-cost.test.ts`

**Step 1: Write the failing test first**

`warehouse-backend/src/__tests__/below-cost.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  computeBelowCostItems,
  type OrderLineInput,
  type ProductCost,
} from "../utils/below-cost.js";

describe("computeBelowCostItems", () => {
  const costs: Record<number, ProductCost> = {
    100: { product_id: 100, name: "Скара", purchase_price: 50 },
    200: { product_id: 200, name: "Лопата", purchase_price: 5 },
    300: { product_id: 300, name: "Без cost", purchase_price: null },
  };

  it("returns empty when all lines are at or above cost", () => {
    const lines: OrderLineInput[] = [
      { product_id: 100, quantity: 1, unit_price: 60, discount_percent: 0 },
      { product_id: 200, quantity: 1, unit_price: 5, discount_percent: 0 },
    ];
    expect(computeBelowCostItems(lines, costs)).toEqual([]);
  });

  it("flags a line whose post-discount effective price is below cost", () => {
    const lines: OrderLineInput[] = [
      { product_id: 200, quantity: 2, unit_price: 5, discount_percent: 50 }, // effective 2.50, cost 5
    ];
    const result = computeBelowCostItems(lines, costs);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      product_id: 200,
      product_name: "Лопата",
      quantity: 2,
      unit_price: 5,
      discount_percent: 50,
      effective_price: 2.5,
      purchase_price: 5,
      loss_per_unit: 2.5,
    });
  });

  it("ignores products with null purchase_price (no known cost)", () => {
    const lines: OrderLineInput[] = [
      { product_id: 300, quantity: 1, unit_price: 0.01, discount_percent: 0 },
    ];
    expect(computeBelowCostItems(lines, costs)).toEqual([]);
  });

  it("treats missing discount_percent as 0", () => {
    const lines: OrderLineInput[] = [
      { product_id: 100, quantity: 1, unit_price: 49.99 } as OrderLineInput,
    ];
    expect(computeBelowCostItems(lines, costs)).toHaveLength(1);
  });

  it("uses small epsilon to avoid floating-point false positives", () => {
    const lines: OrderLineInput[] = [
      {
        product_id: 100,
        quantity: 1,
        unit_price: 50.0001,
        discount_percent: 0,
      },
    ];
    expect(computeBelowCostItems(lines, costs)).toEqual([]);
  });
});
```

**Step 2: Run test — expect failure**

Run: `cd warehouse-backend && npx vitest run src/__tests__/below-cost.test.ts`
Expected: FAIL — module not found.

**Step 3: Write minimal implementation**

`warehouse-backend/src/utils/below-cost.ts`:

```ts
export interface OrderLineInput {
  product_id: number;
  quantity: number;
  unit_price: number;
  discount_percent?: number;
}

export interface ProductCost {
  product_id: number;
  name: string;
  purchase_price: number | null;
}

export interface BelowCostLine {
  product_id: number;
  product_name: string;
  quantity: number;
  unit_price: number;
  discount_percent: number;
  effective_price: number;
  purchase_price: number;
  loss_per_unit: number;
}

const EPSILON = 0.005; // 0.5 cent — avoids float rounding noise

export function computeBelowCostItems(
  lines: OrderLineInput[],
  costs: Record<number, ProductCost>,
): BelowCostLine[] {
  const out: BelowCostLine[] = [];
  for (const line of lines) {
    const cost = costs[line.product_id];
    if (!cost || cost.purchase_price == null) continue;
    const discount = line.discount_percent ?? 0;
    const effective = line.unit_price * (1 - discount / 100);
    if (effective + EPSILON < cost.purchase_price) {
      out.push({
        product_id: line.product_id,
        product_name: cost.name,
        quantity: line.quantity,
        unit_price: line.unit_price,
        discount_percent: discount,
        effective_price: Math.round(effective * 100) / 100,
        purchase_price: cost.purchase_price,
        loss_per_unit:
          Math.round((cost.purchase_price - effective) * 100) / 100,
      });
    }
  }
  return out;
}
```

**Step 4: Run test — expect pass**

Run: `npx vitest run src/__tests__/below-cost.test.ts`
Expected: 5 tests pass.

**Step 5: Commit**

```bash
git add warehouse-backend/src/utils/below-cost.ts warehouse-backend/src/__tests__/below-cost.test.ts
git commit -m "feat(orders): add computeBelowCostItems pure helper + unit tests"
```

---

## Task 4: Wire below-cost validation into POST /orders

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts` — extend the create-order schema with `allow_below_cost: z.boolean().optional()`; load product cost map; call helper; gate on permission; persist audit columns.
- Modify: same file — read approved-by name in `GET /orders/:id` JOIN for the drawer badge.

**Step 1: Extend the create schema**

Locate the Zod schema for the POST body (near the top of `routes/orders.ts`). Add:

```ts
allow_below_cost: z.boolean().optional().default(false),
```

**Step 2: Inside the POST /orders handler — after items are validated, before INSERT**

```ts
import {
  computeBelowCostItems,
  type ProductCost,
} from "../utils/below-cost.js";
import { hasPermission, PERMISSIONS } from "../lib/permissions.js";

// 1. Build cost map for products in the order
const productIds = items.map((i) => i.product_id);
const { rows: productRows } = await client.query(
  `SELECT id, name_bg, purchase_price FROM products WHERE id = ANY($1::int[])`,
  [productIds],
);
const costMap: Record<number, ProductCost> = Object.fromEntries(
  productRows.map((p) => [
    p.id,
    {
      product_id: p.id,
      name: p.name_bg,
      purchase_price:
        p.purchase_price != null ? parseFloat(p.purchase_price) : null,
    },
  ]),
);

// 2. Detect below-cost lines
const belowCost = computeBelowCostItems(items, costMap);

let belowCostApprovedBy: string | null = null;
let belowCostApprovedAt: Date | null = null;
let belowCostDetails: any = null;

if (belowCost.length > 0) {
  if (!body.allow_below_cost) {
    return reply.status(400).send({
      error: "Below cost not approved",
      message: "Има артикули под доставна цена. Изисква одобрение от admin.",
      below_cost_items: belowCost,
    });
  }
  const allowed = await hasPermission(
    request.user as any,
    PERMISSIONS.BELOW_COST_OVERRIDE,
  );
  if (!allowed) {
    return reply.status(403).send({
      error: "Forbidden",
      message: "Само admin може да одобрява продажба под доставна цена.",
      required_permission: PERMISSIONS.BELOW_COST_OVERRIDE,
    });
  }
  belowCostApprovedBy = (request.user as any).id;
  belowCostApprovedAt = new Date();
  belowCostDetails = belowCost;
}
```

**Step 3: Add the new columns to the INSERT**

Update the `INSERT INTO orders` to include the three audit columns and bind values; for the no-below-cost happy path the values are `null` and the row is identical to today.

**Step 4: Mirror the same logic in PUT /orders/:id**

(Step 2 logic, but inside the existing edit handler at `routes/orders.ts:1146-1170` block.) Use `UPDATE orders SET below_cost_approved_by = $X, below_cost_approved_at = $Y, below_cost_details = $Z` only when `belowCost.length > 0`; otherwise leave the columns alone (preserves prior approval if user re-saves an already-approved order).

**Step 5: Run backend type-check**

Run: `cd warehouse-backend && npx tsc --noEmit`
Expected: PASS (no new errors).

**Step 6: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): hard-block below-cost lines without admin override + audit"
```

---

## Task 5: Integration test — POST /orders below-cost behavior

**Files:**

- Create: `warehouse-backend/src/__tests__/orders-below-cost.test.ts`

**Step 1: Write the test (mirrors `orders-incoming-permissions.test.ts` pattern)**

```ts
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../lib/redis.js", () => ({
  getRedis: vi.fn(async () => ({
    get: vi.fn(async () => null),
    setex: vi.fn(async () => "OK"),
    del: vi.fn(async () => 0),
  })),
}));

import { query, transaction } from "../db.js";
import ordersRoutes from "../routes/orders.js";

const mockQuery = vi.mocked(query);
const mockTransaction = vi.mocked(transaction);

async function buildApp(role: string) {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u1", role };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(ordersRoutes, { prefix: "/orders" });
  return app;
}

describe("POST /orders below-cost guard", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTransaction.mockReset();
  });

  it("rejects 400 when below-cost lines and allow_below_cost is false (sales user)", async () => {
    // …mock product fetch returning purchase_price=50 for product 100…
    // …submit POST with unit_price=10 for product 100, no allow_below_cost…
    // expect 400 with below_cost_items in response body
  });

  it("rejects 403 when allow_below_cost=true but user lacks BELOW_COST_OVERRIDE", async () => {
    /* … */
  });

  it("accepts 201 when allow_below_cost=true and user is admin (writes audit)", async () => {
    /* … */
  });

  it("accepts 201 with no audit when no lines are below cost", async () => {
    /* … */
  });
});
```

(Fill in mock query bodies based on existing test patterns — open `orders-incoming-permissions.test.ts` for reference shape.)

**Step 2: Run — expect failures until route is wired correctly**

Run: `npx vitest run src/__tests__/orders-below-cost.test.ts`

**Step 3: Iterate the route until all 4 tests pass**

**Step 4: Commit**

```bash
git add warehouse-backend/src/__tests__/orders-below-cost.test.ts
git commit -m "test(orders): integration tests for below-cost guard on POST /orders"
```

---

## Task 6: Edit-after-fulfill admin guard on PUT /orders/:id

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts` — add status check at the top of the PUT handler.

**Step 1: At the start of `app.put("/:id", …)`, after fetching the order**

```ts
if (
  existingOrder.status === "fulfilled" ||
  existingOrder.status === "invoiced"
) {
  const allowed = await hasPermission(
    request.user as any,
    PERMISSIONS.ORDERS_EDIT_AFTER_FULFILL,
  );
  if (!allowed) {
    return reply.status(403).send({
      error: "Forbidden",
      message: "Само admin може да редактира приключени поръчки.",
      required_permission: PERMISSIONS.ORDERS_EDIT_AFTER_FULFILL,
    });
  }
}
```

**Step 2: Add a test in `orders-below-cost.test.ts` (or new file)**

```ts
it("rejects 403 on PUT /orders/:id for fulfilled order when sales user", async () => {
  mockQuery.mockResolvedValueOnce({
    rows: [{ role: "sales", overrides: [] }],
  } as any);
  mockQuery.mockResolvedValueOnce({
    rows: [{ id: 1, status: "fulfilled" }],
  } as any);
  // …PUT request…
  // expect 403 with required_permission: orders.edit_after_fulfill
});

it("admin can PUT /orders/:id on fulfilled order", async () => {
  /* … */
});
```

**Step 3: Run + commit**

```bash
npx vitest run src/__tests__/orders-below-cost.test.ts
git add warehouse-backend/src/routes/orders.ts warehouse-backend/src/__tests__/orders-below-cost.test.ts
git commit -m "feat(orders): admin-only edit guard on fulfilled/invoiced orders + tests"
```

---

## Task 7: Below-cost reports filter on GET /orders

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts` — accept `?below_cost_only=true` query param and add WHERE clause.

**Step 1: Find the GET /orders handler near `routes/orders.ts:401-560`**

Add a query param parse near the existing filter parsing block:

```ts
const belowCostOnly = (request.query as any).below_cost_only === "true";
```

Append to `where`:

```ts
if (belowCostOnly) {
  where += ` AND o.below_cost_approved_at IS NOT NULL`;
}
```

**Step 2: Add a test (in same file as Task 5)**

```ts
it("GET /orders?below_cost_only=true filters to approved-below-cost orders", async () => {
  // …
});
```

**Step 3: Run + commit**

```bash
npx vitest run src/__tests__/orders-below-cost.test.ts
git add warehouse-backend/src/routes/orders.ts warehouse-backend/src/__tests__/orders-below-cost.test.ts
git commit -m "feat(orders): below_cost_only filter on GET /orders + test"
```

---

## Task 8: Expose audit fields in GET /orders/:id + GET /orders

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts:563-587` (drawer detail JOIN); also list endpoint SELECT around `:510-520`.

**Step 1: Detail endpoint — JOIN users for approved_by name**

```sql
LEFT JOIN users approver ON approver.id = o.below_cost_approved_by
```

Select these extra columns:

```sql
o.below_cost_approved_at,
o.below_cost_details,
approver.name AS below_cost_approved_by_name
```

**Step 2: List endpoint — include `below_cost_approved_at` (boolean usage on FE is enough, no JOIN needed)**

`o.*` covers it — verify the SELECT does indeed return it.

**Step 3: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): expose below_cost audit fields in GET /orders endpoints"
```

---

## Task 9: Frontend below-cost helper (mirror)

**Files:**

- Create: `warehouse-frontend/src/lib/belowCost.ts`

**Step 1: Mirror the pure helper (drop server-only types, keep same signature)**

```ts
export interface OrderLineInput {
  product_id: number;
  quantity: number | string;
  unit_price: number | string;
  discount_percent?: number | string;
}
export interface ProductCost {
  product_id: number;
  name: string;
  purchase_price: number | null;
}
export interface BelowCostLine {
  product_id: number;
  product_name: string;
  quantity: number;
  unit_price: number;
  discount_percent: number;
  effective_price: number;
  purchase_price: number;
  loss_per_unit: number;
}

const EPSILON = 0.005;

export function computeBelowCostItems(
  lines: OrderLineInput[],
  costs: Record<number, ProductCost>,
): BelowCostLine[] {
  // …same logic as backend, parsing strings via parseFloat…
}
```

**Step 2: Commit**

```bash
git add warehouse-frontend/src/lib/belowCost.ts
git commit -m "feat(fe): mirror computeBelowCostItems helper on frontend"
```

---

## Task 10: New-order modal — block submit on below-cost without override

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx:2470-2479` — replace the existing soft `belowCostItems`/`confirmBelowCost` flow with the new gated flow that detects permission and either shows a confirm dialog or shows a hard error.

**Step 1: Wire usePermissions + helper**

Near the top of the new-order modal, after `belowCostItems` is computed:

```tsx
import { usePermissions } from "@/contexts/PermissionContext";
import { PERMISSIONS } from "@/lib/permissions";
import { computeBelowCostItems } from "@/lib/belowCost";
import { confirm } from "@/components/ConfirmDialog";

const { hasPermission } = usePermissions();
const canOverride = hasPermission(PERMISSIONS.BELOW_COST_OVERRIDE);
```

**Step 2: In the submit/save handler — gate**

```ts
const belowCost = computeBelowCostItems(validItems, productCostMap);
if (belowCost.length > 0) {
  if (!canOverride) {
    setErrorMsg("Има артикули под доставна цена. Свържи се с admin.");
    return;
  }
  const ok = await confirm({
    title: "Продажба под доставна цена",
    description: `${belowCost.length} артикул(а) са под cost. Общa загуба: ${totalLoss}€. Потвърждаваш ли?`,
    confirmText: "Разреши",
    variant: "danger",
  });
  if (!ok) return;
  payload.allow_below_cost = true;
}
```

**Step 3: Remove the old `confirmBelowCost` checkbox UI** (it's now replaced by the dialog).

**Step 4: Manual smoke test**

Login as admin → create order with one product priced below cost → verify confirm dialog appears with correct sum → confirm → 201 with audit columns set in DB.

Login as a non-admin role (e.g. `sales`) → repeat → expect inline red error and no submit attempt.

**Step 5: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): gate below-cost on submit; admin confirm dialog"
```

---

## Task 11: Edit modal — same gate + audit detection

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx:1804-1855` (`EditOrderItemsModal.mutation`).

**Step 1: Repeat Task 10 logic inside `EditOrderItemsModal`**

Same `computeBelowCostItems` → `canOverride` → confirm dialog → `payload.allow_below_cost = true`.

**Step 2: Manual smoke test**

Edit an existing order — add a below-cost line → submit → confirm dialog → verify audit columns updated.

**Step 3: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): below-cost gate in edit-items modal"
```

---

## Task 12: Edit button visibility — gate by ORDERS_EDIT_AFTER_FULFILL

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx:957-967` (the "Редактирай артикули" button next to the Еконт row).

**Step 1: Replace existing condition**

```tsx
{detail.status !== "cancelled" &&
 (
   (detail.status !== "fulfilled" && detail.status !== "invoiced") ||
   hasPermission(PERMISSIONS.ORDERS_EDIT_AFTER_FULFILL)
 ) && (
  <Button …>
    <Pencil className="h-4 w-4" /> Редактирай артикули
  </Button>
)}
```

**Step 2: Manual test**

Login as admin → fulfilled order → button visible.
Login as non-admin (sales) → fulfilled order → button hidden.

**Step 3: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): gate edit-items button on fulfilled/invoiced for non-admin"
```

---

## Task 13: Audit badge in drawer

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` — drawer top section, add a banner above the workflow indicator when `below_cost_approved_at` is set.

**Step 1: Banner component**

```tsx
{
  detail.below_cost_approved_at && (
    <div className="bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-sm text-amber-800 flex items-start gap-2">
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
      <div>
        <div className="font-medium">Поръчка с одобрение под доставна цена</div>
        <div className="text-xs opacity-80">
          Одобрена от {detail.below_cost_approved_by_name ?? "admin"} на{" "}
          {formatDate(detail.below_cost_approved_at)}
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Update Order interface in `warehouse-frontend/src/types/index.ts`**

```ts
below_cost_approved_at?: string | null;
below_cost_approved_by_name?: string | null;
below_cost_details?: BelowCostLine[] | null;
```

**Step 3: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx warehouse-frontend/src/types/index.ts
git commit -m "feat(orders-fe): drawer banner for below-cost approved orders"
```

---

## Task 14: Orders list — ⚠ icon in status column

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx:3823-3852` (status cell).

**Step 1: Insert ⚠ chip alongside the existing warehouse chip**

```tsx
{
  order.below_cost_approved_at && (
    <span
      className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-800 border border-amber-300"
      title={`Под cost — одобрена ${formatDate(order.below_cost_approved_at)}`}
    >
      <AlertTriangle className="h-3 w-3" />
    </span>
  );
}
```

**Step 2: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): warning chip on orders list for below-cost approved orders"
```

---

## Task 15: Reports filter pill — `Покажи под-cost`

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx:3611-3635` (status filter pills row).

**Step 1: Add a toggle pill (admin-only visibility)**

```tsx
{
  hasPermission(PERMISSIONS.BELOW_COST_OVERRIDE) && (
    <button
      onClick={() => setBelowCostOnly((v) => !v)}
      className={`px-3 py-1.5 rounded-full text-sm font-medium ${
        belowCostOnly
          ? "bg-amber-500 text-white"
          : "bg-gray-100 hover:bg-gray-200"
      }`}
    >
      ⚠ Под cost
    </button>
  );
}
```

**Step 2: Wire into orders query**

In the `useQuery({ queryKey: ["orders", …, belowCostOnly] })` queryFn, append `&below_cost_only=true` when active.

**Step 3: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): below-cost reports filter pill (admin only)"
```

---

## Task 16: Manual end-to-end verification

Run `./scripts/start-mertm.sh` and follow this script:

1. **Login admin** (`admin@mertm.bg`) → Поръчки → Нова поръчка
2. Add a product where unit_price < purchase_price → save → confirm dialog appears with correct loss → confirm → order created
3. Open the new order in drawer → verify the amber banner "Поръчка с одобрение под доставна цена"
4. Back to orders list → verify ⚠ chip in status column for that row
5. Click "⚠ Под cost" filter pill → list narrows to only that order
6. Find a `fulfilled` order → click "Редактирай артикули" → confirm modal opens
7. **Logout, login as sales user** (or use a sales test account) → repeat step 2 → verify red inline error "Свържи се с admin", submit blocked
8. As sales user, open a fulfilled order → verify "Редактирай артикули" button is hidden
9. As sales user, verify the "⚠ Под cost" filter pill is NOT shown

If any step fails, debug, fix, commit, re-run.

---

## Task 17: Update STATUS.md

**Files:**

- Modify: `STATUS.md`

**Step 1: Add an entry under "Done — Recent Sessions"**

```markdown
**Batch A — Permission features** (2026-04-29):

- Migration 056 — `orders.below_cost_approved_by/at/details` audit columns
- New permissions `BELOW_COST_OVERRIDE`, `ORDERS_EDIT_AFTER_FULFILL` (admin-only by default)
- Backend hard-block on POST/PUT /orders for below-cost lines without admin override
- Backend admin-only edit guard on `fulfilled`/`invoiced` orders
- Frontend confirm dialog + hard error for non-admin
- Audit banner in drawer + ⚠ chip in list + below-cost reports filter pill
```

**Step 2: Commit**

```bash
git add STATUS.md
git commit -m "docs(status): Batch A complete — below-cost override + edit lock"
```

---

## Verification checklist (`superpowers:verification-before-completion`)

Before declaring Batch A done:

- [ ] All migrations applied (`SELECT name FROM _migrations WHERE name='056_orders_below_cost_audit.sql'`)
- [ ] Backend tests pass: `npx vitest run` from `warehouse-backend/`
- [ ] Backend type-check clean: `npx tsc --noEmit`
- [ ] Frontend type-check clean: `cd warehouse-frontend && npx tsc --noEmit`
- [ ] Manual E2E walkthrough completed (Task 16, all 9 steps green)
- [ ] No `console.log` left in production code
- [ ] STATUS.md updated
- [ ] All commits use conventional format

If everything passes, the branch is ready for review and merge.
