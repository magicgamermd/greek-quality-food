# Daily Payments Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `/payments` page so admin can filter by a single day, see cash/bank split, and print a clean A4 daily report — with two separate reports (Фактурни / По разписки) driven by the existing tabs.

**Architecture:** Pure extension of `warehouse-frontend/src/pages/Payments.tsx`. One new CSS file for `@media print`. Two small backend tweaks: raise page-size cap from 100 to 500 and expose `invoice_status` / `order_status` in GET /payments response so the UI can tag annulled documents.

**Tech Stack:** React 19 + TanStack Query + Tailwind v4 (frontend), Fastify + node-postgres (backend), vitest (backend tests). No new deps.

**Spec:** `docs/superpowers/specs/2026-04-22-daily-payments-report-design.md`

---

## Task 1: Backend — raise limit cap and expose document status

**Files:**

- Modify: `warehouse-backend/src/routes/payments.ts:45` (cap), `:138-142` (invoice SELECT), `:107-109` (razpiska SELECT)
- Test: `warehouse-backend/src/routes/__tests__/payments.test.ts` (existing file — add cases)

**Why:** Spec §3.5 raises UI limit to 500 when in daily mode. Current cap is 100. Spec §5.2 requires an "АНУЛИРАНА" tag on rows tied to cancelled documents — backend must return the `status`.

- [ ] **Step 1: Write failing test for limit cap at 500**

Add to `warehouse-backend/src/routes/__tests__/payments.test.ts` (find the existing describe block for GET /payments):

```ts
it("accepts limit up to 500", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/payments?limit=500&type=invoice",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  // Body must be accepted; no 400/413. Row count depends on fixtures;
  // the assertion is simply that limit=500 is not clipped down to 100.
  const body = res.json();
  expect(Array.isArray(body.data)).toBe(true);
});

it("returns invoice_status for invoice payments", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/payments?type=invoice&limit=10",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  if (body.data.length > 0) {
    expect(body.data[0]).toHaveProperty("invoice_status");
    expect(["active", "cancelled"]).toContain(body.data[0].invoice_status);
  }
});

it("returns order_status for razpiska payments", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/payments?type=razpiska&limit=10",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  if (body.data.length > 0) {
    expect(body.data[0]).toHaveProperty("order_status");
  }
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd warehouse-backend && npx vitest run src/routes/__tests__/payments.test.ts`
Expected: first test may pass (if data < 100 rows), status tests FAIL (property missing in response).

- [ ] **Step 3: Raise page-size cap from 100 to 500**

In `warehouse-backend/src/routes/payments.ts:45`, change:

```ts
const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 50));
```

to:

```ts
const pageSize = Math.min(500, Math.max(1, parseInt(limit) || 50));
```

- [ ] **Step 4: Add `invoice_status` to invoice-tab SELECT**

In `warehouse-backend/src/routes/payments.ts:138-142`, change the SELECT list:

```ts
SELECT pay.*, i.invoice_number, i.total_gross AS invoice_total_gross,
       i.status AS invoice_status,
       p.name AS partner_name,
       pay.cumulative_paid::numeric AS invoice_paid_total
```

- [ ] **Step 5: Add `order_status` to razpiska-tab SELECT**

In `warehouse-backend/src/routes/payments.ts:107-109`, change the SELECT list:

```ts
SELECT pay.*, o.order_number, o.total_amount AS order_total,
       o.status AS order_status,
       p.name AS partner_name,
       pay.cumulative_paid::numeric AS order_paid_total
```

- [ ] **Step 6: Run tests — verify they pass**

Run: `cd warehouse-backend && npx vitest run src/routes/__tests__/payments.test.ts`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add warehouse-backend/src/routes/payments.ts warehouse-backend/src/routes/__tests__/payments.test.ts
git commit -m "feat(payments): raise list cap to 500 and expose document status

