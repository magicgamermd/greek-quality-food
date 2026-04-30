# Batch F1 — Paid-not-taken + Awaiting line statuses Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Per-line `line_status` on `order_items` enabling paid-not-taken (paid, allowed-negative stock) and awaiting (pre-order, no stock effect) workflows. Plus quantity-split UI on oversell, "Предадено" handover button, notification trigger on incoming confirm, and 2 new filter pills.

**Architecture:** New `line_status` enum column with default `'normal'`. Fulfill flow branches on the new field — `awaiting` lines skipped, `paid_not_taken` lines deduct with `allowNegative=true`. Two new POST endpoints flip the status (handover and confirm-from-awaiting). Incoming-goods confirm handler emits a `pending_order_ready` notification per matching open line. Two new EXISTS-based filter params surface as filter pills in the orders list. Frontend renders bg-tint + chip per row + adds split-on-oversell UI.

**Tech Stack:** PostgreSQL 16, Fastify+TypeScript+Zod, pdfkit (no changes), Vitest, React+TanStack Query.

**Spec:** [docs/superpowers/specs/2026-04-29-batch-f1-paid-not-taken-and-awaiting-design.md](../specs/2026-04-29-batch-f1-paid-not-taken-and-awaiting-design.md)

---

## Pre-flight

- Branch: `git checkout main && git pull && git checkout -b feature/MERTM-batch-f1-line-status`
- Backend tests: `cd warehouse-backend && npx vitest run`
- Type-check: `npx tsc --noEmit` (in both `warehouse-backend/` and `warehouse-frontend/`)

---

## Task 1: Migration 064 — line_status column + index

**Files:**

- Create: `warehouse-backend/migrations/064_order_items_line_status.sql`

**Step 1: Migration**

```sql
-- 064_order_items_line_status.sql
-- Per-line state on order_items:
--   'normal'         (default) — standard stock-deducting line
--   'paid_not_taken' — customer paid; goods not handed over; deducts stock
--                      (allowed negative — promised inventory)
--   'awaiting'       — pre-order (no payment, no stock effect)

BEGIN;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS line_status TEXT NOT NULL DEFAULT 'normal'
    CHECK (line_status IN ('normal', 'paid_not_taken', 'awaiting'));

-- Partial index keeps the index tiny (most rows are 'normal').
CREATE INDEX IF NOT EXISTS idx_order_items_line_status_pending
  ON order_items(line_status)
  WHERE line_status != 'normal';

COMMIT;
```

**Step 2: Apply + verify**

```bash
docker exec -i mertm-postgres-1 psql -U warehouse -d mertm_warehouse \
  -v ON_ERROR_STOP=1 --single-transaction \
  < warehouse-backend/migrations/064_order_items_line_status.sql

docker exec mertm-postgres-1 psql -U warehouse -d mertm_warehouse -tAc \
  "INSERT INTO _migrations (name) VALUES ('064_order_items_line_status.sql') ON CONFLICT DO NOTHING"

docker exec mertm-postgres-1 psql -U warehouse -d mertm_warehouse -tAc \
  "SELECT column_name, data_type FROM information_schema.columns
   WHERE table_name='order_items' AND column_name='line_status'"
```

Expected: `line_status|text`.

**Step 3: Commit**

```bash
git add warehouse-backend/migrations/064_order_items_line_status.sql
git commit -m "feat(db): add order_items.line_status enum column (060)"
```

---

## Task 2: Shared `ORDER_LINE_STATUSES` constant

**Files:**

- Create: `warehouse-backend/src/lib/order-line-status.ts`
- Create: `warehouse-frontend/src/lib/orderLineStatus.ts`

**Step 1: Backend constant**

```ts
import { z } from "zod";

export const ORDER_LINE_STATUSES = [
  "normal",
  "paid_not_taken",
  "awaiting",
] as const;

export type OrderLineStatus = (typeof ORDER_LINE_STATUSES)[number];

export const ORDER_LINE_STATUS_LABELS: Record<OrderLineStatus, string> = {
  normal: "Нормално",
  paid_not_taken: "Платена невзета",
  awaiting: "На изчакване",
};

export const orderLineStatusSchema = z
  .enum(ORDER_LINE_STATUSES)
  .default("normal");
```

