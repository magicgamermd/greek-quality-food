# Batch C — Orders search by article design

**Date:** 2026-04-29
**Status:** Approved (brainstorm complete, ready for implementation plan)
**Scope:** Inline "Артикул" search filter in Orders list, plus a
conditional "Намерен артикул" column shown only while the filter is
active.

---

## Understanding Summary

**What we're building:** A new inline filter input ("Артикул") next to
the existing 5 filters on the Orders list page. When typed, it filters
orders to those that contain at least one item matching the query by
`name_bg`, `name_en`, or exact `sku`. While the filter is active, the
table renders an extra column showing which item(s) matched — with the
matching substring highlighted.

**Why:** Use case — a private-individual customer comes in a week
after a sale, has lost their stock-dispatch slip, and asks for a
proper invoice. Internal staff search by product name + date range to
find the original order.

**For whom:** Entire internal team with `ORDERS_MANAGE` (admin, sales,
warehouse).

**Key constraints:**

- Search works in combination with the existing date range (the
  "История" toggle already exposes from/to dates — no change there).
- Backend `GET /orders` accepts a new query param `?article=...`.
- Match logic: `name_bg ILIKE '%q%' OR name_en ILIKE '%q%' OR sku = q`.
- After Batch B merges, the SQL switches from `JOIN products` to
  `order_items.name_bg_snapshot` so historically-named items are still
  findable by their original name. Until then, fallback to `JOIN
products` is acceptable.

**Non-goals:**

- No transliteration (bg ↔ en) — internal staff use Cyrillic.
- No "Advanced Search" page or drawer.
- No row duplication when an order has multiple matches — one row per
  order, multiple matched items shown in the new column as a list.
- No new permission.

---

## Assumptions

1. The orders list endpoint can accept `?article=...` and filter with
   an `EXISTS` subquery on `order_items` without significant
   performance impact (production data is in the low thousands).
2. The "Намерен артикул" column is rendered conditionally — only when
   the filter is non-empty — to avoid cluttering the toolbar.
3. After Batch B merges, the search SQL is updated to use
   `oi.name_bg_snapshot` / `oi.name_en_snapshot` / `oi.sku_snapshot`.
   This is a follow-up commit; it does NOT block the initial Batch C
   merge.
4. The frontend `Order` interface receives a new optional field
   `matched_items?: Array<{ name_bg: string; sku: string | null }>`.
   The backend populates it only when `?article=` is supplied.
5. `order_items` already has an index on `product_id` (verified) and
   `products` has indexes on `name_bg` and `sku` patterns (already in
   use for product search).

---

## Decision Log

| #   | Decision                                     | Alternatives                                     | Reason                                                   |
| --- | -------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------- |
| 1   | Inline filter on orders list                 | Separate Find page; drawer-based advanced search | Minimal UI change, fits the use case perfectly           |
| 2   | Match by `name_bg` + `name_en` + exact `sku` | name_bg only; with transliteration               | Full coverage without over-engineering                   |
| 3   | Reuse existing `order_date` range            | Multi-date filter / radio choice                 | YAGNI; the existing range already serves the use case    |
| 4   | `ORDERS_MANAGE` permission (existing)        | Admin/sales only; new `ORDERS_SEARCH_BY_ARTICLE` | Search reveals nothing new beyond the orders list itself |
| 5   | Conditional "Намерен артикул" column         | No column change; duplicated rows per match      | Informative, compact, no UX confusion                    |

---

## Final Design

### Backend — `GET /orders` extension

Accept a new query param `article` (string). When present, restrict
results to orders that contain at least one matching item.

```ts
// In the GET /orders handler, after parsing other filter params:
const article = normalizeOptionalText(request.query.article);

if (article) {
  // EXISTS subquery joins order_items + products and matches the
  // query against name_bg, name_en, or sku.
  where += ` AND EXISTS (
    SELECT 1
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = o.id
      AND (
        p.name_bg ILIKE $${paramIdx}
        OR p.name_en ILIKE $${paramIdx}
        OR p.sku = $${paramIdx + 1}
      )
  )`;
  params.push(`%${article}%`, article);
  paramIdx += 2;
}
```