Supports the new daily report view which uses limit=500 for single-day
mode and needs document status to tag annulled rows."
```

---

## Task 2: Update Payment TypeScript type

**Files:**

- Modify: `warehouse-frontend/src/types/index.ts:269-286`

**Why:** Frontend needs to read the new backend fields.

- [ ] **Step 1: Add status fields to Payment interface**

In `warehouse-frontend/src/types/index.ts`, locate the `Payment` interface (around line 269) and add two optional fields at the end:

```ts
export interface Payment {
  id: number;
  invoice_id?: number | null;
  order_id?: number | null;
  amount: number;
  payment_method: "cash" | "bank" | "card";
  paid_at: string;
  bank_reference?: string;
  matched_by_agent?: boolean;
  invoice?: Invoice;
  invoice_number?: string;
  partner_name?: string;
  invoice_total_gross?: number | string;
  invoice_paid_total?: number | string;
  order_number?: number;
  order_total?: number | string;
  order_paid_total?: number | string;
  invoice_status?: "active" | "cancelled" | null;
  order_status?:
    | "pending"
    | "confirmed"
    | "processing"
    | "fulfilled"
    | "cancelled"
    | null;
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add warehouse-frontend/src/types/index.ts
git commit -m "feat(types): add invoice_status and order_status to Payment"
```

---

## Task 3: Add `todayIso()` helper and "Днес" button

**Files:**

- Modify: `warehouse-frontend/src/pages/Payments.tsx` (add helper at top-level, button near line 295)

**Why:** Spec §3.1 — one-click filter to today.

- [ ] **Step 1: Add `todayIso()` helper at module top**

In `warehouse-frontend/src/pages/Payments.tsx`, right after the imports (around line 23, before `const methodLabels`), add:

```ts
/** Return today's date in ISO 8601 format (YYYY-MM-DD) in Europe/Sofia timezone. */
function todayIso(): string {
  return new Date().toLocaleDateString("sv-SE", {
    timeZone: "Europe/Sofia",
  });
}
```

(Swedish locale `sv-SE` returns `YYYY-MM-DD` format, which happens to match ISO 8601.)

- [ ] **Step 2: Add "Днес" button next to date inputs**

In `warehouse-frontend/src/pages/Payments.tsx`, inside the date filter div (around lines 271-295, replacing the current structure):

Find:

```tsx
<div className="space-y-1">
  <Label className="text-xs">Период</Label>
  <div className="grid grid-cols-2 gap-2">
    <Input
      type="date"
      value={filters.date_from}
      onChange={(e) =>
        setFilters((prev) => ({
          ...prev,
          date_from: e.target.value,
        }))
      }
    />
    <Input
      type="date"
      value={filters.date_to}
      onChange={(e) =>
        setFilters((prev) => ({
          ...prev,
          date_to: e.target.value,
        }))
      }
    />
  </div>
</div>
```

Replace with:

```tsx
<div className="space-y-1">
  <div className="flex items-center justify-between">
    <Label className="text-xs">Период</Label>
    <button
      type="button"
      className="text-xs text-[#f97316] hover:underline"
      onClick={() => {
        const t = todayIso();
        setFilters((prev) => ({ ...prev, date_from: t, date_to: t }));
      }}
    >
      Днес
    </button>
  </div>
  <div className="grid grid-cols-2 gap-2">
    <Input
      type="date"
      value={filters.date_from}
      onChange={(e) =>
        setFilters((prev) => ({
          ...prev,
          date_from: e.target.value,
        }))
      }
    />
    <Input
      type="date"
      value={filters.date_to}
      onChange={(e) =>
        setFilters((prev) => ({
          ...prev,
          date_to: e.target.value,
        }))
      }
    />
  </div>
</div>
```

- [ ] **Step 3: Verify via preview**

Run `preview_start` with name `mertm-frontend`. Navigate to `/payments`. Snapshot and find the "Днес" label. Click it via `preview_click`. Snapshot and verify both date inputs now show today's date in `YYYY-MM-DD` format.

- [ ] **Step 4: Commit**

```bash
git add warehouse-frontend/src/pages/Payments.tsx
git commit -m "feat(payments): add 'Днес' quick-filter button"
```

---

## Task 4: Split summary cards in single-day mode

**Files:**

- Modify: `warehouse-frontend/src/pages/Payments.tsx` (around lines 215-235)

**Why:** Spec §3.2 — when one day is selected, show cash/bank/total breakdown.

- [ ] **Step 1: Add `formatDateBg()` helper in module**

In `warehouse-frontend/src/pages/Payments.tsx`, right after the `todayIso()` helper added in Task 3, append:

```ts
/** Format ISO YYYY-MM-DD as DD.MM.YYYY. Returns original if parse fails. */
function formatDateBg(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}
```

- [ ] **Step 2: Compute split totals inside the component**

Inside the `Payments()` function, after the existing `totalReceived` calculation (around line 171), add:

```ts
const isSingleDay =
  !!filters.date_from &&
  !!filters.date_to &&
  filters.date_from === filters.date_to;

const cashTotal = payments
  .filter((p) => p.payment_method === "cash")
  .reduce((s, p) => s + safeAmount(p.amount), 0);
const bankTotal = payments
  .filter((p) => p.payment_method === "bank" || p.payment_method === "card")
  .reduce((s, p) => s + safeAmount(p.amount), 0);
```

- [ ] **Step 3: Replace the summary grid with a conditional**

Find the existing summary block (around lines 215-235) — the `<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">` containing three cards — and replace the entire block with:

```tsx
{
  /* Summary */
}
{
  isSingleDay ? (
    <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
      <div className="rounded-xl bg-gray-50 border border-gray-200 p-4">
        <p className="text-sm text-gray-600">За деня</p>
        <p className="text-2xl font-bold text-gray-900 mt-1">
          {formatDateBg(filters.date_from)}
        </p>
      </div>
      <div className="rounded-xl bg-green-50 border border-green-200 p-4">
        <p className="text-sm text-green-600">В брой</p>
        <p className="text-2xl font-bold text-green-700 mt-1">
          {formatCurrency(cashTotal)}
        </p>
      </div>
      <div className="rounded-xl bg-blue-50 border border-blue-200 p-4">
        <p className="text-sm text-blue-600">По банка</p>
        <p className="text-2xl font-bold text-blue-700 mt-1">
          {formatCurrency(bankTotal)}
        </p>
      </div>
      <div className="rounded-xl bg-orange-50 border border-orange-200 p-4">
        <p className="text-sm text-orange-600">Общо за деня</p>
        <p className="text-2xl font-bold text-orange-700 mt-1">
          {formatCurrency(totalReceived)}
        </p>
        <p className="text-xs text-orange-500 mt-1">
          {payments.length} плащания
        </p>
      </div>
    </div>
  ) : (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div className="rounded-xl bg-green-50 border border-green-200 p-4">
        <p className="text-sm text-green-600">Получени плащания</p>
        <p className="text-2xl font-bold text-green-700 mt-1">
          {formatCurrency(totalReceived)}
        </p>
      </div>
      <div className="rounded-xl bg-red-50 border border-red-200 p-4">
        <p className="text-sm text-red-600">Чакащи фактури</p>
        <p className="text-2xl font-bold text-red-700 mt-1">
          {unpaidInvoices.length}
        </p>
      </div>
      <div className="rounded-xl bg-orange-50 border border-orange-200 p-4">
        <p className="text-sm text-orange-600">Общо транзакции</p>
        <p className="text-2xl font-bold text-orange-700 mt-1">
          {payments.length}
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify via preview**

On `/payments`, click "Днес". Snapshot — should show 4 cards (Деня, В брой, По банка, Общо). Clear filters (click "Изчисти филтрите"). Snapshot — should show 3 cards (Получени, Чакащи, Общо).

Verify `cash + bank = totalReceived` by comparing displayed values to the row data.

- [ ] **Step 5: Commit**

```bash
git add warehouse-frontend/src/pages/Payments.tsx
git commit -m "feat(payments): split summary into cash/bank in single-day mode"
```

---

## Task 5: Print CSS file

**Files:**

- Create: `warehouse-frontend/src/pages/Payments.print.css`
- Modify: `warehouse-frontend/src/pages/Payments.tsx` (import the CSS)

**Why:** Spec §3.4 — hide app chrome during print.

- [ ] **Step 1: Create the CSS file**

Create `warehouse-frontend/src/pages/Payments.print.css` with:

```css
@media print {
  /* Hide app chrome */
  aside,
  .app-header,
  .sidebar,
  nav[aria-label="Main navigation"] {
    display: none !important;
  }

  /* Hide interactive controls within the Payments page */
  .payments-page .no-print,
  .payments-page button,
  .payments-page input,
  .payments-page select,
  .payments-page .filters-card {
    display: none !important;
  }

  /* Full-width main content */
  main,
  .payments-page {
    padding: 0 !important;
    margin: 0 !important;
    background: white !important;
  }

  /* Print-only elements (hidden on screen) */
  .print-only {
    display: block !important;
  }

  /* Keep summary and table visible */
  .payments-page .summary-cards,
  .payments-page .payments-table {
    page-break-inside: avoid;
  }

  @page {
    size: A4 portrait;
    margin: 1.5cm;
  }

  /* Smaller heading + muted footer */
  .print-title h1 {
    font-size: 16pt;
    margin: 0 0 4px 0;
  }
  .print-title p {
    font-size: 11pt;
    margin: 0 0 12px 0;
  }
  .print-footer {
    font-size: 9pt;
    color: #555;
    margin-top: 16px;
    text-align: right;
  }
}

/* Hidden on screen, shown only in print (Tailwind's `print:block` works too,
   but we keep one source of truth for print styling here) */
.print-only {
  display: none;
}
```

- [ ] **Step 2: Import the CSS in Payments.tsx**

At the top of `warehouse-frontend/src/pages/Payments.tsx`, after the last import, add:

```ts
import "./Payments.print.css";
```

- [ ] **Step 3: Add marker classes to key elements**

We need CSS hooks for `.payments-page`, `.filters-card`, `.summary-cards`, `.payments-table`.

In `Payments.tsx`:

- Change the root `<div className="p-6 space-y-6">` (around line 174) to:
  ```tsx
  <div className="payments-page p-6 space-y-6">
  ```
- Add `className="filters-card"` on the `<Card>` wrapping the filter grid (around line 237). This `<Card>` currently has no className — replace `<Card>` with `<Card className="filters-card">`.
- Wrap the summary grid in `<div className="summary-cards">` (both conditional branches). Simplest: wrap the whole `{isSingleDay ? (...) : (...)}` in the summary section with `<div className="summary-cards">...</div>`.
- Add `className="payments-table"` on the `<Card>` wrapping the Table (around line 324). Replace `<Card>` with `<Card className="payments-table">`.

- [ ] **Step 4: Verify CSS loads without build errors**

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: no errors.

Verify via preview: reload `/payments`, snapshot — no visual change on screen.

- [ ] **Step 5: Commit**

```bash
git add warehouse-frontend/src/pages/Payments.print.css warehouse-frontend/src/pages/Payments.tsx
git commit -m "feat(payments): add print stylesheet and marker classes"
```

---

## Task 6: Print button and print-only JSX

**Files:**

- Modify: `warehouse-frontend/src/pages/Payments.tsx`

**Why:** Spec §3.3 — button to trigger `window.print()`. Print-only title/footer.

- [ ] **Step 1: Add a `<Printer />` icon import**

In `Payments.tsx`, update the lucide-react import:

```ts
import { Plus, Search, Printer } from "lucide-react";
```

- [ ] **Step 2: Add the "Принтирай отчет" button**

Find the export buttons row (around line 297-320 — the div with "Експорт CSV" and "Изчисти филтрите"). Add a new button before the clear-filter button:

```tsx
<Button
  variant="outline"
  size="sm"
  onClick={() => window.print()}
  disabled={payments.length === 0}
>
  <Printer className="h-4 w-4" />
  Принтирай отчет
</Button>
```

Place it between the existing "Експорт CSV" button and "Изчисти филтрите". Final order: Експорт CSV · Принтирай отчет · Изчисти филтрите.

- [ ] **Step 3: Add print-only title and footer**

In the JSX (inside `.payments-page` root div, right after the opening `<div>` around line 174), insert the print-only title:

```tsx
<div className="print-only print-title">
  <h1>
    МЕРТ-М — Дневен отчет (
    {activeTab === "invoice" ? "Фактурни" : "По разписки"})
  </h1>
  <p>
    {isSingleDay
      ? formatDateBg(filters.date_from)
      : filters.date_from && filters.date_to
        ? `Период: ${formatDateBg(filters.date_from)} – ${formatDateBg(filters.date_to)}`
        : "Всички плащания"}
  </p>
</div>
```

And at the very bottom (inside `.payments-page`, before the closing `</div>` around line 434, after `RecordPaymentModal`), add the footer:

```tsx
<div className="print-only print-footer">
  Отпечатано на {formatDateBg(todayIso())}{" "}
  {new Date().toLocaleTimeString("bg-BG", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Sofia",
  })}