**Step 2: Frontend mirror (identical content)**

```ts
export const ORDER_LINE_STATUSES = [
  "normal",
  "paid_not_taken",
  "awaiting",
] as const;

export type OrderLineStatus = (typeof ORDER_LINE_STATUSES)[number];

export const ORDER_LINE_STATUS_LABELS: Record<OrderLineStatus, string> = {
  normal: "Нормално",
  paid_not_taken: "Платена невзета",
  awaiting: "На изчакване",
};
```

**Step 3: Commit**

```bash
git add warehouse-backend/src/lib/order-line-status.ts warehouse-frontend/src/lib/orderLineStatus.ts
git commit -m "feat(orders): shared ORDER_LINE_STATUSES constant (BE+FE)"
```

---

## Task 3: Extend `deductProductStock` with `allowNegative`

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts:2105-2139` (the existing `deductProductStock` helper)

**Step 1: Add option + safety check**

```ts
async function deductProductStock(
  db: DbExecutor,
  productId: number,
  quantity: number,
  options: { allowNegative?: boolean } = {},
): Promise<number | null> {
  const { allowNegative = false } = options;

  if (!allowNegative) {
    // Check current quantity — refuse if it would go below 0
    const {
      rows: [inv],
    } = await db.query(
      `SELECT COALESCE(SUM(quantity), 0)::numeric AS qty
         FROM inventory
        WHERE product_id = $1 AND warehouse_id = 1`,
      [productId],
    );
    const current = parseFloat(inv?.qty ?? "0");
    if (current < quantity) {
      throw Object.assign(
        new Error(
          `Insufficient stock for product ${productId}: have ${current}, need ${quantity}`,
        ),
        { statusCode: 409 },
      );
    }
  }

  // …existing UPDATE / INSERT logic unchanged…
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

**Step 2: Audit existing callers — should they pass `allowNegative: true`?**

The current callers (fulfill, edit-add-line) silently allow negative today (no check). To preserve behaviour, they should pass `allowNegative: true` for now. This task changes only the helper signature — the call-sites will be updated in Task 4 (fulfill) and Task 5 (handover/confirm).

**Step 3: Type-check + commit**

```bash
cd warehouse-backend && npx tsc --noEmit
git add warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): deductProductStock accepts allowNegative option"
```

---

## Task 4: Fulfill flow — branch on `line_status`

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts:1729-1820` (fulfill handler)

**Step 1: Skip awaiting; pass allowNegative for paid_not_taken**

Inside the items loop in `/:id/fulfill`:

```ts
for (const item of items) {
  // Awaiting lines are pre-orders: no stock change, no COGS, no fulfilment effect
  if (item.line_status === "awaiting") {
    continue;
  }

  // normal + paid_not_taken: deduct stock
  const allowNegative = item.line_status === "paid_not_taken";
  const costUnitPrice = await deductProductStock(
    client,
    item.product_id,
    parseFloat(item.quantity),
    { allowNegative },
  );

  await client.query(
    `UPDATE order_items
       SET cost_unit_price = $1
     WHERE id = $2`,
    [costUnitPrice, item.id],
  );
}
```

(Make sure the SELECT that loads `items` includes `line_status` — verify and add if missing.)

**Step 2: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): fulfill respects line_status (skip awaiting; allow negative for paid_not_taken)"
```

---

## Task 5: Backend — `POST /:id/items/:itemId/handover` endpoint

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts` — new endpoint near other transitions

**Step 1: Add endpoint**

```ts
// POST /:id/items/:itemId/handover — flip paid_not_taken → normal
// (no stock change; already deducted at fulfill)
app.post(
  "/:id/items/:itemId/handover",
  { preHandler: ordersManagePreHandler },
  async (request: FastifyRequest, reply: FastifyReply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    return await transaction(async (client) => {
      const {
        rows: [item],
      } = await client.query(
        `SELECT id, order_id, line_status FROM order_items
         WHERE id = $1 AND order_id = $2 FOR UPDATE`,
        [itemId, id],
      );
      if (!item) {
        throw Object.assign(new Error("Order item not found"), {
          statusCode: 404,
        });
      }
      if (item.line_status !== "paid_not_taken") {
        throw Object.assign(
          new Error("Only paid_not_taken lines can be handed over."),
          { statusCode: 400 },
        );
      }
      const {
        rows: [updated],
      } = await client.query(
        `UPDATE order_items SET line_status = 'normal'
         WHERE id = $1 RETURNING *`,
        [itemId],
      );
      return updated;
    });
  },
);
```

**Step 2: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): POST /:id/items/:itemId/handover — paid_not_taken → normal"
```

---

## Task 6: Backend — `POST /:id/items/:itemId/confirm-from-awaiting` endpoint

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts` — same area

**Step 1: Add endpoint (deducts stock, allowNegative=false)**

```ts
// POST /:id/items/:itemId/confirm-from-awaiting — flip awaiting → normal
// (deduct stock NOW; refuse if insufficient stock)
app.post(
  "/:id/items/:itemId/confirm-from-awaiting",
  { preHandler: ordersManagePreHandler },
  async (request: FastifyRequest, reply: FastifyReply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    return await transaction(async (client) => {
      const {
        rows: [item],
      } = await client.query(
        `SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE`,
        [itemId, id],
      );
      if (!item) {
        throw Object.assign(new Error("Order item not found"), {
          statusCode: 404,
        });
      }
      if (item.line_status !== "awaiting") {
        throw Object.assign(
          new Error("Only awaiting lines can be confirmed."),
          { statusCode: 400 },
        );
      }
      // Deduct stock now (refuse if insufficient — caller should ensure stock arrived)
      const costUnitPrice = await deductProductStock(
        client,
        item.product_id,
        parseFloat(item.quantity),
        { allowNegative: false },
      );
      const {
        rows: [updated],
      } = await client.query(
        `UPDATE order_items
           SET line_status = 'normal',
               cost_unit_price = $1
         WHERE id = $2 RETURNING *`,
        [costUnitPrice, itemId],
      );
      return updated;
    });
  },
);
```

**Step 2: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): POST /:id/items/:itemId/confirm-from-awaiting — awaiting → normal + deduct"
```

---

## Task 7: Backend — accept `line_status` per item in create/edit

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts` — items array Zod schema (likely around `:108-140`)

**Step 1: Extend the per-item schema**

Find the `items: z.array(z.object({...}))` inside `createOrderSchema`. Add:

```ts
import { orderLineStatusSchema } from "../lib/order-line-status.js";

// inside the per-item object:
line_status: orderLineStatusSchema.optional(),
```

**Step 2: Pass `line_status` to INSERT INTO order_items**

In all 3 INSERT places (POST main flow at `:763`, import at `:954`, edit at `:1167`), include `line_status` in the column list and use `item.line_status ?? 'normal'` as the value.

**Step 3: Type-check + commit**

```bash
cd warehouse-backend && npx tsc --noEmit
git add warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): persist line_status from request payload on INSERT"
```

---

## Task 8: Backend — notification trigger in incoming confirm

**Files:**

- Modify: `warehouse-backend/src/routes/incoming.ts` — find the existing INSERT INTO notifications around `:2024` or `:2129`; add the pending-order-ready trigger after stock is increased.

**Step 1: Add trigger**

Inside the incoming-goods confirm handler, after stock is incremented for each incoming line:

```ts
const { rows: pendingLines } = await client.query(
  `SELECT oi.id          AS item_id,
          oi.order_id,
          oi.product_id,
          oi.quantity,
          oi.line_status,
          oi.name_bg_snapshot AS product_name,
          o.partner_id,
          p.name              AS partner_name
     FROM order_items oi
     JOIN orders o   ON o.id = oi.order_id
     JOIN partners p ON p.id = o.partner_id
    WHERE oi.product_id = $1
      AND oi.line_status IN ('paid_not_taken', 'awaiting')
      AND o.status NOT IN ('cancelled')`,
  [incomingItem.product_id],
);

