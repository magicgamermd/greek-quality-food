# Batch A — Permission features design

**Date:** 2026-04-29
**Status:** Approved (brainstorm complete, ready for implementation plan)
**Scope:** Two permission features for MERT-M warehouse:

1. Admin-only override for selling below cost (`purchase_price`).
2. Admin-only edit lock for fulfilled / invoiced orders.

---

## Understanding Summary

**What we're building:**

1. **Below-cost override** — selling under `purchase_price` is forbidden for
   everyone; admin can approve it for a specific order via a confirm dialog;
   the entire operation is audited.

2. **Edit lock on finalized orders** — orders with status `fulfilled` or
   `invoiced` can be edited only by admin (or any user with the new
   permission).

**Why:**

- Financial control — prevent accidental losses (1) and accidental/malicious
  modification of issued documents (2).
- Bulgarian accounting good practice — full audit trail for every financial
  override.

**For whom:** MERT-M internal team. Admin is owner; other roles
(`warehouse`, `accountant`, `sales`) are restricted.

**Key constraints:**

- Backend enforcement (not frontend-only) — clients cannot bypass via
  DevTools / curl.
- Per-order approval (not per-line).
- Audit JSONB snapshot stored on the order itself.
- Customer does NOT see below-cost markings on the printed invoice.

**Non-goals:**

- No below-cost reports / analytics page (separate feature, future).
- No bulk approval (multiple orders at once).
- No self-revoke of approval (admin approves once; revocation requires
  cancelling the order).

---

## Assumptions

1. The `admin` role always has every permission by default (verified in
   `ROLE_DEFAULTS`).
2. Editing a fulfilled / invoiced order already triggers auto-regenerate
   of the invoice (verified in current code) — we are only restricting
   WHO can edit, not WHAT happens on edit.
3. `products.purchase_price` is a valid reference for "cost" — MERT-M
   keeps it up to date in the Products page.
4. The Edit-items modal in the order drawer is the only UI path that
   modifies items after creation (no parallel paths to gate).

---

## Decision Log

| #   | Decision                                                      | Alternatives considered                      | Reason                                                                                                                                 |
| --- | ------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Hard backend block + audit trail                              | Frontend-only confirm; backend without audit | Frontend-only is bypassable; audit is near-free and important for financial control                                                    |
| 2   | Per-order approval scope                                      | Per-line; per-session                        | Per-order balances granularity with UX; per-session is dangerous (admin forgets to disable)                                            |
| 3   | New permission `BELOW_COST_OVERRIDE`                          | Hard role check `user.role === 'admin'`      | Consistent with existing permission system; future-proof (can grant to non-admin user without making them admin)                       |
| 4   | Audit detail = `approved_by` + `approved_at` + JSONB snapshot | Minimal; full audit log table                | JSONB is near-free and captures price/cost at approval time; full audit log is overkill for this rare event                            |
| 5   | Visibility B (UI badge + reports filter; not on PDF)          | Drawer-only; including PDF                   | Customer must not see internal cost data (BG accounting / B2B norm); internal team has full visibility                                 |
| 6   | Edit-after-fulfill admin-only for `fulfilled` + `invoiced`    | Only fulfilled; everything after confirmed   | `pending` / `confirmed` / `processing` are still drafts; from `fulfilled` onwards there are real financial artefacts (stock + invoice) |
| 7   | New permission `ORDERS_EDIT_AFTER_FULFILL`                    | Hard role check                              | Same reason as #3                                                                                                                      |

---

## Final Design

### DB migration (056)

```sql
BEGIN;

ALTER TABLE orders
  ADD COLUMN below_cost_approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN below_cost_approved_at TIMESTAMPTZ,
  ADD COLUMN below_cost_details JSONB;

CREATE INDEX IF NOT EXISTS idx_orders_below_cost_approved_at
  ON orders(below_cost_approved_at)
  WHERE below_cost_approved_at IS NOT NULL;

COMMIT;
```

No new tables; permissions are stored in the existing
`user_permission_overrides` table.

### Backend

**`warehouse-backend/src/lib/permissions.ts`** — register two new
permissions:

```ts
export const PERMISSIONS = {
  // …existing…
  BELOW_COST_OVERRIDE: "orders.below_cost_override",
  ORDERS_EDIT_AFTER_FULFILL: "orders.edit_after_fulfill",
} as const;
```

`ROLE_DEFAULTS.admin` already contains every permission via
`Object.values(PERMISSIONS)`. Other roles must NOT receive these two by
default — verify and adjust if needed.

`PERMISSION_REGISTRY` — add Bulgarian labels + descriptions for each new
permission so they appear in the future admin permission UI.

**`warehouse-backend/src/routes/orders.ts`:**

`POST /orders` and `PUT /orders/:id`:

