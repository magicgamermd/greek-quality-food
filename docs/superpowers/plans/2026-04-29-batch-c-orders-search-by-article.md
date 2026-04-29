# Batch C — Orders search by article Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an "Артикул" inline filter to the Orders list that finds orders containing a product by partial `name_bg` / `name_en` or exact `sku`, with a conditional "Намерен артикул" column showing which items matched.

**Architecture:** Backend `GET /orders` accepts `?article=...` and adds an `EXISTS` subquery against `order_items` + `products`. When the param is supplied, a second batched query enriches each returned order with `matched_items: [{ name_bg, sku }]`. Frontend adds a 6th inline filter input and a conditional table column. After Batch B (snapshot) merges, follow-up commit switches the SQL from `JOIN products` to `oi.name_bg_snapshot`.

**Tech Stack:** PostgreSQL 16 (EXISTS + ILIKE), Fastify+TypeScript backend, Vitest tests, React+TanStack Query frontend (already has `useDebouncedValue` helper).

**Spec:** [docs/superpowers/specs/2026-04-29-batch-c-orders-search-by-article-design.md](../specs/2026-04-29-batch-c-orders-search-by-article-design.md)

---

## Pre-flight

- Branch from `main`: `git checkout main && git pull && git checkout -b feature/MERTM-batch-c-search-by-article`
- Backend dev server: `./scripts/start-mertm.sh`
- Backend tests: `cd warehouse-backend && npx vitest run`
- Type-check: `npx tsc --noEmit` (run in both `warehouse-backend/` and `warehouse-frontend/`)

---

## Task 1: Backend — accept `?article=` and add EXISTS filter

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts:402-417` (add `article` to destructuring); `:494-512` (add filter after the existing filters block, before `Snapshot WHERE params`).

**Step 1: Add `article` to the query param destructuring**

Around `:402`:

```ts
const {
  status,
  partner_id,
  page,
  limit,
  invoiced,
  date_from,
  date_to,
  invoice_number,
  stock_dispatch_number,
  commercial_document_number,
  request_number,
  object_query,
  q,
  below_cost_only,
  article, // NEW
} = request.query as any;
```

**Step 2: Add the EXISTS filter block after the existing `objectQuery` block at `:494`**

```ts
const articleQuery = normalizeOptionalText(article);
if (articleQuery) {
  // Match against products joined to order_items. Switch to
  // order_items.name_bg_snapshot once Batch B merges.
  where += ` AND EXISTS (
    SELECT 1
    FROM order_items oi
    JOIN products p_oi ON p_oi.id = oi.product_id
    WHERE oi.order_id = o.id
      AND (
        p_oi.name_bg ILIKE $${paramIdx}
        OR p_oi.name_en ILIKE $${paramIdx}
        OR p_oi.sku = $${paramIdx + 1}
      )
  )`;
  params.push(`%${articleQuery}%`, articleQuery);
  paramIdx += 2;
}
```

(Use alias `p_oi` to avoid collision with the existing `p` partner alias on the outer query.)

**Step 3: Type-check**

Run: `cd warehouse-backend && npx tsc --noEmit`
Expected: PASS.

**Step 4: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): accept ?article= filter on GET /orders (EXISTS subquery)"
```

---

## Task 2: Backend — enrich response with `matched_items`

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts:556-575` (after the main `query(sql, params)` call, before constructing the response).

**Step 1: After `const { rows } = await query(sql, params);`, when `articleQuery` is set, fetch matched items in one batched query**

```ts
let matchedItemsByOrder: Map<
  number,
  Array<{ name_bg: string; sku: string | null }>
> = new Map();
if (articleQuery && rows.length > 0) {
  const orderIds = rows.map((r) => r.id);
  const { rows: matched } = await query(
    `SELECT oi.order_id, p.name_bg, p.sku
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ANY($1::int[])
        AND (
          p.name_bg ILIKE $2
          OR p.name_en ILIKE $2
          OR p.sku = $3
        )
      ORDER BY oi.order_id, oi.id
      LIMIT 1000`,
    [orderIds, `%${articleQuery}%`, articleQuery],
  );
  for (const row of matched) {
    const list = matchedItemsByOrder.get(row.order_id) ?? [];
    list.push({ name_bg: row.name_bg, sku: row.sku });
    matchedItemsByOrder.set(row.order_id, list);
  }
}

