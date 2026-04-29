# Batch B — Product name snapshot in order_items design

**Date:** 2026-04-29
**Status:** Approved (brainstorm complete, ready for implementation plan)
**Scope:** Snapshot product identity (`name_bg`, `name_en`, `sku`) on
`order_items` rows so historical documents continue to display the name
that was on the order at time of issuance, regardless of subsequent
product renames in the master catalog.

---

## Understanding Summary

**What we're building:** Three new snapshot columns on `order_items`
(`name_bg_snapshot`, `name_en_snapshot`, `sku_snapshot`). At the time a
new `order_items` row is INSERTed, the current values from `products`
are copied in. All reads in an "order context" (PDF generation, order
drawer, items table, search filters, reports) read from the snapshot
instead of joining with `products`.

**Why:**

- Invoices, stock-dispatch slips, and commercial documents must
  reflect the product name that was used when the document was issued.
  This is a Bulgarian accounting / legal norm — issued documents are
  immutable.
- Renaming a product in the catalog must NOT alter previously issued
  documents.

**For whom:** All MERT-M users. The change is mostly invisible in the
day-to-day flow but rigid for audit / re-print scenarios.

**Key constraints:**

- Snapshot is set at INSERT time; it is NEVER mutated by a subsequent
  `UPDATE products`.
- Editing an existing order's item (qty, price, discount) does NOT
  change the snapshot.
- Adding a NEW item to an existing order on a later date snapshots
  the **current** product values at the moment of add (the snapshot is
  always "what was on the order line when the line itself was created").
- Frontend response shape stays unchanged — backend swaps the source
  of `name_bg` / `name_en` / `sku` from JOIN to snapshot, but emits
  the same field names.

**Non-goals:**

- No `product_name_history` table (a full rename timeline) — YAGNI.
- No "(previously named X)" indicator in the UI — the snapshot name is
  the truth for that line.
- No change to `fiscal-printer` (uses category name, not product name).
- No change to the new-order picker, products page, inventory low-stock
  alerts — these always read the live catalog.

---

## Assumptions

1. `products.name_bg` is always NOT NULL (enforced by schema).
2. `products.name_en` and `products.sku` may be NULL; snapshot columns
   mirror this nullability.
3. Backfill of legacy `order_items` rows can run inside a single
   transaction without performance issues — the table is not large in
   MERT-M production data.
4. Race condition at INSERT time (concurrent rename + new order) is
   acceptable: the INSERT runs in a transaction and reads `products`
   inline, so the snapshot reflects whatever the rename committed
   before the order INSERT — eventual consistency.
5. Frontend code that already reads `item.name_bg` / `item.name_en` /
   `item.sku` will continue to work, because backend response shape is
   preserved (the source changes, the field names do not).

---

## Decision Log

| #   | Decision                                             | Alternatives                                           | Reason                                                                                                |
| --- | ---------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 1   | Snapshot in `order_items` (Option 1 from brainstorm) | Full `product_name_history` table                      | Simpler, YAGNI; covers 100% of the use case                                                           |
| 2   | Snapshot scope: `name_bg` + `name_en` + `sku`        | Only `name_bg`; full snapshot incl. `unit` and `brand` | Covers everything the customer sees on a printed document; `unit` / `brand` rarely change in practice |
| 3   | Backfill with current names for legacy `order_items` | Lazy NULL + COALESCE fallback; NULL + UI indicator     | No NULL handling needed afterwards; legacy inaccuracy already exists today                            |
| 4   | All order-context reads switch to snapshot           | PDF only; hybrid with "(was X)" indicator              | One rule, no UI/PDF inconsistency, simpler reasoning                                                  |

---

## Final Design

### DB migration (057)

```sql
-- 057_order_items_product_name_snapshot.sql
-- Adds snapshot columns to order_items so historical documents preserve
-- the product name that was used at issuance.

BEGIN;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS name_bg_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS name_en_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS sku_snapshot TEXT;

-- Backfill existing rows with current product values. Safe to run
-- inside a single transaction at MERT-M's data volume.
UPDATE order_items oi
   SET name_bg_snapshot = p.name_bg,
       name_en_snapshot = p.name_en,
       sku_snapshot     = p.sku
  FROM products p
 WHERE oi.product_id = p.id
   AND oi.name_bg_snapshot IS NULL;

-- Make name_bg_snapshot NOT NULL going forward (every product has a
-- name_bg, so backfill must have set this for every existing row).
ALTER TABLE order_items
  ALTER COLUMN name_bg_snapshot SET NOT NULL;

COMMIT;
```