```ts
// Compute below-cost items from request payload.
// Effective price after discount: unit_price × (1 - discount_percent / 100)
const belowCostItems = computeBelowCostItems(items, productCostMap);

if (belowCostItems.length > 0) {
  if (body.allow_below_cost !== true) {
    throw HttpError(
      400,
      "Има артикули под доставна цена. Изисква одобрение от admin.",
    );
  }
  if (!(await hasPermission(userId, PERMISSIONS.BELOW_COST_OVERRIDE))) {
    throw HttpError(
      403,
      "Само admin може да одобрява продажба под доставна цена.",
    );
  }
  // Save audit snapshot
  belowCostApprovedBy = userId;
  belowCostApprovedAt = new Date();
  belowCostDetails = belowCostItems.map((i) => ({
    product_id: i.product_id,
    product_name: productNameMap[i.product_id],
    quantity: i.quantity,
    unit_price: i.unit_price,
    discount_percent: i.discount_percent,
    purchase_price: productCostMap[i.product_id],
    loss_per_unit: productCostMap[i.product_id] - i.effective_price,
  }));
}
```

`PUT /orders/:id`:

```ts
const order = await fetchOrder(id);
if (order.status === "fulfilled" || order.status === "invoiced") {
  if (!(await hasPermission(userId, PERMISSIONS.ORDERS_EDIT_AFTER_FULFILL))) {
    throw HttpError(403, "Само admin може да редактира приключени поръчки.");
  }
}
// …existing edit logic…
```

`GET /orders` — accept `?below_cost_only=true` parameter:

```ts
if (query.below_cost_only === "true") {
  whereClauses.push("o.below_cost_approved_at IS NOT NULL");
}
```

### Frontend

**Permission helpers (`warehouse-frontend/src/contexts/PermissionContext.tsx`):**

- Already provides `hasPermission(perm)` hook.
- Just add the two new permission constants in
  `warehouse-frontend/src/lib/permissions.ts` (mirror of backend).

**`Orders.tsx` — new-order modal + edit modal submit:**

```ts
const belowCostItems = computeBelowCostItems(items);
const canOverride = hasPermission(PERMISSIONS.BELOW_COST_OVERRIDE);

if (belowCostItems.length > 0) {
  if (!canOverride) {
    setErrorMsg("Има артикули под доставна цена. Свържи се с admin.");
    return;
  }
  // Show confirm dialog with detailed table
  const ok = await confirmBelowCost(belowCostItems);
  if (!ok) return;
  payload.allow_below_cost = true;
}
```

The confirm dialog lists product name, qty, unit price, cost, loss per
unit, and total loss. Modeled on the existing `ConfirmDialog` component.

**`Orders.tsx` — Edit button visibility:**

```tsx
{
  detail.status !== "cancelled" &&
    ((detail.status !== "fulfilled" && detail.status !== "invoiced") ||
      hasPermission(PERMISSIONS.ORDERS_EDIT_AFTER_FULFILL)) && (
      <Button onClick={() => setEditOpen(true)}>Редактирай артикули</Button>
    );
}
```

**`Orders.tsx` — orders list, badge column:**

```tsx
{
  order.below_cost_approved_at && (
    <span className="ml-1" title="Поръчка с одобрение под доставна цена">
      ⚠
    </span>
  );
}
```

**`Orders.tsx` — drawer audit badge:**

```tsx
{
  detail.below_cost_approved_at && (
    <div className="bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-sm text-amber-800">
      ⚠ Под доставна цена — одобрена от {detail.below_cost_approved_by_name}
      на {formatDate(detail.below_cost_approved_at)}
    </div>
  );
}
```

**Reports filter UI** — small toggle pill in orders list header:
"Покажи под-cost" → toggles `?below_cost_only=true` query param.

---

## Non-Functional Requirements

- **Performance:** trivial impact (one extra SELECT on edit endpoint to
  load product cost map; one extra INSERT on audit columns).
- **Scale:** no scaling impact; below-cost approvals are a rare event.
- **Security:** ⚠ critical — backend enforcement is mandatory.
  Permission check must run before any mutation. Frontend gating is
  cosmetic only.
- **Reliability:** standard. Audit snapshot is written in the same
  transaction as the order mutation — atomic.
- **Maintenance:** +2 permissions, +1 migration, +2 confirm-dialog
  flows, ~5 modified files. Small surface.

---

## Implementation Plan

(To be generated by `writing-plans` skill in the next step.)

Test strategy summary:

- Unit: `computeBelowCostItems` helper (pure function).
- Backend integration: `POST /orders` with below-cost items rejects
  non-admin; accepts admin with `allow_below_cost: true`; audit columns
  populated.
- Backend integration: `PUT /orders/:id` on fulfilled order rejects
  non-admin; accepts admin.
- E2E: full flow via Playwright — admin login → create order with
  below-cost item → confirm dialog → save → verify badge in list.
