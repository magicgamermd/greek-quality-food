# Batch B — Product name snapshot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Snapshot `name_bg` / `name_en` / `sku` of each ordered product into the `order_items` row at INSERT time, so historical documents continue to display the name that was on the order at issuance, regardless of subsequent product renames.

**Architecture:** Three new columns on `order_items` populated at INSERT and never touched on UPDATE. Migration backfills from current `products`. All "order-context" reads (PDF generation, drawer, edit fetch, invoices) switch from `JOIN products p` for name/sku to `oi.<col>_snapshot`. Operational catalog data (unit, brand, weight, purchase_price) still LEFT-JOINs `products`.

**Tech Stack:** PostgreSQL 16, Fastify+TypeScript backend, Vitest for integration tests. No frontend changes (response shape preserved).

**Spec:** [docs/superpowers/specs/2026-04-29-batch-b-product-name-snapshot-design.md](../specs/2026-04-29-batch-b-product-name-snapshot-design.md)

---

## Pre-flight

- Branch: same `feature/MERTM-tester-attachments-buttons` (parallel to Batch A) OR fresh `feature/MERTM-batch-b-snapshot`. Choose based on Batch A status.
- Backend tests: `cd warehouse-backend && npx vitest run` (Vitest).
- Backend type-check: `npx tsc --noEmit`.
- Migration runner: `docker exec -i mertm-postgres-1 psql -U warehouse -d mertm_warehouse -v ON_ERROR_STOP=1 --single-transaction < <migration_file>`.

---

## Task 1: Migration 057 — snapshot columns + backfill

**Files:**

- Create: `warehouse-backend/migrations/057_order_items_product_name_snapshot.sql`

**Step 1: Write the migration**

```sql
-- 057_order_items_product_name_snapshot.sql
-- Snapshots product identity (name_bg, name_en, sku) onto each order_items
-- row at INSERT time, so historical documents preserve the name that was
-- in use at issuance even after the product is renamed in the catalog.

BEGIN;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS name_bg_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS name_en_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS sku_snapshot TEXT;

-- Backfill existing rows from the current catalog. Acceptable inaccuracy:
-- legacy rows for products that have already been renamed will receive
-- the *current* name, not the one that was on the document at issuance —
-- but that data is unrecoverable. Going forward, snapshots are exact.
UPDATE order_items oi
   SET name_bg_snapshot = p.name_bg,
       name_en_snapshot = p.name_en,
       sku_snapshot     = p.sku
  FROM products p
 WHERE oi.product_id = p.id
   AND oi.name_bg_snapshot IS NULL;

-- products.name_bg is NOT NULL, so every existing row is now non-null.
ALTER TABLE order_items
  ALTER COLUMN name_bg_snapshot SET NOT NULL;

COMMIT;
```

**Step 2: Apply the migration**

Run:

```bash
docker exec -i mertm-postgres-1 psql -U warehouse -d mertm_warehouse \
  -v ON_ERROR_STOP=1 --single-transaction \
  < warehouse-backend/migrations/057_order_items_product_name_snapshot.sql

docker exec mertm-postgres-1 psql -U warehouse -d mertm_warehouse -tAc \
  "INSERT INTO _migrations (name) VALUES ('057_order_items_product_name_snapshot.sql') ON CONFLICT DO NOTHING"
```

Expected: `BEGIN`, `ALTER TABLE` × 4, `UPDATE N`, `COMMIT`.

**Step 3: Verify**

```bash
docker exec mertm-postgres-1 psql -U warehouse -d mertm_warehouse -tAc \
  "SELECT COUNT(*) FROM order_items WHERE name_bg_snapshot IS NULL"
```

Expected: `0`.

```bash
docker exec mertm-postgres-1 psql -U warehouse -d mertm_warehouse -tAc \
  "SELECT oi.id, oi.product_id, oi.name_bg_snapshot, p.name_bg
   FROM order_items oi JOIN products p ON p.id=oi.product_id LIMIT 5"
```

Expected: `name_bg_snapshot` matches `p.name_bg` for every row.

**Step 4: Commit**

```bash
git add warehouse-backend/migrations/057_order_items_product_name_snapshot.sql
git commit -m "feat(db): snapshot product name_bg/name_en/sku on order_items (057)"
```

---

