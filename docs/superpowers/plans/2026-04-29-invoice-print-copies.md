# Invoice Print Copies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 1-or-2-copies dropdown to the invoice „Отвори"/„Принтирай" button. Default = 1 copy. When 2 are printed, both pages are labeled „Оригинал". Email always sends 1 copy.

**Architecture:** Extend `generateInvoicePdf()` with a `copies?: 1 | 2` parameter (default `1`). Add `?copies={1,2}` query parameter to `GET /invoices/:id/pdf` — `copies=1` serves the cached on-disk file, `copies=2` regenerates in-memory without writing. Cache only the 1-page version on disk. Frontend converts the existing print buttons to split buttons (main action + chevron dropdown).

**Tech Stack:** Fastify + TypeScript + pdfkit (backend); React + Vite + shadcn/ui DropdownMenu (frontend); Vitest for tests.

**Spec:** [docs/superpowers/specs/2026-04-29-invoice-print-copies-design.md](../specs/2026-04-29-invoice-print-copies-design.md)

**Branch:** Create `feature/MERTM-invoice-print-copies` from current branch. (We are still on `feature/MERTM-tester-attachments-buttons`; the spec is already committed there. The implementation can branch off from this one or from `main` after the spec is merged.)

---

## File Structure

**Backend (modify):**

- `warehouse-backend/src/services/invoice-pdf.ts` — add `copies` to `GenerateInvoicePdfArgs`, conditionally render second page with „Оригинал" label.
- `warehouse-backend/src/routes/invoices.ts` — add `?copies` query parsing + validation to `GET /:id/pdf`; for `copies=2` generate to a temp path then read into a buffer (or stream directly).
- `warehouse-backend/src/__tests__/invoice-pdf.test.ts` — update existing tests (which assert page count == 2) to reflect new default of 1; add new tests for `copies=1` and `copies=2` behavior.
- `warehouse-backend/src/__tests__/invoice-pdf-individual.test.ts` — same update if it asserts page count.

**Backend (new):**

- `warehouse-backend/src/__tests__/invoices-pdf-route.test.ts` — new file. Tests `GET /invoices/:id/pdf?copies=...` with valid + invalid values.

**Frontend (modify):**

- `warehouse-frontend/src/pages/Orders.tsx` — `openInvoicePdf` accepts optional `copies`; replace „Отвори" button with split-button component using existing `DropdownMenu`.
- `warehouse-frontend/src/pages/Invoices.tsx` — same treatment for the „Принтирай" printer-icon button (`handlePrint`).

**No new files on frontend** — we inline the split button in both pages because it's a 30-line block and only used in 2 places. If a third caller appears later, extract to a shared component then.

---

## Task 1: Update existing PDF tests for new 1-page default

**Why first:** TDD — we change tests to describe the desired behavior, watch them fail, then make them pass in Task 2.

**Files:**

- Modify: `warehouse-backend/src/__tests__/invoice-pdf.test.ts`
- Modify: `warehouse-backend/src/__tests__/invoice-pdf-individual.test.ts` (only if it asserts on page count — verify first)

- [ ] **Step 1: Inspect `invoice-pdf-individual.test.ts` for page-count assertions**

Run: `grep -n "PageCount\|pages" warehouse-backend/src/__tests__/invoice-pdf-individual.test.ts`

Expected: Note any `expect(...PageCount...).toBe(2)` lines. If none, this file is unaffected.

- [ ] **Step 2: Update default-behavior tests in `invoice-pdf.test.ts`**

Replace the 4 assertions of `toBe(2)` with `toBe(1)` (lines 81, 92, 119, 166 in the current file) **except** the one on line 192 which is in the test that explicitly verifies the two-copy rendering — that test will be rewritten in Step 3 below.

The 4 to change are in:

- "generates standard, no-VAT, and credit note PDFs" — 3 assertions (lines 81, 92, 119) → `toBe(1)`
- "handles string number values and multiple items" — 1 assertion (line 166) → `toBe(1)`

Also keep the test "keeps long buyer and supplier headers stable without extra pages" (line 255: `toBe(2)`) — this currently asserts 2 pages because the OLD default produces 2. After our change, with default `copies=1` it will produce 1 page. **Change this to `toBe(1)`** as well.

