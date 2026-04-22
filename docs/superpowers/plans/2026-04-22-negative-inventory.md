# Negative Inventory (Back-Order) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow selling products when stock reaches 0 so that `inventory.quantity` can go negative; deliveries offset the backlog automatically; a new "На минус" tab and a soft-confirm dialog keep operators in the loop.

**Architecture:** Three layers change. (1) DB — drop the `chk_inventory_qty_nonneg` CHECK constraint via a new migration. (2) Backend — `validateRequestedStock()` stops throwing and returns an info payload, `deductProductStock()` drops its `quantity >= $1` guard and falls back to INSERT when no inventory row exists, and `analytics.ts` downgrades the negative-stock anomaly from `critical` to `warning`. (3) Frontend — new `OversellConfirmDialog` component wired into the New Order modal and the Fulfill button in `Orders.tsx`, a fifth "На минус" tab in `Inventory.tsx`, a shared `stockColorClass()` util, and red indicators across Products/Inventory/order autocomplete.

**Tech Stack:** Fastify + TypeScript + PostgreSQL 16 (backend), Vitest with `vi.mock("../db.js")` + Fastify `app.inject()` for backend tests, React 18 + Vite + Tailwind v4 + TanStack Query + shadcn primitives (frontend). No frontend test framework is installed — UI is verified manually via `preview_*` tools.

**Spec:** `docs/superpowers/specs/2026-04-22-negative-inventory-design.md`

---

## File Structure

**Database**

- Create: `warehouse-backend/migrations/052_allow_negative_inventory.sql` — drops `chk_inventory_qty_nonneg`.

**Backend**

- Modify: `warehouse-backend/src/routes/orders.ts` — `validateRequestedStock()` (lines 1482-1523) and `deductProductStock()` (lines 1537-1571). Callers at lines 677 and 1102 are updated to consume the new return shape.
- Modify: `warehouse-backend/src/routes/analytics.ts` — severity string at lines 180-193.
- Create: `warehouse-backend/src/__tests__/negative-inventory.test.ts` — covers the new backend behaviours.

**Frontend**

- Create: `warehouse-frontend/src/components/OversellConfirmDialog.tsx` — shared confirm dialog.
- Modify: `warehouse-frontend/src/lib/utils.ts` — adds `stockColorClass()`.
- Modify: `warehouse-frontend/src/pages/Orders.tsx` — wires the dialog into New Order + Fulfill paths.
- Modify: `warehouse-frontend/src/pages/Inventory.tsx` — adds the "На минус" tab with red indicators and KPI card.
- Modify: `warehouse-frontend/src/pages/Products.tsx` — applies `stockColorClass()` to the stock column (drop-in replacement for the ad-hoc classes currently there).

---

## Task 1: Migration 052 — drop `chk_inventory_qty_nonneg`

**Files:**

- Create: `warehouse-backend/migrations/052_allow_negative_inventory.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- 052_allow_negative_inventory.sql
-- Allow inventory.quantity to go negative so operators can sell
-- back-ordered stock. Deliveries offset the negative balance via the
-- existing ON CONFLICT upsert in incoming/confirm.
--
-- Rollback (manual, not automated): run
--   ALTER TABLE inventory ADD CONSTRAINT chk_inventory_qty_nonneg
--     CHECK (quantity >= 0);
-- which will fail if any negative rows exist at the time of rollback.

ALTER TABLE inventory DROP CONSTRAINT IF EXISTS chk_inventory_qty_nonneg;
```

- [ ] **Step 2: Apply the migration against the dev DB**

Run: `cd warehouse-backend && psql "$DATABASE_URL" -f migrations/052_allow_negative_inventory.sql`
Expected: `ALTER TABLE` printed, no errors.

- [ ] **Step 3: Verify the constraint is gone**

Run:

```bash
psql "$DATABASE_URL" -c "SELECT conname FROM pg_constraint WHERE conrelid = 'inventory'::regclass AND conname = 'chk_inventory_qty_nonneg';"
```

Expected: `(0 rows)`.

- [ ] **Step 4: Verify negatives are accepted**

Run:

```bash
psql "$DATABASE_URL" -c "DO \$\$ BEGIN INSERT INTO inventory (product_id, warehouse_id, quantity) VALUES (999999, 1, -5); DELETE FROM inventory WHERE product_id = 999999; END \$\$;"
```

Expected: `DO` printed with no CHECK violation. The inline cleanup keeps the DB clean.

- [ ] **Step 5: Commit**

```bash
git add warehouse-backend/migrations/052_allow_negative_inventory.sql
git commit -m "feat(inventory): migration 052 — drop qty_nonneg CHECK to allow back-orders"
```

---

## Task 2: Write failing test for `deductProductStock` going negative

**Files:**

- Create: `warehouse-backend/src/__tests__/negative-inventory.test.ts`

This task only introduces the first test and confirms it fails against the _current_ implementation. Task 3 makes it pass.

- [ ] **Step 1: Create the test file with the first failing case**

```typescript
// warehouse-backend/src/__tests__/negative-inventory.test.ts
//
// MERT-M: back-order support — inventory.quantity is allowed to go
// negative. Follows the project pattern from
// incoming-confirm-inventory.test.ts: vi.mock("../db.js"), auth
// injected via onRequest hook, assertions on the SQL that the route
// issues to the mocked client.
import Fastify, { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  query: vi.fn(async () => ({ rows: [] })),
  transaction: vi.fn(),
}));

import { transaction } from "../db.js";
import orderRoutes from "../routes/orders.js";

const mockTransaction = vi.mocked(transaction);

function rows<T>(list: T[]) {
  return { rows: list, rowCount: list.length } as any;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-admin",
      email: "admin@mertm.bg",
      role: "admin",
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(orderRoutes, { prefix: "/orders" });
  return app;
}

describe("orders route — back-order / negative inventory", () => {
  beforeEach(() => {
    mockTransaction.mockReset();
  });

  it("fulfill allows inventory.quantity to go negative (UPDATE drops the >= guard)", async () => {
    // Order #42 has a single pending item (product 7, qty 3). Stock is 0.
    // After the change, deductProductStock must UPDATE without the
    // `quantity >= $1` guard so the row lands at -3.
    const clientQuery = vi
      .fn()
      // 1. SELECT * FROM orders WHERE id = $1 FOR UPDATE
      .mockResolvedValueOnce(
        rows([
          {
            id: 42,
            status: "pending",
            partner_id: 1,
            total_amount: "30",
          },
        ]),
      )
      // 2. SELECT * FROM order_items WHERE order_id = $1
      .mockResolvedValueOnce(
        rows([
          {
            id: 501,
            order_id: 42,
            product_id: 7,
            quantity: "3",
            unit_price: "10",
          },
        ]),
      )
      // 3. deductProductStock UPDATE inventory ... RETURNING quantity
      //    Current stock is 0 → new stock is -3. Row IS returned.
      .mockResolvedValueOnce(rows([{ quantity: "-3" }]))
      // 4. SELECT purchase_price FROM products WHERE id = $1
      .mockResolvedValueOnce(rows([{ purchase_price: "5" }]))
      // 5. UPDATE order_items SET cost_unit_price ... (one per item)
      .mockResolvedValueOnce(rows([]))
      // 6. UPDATE orders SET status='fulfilled', fulfilled_at = NOW() ...
      .mockResolvedValueOnce(rows([]))
      // 7. INSERT INTO notifications
      .mockResolvedValueOnce(rows([]));

    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ query: clientQuery }),
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/orders/42/fulfill",
      });

      expect(res.statusCode).toBe(200);

      // The deductProductStock UPDATE must NOT carry the old guard.
      const deductCall = clientQuery.mock.calls.find(
        (call: any[]) =>
          String(call[0]).includes("UPDATE inventory") &&
          String(call[0]).includes("SET quantity = quantity -"),
      );
      expect(deductCall).toBeDefined();
      expect(String(deductCall![0])).not.toMatch(/quantity\s*>=\s*\$/);
    } finally {
      await app.close();
    }
  });
});
```

