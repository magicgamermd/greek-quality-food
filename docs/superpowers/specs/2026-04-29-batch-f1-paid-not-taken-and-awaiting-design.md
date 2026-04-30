# Batch F1 — Paid-not-taken + Awaiting line statuses design

**Date:** 2026-04-29
**Status:** Approved (brainstorm complete, ready for implementation plan)
**Scope:** Per-line status on `order_items` allowing two new soft states:

- `paid_not_taken` — customer paid for the line, but the goods were not
  physically handed over (stock not on shelf or insufficient).
- `awaiting` — customer reserved the line; not paid; waiting for stock
  to arrive.

Plus: stock policy, document logic, "Предадено" handover button,
notification trigger, filter pills, visual markers.

**Notification UX upgrade (toasts, banners, improved center) is OUT of
scope — tracked separately as Batch I.**

---

## Understanding Summary

**What we're building:**

- New column `order_items.line_status` (default `'normal'`).
- Quantity-split workflow: when order calls for 10 but only 7 are
  available, the line is split into two rows — qty=7 `normal` and
  qty=3 `paid_not_taken`.
- Stock semantics:
  - `normal` lines deduct stock at fulfill (today's behaviour).
  - `paid_not_taken` lines deduct stock at fulfill, allowed to go
    NEGATIVE (the standard BG warehouse "promised" indicator).
  - `awaiting` lines do NOT touch stock until they are converted to
    `normal`.
- Documents:
  - Invoice covers the FULL paid amount (all `normal` +
    `paid_not_taken` lines) — single legal artefact.
  - Stock-dispatch slips ("стокова разписка") only contain `normal`
    lines that were physically handed over. Multiple SR PDFs may
    exist per order — one per handover batch.
- "Предадено" (handover) button on a `paid_not_taken` line flips its
  status to `normal`. Stock is NOT deducted again (already deducted
  at fulfill); a new SR PDF can be generated for the handed-over rows.
- Notifications: when incoming goods are confirmed and the increased
  stock covers a pending line (paid_not_taken or awaiting), an
  `INSERT INTO notifications (type='pending_order_ready', ...)` is
  fired. The frontend bell-icon dropdown surfaces these (no UI
  redesign — bell remains as today; modern UX is Batch I).
- Filter pills: orders list gets two new pills "Платени невзети" and
  "На изчакване", each filtering for orders with at least one matching
  line.
- Visual: rows with non-normal `line_status` rendered with a soft
  background tint (amber for paid_not_taken, gray for awaiting) plus
  a chip on the line ("💰 Платена невзета" / "⏳ Изчакване").
- Mixed line_status within a single order is allowed.

**Why:**

- Real-world BG warehouse case: customer pays in full while one item
  is missing from stock. Today there is no clean path — you'd
  oversell, fake the stock, or split into two orders.
- Pre-order workflow: customer phones asking for an item we don't
  have; we register their interest; when delivery arrives, we call
  them.

**For whom:** Sales (`ORDERS_MANAGE`). Warehouse staff see
notifications. Admin retains existing privileged operations
(below-cost, edit-after-fulfill from Batch A).

**Key constraints:**

- `paid_not_taken` marker IMPLICITLY allows oversell — no extra
  permission. The marker itself is the explicit intent.
- Cancel flow reuses existing logic (stock return). Credit note remains
  a manual step (existing UI button).
- Single invoice for the full paid amount. Stock-dispatch slips are
  generated per-handover-batch.
- Awaiting lines are not visible on documents (no fact, no SR — it's a
  pre-order, not a sale).

**Non-goals:**

- Modern notification UX (toasts, banners, improved bell center) → Batch I.
- Auto credit note on cancel → manual.
- Order-level homogeneity restrictions → mixed allowed.
- Partial payment for awaiting → either paid in full (paid_not_taken)
  or unpaid (awaiting); not in between.

---

## Assumptions

1. Stock may go negative — DB has no CHECK constraint preventing this
   (verified).
2. `restoreOrderItemsToInventory` (existing helper used in cancel
   flow) handles negative stock correctly — verify and adjust if
   needed.
3. `notifications` table schema: `(id, type TEXT, message TEXT,
payload JSONB, ...)` or similar — check & extend with
   `pending_order_ready` type.
4. Edit-items modal allows the cashier to mark a row's line_status
   manually (or accept an automated split-on-oversell flow — see plan
   Task 6).
5. Migration is backward-compatible: every existing `order_items` row
   receives `line_status='normal'`.
6. Notification payload contains JSONB
   `{order_id, product_id, qty_pending, partner_name}` for the bell
   dropdown to render rich text.

---

## Decision Log

| #   | Decision                                                               | Alternatives                                         | Reason                                                               |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | `line_status` enum column on `order_items`                             | Two booleans; JSON tag; separate table               | Single source of truth; clean queries; minimal schema                |
| 2   | Quantity split into separate rows                                      | `qty + quantity_pending` column; manual partial flow | Standard ERP; clean stock logic; per-line independence               |
| 3   | `paid_not_taken` deducts stock (allowed negative); `awaiting` does not | Both deduct; neither deducts                         | Reality match: paid=sale; awaiting=pre-order                         |
| 4   | 1 invoice + multiple SR slips (per delivery batch)                     | 1 on full; 2 invoices                                | Accounting accuracy (invoice=sale) + physical accuracy (SR=handover) |
| 5   | Notification trigger on incoming-goods CONFIRM                         | On receive; both                                     | Stock is real at confirm moment                                      |
| 6   | Reuse existing bell + new type (minimal)                               | Auto-upgrade UX                                      | Cross-cutting concern → Batch I separate                             |
| 7   | `paid_not_taken` mark implicitly allows oversell                       | New permission; admin-only                           | Legitimate business case; explicit marker = intent                   |
| 8   | Cancel reuses existing flow; credit note manual                        | Auto credit note                                     | Flexibility; existing infra works                                    |
| 9   | Mixed line_status in one order allowed                                 | Homogeneous; max 2 types                             | Real-world matches; per-line semantic                                |
| 10  | UI: bg-color + chip + filter pills                                     | Solo color; solo chip                                | Both visual + explicit; pills enable workflow filtering              |

---

## Final Design

### DB migration (064)

```sql
-- 064_order_items_line_status.sql
-- Adds per-line state to order_items. Default 'normal' covers all
-- existing rows; the new states unlock paid-not-taken and awaiting
-- workflows (Batch F1).

BEGIN;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS line_status TEXT NOT NULL DEFAULT 'normal'
    CHECK (line_status IN ('normal', 'paid_not_taken', 'awaiting'));

CREATE INDEX IF NOT EXISTS idx_order_items_line_status
  ON order_items(line_status)
  WHERE line_status != 'normal';

COMMIT;
```

(Partial index on non-normal rows keeps the index small.)

### Backend — schema + helpers

`warehouse-backend/src/lib/order-line-status.ts` — shared constant:

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

Mirror at `warehouse-frontend/src/lib/orderLineStatus.ts`.

### Backend — INSERT path (POST /orders, PUT edit)

The order create / edit handler accepts a per-line `line_status` field.
Each item submitted by the frontend includes `line_status`, defaulting
to `'normal'`. The split-into-two-rows logic happens on the
**frontend** (cashier sees the partial-availability warning, clicks
"Маркирай 3 като платени невзети" → frontend submits 2 rows). Backend
just accepts the rows as-is.

The fulfill flow (`POST /orders/:id/fulfill`) is updated:

```ts
for (const item of items) {
  if (item.line_status === "awaiting") {
    // Skip: awaiting lines do not touch stock or COGS
    continue;
  }
  // normal + paid_not_taken: deduct (paid_not_taken may go negative)
  await deductProductStock(client, item.product_id, item.quantity, {
    allowNegative: item.line_status === "paid_not_taken",
  });
  // …existing COGS snapshot…
}
```

### Backend — `POST /orders/:id/items/:itemId/handover`

New endpoint that converts a `paid_not_taken` line to `normal`:

```ts
app.post(
  "/:id/items/:itemId/handover",
  { preHandler: ordersManagePreHandler },
  async (req, reply) => {
    const { id, itemId } = req.params;
    return await transaction(async (client) => {
      const {
        rows: [item],
      } = await client.query(
        `SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE`,
        [itemId, id],
      );
      if (!item) throw HttpError(404);
      if (item.line_status !== "paid_not_taken") {
        throw HttpError(400, "Only paid_not_taken lines can be handed over");
      }
      await client.query(
        `UPDATE order_items SET line_status = 'normal' WHERE id = $1`,
        [itemId],
      );
      return { id: itemId, line_status: "normal" };
    });
  },
);
```

(Awaiting → normal is a separate flow — happens via "Предадено" after
delivery + customer confirms; same endpoint also covers it. The
endpoint accepts both `paid_not_taken` AND `awaiting` source statuses;
only `awaiting → normal` deducts stock at this moment.)

Wait — to keep semantics clean, two endpoints:

- `POST /orders/:id/items/:itemId/handover` — `paid_not_taken → normal`
  (no stock change; already deducted at fulfill)
- `POST /orders/:id/items/:itemId/confirm-from-awaiting` — `awaiting →
normal` (deduct stock now; also requires payment to be recorded)

### Backend — Notification trigger on incoming confirm

In `routes/incoming.ts` confirm handler, after stock is increased:

```ts
for (const incomingItem of items) {
  // Find pending order lines awaiting this product
  const { rows: pendingLines } = await client.query(
    `SELECT oi.order_id, oi.product_id, oi.quantity, oi.line_status,
            o.partner_id, p.name AS partner_name, oi.name_bg_snapshot AS product_name
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
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
          product_id: pending.product_id,
          qty_pending: pending.quantity,
          line_status: pending.line_status,
          partner_name: pending.partner_name,
        }),
      ],
    );
  }
}
```

Idempotency: a flag column `notification_sent_at` on `order_items` (or
similar) avoids re-sending. **YAGNI for now** — first incoming confirm
fires the notif; admin can mark it read.

### Backend — `GET /orders` filter additions

Two new query params: `?has_paid_not_taken=true` and
`?has_awaiting=true`. Each adds an EXISTS subquery:

```ts
if (hasPaidNotTaken === "true") {
  where += ` AND EXISTS (
    SELECT 1 FROM order_items oi
    WHERE oi.order_id = o.id AND oi.line_status = 'paid_not_taken'
  )`;
}
// same for awaiting
```

### Frontend — order types extension

`warehouse-frontend/src/types/index.ts`:

```ts
export interface OrderItem {
  // …existing…
  line_status?: "normal" | "paid_not_taken" | "awaiting";
}
```

### Frontend — visual markers in drawer

In the items table of order detail and edit modal:

```tsx
const lineStatusStyles = {
  normal: { bg: "", chip: null },
  paid_not_taken: {
    bg: "bg-amber-50",
    chip: (
      <Badge variant="warning" className="text-xs">
        💰 Платена невзета
      </Badge>
    ),
  },
  awaiting: {
    bg: "bg-gray-50",
    chip: (
      <Badge variant="secondary" className="text-xs">
        ⏳ Изчакване
      </Badge>
    ),
  },
};

