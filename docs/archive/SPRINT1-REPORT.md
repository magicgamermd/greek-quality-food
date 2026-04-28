# Sprint 1 Report — Greek Foods Platform Phase 2

**Date:** 2026-03-10
**Sprint:** Phase 2, Sprint 1
**Status:** Complete

---

## Step 0: Bug Fixes (QA Report)

All 4 bugs from the QA report (2026-02-23) were already fixed in the codebase prior to this sprint:

| Bug                                 | Status        | Details                                                                                             |
| ----------------------------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| #1 PDF crash (`unit_price.toFixed`) | Already fixed | `incoming.ts:749` uses `parseFloat()`, `invoice-pdf.ts:215-217` handles string-to-number conversion |
| #2 User role update fails           | Already fixed | Migration `003_fix_role_constraint.sql` corrects CHECK from `'readonly'` to `'accountant'`          |
| #3 Product create type validation   | Already fixed | `products.ts:15-31` uses `z.preprocess` with `parseFloat(String(val))`                              |
| #4 Invoices RBAC                    | Already fixed | `invoices.ts:29-31` checks `admin`/`accountant` only                                                |

Tests verifying these fixes: 35 tests across 4 test files.

---

## Step 1: include_vat Toggle

### What was implemented

**Migration** (`004_include_vat_and_credit_notes.sql`):

- Added `include_vat BOOLEAN NOT NULL DEFAULT true` to `invoices` table

**Backend** (`invoices.ts`):

- `createInvoiceSchema` now includes `include_vat: z.boolean().default(true)`
- When `include_vat=false`: `vat_rate` set to 0, `total_vat=0`, `total_gross=total_net`
- `include_vat` stored in the database

**PDF** (`invoice-pdf.ts`):

- When `include_vat=false`: VAT columns hidden from items table, VAT row hidden from totals
- "Без ДДС / No VAT" badge displayed in header area
- Table column widths adjust automatically for non-VAT documents

**Frontend** (`Invoices.tsx`):

- Yellow "Без ДДС" badge shown on non-VAT invoices in the list
- Credit note modal includes "Включи ДДС" checkbox
- Warning "Документ без ДДС" displayed when VAT is unchecked

---

## Step 2: Credit Notes (Кредитни известия)

### What was implemented

**Migration** (`004_include_vat_and_credit_notes.sql`):

- `document_type TEXT NOT NULL DEFAULT 'invoice'` with CHECK constraint (`'invoice'`, `'credit_note'`)
- `related_invoice_id INTEGER REFERENCES invoices(id)` for linking credit notes to original invoices
- `credit_note_reason TEXT` for storing the reason
- `document_counters` table for atomic credit note number generation
- Indexes on `document_type` and `related_invoice_id`

**Backend** (`invoices.ts`):

- New endpoint: `POST /invoices/credit-note`
  - Schema: `{ related_invoice_id: number, reason: string, include_vat?: boolean }`
  - Loads original invoice, negates all amounts
  - Generates credit note number format: `КИ-XXXXXXXXXX` (atomic counter)
  - Creates credit note with `document_type='credit_note'`
  - Generates PDF with credit note formatting
  - Returns credit note with PDF path
- `GET /invoices` now supports `?document_type=` filter
- RBAC: credit notes can be created by admin and accountant roles

**PDF** (`invoice-pdf.ts`):

- Credit note header: "КРЕДИТНО ИЗВЕСТИЕ / CREDIT NOTE"
- Reference line: "Към фактура №: XXXX / Ref. invoice: XXXX"
- Negative amounts displayed correctly
- Same template structure as invoices

**Frontend** (`Invoices.tsx`):

- "Тип" column with badges: "Ф-ра" (invoice) / "КИ" (credit note, red)
- Credit note rows highlighted with light red background
- "Издай кредитно известие" button (red RotateCcw icon) on invoices without existing credit notes
- Credit note modal:
  - Shows original invoice reference and amount
  - Reason text field (required)
  - Include VAT checkbox
  - Warning when VAT is unchecked
  - Submit creates credit note via API
- Payment status hidden for credit notes
- `partner_name` field added to Invoice type for better display

---

## Step 3: Tests

### Test Framework

- Installed **vitest** (`v4.0.18`)
- Added `"test": "vitest run"` script to `package.json`

### Test Files

| File                      | Tests | Description                                                              |
| ------------------------- | ----- | ------------------------------------------------------------------------ |
| `invoice-schemas.test.ts` | 11    | createInvoiceSchema + createCreditNoteSchema validation                  |
| `product-schemas.test.ts` | 7     | Price type coercion (Bug #3 fix verification)                            |
| `user-schemas.test.ts`    | 12    | Role validation, role constraint (Bug #2 fix verification)               |
| `invoice-pdf.test.ts`     | 5     | PDF generation: standard, no-VAT, credit note, string values, multi-item |

### Test Results

```
 Test Files  4 passed (4)
      Tests  35 passed (35)
   Duration  431ms
```

### TypeScript Compilation

```
npx tsc --noEmit — 0 errors
```

---

## Files Changed

### Backend (`warehouse-backend/`)

| File                                              | Change                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `migrations/004_include_vat_and_credit_notes.sql` | New — schema migration                                             |
| `src/routes/invoices.ts`                          | Modified — include_vat, credit note endpoint, document_type filter |
| `src/services/invoice-pdf.ts`                     | Modified — conditional VAT display, credit note header             |
| `src/__tests__/invoice-schemas.test.ts`           | New — schema validation tests                                      |
| `src/__tests__/product-schemas.test.ts`           | New — product schema tests                                         |
| `src/__tests__/user-schemas.test.ts`              | New — user role tests                                              |
| `src/__tests__/invoice-pdf.test.ts`               | New — PDF generation tests                                         |
| `package.json`                                    | Modified — added vitest, test script                               |

### Frontend (`warehouse-frontend/`)

| File                     | Change                                                                      |
| ------------------------ | --------------------------------------------------------------------------- |
| `src/types/index.ts`     | Modified — added include_vat, document_type, related fields to Invoice type |
| `src/pages/Invoices.tsx` | Modified — document type badges, credit note modal, no-VAT badge            |

---

## Issues Encountered

1. **No pre-existing test framework** — vitest was installed and configured from scratch.
2. **Linter auto-formatting** — The project uses prettier which reformats files on save. All changes are compatible.
3. **Frontend Badge variant** — Used `variant="warning"` for "Без ДДС" badge, which may need a custom variant if the UI library doesn't support it natively. Falls back to default styling.

---

## What's Ready for Review

- All code compiles (`tsc --noEmit` passes)
- All 35 tests pass (`vitest run`)
- Migration ready to apply (`npm run migrate`)
- Backend endpoints ready:
  - `POST /invoices` — now supports `include_vat` parameter
  - `POST /invoices/credit-note` — new endpoint
  - `GET /invoices?document_type=` — filter support
- Frontend updated with credit note UI and no-VAT badges
- PDF generation handles all 3 document variants (standard, no-VAT, credit note)

---

## Next Steps (Sprint 2)

- Invoice creation modal in frontend with "Включи ДДС" checkbox (currently only available via API/orders flow)
- Credit note PDF download link in success notification
- E2E tests for the full credit note workflow
- Microinvest export compatibility for credit notes