- [ ] **Step 2: Run the test — expect it to fail**

Run: `cd warehouse-backend && npx vitest run src/__tests__/negative-inventory.test.ts`
Expected: FAIL. Reason: the UPDATE at orders.ts:1543-1550 still contains `AND quantity >= $1`, so the assertion `expect(...).not.toMatch(/quantity\s*>=\s*\$/)` fails. The mock stack may also diverge because the current code throws `insufficient_stock` when no row is returned — this test does not exercise that path yet, but the SQL assertion is the gate.

- [ ] **Step 3: Commit the failing test**

```bash
git add warehouse-backend/src/__tests__/negative-inventory.test.ts
git commit -m "test(inventory): failing test — deduct must allow stock to go negative"
```

---

## Task 3: Implement `deductProductStock` — drop `>=` guard + fallback INSERT

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts:1537-1571`

- [ ] **Step 1: Replace the function body**

In `warehouse-backend/src/routes/orders.ts`, replace the existing `deductProductStock` implementation (currently lines 1537-1571) with:

```typescript
/**
 * MERT-M per-product stock deduction — back-order aware.
 *
 * First attempts an atomic UPDATE without a quantity guard so the
 * inventory row is allowed to go negative (sells into the red). If
 * no row exists for this product/warehouse yet, fall back to an
 * INSERT with a negative quantity; the partial unique index
 * `inventory_product_warehouse_nobatch_uidx` (migration 045) keeps
 * this safe against concurrent inserts because there is only one
 * batch_id-NULL row per product/warehouse.
 *
 * Returns the COGS unit price snapshotted from products.purchase_price
 * for later profit reporting (unchanged from the old behaviour).
 */
async function deductProductStock(
  db: DbExecutor,
  productId: number,
  quantity: number,
): Promise<number | null> {
  const { rowCount } = await db.query(
    `UPDATE inventory
         SET quantity = quantity - $1,
             updated_at = NOW()
       WHERE product_id = $2
         AND warehouse_id = 1
         AND batch_id IS NULL
       RETURNING quantity`,
    [quantity, productId],
  );

  if (!rowCount) {
    // No inventory row at all — a product that has never been
    // delivered yet is being sold. Create a row starting at -qty.
    await db.query(
      `INSERT INTO inventory (product_id, warehouse_id, quantity, batch_id)
         VALUES ($1, 1, $2, NULL)`,
      [productId, -quantity],
    );
  }

  const { rows: productRows } = await db.query(
    "SELECT purchase_price FROM products WHERE id = $1",
    [productId],
  );
  const fallbackCost = parseFloat(productRows[0]?.purchase_price ?? "0");
  return Number.isFinite(fallbackCost) && fallbackCost > 0
    ? fallbackCost
    : null;
}
```

- [ ] **Step 2: Run the failing test from Task 2 — expect it to pass**

Run: `cd warehouse-backend && npx vitest run src/__tests__/negative-inventory.test.ts`
Expected: PASS (1/1). The UPDATE no longer contains the `>=` guard, and the mock stack matches the new call sequence.

- [ ] **Step 3: Add the fallback-INSERT test**

Append to `warehouse-backend/src/__tests__/negative-inventory.test.ts` inside the same `describe` block:

```typescript
it("fulfill falls back to INSERT when inventory row is missing entirely", async () => {
  // Product 8 has never been delivered → no inventory row at all.
  // Fulfilling qty 2 must UPDATE (0 rows), then INSERT with qty -2.
  const clientQuery = vi
    .fn()
    .mockResolvedValueOnce(
      rows([{ id: 43, status: "pending", partner_id: 1, total_amount: "20" }]),
    )
    .mockResolvedValueOnce(
      rows([
        {
          id: 510,
          order_id: 43,
          product_id: 8,
          quantity: "2",
          unit_price: "10",
        },
      ]),
    )
    // UPDATE inventory ... RETURNING quantity → 0 rows (no match)
    .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
    // INSERT INTO inventory ... VALUES ($1, 1, $2, NULL)
    .mockResolvedValueOnce(rows([]))
    // SELECT purchase_price
    .mockResolvedValueOnce(rows([{ purchase_price: "5" }]))
    // UPDATE order_items SET cost_unit_price
    .mockResolvedValueOnce(rows([]))
    // UPDATE orders SET status='fulfilled'
    .mockResolvedValueOnce(rows([]))
    // INSERT INTO notifications
    .mockResolvedValueOnce(rows([]));

  mockTransaction.mockImplementation(async (callback: any) =>
    callback({ query: clientQuery }),
  );

  const app = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/orders/43/fulfill",
    });

    expect(res.statusCode).toBe(200);

    const insertCall = clientQuery.mock.calls.find((call: any[]) =>
      String(call[0]).includes("INSERT INTO inventory"),
    );
    expect(insertCall).toBeDefined();
    // Args: [product_id, -quantity]
    expect(insertCall![1]).toEqual([8, -2]);
  } finally {
    await app.close();
  }
});

