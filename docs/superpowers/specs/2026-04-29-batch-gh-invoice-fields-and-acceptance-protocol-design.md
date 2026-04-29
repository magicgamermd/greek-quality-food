# Batch G+H — Invoice fields & Acceptance protocol design

**Date:** 2026-04-29
**Status:** Approved (brainstorm complete, ready for implementation plan)
**Scope:** Combined batch — two invoice PDF tweaks (G) plus a new
"Приемо-предавателен протокол" document (H). Bundled because all three
features touch PDF generation and are individually small.

---

## Understanding Summary

**Batch G:**

1. **VAT exemption legal text** on invoices — when an invoice is issued
   without VAT (включително EU reverse charge), the printed PDF must
   show the legal basis (e.g. "Освободена доставка по чл. 28 ЗДДС"). A
   new field on the invoice dialog accepts free text but offers a
   dropdown of pre-defined common reasons.

2. **Free text on invoice** — for cases like "по проект X" or
   "съгласно договор от 15.04.2026". A separate `invoices.invoice_note`
   column + textarea in the invoice-generating dialog.

**Batch H — Acceptance protocol PDF:**

- New PDF document type "Приемо-предавателен протокол".
- New button in the drawer's "ДОКУМЕНТИ" row, next to Стокова
  разписка / Търговски документ / Гаранция.
- Clicking opens a dialog with pre-filled fields (buyer, seller,
  place, date, items) which the user can override before download.
- PDF is generated on-demand; not persisted in DB.

**Why:**

- BG legal requirements (ЗДДС чл. 114) — the legal basis for VAT
  exemption must be printed on the invoice.
- Project-based customers expect "по проект …" on the invoice.
- Acceptance protocol is a standard handover document; customers
  expect to receive it.

**For whom:** Internal team with `ORDERS_MANAGE` (admin, sales,
warehouse).

**Key constraints:**

- VAT exemption + invoice_note are **preserved** through invoice
  regenerate (same pattern as `payment_method` / `include_vat`).
- VAT exemption applies to credit notes too (overrides the existing
  default).
- Acceptance protocol does NOT deduct stock or change order status.

**Non-goals:**

- No auto-detection of EU partners by VAT number — user picks the
  exemption reason explicitly.
- No template editor for the protocol — fixed layout.
- No digital signatures — handwritten on the printed copy.

---

## Assumptions

1. `invoice-pdf.ts` already has `vat_exemption_reason` and
   `transaction_basis` in its interface; the rendering code reads them
   with a fallback. The only missing piece is **persistence** — a DB
   column + write path.
2. Predefined VAT exemption list is small (4–6 options) and lives as a
   shared constant in code (like `INVOICE_PAYMENT_METHODS`) — not a
   separate DB table.
3. `invoices.invoice_note` is `TEXT NULL`; not related to
   `orders.notes` (which stays internal).
4. Acceptance protocol generates a PDF on demand; not persisted in
   `_documents` or similar. Re-generation produces the same content
   if inputs are identical.
5. `ORDERS_MANAGE` is the only required permission; no new permission.
6. Protocol's pre-filled values come from:
   - Buyer: `partner.name`, `partner.contact_person`, `partner.eik`
   - Seller: company settings (`getCompanySettings`)
   - Place: `company.city` default
   - Date: today
   - Items: from order_items (with snapshot names if Batch B is
     merged)

---

## Decision Log

| #   | Decision                                                | Alternatives                                        | Reason                                                                    |
| --- | ------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | VAT exemption: input + datalist suggestions + free text | Free text only; multi-select from full ЗДДС catalog | Standardisation for popular cases + flexibility for edge cases            |
| 2   | Free text = separate `invoice_note` column              | Reuse `orders.notes`; both                          | Clean public-on-PDF vs internal-note separation; consistent regen pattern |
| 3   | Protocol pre-filled + manual override dialog            | Blank lines; pre-filled without override            | Flexibility for situational tweaks                                        |
| 4   | `ORDERS_MANAGE` permission (existing)                   | New permission                                      | Consistency with other documents                                          |
| 5   | Protocol PDF on-demand (no DB tracking)                 | Persist each generated PDF                          | YAGNI — user prints, signs, files; no need for system-side history        |

---

## Final Design

### DB migration (058)

```sql
-- 058_invoice_extra_fields.sql
-- Adds two persistence columns to invoices for legal/free-text needs.

BEGIN;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS vat_exemption_reason TEXT,
  ADD COLUMN IF NOT EXISTS invoice_note TEXT;

COMMIT;
```

No new tables for the protocol (generated on demand, not stored).

### Backend — VAT exemption suggestions constant

Create a shared constant `warehouse-backend/src/lib/vat-exemption-reasons.ts`:

```ts
export const VAT_EXEMPTION_REASONS: ReadonlyArray<string> = [
  "Освободена доставка по чл. 28 ЗДДС",
  "Вътрешнообщностна доставка по чл. 173 ЗДДС",
  "EU reverse charge / обратно начисляване",
  "Освободена доставка по чл. 38 ЗДДС",
  "Освободена доставка по чл. 39 ЗДДС",
] as const;
```