The wrapped-descriptions test (lines 291-293) asserts `> 2` pages because long content overflows. This still needs to be true — but with default `copies=1`, the overflow may produce different page counts. **Update to: `expect(pageCount).toBeGreaterThanOrEqual(2); expect(pageCount).toBeLessThanOrEqual(4);`** (a single 1-copy invoice with overflow may take 2-4 pages).

- [ ] **Step 3: Rewrite the „original/copy" test for the new semantics**

Find the test starting at line 169: `"renders original and plain invoice copies in a single two-page PDF"`. Replace the entire `it(...)` block with two new tests:

```typescript
  it("renders a single page labeled „Оригинал" by default (copies=1)", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(TEST_OUTPUT_DIR, "single-copy.pdf");
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    let renderedStrings: string[] = [];

    try {
      await generateInvoicePdf(getTestData({ outputPath }));
      renderedStrings = textSpy.mock.calls
        .map(([text]) => (typeof text === "string" ? text : String(text ?? "")))
        .filter(Boolean);
    } finally {
      textSpy.mockRestore();
    }

    expect(getPdfPageCount(outputPath)).toBe(1);
    expect(renderedStrings).toContain("Оригинал");
  });

  it("renders two „Оригинал" pages when copies=2", async () => {
    fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(TEST_OUTPUT_DIR, "two-copies.pdf");
    const textSpy = vi.spyOn(PDFDocument.prototype, "text");
    let renderedStrings: string[] = [];

    try {
      await generateInvoicePdf(getTestData({ outputPath, copies: 2 }));
      renderedStrings = textSpy.mock.calls
        .map(([text]) => (typeof text === "string" ? text : String(text ?? "")))
        .filter(Boolean);
    } finally {
      textSpy.mockRestore();
    }

    const originalLabels = renderedStrings.filter((s) => s === "Оригинал");
    expect(originalLabels.length).toBe(2);
    expect(getPdfPageCount(outputPath)).toBe(2);
  });
```

The key invariant: in the `copies=2` test we assert **exactly two** „Оригинал" labels (one per page) — this guards against the previous behavior where the second page had `null` label.

- [ ] **Step 4: Run the updated tests — verify they FAIL**

Run: `cd warehouse-backend && pnpm vitest run src/__tests__/invoice-pdf.test.ts`

Expected: Failures because the implementation still hardcodes 2 pages and only the first has „Оригинал". The error messages should mention page-count mismatches and the new test for `copies=2` will fail because the parameter doesn't exist yet.

- [ ] **Step 5: Commit the failing tests**

```bash
git add warehouse-backend/src/__tests__/invoice-pdf.test.ts
# Add invoice-pdf-individual.test.ts only if Step 1 found assertions to change
git commit -m "test(invoice-pdf): describe new default of 1 copy + copies=2 with two Оригинал pages

Tests fail until generateInvoicePdf() accepts a copies parameter (Task 2)."
```

---

## Task 2: Add `copies` parameter to `generateInvoicePdf()`

**Files:**

- Modify: `warehouse-backend/src/services/invoice-pdf.ts` — interface `GenerateInvoicePdfArgs` + lines 1128-1130

- [ ] **Step 1: Locate and read the current rendering block**

Run: `sed -n '680,700p;1120,1135p' warehouse-backend/src/services/invoice-pdf.ts`

Expected output includes the `GenerateInvoicePdfArgs` interface (around line 680-700) and the trailing `renderCopy("Оригинал"); doc.addPage(...); renderCopy(null);` block (lines 1128-1130).

- [ ] **Step 2: Add `copies` to the args interface**

Find `interface GenerateInvoicePdfArgs` (around line 680-700 — exact line shown by Step 1). Add this field:

```typescript
  /**
   * Number of identical „Оригинал"-labeled pages to render. Default `1`.
   * When `2`, both pages get the „Оригинал" label.
   */
  copies?: 1 | 2;
```

- [ ] **Step 3: Destructure `copies` from args with default**

Find where the function `generateInvoicePdf` destructures its argument (search for `function generateInvoicePdf` or `export async function generateInvoicePdf`). In the destructuring, add `copies = 1`:

```typescript
export async function generateInvoicePdf({
  invoice,
  partner,
  // ... existing fields
  copies = 1,
}: GenerateInvoicePdfArgs) {
```

If destructuring uses positional/object access instead of inline destructuring, use `const copies = args.copies ?? 1;` near the top of the function body.

- [ ] **Step 4: Replace the hardcoded two-page render block**

Locate `invoice-pdf.ts:1128-1130`:

```typescript
renderCopy("Оригинал");
doc.addPage({ size: "A4", margins: pageMargins });
renderCopy(null);
```

Replace with:

```typescript
renderCopy("Оригинал");
if (copies === 2) {
  doc.addPage({ size: "A4", margins: pageMargins });
  renderCopy("Оригинал");
}
```

- [ ] **Step 5: Run unit tests — verify they PASS**

Run: `cd warehouse-backend && pnpm vitest run src/__tests__/invoice-pdf.test.ts`

Expected: All tests pass, including the two new ones from Task 1.

- [ ] **Step 6: Run the full backend test suite — verify no regressions**

Run: `cd warehouse-backend && pnpm vitest run`

Expected: All tests pass. If `invoice-pdf-individual.test.ts` or any other test fails because it depended on the old 2-page default, fix the assertion to expect 1 page (the new default). Re-run.

- [ ] **Step 7: Commit**

```bash
git add warehouse-backend/src/services/invoice-pdf.ts
git commit -m "feat(invoice-pdf): add copies parameter (1 or 2), both pages labeled Оригинал

Default is 1 copy. When copies=2, both pages render with Оригинал label
(replacing the previous 1 Оригинал + 1 unlabeled behavior)."
```

---

## Task 3: Add `?copies` query parameter to `GET /invoices/:id/pdf`

**Files:**

- Modify: `warehouse-backend/src/routes/invoices.ts` — `GET /:id/pdf` handler (around line 730)
- Create: `warehouse-backend/src/__tests__/invoices-pdf-route.test.ts`

- [ ] **Step 1: Read the current `GET /:id/pdf` handler**

Run: `sed -n '725,870p' warehouse-backend/src/routes/invoices.ts`

Expected: handler that streams `pdf_path` from disk, regenerating to disk if missing. Note the exact line numbers — they will shift slightly after edit.

- [ ] **Step 2: Write a failing test for the new behavior**

Create `warehouse-backend/src/__tests__/invoices-pdf-route.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";
import { signTestToken } from "./helpers/auth.js";
import { resetTestDb, seedInvoiceWithPdf } from "./helpers/db.js";

describe("GET /invoices/:id/pdf — copies query parameter", () => {
  let app: FastifyInstance;
  let token: string;
  let invoiceId: number;

  beforeAll(async () => {
    await resetTestDb();
    app = await buildApp();
    token = signTestToken({ role: "admin" });
    invoiceId = await seedInvoiceWithPdf();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 1-page PDF when no query is given (default)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/invoices/${invoiceId}/pdf`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    const pageCount = (
      res.rawPayload.toString("latin1").match(/\/Type\s*\/Page\b/g) || []
    ).length;
    expect(pageCount).toBe(1);
  });

  it("returns 1-page PDF when copies=1", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/invoices/${invoiceId}/pdf?copies=1`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const pageCount = (
      res.rawPayload.toString("latin1").match(/\/Type\s*\/Page\b/g) || []
    ).length;
    expect(pageCount).toBe(1);
  });

  it("returns 2-page PDF when copies=2 without rewriting on-disk cache", async () => {
    const fs = await import("node:fs");
    const { rows } = await (
      await import("../lib/pg.js")
    ).pool.query("SELECT pdf_path FROM invoices WHERE id = $1", [invoiceId]);
    const diskPath = rows[0].pdf_path as string;
    const sizeBefore = fs.statSync(diskPath).size;

    const res = await app.inject({
      method: "GET",
      url: `/invoices/${invoiceId}/pdf?copies=2`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const pageCount = (
      res.rawPayload.toString("latin1").match(/\/Type\s*\/Page\b/g) || []
    ).length;
    expect(pageCount).toBe(2);

    // On-disk cache must still be the 1-page version
    const sizeAfter = fs.statSync(diskPath).size;
    expect(sizeAfter).toBe(sizeBefore);
    const cachedPageCount = (
      fs.readFileSync(diskPath, "latin1").match(/\/Type\s*\/Page\b/g) || []
    ).length;
    expect(cachedPageCount).toBe(1);
  });

  it("returns 400 when copies is not 1 or 2", async () => {
    for (const bad of ["0", "3", "99", "abc", "-1"]) {
      const res = await app.inject({
        method: "GET",
        url: `/invoices/${invoiceId}/pdf?copies=${bad}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toMatch(/copies/i);
    }
  });
});
```

**Note for engineer:** the helpers `signTestToken`, `resetTestDb`, and `seedInvoiceWithPdf` should already exist in `warehouse-backend/src/__tests__/helpers/`. If `seedInvoiceWithPdf` doesn't exist, look at how other route tests (e.g. `incoming-confirm-inventory.test.ts`) seed invoices and adapt — typically: insert a partner, insert an order, insert an invoice row, then call `generateInvoicePdf` to write a PDF and store its path in `invoices.pdf_path`. Place any new helper in `warehouse-backend/src/__tests__/helpers/db.ts`.

- [ ] **Step 3: Run the test — verify it fails**

Run: `cd warehouse-backend && pnpm vitest run src/__tests__/invoices-pdf-route.test.ts`

Expected: Failures — the route doesn't yet validate `copies`, doesn't generate 2-page on demand, and the default behavior may still serve 2-page PDFs from previously-cached files.

- [ ] **Step 4: Update the route handler**

In `warehouse-backend/src/routes/invoices.ts`, find the `GET /:id/pdf` handler (around line 730). Modify it as follows:

1. Add Zod schema for the query (or inline validation):

```typescript
import { z } from "zod";
// ... near the top of the file or before the route registration

