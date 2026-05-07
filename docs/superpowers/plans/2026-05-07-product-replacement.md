# Product Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a "Замяна" (product exchange) workflow on razpiska orders — a new order with `is_replacement = true` containing both "given" and "returning" lines on a signed total, with one PDF document, a list filter, and a daily-report section.

**Architecture:** Replacement is a single order row with `is_replacement = true`. Each `order_items` row has `is_returning` flipping its sign in totals and stock movements. Original orders/razpiski are never modified. Cash differences land in `payments` with `is_refund` indicating the direction.

**Tech Stack:** PostgreSQL 16, Fastify 4 + TypeScript, vitest, React 18 + Vite + Tailwind v4, pdf-lib for PDFs.

**Spec:** `docs/superpowers/specs/2026-05-07-product-replacement-design.md`

---

## File Structure

**New files:**

- `warehouse-backend/migrations/077_orders_replacement.sql`
- `warehouse-backend/migrations/078_payments_is_refund.sql`
- `warehouse-backend/src/__tests__/replacement-create.test.ts`
- `warehouse-backend/src/__tests__/replacement-fulfill.test.ts`
- `warehouse-backend/src/__tests__/replacement-payment.test.ts`
- `warehouse-backend/src/__tests__/replacement-filter.test.ts`
- `warehouse-backend/src/__tests__/replacement-cancel.test.ts`
- `warehouse-backend/src/__tests__/replacement-pdf.test.ts`
- `warehouse-backend/src/services/razpiska-replacement-pdf.ts`
- `warehouse-frontend/src/components/orders/ReplacementForm.tsx`
- `warehouse-frontend/src/components/orders/ReplacementDetail.tsx`

**Files modified:**

- `warehouse-backend/src/lib/permissions.ts` — add `REPLACEMENT_CREATE`
- `warehouse-backend/src/routes/orders.ts` — POST /orders body schema, total calc, fulfill bidirectional stock, GET filter, cancel mirror payment, PDF dispatch
- `warehouse-backend/src/routes/notifications.ts` — new notification type `replacement_ready_for_packaging` (if not auto-handled)
- `warehouse-frontend/src/types/orders.ts` (or equivalent) — add fields
- `warehouse-frontend/src/pages/Orders.tsx` — toggle button, list filter pill, row red label, integrate ReplacementForm/Detail
- `warehouse-frontend/src/pages/Dashboard.tsx` or daily-report screen — new "Замени" section
- `warehouse-frontend/src/components/partners/PartnerOrderHistory.tsx` (or equivalent) — replacement label
- `warehouse-frontend/src/lib/i18n/bg.json` (or wherever translations live) — replacement strings

---

## Task 1: DB migration 077 — orders.is_replacement + order_items.is_returning

**Files:**

- Create: `warehouse-backend/migrations/077_orders_replacement.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- 077_orders_replacement.sql
-- Adds the "Замяна" (product exchange) feature.
-- See docs/superpowers/specs/2026-05-07-product-replacement-design.md

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS is_replacement BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_orders_replacement
  ON orders(is_replacement)
  WHERE is_replacement = true;

COMMENT ON COLUMN orders.is_replacement IS
  'Marks an order as a product-exchange order. Such orders contain both given (is_returning=false) and returned (is_returning=true) line items; their total is the signed difference.';

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS is_returning BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN order_items.is_returning IS
  'When true, this line is a returning item in a replacement order — quantity goes back to stock and amount is subtracted from the order total. Only allowed on orders with is_replacement=true (enforced by backend validation).';
```

- [ ] **Step 2: Run the migration**

Run: `cd warehouse-backend && npm run migrate`
Expected: migration `077_orders_replacement.sql` applied; no errors.

- [ ] **Step 3: Verify schema**

Run:

```bash
docker exec -i mertm-postgres psql -U mertm -d mertm -c "\d orders" | grep is_replacement
docker exec -i mertm-postgres psql -U mertm -d mertm -c "\d order_items" | grep is_returning
```

Expected: both columns appear with `boolean` and `default false`.

- [ ] **Step 4: Commit**

```bash
git add warehouse-backend/migrations/077_orders_replacement.sql
git commit -m "feat(db): add is_replacement and is_returning for product exchange (migration 077)"
```

---

## Task 2: DB migration 078 — payments.is_refund

**Files:**

- Create: `warehouse-backend/migrations/078_payments_is_refund.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- 078_payments_is_refund.sql
-- Adds is_refund flag to payments. Used by replacement orders when
-- the difference is in the customer's favour (we return money). amount
-- stays positive; is_refund=true means cash flows OUT of the till.
-- See docs/superpowers/specs/2026-05-07-product-replacement-design.md

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS is_refund BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN payments.is_refund IS
  'When true, this payment represents money RETURNED to the customer (cash out). Used for negative-difference replacements and cancel-mirror entries.';
```

- [ ] **Step 2: Run the migration**

Run: `cd warehouse-backend && npm run migrate`
Expected: applied without error.

- [ ] **Step 3: Verify schema**

Run:

```bash
docker exec -i mertm-postgres psql -U mertm -d mertm -c "\d payments" | grep is_refund
```

Expected: column appears.

- [ ] **Step 4: Commit**

```bash
git add warehouse-backend/migrations/078_payments_is_refund.sql
git commit -m "feat(db): add payments.is_refund for replacement refunds (migration 078)"
```

---

## Task 3: Add REPLACEMENT_CREATE permission

**Files:**

- Modify: `warehouse-backend/src/lib/permissions.ts`

- [ ] **Step 1: Add the new permission constant**

In `PERMISSIONS` object, after `RAZPISKA_MANAGE`, add:

```ts
REPLACEMENT_CREATE: "replacement.create",
```

- [ ] **Step 2: Grant it to admin (automatic via Object.values), accountant, warehouse, sales**

In `ROLE_DEFAULTS`, append `PERMISSIONS.REPLACEMENT_CREATE` to:

- `accountant` (after `RAZPISKA_MANAGE`)
- `warehouse` (after `RAZPISKA_MANAGE`)
- `sales` (after `RAZPISKA_MANAGE`)

(`admin` already gets it via `Object.values(PERMISSIONS)`.)

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd warehouse-backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add warehouse-backend/src/lib/permissions.ts
git commit -m "feat(perms): add REPLACEMENT_CREATE for product exchange"
```

---

## Task 4: Backend POST /orders — accept replacement payload, validate, persist

**Files:**

- Test: `warehouse-backend/src/__tests__/replacement-create.test.ts`
- Modify: `warehouse-backend/src/routes/orders.ts` (POST /orders handler near line 841)

- [ ] **Step 1: Write failing tests**

Create `warehouse-backend/src/__tests__/replacement-create.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "../index";
import type { FastifyInstance } from "fastify";
import {
  resetDb,
  seedRazpiskaPartner,
  seedVatPartner,
  seedProduct,
  authHeaders,
} from "./test-helpers";