for (const pending of pendingLines) {
  await client.query(
    `INSERT INTO notifications (type, message, payload)
     VALUES ('pending_order_ready', $1, $2)`,
    [
      `Поръчка #${pending.order_id} (${pending.partner_name}) — ${pending.product_name} вече е наличен`,
      JSON.stringify({
        order_id: pending.order_id,
        order_item_id: pending.item_id,
        product_id: pending.product_id,
        qty_pending: pending.quantity,
        line_status: pending.line_status,
        partner_name: pending.partner_name,
      }),
    ],
  );
}
```

(If `notifications` does NOT have a `payload` JSONB column, check first — if missing, this becomes Task 8a: migration to add it. Likely already exists; verify.)

**Step 2: Commit**

```bash
git add warehouse-backend/src/routes/incoming.ts
git commit -m "feat(incoming): notify pending orders when stock arrives (paid_not_taken + awaiting)"
```

---

## Task 9: Backend — `?has_paid_not_taken` + `?has_awaiting` filter params

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts:399-450` (GET /orders handler — filter parsing)

**Step 1: Accept params + EXISTS clauses**

```ts
const {
  // …existing destructuring…
  has_paid_not_taken,
  has_awaiting,
} = request.query as any;

if (has_paid_not_taken === "true") {
  where += ` AND EXISTS (
    SELECT 1 FROM order_items oi
    WHERE oi.order_id = o.id AND oi.line_status = 'paid_not_taken'
  )`;
}
if (has_awaiting === "true") {
  where += ` AND EXISTS (
    SELECT 1 FROM order_items oi
    WHERE oi.order_id = o.id AND oi.line_status = 'awaiting'
  )`;
}
```