const PdfQuerySchema = z.object({
  copies: z
    .union([z.literal("1"), z.literal("2")])
    .optional()
    .transform((v) => (v ? (Number(v) as 1 | 2) : 1)),
  t: z.string().optional(),
});
```

2. Inside the handler, parse and validate the query:

```typescript
const parsed = PdfQuerySchema.safeParse(request.query);
if (!parsed.success) {
  return reply
    .status(400)
    .send({ error: "Invalid copies value. Must be 1 or 2." });
}
const copies = parsed.data.copies; // 1 | 2
```

3. Branch the response logic:

```typescript
if (copies === 2) {
  // 2-copy path: generate to a temp file, stream it, then unlink.
  const tmpPath = path.join(
    os.tmpdir(),
    `mertm-invoice-${invoice.id}-2copies-${Date.now()}.pdf`,
  );
  await generateInvoicePdf({
    invoice,
    partner,
    company,
    items,
    vatRate: effectiveVatRate,
    includeVat,
    sourceCurrency,
    outputPath: tmpPath,
    copies: 2,
  });
  const buf = await fs.promises.readFile(tmpPath);
  await fs.promises.unlink(tmpPath).catch(() => {});
  return reply
    .header("Content-Type", "application/pdf")
    .header(
      "Content-Disposition",
      `inline; filename="${invoice.invoice_number}.pdf"`,
    )
    .send(buf);
}

// copies === 1 — existing logic: serve cached file or regenerate to disk
// ... (keep current code path unchanged, but ensure that any inline
// regeneration in this branch passes copies: 1 or omits it)
```

**Important:** ensure that wherever the existing `copies=1` branch calls `generateInvoicePdf()`, it either omits `copies` (defaults to 1) or passes `copies: 1` explicitly. The variable names in the current handler may differ — match what's already destructured for `partner`, `company`, etc.

4. Add imports at the top of the file if not already present:

```typescript
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
```

(Check existing imports first — most are likely already there.)

- [ ] **Step 5: Run the route tests — verify they PASS**

Run: `cd warehouse-backend && pnpm vitest run src/__tests__/invoices-pdf-route.test.ts`

Expected: All tests pass.

- [ ] **Step 6: Run full backend test suite — no regressions**

Run: `cd warehouse-backend && pnpm vitest run`

Expected: All green.

- [ ] **Step 7: Commit**

```bash
git add warehouse-backend/src/routes/invoices.ts warehouse-backend/src/__tests__/invoices-pdf-route.test.ts
# Also add helpers/db.ts if you added a seed helper
git commit -m "feat(invoices): add ?copies={1,2} query param to GET /invoices/:id/pdf

