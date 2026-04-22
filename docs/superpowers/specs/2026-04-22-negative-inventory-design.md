# Negative Inventory (Back-Order) — Design Spec

**Date:** 2026-04-22
**Author:** brainstorming session, user: magic
**Status:** Approved for planning

---

## 1. Goal

Allow operators to sell products even when stock has reached zero. Instead
of rejecting the order, the system lets `inventory.quantity` go negative
(-1, -2, -3, ...) to represent back-orders. When a new delivery arrives,
the negative balance is offset first (e.g. stock = −3 + incoming 10 →
final 7). A dedicated view shows which products are currently in the red.

Soft confirmation dialogs are shown at the two moments that move stock
downward (order creation and fulfillment) so nobody is surprised by an
accidental back-order.

## 2. Scope and constraints

- Back-ordering is **enabled for every product automatically**. No
  per-product toggle — the user explicitly chose the simpler global
  behaviour.
- Warning is a **soft confirm** (non-blocking) — after the user confirms,
  the server proceeds without additional server-side enforcement.
- Race-condition handling is explicitly **out of scope**. MERT-M usually
  has one or two concurrent operators; the design accepts that a client
  with stale stock data may skip the warning. The negative balance still
  shows up in the new "На минус" tab.
- Batches table is deprecated for MERT-M durable goods; its own
  `chk_batches_qty_nonneg` constraint is **left in place**.
- Direct-sale ("razpiska") refers to payments, not a separate stock
  outflow; no additional route changes needed there.
- No history/audit table for oversell events — YAGNI. Current negative
  state is enough; historical "when did this first go negative" can be
  derived later from `order_items` + `orders.fulfilled_at` if needed.
- No notifications when a delivery clears a back-order — YAGNI.

## 3. Architecture overview

Three layers change:

### 3.1 Database

One new migration `warehouse-backend/migrations/052_allow_negative_inventory.sql`:

```sql
ALTER TABLE inventory DROP CONSTRAINT IF EXISTS chk_inventory_qty_nonneg;
```

Rollback is a manual `ALTER TABLE inventory ADD CONSTRAINT
chk_inventory_qty_nonneg CHECK (quantity >= 0)`, which will fail if any
negative rows exist at the time of rollback — acceptable.

### 3.2 Backend

Two functions in `warehouse-backend/src/routes/orders.ts` change, plus
one severity change in `analytics.ts`. Incoming goods and manual
inventory adjustments need no changes.

#### `validateRequestedStock()` (current: orders.ts:1482-1523)

Old behaviour: throws `"Недостатъчна наличност"` (HTTP 400) when
requested quantity exceeds `available + EPSILON`.

New behaviour: never throws. Returns an info payload listing the items
that would go negative:

```ts
type OversellInfo = {
  product_id: number;
  available: number; // current total_stock
  requested: number; // order-item quantity
  final_stock: number; // available - requested, may be < 0
};

async function validateRequestedStock(
  client: PoolClient,
  items: Array<{ product_id: number; quantity: number }>,
): Promise<{ oversell_items: OversellInfo[] }>;
```

Callers (POST /orders handler) attach the result as
`response.body.warnings.oversell` when the array is non-empty. This is
purely informational — the front-end has already shown the confirm
dialog, and the server does not gate on it.

#### `deductProductStock()` (current: orders.ts:1543-1561)

Old SQL:

```sql
UPDATE inventory SET quantity = quantity - $1
WHERE product_id = $2 AND warehouse_id = 1 AND quantity >= $1
RETURNING id;
```

`insufficient_stock` error is thrown when `RETURNING` comes back empty.

New SQL:

```sql
UPDATE inventory SET quantity = quantity - $1
WHERE product_id = $2 AND warehouse_id = 1
RETURNING id;
```

If `RETURNING` comes back empty, it means there is no inventory row for
this product/warehouse at all. Fall back to:

```sql
INSERT INTO inventory (product_id, warehouse_id, quantity)
VALUES ($2, 1, -$1);
```

The `insufficient_stock` error path is removed from the function and
from the error-mapping table used by the route handler.

#### Analytics (current: analytics.ts:180-193)

Single change: `severity: 'critical'` → `severity: 'warning'` in the
`negative_stock` anomaly row. Query body and result type untouched.

### 3.3 Frontend

Five additions (new shared dialog component, two wire-ups in the Orders
page, new tab in the Inventory page, shared colour util):

#### New component `OversellConfirmDialog`

Location: `warehouse-frontend/src/components/OversellConfirmDialog.tsx`.

Built on the existing shadcn `AlertDialog` primitive. Props:

```ts
interface OversellConfirmDialogProps {
  open: boolean;
  items: Array<{
    product_name: string;
    available: number;
    requested: number;
    final_stock: number; // negative
  }>;
  onConfirm: () => void;
  onCancel: () => void;
}
```

Renders a list like:

> **⚠ Наличността ще отиде под нулата**
>
> - **Бен Мари-топла витрина** — ще стане **-2** (наличност: 1, поръчка: 3)
> - **Електрическа Бен Мари** — ще стане **-5** (наличност: 0, поръчка: 5)
>
> [Отказ] [Продължи]

#### Order creation (New Order modal in `Orders.tsx`)

Before POSTing to `/orders`, the submit handler runs a client-side
comparison using `total_stock` from the products cache. If any line
would result in `final_stock < 0`, open `OversellConfirmDialog`. On
"Продължи" → continue with POST. On "Отказ" → stay in modal.

#### Order fulfillment (Fulfill button in `Orders.tsx` list)