**Step 2: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): GET /orders ?has_paid_not_taken= + ?has_awaiting= filter params"
```

---

## Task 10: Backend integration tests

**Files:**

- Create: `warehouse-backend/src/__tests__/orders-line-status.test.ts`

**Step 1: Test skeleton (mirrors orders-quotation.test.ts pattern)**

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

import { transaction } from "../db.js";
import ordersRoutes from "../routes/orders.js";

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

describe("Line status flows", () => {
  beforeEach(() => mockTx.mockReset());

  it("fulfill skips awaiting lines (no stock deduction)", async () => {
    // Mock fulfill: items array has 1 normal + 1 awaiting
    // Verify only the normal line gets a deductProductStock call
    // (track by counting UPDATE inventory queries)
  });

  it("fulfill on paid_not_taken line deducts stock allowing negative", async () => {
    // Mock current inventory = 0 for product 1
    // Submit fulfill with paid_not_taken qty=3
    // Verify UPDATE inventory was called WITHOUT pre-check
  });

  it("handover endpoint flips paid_not_taken → normal without re-deduct", async () => {
    mockTx.mockImplementationOnce(async (cb: any) =>
      cb({
        query: vi
          .fn()
          .mockResolvedValueOnce({
            rows: [{ id: 1, order_id: 10, line_status: "paid_not_taken" }],
          })
          .mockResolvedValueOnce({ rows: [{ id: 1, line_status: "normal" }] }),
      }),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/orders/10/items/1/handover",
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("handover rejects 400 on non-paid_not_taken line", async () => {
    mockTx.mockImplementationOnce(async (cb: any) =>
      cb({
        query: vi.fn().mockResolvedValueOnce({
          rows: [{ id: 1, order_id: 10, line_status: "normal" }],
        }),
      }),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/orders/10/items/1/handover",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("confirm-from-awaiting flips status AND deducts stock", async () => {
    // Verify UPDATE inventory IS called
    // Verify line_status flipped to 'normal'
  });

  it("confirm-from-awaiting refuses 409 when insufficient stock", async () => {
    // Mock inventory.quantity = 0 for the product
    // Attempt confirm with qty=3
    // Expect 409
  });
});

describe("Filter pills", () => {
  it("?has_paid_not_taken=true adds EXISTS clause for paid_not_taken", async () => {
    // …
  });
  it("?has_awaiting=true adds EXISTS clause for awaiting", async () => {
    // …
  });
});
```