copies=1 (or absent) serves the cached on-disk PDF. copies=2 regenerates
in a temp file, streams it, and does not touch the on-disk cache.
Invalid values return 400."
```

---

## Task 4: Update `openInvoicePdf` helper in Orders.tsx to accept `copies`

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` — `openInvoicePdf` function (line 181) and its call sites

- [ ] **Step 1: Update the function signature**

Find `async function openInvoicePdf(invoiceId: number)` at line 181. Replace with:

```typescript
async function openInvoicePdf(
  invoiceId: number,
  copies: 1 | 2 = 1,
) {
```

- [ ] **Step 2: Pass `copies` into the request URL**

Inside the function (line 185), change:

```typescript
const res = await api.get(`/invoices/${invoiceId}/pdf?t=${Date.now()}`, {
```

to:

```typescript
const res = await api.get(
  `/invoices/${invoiceId}/pdf?copies=${copies}&t=${Date.now()}`,
  {
```

- [ ] **Step 3: Verify call sites still compile**

Run: `grep -n "openInvoicePdf(" warehouse-frontend/src/pages/Orders.tsx`

Expected callers (all should work because `copies` has a default):

- Line ~662: `setTimeout(() => void openInvoicePdf(newInvoiceId), 300);` → uses default `1`. ✓
- Line ~716: `setTimeout(() => void openInvoicePdf(cnId), 300);` → default `1`. ✓
- Line ~1375: `onClick={() => void openInvoicePdf(effectiveInvoiceId!)}` → will be replaced in Task 5.
- Line ~1416: `onClick={() => void openInvoicePdf(detail.credit_note_id!)}` → credit note, default `1`. ✓
- Line ~1490: `onClick={() => void openInvoicePdf(issuedCreditNoteId)}` → default `1`. ✓

- [ ] **Step 4: Type-check**

Run: `cd warehouse-frontend && pnpm tsc --noEmit`

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "refactor(orders): openInvoicePdf accepts optional copies (1 | 2)

Default = 1. Existing call sites continue to use the default; only the
manual „Отвори" button (Task 5) will pass an explicit value."
```

---

## Task 5: Convert „Отвори" button to split button in Orders.tsx

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` — the button block at lines 1373-1393

- [ ] **Step 1: Verify the DropdownMenu component is available**

Run: `cat warehouse-frontend/src/components/ui/dropdown-menu.tsx | head -20`

Expected: shadcn `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem` exports.

If the file doesn't exist, install via shadcn CLI: `cd warehouse-frontend && pnpm dlx shadcn@latest add dropdown-menu`. Then commit just the addition.

- [ ] **Step 2: Add imports at the top of `Orders.tsx`**

Find the existing UI imports (search for `from "@/components/ui/`). Add:

```typescript
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
```

(The existing file already imports `FileText`, `RefreshCw` etc. from lucide-react — append `ChevronDown` to the same import line if a single lucide import already exists.)

- [ ] **Step 3: Replace the „Отвори" button block**

Find lines 1373-1380 in `Orders.tsx`:

```tsx
<Button
  variant="outline"
  onClick={() => void openInvoicePdf(effectiveInvoiceId!)}
  className="border-[#f97316]/40 text-[#f97316] hover:bg-[#f97316]/5"
>
  <FileText className="h-4 w-4" />
  Отвори
</Button>
```

Replace with this split-button block:

```tsx
<div className="inline-flex">
  <Button
    variant="outline"
    onClick={() => void openInvoicePdf(effectiveInvoiceId!, 1)}
    className="border-[#f97316]/40 text-[#f97316] hover:bg-[#f97316]/5 rounded-r-none border-r-0"
    title="Принтирай 1 копие (Оригинал)"
  >
    <FileText className="h-4 w-4" />
    Отвори
  </Button>
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button
        variant="outline"
        className="border-[#f97316]/40 text-[#f97316] hover:bg-[#f97316]/5 rounded-l-none px-2"
        title="Избери брой копия"
        aria-label="Избери брой копия"
      >
        <ChevronDown className="h-4 w-4" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem
        onClick={() => void openInvoicePdf(effectiveInvoiceId!, 1)}
      >
        📄 1 копие (Оригинал)
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => void openInvoicePdf(effectiveInvoiceId!, 2)}
      >
        📄📄 2 копия (и двете Оригинал)
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</div>
```