it("insufficient_stock error is no longer thrown on fulfillment", async () => {
  // Previously this payload threw a 400 `insufficient_stock`. Under
  // back-order semantics it must succeed with the inventory row
  // going into the red.
  const clientQuery = vi
    .fn()
    .mockResolvedValueOnce(
      rows([{ id: 44, status: "pending", partner_id: 1, total_amount: "100" }]),
    )
    .mockResolvedValueOnce(
      rows([
        {
          id: 520,
          order_id: 44,
          product_id: 9,
          quantity: "10",
          unit_price: "10",
        },
      ]),
    )
    .mockResolvedValueOnce(rows([{ quantity: "-10" }]))
    .mockResolvedValueOnce(rows([{ purchase_price: "5" }]))
    .mockResolvedValueOnce(rows([]))
    .mockResolvedValueOnce(rows([]))
    .mockResolvedValueOnce(rows([]));

  mockTransaction.mockImplementation(async (callback: any) =>
    callback({ query: clientQuery }),
  );

  const app = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/orders/44/fulfill",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty("error", "insufficient_stock");
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 4: Run the expanded test file — expect 3/3 PASS**

Run: `cd warehouse-backend && npx vitest run src/__tests__/negative-inventory.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts warehouse-backend/src/__tests__/negative-inventory.test.ts
git commit -m "feat(orders): deductProductStock allows inventory to go negative"
```

---

## Task 4: Rewrite `validateRequestedStock` — return info, never throw

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts:1482-1523` (the function)
- Modify: `warehouse-backend/src/routes/orders.ts:677` (POST /orders caller)
- Modify: `warehouse-backend/src/routes/orders.ts:1102` (PUT /orders/:id caller)

- [ ] **Step 1: Add the failing test for the new behaviour**

Append to `warehouse-backend/src/__tests__/negative-inventory.test.ts` inside the same `describe` block:

```typescript
it("POST /orders succeeds with warnings.oversell when stock is insufficient", async () => {
  // Partner 1, product 7 has stock 0, user orders 3 → response must
  // be 201 with an informational oversell warning, NOT a 400.
  const clientQuery = vi
    .fn()
    // 1. SELECT * FROM partners
    .mockResolvedValueOnce(
      rows([
        {
          id: 1,
          name: "Test Partner",
          price_group: null,
          price_list_id: null,
        },
      ]),
    )
    // 2. SELECT id, selling_price, group_price, name_bg FROM products
    .mockResolvedValueOnce(
      rows([{ id: 7, selling_price: "10", name_bg: "Test Product" }]),
    )
    // 3. validateRequestedStock → SELECT COALESCE(SUM(quantity), 0)
    //    Stock is 0; requested 3 → oversell.
    .mockResolvedValueOnce(rows([{ total: "0" }]))
    // 4. INSERT INTO orders ... RETURNING *
    .mockResolvedValueOnce(
      rows([
        {
          id: 101,
          partner_id: 1,
          status: "pending",
          order_number: 101,
        },
      ]),
    )
    // 5. INSERT INTO order_items ... RETURNING *
    .mockResolvedValueOnce(
      rows([
        {
          id: 1001,
          order_id: 101,
          product_id: 7,
          quantity: "3",
          unit_price: "10",
          discount_percent: "0",
          total_price: "30",
        },
      ]),
    )
    // 6. UPDATE orders SET total_amount
    .mockResolvedValueOnce(rows([]))
    // 7. INSERT INTO notifications
    .mockResolvedValueOnce(rows([]));

  mockTransaction.mockImplementation(async (callback: any) =>
    callback({ query: clientQuery }),
  );

  const app = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        partner_id: 1,
        items: [{ product_id: 7, quantity: 3, unit_price: 10 }],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.warnings?.oversell).toBeDefined();
    expect(body.warnings.oversell).toEqual([
      {
        product_id: 7,
        available: 0,
        requested: 3,
        final_stock: -3,
      },
    ]);
  } finally {
    await app.close();
  }
});