const enrichedRows = rows.map((r) => ({
  ...r,
  matched_items: articleQuery
    ? (matchedItemsByOrder.get(r.id) ?? [])
    : undefined,
}));
```

**Step 2: Replace the existing `return reply.send({ data: rows, total })` (or similar) with the enriched rows**

Find the current response construction (around `:570-575`). Use `enrichedRows` in place of `rows`.

**Step 3: Commit**

```bash
git add warehouse-backend/src/routes/orders.ts
git commit -m "feat(orders): enrich GET /orders response with matched_items when ?article= is set"
```

---

## Task 3: Backend integration tests

**Files:**

- Create: `warehouse-backend/src/__tests__/orders-search-by-article.test.ts`

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

import { query } from "../db.js";
import ordersRoutes from "../routes/orders.js";

const mockQuery = vi.mocked(query);

async function buildApp(role = "admin") {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as any).user = { id: "u1", role };
    (req as any).jwtVerify = async () => (req as any).user;
  });
  await app.register(ordersRoutes, { prefix: "/orders" });
  return app;
}

describe("GET /orders ?article= filter", () => {
  beforeEach(() => mockQuery.mockReset());

  it("does not apply the filter when ?article= is empty whitespace", async () => {
    // 1st call: getUserPermissions; 2nd: SELECT orders; 3rd: count
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ role: "admin", overrides: [] }],
      } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [{ count: 0 }] } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/orders?article=%20%20",
    });
    expect(res.statusCode).toBe(200);
    // Verify the SQL did NOT include EXISTS clause
    const sqlCall = mockQuery.mock.calls.find((c) => /SELECT o\.\*/.test(c[0]));
    expect(sqlCall?.[0]).not.toMatch(/EXISTS/);
    await app.close();
  });

  it("applies EXISTS filter when ?article= is non-empty", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ role: "admin", overrides: [] }],
      } as any)
      .mockResolvedValueOnce({ rows: [{ id: 1 }] } as any) // main query
      .mockResolvedValueOnce({
        rows: [{ order_id: 1, name_bg: "Скара X", sku: "MBG-1" }],
      } as any) // enrichment
      .mockResolvedValueOnce({ rows: [{ count: 1 }] } as any); // count

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/orders?article=скара",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const data = Array.isArray(body) ? body : body.data;
    expect(data[0].matched_items).toEqual([
      { name_bg: "Скара X", sku: "MBG-1" },
    ]);
    await app.close();
  });

  it("does NOT include matched_items when ?article= is absent", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ role: "admin", overrides: [] }],
      } as any)
      .mockResolvedValueOnce({ rows: [{ id: 1 }] } as any)
      .mockResolvedValueOnce({ rows: [{ count: 1 }] } as any);

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/orders" });
    const body = JSON.parse(res.body);
    const data = Array.isArray(body) ? body : body.data;
    expect(data[0]).not.toHaveProperty("matched_items");
    await app.close();
  });

  it("combines ?article= with ?date_from= / ?date_to=", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ role: "admin", overrides: [] }],
      } as any)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [{ count: 0 }] } as any);

    const app = await buildApp();
    await app.inject({
      method: "GET",
      url: "/orders?article=скара&date_from=2026-04-01&date_to=2026-04-30",
    });
    const sqlCall = mockQuery.mock.calls.find((c) => /SELECT o\.\*/.test(c[0]));
    expect(sqlCall?.[0]).toMatch(/EXISTS/);
    expect(sqlCall?.[0]).toMatch(/order_date.*>=/);
    expect(sqlCall?.[0]).toMatch(/order_date.*<=/);
    await app.close();
  });
});
```