## Task 2: INSERT path — POST /orders main flow

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts:763` (INSERT in main create-order handler)

**Step 1: Locate the existing INSERT block**

Around line 754-770:

```ts
const discountPct = item.discount_percent ?? 0;
// …compute totalPrice…
const {
  rows: [orderItem],
} = await client.query(
  `INSERT INTO order_items (order_id, product_id, quantity, unit_price, discount_percent, total_price)
   VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
  [
    order.id,
    item.product_id,
    item.quantity,
    item.unit_price,
    discountPct,
    totalPrice,
  ],
);
```

**Step 2: Look upstream — there is already a `productRows` SELECT**

Search backwards in the same handler for `SELECT id, selling_price, ${partnerPriceColumn} AS group_price, name_bg FROM products WHERE id = ANY($1)` (around `:679`). It already loads name_bg per product. Extend that SELECT to also pull `name_en` and `sku`:

```ts
`SELECT id, selling_price, ${partnerPriceColumn} AS group_price,
        name_bg, name_en, sku
 FROM products WHERE id = ANY($1)`,
```

Build a snapshot map after the SELECT:

```ts
const snapMap = new Map<
  number,
  { name_bg: string; name_en: string | null; sku: string | null }
>();
for (const p of productRows) {
  snapMap.set(p.id, { name_bg: p.name_bg, name_en: p.name_en, sku: p.sku });
}
```

**Step 3: Update the INSERT to include snapshot columns**

```ts
const snap = snapMap.get(item.product_id);
if (!snap) {
  throw Object.assign(new Error(`Product ${item.product_id} not found`), {
    statusCode: 400,
  });
}
const {
  rows: [orderItem],
} = await client.query(
  `INSERT INTO order_items
     (order_id, product_id, quantity, unit_price, discount_percent, total_price,
      name_bg_snapshot, name_en_snapshot, sku_snapshot)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
  [
    order.id,
    item.product_id,
    item.quantity,
    item.unit_price,
    discountPct,
    totalPrice,
    snap.name_bg,
    snap.name_en,
    snap.sku,
  ],
);
```

**Step 4: Type-check**

Run: `cd warehouse-backend && npx tsc --noEmit`
Expected: PASS.

**Step 5: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): write name_bg/name_en/sku snapshot on POST /orders INSERT"
```

---

## Task 3: INSERT path — chat/import flow at :954

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts:954` (INSERT in import branch)

**Step 1: Locate**

Around `:954`:

```ts
const {
  rows: [orderItem],
} = await client.query(
  `INSERT INTO order_items (order_id, product_id, quantity, unit_price, total_price)
   VALUES ($1, $2, $3, $4, $5) RETURNING *`,
  [order.id, productId, item.quantity, item.unit_price, totalPrice],
);
```

**Step 2: Resolve snapshot inline**

Just above this INSERT, fetch product fields:

```ts
const {
  rows: [snap],
} = await client.query(
  `SELECT name_bg, name_en, sku FROM products WHERE id = $1`,
  [productId],
);
if (!snap) {
  throw Object.assign(new Error(`Product ${productId} not found`), {
    statusCode: 400,
  });
}
```

**Step 3: Update INSERT**

```ts
const {
  rows: [orderItem],
} = await client.query(
  `INSERT INTO order_items
     (order_id, product_id, quantity, unit_price, total_price,
      name_bg_snapshot, name_en_snapshot, sku_snapshot)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
  [
    order.id,
    productId,
    item.quantity,
    item.unit_price,
    totalPrice,
    snap.name_bg,
    snap.name_en,
    snap.sku,
  ],
);
```

**Step 4: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): write snapshot on import-flow INSERT in order_items"
```

---

## Task 4: INSERT path — PUT /orders/:id (edit add-line) at :1167

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts:1167`

**Step 1: Locate**

Around `:1146-1170` is the edit handler that re-creates items. Find:

```ts
`INSERT INTO order_items (order_id, product_id, quantity, unit_price, discount_percent, total_price, cost_unit_price)
 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
```

**Step 2: Add a SELECT block above the INSERT loop, mirroring Task 2**

```ts
const productIds = items.map((i) => i.product_id);
const { rows: snapRows } = await client.query(
  `SELECT id, name_bg, name_en, sku FROM products WHERE id = ANY($1::int[])`,
  [productIds],
);
const snapMap = new Map<
  number,
  { name_bg: string; name_en: string | null; sku: string | null }
>();
for (const p of snapRows)
  snapMap.set(p.id, { name_bg: p.name_bg, name_en: p.name_en, sku: p.sku });
```

**Step 3: Update INSERT**

```ts
const snap = snapMap.get(item.product_id);
if (!snap)
  throw Object.assign(new Error(`Product ${item.product_id} not found`), {
    statusCode: 400,
  });