it("POST /orders omits warnings.oversell when all items have sufficient stock", async () => {
  const clientQuery = vi
    .fn()
    .mockResolvedValueOnce(
      rows([
        {
          id: 1,
          name: "Test Partner",
          price_group: null,
          price_list_id: null,
        },
      ]),
    )
    .mockResolvedValueOnce(
      rows([{ id: 7, selling_price: "10", name_bg: "Test Product" }]),
    )
    .mockResolvedValueOnce(rows([{ total: "10" }])) // plenty of stock
    .mockResolvedValueOnce(
      rows([{ id: 102, partner_id: 1, status: "pending", order_number: 102 }]),
    )
    .mockResolvedValueOnce(
      rows([
        {
          id: 1002,
          order_id: 102,
          product_id: 7,
          quantity: "3",
          unit_price: "10",
          discount_percent: "0",
          total_price: "30",
        },
      ]),
    )
    .mockResolvedValueOnce(rows([]))
    .mockResolvedValueOnce(rows([]));

  mockTransaction.mockImplementation(async (callback: any) =>
    callback({ query: clientQuery }),
  );

  const app = await buildApp();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        partner_id: 1,
        items: [{ product_id: 7, quantity: 3, unit_price: 10 }],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.warnings?.oversell).toBeUndefined();
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 2: Run the expanded test file — expect failures on the two new cases**

Run: `cd warehouse-backend && npx vitest run src/__tests__/negative-inventory.test.ts`
Expected: First three cases PASS. The two new cases FAIL — the current `validateRequestedStock` throws a 400 `"Недостатъчна наличност"`, so the 201-with-warnings case gets a 400 and the sufficient-stock case may pass the status check but the mock call count is one too low (the old function only issues SELECT; the new one should still issue exactly one SELECT per product, so the counts match — this case is the positive-control for the next edit).

- [ ] **Step 3: Replace `validateRequestedStock` implementation**

In `warehouse-backend/src/routes/orders.ts`, replace the function at lines 1482-1523 with:

```typescript
interface OversellInfo {
  product_id: number;
  available: number;
  requested: number;
  final_stock: number;
}

async function validateRequestedStock(
  db: DbExecutor,
  items: Array<{
    product_id: number;
    quantity: number;
  }>,
  _productMap: Map<number, any>,
): Promise<{ oversell_items: OversellInfo[] }> {
  const requestedByProduct = new Map<number, number>();
  for (const item of items) {
    requestedByProduct.set(
      item.product_id,
      (requestedByProduct.get(item.product_id) || 0) + item.quantity,
    );
  }

  const oversell_items: OversellInfo[] = [];
  for (const [productId, requestedQty] of requestedByProduct.entries()) {
    const {
      rows: [stockRow],
    } = await db.query(
      "SELECT COALESCE(SUM(quantity), 0)::numeric AS total FROM inventory WHERE product_id = $1",
      [productId],
    );
    const available = parseFloat(stockRow.total);
    if (available + EPSILON < requestedQty) {
      oversell_items.push({
        product_id: productId,
        available,
        requested: requestedQty,
        final_stock: available - requestedQty,
      });
    }
  }

  return { oversell_items };
}
```

- [ ] **Step 4: Update the POST /orders caller to surface the warning**

Find the block at `warehouse-backend/src/routes/orders.ts:677` that currently reads:

```typescript
await validateRequestedStock(client, body.items, productMap);
```

Replace with:

```typescript
const { oversell_items } = await validateRequestedStock(
  client,
  body.items,
  productMap,
);
```

Then locate the `return reply.status(201).send({...})` for this POST handler (search forward from line 677 for `reply.status(201).send` or `reply.code(201).send`). Add a conditional `warnings` field to the response body. If the response currently looks like:

```typescript
return reply.status(201).send(createdOrder);
```

Change to:

```typescript
const response: any = { ...createdOrder };
if (oversell_items.length > 0) {
  response.warnings = { oversell: oversell_items };
}
return reply.status(201).send(response);
```

If the response currently spreads multiple fields (e.g. `send({ ...order, items })`), merge the `warnings` key into the same object literal:

```typescript
return reply.status(201).send({
  ...order,
  items,
  ...(oversell_items.length > 0
    ? { warnings: { oversell: oversell_items } }
    : {}),
});
```

- [ ] **Step 5: Update the PUT /orders/:id caller**

Find the block at `warehouse-backend/src/routes/orders.ts:1102` that currently reads:

```typescript
await validateRequestedStock(client, body.items, productMap);
```

Replace with:

```typescript
const { oversell_items } = await validateRequestedStock(
  client,
  body.items,
  productMap,
);
```

Then locate the response (`return reply.send(...)` shortly after the update-block). Merge the same `warnings` field:

```typescript
const response: any = { ...updatedOrder };
if (oversell_items.length > 0) {
  response.warnings = { oversell: oversell_items };
}
return reply.send(response);
```

If the PUT handler returns a different shape (e.g. `{ order, items }`), merge `warnings` as a sibling key the same way as Step 4.

- [ ] **Step 6: Run the test file — expect 5/5 PASS**

Run: `cd warehouse-backend && npx vitest run src/__tests__/negative-inventory.test.ts`
Expected: PASS (5/5).

- [ ] **Step 7: Run the full backend test suite — check for regressions**

Run: `cd warehouse-backend && npx vitest run`
Expected: All tests pass except the two pre-existing `payments-razpiska.test.ts` failures (unrelated, existed on `main` before this branch). If any `orders`-related test now fails (e.g. a test that asserted the 400 `"Недостатъчна наличност"` response), open it, update the expectation to 201 with `warnings.oversell`, and re-run. Commit the fix together with the implementation.

- [ ] **Step 8: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts warehouse-backend/src/__tests__/negative-inventory.test.ts
git commit -m "feat(orders): validateRequestedStock returns info instead of throwing"
```

---

## Task 5: Regression tests for incoming goods + cancellation math

No production code changes — the existing `ON CONFLICT ... DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity` already behaves correctly when the current value is negative. These tests are a guard: they lock in the math so a future change cannot silently break back-order reconciliation.

**Files:**

- Modify: `warehouse-backend/src/__tests__/negative-inventory.test.ts` (append two cases)

- [ ] **Step 1: Add the delivery-offsets-backlog test**

Append to the same `describe` block:

```typescript
it("confirming incoming goods offsets a negative inventory balance", async () => {
  // Inventory row for product 7 currently at -3. Incoming goods #99
  // carries qty 10. After confirm, the row must go from -3 to 7 via
  // the existing ON CONFLICT upsert — we only assert that the route
  // does NOT emit any conditional that would filter negatives out
  // (the upsert SQL is the same for all starting values).
  //
  // NOTE: This test lives in this file (not incoming-confirm-inventory.test.ts)
  // because its purpose is to guard back-order semantics as a whole.
  // We re-import the incoming route locally to avoid mutating the
  // outer file's top-level registration.
  const incomingRoutes = (await import("../routes/incoming.js")).default;
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "u-warehouse",
      email: "warehouse@test.local",
      role: "warehouse",
    };
    (request as any).jwtVerify = async () => (request as any).user;
  });
  await app.register(incomingRoutes, { prefix: "/incoming" });

  const clientQuery = vi
    .fn()
    // UPDATE incoming_goods → row returned (was pending)
    .mockResolvedValueOnce(
      rows([{ id: 99, status: "pending", invoice_number: "INV-99" }]),
    )
    // SELECT * FROM incoming_items
    .mockResolvedValueOnce(
      rows([
        {
          id: 1,
          product_id: 7,
          batch_id: null,
          quantity: 10,
          unit_price: 5,
        },
      ]),
    )
    // INSERT INTO inventory ... ON CONFLICT DO UPDATE
    .mockResolvedValueOnce(rows([]))
    // UPDATE products SET purchase_price
    .mockResolvedValueOnce(rows([]))
    // INSERT INTO notifications
    .mockResolvedValueOnce(rows([]));

  mockTransaction.mockImplementation(async (callback: any) =>
    callback({ query: clientQuery }),
  );

  try {
    const res = await app.inject({
      method: "PUT",
      url: "/incoming/99/confirm",
    });
    expect(res.statusCode).toBe(200);

    const insertInv = clientQuery.mock.calls.find((call: any[]) =>
      String(call[0]).includes("INSERT INTO inventory"),
    );
    expect(insertInv).toBeDefined();
    const sql = String(insertInv![0]);
    // The upsert must not gate on `quantity >= 0` anywhere — the
    // math has to apply unconditionally so negatives get offset.
    expect(sql).toMatch(/ON CONFLICT/);
    expect(sql).not.toMatch(/WHERE\s+inventory\.quantity\s*>=\s*0/);
    expect(sql).not.toMatch(/HAVING\s+.*quantity\s*>=\s*0/);
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 2: Add the cancel-restores-stock test**

Append:

```typescript
it("cancelling a fulfilled order adds the quantity back (may turn -1 into 2)", async () => {
  // Order 50 was fulfilled with qty 3 of product 7. Inventory is -1.
  // Cancelling it calls restoreOrderItemsToInventory → the ON CONFLICT
  // upsert adds 3 and the row becomes 2.
  const clientQuery = vi
    .fn()
    // 1. SELECT * FROM orders WHERE id = $1 FOR UPDATE
    .mockResolvedValueOnce(
      rows([
        {
          id: 50,
          status: "fulfilled",
          partner_id: 1,
          total_amount: "30",
        },
      ]),
    )
    // 2. SELECT items FROM order_items (restore pass)
    .mockResolvedValueOnce(
      rows([
        {
          id: 601,
          order_id: 50,
          product_id: 7,
          quantity: "3",
        },
      ]),
    )
    // 3. INSERT INTO inventory ON CONFLICT DO UPDATE (restore)
    .mockResolvedValueOnce(rows([]))
    // 4. UPDATE orders SET status='cancelled'
    .mockResolvedValueOnce(rows([]))
    // 5. INSERT INTO notifications
    .mockResolvedValueOnce(rows([]));

  mockTransaction.mockImplementation(async (callback: any) =>
    callback({ query: clientQuery }),
  );

  const app = await buildApp();
  try {
    const res = await app.inject({
      method: "DELETE",
      url: "/orders/50",
    });

    expect(res.statusCode).toBe(200);

    const upsert = clientQuery.mock.calls.find((call: any[]) =>
      String(call[0]).includes("INSERT INTO inventory"),
    );
    expect(upsert).toBeDefined();
    // The restore path must not filter on quantity sign either.
    expect(String(upsert![0])).not.toMatch(/quantity\s*>=\s*0/);
  } finally {
    await app.close();
  }
});
```

- [ ] **Step 3: Run the file — expect 7/7 PASS**

Run: `cd warehouse-backend && npx vitest run src/__tests__/negative-inventory.test.ts`
Expected: PASS (7/7). If either test fails because the mock call sequence does not match the real route (e.g. an extra SELECT happens before the upsert), read the relevant route implementation and adjust the mock stack — the point of the test is the **absence of quantity-sign guards in the SQL**, not the exact call count.

- [ ] **Step 4: Commit**

```bash
git add warehouse-backend/src/__tests__/negative-inventory.test.ts
git commit -m "test(inventory): guard incoming/cancel math stays sign-agnostic"
```

---

## Task 6: Analytics — downgrade `negative_stock` severity

**Files:**

- Modify: `warehouse-backend/src/routes/analytics.ts:180-193`

- [ ] **Step 1: Edit the severity string**

In `warehouse-backend/src/routes/analytics.ts` around lines 187-192, replace:

```typescript
for (const item of negativeStock) {
  anomalies.push({
    type: "negative_stock",
    severity: "critical",
    ...item,
  });
}
```

with:

```typescript
for (const item of negativeStock) {
  anomalies.push({
    type: "negative_stock",
    severity: "warning",
    ...item,
  });
}
```

- [ ] **Step 2: Run the full backend test suite — confirm no regressions**

Run: `cd warehouse-backend && npx vitest run`
Expected: Same pass/fail profile as before (only pre-existing `payments-razpiska.test.ts` failures). If any test asserted `severity: "critical"` for `negative_stock`, update it to `"warning"` and re-run.

- [ ] **Step 3: Commit**

```bash
git add warehouse-backend/src/routes/analytics.ts
git commit -m "refactor(analytics): negative_stock anomaly is a warning, not critical"
```

---

## Task 7: Frontend util — `stockColorClass`

**Files:**

- Modify: `warehouse-frontend/src/lib/utils.ts`

- [ ] **Step 1: Append the util**

Add at the end of `warehouse-frontend/src/lib/utils.ts`:

```typescript
/**
 * Returns the Tailwind classes for displaying an inventory quantity.
 * Red+bold for negative (back-order), gray for zero, amber for
 * low-stock, default dark gray otherwise. Callers that know the
 * product's `low_stock_threshold` should pass it; missing threshold
 * is treated as "not low".
 */
export function stockColorClass(
  qty: number,
  lowStockThreshold?: number | null,
): string {
  if (!Number.isFinite(qty)) return "text-gray-900";
  if (qty < 0) return "text-red-600 font-semibold";
  if (qty === 0) return "text-gray-500";
  if (
    lowStockThreshold != null &&
    lowStockThreshold > 0 &&
    qty <= lowStockThreshold
  ) {
    return "text-amber-600";
  }
  return "text-gray-900";
}
```

- [ ] **Step 2: Type-check the frontend**

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: No TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add warehouse-frontend/src/lib/utils.ts
git commit -m "feat(frontend): add stockColorClass util for back-order indicators"
```

---

## Task 8: Frontend component — `OversellConfirmDialog`

**Files:**

- Create: `warehouse-frontend/src/components/OversellConfirmDialog.tsx`

The project has `src/components/ui/dialog.tsx` (shadcn `Dialog`). There is no `AlertDialog` primitive installed; the spec says "Built on the existing shadcn AlertDialog primitive" but in this codebase we reuse `Dialog` — same UX (modal overlay, title, actions), with our own action layout. This is a deliberate deviation from the spec's wording because installing a new shadcn primitive is out of scope.

- [ ] **Step 1: Create the component**

```typescript
// warehouse-frontend/src/components/OversellConfirmDialog.tsx
import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface OversellItem {
  product_name: string;
  available: number;
  requested: number;
  final_stock: number; // negative
}

export interface OversellConfirmDialogProps {
  open: boolean;
  items: OversellItem[];
  onConfirm: () => void;
  onCancel: () => void;
}

export function OversellConfirmDialog({
  open,
  items,
  onConfirm,
  onCancel,
}: OversellConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-700">
            <AlertTriangle className="h-5 w-5" />
            Наличността ще отиде под нулата
          </DialogTitle>
          <DialogDescription>
            Потвърди, че искаш да продължиш — стоките ще влязат в минус и
            ще се появят в раздел „На минус" в склада.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2 py-2 max-h-64 overflow-y-auto">
          {items.map((item, idx) => (
            <li
              key={`${item.product_name}-${idx}`}
              className="text-sm leading-snug"
            >
              <span className="font-medium text-gray-900">
                {item.product_name}
              </span>
              {" — ще стане "}
              <span className="font-semibold text-red-600">
                {item.final_stock}
              </span>{" "}
              <span className="text-xs text-gray-500">
                (налично: {item.available}, поръчка: {item.requested})
              </span>
            </li>
          ))}
        </ul>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel}>
            Отказ
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            autoFocus
          >
            Продължи
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add warehouse-frontend/src/components/OversellConfirmDialog.tsx
git commit -m "feat(frontend): add OversellConfirmDialog component"
```

---

## Task 9: Wire `OversellConfirmDialog` into New Order submit

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx`

The New Order modal currently POSTs `/orders` directly on submit. We intercept the submit, compute the oversell items client-side against the cached `total_stock`, and if any are negative we show the dialog. The user's Продължи triggers the real POST.

This task's scope: only the New Order flow. Fulfill comes in Task 10.

- [ ] **Step 1: Read the current submit handler**

Run: `cd warehouse-frontend && grep -n "POST.*orders\|partner_id.*items\|onSubmit\|handleSubmit\|mutationFn.*orders" src/pages/Orders.tsx | head -30`
Expected: The output identifies the mutation that POSTs `/orders` and the corresponding `onClick`/`onSubmit` handler on the "Създай поръчка" button. Use these line numbers to locate the edit site.

- [ ] **Step 2: Add the dialog-state hook and confirm-gate**

At the top of the New Order modal component (search for the component that renders the "Създай поръчка" button — typically `NewOrderModal` or similar inside `Orders.tsx`), add:

```typescript
import {
  OversellConfirmDialog,
  type OversellItem,
} from "@/components/OversellConfirmDialog";
```

Inside the component, add this state:

```typescript
const [pendingOversell, setPendingOversell] = useState<{
  items: OversellItem[];
  proceed: () => void;
} | null>(null);
```

Create a helper that computes oversell items from the current form rows against the already-loaded products cache. Insert it near the existing form helpers (for example next to the `canSubmit` / total-calculation blocks):

```typescript
function computeOversellItems(): OversellItem[] {
  const byProduct = new Map<number, number>();
  for (const row of orderItems) {
    if (!row.product_id) continue;
    const qty = parseFloat(String(row.quantity || 0));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    byProduct.set(row.product_id, (byProduct.get(row.product_id) || 0) + qty);
  }
  const result: OversellItem[] = [];
  for (const [productId, requested] of byProduct) {
    const product = (products as any[]).find((p) => p.id === productId);
    if (!product) continue;
    const available = parseFloat(String(product.total_stock || 0));
    if (available - requested < 0) {
      result.push({
        product_name:
          product.name_bg || product.name_en || `Продукт #${productId}`,
        available,
        requested,
        final_stock: available - requested,
      });
    }
  }
  return result;
}
```

The variable names `orderItems` and `products` must match the variables the existing handler already uses; if they are called differently (e.g. `formItems`, `productsQuery.data`), substitute accordingly.

- [ ] **Step 3: Intercept the submit**

Find the button that actually creates the order. Its `onClick` currently calls the create mutation directly:

```typescript
              onClick={() => createOrderMutation.mutate(payload)}