**Step 2: Run test — expect failures until route is correct**

Run: `npx vitest run src/__tests__/orders-search-by-article.test.ts`

**Step 3: Iterate the route/enrichment until all 4 tests pass**

**Step 4: Commit**

```bash
git add warehouse-backend/src/__tests__/orders-search-by-article.test.ts
git commit -m "test(orders): integration tests for ?article= filter + matched_items shape"
```

---

## Task 4: Frontend — Order interface gets `matched_items`

**Files:**

- Modify: `warehouse-frontend/src/types/index.ts:169-243` (Order interface — extend at the end before closing brace)

**Step 1: Append**

```ts
// Search by article — populated by GET /orders?article=...
matched_items?: Array<{
  name_bg: string;
  sku: string | null;
}>;
```

**Step 2: Type-check**

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: PASS.

**Step 3: Commit**

```bash
git add warehouse-frontend/src/types/index.ts
git commit -m "feat(types): Order.matched_items for article search results"
```

---

## Task 5: Frontend — extend filters state + debounced article input

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx:3406-3412` (filters state shape); add a new state line for the input + a debounced derivative; modify the orders `useQuery` to include `article`.

**Step 1: Add `article` to the filters state shape**

```ts
const [filters, setFilters] = useState({
  order_number: "",
  partner: "",
  invoice: "",
  stock_dispatch: "",
  commercial_doc: "",
  article: "", // NEW
});
```

**Step 2: Import `useDebouncedValue`**

At top of `Orders.tsx`, ensure the hook is imported:

```ts
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
```

**Step 3: Just below the `filters` state, add a debounced derivative**

```ts
const debouncedArticle = useDebouncedValue(filters.article.trim(), 300);
```

**Step 4: Wire into the orders `useQuery` (around `:3431-3445`)**

```ts
const {
  data: orders = [],
  isLoading,
  error,
} = useQuery<Order[]>({
  queryKey: ["orders", statusFilter, belowCostOnly, debouncedArticle],
  queryFn: () => {
    const parts: string[] = [];
    if (statusFilter === "invoiced") parts.push("invoiced=true");
    else if (statusFilter) parts.push(`status=${statusFilter}`);
    if (belowCostOnly) parts.push("below_cost_only=true");
    if (debouncedArticle)
      parts.push(`article=${encodeURIComponent(debouncedArticle)}`);
    const params = parts.length > 0 ? `?${parts.join("&")}` : "";
    return api.get(`/orders${params}`).then((r) => {
      const d = r.data;
      return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
    });
  },
  refetchInterval: 30000,
});
```

**Step 5: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): wire filters.article to backend ?article= with 300ms debounce"
```

---

## Task 6: Frontend — new "Артикул" filter input

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx:3823-3879` (filter inputs row — add 6th input)

**Step 1: Find the 5th input (placeholder "Търговски документ" around `:3868-3878`) and append a 6th input below it**

```tsx
{
  /* Article search — finds orders containing this product */
}
<div className="relative">
  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
  <input
    type="text"
    value={filters.article}
    onChange={(e) => setFilters((f) => ({ ...f, article: e.target.value }))}
    placeholder="Артикул"
    className="pl-9 pr-3 py-2 w-full text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-[#f97316] focus:outline-none"
  />
</div>;
```

**Step 2: Update the "clear all filters" button to also reset `article`**

Around `:3893`:

```ts
setFilters({
  order_number: "",
  partner: "",
  invoice: "",
  stock_dispatch: "",
  commercial_doc: "",
  article: "", // NEW
});
```

**Step 3: Manual smoke test**

Login → Поръчки → type "скара" in Артикул input → verify the URL shows `?article=скара` after 300ms; verify only orders containing "скара" remain.

**Step 4: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): add Артикул inline filter input"
```

---