await client.query(
  `INSERT INTO order_items
     (order_id, product_id, quantity, unit_price, discount_percent, total_price, cost_unit_price,
      name_bg_snapshot, name_en_snapshot, sku_snapshot)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
  [
    order.id,
    item.product_id,
    item.quantity,
    item.unit_price,
    discountPct,
    totalPrice,
    costUnitPrice,
    snap.name_bg,
    snap.name_en,
    snap.sku,
  ],
);
```

**Step 4: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): write snapshot on PUT /orders/:id edit INSERT"
```

---

## Task 5: Integration test — INSERT writes snapshot, UPDATE doesn't touch it

**Files:**

- Create: `warehouse-backend/src/__tests__/order-items-snapshot.test.ts`

**Step 1: Write the test**

```ts
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
import Fastify from "fastify";
import ordersRoutes from "../routes/orders.js";

const mockQuery = vi.mocked(query);
const mockTx = vi.mocked(transaction);

async function buildApp(role = "admin") {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u1", role };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(ordersRoutes, { prefix: "/orders" });
  return app;
}

describe("order_items snapshot — write path", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTx.mockReset();
  });

  it("POST /orders writes name_bg/name_en/sku snapshot from current products", async () => {
    // Mock the products SELECT to return current names, then assert
    // the INSERT INTO order_items receives those exact values.
    // …pattern mirrors orders-incoming-permissions.test.ts…
  });

  it("PUT /orders/:id with new line writes snapshot from CURRENT product values", async () => {
    // Pre-existing order created month ago. Today, edit adds a new
    // line. Snapshot must be the product's name TODAY, not at the
    // original order's date.
  });

  it("PUT /orders/:id editing qty does NOT touch snapshot", async () => {
    // Spy on the UPDATE query; verify name_bg_snapshot is NOT in the SET.
  });
});
```

(Fill in mock query bodies based on `orders-incoming-permissions.test.ts` for shape.)

**Step 2: Run + iterate**

```bash
cd warehouse-backend && npx vitest run src/__tests__/order-items-snapshot.test.ts
```

**Step 3: Commit**

```bash
git add warehouse-backend/src/__tests__/order-items-snapshot.test.ts
git commit -m "test(orders): integration tests for order_items snapshot write/preserve"
```

---

## Task 6: READ path — drawer detail at :597-608

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts:597-608`

**Step 1: Replace the SELECT**

Current:

```sql
SELECT oi.*,
       COALESCE(pr.name_bg, 'Продукт #' || oi.product_id) AS name_bg,
       COALESCE(pr.name_en, 'Product #' || oi.product_id) AS name_en,
       pr.sku, pr.unit, pr.brand, pr.weight_kg,
       (…)::numeric AS total_stock
  FROM order_items oi
  LEFT JOIN products pr ON pr.id = oi.product_id
 WHERE oi.order_id = $1
```

New:

```sql
SELECT oi.*,
       oi.name_bg_snapshot AS name_bg,
       oi.name_en_snapshot AS name_en,
       oi.sku_snapshot     AS sku,
       pr.unit, pr.brand, pr.weight_kg,
       (…)::numeric AS total_stock
  FROM order_items oi
  LEFT JOIN products pr ON pr.id = oi.product_id
 WHERE oi.order_id = $1
```

(Drop `pr.sku`; drop `COALESCE` wrappers — snapshot is NOT NULL after migration.)

**Step 2: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts
git commit -m "refactor(orders): drawer detail reads name from order_items snapshot"
```

---

## Task 7: READ path — orders list at :1914-1920 + edit fetch at :1698

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts:1698-1700` (edit fetch)
- Modify: `warehouse-backend/src/routes/orders.ts:1914-1920` (other detail)

**Step 1: Same swap as Task 6 — both queries**

For `:1698`:

```sql
SELECT oi.*,
       oi.name_bg_snapshot AS name_bg,
       oi.name_en_snapshot AS name_en,
       oi.sku_snapshot     AS sku,
       p.unit, p.brand
  FROM order_items oi
  LEFT JOIN products p ON p.id = oi.product_id
 WHERE oi.order_id = $1
 ORDER BY oi.id
```

(Was `JOIN products p` — change to `LEFT JOIN` because snapshot covers identity even if product is gone.)

For `:1914-1920`: same swap as Task 6.