```

Replace with:

```typescript
              onClick={() => {
                const oversell = computeOversellItems();
                if (oversell.length > 0) {
                  setPendingOversell({
                    items: oversell,
                    proceed: () => createOrderMutation.mutate(payload),
                  });
                  return;
                }
                createOrderMutation.mutate(payload);
              }}
```

If the button currently wraps a `<form onSubmit={...}>`, apply the same gate inside the `onSubmit` handler (`event.preventDefault()` first, then the oversell check).

- [ ] **Step 4: Render the dialog**

At the end of the modal's JSX (just before the closing `</Dialog>` or `</DialogContent>` of the New Order modal itself — not the root), add:

```tsx
<OversellConfirmDialog
  open={!!pendingOversell}
  items={pendingOversell?.items ?? []}
  onCancel={() => setPendingOversell(null)}
  onConfirm={() => {
    const proceed = pendingOversell?.proceed;
    setPendingOversell(null);
    proceed?.();
  }}
/>
```

- [ ] **Step 5: Surface the server warning toast**

Find the `onSuccess` handler of the create-order mutation and add a conditional toast:

```typescript
        onSuccess: (response) => {
          const oversell = response.data?.warnings?.oversell;
          if (Array.isArray(oversell) && oversell.length > 0) {
            toast.warning(
              `Поръчката е записана, но ${oversell.length} ${oversell.length === 1 ? "артикул ще влезе" : "артикула ще влязат"} в минус при изпълнение.`,
            );
          }
          // ...existing logic (close modal, invalidate queries, etc.)
        },
