# Заявки Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat `Заявки` page with a two-layer model — lightweight `Бележки` (no ZA number, supplier-grouped colored cards) that get converted into formal `Заявки` (ZA-XXXXX). Adds period/status/search filters and capped note cards.

**Architecture:** One table (`purchase_orders`) discriminated by `status`. New `'note'` status + `label` + `merged_from_count` columns added via additive migration. Existing `merge` endpoint generalised to convert 1+ notes into a single draft order. Frontend rewritten with a toolbar (period + status pills + search), a notes board grouped by supplier with capped cards, and the existing заявки table at the bottom.

**Tech Stack:** PostgreSQL 16 (additive migration), Fastify + Zod (backend), React + Vite + Tailwind v4 + react-query (frontend), Vitest (tests).

**Spec:** [docs/superpowers/specs/2026-05-05-purchase-orders-redesign-design.md](../specs/2026-05-05-purchase-orders-redesign-design.md)

---

## File map

**Create:**

- `warehouse-backend/migrations/072_purchase_order_notes.sql`
- `warehouse-frontend/src/lib/supplier-colors.ts`
- `warehouse-frontend/src/components/purchase-orders/NoteCard.tsx`
- `warehouse-frontend/src/components/purchase-orders/PurchaseOrdersToolbar.tsx`

**Modify:**

- `warehouse-backend/src/routes/purchase-orders.ts`
- `warehouse-backend/src/services/purchase-order-pdf.ts`
- `warehouse-backend/src/__tests__/purchase-orders.test.ts`
- `warehouse-frontend/src/pages/PurchaseOrders.tsx` (large rewrite — extract NoteCard + Toolbar)

---

## Task 1: Migration — add `note` status + `label` + `merged_from_count`

**Files:**

- Create: `warehouse-backend/migrations/072_purchase_order_notes.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 072_purchase_order_notes.sql
-- Adds the "note" layer: lightweight pre-purchase-order entries that get
-- merged into a real PO via /merge.

ALTER TABLE purchase_orders
  DROP CONSTRAINT purchase_orders_status_check;

ALTER TABLE purchase_orders
  ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN ('note', 'draft', 'sent', 'received'));

-- Optional free-text label for notes (e.g., "Кухня в Хемус").
ALTER TABLE purchase_orders
  ADD COLUMN label TEXT;

-- How many notes were folded into this entry (0 for direct drafts/notes,
-- ≥1 for orders produced by /merge). Pure UI metadata — no logic depends
-- on it.
ALTER TABLE purchase_orders
  ADD COLUMN merged_from_count INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Apply migration to dev DB and verify**

Run: `cd warehouse-backend && npm run migrate`
Expected: migration 072 applied, no errors.

Run: `psql -h localhost -p 5433 -U mertm -d mertm_warehouse -c "\d purchase_orders"`
Expected: `label` and `merged_from_count` columns visible; status check shows 4 values.

- [ ] **Step 3: Commit**

```bash
git add warehouse-backend/migrations/072_purchase_order_notes.sql
git commit -m "feat(db): add note status + label + merged_from_count to purchase_orders

Additive migration for the Бележки → Заявки redesign. Existing rows
keep their status; new column defaults are NULL/0 so legacy drafts
remain unchanged."
```

---

## Task 2: Backend — extend `GET /purchase-orders` with period filter

**Files:**

- Modify: `warehouse-backend/src/routes/purchase-orders.ts`
- Test: `warehouse-backend/src/__tests__/purchase-orders.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the `describe("Purchase Orders — CRUD", …)` block:

```ts
it("GET /?period=this-week filters by created_at >= start of week", async () => {
  mockQuery.mockResolvedValueOnce(rows([]));
  const res = await app.inject({
    method: "GET",
    url: "/purchase-orders?period=this-week",
  });
  expect(res.statusCode).toBe(200);
  const sql = mockQuery.mock.calls[0][0] as string;
  expect(sql).toMatch(/created_at\s*>=\s*\$\d/);
});

it("GET /?period=today applies a tighter created_at filter", async () => {
  mockQuery.mockResolvedValueOnce(rows([]));
  await app.inject({
    method: "GET",
    url: "/purchase-orders?period=today",
  });
  const params = mockQuery.mock.calls[0][1] as unknown[];
  // Today's 00:00:00 should be the bound — params include a Date or ISO string.
  expect(params.length).toBeGreaterThan(0);
});

it("GET /?period=all applies no created_at filter", async () => {
  mockQuery.mockResolvedValueOnce(rows([]));
  await app.inject({
    method: "GET",
    url: "/purchase-orders?period=all",
  });
  const sql = mockQuery.mock.calls[0][0] as string;
  expect(sql).not.toMatch(/created_at\s*>=/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd warehouse-backend && npx vitest run src/__tests__/purchase-orders.test.ts -t "period"`
Expected: FAIL — period filter not implemented.

- [ ] **Step 3: Implement period filter**

In `warehouse-backend/src/routes/purchase-orders.ts` inside the `app.get("/", …)` handler, replace the body of `where` construction with:

```ts
const { status, supplier_id, period, search } = request.query as {
  status?: string;
  supplier_id?: string;
  period?: "today" | "this-week" | "this-month" | "all";
  search?: string;
};
const where: string[] = [];
const params: unknown[] = [];
if (status) {
  params.push(status);
  where.push(`po.status = $${params.length}`);
}
if (supplier_id) {
  params.push(Number(supplier_id));
  where.push(`po.supplier_id = $${params.length}`);
}
if (period && period !== "all") {
  const cutoff = computePeriodCutoff(period);
  params.push(cutoff);
  where.push(`po.created_at >= $${params.length}`);
}
```

Add helper at the top of the file (above `formatNumber`):

```ts
function computePeriodCutoff(
  period: "today" | "this-week" | "this-month",
): Date {
  const now = new Date();
  if (period === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (period === "this-week") {
    const d = new Date(now);
    const dayOfWeek = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - dayOfWeek);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  // this-month
  return new Date(now.getFullYear(), now.getMonth(), 1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd warehouse-backend && npx vitest run src/__tests__/purchase-orders.test.ts -t "period"`
Expected: PASS for all 3 period tests.

Run the whole file once: `npx vitest run src/__tests__/purchase-orders.test.ts`
Expected: all existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add warehouse-backend/src/routes/purchase-orders.ts \
        warehouse-backend/src/__tests__/purchase-orders.test.ts