<TableRow className={lineStatusStyles[item.line_status ?? "normal"].bg}>
  …<TableCell>{lineStatusStyles[item.line_status ?? "normal"].chip}</TableCell>
</TableRow>;
```

### Frontend — split flow on oversell warning

Edit modal already detects oversell. When detected:

```
Item X: quantity 10, available 7
[Намали до 7] [Маркирай 3 като платена невзета] [Маркирай 3 като изчакваща]
```

Clicking the action splits the row in the local state into two rows
before submit.

### Frontend — "Предадено" button per row

In the drawer, for each row with `line_status='paid_not_taken'`:

```tsx
<Button
  size="sm"
  variant="outline"
  onClick={() =>
    handoverMutation.mutate({ orderId: detail.id, itemId: item.id })
  }
>
  ✓ Предадено
</Button>
```

(Similar for `awaiting → normal` with own endpoint.)

### Frontend — filter pills

In the existing filter row of orders list:

```tsx
<button onClick={() => setHasPaidNotTaken(v => !v)}>💰 Платени невзети</button>
<button onClick={() => setHasAwaiting(v => !v)}>⏳ На изчакване</button>
```

Wired into the orders query.

### Test strategy

- Backend integration:
  - POST /orders with mixed line_status saves all rows correctly.
  - Fulfill skips awaiting lines; deducts paid_not_taken (allowing
    negative stock).
  - Handover endpoint flips paid_not_taken → normal without re-deduct.
  - Confirm-from-awaiting flips awaiting → normal AND deducts stock.
  - Cancel of order with paid_not_taken returns stock correctly
    (negative + cancellation).
  - Incoming confirm fires notifications for matching pending lines.
  - Filter `?has_paid_not_taken=true` returns only matching orders.

- Frontend manual smoke (see plan).

---

## Non-Functional Requirements

- **Performance:** trivial — 1 column + indexes; +2 filter EXISTS;
  +1 notification INSERT loop on incoming confirm
- **Scale:** no impact
- **Security:** existing `ORDERS_MANAGE`; no new attack surface
- **Reliability:** atomic transactions for fulfill + handover; cancel
  flow already audited
- **Maintenance:** +1 migration, +shared status constant (BE+FE),
  +2 endpoints (handover, confirm-from-awaiting), +notification hook
  in incoming.ts, +UI markers + 2 filter pills + split-on-oversell
  workflow

---

## Implementation Plan

(Generated next by `writing-plans` skill.)