```

Use whichever toast API the file already imports (`sonner`'s `toast` is already wired at `App.tsx`).

- [ ] **Step 6: Type-check + manual smoke**

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: No errors.

Start the dev server if not running, then verify:

1. Add a product with stock 0 to a new order, click Създай → dialog appears with the product name and "-X" final stock.
2. Click Отказ → dialog closes, order is NOT created.
3. Reopen, click Продължи → dialog closes, order IS created, warning toast appears.

Checks via preview tools:

- `preview_snapshot` → confirm dialog title "Наличността ще отиде под нулата" is on the page.
- `preview_console_logs` → no React warnings or uncaught errors.

- [ ] **Step 7: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders): soft-confirm dialog before submitting back-order new order"
```

---

## Task 10: Wire `OversellConfirmDialog` into Fulfill button

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx`

The Fulfill button lives in the orders list row. Clicking it today POSTs to `/orders/:id/fulfill` directly. We gate it with the same dialog, using the order-detail items + the current products cache.

- [ ] **Step 1: Locate the Fulfill handler**

Run: `cd warehouse-frontend && grep -n "fulfill\|Изпълни" src/pages/Orders.tsx | head`
Expected: The output identifies the mutation that POSTs `/orders/:id/fulfill` and the button/menu item that triggers it.

- [ ] **Step 2: Fetch order items + compute oversell**

The fulfill button currently calls `fulfillMutation.mutate(orderId)` without fetching item details first. Replace the handler with an async function that fetches the order detail, computes the oversell items, and either opens the dialog or proceeds directly:

```typescript
async function handleFulfillClick(orderId: number) {
  try {
    const detailRes = await api.get(`/orders/${orderId}`);
    const detail = detailRes.data?.data ?? detailRes.data;
    const itemsList: Array<{
      product_id: number;
      quantity: number | string;
    }> = detail?.items ?? [];

    const byProduct = new Map<number, number>();
    for (const it of itemsList) {
      const qty = parseFloat(String(it.quantity));
      if (!Number.isFinite(qty) || qty <= 0) continue;
      byProduct.set(it.product_id, (byProduct.get(it.product_id) || 0) + qty);
    }

    const oversell: OversellItem[] = [];
    for (const [productId, requested] of byProduct) {
      const product = (products as any[]).find((p) => p.id === productId);
      if (!product) continue;
      const available = parseFloat(String(product.total_stock || 0));
      if (available - requested < 0) {
        oversell.push({
          product_name:
            product.name_bg || product.name_en || `Продукт #${productId}`,
          available,
          requested,
          final_stock: available - requested,
        });
      }
    }

    if (oversell.length > 0) {
      setPendingFulfillOversell({
        items: oversell,
        proceed: () => fulfillMutation.mutate(orderId),
      });
      return;
    }
    fulfillMutation.mutate(orderId);
  } catch (err) {
    toast.error(getApiErrorMessage(err, "Грешка при проверка на наличността."));
  }
}
```

Add the corresponding state (placed next to other orders-list state, outside the New Order modal):

```typescript
const [pendingFulfillOversell, setPendingFulfillOversell] = useState<{
  items: OversellItem[];
  proceed: () => void;
} | null>(null);
```

- [ ] **Step 3: Replace the fulfill button's onClick**

Find the button/menu item that calls `fulfillMutation.mutate(order.id)` and change it to `handleFulfillClick(order.id)`.

- [ ] **Step 4: Render the dialog at the list level**

At the top level of the Orders page (not inside the New Order modal), add a second dialog instance:

```tsx
<OversellConfirmDialog
  open={!!pendingFulfillOversell}
  items={pendingFulfillOversell?.items ?? []}
  onCancel={() => setPendingFulfillOversell(null)}
  onConfirm={() => {
    const proceed = pendingFulfillOversell?.proceed;
    setPendingFulfillOversell(null);
    proceed?.();
  }}