describe("POST /orders — replacement", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it("creates a replacement order with one give + one return line", async () => {
    const partner = await seedRazpiskaPartner();
    const giveProduct = await seedProduct({ price: 230 });
    const returnProduct = await seedProduct({ price: 200 });

    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: authHeaders("warehouse"),
      payload: {
        partner_id: partner.id,
        is_replacement: true,
        items: [
          {
            product_id: giveProduct.id,
            quantity: 1,
            unit_price: 230,
            is_returning: false,
          },
          {
            product_id: returnProduct.id,
            quantity: 1,
            unit_price: 200,
            is_returning: true,
          },
        ],
        payment_method: "cash",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.is_replacement).toBe(true);
    expect(body.items).toHaveLength(2);
    expect(body.items.find((i: any) => i.is_returning)).toBeTruthy();
    expect(body.total_amount).toBe(30); // 230 - 200
  });

  it("rejects replacement with no give line", async () => {
    const partner = await seedRazpiskaPartner();
    const product = await seedProduct({ price: 100 });

    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: authHeaders("warehouse"),
      payload: {
        partner_id: partner.id,
        is_replacement: true,
        items: [
          {
            product_id: product.id,
            quantity: 1,
            unit_price: 100,
            is_returning: true,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/поне един артикул/i);
  });

  it("rejects replacement with no return line", async () => {
    const partner = await seedRazpiskaPartner();
    const product = await seedProduct({ price: 100 });

    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: authHeaders("warehouse"),
      payload: {
        partner_id: partner.id,
        is_replacement: true,
        items: [
          {
            product_id: product.id,
            quantity: 1,
            unit_price: 100,
            is_returning: false,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects is_returning=true on a non-replacement order", async () => {
    const partner = await seedRazpiskaPartner();
    const product = await seedProduct({ price: 100 });

    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: authHeaders("warehouse"),
      payload: {
        partner_id: partner.id,
        is_replacement: false,
        items: [
          {
            product_id: product.id,
            quantity: 1,
            unit_price: 100,
            is_returning: true,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects replacement for a VAT-registered partner", async () => {
    const partner = await seedVatPartner();
    const giveProduct = await seedProduct({ price: 230 });
    const returnProduct = await seedProduct({ price: 200 });

    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: authHeaders("warehouse"),
      payload: {
        partner_id: partner.id,
        is_replacement: true,
        items: [
          {
            product_id: giveProduct.id,
            quantity: 1,
            unit_price: 230,
            is_returning: false,
          },
          {
            product_id: returnProduct.id,
            quantity: 1,
            unit_price: 200,
            is_returning: true,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/ДДС/);
  });
});
```

If `test-helpers.ts` doesn't already provide `seedRazpiskaPartner`, `seedVatPartner`, `seedProduct`, `resetDb`, `authHeaders`, look at `incoming-confirm-inventory.test.ts` for the existing helper pattern and add the missing ones to a shared helpers file. **Do not invent new helpers — copy the pattern of the existing tests.**

- [ ] **Step 2: Run the failing tests**

Run: `cd warehouse-backend && npx vitest run src/__tests__/replacement-create.test.ts`
Expected: 5 failing tests (route doesn't accept the new fields yet, validation absent).

- [ ] **Step 3: Add Zod schema for the new fields**

In `warehouse-backend/src/routes/orders.ts` near the existing POST /orders body schema (look for the `Body` zod schema for the POST handler, around line 841-870):

Add to the body schema:

```ts
is_replacement: z.boolean().optional().default(false),
```

Add to the per-item schema:

```ts
is_returning: z.boolean().optional().default(false),
```

- [ ] **Step 4: Add validation logic in the POST /orders handler**

After zod parsing, before order creation (still inside the handler):

```ts
// Replacement validation — see spec section 4.1
if (parsed.is_replacement) {
  const hasGive = parsed.items.some((it) => !it.is_returning);
  const hasReturn = parsed.items.some((it) => it.is_returning);
  if (!hasGive) {
    return reply.code(400).send({
      error:
        "Замяната трябва да съдържа поне един артикул, който се дава на клиента.",
    });
  }
  if (!hasReturn) {
    return reply.code(400).send({
      error:
        "Замяната трябва да съдържа поне един артикул, който се връща от клиента.",
    });
  }
  // Razpiska-eligible partner check (no VAT registration). Adapt the
  // exact column / function name to the partners schema in the
  // codebase — look at how existing razpiska routes filter partners.
  const partnerRes = await pool.query(
    "SELECT vat_registered, partner_type FROM partners WHERE id=$1",
    [parsed.partner_id],
  );
  const p = partnerRes.rows[0];
  if (!p) return reply.code(404).send({ error: "Партньорът не е намерен." });
  const isRazpiskaEligible =
    p.partner_type === "individual" || p.vat_registered === false;
  if (!isRazpiskaEligible) {
    return reply.code(400).send({
      error: "Замяна за ДДС-фактуриран клиент още не е поддържана.",
    });
  }
} else {
  // Defensive: reject is_returning on non-replacement orders
  if (parsed.items.some((it) => it.is_returning)) {
    return reply.code(400).send({
      error: "Поле is_returning е разрешено само в поръчки от тип замяна.",
    });
  }
}
```

(If actual partner column names differ, adapt — verify with `\d partners` in psql before writing the query.)

- [ ] **Step 5: Persist new fields**

In the INSERT for `orders`, add `is_replacement` to the column list and `$N` value. In the INSERT for `order_items`, add `is_returning` to the column list and value. Match the pattern used by existing INSERTs (parameterized).

- [ ] **Step 6: Run the tests, expect pass**

Run: `cd warehouse-backend && npx vitest run src/__tests__/replacement-create.test.ts`
Expected: 5/5 passing.

- [ ] **Step 7: Run full BE test suite, no regressions**

Run: `cd warehouse-backend && npx vitest run`
Expected: all previously-passing tests still pass; same 6 pre-existing failures from STATUS.md baseline are acceptable.

- [ ] **Step 8: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts warehouse-backend/src/__tests__/replacement-create.test.ts
git commit -m "feat(orders): accept and validate replacement-order payload"
```

---

## Task 5: Backend total calculation with signed sum

**Files:**

- Test: `warehouse-backend/src/__tests__/replacement-create.test.ts` (extend with total tests)
- Modify: `warehouse-backend/src/routes/orders.ts`

The `total_amount` for orders is currently computed somewhere — find the existing pattern (search for `total_amount` and `SUM`). If it's done via DB trigger, modify the trigger; if it's computed in JS before INSERT, modify that block; if it's computed in a SELECT for GET, modify the SELECT.

- [ ] **Step 1: Add tests for signed totals**

Append to `replacement-create.test.ts`:

```ts
it("computes positive total when give > return", async () => {
  const partner = await seedRazpiskaPartner();
  const give = await seedProduct({ price: 230 });
  const ret = await seedProduct({ price: 200 });
  const res = await app.inject({
    method: "POST",
    url: "/orders",
    headers: authHeaders("warehouse"),
    payload: {
      partner_id: partner.id,
      is_replacement: true,
      items: [
        {
          product_id: give.id,
          quantity: 1,
          unit_price: 230,
          is_returning: false,
        },
        {
          product_id: ret.id,
          quantity: 1,
          unit_price: 200,
          is_returning: true,
        },
      ],
      payment_method: "cash",
    },
  });
  expect(res.json().total_amount).toBe(30);
});

it("computes negative total when return > give", async () => {
  const partner = await seedRazpiskaPartner();
  const give = await seedProduct({ price: 150 });
  const ret = await seedProduct({ price: 200 });
  const res = await app.inject({
    method: "POST",
    url: "/orders",
    headers: authHeaders("warehouse"),
    payload: {
      partner_id: partner.id,
      is_replacement: true,
      items: [
        {
          product_id: give.id,
          quantity: 1,
          unit_price: 150,
          is_returning: false,
        },
        {
          product_id: ret.id,
          quantity: 1,
          unit_price: 200,
          is_returning: true,
        },
      ],
      payment_method: "cash",
    },
  });
  expect(res.json().total_amount).toBe(-50);
});

it("computes zero total when give == return", async () => {
  const partner = await seedRazpiskaPartner();
  const a = await seedProduct({ price: 200 });
  const b = await seedProduct({ price: 200 });
  const res = await app.inject({
    method: "POST",
    url: "/orders",
    headers: authHeaders("warehouse"),
    payload: {
      partner_id: partner.id,
      is_replacement: true,
      items: [
        { product_id: a.id, quantity: 1, unit_price: 200, is_returning: false },
        { product_id: b.id, quantity: 1, unit_price: 200, is_returning: true },
      ],
    },
  });
  expect(res.json().total_amount).toBe(0);
});

it("handles multi-item totals on both sides", async () => {
  const partner = await seedRazpiskaPartner();
  const a = await seedProduct({ price: 100 });
  const b = await seedProduct({ price: 50 });
  const res = await app.inject({
    method: "POST",
    url: "/orders",
    headers: authHeaders("warehouse"),
    payload: {
      partner_id: partner.id,
      is_replacement: true,
      items: [
        { product_id: a.id, quantity: 2, unit_price: 100, is_returning: false }, // +200
        { product_id: b.id, quantity: 3, unit_price: 50, is_returning: true }, // -150
      ],
      payment_method: "cash",
    },
  });
  expect(res.json().total_amount).toBe(50);
});
```

- [ ] **Step 2: Run the tests, expect them to fail**

Run: `cd warehouse-backend && npx vitest run src/__tests__/replacement-create.test.ts`
Expected: 4 new tests fail (totals will be wrong because returning lines are summed positive).

- [ ] **Step 3: Update the total calculation**

Find where `total_amount` is computed (grep `total_amount` in `routes/orders.ts`). Adjust to:

```ts
const total = items.reduce(
  (sum, it) => sum + it.quantity * it.unit_price * (it.is_returning ? -1 : 1),
  0,
);
```

If totals are computed via SQL (e.g. in a SELECT for GET), update the expression:

```sql
SUM(quantity * unit_price * CASE WHEN is_returning THEN -1 ELSE 1 END) AS total_amount
```

Adjust both create-time computation and any read-time aggregation.

- [ ] **Step 4: Run tests, expect pass**

Run: `cd warehouse-backend && npx vitest run src/__tests__/replacement-create.test.ts`
Expected: all 9 tests pass.

- [ ] **Step 5: Run full suite, no regressions**

Run: `cd warehouse-backend && npx vitest run`
Expected: no new failures.

- [ ] **Step 6: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts warehouse-backend/src/__tests__/replacement-create.test.ts
git commit -m "feat(orders): signed totals for replacement orders"
```

---

## Task 6: Backend fulfill — bidirectional stock movements

**Files:**

- Test: `warehouse-backend/src/__tests__/replacement-fulfill.test.ts`
- Modify: `warehouse-backend/src/routes/orders.ts` (POST /orders/:id/fulfill near line 1932; `deductProductStock` at line 2625)

- [ ] **Step 1: Write failing tests**

Create `warehouse-backend/src/__tests__/replacement-fulfill.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "../index";
import type { FastifyInstance } from "fastify";
import {
  resetDb,
  seedRazpiskaPartner,
  seedProduct,
  authHeaders,
  getStock,
} from "./test-helpers";

describe("Replacement fulfill — bidirectional stock", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it("decreases stock for give lines and increases for return lines", async () => {
    const partner = await seedRazpiskaPartner();
    const give = await seedProduct({ price: 230, stock: 5 });
    const ret = await seedProduct({ price: 200, stock: 1 });

    const create = await app.inject({
      method: "POST",
      url: "/orders",
      headers: authHeaders("warehouse"),
      payload: {
        partner_id: partner.id,
        is_replacement: true,
        items: [
          {
            product_id: give.id,
            quantity: 1,
            unit_price: 230,
            is_returning: false,
          },
          {
            product_id: ret.id,
            quantity: 1,
            unit_price: 200,
            is_returning: true,
          },
        ],
        payment_method: "cash",
      },
    });
    const orderId = create.json().id;

    const fulfill = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/fulfill`,
      headers: authHeaders("warehouse"),
    });
    expect(fulfill.statusCode).toBe(200);

    expect(await getStock(give.id)).toBe(4); // 5 - 1
    expect(await getStock(ret.id)).toBe(2); // 1 + 1
  });

  it("handles the same SKU in both sides (warranty case)", async () => {
    const partner = await seedRazpiskaPartner();
    const product = await seedProduct({ price: 200, stock: 3 });

    const create = await app.inject({
      method: "POST",
      url: "/orders",
      headers: authHeaders("warehouse"),
      payload: {
        partner_id: partner.id,
        is_replacement: true,
        items: [
          {
            product_id: product.id,
            quantity: 1,
            unit_price: 200,
            is_returning: false,
          },
          {
            product_id: product.id,
            quantity: 1,
            unit_price: 200,
            is_returning: true,
          },
        ],
      },
    });
    const orderId = create.json().id;
    await app.inject({
      method: "POST",
      url: `/orders/${orderId}/fulfill`,
      headers: authHeaders("warehouse"),
    });

    expect(await getStock(product.id)).toBe(3); // -1 +1 = 0 net
  });
});
```

- [ ] **Step 2: Run tests, expect fail**

Run: `cd warehouse-backend && npx vitest run src/__tests__/replacement-fulfill.test.ts`
Expected: failures (stock decreases on every line currently, including return lines).

- [ ] **Step 3: Update fulfill logic**

In the fulfill handler (line ~1932 in `routes/orders.ts`), find the loop calling `deductProductStock` for each item. Replace with:

```ts
for (const item of items) {
  if (item.is_returning) {
    // Replacement return — add stock back, no COGS update
    await pool.query(
      "UPDATE product_stocks SET quantity = quantity + $1 WHERE product_id = $2",
      [item.quantity, item.product_id],
    );
  } else {
    const costUnitPrice =
      await deductProductStock();
      /* existing args */
    // existing COGS snapshot logic...
  }
}
```

Match the actual existing call shape — read lines 1932-2040 to see the surrounding code. Keep all existing behaviour for non-replacement orders. (`deductProductStock` is at line 2625.)

- [ ] **Step 4: Run tests, expect pass**

Run: `cd warehouse-backend && npx vitest run src/__tests__/replacement-fulfill.test.ts`
Expected: 2/2 passing.

- [ ] **Step 5: Run full suite**

Run: `cd warehouse-backend && npx vitest run`
Expected: no new regressions.

- [ ] **Step 6: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts warehouse-backend/src/__tests__/replacement-fulfill.test.ts
git commit -m "feat(orders): bidirectional stock movements for replacement fulfill"
```

---

## Task 7: Backend payment recording with is_refund

**Files:**

- Test: `warehouse-backend/src/__tests__/replacement-payment.test.ts`
- Modify: `warehouse-backend/src/routes/orders.ts` (in or near the create-order handler, after order is persisted)

The replacement create call should automatically record the difference payment when `payment_method` is supplied. Existing razpiska orders may already have a "create with payment" pattern — check before duplicating.

- [ ] **Step 1: Write failing tests**

Create `warehouse-backend/src/__tests__/replacement-payment.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "../index";
import type { FastifyInstance } from "fastify";
import {
  resetDb,
  seedRazpiskaPartner,
  seedProduct,
  authHeaders,
  getPaymentsForOrder,
} from "./test-helpers";

describe("Replacement — payment recording", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it("records is_refund=false payment when total > 0", async () => {
    const partner = await seedRazpiskaPartner();
    const a = await seedProduct({ price: 230 });
    const b = await seedProduct({ price: 200 });
    const create = await app.inject({
      method: "POST",
      url: "/orders",
      headers: authHeaders("warehouse"),
      payload: {
        partner_id: partner.id,
        is_replacement: true,
        items: [
          {
            product_id: a.id,
            quantity: 1,
            unit_price: 230,
            is_returning: false,
          },
          {
            product_id: b.id,
            quantity: 1,
            unit_price: 200,
            is_returning: true,
          },
        ],
        payment_method: "cash",
      },
    });
    const payments = await getPaymentsForOrder(create.json().id);
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe(30);
    expect(payments[0].is_refund).toBe(false);
    expect(payments[0].method).toBe("cash");
  });

  it("records is_refund=true payment when total < 0", async () => {
    const partner = await seedRazpiskaPartner();
    const a = await seedProduct({ price: 150 });
    const b = await seedProduct({ price: 200 });
    const create = await app.inject({
      method: "POST",
      url: "/orders",
      headers: authHeaders("warehouse"),
      payload: {
        partner_id: partner.id,
        is_replacement: true,
        items: [
          {
            product_id: a.id,
            quantity: 1,
            unit_price: 150,
            is_returning: false,
          },
          {
            product_id: b.id,
            quantity: 1,
            unit_price: 200,
            is_returning: true,
          },
        ],
        payment_method: "cash",
      },
    });
    const payments = await getPaymentsForOrder(create.json().id);
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe(50);
    expect(payments[0].is_refund).toBe(true);
  });

  it("records no payment when total == 0", async () => {
    const partner = await seedRazpiskaPartner();
    const a = await seedProduct({ price: 200 });
    const b = await seedProduct({ price: 200 });
    const create = await app.inject({
      method: "POST",
      url: "/orders",
      headers: authHeaders("warehouse"),
      payload: {
        partner_id: partner.id,
        is_replacement: true,
        items: [
          {
            product_id: a.id,
            quantity: 1,
            unit_price: 200,
            is_returning: false,
          },
          {
            product_id: b.id,
            quantity: 1,
            unit_price: 200,
            is_returning: true,
          },
        ],
      },
    });
    const payments = await getPaymentsForOrder(create.json().id);
    expect(payments).toHaveLength(0);
  });
});
```

`getPaymentsForOrder` is a helper that queries `payments WHERE order_id = $1 ORDER BY id`.

- [ ] **Step 2: Run tests, expect fail**

Run: `cd warehouse-backend && npx vitest run src/__tests__/replacement-payment.test.ts`
Expected: 3 failures.

- [ ] **Step 3: Add payment-on-create logic**

In the POST /orders handler, after the order INSERT and order_items INSERTs are done (still inside the same DB transaction), add for replacement orders:

```ts
if (parsed.is_replacement && parsed.payment_method && total !== 0) {
  await pool.query(
    `INSERT INTO payments (order_id, amount, method, is_refund, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [orderId, Math.abs(total), parsed.payment_method, total < 0],
  );
}
```

Adapt column names to match the existing `payments` table.

- [ ] **Step 4: Run tests, expect pass**

Run: `cd warehouse-backend && npx vitest run src/__tests__/replacement-payment.test.ts`
Expected: 3/3 pass.

- [ ] **Step 5: Run full suite**

Run: `cd warehouse-backend && npx vitest run`
Expected: no regressions.

- [ ] **Step 6: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts warehouse-backend/src/__tests__/replacement-payment.test.ts
git commit -m "feat(orders): auto-record signed difference payment on replacement create"
```

---

## Task 8: Backend GET /orders ?is_replacement filter

**Files:**

- Test: `warehouse-backend/src/__tests__/replacement-filter.test.ts`
- Modify: `warehouse-backend/src/routes/orders.ts` (GET /orders handler)

- [ ] **Step 1: Write failing tests**

Create `warehouse-backend/src/__tests__/replacement-filter.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "../index";
import type { FastifyInstance } from "fastify";
import {
  resetDb,
  seedRazpiskaPartner,
  seedProduct,
  authHeaders,
  createReplacementOrder,
  createNormalOrder,
} from "./test-helpers";

describe("GET /orders — is_replacement filter", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it("returns only replacement orders when is_replacement=true", async () => {
    const partner = await seedRazpiskaPartner();
    await createNormalOrder(partner.id);
    await createReplacementOrder(partner.id);
    const res = await app.inject({
      method: "GET",
      url: "/orders?is_replacement=true",
      headers: authHeaders("warehouse"),
    });
    const list = res.json().orders ?? res.json();
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((o: any) => o.is_replacement === true)).toBe(true);
  });

  it("excludes replacements when is_replacement=false", async () => {
    const partner = await seedRazpiskaPartner();
    await createNormalOrder(partner.id);
    await createReplacementOrder(partner.id);
    const res = await app.inject({
      method: "GET",
      url: "/orders?is_replacement=false",
      headers: authHeaders("warehouse"),
    });
    const list = res.json().orders ?? res.json();
    expect(list.every((o: any) => o.is_replacement === false)).toBe(true);
  });

  it("returns all orders when no filter is given", async () => {
    const partner = await seedRazpiskaPartner();
    await createNormalOrder(partner.id);
    await createReplacementOrder(partner.id);
    const res = await app.inject({
      method: "GET",
      url: "/orders",
      headers: authHeaders("warehouse"),
    });
    const list = res.json().orders ?? res.json();
    expect(list.some((o: any) => o.is_replacement)).toBe(true);
    expect(list.some((o: any) => !o.is_replacement)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests, expect fail**

Run: `cd warehouse-backend && npx vitest run src/__tests__/replacement-filter.test.ts`
Expected: 3 failures.

- [ ] **Step 3: Add filter to GET /orders handler**

Find the GET /orders handler (search for `// GET /orders` in `routes/orders.ts`). Extend the query schema with:

```ts
is_replacement: z.enum(["true", "false"]).optional(),
```

Translate it to a WHERE clause where the rest of the filters are assembled:

```ts
if (q.is_replacement !== undefined) {
  whereClauses.push(`o.is_replacement = $${paramIdx++}`);
  values.push(q.is_replacement === "true");
}
```

Also include `o.is_replacement` in the SELECT projection so the frontend gets the flag back.

- [ ] **Step 4: Run tests, expect pass**

Run: `cd warehouse-backend && npx vitest run src/__tests__/replacement-filter.test.ts`
Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts warehouse-backend/src/__tests__/replacement-filter.test.ts
git commit -m "feat(orders): is_replacement query filter on GET /orders"
```

---

## Task 9: Backend cancel — mirror payment + reverse stock

**Files:**

- Test: `warehouse-backend/src/__tests__/replacement-cancel.test.ts`
- Modify: `warehouse-backend/src/routes/orders.ts` (DELETE /orders/:id handler — search for `// DELETE /orders/:id`)

- [ ] **Step 1: Write failing tests**

Create `warehouse-backend/src/__tests__/replacement-cancel.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "../index";
import type { FastifyInstance } from "fastify";
import {
  resetDb,
  seedRazpiskaPartner,
  seedProduct,
  authHeaders,
  getStock,
  getPaymentsForOrder,
} from "./test-helpers";

describe("Replacement cancel", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it("reverses stock movements and writes mirror payment (positive total case)", async () => {
    const partner = await seedRazpiskaPartner();
    const give = await seedProduct({ price: 230, stock: 5 });
    const ret = await seedProduct({ price: 200, stock: 1 });
    const create = await app.inject({
      method: "POST",
      url: "/orders",
      headers: authHeaders("warehouse"),
      payload: {
        partner_id: partner.id,
        is_replacement: true,
        items: [
          {
            product_id: give.id,
            quantity: 1,
            unit_price: 230,
            is_returning: false,
          },
          {
            product_id: ret.id,
            quantity: 1,
            unit_price: 200,
            is_returning: true,
          },
        ],
        payment_method: "cash",
      },
    });
    const orderId = create.json().id;
    await app.inject({
      method: "POST",
      url: `/orders/${orderId}/fulfill`,
      headers: authHeaders("warehouse"),
    });
    expect(await getStock(give.id)).toBe(4);
    expect(await getStock(ret.id)).toBe(2);

    const cancel = await app.inject({
      method: "DELETE",
      url: `/orders/${orderId}`,
      headers: authHeaders("admin"),
    });
    expect(cancel.statusCode).toBe(200);

    expect(await getStock(give.id)).toBe(5);
    expect(await getStock(ret.id)).toBe(1);

    const payments = await getPaymentsForOrder(orderId);
    expect(payments).toHaveLength(2);
    expect(payments[0].amount).toBe(30);
    expect(payments[0].is_refund).toBe(false);
    expect(payments[1].amount).toBe(30);
    expect(payments[1].is_refund).toBe(true);
  });

  it("reverses stock and mirrors refund (negative total case)", async () => {
    const partner = await seedRazpiskaPartner();
    const give = await seedProduct({ price: 150, stock: 5 });
    const ret = await seedProduct({ price: 200, stock: 1 });
    const create = await app.inject({
      method: "POST",
      url: "/orders",
      headers: authHeaders("warehouse"),
      payload: {
        partner_id: partner.id,
        is_replacement: true,
        items: [
          {
            product_id: give.id,
            quantity: 1,
            unit_price: 150,
            is_returning: false,
          },
          {
            product_id: ret.id,
            quantity: 1,
            unit_price: 200,
            is_returning: true,
          },
        ],
        payment_method: "cash",
      },
    });
    const orderId = create.json().id;
    await app.inject({
      method: "POST",
      url: `/orders/${orderId}/fulfill`,
      headers: authHeaders("warehouse"),
    });
    await app.inject({
      method: "DELETE",
      url: `/orders/${orderId}`,
      headers: authHeaders("admin"),
    });

    const payments = await getPaymentsForOrder(orderId);
    expect(payments).toHaveLength(2);
    expect(payments[0].is_refund).toBe(true); // original refund
    expect(payments[1].is_refund).toBe(false); // mirror — money flows back IN
  });
});
```

- [ ] **Step 2: Run tests, expect fail**

Run: `cd warehouse-backend && npx vitest run src/__tests__/replacement-cancel.test.ts`
Expected: failures (cancel logic doesn't know about returning lines or mirror payments).

- [ ] **Step 3: Update DELETE /orders/:id handler**

Find the DELETE handler. Add a branch for replacement orders that:

1. Reverses stock for both directions:
   - For `is_returning=false` items → +qty back to stock (existing fulfilled-cancel pattern)
   - For `is_returning=true` items → −qty (because we'd added them on fulfill)
2. Inserts a mirror payment for any payment row of this order:

```ts
if (order.is_replacement && order.fulfilled_at) {
  for (const item of items) {
    const sign = item.is_returning ? -1 : +1; // reverse fulfill direction
    await pool.query(
      "UPDATE product_stocks SET quantity = quantity + $1 WHERE product_id = $2",
      [item.quantity * sign, item.product_id],
    );
  }
}

if (order.is_replacement) {
  const orig = await pool.query(
    "SELECT amount, method, is_refund FROM payments WHERE order_id = $1 ORDER BY id ASC LIMIT 1",
    [orderId],
  );
  if (orig.rows[0]) {
    const p = orig.rows[0];
    await pool.query(
      `INSERT INTO payments (order_id, amount, method, is_refund, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [orderId, p.amount, p.method, !p.is_refund],
    );
  }
}
```

The non-replacement cancel branch keeps its existing logic untouched.

- [ ] **Step 4: Run tests, expect pass**

Run: `cd warehouse-backend && npx vitest run src/__tests__/replacement-cancel.test.ts`
Expected: 2/2 pass.

- [ ] **Step 5: Run full suite**

Run: `cd warehouse-backend && npx vitest run`

- [ ] **Step 6: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts warehouse-backend/src/__tests__/replacement-cancel.test.ts
git commit -m "feat(orders): cancel replacement reverses stock and mirrors payment"
```

---

## Task 10: Backend PDF — "Стокова разписка за Замяна"

**Files:**

- Create: `warehouse-backend/src/services/razpiska-replacement-pdf.ts`
- Test: `warehouse-backend/src/__tests__/replacement-pdf.test.ts`
- Modify: `warehouse-backend/src/routes/orders.ts` (the PDF endpoint, search for `/document/pdf` or `/invoice` routes)

- [ ] **Step 1: Read existing razpiska PDF generator**

Look at the existing razpiska PDF code (search for "Стокова разписка" — `document-pdf.test.ts` references it). Identify the function/module that builds the razpiska PDF — that's the pattern to mirror.

- [ ] **Step 2: Write failing snapshot tests**

Create `warehouse-backend/src/__tests__/replacement-pdf.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderReplacementPdf } from "../services/razpiska-replacement-pdf";

const sampleOrder = {
  id: 241,
  number: "25-000241",
  date: new Date("2026-05-07T10:00:00Z"),
  partner: { name: "Иван Петров", egn_or_eik: null, address: null },
  items: [
    {
      product_name: "Hendi фритюрник 226001",
      product_code: "H226001",
      quantity: 1,
      unit_price: 230,
      is_returning: false,
    },
    {
      product_name: "Hendi фритюрник 226000",
      product_code: "H226000",
      quantity: 1,
      unit_price: 200,
      is_returning: true,
    },
  ],
  total: 30,
  payment_method: "cash" as const,
};

describe("Replacement PDF", () => {
  it("renders a non-empty PDF for positive diff", async () => {
    const buf = await renderReplacementPdf(sampleOrder);
    expect(buf.byteLength).toBeGreaterThan(2000);
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("renders for negative diff", async () => {
    const buf = await renderReplacementPdf({ ...sampleOrder, total: -50 });
    expect(buf.byteLength).toBeGreaterThan(2000);
  });

  it("renders for zero diff", async () => {
    const buf = await renderReplacementPdf({
      ...sampleOrder,
      total: 0,
      payment_method: undefined,
    });
    expect(buf.byteLength).toBeGreaterThan(2000);
  });
});
```

- [ ] **Step 3: Run tests, expect fail (module not found)**

Run: `cd warehouse-backend && npx vitest run src/__tests__/replacement-pdf.test.ts`
Expected: import error.

- [ ] **Step 4: Implement the renderer**

Create `warehouse-backend/src/services/razpiska-replacement-pdf.ts`:

```ts
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import * as fs from "fs";
import * as path from "path";

export type ReplacementPdfOrder = {
  id: number;
  number: string;
  date: Date;
  partner: { name: string; egn_or_eik: string | null; address: string | null };
  items: Array<{
    product_name: string;
    product_code: string;
    quantity: number;
    unit_price: number;
    is_returning: boolean;
  }>;
  total: number;
  payment_method?: "cash" | "pos" | "bank_transfer";
};

const RED = rgb(0.78, 0.05, 0.05);
const GREEN = rgb(0.0, 0.5, 0.1);
const BLACK = rgb(0, 0, 0);
const GRAY = rgb(0.4, 0.4, 0.4);

export async function renderReplacementPdf(
  order: ReplacementPdfOrder,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  // Use the same Cyrillic-capable font already shipped under src/fonts.
  // Match the path used by the existing razpiska PDF generator.
  const fontPath = path.join(__dirname, "..", "fonts", "DejaVuSans.ttf");
  const fontBytes = fs.readFileSync(fontPath);
  const font = await doc.embedFont(fontBytes);
  const fontBoldBytes = fs.readFileSync(
    path.join(__dirname, "..", "fonts", "DejaVuSans-Bold.ttf"),
  );
  const bold = await doc.embedFont(fontBoldBytes);

  const page = doc.addPage([595, 842]); // A4
  let y = 800;

  page.drawText("СТОКОВА РАЗПИСКА ЗА ЗАМЯНА №" + order.number, {
    x: 50,
    y,
    size: 16,
    font: bold,
    color: RED,
  });
  y -= 30;

  // Red stamp top-right
  page.drawRectangle({
    x: 470,
    y: 770,
    width: 80,
    height: 30,
    borderColor: RED,
    borderWidth: 2,
  });
  page.drawText("ЗАМЯНА", { x: 487, y: 780, size: 12, font: bold, color: RED });

  page.drawText(`Дата: ${order.date.toISOString().slice(0, 10)}`, {
    x: 50,
    y,
    size: 10,
    font,
    color: BLACK,
  });
  y -= 16;
  page.drawText(`Клиент: ${order.partner.name}`, {
    x: 50,
    y,
    size: 11,
    font,
    color: BLACK,
  });
  y -= 20;

  // Section 1 — Взема се
  page.drawText("ВЗЕМА СЕ", { x: 50, y, size: 12, font: bold, color: GREEN });
  y -= 16;
  const giveItems = order.items.filter((i) => !i.is_returning);
  let giveSum = 0;
  for (const it of giveItems) {
    const lineSum = it.quantity * it.unit_price;
    giveSum += lineSum;
    page.drawText(
      `${it.product_name} (${it.product_code})  ${it.quantity}бр × ${it.unit_price.toFixed(2)} = ${lineSum.toFixed(2)} лв`,
      { x: 60, y, size: 10, font, color: BLACK },
    );
    y -= 14;
  }
  page.drawText(`Сума: ${giveSum.toFixed(2)} лв`, {
    x: 60,
    y,
    size: 11,
    font: bold,
    color: BLACK,
  });
  y -= 24;

  // Section 2 — Връща се
  page.drawText("ВРЪЩА СЕ", { x: 50, y, size: 12, font: bold, color: RED });
  y -= 16;
  const returnItems = order.items.filter((i) => i.is_returning);
  let retSum = 0;
  for (const it of returnItems) {
    const lineSum = it.quantity * it.unit_price;
    retSum += lineSum;
    page.drawText(
      `${it.product_name} (${it.product_code})  ${it.quantity}бр × ${it.unit_price.toFixed(2)} = ${lineSum.toFixed(2)} лв`,
      { x: 60, y, size: 10, font, color: BLACK },
    );
    y -= 14;
  }
  page.drawText(`Сума: ${retSum.toFixed(2)} лв`, {
    x: 60,
    y,
    size: 11,
    font: bold,
    color: BLACK,
  });
  y -= 30;

  // Difference + payment
  const diffLabel =
    order.total > 0
      ? `Разлика за плащане: +${order.total.toFixed(2)} лв`
      : order.total < 0
        ? `За връщане на клиента: ${Math.abs(order.total).toFixed(2)} лв`
        : "Размяна без доплащане (равна)";
  page.drawText(diffLabel, { x: 50, y, size: 12, font: bold, color: BLACK });
  y -= 18;

  if (order.total !== 0 && order.payment_method) {
    const methodBg: Record<string, string> = {
      cash: "брой",
      pos: "POS",
      bank_transfer: "банков превод",
    };
    const verb = order.total > 0 ? "Платено в" : "Възстановено в";
    page.drawText(
      `${verb} ${methodBg[order.payment_method]}: ${Math.abs(order.total).toFixed(2)} лв`,
      {
        x: 50,
        y,
        size: 10,
        font,
        color: BLACK,
      },
    );
    y -= 24;
  }

  // Descriptive text
  const giveLine = giveItems
    .map(
      (i) =>
        `${i.quantity} бр. ${i.product_name} на стойност ${(i.quantity * i.unit_price).toFixed(2)} лв`,
    )
    .join("; ");
  const retLine = returnItems
    .map(
      (i) =>
        `${i.quantity} бр. ${i.product_name} на стойност ${(i.quantity * i.unit_price).toFixed(2)} лв`,
    )
    .join("; ");
  const sentence =
    order.total > 0
      ? `Със настоящата стокова разписка клиентът взема: ${giveLine}. Клиентът връща: ${retLine}. Разликата от ${order.total.toFixed(2)} лв е заплатена от клиента.`
      : order.total < 0
        ? `Със настоящата стокова разписка клиентът взема: ${giveLine}. Клиентът връща: ${retLine}. Разликата от ${Math.abs(order.total).toFixed(2)} лв е възстановена на клиента.`
        : `Със настоящата стокова разписка клиентът взема: ${giveLine}. Клиентът връща: ${retLine}. Размяната е равностойностна — без доплащане.`;
  // naive wrap
  const wrap = (s: string, max: number) => {
    const words = s.split(" ");
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      if ((cur + " " + w).length > max) {
        lines.push(cur);
        cur = w;
      } else {
        cur = cur ? cur + " " + w : w;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  };
  for (const line of wrap(sentence, 95)) {
    page.drawText(line, { x: 50, y, size: 9, font, color: GRAY });
    y -= 12;
  }
  y -= 24;

  // Signatures
  page.drawText(
    "Предал: ____________________      Приел: ____________________",
    {
      x: 50,
      y,
      size: 10,
      font,
      color: BLACK,
    },
  );

  return Buffer.from(await doc.save());
}
```

- [ ] **Step 5: Run tests, expect pass**

Run: `cd warehouse-backend && npx vitest run src/__tests__/replacement-pdf.test.ts`
Expected: 3/3 pass.

- [ ] **Step 6: Wire into the document endpoint**

Find the existing `GET /orders/:id/document/pdf` (or whatever the razpiska download endpoint is — check `routes/orders.ts` for `/pdf` and `/invoice` patterns; razpiska download path may be elsewhere). Add:

```ts
if (order.is_replacement) {
  const buf = await renderReplacementPdf(orderForPdf);
  reply.type("application/pdf").send(buf);
  return;
}
// existing razpiska / invoice rendering ...
```

Make sure the order data passed to `renderReplacementPdf` matches the type — JOIN partners and order_items as needed.

- [ ] **Step 7: Run full suite**

Run: `cd warehouse-backend && npx vitest run`

- [ ] **Step 8: Commit**

```bash
git add warehouse-backend/src/services/razpiska-replacement-pdf.ts warehouse-backend/src/__tests__/replacement-pdf.test.ts warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): replacement PDF (Стокова разписка за Замяна)"
```

---

## Task 11: Backend notification — replacement_ready_for_packaging

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts` (the create handler — emit notification on replacement create)

- [ ] **Step 1: Inspect existing notification emit pattern**

Find where normal razpiska orders emit "ready for packaging" notifications (`grep -n notification warehouse-backend/src/routes/orders.ts`). Match its shape.

- [ ] **Step 2: Add the emit for replacement orders**

After the replacement order is created and committed, before sending the response, insert:

```ts
if (parsed.is_replacement) {
  await pool.query(
    `INSERT INTO notifications (type, payload, created_at)
     VALUES ($1, $2::jsonb, NOW())`,
    [
      "replacement_ready_for_packaging",
      JSON.stringify({ order_id: orderId, is_replacement: true }),
    ],
  );
}
```

(Match column names with the actual `notifications` schema; the spec for that table is in `2026-04-29-batch-i-notifications-ux-upgrade-design.md`.)

- [ ] **Step 3: Manual smoke (no separate test file)**

Create one replacement order via curl or HTTP client, then `SELECT * FROM notifications WHERE type='replacement_ready_for_packaging' LIMIT 5` — confirm the row exists.

- [ ] **Step 4: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): emit replacement_ready_for_packaging notification on create"
```

---

## Task 12: Frontend types and API typing

**Files:**

- Modify: the orders type file (search `warehouse-frontend/src/types/` and `warehouse-frontend/src/lib/api/`)

- [ ] **Step 1: Add fields to the Order TypeScript type**

Add `is_replacement: boolean` to the `Order` type. Add `is_returning: boolean` to the `OrderItem` type. Match the casing used by the rest of the type.

- [ ] **Step 2: Add the create-payload type**

If there is a `CreateOrderInput` (or similar) type, add the same fields plus `payment_method?: "cash" | "pos" | "bank_transfer"` (if not already present). The frontend will pass these to POST /orders.

- [ ] **Step 3: TypeScript compile**

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add warehouse-frontend/src/types
git commit -m "types(frontend): add is_replacement and is_returning fields"
```

---

## Task 13: Frontend ReplacementForm component

**Files:**

- Create: `warehouse-frontend/src/components/orders/ReplacementForm.tsx`

This component is mounted inside the existing "New Order" form when the user toggles the "Замяна" mode. It renders two item-pickers (Взема се / Връща се), live-computes the diff, and exposes the payload via a callback.

- [ ] **Step 1: Skeleton with two sections**

Create the file:

```tsx
import { useMemo, useState } from "react";
import type { Product } from "@/types/products";

type LineItem = {
  product_id: number;
  product_name: string;
  product_code: string;
  quantity: number;
  unit_price: number;
};

export type ReplacementFormState = {
  giveItems: LineItem[];
  returnItems: LineItem[];
  paymentMethod: "cash" | "pos" | "bank_transfer";
};

export type ReplacementFormProps = {
  onChange: (s: ReplacementFormState) => void;
  productLookup: () => Promise<Product[]>; // or pre-fetched list
};

export function ReplacementForm({
  onChange,
  productLookup,
}: ReplacementFormProps) {
  const [give, setGive] = useState<LineItem[]>([]);
  const [ret, setRet] = useState<LineItem[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<
    "cash" | "pos" | "bank_transfer"
  >("cash");

  const giveSum = useMemo(
    () => give.reduce((s, i) => s + i.quantity * i.unit_price, 0),
    [give],
  );
  const retSum = useMemo(
    () => ret.reduce((s, i) => s + i.quantity * i.unit_price, 0),
    [ret],
  );
  const diff = giveSum - retSum;

  // Notify parent on every change
  useMemo(
    () => onChange({ giveItems: give, returnItems: ret, paymentMethod }),
    [give, ret, paymentMethod],
  );

  return (
    <div className="space-y-4">
      <Section
        title="Взема се"
        accent="green"
        items={give}
        onChange={setGive}
      />
      <Section title="Връща се" accent="red" items={ret} onChange={setRet} />

      <DiffBanner diff={diff} />

      {diff !== 0 && (
        <PaymentMethodPicker
          value={paymentMethod}
          onChange={setPaymentMethod}
        />
      )}
    </div>
  );
}

function DiffBanner({ diff }: { diff: number }) {
  if (diff > 0)
    return (
      <div className="bg-green-50 text-green-900 p-3 rounded">
        +{diff.toFixed(2)} лв (клиент доплаща)
      </div>
    );
  if (diff < 0)
    return (
      <div className="bg-red-50 text-red-900 p-3 rounded font-bold">
        {diff.toFixed(2)} лв (връщаме на клиент)
      </div>
    );
  return (
    <div className="bg-gray-100 text-gray-700 p-3 rounded">
      0 лв (равно — без плащане)
    </div>
  );
}

function Section({
  title,
  accent,
  items,
  onChange,
}: {
  title: string;
  accent: "green" | "red";
  items: LineItem[];
  onChange: (it: LineItem[]) => void;
}) {
  const border =
    accent === "green"
      ? "border-l-4 border-green-500"
      : "border-l-4 border-red-500";
  return (
    <div className={`p-3 ${border}`}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-bold">{title}</h3>
        <button
          onClick={() =>
            onChange([
              ...items,
              {
                product_id: 0,
                product_name: "",
                product_code: "",
                quantity: 1,
                unit_price: 0,
              },
            ])
          }
        >
          + Добави артикул
        </button>
      </div>
      {items.map((it, idx) => (
        <ItemRow
          key={idx}
          item={it}
          onChange={(next) => {
            const copy = [...items];
            copy[idx] = next;
            onChange(copy);
          }}
          onRemove={() => onChange(items.filter((_, i) => i !== idx))}
        />
      ))}
    </div>
  );
}

function ItemRow({
  item,
  onChange,
  onRemove,
}: {
  item: LineItem;
  onChange: (i: LineItem) => void;
  onRemove: () => void;
}) {
  return (
    <div className="grid grid-cols-12 gap-2 items-center mb-1">
      {/* TODO: hook up the existing product autocomplete used by the rest of Orders.tsx */}
      <input
        className="col-span-5"
        value={item.product_name}
        onChange={(e) => onChange({ ...item, product_name: e.target.value })}
        placeholder="Артикул"
      />
      <input
        className="col-span-2"
        value={item.product_code}
        onChange={(e) => onChange({ ...item, product_code: e.target.value })}
        placeholder="Код"
      />
      <input
        className="col-span-1"
        type="number"
        value={item.quantity}
        onChange={(e) =>
          onChange({ ...item, quantity: Number(e.target.value) || 0 })
        }
      />
      <input
        className="col-span-2"
        type="number"
        step="0.01"
        value={item.unit_price}
        onChange={(e) =>
          onChange({ ...item, unit_price: Number(e.target.value) || 0 })
        }
        placeholder="Цена"
      />
      <span className="col-span-1">
        {(item.quantity * item.unit_price).toFixed(2)}
      </span>
      <button className="col-span-1" onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

function PaymentMethodPicker({
  value,
  onChange,
}: {
  value: "cash" | "pos" | "bank_transfer";
  onChange: (v: "cash" | "pos" | "bank_transfer") => void;
}) {
  return (
    <div className="flex gap-3">
      {(["cash", "pos", "bank_transfer"] as const).map((m) => (
        <label key={m} className="flex items-center gap-1">
          <input
            type="radio"
            checked={value === m}
            onChange={() => onChange(m)}
          />
          {m === "cash" ? "Брой" : m === "pos" ? "POS" : "Превод"}
        </label>
      ))}
    </div>
  );
}
```

The "TODO: hook up the existing product autocomplete" line needs to be replaced before submit — the rest of `Orders.tsx` already contains a product picker. Open `Orders.tsx`, find the existing item-row component (likely named `OrderItemRow` or similar), and replace the `<input ... placeholder="Артикул" />` here with that component, passing it the same props it expects elsewhere.

- [ ] **Step 2: Verify it compiles**

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add warehouse-frontend/src/components/orders/ReplacementForm.tsx
git commit -m "feat(frontend): ReplacementForm component (toggle + two sections + diff banner)"
```

---

## Task 14: Frontend — wire the toggle into the New Order form

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx`

- [ ] **Step 1: Locate the New Order form**

Open `warehouse-frontend/src/pages/Orders.tsx`. Search for `// New order` / `New Order` / `Нова поръчка` — find the section that renders the new-order form. It's likely a modal or a side drawer.

- [ ] **Step 2: Add the toggle state**

At the top of that form component:

```tsx
const [isReplacement, setIsReplacement] = useState(false);
const [replacementState, setReplacementState] =
  useState<ReplacementFormState | null>(null);
```

- [ ] **Step 3: Add the toggle button at the top of the form**

```tsx
<div className="flex items-center justify-between mb-4">
  <h2 className={isReplacement ? "text-red-600 font-bold" : ""}>
    {isReplacement ? "🔄 НОВА ЗАМЯНА" : "Нова поръчка"}
  </h2>
  <button
    type="button"
    disabled={selectedPartner?.vat_registered}
    title={
      selectedPartner?.vat_registered
        ? "Замяна за ДДС-фактуриран клиент ще бъде добавена в следваща итерация."
        : ""
    }
    className={`px-3 py-1 rounded ${isReplacement ? "bg-red-600 text-white" : "bg-gray-200"}`}
    onClick={() => setIsReplacement((v) => !v)}
  >
    🔄 Замяна
  </button>
</div>
```

(Adapt `selectedPartner.vat_registered` to whatever field actually exists on the partner — verify against the type or the existing partner-form. If the existing flag is `partner_type === 'individual'` instead, use that.)

- [ ] **Step 4: Conditionally render the form body**

```tsx
{isReplacement
  ? <ReplacementForm onChange={setReplacementState} productLookup={...} />
  : <ExistingOrderForm ... />
}
```

- [ ] **Step 5: Update submit handler**

When the user submits, build the payload:

```tsx
const payload = isReplacement
  ? {
      partner_id: selectedPartner.id,
      is_replacement: true,
      items: [
        ...replacementState!.giveItems.map((i) => ({
          ...i,
          is_returning: false,
        })),
        ...replacementState!.returnItems.map((i) => ({
          ...i,
          is_returning: true,
        })),
      ],
      payment_method: replacementState!.paymentMethod,
    }
  : {
      /* existing order payload */
    };

await api.post("/orders", payload);
```

- [ ] **Step 6: Manual smoke test**

Run: `./scripts/start-mertm.sh` (if not running)
Open the warehouse frontend at `http://localhost:5174`, log in as `admin@mertm.bg / admin123`, open "Нова поръчка", toggle "🔄 Замяна". Verify:

- Title turns red and shows "🔄 НОВА ЗАМЯНА"
- Two sections appear with green/red borders
- Diff banner updates as you add items
- For VAT-registered partner the toggle is disabled with the tooltip

- [ ] **Step 7: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(frontend): toggle 'Замяна' inside New Order form"
```

---

## Task 15: Frontend orders list — filter pill + red row label

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx`

- [ ] **Step 1: Add filter pill state**

Find where existing pill filters live (`has_paid_not_taken`, `has_awaiting` from STATUS.md). Add a parallel `is_replacement` filter:

```tsx
const [filterReplacement, setFilterReplacement] = useState<
  "all" | "only" | "exclude"
>("all");
```

In the orders fetch query (likely React Query), include:

```tsx
queryParams: {
  ...,
  ...(filterReplacement === "only" ? { is_replacement: "true" } : {}),
  ...(filterReplacement === "exclude" ? { is_replacement: "false" } : {}),
}
```

- [ ] **Step 2: Render the pill**

Next to the existing pills, add:

```tsx
<button
  className={
    filterReplacement === "only"
      ? "pill pill-active bg-red-100 text-red-700"
      : "pill"
  }
  onClick={() =>
    setFilterReplacement(filterReplacement === "only" ? "all" : "only")
  }
>
  🔄 Замени
</button>
```

(Match the existing pill button styles.)

- [ ] **Step 3: Mark replacement rows red**

In the row rendering (table row or list item):

```tsx
<tr className={order.is_replacement ? "text-red-700" : ""}>
  <td>{order.is_replacement ? "🔄 ЗАМЯНА" : "Поръчка"}</td>
  <td>{/* partner */}</td>
  <td>
    {order.is_replacement && order.total_amount > 0
      ? `+${order.total_amount.toFixed(2)} лв`
      : order.is_replacement && order.total_amount < 0
        ? `${order.total_amount.toFixed(2)} лв`
        : `${order.total_amount.toFixed(2)} лв`}
  </td>
  ...
</tr>
```

- [ ] **Step 4: Manual smoke**

Reload the orders page. Click "🔄 Замени" — list should narrow to replacement rows only, all in red.

- [ ] **Step 5: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(frontend): replacement filter pill and red row label on orders list"
```

---

## Task 16: Frontend — order detail view for replacements

**Files:**

- Create: `warehouse-frontend/src/components/orders/ReplacementDetail.tsx`
- Modify: `warehouse-frontend/src/pages/Orders.tsx` (the order-detail rendering branch)

- [ ] **Step 1: Build the detail component**

Create `warehouse-frontend/src/components/orders/ReplacementDetail.tsx`:

```tsx
import type { Order } from "@/types/orders";

export function ReplacementDetail({
  order,
  onCancel,
  onPrint,
  onSendToPacking,
}: {
  order: Order;
  onCancel: () => void;
  onPrint: () => void;
  onSendToPacking: () => void;
}) {
  const give = order.items.filter((i) => !i.is_returning);
  const ret = order.items.filter((i) => i.is_returning);
  const giveSum = give.reduce((s, i) => s + i.quantity * i.unit_price, 0);
  const retSum = ret.reduce((s, i) => s + i.quantity * i.unit_price, 0);
  const diff = giveSum - retSum;

  return (
    <div>
      <h2 className="text-red-600 font-bold text-xl">🔄 ЗАМЯНА #{order.id}</h2>

      <Section title="Взема се" accent="green" items={give} sum={giveSum} />
      <Section title="Връща се" accent="red" items={ret} sum={retSum} />

      <div className="mt-4 p-3 border rounded">
        Разлика:{" "}
        <strong>
          {diff > 0 ? "+" : ""}
          {diff.toFixed(2)} лв
        </strong>
        {order.payment_method ? ` | Метод: ${order.payment_method}` : ""}
      </div>

      <div className="flex gap-2 mt-4">
        <button onClick={onPrint}>Печат Стокова разписка за Замяна</button>
        <button onClick={onSendToPacking}>Към склад пакетиране</button>
        <button className="text-red-600" onClick={onCancel}>
          Анулирай замяна
        </button>
      </div>
    </div>
  );
}

function Section({
  title,
  accent,
  items,
  sum,
}: {
  title: string;
  accent: "green" | "red";
  items: Order["items"];
  sum: number;
}) {
  const color = accent === "green" ? "text-green-700" : "text-red-700";
  return (
    <div className="mt-3">
      <h3 className={`font-bold ${color}`}>{title}</h3>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th>Артикул</th>
            <th>Кол.</th>
            <th>Ед. цена</th>
            <th>Сума</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id}>
              <td>{it.product_name}</td>
              <td>{it.quantity}</td>
              <td>{it.unit_price.toFixed(2)}</td>
              <td>{(it.quantity * it.unit_price).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-right">
        Сума: <strong>{sum.toFixed(2)} лв</strong>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire into Orders.tsx detail rendering**

In `Orders.tsx`, find where the order-detail is rendered (modal or right pane). Branch:

```tsx
{order.is_replacement
  ? <ReplacementDetail order={order} onCancel={...} onPrint={...} onSendToPacking={...} />
  : <ExistingOrderDetail order={order} ... />}
```

- [ ] **Step 3: Cancel confirmation dialog**

Wrap `onCancel` in:

```tsx
const onCancel = () => {
  if (
    confirm(
      "Това ще върне склада в първоначалното състояние и ще анулира платената разлика. Сигурни ли сте?",
    )
  ) {
    cancelMutation.mutate(order.id);
  }
};
```

- [ ] **Step 4: Manual smoke**

Click into a replacement order from the list. Verify red title, two sections, footer, three buttons. Click "Печат" — PDF opens. Click "Анулирай" — confirm dialog appears.

- [ ] **Step 5: Commit**

```bash
git add warehouse-frontend/src/components/orders/ReplacementDetail.tsx warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(frontend): replacement order detail view"
```

---

## Task 17: Frontend partner history — replacement label

**Files:**

- Modify: the partner order history component (search `PartnerOrderHistory` in `warehouse-frontend/src/components/`)

- [ ] **Step 1: Find the row renderer**

Open the partner order history drawer/component. Find the `<tr>` or list-item that renders one order.

- [ ] **Step 2: Add replacement label**

```tsx
<span
  className={
    order.is_replacement
      ? "inline-block px-2 py-0.5 rounded bg-red-100 text-red-700 text-xs font-bold"
      : ""
  }
>
  {order.is_replacement ? "🔄 Замяна" : "Поръчка"}
</span>
```

Apply same red text class to the row when `is_replacement`.

- [ ] **Step 3: Manual smoke**

Open a partner that has a replacement order. Verify the entry shows the red "🔄 Замяна" label.

- [ ] **Step 4: Commit**

```bash
git add warehouse-frontend/src/components
git commit -m "feat(frontend): replacement label in partner order history"
```

---

## Task 18: Frontend daily report — "Замени" section

**Files:**

- Modify: the daily-report component (likely `Dashboard.tsx` or a `DailyReport.tsx`; existing spec is `2026-04-30-daily-report-design.md`)

- [ ] **Step 1: Locate daily report sections**

Search the frontend for "Дневен отчет" or `daily-report` to find the rendering point.

- [ ] **Step 2: Add the "Замени" section**

Between "Поръчки" and "Анулирани" (or whatever the section order is):

```tsx
<section>
  <h3 className="font-bold text-red-600">🔄 Замени ({replacements.length})</h3>
  <ul>
    {replacements.map((r) => (
      <li key={r.id} className="flex justify-between">
        <span>
          #{r.id} — {r.partner_name}
        </span>
        <span>
          {r.total_amount > 0 ? "+" : ""}
          {r.total_amount.toFixed(2)} лв
        </span>
        <span>{r.payment_method ?? "—"}</span>
      </li>
    ))}
  </ul>
  <div className="mt-2 font-bold">
    Брой замени: {replacements.length}
    {" | "}
    Нетна разлика: {netDiff > 0 ? "+" : ""}
    {netDiff.toFixed(2)} лв
  </div>
</section>
```

`replacements` comes from filtering the existing daily-report data by `is_replacement === true`. `netDiff` = sum of `total_amount` for those rows.

- [ ] **Step 3: Backend daily-report endpoint update (if needed)**

If the daily-report endpoint already returns all orders with `is_replacement` field, no backend change needed — frontend just filters. If it returns a flattened summary, extend it: search the backend for the daily-report route and ensure `is_replacement` is included.

- [ ] **Step 4: Manual smoke**

Generate a replacement order with a positive diff and one with negative. Open daily report — confirm "🔄 Замени" section appears with both rows and the net diff is correct.

- [ ] **Step 5: Commit**

```bash
git add warehouse-frontend/src
git commit -m "feat(frontend): 'Замени' section in daily report with net diff"
```

---

## Task 19: i18n / Bulgarian strings

**Files:**

- Modify: the existing translation file (search for `"order.*"` keys in the frontend)

- [ ] **Step 1: Locate i18n file**

Run: `grep -rn '"order\.' warehouse-frontend/src/lib | head -5`
Find the main bg.json or similar.

- [ ] **Step 2: Add the strings**

```json
{
  "order.replacement.label": "Замяна",
  "order.replacement.giving": "Взема се",
  "order.replacement.returning": "Връща се",
  "order.replacement.difference_positive": "Клиент доплаща",
  "order.replacement.difference_negative": "Връщаме на клиент",
  "order.replacement.difference_zero": "Равно — без плащане",
  "order.replacement.button": "🔄 Замяна",
  "order.replacement.finalize": "Финализирай замяна",
  "order.replacement.cancel": "Анулирай замяна",
  "order.replacement.cancel_confirm": "Това ще върне склада в първоначалното състояние и ще анулира платената разлика. Сигурни ли сте?",
  "order.replacement.disabled_for_invoiced": "Замяна за ДДС-фактуриран клиент ще бъде добавена в следваща итерация."
}
```

- [ ] **Step 3: Replace the hardcoded strings in the components written in Tasks 13-18 with `t("order.replacement.*")`**

(If the project uses i18next, this is `useTranslation`. If they use a custom hook, mirror the pattern.)

- [ ] **Step 4: Commit**

```bash
git add warehouse-frontend/src
git commit -m "i18n(frontend): replacement strings"
```

---

## Task 20: Manual E2E checklist

**Files:**

- None (validation pass)

- [ ] **Step 1: Bring up the local stack**

Run: `cd /Users/magic/Projects/mert-m && ./scripts/start-mertm.sh`
Confirm: backend on :3004, frontend on :5174.

- [ ] **Step 2: Walk through each spec scenario**

Log in as `admin@mertm.bg / admin123`. Execute these scenarios in order, ticking each only after observing the expected outcome:

- [ ] **(a)** Замяна с positive diff — клиент доплаща в брой → check stock changed correctly, payment row recorded, PDF prints with green "Взема се" + red "Връща се" sections
- [ ] **(b)** Замяна с negative diff (новият по-евтин) — POS reverse → PDF reads "За връщане на клиента"; payments row has `is_refund=true`
- [ ] **(c)** Замяна с zero diff → no payment row written; PDF reads "равностойностна"
- [ ] **(d)** Cancel of (a) → both stock movements reversed; second mirror payment row inserted with flipped is_refund
- [ ] **(e)** Same SKU on both sides (warranty) → стокът остава непроменен (−1 +1)
- [ ] **(f)** Replacement-of-replacement — създай замяна на вече заменен артикул → системата позволява, всичко работи
- [ ] **(g)** Toggle "Замяна" e disabled при ДДС-регистриран партньор; tooltip се показва
- [ ] **(h)** Filter pill "Замени" в /orders филтрира коректно
- [ ] **(i)** Партньорска история показва "🔄 Замяна" label на правилния ред
- [ ] **(j)** Дневен отчет включва "🔄 Замени" секцията с правилен net diff

- [ ] **Step 3: Update STATUS.md**

Append to `STATUS.md` a "Replacement feature — COMPLETE" entry mirroring the format of previous Batch entries (migration numbers, test counts, deferred items, manual verification status).

- [ ] **Step 4: Final commit**

```bash
git add STATUS.md
git commit -m "docs(status): replacement feature complete (manual E2E pending sign-off)"
```

---

## Self-Review Notes (verified before marking plan complete)

**Spec coverage:**

- ✅ Spec §3 (DB) → Tasks 1, 2
- ✅ Spec §4.1 (validation) → Task 4
- ✅ Spec §4.2 (fulfill) → Task 6
- ✅ Spec §4.3 (payment) → Task 7
- ✅ Spec §4.4 (cancel) → Task 9
- ✅ Spec §4.5 (filter) → Task 8
- ✅ Spec §4.6 (PDF) → Task 10
- ✅ Spec §4.7 (notification) → Task 11
- ✅ Spec §5 (frontend) → Tasks 12-18
- ✅ Spec §6 (PDF doc) → Task 10
- ✅ Spec §7 (permissions) → Task 3
- ✅ Spec §8 (edge cases) → Tasks 4, 6, 9 + manual E2E in Task 20
- ✅ Spec §9 (tests) → all backend tasks include vitest tests
- ✅ Spec §10 (migrations) → Tasks 1, 2 (renumbered to 077/078)
- ✅ Spec §11 (open questions) — preserved as out-of-scope; the plan does not implement invoice replacements, original-order linking, warranty protocol, or return-only

**Type consistency:** `is_replacement` and `is_returning` used consistently throughout. `payments.is_refund` used consistently. PDF type `ReplacementPdfOrder` defined and used in Task 10.

**No placeholders:** Each step has either runnable commands, complete code, or precise instructions ("find X", "match pattern Y in file Z"). Two TODO-shaped notes intentionally left for the implementer to wire to project-specific bits (`product autocomplete in Task 13` and `i18n hook in Task 19 step 3`) — these can't be precisely templated without inspecting how Orders.tsx already does them, so the engineer has to read and copy the existing pattern.

**Scope check:** This is a single coherent feature. ~20 tasks, all interlock around the same data model. Implementable in one sitting per batch (BE batch 1-11, FE batch 12-19, validation 20).