Mirror it in `warehouse-frontend/src/lib/vatExemptionReasons.ts`. Used
as the `<datalist>` source on the frontend dialog and as a server-side
validator-friendly hint (no strict enforcement — free text accepted).

### Backend — invoices.ts schema + INSERT/UPDATE

Extend `createInvoiceSchema` with two new optional fields:

```ts
const createInvoiceSchema = z.object({
  // …existing…
  vat_exemption_reason: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((v) => (v && v.length > 0 ? v : null)),
  invoice_note: z
    .string()
    .trim()
    .max(2000)
    .nullish()
    .transform((v) => (v && v.length > 0 ? v : null)),
});
```

POST /invoices INSERT — add the two columns to INSERT and to the
`generateInvoicePdf({invoice: …})` data passed to PDF service.

`regenerateInvoiceSchema` — same two new optional fields. UPDATE
preserves existing values when the field is absent
(`COALESCE($X, vat_exemption_reason)` pattern).

### Backend — Acceptance protocol service

Create `warehouse-backend/src/services/protocol-pdf.ts` modelled on
`warranty-pdf.ts`. Standard layout:

```
              ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ
              № PR-{order_number padded to 7}

Място: {place}                    Дата: {date}

Долуподписаните:

Предал:  {seller_name}, {seller_eik},
         представляван от {seller_rep}

Приел:   {buyer_name}, {buyer_eik},
         представляван от {buyer_rep}

С настоящия протокол страните установяват, че Предал предаде, а
Приел прие следните стоки/услуги съгласно поръчка
№ {order_number}, фактура № {invoice_number} (ако е издадена) /
стокова разписка № {stock_dispatch_number}:

┌─────────────────────────┬──────┬─────────┬─────────┐
│ Артикул                 │ К-во │ Ед.цена │ Сума    │
├─────────────────────────┼──────┼─────────┼─────────┤
│ ...                     │  ... │ ...     │ ...     │
└─────────────────────────┴──────┴─────────┴─────────┘

Общо: {total} EUR

Стоките са приети без забележки.

Предал: ___________________      Приел: ___________________
        (подпис)                          (подпис)
```

### Backend — `/orders/:id/protocol-pdf` endpoint

Modelled after `/orders/:id/warranty-pdf`. Accepts query params for
manual overrides:

- `?place=…` → overrides place
- `?date=YYYY-MM-DD` → overrides date
- `?seller_rep=…` / `?buyer_rep=…` → override representative names

The frontend sends these from the override dialog.

### Frontend — Invoice dialog tweaks (Batch G UI)

In Orders.tsx — extend the invoice-generating dialog (where ДДС /
Плащане toggles live). Add:

1. **Свободен текст към фактура** (textarea, optional, max 2000)
2. **Основание (без ДДС)** (input + datalist, only shown when
   `includeVat === false`)

Wire into `invoiceMutation`:

```ts
api.post("/invoices", {
  // …existing…
  vat_exemption_reason: vatExemptionReason || undefined,
  invoice_note: invoiceNote || undefined,
});
```

The same fields appear in the **regenerate** flow with current values
pre-loaded. Edit lets the user change before re-issuing.

### Frontend — Acceptance protocol dialog (Batch H UI)

New button in Документи row:

```tsx
<Button onClick={() => setProtocolOpen(true)}>
  <FileSignature className="h-4 w-4" />
  Приемо-предавателен
</Button>
```

Dialog (similar to invoice-generating dialog):

- Place input (default: company.city)
- Date input (default: today)
- Seller rep input (default: company.mol or company contact)
- Buyer rep input (default: partner.contact_person)
- Items preview (read-only — shows the order's items)
- Bottom: cancel + "Свали PDF" buttons

On submit: navigate to
`/api/orders/{id}/protocol-pdf?place=…&date=…&seller_rep=…&buyer_rep=…`
which triggers a download.

### Test strategy

**Backend:**

- `POST /invoices` with `vat_exemption_reason` + `invoice_note` →
  fields persist; PDF data includes them.
- `PUT /invoices/:id/regenerate` without these fields → DB values
  preserved.
- `GET /orders/:id/protocol-pdf` → 200 + content-type `application/pdf`.
- Protocol endpoint with overrides → PDF generated (smoke test only;
  visual verification manual).

**Frontend:** manual smoke tests — see plan.

---

## Non-Functional Requirements

- **Performance:** trivial — 2 columns + 1 endpoint
- **Scale:** no impact
- **Security:** standard `ORDERS_MANAGE`; no new attack surface
- **Reliability:** stateless PDF generation; atomic invoice writes
- **Maintenance:** +1 migration, +1 PDF service, +1 endpoint, +2
  invoice fields, +1 dialog, +1 button. Small surface.

---

## Implementation Plan

(Generated next by `writing-plans` skill.)