</div>
```

- [ ] **Step 4: Verify via preview**

Reload `/payments`. Snapshot — the print-only elements must NOT be visible on screen (CSS `.print-only { display: none }`).

Verify button exists: snapshot should now show "Принтирай отчет" in the action row.

Use `preview_eval` to check print media styles:

```js
window.matchMedia("print").matches; // false on screen
// Check that the print-only element is rendered but hidden
document.querySelector(".print-only")?.offsetHeight; // 0 on screen
```

To visually verify print layout: Chrome DevTools → `preview_eval` to run a command simulating print preview won't work; instead, instruct the user to open Chrome DevTools → Rendering panel → Emulate CSS media type: print. (Document this as a manual step in the final verification task.)

- [ ] **Step 5: Commit**

```bash
git add warehouse-frontend/src/pages/Payments.tsx
git commit -m "feat(payments): add 'Принтирай отчет' button and print-only title/footer"
```

---

## Task 7: Raise fetch limit in daily mode + overflow warning

**Files:**

- Modify: `warehouse-frontend/src/pages/Payments.tsx` (queryFn around line 138; JSX above the table around line 324)

**Why:** Spec §3.5 and edge case §5.4.

- [ ] **Step 1: Make the limit dynamic**

In the `useQuery` `queryFn` (around line 136-151), change:

```ts
params.set("limit", "100");
```

to:

```ts
const isOneDay = !!(
  filters.date_from &&
  filters.date_to &&
  filters.date_from === filters.date_to
);
params.set("limit", isOneDay ? "500" : "100");
```

**Note:** `isOneDay` here is computed inside the closure — cannot reuse the `isSingleDay` from the component body because `useQuery` runs outside render scope. Keep both; they are consistent because both read `filters`.

- [ ] **Step 2: Add overflow warning banner**

In the JSX, right above the `<Card className="payments-table">` (around line 324), add:

```tsx
{
  payments.length >= 500 && (
    <div className="no-print rounded-lg bg-yellow-50 border border-yellow-200 p-3 text-sm text-yellow-800">
      Показват се първите 500 плащания. Ако денят има повече записи, сумите в
      обобщението може да не са пълни. Стеснете периода или филтрите.
    </div>
  );
}
```

- [ ] **Step 3: Verify via preview**

On `/payments`, the banner should be hidden when the dataset has < 500 rows. No easy way to test the banner without 500+ payments in the DB; verify the conditional renders nothing by snapshot (no "Показват се първите 500" text). Logic will be exercised manually in production if ever needed.

Run `npx tsc --noEmit` — no errors.

- [ ] **Step 4: Commit**

```bash
git add warehouse-frontend/src/pages/Payments.tsx
git commit -m "feat(payments): raise limit to 500 in daily mode with overflow warning"
```

---

## Task 8: "АНУЛИРАНА" tag on cancelled-document rows

**Files:**

- Modify: `warehouse-frontend/src/pages/Payments.tsx` (table row rendering around line 360-367)

**Why:** Spec §5.2 edge case — mark payments tied to a cancelled document visually.

- [ ] **Step 1: Add annulled tag to the document-number cell**

Inside the `payments.map((p) => (...))` row rendering (starts around line 359), find the first `<TableCell>` (the one with `font-mono text-[#f97316]`). Replace:

```tsx
<TableCell className="font-mono text-[#f97316]">
  {activeTab === "razpiska"
    ? `#${p.order_number ?? p.order_id}`
    : (p.invoice?.invoice_number ?? p.invoice_number ?? `#${p.invoice_id}`)}