git commit -m "feat(api): add ?period filter to GET /purchase-orders

Supports today | this-week | this-month | all. Uses created_at >= cutoff."
```

---

## Task 3: Backend — extend `GET /purchase-orders` with search

**Files:**

- Modify: `warehouse-backend/src/routes/purchase-orders.ts`
- Test: `warehouse-backend/src/__tests__/purchase-orders.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("GET /?search=hendi adds ILIKE on supplier name + product name + sku", async () => {
  mockQuery.mockResolvedValueOnce(rows([]));
  await app.inject({
    method: "GET",
    url: "/purchase-orders?search=hendi",
  });
  const sql = mockQuery.mock.calls[0][0] as string;
  expect(sql).toMatch(/ILIKE/);
  // Search should match supplier name OR an item product
  expect(sql).toMatch(/s\.name\s+ILIKE/);
  expect(sql).toMatch(/EXISTS/); // subquery on items
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd warehouse-backend && npx vitest run src/__tests__/purchase-orders.test.ts -t "search"`
Expected: FAIL.

- [ ] **Step 3: Implement search**

Inside the same `GET /` handler, after the period filter:

```ts
if (search && search.trim().length > 0) {
  const term = `%${search.trim()}%`;
  params.push(term);
  const idx = params.length;
  where.push(
    `(s.name ILIKE $${idx} OR EXISTS (
        SELECT 1 FROM purchase_order_items poi
        JOIN products p ON p.id = poi.product_id
        WHERE poi.purchase_order_id = po.id
          AND (p.name_bg ILIKE $${idx} OR p.name_en ILIKE $${idx} OR p.sku ILIKE $${idx})
     ))`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd warehouse-backend && npx vitest run src/__tests__/purchase-orders.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add warehouse-backend/src/routes/purchase-orders.ts \
        warehouse-backend/src/__tests__/purchase-orders.test.ts
git commit -m "feat(api): add ?search filter to GET /purchase-orders

Searches supplier name and item product name/SKU using ILIKE."
```

---

## Task 4: Backend — `POST /purchase-orders` defaults to `status='note'`, accepts `label`

**Files:**

- Modify: `warehouse-backend/src/routes/purchase-orders.ts`
- Test: `warehouse-backend/src/__tests__/purchase-orders.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("POST / defaults to status='note' when not provided", async () => {
  mockTransaction.mockImplementationOnce(async (cb: any) => {
    const client = {
      query: vi.fn().mockResolvedValueOnce(rows([{ id: 7 }])),
    };
    return cb(client as any);
  });
  mockQuery
    .mockResolvedValueOnce(
      rows([{ id: 7, status: "note", supplier_name: "S" }]),
    )
    .mockResolvedValueOnce(rows([]));

  const res = await app.inject({
    method: "POST",
    url: "/purchase-orders",
    payload: {
      supplier_id: 2,
      items: [{ product_id: 10, quantity: 5 }],
    },
  });
  expect(res.statusCode).toBe(201);
  // INSERT should pass status='note'
  const insertCall = mockTransaction.mock.calls[0];
  // The transaction was called; we can't easily verify SQL params, but the
  // returned status should reflect what we set:
  expect(res.json().status).toBe("note");
});

it("POST / accepts an explicit status='draft' for backwards compat", async () => {
  mockTransaction.mockImplementationOnce(async (cb: any) => {
    const client = {
      query: vi.fn().mockResolvedValueOnce(rows([{ id: 8 }])),
    };
    return cb(client as any);
  });
  mockQuery
    .mockResolvedValueOnce(
      rows([{ id: 8, status: "draft", supplier_name: "S" }]),
    )
    .mockResolvedValueOnce(rows([]));

  const res = await app.inject({
    method: "POST",
    url: "/purchase-orders",
    payload: {
      supplier_id: 2,
      status: "draft",
      items: [{ product_id: 10, quantity: 5 }],
    },
  });
  expect(res.statusCode).toBe(201);
});

it("POST / accepts a label for notes", async () => {
  mockTransaction.mockImplementationOnce(async (cb: any) => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce(rows([{ id: 9, label: "Кухня в Хемус" }])),
    };
    return cb(client as any);
  });
  mockQuery
    .mockResolvedValueOnce(
      rows([
        { id: 9, status: "note", label: "Кухня в Хемус", supplier_name: "S" },
      ]),
    )
    .mockResolvedValueOnce(rows([]));

  const res = await app.inject({
    method: "POST",
    url: "/purchase-orders",
    payload: {
      supplier_id: 2,
      label: "Кухня в Хемус",
      items: [{ product_id: 10, quantity: 5 }],
    },
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().label).toBe("Кухня в Хемус");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd warehouse-backend && npx vitest run src/__tests__/purchase-orders.test.ts -t "POST /"`
Expected: 3 new tests FAIL.

- [ ] **Step 3: Update create schema and route**

In `warehouse-backend/src/routes/purchase-orders.ts`, replace `createSchema`:

```ts
const createSchema = z.object({
  supplier_id: z.number().int().positive(),
  status: z.enum(["note", "draft"]).optional().default("note"),
  notes: z.string().nullish(),
  label: z.string().max(120).nullish(),
  expected_delivery_date: z.string().nullish(),
  items: z.array(itemSchema).min(1),
});
```

Replace the INSERT in the POST handler:

```ts
const order = await transaction(async (client) => {
  const {
    rows: [created],
  } = await client.query(
    `INSERT INTO purchase_orders
        (supplier_id, status, notes, label, expected_delivery_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      body.supplier_id,
      body.status,
      body.notes ?? null,
      body.label ?? null,
      body.expected_delivery_date ?? null,
      userId,
    ],
  );
  for (const item of body.items) {
    await client.query(
      `INSERT INTO purchase_order_items
          (purchase_order_id, product_id, quantity, notes)
       VALUES ($1, $2, $3, $4)`,
      [created.id, item.product_id, item.quantity, item.notes ?? null],
    );
  }
  return created;
});
```

Also update `loadOrderWithItems` SELECT to include `po.label, po.merged_from_count` (so they reach the API consumer):

In the SELECT for orderRows, change:

```ts
`SELECT po.*, s.name AS supplier_name, …`;
```

This already pulls all columns via `po.*`. No change needed; just verify the API response includes `label` and `merged_from_count`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd warehouse-backend && npx vitest run src/__tests__/purchase-orders.test.ts`
Expected: all PASS, including the existing "POST / creates draft" test (which now needs to either send status='draft' explicitly OR be updated to expect 'note').

If the existing test fails because the default changed: update the existing assertion `expect(body.order_number).toBe("ZA-00007")` — note: still produces a ZA number from the id. Keep the assertion. The test sets `status: "draft"` to keep the original semantics — update the payload to include `status: "draft"`.

- [ ] **Step 5: Commit**

```bash
git add warehouse-backend/src/routes/purchase-orders.ts \
        warehouse-backend/src/__tests__/purchase-orders.test.ts
git commit -m "feat(api): POST /purchase-orders defaults to status=note + supports label

New entries are notes by default. Explicit status='draft' is still
accepted for the legacy direct-draft flow. Optional 'label' free-text
field for organizing notes (e.g. 'Kitchen in Hemus')."
```

---

## Task 5: Backend — extend `PATCH /purchase-orders/:id` to allow editing notes

**Files:**

- Modify: `warehouse-backend/src/routes/purchase-orders.ts`
- Test: `warehouse-backend/src/__tests__/purchase-orders.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("PATCH /:id allows editing a note (status='note')", async () => {
  mockTransaction.mockImplementationOnce(async (cb: any) => {
    const client = {
      query: vi
        .fn()
        // SELECT FOR UPDATE
        .mockResolvedValueOnce(rows([{ id: 5, status: "note" }]))
        // UPDATE purchase_orders
        .mockResolvedValueOnce(rows([]))
        // DELETE items + INSERT items
        .mockResolvedValueOnce(rows([]))
        .mockResolvedValueOnce(rows([])),
    };
    return cb(client as any);
  });
  mockQuery
    .mockResolvedValueOnce(
      rows([{ id: 5, status: "note", supplier_name: "S" }]),
    )
    .mockResolvedValueOnce(rows([]));

  const res = await app.inject({
    method: "PATCH",
    url: "/purchase-orders/5",
    payload: {
      label: "Updated label",
      items: [{ product_id: 10, quantity: 3 }],
    },
  });
  expect(res.statusCode).toBe(200);
});

it("PATCH /:id rejects sent orders (unchanged behavior)", async () => {
  mockTransaction.mockImplementationOnce(async (cb: any) => {
    const client = {
      query: vi.fn().mockResolvedValueOnce(rows([{ id: 5, status: "sent" }])),
    };
    return cb(client as any);
  });
  const res = await app.inject({
    method: "PATCH",
    url: "/purchase-orders/5",
    payload: { label: "x" },
  });
  expect(res.statusCode).toBe(400);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd warehouse-backend && npx vitest run src/__tests__/purchase-orders.test.ts -t "PATCH"`
Expected: first test FAILS (status check forbids 'note'); second PASSES already.

- [ ] **Step 3: Update PATCH route**

In `warehouse-backend/src/routes/purchase-orders.ts`, replace `updateSchema`:

```ts
const updateSchema = z.object({
  supplier_id: z.number().int().positive().optional(),
  notes: z.string().nullish().optional(),
  label: z.string().max(120).nullish().optional(),
  expected_delivery_date: z.string().nullish().optional(),
  items: z.array(itemSchema).optional(),
});
```

In the PATCH handler, change the status check from `!== "draft"` to allow note + draft:

```ts
if (existing.status !== "draft" && existing.status !== "note") {
  throw Object.assign(
    new Error("Само бележки и чернови могат да се редактират"),
    { statusCode: 400 },
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd warehouse-backend && npx vitest run src/__tests__/purchase-orders.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add warehouse-backend/src/routes/purchase-orders.ts \
        warehouse-backend/src/__tests__/purchase-orders.test.ts
git commit -m "feat(api): PATCH /purchase-orders/:id allows editing notes

Notes (status='note') are editable with the same flow as drafts. Also
accepts the new 'label' field."
```

---

## Task 6: Backend — extend `DELETE /purchase-orders/:id` to allow deleting notes

**Files:**

- Modify: `warehouse-backend/src/routes/purchase-orders.ts`
- Test: `warehouse-backend/src/__tests__/purchase-orders.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("DELETE /:id allows note deletion", async () => {
  mockQuery
    .mockResolvedValueOnce(rows([{ status: "note" }]))
    .mockResolvedValueOnce(rows([]));
  const res = await app.inject({
    method: "DELETE",
    url: "/purchase-orders/4",
  });
  expect(res.statusCode).toBe(204);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd warehouse-backend && npx vitest run src/__tests__/purchase-orders.test.ts -t "note deletion"`
Expected: FAIL — current code only allows status='draft'.

- [ ] **Step 3: Update DELETE route**

In `warehouse-backend/src/routes/purchase-orders.ts`:

```ts
if (rows[0].status !== "draft" && rows[0].status !== "note") {
  return reply
    .status(400)
    .send({ error: "Само бележки и чернови могат да бъдат изтрити" });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd warehouse-backend && npx vitest run src/__tests__/purchase-orders.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add warehouse-backend/src/routes/purchase-orders.ts \
        warehouse-backend/src/__tests__/purchase-orders.test.ts
git commit -m "feat(api): DELETE /purchase-orders/:id allows deleting notes"
```

---

## Task 7: Backend — generalise `/merge` to accept 1+ notes and produce a draft order

**Files:**

- Modify: `warehouse-backend/src/routes/purchase-orders.ts`
- Test: `warehouse-backend/src/__tests__/purchase-orders.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("POST /merge accepts a single note and converts it to a draft order", async () => {
  mockTransaction.mockImplementationOnce(async (cb: any) => {
    const client = {
      query: vi
        .fn()
        // SELECT FOR UPDATE — 1 note
        .mockResolvedValueOnce(
          rows([
            {
              id: 7,
              supplier_id: 2,
              status: "note",
              notes: null,
              label: "Кухня",
              expected_delivery_date: null,
              created_at: "2026-05-01T10:00:00Z",
            },
          ]),
        )
        // SELECT items from sources (none — single source is the master)
        .mockResolvedValueOnce(rows([]))
        // SELECT master items
        .mockResolvedValueOnce(
          rows([{ id: 100, product_id: 10, quantity: "5" }]),
        )
        // UPDATE master row → status='draft', merged_from_count=1
        .mockResolvedValueOnce(rows([])),
    };
    return cb(client as any);
  });
  mockQuery
    .mockResolvedValueOnce(
      rows([{ id: 7, supplier_id: 2, status: "draft", supplier_name: "S" }]),
    )
    .mockResolvedValueOnce(rows([]));

  const res = await app.inject({
    method: "POST",
    url: "/purchase-orders/merge",
    payload: { ids: [7] },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().id).toBe(7);
});

it("POST /merge accepts notes (not just drafts) for multi-source", async () => {
  mockTransaction.mockImplementationOnce(async (cb: any) => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce(
          rows([
            {
              id: 7,
              supplier_id: 2,
              status: "note",
              notes: null,
              label: null,
              expected_delivery_date: null,
              created_at: "2026-05-01T10:00:00Z",
            },
            {
              id: 9,
              supplier_id: 2,
              status: "note",
              notes: null,
              label: null,
              expected_delivery_date: null,
              created_at: "2026-05-02T10:00:00Z",
            },
          ]),
        )
        .mockResolvedValueOnce(
          rows([{ product_id: 11, quantity: "2", notes: null }]),
        )
        .mockResolvedValueOnce(
          rows([{ id: 100, product_id: 10, quantity: "5" }]),
        )
        .mockResolvedValueOnce(rows([])) // INSERT new (product 11)
        .mockResolvedValueOnce(rows([])) // UPDATE master (status=draft, merged_from_count=2)
        .mockResolvedValueOnce(rows([])), // DELETE source
    };
    return cb(client as any);
  });
  mockQuery
    .mockResolvedValueOnce(
      rows([{ id: 7, status: "draft", supplier_name: "S" }]),
    )
    .mockResolvedValueOnce(rows([]));

  const res = await app.inject({
    method: "POST",
    url: "/purchase-orders/merge",
    payload: { ids: [7, 9] },
  });
  expect(res.statusCode).toBe(200);
});

it("POST /merge rejects if any source is not a note or draft", async () => {
  mockTransaction.mockImplementationOnce(async (cb: any) => {
    const client = {
      query: vi.fn().mockResolvedValueOnce(
        rows([
          { id: 1, supplier_id: 2, status: "note", created_at: new Date() },
          { id: 2, supplier_id: 2, status: "sent", created_at: new Date() },
        ]),
      ),
    };
    return cb(client as any);
  });
  const res = await app.inject({
    method: "POST",
    url: "/purchase-orders/merge",
    payload: { ids: [1, 2] },
  });
  expect(res.statusCode).toBe(400);
});
```

Also **update** the existing test `"POST /merge rejects fewer than 2 ids"` to expect `min(1)` — change ids to `[]`:

```ts
it("POST /merge rejects empty ids", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/purchase-orders/merge",
    payload: { ids: [] },
  });
  expect(res.statusCode).toBe(400);
});
```

(Delete the previous "fewer than 2" test.)

- [ ] **Step 2: Run tests to verify failure**

Run: `cd warehouse-backend && npx vitest run src/__tests__/purchase-orders.test.ts -t "merge"`
Expected: at least 2 of the new tests FAIL.

- [ ] **Step 3: Update merge schema and route**

Replace `mergeSchema`:

```ts
const mergeSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
});
```

In the merge handler, replace the `nonDraft` check and the merge logic:

```ts
const invalid = orders.find(
  (o: any) => o.status !== "draft" && o.status !== "note",
);
if (invalid) {
  throw Object.assign(
    new Error("Само бележки и чернови могат да се обединяват"),
    { statusCode: 400 },
  );
}
```

After items are summed and notes concatenated, replace the master UPDATE so it always sets status='draft' and merged_from_count:

```ts
await client.query(
  `UPDATE purchase_orders
   SET status = 'draft',
       notes = $1,
       expected_delivery_date = $2,
       merged_from_count = $3,
       updated_at = NOW()
   WHERE id = $4`,
  [mergedNotes || null, expected, ids.length, master.id],
);
```

Update the source-notes concatenation to prefer label over fake ZA prefix:

```ts
const notesParts = orders
  .map((o: any) => {
    if (!o.notes) return "";
    const tag = o.label ? `[${o.label}]` : `[Бележка #${o.id}]`;
    return `${tag} ${o.notes}`;
  })
  .filter(Boolean);
const mergedNotes = notesParts.join("\n");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd warehouse-backend && npx vitest run src/__tests__/purchase-orders.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add warehouse-backend/src/routes/purchase-orders.ts \
        warehouse-backend/src/__tests__/purchase-orders.test.ts
git commit -m "feat(api): /merge accepts 1+ notes and emits a draft order

Sources can be 'note' or 'draft' (legacy). Always emits status='draft'
on the master, sets merged_from_count for UI 'from N notes' display.
Notes concat now uses [label] or [Note #N] instead of fake ZA prefix."
```

---

## Task 8: Backend — PDF supports notes (header says „БЕЛЕЖКА")

**Files:**

- Modify: `warehouse-backend/src/services/purchase-order-pdf.ts`

- [ ] **Step 1: Read the current PDF generator to find the header section**

Run: `head -80 warehouse-backend/src/services/purchase-order-pdf.ts`
Locate where it renders `order.order_number` (probably "ZA-XXXXX" in BG and EN).

- [ ] **Step 2: Update the header logic**

Where the header is rendered, add a branch:

```ts
const titleBg =
  order.status === "note"
    ? `БЕЛЕЖКА${order.label ? ` — ${order.label}` : ""}`
    : `ЗАЯВКА ${order.order_number}`;
const titleEn =
  order.status === "note"
    ? `NOTE${order.label ? ` — ${order.label}` : ""}`
    : `ORDER ${order.order_number}`;
```

Use `titleBg` and `titleEn` everywhere the previous header strings were used. Read the whole file first to make sure you locate every reference (BG header, EN header, possibly footer).

- [ ] **Step 3: Smoke-test by running the existing PDF test**

Run: `cd warehouse-backend && npx vitest run src/__tests__/purchase-orders.test.ts -t "pdf"`
Expected: PASS (the route test mocks the PDF service so changing the service should not affect this test).

For a richer check, manually exercise the route in dev and download a PDF for both a note and an order — visual confirmation only.

- [ ] **Step 4: Commit**

```bash
git add warehouse-backend/src/services/purchase-order-pdf.ts
git commit -m "feat(pdf): show 'БЕЛЕЖКА' header for notes (status='note')

Notes get 'БЕЛЕЖКА — <label>' / 'NOTE — <label>' instead of ZA-XXXXX."
```

---

## Task 9: Frontend — supplier color utility

**Files:**

- Create: `warehouse-frontend/src/lib/supplier-colors.ts`

- [ ] **Step 1: Write the utility**

```ts
// Deterministic supplier → color mapping. Used for the small dot next
// to the supplier name in the notes list.

const PALETTE = [
  { name: "amber", bg: "#f59e0b" },
  { name: "blue", bg: "#3b82f6" },
  { name: "pink", bg: "#ec4899" },
  { name: "emerald", bg: "#10b981" },
  { name: "violet", bg: "#8b5cf6" },
  { name: "rose", bg: "#f43f5e" },
  { name: "cyan", bg: "#06b6d4" },
  { name: "lime", bg: "#84cc16" },
] as const;

export type SupplierColor = (typeof PALETTE)[number];

export function colorForSupplier(supplierId: number): SupplierColor {
  // Deterministic — same supplier always gets same color across reloads.
  const idx = Math.abs(supplierId) % PALETTE.length;
  return PALETTE[idx];
}
```

- [ ] **Step 2: Smoke-test in console (optional)**

Add a tiny test if a Vitest setup exists for the frontend (check `warehouse-frontend/package.json` for a `test` script). If not, skip — visual verification at integration time is sufficient.

- [ ] **Step 3: Commit**

```bash
git add warehouse-frontend/src/lib/supplier-colors.ts
git commit -m "feat(ui): supplier color palette utility for note dots

Deterministic mapping of supplier_id to one of 8 brand-aligned colors."
```

---

## Task 10: Frontend — `NoteCard` component

**Files:**

- Create: `warehouse-frontend/src/components/purchase-orders/NoteCard.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { useMemo } from "react";

interface NoteItem {
  product_id: number;
  product_name?: string;
  quantity: number;
}

export interface NoteCardData {
  id: number;
  label: string | null;
  created_at: string;
  items: NoteItem[];
  total_quantity: number;
  item_count: number;
}

interface NoteCardProps {
  note: NoteCardData;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}

const VISIBLE_ITEMS = 3;

export function NoteCard({ note, selected, onToggle, onOpen }: NoteCardProps) {
  const visible = useMemo(
    () => note.items.slice(0, VISIBLE_ITEMS),
    [note.items],
  );
  const hidden = Math.max(0, note.items.length - VISIBLE_ITEMS);
  const tsLabel = formatShortDate(note.created_at);

  return (
    <div
      className={
        "relative flex flex-col bg-white border rounded-lg p-3 cursor-pointer transition-all " +
        (selected
          ? "border-[#f97316] ring-2 ring-orange-200"
          : "border-gray-200 hover:border-[#f97316]")
      }
      onClick={onOpen}
    >
      <button
        type="button"
        aria-label="Избери бележка"
        className={
          "absolute top-2.5 right-2.5 w-4 h-4 rounded border-[1.5px] flex items-center justify-center " +
          (selected
            ? "bg-[#f97316] border-[#f97316]"
            : "bg-white border-gray-300")
        }
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        {selected && (
          <span className="block w-1 h-2 border-r-[1.5px] border-b-[1.5px] border-white rotate-45 -mt-0.5" />
        )}
      </button>

      <div className="flex justify-between items-center mb-1.5 pr-6">
        <span className="text-[11px] font-semibold text-gray-500">
          {note.label || "Бележка"}
        </span>
        <span className="text-[11px] text-gray-400">{tsLabel}</span>
      </div>

      <ul className="m-0 pl-3.5 text-xs leading-[1.55] text-gray-700 marker:text-[#f97316]">
        {visible.map((item, idx) => (
          <li key={`${item.product_id}-${idx}`}>
            {item.product_name ?? `Продукт #${item.product_id}`}{" "}
            <span className="font-semibold text-[#f97316]">
              ×{item.quantity}
            </span>
          </li>
        ))}
      </ul>

      <div className="flex justify-between items-center mt-2 pt-2 border-t border-dashed border-gray-200 text-[11px]">
        <span className="text-gray-500 font-medium">
          {note.item_count} продукта · {note.total_quantity} бр.
        </span>
        {hidden > 0 && (
          <span className="text-[#f97316] font-semibold">+ {hidden} още →</span>
        )}
      </div>
    </div>
  );
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("bg-BG", { weekday: "short" });
  const time = d.toLocaleTimeString("bg-BG", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${day} ${time}`;
}
```

- [ ] **Step 2: Visual verification**

Make sure file compiles:

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: no errors related to NoteCard.

- [ ] **Step 3: Commit**

```bash
git add warehouse-frontend/src/components/purchase-orders/NoteCard.tsx
git commit -m "feat(ui): NoteCard component — capped product list + more link

Shows up to 3 products with overflow indicator. Selection toggles the
orange ring; whole-card click opens the dialog."
```

---

## Task 11: Frontend — `PurchaseOrdersToolbar` component

**Files:**

- Create: `warehouse-frontend/src/components/purchase-orders/PurchaseOrdersToolbar.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { Search } from "lucide-react";

export type PeriodFilter = "today" | "this-week" | "this-month" | "all";
export type StatusFilter = "" | "note" | "draft" | "sent" | "received";

interface ToolbarProps {
  period: PeriodFilter;
  status: StatusFilter;
  search: string;
  counts: Record<StatusFilter, number>;
  onPeriod: (p: PeriodFilter) => void;
  onStatus: (s: StatusFilter) => void;
  onSearch: (q: string) => void;
}

const PERIODS: { key: PeriodFilter; label: string }[] = [
  { key: "today", label: "Днес" },
  { key: "this-week", label: "Тази седмица" },
  { key: "this-month", label: "Този месец" },
  { key: "all", label: "Всички" },
];

const STATUSES: { key: StatusFilter; label: string }[] = [
  { key: "", label: "Всички" },
  { key: "note", label: "Бележки" },
  { key: "draft", label: "Чернови" },
  { key: "sent", label: "Изпратени" },
  { key: "received", label: "Получени" },
];

export function PurchaseOrdersToolbar({
  period,
  status,
  search,
  counts,
  onPeriod,
  onStatus,
  onSearch,
}: ToolbarProps) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-3.5 items-center pb-3.5 mb-3.5 border-b border-gray-100">
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold mr-1">
          Период
        </span>
        {PERIODS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => onPeriod(p.key)}
            className={pillClass(period === p.key)}
          >
            {p.label}
          </button>
        ))}
        <span className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold ml-3 mr-1">
          Статус
        </span>
        {STATUSES.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => onStatus(s.key)}
            className={pillClass(status === s.key)}
          >
            {s.label}
            <span className="ml-1 opacity-70 font-normal">{counts[s.key]}</span>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5 bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 w-60">
        <Search className="w-4 h-4 text-gray-400" />
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Търси продукт или доставчик…"
          className="bg-transparent outline-none flex-1 text-sm text-gray-900 placeholder:text-gray-400"
        />
      </div>
    </div>
  );
}

function pillClass(active: boolean) {
  return (
    "px-3 py-1 rounded-full text-xs font-medium border transition-colors " +
    (active
      ? "bg-[#f97316] text-white border-[#f97316]"
      : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50")
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add warehouse-frontend/src/components/purchase-orders/PurchaseOrdersToolbar.tsx
git commit -m "feat(ui): PurchaseOrdersToolbar — period + status pills + search"
```

---

## Task 12: Frontend — rewrite `PurchaseOrders.tsx` page

**Files:**

- Modify: `warehouse-frontend/src/pages/PurchaseOrders.tsx`

This is a large rewrite. The drawer (`PurchaseOrderDrawer`) stays mostly intact and is updated in Task 13. The page-level component is replaced.

- [ ] **Step 1: Update list query types and types for new fields**

Add these types (or extend existing `PurchaseOrderListRow`):

```ts
type PurchaseOrderStatus = "note" | "draft" | "sent" | "received";

interface PurchaseOrderListRow {
  id: number;
  order_number: string;
  supplier_id: number;
  supplier_name: string;
  status: PurchaseOrderStatus;
  notes: string | null;
  label: string | null;
  expected_delivery_date: string | null;
  sent_at: string | null;
  received_at: string | null;
  incoming_goods_id: number | null;
  merged_from_count: number;
  item_count: number | string;
  total_quantity: number | string | null;
  created_at: string;
  // For notes UI we also need item names; backend list omits items.
  // We fetch a richer endpoint per-note if needed — see Step 4 below.
}
```

Update `STATUS_LABELS` and `STATUS_VARIANTS`:

```ts
const STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  note: "Бележка",
  draft: "Чернова",
  sent: "Изпратена",
  received: "Получена",
};

const STATUS_VARIANTS: Record<
  PurchaseOrderStatus,
  "secondary" | "warning" | "info" | "success"
> = {
  note: "secondary",
  draft: "warning",
  sent: "info",
  received: "success",
};
```

- [ ] **Step 2: Replace the `PurchaseOrders` page component body**

Replace the existing default export `PurchaseOrders()` function with:

```tsx
export default function PurchaseOrders() {
  const qc = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [period, setPeriod] = useState<PeriodFilter>("this-week");
  const [status, setStatus] = useState<StatusFilter>("");
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const listQuery = useQuery({
    queryKey: ["purchase-orders", period, status, search],
    queryFn: () => {
      const qs = new URLSearchParams();
      qs.set("period", period);
      if (status) qs.set("status", status);
      if (search.trim()) qs.set("search", search.trim());
      return api
        .get(`/purchase-orders?${qs.toString()}`)
        .then((r) => r.data?.data as PurchaseOrderListRow[]);
    },
  });

  // Notes also need their items for the card preview. We fetch each note's
  // detail lazily — react-query caches per-id so re-renders are cheap.
  // For MVP scale (≤500 rows) this is fine; if it ever becomes too chatty,
  // add a server-side variant of GET / that includes item arrays for notes.
  const noteIds = useMemo(
    () =>
      (listQuery.data ?? [])
        .filter((r) => r.status === "note")
        .map((r) => r.id),
    [listQuery.data],
  );
  const noteDetails = useQueries({
    queries: noteIds.map((id) => ({
      queryKey: ["purchase-order", id],
      queryFn: () => api.get(`/purchase-orders/${id}`).then((r) => r.data),
      staleTime: 30_000,
    })),
  });
  const itemsById = useMemo(() => {
    const map = new Map<number, any[]>();
    noteDetails.forEach((q) => {
      if (q.data) map.set(q.data.id, q.data.items ?? []);
    });
    return map;
  }, [noteDetails]);

  const mergeMut = useMutation({
    mutationFn: (ids: number[]) =>
      api.post("/purchase-orders/merge", { ids }).then((r) => r.data),
    onSuccess: (data) => {
      toast.success(
        selectedIds.size > 1
          ? `${selectedIds.size} бележки обединени в ${data.order_number}`
          : `Бележка превърната в ${data.order_number}`,
      );
      setSelectedIds(new Set());
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      setEditingId(data.id);
      setDrawerOpen(true);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const openNew = () => {
    setEditingId(null);
    setDrawerOpen(true);
  };
  const openEdit = (id: number) => {
    setEditingId(id);
    setDrawerOpen(true);
  };

  const toggleSelect = (id: number, status: PurchaseOrderStatus) => {
    if (status !== "note") return; // Only notes selectable
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allRows = listQuery.data ?? [];
  const notes = allRows.filter((r) => r.status === "note");
  const orders = allRows.filter((r) => r.status !== "note");

  // Group notes by supplier
  const notesBySupplier = useMemo(() => {
    const groups = new Map<
      number,
      { name: string; notes: PurchaseOrderListRow[] }
    >();
    for (const n of notes) {
      const g = groups.get(n.supplier_id) ?? {
        name: n.supplier_name,
        notes: [],
      };
      g.notes.push(n);
      groups.set(n.supplier_id, g);
    }
    return Array.from(groups.entries());
  }, [notes]);

  const selectedRows = allRows.filter((r) => selectedIds.has(r.id));
  const selectedSupplierIds = new Set(selectedRows.map((r) => r.supplier_id));
  const sameSupplier = selectedSupplierIds.size <= 1;
  const canConvert =
    selectedRows.length >= 1 &&
    sameSupplier &&
    selectedRows.every((r) => r.status === "note");

  const counts: Record<StatusFilter, number> = {
    "": allRows.length,
    note: notes.length,
    draft: orders.filter((o) => o.status === "draft").length,
    sent: orders.filter((o) => o.status === "sent").length,
    received: orders.filter((o) => o.status === "received").length,
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Package className="h-6 w-6 text-[#f97316]" />
            Заявки
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            Бележки през деня → официална заявка за доставчика
          </p>
        </div>
        <Button onClick={openNew}>
          <Plus className="h-4 w-4 mr-1" /> Нова бележка
        </Button>
      </div>

      <PurchaseOrdersToolbar
        period={period}
        status={status}
        search={search}
        counts={counts}
        onPeriod={setPeriod}
        onStatus={setStatus}
        onSearch={setSearch}
      />

      {selectedIds.size >= 1 && (
        <div className="flex items-center justify-between bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
          <span className="text-sm text-orange-900">
            {!sameSupplier ? (
              <span className="text-red-600">
                Бележките трябва да са от един и същ доставчик
              </span>
            ) : (
              <>
                <strong>{selectedIds.size}</strong>{" "}
                {selectedIds.size === 1 ? "бележка избрана" : "бележки избрани"}{" "}
                · {selectedRows[0]?.supplier_name}
              </>
            )}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelectedIds(new Set())}
            >
              Изчисти
            </Button>
            <Button
              size="sm"
              onClick={() => mergeMut.mutate([...selectedIds])}
              disabled={!canConvert || mergeMut.isPending}
            >
              <Merge className="h-4 w-4 mr-1" />
              {mergeMut.isPending ? "Превръщане…" : "Превърни в заявка"}
            </Button>
          </div>
        </div>
      )}

      {/* Бележки секция */}
      {(status === "" || status === "note") && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-sm font-semibold text-gray-700">Бележки</h2>
            <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
              {notes.length}
            </span>
            <span className="text-xs text-gray-400 ml-auto">
              маркер = доставчик · клик за избор · 1+ бележки за един доставчик
              за обединение
            </span>
          </div>
          {notesBySupplier.length === 0 ? (
            <div className="text-sm text-gray-400 italic py-6 text-center">
              Няма бележки за този период.
            </div>
          ) : (
            notesBySupplier.map(([supplierId, group]) => {
              const color = colorForSupplier(supplierId);
              return (
                <div key={supplierId} className="mb-4">
                  <div className="flex items-center gap-2 px-1 py-1.5 border-b border-gray-100 mb-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: color.bg }}
                    />
                    {group.name}
                    <span className="ml-auto font-normal normal-case text-gray-400">
                      {group.notes.length}{" "}
                      {group.notes.length === 1 ? "бележка" : "бележки"}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                    {group.notes.map((n) => {
                      const items = itemsById.get(n.id) ?? [];
                      return (
                        <NoteCard
                          key={n.id}
                          note={{
                            id: n.id,
                            label: n.label,
                            created_at: n.created_at,
                            items,
                            total_quantity: Number(n.total_quantity ?? 0),
                            item_count: Number(n.item_count ?? 0),
                          }}
                          selected={selectedIds.has(n.id)}
                          onToggle={() => toggleSelect(n.id, n.status)}
                          onOpen={() => openEdit(n.id)}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Заявки таблица */}
      {(status === "" ||
        status === "draft" ||
        status === "sent" ||
        status === "received") && (
        <div className="rounded-lg border border-gray-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[130px]">№</TableHead>
                <TableHead>Доставчик</TableHead>
                <TableHead className="text-right">Артикули</TableHead>
                <TableHead className="text-right">Кол.</TableHead>
                <TableHead>Очаквана</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead className="w-[40px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer hover:bg-gray-50"
                  onClick={() => openEdit(row.id)}
                >
                  <TableCell className="font-mono font-medium">
                    {row.order_number}
                    {row.merged_from_count > 0 && (
                      <span className="block text-[11px] text-gray-400 font-sans font-normal">
                        от {row.merged_from_count}{" "}
                        {row.merged_from_count === 1 ? "бележка" : "бележки"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{row.supplier_name}</TableCell>
                  <TableCell className="text-right">{row.item_count}</TableCell>
                  <TableCell className="text-right">
                    {row.total_quantity ?? 0}
                  </TableCell>
                  <TableCell>
                    {row.expected_delivery_date
                      ? formatDate(row.expected_delivery_date)
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANTS[row.status]}>
                      {STATUS_LABELS[row.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Pencil className="h-4 w-4 text-gray-400" />
                  </TableCell>
                </TableRow>
              ))}
              {orders.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-sm text-gray-400 py-8 italic"
                  >
                    Няма заявки за този период.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <PurchaseOrderDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        orderId={editingId}
      />
    </div>
  );
}
```

- [ ] **Step 3: Add the new imports**

At the top of the file:

```tsx
import { useQueries } from "@tanstack/react-query";
import {
  PurchaseOrdersToolbar,
  type PeriodFilter,
  type StatusFilter,
} from "@/components/purchase-orders/PurchaseOrdersToolbar";
import { NoteCard } from "@/components/purchase-orders/NoteCard";
import { colorForSupplier } from "@/lib/supplier-colors";
```

Remove the `Filter` pills code (now in toolbar) and the `selectedIds` >= 2 check (now >= 1).

- [ ] **Step 4: Type-check**

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Visual verification using preview tools**

Run: `cd warehouse-frontend && npm run dev` (background)
Open the URL provided (port 5174), navigate to /purchase-orders.

Use `mcp__Claude_Preview__preview_*` tools (start with preview_start if needed) to:

1. Confirm the toolbar renders (period + status pills + search)
2. Confirm the empty state for notes/заявки when there are none
3. Create a note via "+ Нова бележка" → see it appear under the supplier group
4. Select 1 note → see "Превърни в заявка" merge bar
5. Convert it → заявка appears in the bottom table with `от 1 бележка`
6. Take a screenshot of the final state and share

- [ ] **Step 6: Commit**

```bash
git add warehouse-frontend/src/pages/PurchaseOrders.tsx
git commit -m "feat(ui): rewrite Заявки page as Бележки + Заявки

Two-section layout: notes grouped by supplier (colored dots, capped
cards) and orders in the existing table format. Toolbar with period +
status + search filters. Selection bar handles 1+ note conversion."
```

---

## Task 13: Frontend — adapt `PurchaseOrderDrawer` for notes

**Files:**

- Modify: `warehouse-frontend/src/pages/PurchaseOrders.tsx` (the `PurchaseOrderDrawer` component near the top)

- [ ] **Step 1: Add `label` state and field**

In `PurchaseOrderDrawer`, add state next to `notes`:

```tsx
const [label, setLabel] = useState("");
```

In the sync `useMemo` (the one that fires when `detailQuery.data` arrives), add:

```tsx
setLabel(detailQuery.data.label ?? "");
```

And in the `else if (!isEdit)` branch:

```tsx
setLabel("");
```

- [ ] **Step 2: Add `label` to mutation payload**

In `saveMut.mutationFn`'s payload, add `label`:

```tsx
const payload = {
  supplier_id: supplierId,
  label: label || null,
  notes: notes || null,
  expected_delivery_date: expectedDate || null,
  items: validItems.map((i) => ({
    product_id: i.product_id,
    quantity: i.quantity,
    notes: i.notes ?? null,
  })),
};
```

- [ ] **Step 3: Render the `label` input only for notes**

Compute `isNote`:

```tsx
const isNote = isEdit ? detail?.status === "note" : true; // new entries default to note
```

In the JSX, between the supplier select and the items table, add:

```tsx
{
  isNote && (
    <div>
      <Label>Етикет (опционално)</Label>
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="напр. Кухня в Хемус"
        maxLength={120}
        disabled={isReadOnly}
      />
    </div>
  );
}
```

- [ ] **Step 4: Hide `expected_delivery_date` for notes**

Wrap the existing date picker in `{!isNote && (...)}`. So only заявки see the date field. Notes never set it.

- [ ] **Step 5: Update the dialog title**

```tsx
<DialogTitle className="flex items-center gap-3">
  {isEdit
    ? isNote
      ? `Бележка${detail?.label ? ` — ${detail.label}` : ""}`
      : `Заявка ${detail?.order_number ?? ""}`
    : "Нова бележка"}
  {isEdit && detail && (
    <Badge variant={STATUS_VARIANTS[detail.status]}>
      {STATUS_LABELS[detail.status]}
    </Badge>
  )}
  {isEdit && detail?.merged_from_count > 0 && (
    <span className="text-xs text-gray-500">
      от {detail.merged_from_count}{" "}
      {detail.merged_from_count === 1 ? "бележка" : "бележки"}
    </span>
  )}
</DialogTitle>
```

- [ ] **Step 6: Update the primary action label for notes**

In the footer, change:

```tsx
{
  !isReadOnly && (
    <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
      {saveMut.isPending
        ? "Запазване…"
        : isEdit
          ? "Запази промените"
          : isNote
            ? "Създай бележка"
            : "Създай заявка"}
    </Button>
  );
}
```

For an existing note, add a „Превърни в заявка" button:

```tsx
{
  isEdit && isNote && (
    <Button variant="outline" onClick={() => convertSingleNote()}>
      <Merge className="h-4 w-4 mr-1" /> Превърни в заявка
    </Button>
  );
}
```

Where `convertSingleNote` is:

```tsx
const convertSingleNoteMut = useMutation({
  mutationFn: () =>
    api.post("/purchase-orders/merge", { ids: [orderId] }).then((r) => r.data),
  onSuccess: (data) => {
    toast.success(`Бележка превърната в ${data.order_number}`);
    qc.invalidateQueries({ queryKey: ["purchase-orders"] });
    qc.invalidateQueries({ queryKey: ["purchase-order", orderId] });
    onClose();
  },
  onError: (err) => toast.error(getApiErrorMessage(err)),
});

const convertSingleNote = () => {
  if (!orderId) return;
  convertSingleNoteMut.mutate();
};
```

- [ ] **Step 7: Type-check**

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Verify visually**

In dev preview:

1. Open an existing note via the card → drawer shows „Бележка" title, label field visible, no expected date field.
2. Click „Превърни в заявка" inside the drawer → success toast → drawer closes → see new заявка in table.
3. Open the converted заявка → drawer shows ZA-XXXXX title, expected date field visible (currently empty).

- [ ] **Step 9: Commit**

```bash
git add warehouse-frontend/src/pages/PurchaseOrders.tsx
git commit -m "feat(ui): drawer adapts to note vs order

Notes show a 'Етикет' field, no expected delivery date, and a
'Превърни в заявка' action. Orders keep the existing fields and
actions. Title and badges reflect the entity type."
```

---

## Task 14: End-to-end manual verification

**Files:** none

- [ ] **Step 1: Start the stack**

Run (from repo root): `docker compose up -d` (if needed) and:

- backend: `cd warehouse-backend && npm run dev`
- frontend: `cd warehouse-frontend && npm run dev`

- [ ] **Step 2: Walk through the acceptance criteria from the spec**

Use the dev preview to verify:

1. **Period + status + search work together (AND)**
   - Set period=this-week + status=Бележки + search="Hendi" — only matching notes from this week show.
2. **Big note (20 products) shows capped + „+ N още"**
   - Create a note with many items — card shows ≤3 items + footer count.
   - Click → dialog shows full list.
3. **1+ note conversion works**
   - Single note: select one → „Превърни в заявка" → ZA-XXXXX appears with `от 1 бележка`.
   - Multi note: select two for the same supplier → conversion sums quantities → ZA-XXXXX with `от 2 бележки`.
4. **Different-supplier selection blocked**
   - Select two notes from different suppliers → red message in merge bar, button disabled.
5. **Чернова заявка remains editable**
   - Open the converted заявка → drawer shows ZA-XXXXX, items editable, can change qty and save.
6. **Send + receive flow**
   - From a Чернова: click „Маркирай като изпратена" → status changes.
   - Click „Превърни в приемане на стока" → incoming_goods record created, status=Получена.
7. **Existing pre-migration drafts unaffected**
   - Inspect any draft created before the migration — it still works (edit, send, receive).

- [ ] **Step 3: Capture proof**

Take screenshots of:

- Toolbar with active filters and counts.
- Notes section grouped by supplier with at least 2 colors visible.
- A converted заявка in the bottom table showing „от N бележки".

- [ ] **Step 4: Final commit (only if any small fixes needed during verification)**

If everything works, no further commit needed. If any tweaks were necessary:

```bash
git add <files>
git commit -m "fix(ui): post-verification tweaks for Заявки redesign"
```

---

## Self-review summary

- **Spec coverage:** all 6 decisions from spec §3 are covered (Tasks 1, 4, 5, 7, 13). Migration matches spec §4. Filters match §6. API changes match §7. Frontend rewrite matches §5 + §8. Out-of-scope items (pagination, drag, custom date range) are explicitly skipped.
- **No placeholders.** All steps have concrete code, exact file paths, exact commands.
- **Type consistency:** `PurchaseOrderListRow.merged_from_count`, `label`, and the new `'note'` status are used consistently across backend route, schema, frontend types, and components.
- **Tests:** every backend change has a failing-then-passing test pair. Frontend changes verified through type-check + visual preview (Vitest setup for frontend not required by this plan).