## Task 7: Frontend — conditional "Намерен артикул" column

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx:3771-3791` (table headers — add conditional `<TableHead>`); `:3823-…` (table body — add conditional `<TableCell>`).

**Step 1: Inside `<TableHeader>`, after the "Документи" head**

```tsx
{
  filters.article.trim() && (
    <TableHead className="w-[200px]">Намерен артикул</TableHead>
  );
}
```

(Adjust grid widths if needed; might require shrinking other columns.)

**Step 2: Inside the row, after the "Документи" `<TableCell>`**

```tsx
{
  filters.article.trim() && (
    <TableCell className="text-xs">
      {(order.matched_items ?? []).slice(0, 3).map((it, idx) => (
        <div key={`${it.sku ?? "no-sku"}-${idx}`} className="truncate">
          <HighlightMatch text={it.name_bg} query={filters.article} />
          {it.sku && <span className="text-gray-400 ml-1">({it.sku})</span>}
        </div>
      ))}
      {(order.matched_items?.length ?? 0) > 3 && (
        <div className="text-gray-400">
          +{order.matched_items!.length - 3} още
        </div>
      )}
    </TableCell>
  );
}
```

**Step 3: Manual smoke test**

Type "скара" → verify the new column appears, with matched item names highlighted; clear the filter → column disappears.

**Step 4: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders-fe): conditional 'Намерен артикул' column highlights matches"
```

---

## Task 8: Manual end-to-end verification

Run `./scripts/start-mertm.sh` and follow:

1. **Login admin** → Поръчки → confirm there are 5 filter inputs visible plus the new "Артикул".
2. Type "скара" → verify after ~300ms the list narrows to orders containing "скара" in any item.
3. Verify the new "Намерен артикул" column appears at the right; matched items shown with highlight.
4. Clear the input → column disappears; full list returns.
5. Open the "История" toggle → enter dates → combine with "скара" → verify both filters AND-ed.
6. Type an exact SKU like "MBG-29128" → verify it finds matching orders.
7. Type "grill" → verify English-name matches work.
8. Verify a sales user (no `BELOW_COST_OVERRIDE`) sees the same article filter (it's NOT gated on that).

---

## Task 9: Update STATUS.md

```markdown
**Batch C — Orders search by article** (2026-04-29):

- Backend `GET /orders?article=…` — EXISTS subquery on order_items + products
- `matched_items` enrichment when ?article= is supplied
- Frontend "Артикул" inline filter (debounced 300ms)
- Conditional "Намерен артикул" column with HighlightMatch
- Combines naturally with existing date range and other filters
- Follow-up: switch SQL to oi.name_bg_snapshot once Batch B is merged
```

---

## Follow-up (after Batch B merges)

Once `order_items.name_bg_snapshot` exists:

1. In `routes/orders.ts` Task-1 EXISTS subquery, replace:
   ```sql
   JOIN products p_oi ON p_oi.id = oi.product_id
   WHERE oi.order_id = o.id
     AND (
       p_oi.name_bg ILIKE $X
       OR p_oi.name_en ILIKE $X
       OR p_oi.sku = $Y
     )
   ```
   with:
   ```sql
   WHERE oi.order_id = o.id
     AND (
       oi.name_bg_snapshot ILIKE $X
       OR oi.name_en_snapshot ILIKE $X
       OR oi.sku_snapshot = $Y
     )
   ```
2. Same swap in the matched_items enrichment query (Task 2).
3. Drop the `JOIN products`.
4. Add a test case: rename a product → search by old name still finds the order.
5. Single commit:
   ```bash
   git commit -m "refactor(orders): article search uses order_items snapshot post-Batch-B"
   ```

---

## Verification checklist (`superpowers:verification-before-completion`)

- [ ] Backend tests pass: `npx vitest run`
- [ ] Backend type-check clean: `npx tsc --noEmit`
- [ ] Frontend type-check clean: `cd warehouse-frontend && npx tsc --noEmit`
- [ ] Manual E2E (Task 8) — all 8 steps green
- [ ] STATUS.md updated
- [ ] All commits use conventional format
- [ ] Follow-up swap to snapshot scheduled for after Batch B merge