Same check before POSTing to `/orders/:id/fulfill`. Fetch `order_items`
from the already-loaded order detail (or quick GET /orders/:id),
compare against current `total_stock` from the products cache, show the
dialog, proceed on confirm.

#### Inventory tab "На минус"

Location: `warehouse-frontend/src/pages/Inventory.tsx`.

Add a fifth tab after `Нисък запас`:

```
Налични | Всички | Нулеви | Нисък запас | На минус
```

Tab content:

- Same table columns as the other tabs (Продукт | SKU | Категория | Мерна ед. | Наличност | Статус)
- Filter: `total_quantity < 0`
- `Наличност` cell: red, bold (e.g. **-3**) with a ⚠ icon
- `Статус` cell: red badge "На минус"
- KPI card at top: "Продукти на минус: **N**"
- Default sort: `ORDER BY total_quantity ASC` (most-negative first)

#### Visual indicators elsewhere

New util `stockColorClass(qty: number): string` in
`warehouse-frontend/src/lib/utils.ts`:

- `qty < 0` → `"text-red-600 font-semibold"`
- `qty === 0` → `"text-gray-500"`
- `qty > 0 && qty <= low_stock_threshold` → `"text-amber-600"`
- default → `"text-gray-900"`

Applied in the `Наличност` column across `Products`, `Inventory`, and
the `New Order` product autocomplete dropdown ("на минус: -3" hint).

## 4. Data flow

### 4.1 Selling into the negative

```
User opens "Нова поръчка"
  → selects partner
  → adds product X (stock=0) with qty=3
  → clicks "Създай"
  → frontend: line would yield final_stock=-3 → show OversellConfirmDialog
  → user clicks "Продължи"
  → POST /orders with the items
  → backend: validateRequestedStock returns { oversell_items: [...] }
  → backend: order created (status=pending)
  → response has warnings.oversell; UI surfaces a toast
  → stock still 0 at this point (order is pending, not fulfilled)
```

```
User clicks "Изпълни" on the pending order
  → frontend: detail has qty=3, product_stock=0 → final_stock=-3
  → OversellConfirmDialog opens again
  → user clicks "Продължи"
  → POST /orders/:id/fulfill
  → backend: deductProductStock updates inventory.quantity from 0 → -3
  → inventory row persists at -3
```

### 4.2 Delivery clears the back-order

```
Delivery of 10 pcs confirmed (POST /incoming/:id/confirm)
  → existing code: ON CONFLICT DO UPDATE SET quantity = quantity + 10
  → inventory row goes from -3 to 7
  → no special handling needed
```

### 4.3 "На минус" tab

```
User navigates Склад → "На минус"
  → Inventory page already loads every product with its total_stock;
    the tab is a pure client-side filter (total_quantity < 0)
  → list shows the back-ordered products with current negative balance
  → KPI card shows count
```

## 5. Error handling

- The old `insufficient_stock` error is **removed**, not repurposed.
- `validateRequestedStock` no longer throws; every caller site that
  handled that exception is simplified.
- Client-side `OversellConfirmDialog` is the only "gate"; if it is
  bypassed (e.g. stale client cache), the sale still goes through and
  the negative stock shows up in the "На минус" tab — the user will see
  it and act accordingly.
- `deductProductStock` fall-back INSERT handles the edge case of a
  product with no `inventory` row at all (sales before any delivery
  ever landed).

## 6. Testing

### 6.1 Backend (vitest + PG test DB)

New file `warehouse-backend/src/__tests__/negative-inventory.test.ts`:

1. After migration 052, `INSERT INTO inventory ... VALUES (1, 1, -5)`
   succeeds.
2. `POST /orders` with qty=3 when stock=0 → 201 Created, response has
   `warnings.oversell` with `final_stock: -3`.
3. `POST /orders/:id/fulfill` when stock=0 → 200, inventory row becomes
   -3.
4. Fulfilling a second order on the same product (qty=3) → inventory
   row becomes -6.
5. Confirming incoming goods (qty=10) when inventory=-3 → inventory=7.
6. Confirming incoming goods (qty=3) when inventory=-10 → inventory=-7
   (partial fill).
7. Cancelling a fulfilled order (qty=3) when inventory=-1 → inventory=2
   (−1 + 3).

Existing test that asserts `"Недостатъчна наличност"` 400 must be
updated or deleted.

### 6.2 Frontend

The project has no vitest / React Testing Library setup on the
frontend side. Introducing one here is out of scope; UI behaviour is
covered by the manual E2E scenarios below.

### 6.3 Manual E2E (via preview tools, inside the implementation plan)

1. New order with sufficient stock → dialog does **not** appear.
2. New order with insufficient stock → dialog appears, "Продължи"
   persists the order with a warning toast.
3. Fulfill a pending order whose stock has dropped to 0 in the
   meantime → dialog appears again at fulfillment, "Продължи" lets
   stock go negative.
4. After fulfillment → the product appears in Склад → "На минус" tab
   with red bold negative number and "На минус" badge.
5. Confirm incoming goods with qty greater than the current negative →
   product leaves "На минус" tab, stock goes positive.
6. Analytics page: negative stock anomaly now shows as a yellow
   "warning", not a red "critical".

### 6.4 Rollback

Not automated. Manual SQL if needed; will fail loudly if negatives
exist in the DB at rollback time.

## 7. Out of scope

- Per-product back-order toggle
- Server-side 409 / confirm_oversell flag
- Oversell audit log table
- Notifications when a delivery clears back-orders
- Changes to batches table (deprecated)
- Razpiska-specific flow (not a separate stock-outflow path)
- History view ("when did this product first go negative")