</TableCell>
```

with:

```tsx
<TableCell className="font-mono text-[#f97316]">
  {(() => {
    const isCancelled =
      activeTab === "razpiska"
        ? p.order_status === "cancelled"
        : p.invoice_status === "cancelled";
    const label =
      activeTab === "razpiska"
        ? `#${p.order_number ?? p.order_id}`
        : (p.invoice?.invoice_number ?? p.invoice_number ?? `#${p.invoice_id}`);
    return (
      <span className={isCancelled ? "line-through text-gray-400" : ""}>
        {label}
        {isCancelled && (
          <Badge variant="destructive" className="ml-2 no-print-inline">
            АНУЛИРАНА
          </Badge>
        )}
      </span>
    );
  })()}
</TableCell>
```

**Note:** The `destructive` variant must already exist in the Badge component. Verify quickly:

Run: `grep -n "destructive" warehouse-frontend/src/components/ui/badge.tsx`

If `destructive` is NOT a variant, use `warning` instead (which is confirmed to exist from the existing code).

- [ ] **Step 2: Verify via preview**

Snapshot `/payments`. Rows tied to cancelled invoices (if any exist in the dev DB) must show "АНУЛИРАНА" badge. Rows for active documents must remain unchanged.

If no cancelled documents exist in dev, manually cancel one invoice via the Invoices page, then refresh `/payments` and verify the tag appears on its related payments.

- [ ] **Step 3: Commit**

```bash
git add warehouse-frontend/src/pages/Payments.tsx
git commit -m "feat(payments): tag cancelled-document rows with АНУЛИРАНА badge"
```

---

## Task 9: Lint + typecheck + full manual smoke test

**Files:** None (verification only)

- [ ] **Step 1: Lint**

Run: `cd warehouse-frontend && npm run lint`
Expected: no errors.

- [ ] **Step 2: Typecheck**

Run: `cd warehouse-frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Backend typecheck**