**Step 2: Run + iterate**

```bash
cd warehouse-backend && npx vitest run src/__tests__/orders-line-status.test.ts
```

**Step 3: Commit**

```bash
git add warehouse-backend/src/__tests__/orders-line-status.test.ts
git commit -m "test(orders): integration tests for line_status flows + handover endpoints"
```

---

## Task 11: Backend integration test — incoming notification trigger

**Files:**

- Create: `warehouse-backend/src/__tests__/incoming-pending-notification.test.ts`

**Step 1: Test**

```ts
// Mock incoming confirm
// Mock SELECT order_items returning 2 pending lines
// Verify INSERT INTO notifications was called twice with type='pending_order_ready'
// + payload contains order_id + line_status
```

**Step 2: Commit**

```bash
git add warehouse-backend/src/__tests__/incoming-pending-notification.test.ts
git commit -m "test(incoming): notification fires for pending lines on confirm"
```

---

## Task 12: Frontend — types extension

**Files:**

- Modify: `warehouse-frontend/src/types/index.ts:245-257` (OrderItem interface)

**Step 1: Add field**

```ts
export interface OrderItem {
  // …existing…
  unit?: string;
  line_status?: "normal" | "paid_not_taken" | "awaiting";
}
```

**Step 2: Type-check + commit**

```bash
cd warehouse-frontend && npx tsc --noEmit
git add warehouse-frontend/src/types/index.ts
git commit -m "feat(types): OrderItem.line_status union"
```

---

## Task 13: Frontend — visual markers (bg tint + chip)

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` — items table in drawer (around `:980-1045`) and edit modal items table

**Step 1: Helper map near the top of the file**

```tsx
import { ORDER_LINE_STATUS_LABELS } from "@/lib/orderLineStatus";

const lineStatusStyles: Record<string, { bg: string; chip: React.ReactNode }> =
  {
    normal: { bg: "", chip: null },
    paid_not_taken: {
      bg: "bg-amber-50",
      chip: (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 border border-amber-200 text-xs">
          💰 Платена невзета
        </span>
      ),
    },
    awaiting: {
      bg: "bg-gray-50",
      chip: (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-gray-100 text-gray-700 border border-gray-200 text-xs">
          ⏳ Изчакване
        </span>
      ),
    },
  };
```

**Step 2: Apply to TableRow**

```tsx
const status = item.line_status ?? "normal";
const styles = lineStatusStyles[status];

<TableRow key={item.id} className={styles.bg}>
  …<TableCell>{styles.chip}</TableCell>
</TableRow>;
```

(Add the chip cell or render the chip inline next to the product name — your choice.)

**Step 3: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): bg tint + chip per row based on line_status"
```

---

## Task 14: Frontend — "Предадено" + "Потвърди от изчакване" buttons

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` — drawer items table (per row actions column)

**Step 1: Add per-row mutations**

```ts
const handoverMutation = useMutation({
  mutationFn: ({ orderId, itemId }: { orderId: number; itemId: number }) =>
    api.post(`/orders/${orderId}/items/${itemId}/handover`),
  onSuccess: () => invalidateAllOrderRelated(),
});