- [ ] **Step 4: Type-check + lint**

Run: `cd warehouse-frontend && pnpm tsc --noEmit && pnpm lint`

Expected: Clean.

- [ ] **Step 5: Manual smoke test (the dev server is on port 5174)**

If the dev stack isn't running, start it: `./scripts/start-mertm.sh`

Open `http://localhost:5174/orders`, open an existing order with a fulfilled status, click the order row to open the detail modal. Verify:

1. The new split button appears in place of „Отвори".
2. Clicking the main part triggers a print preview with **1 page** (containing „Оригинал").
3. Clicking the chevron opens a dropdown with two items.
4. Selecting „2 копия" triggers a print preview with **2 pages** (both with „Оригинал").

If any of these fails, debug. The split button visual style should match the surrounding orange-outline buttons.

- [ ] **Step 6: Commit**

```bash
git add warehouse-frontend/src/pages/Orders.tsx
git commit -m "feat(orders): split-button Отвори with 1/2 copies dropdown

Main button prints 1 copy (default). Chevron dropdown lets the user
pick 2 copies; both pages render with Оригинал label."
```

---

## Task 6: Convert „Принтирай" icon button to split button in Invoices.tsx

**Files:**

- Modify: `warehouse-frontend/src/pages/Invoices.tsx` — `handlePrint` (line 332) and the button block (lines 780-793)

- [ ] **Step 1: Update `handlePrint` to accept `copies`**

Find `const handlePrint = async (invoice: Invoice) => {` at line 332. Replace with:

```typescript
const handlePrint = async (invoice: Invoice, copies: 1 | 2 = 1) => {
```

Inside, change line 335:

```typescript
const res = await api.get(`/invoices/${invoice.id}/pdf?t=${Date.now()}`, {
```

to:

```typescript
const res = await api.get(
  `/invoices/${invoice.id}/pdf?copies=${copies}&t=${Date.now()}`,
  {
```

- [ ] **Step 2: Add imports**

If not already present in `Invoices.tsx`, add to the existing UI/lucide import block:

```typescript
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
```

- [ ] **Step 3: Replace the printer-icon button block**

Find lines 780-793 in `Invoices.tsx`:

```tsx
<Tooltip content="Принтирай">
  <Button
    size="sm"
    variant="ghost"
    onClick={() => handlePrint(inv)}
    disabled={printingId === inv.id}
  >
    {printingId === inv.id ? (
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
    ) : (
      <Printer className="h-4 w-4" />
    )}
  </Button>
</Tooltip>
```

Replace with:

```tsx
<div className="inline-flex">
  <Tooltip content="Принтирай 1 копие">
    <Button
      size="sm"
      variant="ghost"
      onClick={() => handlePrint(inv, 1)}
      disabled={printingId === inv.id}
      className="rounded-r-none pr-1"
    >
      {printingId === inv.id ? (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
      ) : (
        <Printer className="h-4 w-4" />
      )}
    </Button>
  </Tooltip>
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button
        size="sm"
        variant="ghost"
        disabled={printingId === inv.id}
        className="rounded-l-none px-1"
        aria-label="Избери брой копия"
      >
        <ChevronDown className="h-3 w-3" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem onClick={() => handlePrint(inv, 1)}>
        📄 1 копие (Оригинал)
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => handlePrint(inv, 2)}>
        📄📄 2 копия (и двете Оригинал)
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</div>
```

- [ ] **Step 4: Type-check**

Run: `cd warehouse-frontend && pnpm tsc --noEmit`

Expected: Clean.

- [ ] **Step 5: Manual smoke test**

Open `http://localhost:5174/invoices`. Verify:

1. Each invoice row has the printer icon + a small chevron next to it.
2. Clicking the printer prints **1 page**.
3. Clicking the chevron → „2 копия" prints **2 pages**, both with „Оригинал".