When `?article=` is supplied, also enrich each order row in the
response with `matched_items` — an array of items that matched the
query, sorted by `oi.id`:

```sql
-- For each returned order, look up the matched items.
-- One round-trip after the main fetch is fine at this scale.
SELECT oi.order_id,
       p.name_bg,
       p.sku
  FROM order_items oi
  JOIN products p ON p.id = oi.product_id
 WHERE oi.order_id = ANY($1::int[])
   AND (
     p.name_bg ILIKE $2
     OR p.name_en ILIKE $2
     OR p.sku = $3
   )
 ORDER BY oi.order_id, oi.id
```

Group the rows by `order_id` and attach to each order under
`matched_items`.

**After Batch B merges,** the joins above become:

```sql
WHERE oi.order_id = o.id
  AND (
    oi.name_bg_snapshot ILIKE $X
    OR oi.name_en_snapshot ILIKE $X
    OR oi.sku_snapshot = $Y
  )
```

No `JOIN products` needed for the matching check itself.

### Frontend — Orders list

**New filter input** in the existing filter row (around
`Orders.tsx:3823-3873`):

```tsx
<div className="relative">
  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
  <input
    type="text"
    value={filters.article}
    onChange={(e) => setFilters((f) => ({ ...f, article: e.target.value }))}
    placeholder="Артикул"
    className="pl-9 pr-3 py-2 …"
  />
</div>
```

**Wire the new filter into the orders query:**

```tsx
const ordersQuery = useQuery({
  queryKey: ["orders", debouncedFilters],
  queryFn: () =>
    api.get("/orders", { params: { ...debouncedFilters } }).then((r) => r.data),
});
```

`debouncedFilters` already includes the existing 5 filters; add
`article` (debounced ~300ms to avoid hammering the backend on each
keystroke).

**Conditional column "Намерен артикул":**

```tsx
{
  filters.article.trim() && (
    <TableHead className="w-[180px]">Намерен артикул</TableHead>
  );
}

// In the row:
{
  filters.article.trim() && (
    <TableCell className="text-xs">
      {(order.matched_items ?? []).slice(0, 3).map((it) => (
        <div key={it.sku ?? it.name_bg}>
          <HighlightMatch text={it.name_bg} query={filters.article} />
          {it.sku && <span className="text-gray-400 ml-1">({it.sku})</span>}
        </div>
      ))}
      {(order.matched_items ?? []).length > 3 && (
        <div className="text-gray-400">
          +{order.matched_items.length - 3} още
        </div>
      )}
    </TableCell>
  );
}
```

The `HighlightMatch` component already exists and is used for the
existing filters — same pattern.

### Frontend — Order interface extension

```ts
// types/index.ts — extend Order interface
matched_items?: Array<{
  name_bg: string;
  sku: string | null;
}>;
```

### Test strategy

- **Backend integration tests:**
  - `GET /orders?article=скара` returns only orders containing a
    matching product.
  - Response includes `matched_items` only when `?article=` was supplied.
  - Search by SKU (exact match) works.
  - Search by `name_en` works.
  - Combined with `?date_from=` and `?date_to=`, both filters AND-ed.
  - Empty `?article=` (whitespace) is ignored (no filter applied).

- **Frontend smoke tests** (manual, see below).

- **No unit tests** — the search is a thin SQL filter with a frontend
  debounce; logic is straightforward and well-covered by integration
  tests.

---

## Non-Functional Requirements

- **Performance:** EXISTS subquery with `order_items(product_id)`
  index → fast at MERT-M scale. Add LIMIT 100 on the matched_items
  enrichment query as a safety net.
- **Scale:** acceptable up to ~50k orders without further indexing.
- **Security:** uses existing auth + `ORDERS_MANAGE` requirement; no
  new attack surface.
- **Reliability:** read-only; atomic queries.
- **Maintenance:** +1 filter input, +1 conditional column, +1 backend
  param, +1 enrichment query. Small surface.

---

## Implementation Plan

(Generated next by the `writing-plans` skill.)