**Step 2: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts
git commit -m "refactor(orders): edit fetch + list reads from snapshot"
```

---

## Task 8: READ path — invoices.ts (4 places)

**Files:**

- Modify: `warehouse-backend/src/routes/invoices.ts:364`
- Modify: `warehouse-backend/src/routes/invoices.ts:511`
- Modify: `warehouse-backend/src/routes/invoices.ts:774`
- Modify: `warehouse-backend/src/routes/invoices.ts:1056`

**Step 1: Each block looks like**

```sql
SELECT oi.*, p.name_bg, p.name_en, p.sku, p.unit, p.brand
  FROM order_items oi
  JOIN products p ON p.id = oi.product_id
 WHERE oi.order_id = $1
 ORDER BY oi.id
```

**Step 2: Replace each with**

```sql
SELECT oi.*,
       oi.name_bg_snapshot AS name_bg,
       oi.name_en_snapshot AS name_en,
       oi.sku_snapshot     AS sku,
       p.unit, p.brand
  FROM order_items oi
  LEFT JOIN products p ON p.id = oi.product_id
 WHERE oi.order_id = $1
 ORDER BY oi.id
```

(Inner JOIN → LEFT JOIN; snapshot replaces JOIN'd name fields.)

**Step 3: Commit**

```bash
git add warehouse-backend/src/routes/invoices.ts
git commit -m "refactor(invoices): all 4 item reads use order_items snapshot"
```

---

## Task 9: Integration test — read path stays correct after rename

**Files:**

- Modify: `warehouse-backend/src/__tests__/order-items-snapshot.test.ts` (extend Task 5 file)

**Step 1: Add tests**

```ts
describe("order_items snapshot — read path", () => {
  it("GET /orders/:id returns snapshot name even when product was renamed", async () => {
    // Mock products row with name_bg = 'NEW NAME'
    // Mock order_items row with name_bg_snapshot = 'OLD NAME'
    // Hit GET /orders/:id, assert response items[0].name_bg === 'OLD NAME'
  });

  it("GET /invoices/:id PDF data uses snapshot name", async () => {
    // Same shape — verify the items array sent to generateInvoicePdf
    // contains the snapshot, not the current product name.
  });
});
```

**Step 2: Run + commit**

```bash
npx vitest run src/__tests__/order-items-snapshot.test.ts
git add warehouse-backend/src/__tests__/order-items-snapshot.test.ts
git commit -m "test(orders): read-path tests confirm snapshot wins over current product name"
```

---

## Task 10: Manual end-to-end verification

Run `./scripts/start-mertm.sh`, then:

1. **Login admin** → Поръчки → Нова поръчка → add product "Скара X" → save → fulfill → generate invoice. Open PDF → verify item shows "Скара X".
2. **Rename the product:** Products → click "Скара X" → change name to "Скара X PRO" → save.
3. **Re-open the same invoice PDF** (use "Регенерирай" or just open). Verify item still shows **"Скара X"** (the original name, frozen).
4. **Open the order drawer** → verify items table shows "Скара X" (not the new name).
5. **Create a NEW order with the same product** → verify the new order's items show "Скара X PRO" (current name).
6. **Edit the OLD order** → add another line of the same product → save → verify the newly-added line shows "Скара X PRO" (snapshot at moment of add), while the original line still shows "Скара X".
7. Check stock-dispatch PDF + commercial-doc PDF on the OLD order — both must show "Скара X" for the original line.

If any step fails — debug, fix, re-commit.

---

## Task 11: Update STATUS.md

**Files:**

- Modify: `STATUS.md`

**Step 1: Add an entry**

```markdown
**Batch B — Product name snapshot in order_items** (2026-04-29):

- Migration 057 — `order_items.name_bg_snapshot` (NOT NULL) +
  `name_en_snapshot` + `sku_snapshot`; backfill from current products
- INSERT paths in routes/orders.ts (3 places: POST main, import branch,
  PUT edit) populate snapshot from current products
- Read paths in routes/orders.ts (drawer, edit fetch, list) +
  routes/invoices.ts (4 places) switch from JOIN to snapshot
- UPDATE paths NOT touching snapshot — verified by tests
- Frontend untouched (response shape preserved)
```

**Step 2: Commit**

```bash
git add STATUS.md
git commit -m "docs(status): Batch B complete — product name snapshot"
```

---

## Verification checklist (`superpowers:verification-before-completion`)

- [ ] Migration 057 applied; `_migrations` table has the row
- [ ] All `order_items` rows have non-NULL `name_bg_snapshot`
- [ ] Backend tests pass: `npx vitest run`
- [ ] Backend type-check clean: `npx tsc --noEmit`
- [ ] Manual E2E from Task 10 completes (steps 1-7 all green)
- [ ] No frontend type errors: `cd warehouse-frontend && npx tsc --noEmit`
- [ ] STATUS.md updated
- [ ] All commits use conventional format