const confirmAwaitingMutation = useMutation({
  mutationFn: ({ orderId, itemId }: { orderId: number; itemId: number }) =>
    api.post(`/orders/${orderId}/items/${itemId}/confirm-from-awaiting`),
  onSuccess: () => invalidateAllOrderRelated(),
});
```

**Step 2: Conditional buttons in row**

```tsx
{
  item.line_status === "paid_not_taken" && (
    <Button
      size="sm"
      variant="outline"
      onClick={() =>
        handoverMutation.mutate({ orderId: detail.id, itemId: item.id })
      }
    >
      ✓ Предадено
    </Button>
  );
}
{
  item.line_status === "awaiting" && (
    <Button
      size="sm"
      variant="outline"
      onClick={() =>
        confirmAwaitingMutation.mutate({ orderId: detail.id, itemId: item.id })
      }
    >
      ✓ Потвърди
    </Button>
  );
}
```

**Step 3: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): per-row 'Предадено' + 'Потвърди от изчакване' buttons"
```

---

## Task 15: Frontend — split-on-oversell flow in edit modal

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` — `EditOrderItemsModal` oversell detection + `NewOrderModal` (similar)

**Step 1: When oversell warning is detected, instead of just blocking, offer a 3-button choice**

```tsx
{
  oversellLines.length > 0 && (
    <div className="bg-amber-50 border border-amber-200 rounded-md p-3 space-y-2">
      <div className="text-sm">⚠ Има артикули над наличността:</div>
      {oversellLines.map((line) => (
        <div key={line.id} className="flex items-center gap-2 text-sm">
          <span>
            {line.product_name}: {line.quantity} (имам {line.available})
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => reduceTo(line.id, line.available)}
          >
            Намали до {line.available}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-amber-500 text-amber-700"
            onClick={() => splitToPaidNotTaken(line.id)}
          >
            💰 Платена невзета
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-gray-500"
            onClick={() => splitToAwaiting(line.id)}
          >
            ⏳ На изчакване
          </Button>
        </div>
      ))}
    </div>
  );
}
```

**Step 2: Helpers**

```ts
function splitToPaidNotTaken(lineId: number) {
  setItems((prev) => {
    const idx = prev.findIndex((i) => i.id === lineId);
    if (idx < 0) return prev;
    const orig = prev[idx];
    const available = computeAvailable(orig);
    if (orig.quantity <= available) return prev;
    const taken = { ...orig, quantity: available };
    const pending = {
      ...orig,
      id: tempId(), // local-only id, backend assigns real one
      quantity: orig.quantity - available,
      line_status: "paid_not_taken",
    };
    return [...prev.slice(0, idx), taken, pending, ...prev.slice(idx + 1)];
  });
}

function splitToAwaiting(lineId: number) {
  /* same shape, status="awaiting" */
}
```

**Step 3: Submit payload includes `line_status` per row** (no schema change on submit; backend already accepts via Task 7).

**Step 4: Manual smoke test**

Edit existing order → bump qty above stock → verify the 3-button warning → click "Платена невзета" → verify a second row appears with the chip + bg tint → save → verify backend persisted both rows.

**Step 5: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): split-on-oversell flow in edit modal (3 choices)"
```

---

## Task 16: Frontend — 2 new filter pills

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` — orders list filter pills row (around `:3611-3635`)

**Step 1: Pills**

```tsx
<button
  onClick={() => setHasPaidNotTaken(v => !v)}
  className={`px-3 py-1.5 rounded-full text-sm font-medium ${
    hasPaidNotTaken ? "bg-amber-500 text-white" : "bg-gray-100 hover:bg-gray-200"
  }`}
>
  💰 Платени невзети
</button>
<button
  onClick={() => setHasAwaiting(v => !v)}
  className={`px-3 py-1.5 rounded-full text-sm font-medium ${
    hasAwaiting ? "bg-gray-500 text-white" : "bg-gray-100 hover:bg-gray-200"
  }`}
>
  ⏳ На изчакване
</button>
```

**Step 2: Wire into orders query**

Add `hasPaidNotTaken` + `hasAwaiting` to query key + queryFn:

```ts
if (hasPaidNotTaken) parts.push("has_paid_not_taken=true");
if (hasAwaiting) parts.push("has_awaiting=true");
```

**Step 3: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): 'Платени невзети' + 'На изчакване' filter pills"
```