`name_en_snapshot` and `sku_snapshot` remain nullable (mirroring the
catalog).

### Backend write path

In every place where `INSERT INTO order_items (…) VALUES (…)` is
issued (search for the four matches in `routes/orders.ts` and
`routes/incoming-batch-conversion` if present):

```ts
// Resolve current names for the products being inserted (one query).
const { rows: snaps } = await client.query(
  `SELECT id, name_bg, name_en, sku FROM products WHERE id = ANY($1::int[])`,
  [items.map((i) => i.product_id)],
);
const snapMap = Object.fromEntries(snaps.map((p) => [p.id, p]));

for (const item of items) {
  const snap = snapMap[item.product_id];
  await client.query(
    `INSERT INTO order_items
       (order_id, product_id, quantity, unit_price, discount_percent, total_price,
        name_bg_snapshot, name_en_snapshot, sku_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      orderId,
      item.product_id,
      item.quantity,
      item.unit_price,
      item.discount_percent ?? 0,
      item.total_price,
      snap.name_bg,
      snap.name_en,
      snap.sku,
    ],
  );
}
```

The same logic applies to `PUT /orders/:id` (the edit path) when a new
line is added.

When a row is **updated** (qty / price / discount on an existing line),
the snapshot columns are **NOT touched**. This is enforced by simply
omitting them from the UPDATE statement.

### Backend read path

Replace every `SELECT oi.*, p.name_bg, p.name_en, p.sku, ... FROM
order_items oi JOIN products p ON p.id = oi.product_id` query with:

```sql
SELECT oi.*,
       oi.name_bg_snapshot AS name_bg,
       oi.name_en_snapshot AS name_en,
       oi.sku_snapshot     AS sku,
       p.unit, p.brand,           -- still from current catalog
       p.weight_kg, p.purchase_price
  FROM order_items oi
  LEFT JOIN products p ON p.id = oi.product_id
 WHERE oi.order_id = $1
```

Unit, brand, weight, purchase_price still come from the live catalog —
they are operational data, not customer-visible identity. The JOIN is
now LEFT JOIN because a product could (theoretically) be soft-deleted;
the snapshot fields cover the customer-visible identity even then.

### Affected files

Backend:

- `warehouse-backend/src/routes/orders.ts` — write path (INSERT in POST
  and in PUT); read paths (drawer detail, edit fetch, list).
- `warehouse-backend/src/routes/invoices.ts` — read paths (4 places:
  POST /invoices, regenerate, credit note, send-email).
- `warehouse-backend/src/services/invoice-pdf.ts` — interface already
  has `name_bg` / `name_en`; nothing changes here, the source of values
  changes upstream.
- `warehouse-backend/src/services/document-pdf.ts` — same; reads
  `item.name_bg` / `item.name_en`.

Frontend:

- No intentional changes. The response shape is preserved; the UI
  continues to display `item.name_bg` / `item.name_en` / `item.sku`.

### Test strategy

- Migration: apply on a copy of staging; verify (1) every order_items
  row has a non-NULL `name_bg_snapshot`, (2) values match
  `products.name_bg` at backfill time.
- Unit: a small helper (if any) for the snapshot mapping. Likely none —
  it's plain SQL.
- Integration:
  - POST /orders inserts with snapshot columns populated → SELECT
    confirms snapshots match the products at insert time.
  - UPDATE products.name_bg afterwards → SELECT order_items confirms
    snapshot is unchanged.
  - PUT /orders/:id adding a new line uses the **current** product
    name as the snapshot.
  - PUT /orders/:id editing qty does NOT change the snapshot.
- E2E:
  - Create order → fulfill → invoice → verify PDF shows current name
    "X".
  - Rename product to "Y" → re-open invoice PDF → verify still shows
    "X".
  - Create new order with same product → verify snapshot is now "Y".

---

## Non-Functional Requirements

- **Performance:** mildly improved — many queries drop a `JOIN
products`. Backfill UPDATE may run for a few seconds on larger data;
  acceptable as a one-time migration cost.
- **Scale:** no impact.
- **Security:** no change.
- **Reliability:** atomic — snapshot is written in the same
  transaction as the order_item INSERT.
- **Maintenance:** +3 columns on `order_items`, +1 migration. Read
  queries become simpler. Net win.

---

## Implementation Plan

(Generated next by the `writing-plans` skill.)