Run: `cd warehouse-backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Backend tests**

Run: `cd warehouse-backend && npm test`
Expected: all tests pass.

- [ ] **Step 5: Manual checklist via preview**

Using preview tools:

1. Click "Днес" → both date filters set to today. Click snapshot — filter inputs populated.
2. Snapshot summary — 4 cards visible (Деня, В брой, По банка, Общо). Values `cash + bank = total`.
3. Clear filters (click "Изчисти филтрите") → snapshot — 3 cards again (Получени, Чакащи, Общо).
4. Click "Принтирай отчет" (use `preview_eval` with `document.querySelector('button:has(svg[class*="printer"])')?.click()` or find via snapshot UID). Browser print dialog will open — this is expected.
5. Unlock the razpiska tab via `preview_eval`: `sessionStorage.setItem('razpiska_tab_unlocked', 'true'); window.location.reload()`. Snapshot — "По разписки" tab visible. Click it, click "Днес", verify summary cards and print button.

- [ ] **Step 6: Print preview visual check (manual, in real browser)**

Open Chrome at `http://localhost:5174/payments`, click "Днес", then "Принтирай отчет". In the system print dialog:

- Page header: "МЕРТ-М — Дневен отчет (Фактурни) — DD.MM.YYYY"
- Summary 4 cards visible
- Table of payments visible
- Footer: "Отпечатано на DD.MM.YYYY HH:MM"
- NO sidebar, NO app header, NO filter card, NO buttons
- A4 portrait, fits on page

Repeat for "По разписки" tab.

- [ ] **Step 7: Final commit (empty, marks feature complete)**

Nothing new to commit — this is a verification-only task. Skip the commit step.

---

## Success Criteria (from spec §7)

- [x] Admin clicks "Днес" → today's payments filtered. _(Task 3)_
- [x] Split summary shows cash / bank / total correctly. _(Task 4)_
- [x] "Принтирай отчет" produces a clean A4 report without app chrome. _(Tasks 5, 6)_
- [x] Both "Фактурни" and "По разписки" tabs work independently. _(Tasks 5, 6 — tab-aware title)_
- [x] `npm run lint` and `npx tsc --noEmit` in `warehouse-frontend` — зелено. _(Task 9)_
- [x] Backend tests — зелено. _(Tasks 1, 9)_