- [ ] **Step 6: Commit**

```bash
git add warehouse-frontend/src/pages/Invoices.tsx
git commit -m "feat(invoices): split-button Принтирай with 1/2 copies dropdown

Mirrors the Orders modal split button. Default = 1 copy."
```

---

## Task 7: End-to-end manual verification

**Files:** none — verification only.

- [ ] **Step 1: Boot the full dev stack**

Run: `./scripts/start-mertm.sh --status` to confirm everything is up. If not: `./scripts/start-mertm.sh`.

- [ ] **Step 2: Verify auto-open after „Създай фактура"**

In the Orders page, find an order without an invoice, click „Създай фактура". Confirm the auto-printing PDF has **1 page** (regression check — the auto-open path uses the default).

- [ ] **Step 3: Verify „Регенерирай"**

Click „Регенерирай" on an existing invoice. Confirm:

a) The on-disk PDF is now 1-page (download via the disk path or by clicking „Отвори" with default).
b) Clicking the chevron → „2 копия" still produces a 2-page PDF (regenerated in-memory).

- [ ] **Step 4: Verify email sends 1 copy**

Click „Имейл" on an invoice. Open the inbox of the configured test recipient (or check the SMTP catcher / mail log used in dev — see `STATUS.md` for the dev mail setup). Confirm the attached PDF has **1 page**.

If no test inbox is set up, check the backend log: `tail -50 /tmp/mertm-backend.log` should show the SMTP send and the file size of the attachment, which can be cross-checked against the on-disk 1-page PDF.

- [ ] **Step 5: Old-cache regression check**

Find an invoice that existed before this change (its `pdf_path` on disk is the old 2-page format). Click „Отвори" — it should open the 2-page legacy file (no client-side error). Then click „Регенерирай" — verify the file becomes 1-page.

- [ ] **Step 6: No commit needed — verification only**

If everything passes, this task is done. If anything fails, file a bug and decide whether to fix in this branch or follow-up.

---

## Self-Review (already run)

**Spec coverage:**

- §2.Frontend (split button + dropdown + scope) → Tasks 4, 5, 6.
- §2.Backend (`copies` arg + `?copies` query) → Tasks 2, 3.
- §2.Backend (writes-to-disk callers use `copies=1`) → covered by default in Task 2; verified in Task 7 step 3.
- §3.Защо (default = 1 copy, both Оригинал) → Tasks 1, 2.
- §4 API contracts → Task 3 tests assert the contract.
- §5 Tests → Tasks 1, 3.
- §5 Edge cases → Task 7 verifies the legacy-cache case.
- §6 Backwards compat → Task 4 leaves all existing `openInvoicePdf` callers intact via the default parameter.

**Placeholder scan:** No TBDs, TODOs, or "implement appropriate X" — all code shown.

**Type consistency:** `copies?: 1 | 2` consistent across `GenerateInvoicePdfArgs`, `openInvoicePdf` signature, `handlePrint` signature, and the Zod schema. URL param uses string `"1" | "2"` and is parsed to number — explicitly handled in the Zod transform.

---

## Notes for the implementing engineer

- **Branch hygiene:** The current working branch is `feature/MERTM-tester-attachments-buttons`, which is for an unrelated feature. Before Task 1, create the new branch: `git checkout -b feature/MERTM-invoice-print-copies` from the current branch (or rebase later).
- **Test infra gaps:** If `seedInvoiceWithPdf` doesn't exist (Task 3 Step 2), look at how `incoming-confirm-inventory.test.ts` or `invoice-cancel.test.ts` seed invoices — copy that pattern. Don't invent new infra; reuse existing helpers.
- **DropdownMenu styling:** If the visual result doesn't match the surrounding orange-outline buttons exactly, tweak the Tailwind classes (`rounded-r-none border-r-0` etc.) — the goal is a flush split button with no visible gap between the two halves.
- **Permission gating:** The `GET /invoices/:id/pdf` endpoint already has permission middleware (INVOICES_VIEW). Task 3 must not remove or bypass it — add the query validation **after** the permission check.
- **No documentation updates needed** in this plan — `STATUS.md` will be updated as the last step after the feature merges (out of scope here).