---

## Task 17: Manual end-to-end verification

Run `./scripts/start-mertm.sh`, then:

1. **Create paid_not_taken flow:**
   - Login admin → Поръчки → Нова поръчка
   - Pick product with stock=7
   - Set quantity = 10
   - Verify warning: 3-button choice → click "💰 Платена невзета"
   - Verify 2 rows: 7 normal + 3 paid_not_taken (with chip + amber bg)
   - Save → check inventory: 7 deducted to 0; verify 3 paid_not_taken row
   - Fulfill → check inventory: 0 - 3 = -3 (negative; promised stock)
   - Generate invoice → invoice for full 10 × price
   - Generate stock dispatch → only 7 normal rows on the SR PDF

2. **Handover flow:**
   - Approve incoming goods bringing 5 of that product
   - Inventory: -3 + 5 = 2
   - Notification appears in bell (if implemented for visibility)
   - Open the order → click "✓ Предадено" on the paid_not_taken line
   - Verify line_status flipped to normal; inventory unchanged (still 2)
   - Generate new stock dispatch → SR for the 3 just handed over

3. **Awaiting flow:**
   - Create new order → product with stock=0 → qty=2 → click "⏳ На изчакване"
   - Save → inventory unchanged (still 0)
   - No fulfill, no invoice, no SR (line is pre-order)
   - Approve incoming with 5 → inventory = 5; notification appears
   - Open order → "✓ Потвърди" on awaiting line → inventory = 5 - 2 = 3
   - Continue normal flow (fulfill, invoice, SR)

4. **Filter pills:**
   - Click "💰 Платени невзети" pill → orders list shows only orders with paid_not_taken lines
   - Click "⏳ На изчакване" pill → similar
   - Combine with date range / other filters → all AND-ed correctly

5. **Cancel paid_not_taken:**
   - Cancel an order with paid_not_taken lines → existing flow returns stock for normal lines; paid_not_taken lines (already deducted) are returned too
   - Manually generate credit note via existing UI (separate from Batch F1)

If any step fails, debug, fix, re-commit.

---

## Task 18: Update STATUS.md

```markdown
**Batch F1 — Paid-not-taken + Awaiting line statuses** (2026-04-29):

- Migration 064 — `order_items.line_status` enum + partial index
- Shared `ORDER_LINE_STATUSES` constant (BE+FE)
- `deductProductStock` accepts `allowNegative` option
- Fulfill: skip awaiting; allow negative for paid_not_taken
- New endpoints: handover (paid_not_taken→normal) + confirm-from-awaiting (awaiting→normal+deduct)
- Notification trigger on incoming confirm for matching pending lines
- 2 new filter params + filter pills
- Frontend visual markers (bg tint + chip)
- Edit modal split-on-oversell (3-button choice)
- Per-row "Предадено" / "Потвърди" buttons in drawer
```

```bash
git add STATUS.md
git commit -m "docs(status): Batch F1 complete — paid-not-taken + awaiting"
```

---

## Verification checklist (`superpowers:verification-before-completion`)

- [ ] Migration 064 applied; line_status column exists with default 'normal'
- [ ] All existing order_items rows have `line_status='normal'`
- [ ] Backend tests pass: `npx vitest run`
- [ ] Backend type-check clean
- [ ] Frontend type-check clean
- [ ] Manual E2E (Task 17) — all 5 sections green
- [ ] STATUS.md updated
- [ ] Notifications fire on incoming confirm (verified in dev)
- [ ] No console.log left in production code
- [ ] All commits use conventional format

---

## Future work — Batch I (Notifications UX upgrade)

Out of scope for Batch F1. Tracked separately when ready:

- Toasts (slide-in) for non-critical events
- Banner alerts for critical events (e.g. "5 pending orders ready")
- Improved Notification Center (groups, mark-as-read, search, history)
- Realtime polling / SSE
- Per-user read state (`user_notification_reads` table)
- Per-type preferences page
- Optional desktop notifications (Web Notifications API)