/>
```

- [ ] **Step 5: Type-check + manual smoke**

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: No errors.

Manual check (via `preview_*` tools):

1. Pick a pending order whose product has stock 0. Click Изпълни → dialog appears.
2. Отказ → order stays pending.
3. Продължи → order is fulfilled, the product's row in Склад shows negative stock.

- [ ] **Step 6: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders): soft-confirm dialog before fulfilling into back-order"
```

---

## Task 11: Inventory page — "На минус" tab

**Files:**

- Modify: `warehouse-frontend/src/pages/Inventory.tsx`

- [ ] **Step 1: Extend the Tab type and tabs list**

At the top of `Inventory.tsx`, change:

```typescript
type Tab = "available" | "all" | "zero" | "low-stock";
```

to:

```typescript
type Tab = "available" | "all" | "zero" | "low-stock" | "negative";
```

Then in the `tabs` array (currently lines 268-277), append the new tab after `low-stock`:

```typescript
const tabs: {
  key: Tab;
  label: string;
  icon: React.ElementType;
}[] = [
  { key: "available", label: "Налични", icon: PackageCheck },
  { key: "all", label: "Всички", icon: Warehouse },
  { key: "zero", label: "Нулеви", icon: PackageX },
  { key: "low-stock", label: "Нисък запас", icon: AlertTriangle },
  { key: "negative", label: "На минус", icon: AlertTriangle },
];
```

- [ ] **Step 2: Extend `tabSummaryLabel`**

Replace the `tabSummaryLabel` block (currently lines 260-266) with:

```typescript
const tabSummaryLabel =
  tab === "available"
    ? "Налични артикули"
    : tab === "zero"
      ? "Нулеви артикули"
      : tab === "low-stock"
        ? "Нисък запас"
        : tab === "negative"
          ? "Продукти на минус"
          : "Всички артикули";
```

- [ ] **Step 3: Teach the query to fetch negative rows**

The current query's `base` switches between `/inventory/low-stock` and `/inventory`. For `"negative"`, reuse `/inventory` but with `has_stock=negative`. **Backend note:** the current `/inventory` endpoint does not recognize `has_stock=negative`; we rely on it ignoring unknown filter values and returning "all" rows, which we then client-side-filter by `total_quantity < 0`. Update the query body to:

```typescript
const {
  data: result,
  isLoading,
  error,
} = useQuery<{ items: StockLevel[]; total: number }>({
  queryKey: ["inventory", tab, page, search],
  queryFn: () => {
    const base = tab === "low-stock" ? "/inventory/low-stock" : "/inventory";

    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("limit", String(tab === "negative" ? 500 : pageSize));
    if (search.trim()) params.set("search", search.trim());

    if (base === "/inventory") {
      if (tab === "available") params.set("has_stock", "true");
      else if (tab === "zero") params.set("has_stock", "zero");
      // "negative" → no filter, we paginate client-side after filter
    }

    return api.get(`${base}?${params}`).then((r) => {
      const d = r.data;
      const arr = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      const normalized = arr.map((item: any) => normalizeInventoryItem(item));
      if (tab === "negative") {
        const onlyNegative = normalized
          .filter((it) => Number(it.total_quantity ?? 0) < 0)
          .sort(
            (a, b) =>
              Number(a.total_quantity ?? 0) - Number(b.total_quantity ?? 0),
          );
        return { items: onlyNegative, total: onlyNegative.length };
      }
      const total = d?.pagination?.total ?? d?.count ?? arr.length;
      return { items: normalized, total };
    });
  },
  refetchInterval: 30000,
});
```

The `limit=500` bump for `"negative"` is a pragmatic ceiling — if MERT-M accumulates more than 500 back-ordered SKUs simultaneously, we have bigger problems and will revisit.

- [ ] **Step 4: Apply red styling for negative rows**

Import the util near the other utility imports:

```typescript
import { formatUnit, getApiErrorMessage, stockColorClass } from "@/lib/utils";
```

Replace the `Наличност` cell (currently lines 409-419) with:

```tsx
<TableCell>
  <span
    className={
      item.total_quantity < 0
        ? "text-red-600 font-bold inline-flex items-center gap-1"
        : stockColorClass(item.total_quantity, item.low_stock_threshold)
    }
  >
    {item.total_quantity < 0 && <AlertTriangle className="h-3.5 w-3.5" />}
    {item.total_quantity}
  </span>
</TableCell>
```

- [ ] **Step 5: Add the "На минус" status badge**

Replace the `Статус` cell (currently the Badge block at lines 420-432) with:

```tsx
<TableCell>
  <div className="flex gap-1 flex-wrap">
    {item.total_quantity < 0 && <Badge variant="destructive">На минус</Badge>}
    {isLow && <Badge variant="destructive">Нисък запас</Badge>}
    {item.total_quantity === 0 && <Badge variant="outline">Каталог</Badge>}
    {hasStock && !isLow && <Badge variant="success">ОК</Badge>}
  </div>
</TableCell>
```

The `hasStock` and `isLow` variables are already computed above. `hasStock` is `item.total_quantity > 0`, which is already exclusive with the negative/zero cases.

- [ ] **Step 6: Type-check + verify in-browser**

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: No errors.

Start the dev server. Create a back-order (via Task 9 + Task 10 flows) against product "Бен Мари" with qty 3 when stock is 0, fulfill it, then navigate to Склад → „На минус". Verify:

1. The product appears with a red bold `-3` and a ⚠ icon.
2. A red "На минус" badge is shown in Статус.
3. Switching to Налични tab hides the product (it has zero positive stock).

Use `preview_snapshot` to confirm the new tab label appears and `preview_click` to switch tabs.

- [ ] **Step 7: Commit**

```bash
git add warehouse-frontend/src/pages/Inventory.tsx
git commit -m "feat(inventory): add 'На минус' tab for back-ordered products"
```

---

## Task 12: Apply `stockColorClass` in Products + New Order autocomplete

**Files:**

- Modify: `warehouse-frontend/src/pages/Products.tsx`
- Modify: `warehouse-frontend/src/pages/Orders.tsx`

- [ ] **Step 1: Find the stock cell in `Products.tsx`**

Run: `cd warehouse-frontend && grep -n "total_stock\|текущ.*наличност\|inventory.*qty\|text-red-600\b" src/pages/Products.tsx | head -20`
Expected: Identify the `<td>`/`<TableCell>` block that currently renders the product's current stock with an inline conditional className.

- [ ] **Step 2: Apply `stockColorClass` in Products**

Replace the ad-hoc className expression with:

```tsx
<span
  className={stockColorClass(
    parseFloat(String(product.total_stock || 0)),
    product.low_stock_threshold,
  )}
>
  {product.total_stock}
</span>
```

Add the import at the top of the file:

```typescript
import { /* existing imports */, stockColorClass } from "@/lib/utils";
```

- [ ] **Step 3: Apply `stockColorClass` + negative hint in New Order autocomplete**

In `warehouse-frontend/src/pages/Orders.tsx`, find the product autocomplete dropdown inside the New Order modal (search for "selling_price" or "наличност" in that file). Each option typically renders the product name with a small grey stock indicator. Replace the indicator with:

```tsx
{
  (() => {
    const qty = parseFloat(String(product.total_stock || 0));
    if (qty < 0) {
      return (
        <span className="text-red-600 font-semibold">на минус: {qty}</span>
      );
    }
    return (
      <span className={stockColorClass(qty, product.low_stock_threshold)}>
        налично: {qty}
      </span>
    );
  })();
}
```

Add the import if not already present:

```typescript
import { /* existing imports */, stockColorClass } from "@/lib/utils";
```

- [ ] **Step 4: Type-check**

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add warehouse-frontend/src/pages/Products.tsx warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(frontend): red stock indicator for back-ordered products in Products + order autocomplete"
```

---

## Task 13: Manual E2E smoke via `preview_*` tools

No code changes. This task runs the six scenarios from spec section 6.3 against a running dev stack, captures screenshots, and documents any bugs found. Fix inline — if a scenario fails, go back to the relevant task, edit, and re-run that scenario.

- [ ] **Step 1: Ensure the preview is running**

Use `preview_start` if no server is up. Log into the warehouse app as `admin`.

- [ ] **Step 2: Scenario 1 — sufficient stock, no dialog**

Steps:

1. Pick a product with stock > required qty (e.g. 10+).
2. Open Нова поръчка, add the product with qty 1.
3. Click Създай.

Expected: No dialog appears, order is created, no warning toast.

Capture with `preview_screenshot`.

- [ ] **Step 3: Scenario 2 — insufficient stock at creation, dialog appears**

Steps:

1. Pick a product whose stock is 0.
2. Open Нова поръчка, add the product with qty 3.
3. Click Създай.

Expected:

- `OversellConfirmDialog` opens with title "Наличността ще отиде под нулата".
- Body lists product name and "ще стане -3 (налично: 0, поръчка: 3)".
- Clicking Отказ leaves the modal open with the items still there.
- Clicking Продължи creates the order, a warning toast appears.

Capture a screenshot at the dialog moment.

- [ ] **Step 4: Scenario 3 — fulfill into negative**

Steps:

1. Fulfill the pending order created in scenario 2 (stock is still 0 at this point because creation is separate from fulfillment).
2. Click Изпълни.

Expected:

- Dialog appears again with the same `-3` preview.
- Продължи → order moves to fulfilled, stock goes from 0 to -3.

- [ ] **Step 5: Scenario 4 — "На минус" tab**

Steps:

1. Navigate to Склад → На минус.

Expected:

- The product from scenarios 2-3 appears at the top (sorted most-negative first).
- Stock cell shows `-3` in red bold with a ⚠ icon.
- Status shows red "На минус" badge.
- Top KPI reads "Продукти на минус: 1" (or the matching count label).

Capture a screenshot.

- [ ] **Step 6: Scenario 5 — delivery clears back-order**

Steps:

1. Create an incoming-goods delivery for the same product, qty 10.
2. Confirm it.

Expected:

- Inventory row goes from -3 to 7.
- Product leaves the "На минус" tab.
- Product appears in Налични with stock 7.

- [ ] **Step 7: Scenario 6 — analytics severity**

Steps:

1. Manually insert a negative stock row for a different product (via psql or repeat scenarios 2-3 for another SKU so Налични goes negative).
2. Navigate to Анализи / anomalies page (or whichever route uses `/analytics/anomalies`).

Expected: The `negative_stock` anomaly shows as yellow/warning, not red/critical.

- [ ] **Step 8: Clean up test data**

After all scenarios, bring test products back to a consistent state (e.g. confirm a delivery that covers the remaining negatives, or run a direct `UPDATE inventory` if that's how the project resets test fixtures).

- [ ] **Step 9: Report results and fix any failures**

If a scenario failed, loop back to the task that owns the broken behaviour, fix it, re-commit, and re-run the scenario. If everything passed, write a short summary in the session (no separate file).

- [ ] **Step 10: Final commit (if any fixes were made)**

```bash
git add -A && git commit -m "fix(inventory): address <specific issue> found in manual E2E"
```

Skip this step if no fixes were needed.

---

## Wrap-up

- Full test suite: `cd warehouse-backend && npx vitest run` — expect same pass/fail profile as pre-branch (only pre-existing `payments-razpiska.test.ts` failures).
- Frontend type-check: `cd warehouse-frontend && npx tsc --noEmit` — clean.
- Migration applied: `SELECT conname FROM pg_constraint WHERE conrelid = 'inventory'::regclass AND conname = 'chk_inventory_qty_nonneg';` returns `(0 rows)`.
- Manual E2E scenarios 1-6 all green.
- Branch: `feature/MERTM-negative-inventory`.

When all the above holds, invoke `superpowers:finishing-a-development-branch` to merge or open a PR.
