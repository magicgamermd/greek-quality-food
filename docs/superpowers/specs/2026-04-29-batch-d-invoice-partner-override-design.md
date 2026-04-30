# Batch D — Invoice partner override (individual → company) design

**Date:** 2026-04-29
**Status:** Approved (brainstorm complete, ready for implementation plan)
**Scope:** When generating an invoice for an order whose partner is an
individual (`partner_type='individual'`), allow the cashier to issue
the invoice in the name of a different (company) partner — picked from
the catalog or created on the fly. Order partner stays unchanged.

---

## Understanding Summary

**What we're building:** An optional "Издай на фирма" flow on the
invoice-generating dialog. Visible only when the order's partner is an
individual. Opens a sub-dialog with a partner combobox (search the
existing companies) plus an inline "+ Нов партньор" form (name, EIK,
VAT №, address, city). Backend `POST /invoices` accepts an
optional override; if set, the invoice's `partner_id` points to the
override (not to the order's partner). Order is left untouched.

**Why:** Real-world workflow at MERT-M: a private-individual customer
makes a purchase, takes the stock-dispatch slip home, and a week later
returns asking for a company invoice. Today there's no path — the
cashier would have to manually edit the invoice afterwards. With this
feature: search by article (Batch C) → open the order → click "Издай
на фирма" → pick or create the company → invoice is generated with the
new partner, new sequential number, and today's date.

**For whom:** Cashiers (`sales`) and admin. Anyone with
`INVOICES_MANAGE` permission (existing).

**Key constraints:**

- Option visible only for `partner_type='individual'` orders.
- Does NOT apply to invoice regeneration — once issued, the partner is
  locked.
- Order's `partner_id` does NOT change.
- Invoice's `partner_id` becomes the override.
- Duplicate avoidance: if the entered EIK matches an existing partner,
  reuse it instead of inserting a new row.

**Non-goals:**

- No B2B → B2B override.
- No partner change during regenerate.
- No audit log entry — the deviation is visible via
  `order.partner_id ≠ invoice.partner_id`.

---

## Assumptions

1. `invoices.partner_id` column already exists and is independent of
   `orders.partner_id` (verified).
2. `partners.eik` is the unique business identifier for companies.
   Schema may not enforce uniqueness; we add an application-level
   check before INSERT.
3. The smallest viable new-partner payload is `{ name, eik }`. Address,
   city, VAT № are optional but printed on the invoice when present.
4. `client_display_name` (the existing "buyer name override" field for
   individuals) is mutually exclusive with the partner override — if
   the new partner_id is set, `client_display_name` is forced to NULL.
5. Frontend invoice dialog already has the necessary state and
   mutation; we only add a sub-dialog and one new field in the request
   payload.

---

## Decision Log

| #   | Decision                                              | Alternatives                  | Reason                                                                   |
| --- | ----------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| 1   | Visible only for individual orders                    | All orders; only non-invoiced | Tight scope; B2B → B2B raises legal concerns                             |
| 2   | Hybrid combobox of existing partners + inline "+ Нов" | Only existing; only new       | Reuse + extension; standard workflow                                     |
| 3   | Order partner unchanged; invoice gets new partner_id  | Both updated; clone           | Historical accuracy: order = what happened in store; invoice = legal doc |
| 4   | Auto-reuse partner with matching EIK                  | Always insert new             | Avoids duplicates for repeat customers                                   |
| 5   | No partner override on regenerate                     | Allow override on regenerate  | Issued invoice's partner is a legal artefact — locked                    |

---

## Final Design

### DB

No new columns. Use the existing `invoices.partner_id`. Optional
data-quality improvement: ensure `partners.eik` has a partial unique
index on non-NULL values (out of scope for this batch — track
separately if duplicates are observed).

### Backend — schema extension

`createInvoiceSchema`:

```ts
partner_override: z
  .union([
    // Pick existing
    z.object({ partner_id: z.number().int() }),
    // Create new (or reuse by EIK)
    z.object({
      name: z.string().trim().min(1).max(255),
      eik: z.string().trim().min(1).max(50),
      vat_number: z.string().trim().max(50).optional(),
      address: z.string().trim().max(500).optional(),
      city: z.string().trim().max(100).optional(),
      contact_person: z.string().trim().max(255).optional(),
      phone: z.string().trim().max(50).optional(),
    }),
  ])
  .optional(),
```

`regenerateInvoiceSchema` — does NOT receive `partner_override`. If
present, it is rejected with 400 ("Cannot change partner on regenerate").

### Backend — POST /invoices flow

Inside the transaction, before INSERT into `invoices`:

```ts
let invoicePartnerId = order.partner_id;
let clientDisplayName = ...;  // existing logic

if (body.partner_override && partner.partner_type === "individual") {
  if ("partner_id" in body.partner_override) {
    invoicePartnerId = body.partner_override.partner_id;
  } else {
    // Upsert by EIK
    const eik = body.partner_override.eik.trim();
    const { rows: [existing] } = await client.query(
      `SELECT id FROM partners WHERE eik = $1 LIMIT 1`,
      [eik],
    );
    if (existing) {
      invoicePartnerId = existing.id;
    } else {
      const { rows: [created] } = await client.query(
        `INSERT INTO partners (name, eik, vat_number, address, city, contact_person, phone, partner_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'company')
         RETURNING id`,
        [
          body.partner_override.name.trim(),
          eik,
          body.partner_override.vat_number ?? null,
          body.partner_override.address ?? null,
          body.partner_override.city ?? null,
          body.partner_override.contact_person ?? null,
          body.partner_override.phone ?? null,
        ],
      );
      invoicePartnerId = created.id;
    }
  }
  // Override is mutually exclusive with client_display_name
  clientDisplayName = null;
}

// INSERT INTO invoices ... partner_id = invoicePartnerId ...
```

### Frontend — sub-dialog UI

In the invoice-generating dialog (Orders.tsx, where the ДДС / Плащане
toggles live):

When `detail.partner_partner_type === "individual"`, show a new
button:

```tsx
<Button variant="outline" onClick={() => setPartnerOverrideOpen(true)}>
  <Building2 className="h-4 w-4" />
  {partnerOverride ? "Фактура на: " + partnerOverride.name : "Издай на фирма"}
</Button>
```

Below it, when `partnerOverride` is set, a small read-only chip:

```tsx
{
  partnerOverride && (
    <div className="text-xs text-amber-700 bg-amber-50 px-2 py-1 rounded">
      Фактура на: {partnerOverride.name} (ЕИК {partnerOverride.eik})
      <button onClick={() => setPartnerOverride(null)}>×</button>
    </div>
  );
}
```

The sub-dialog (`<Dialog>`) contains:

```
┌─ Издай фактура на фирма ────────────────────┐
│ Партньор: [combobox …………] (search by name)│
│ ─── или ───                                  │
│ + Нов партньор                                │
│   Име:        [_____________________]        │
│   ЕИК:        [_____________________]        │
│   ДДС №:      [_____________________]        │
│   Адрес:      [_____________________]        │
│   Град:       [_____________________]        │
│   Контактно:  [_____________________]        │
│   Телефон:    [_____________________]        │
│                                              │
│ [Отказ]   [Запази]                           │
└──────────────────────────────────────────────┘
```

Selecting an existing partner from the combobox sets
`partnerOverride = { partner_id, name, eik }` and closes.

Filling the new-partner form sets `partnerOverride = { name, eik, ... }`
without `partner_id`.

The `invoiceMutation` payload includes:

```ts
partner_override: partnerOverride
  ? "partner_id" in partnerOverride
    ? { partner_id: partnerOverride.partner_id }
    : {
        name: partnerOverride.name,
        eik: partnerOverride.eik,
        vat_number: partnerOverride.vat_number,
        address: partnerOverride.address,
        city: partnerOverride.city,
        contact_person: partnerOverride.contact_person,
        phone: partnerOverride.phone,
      }
  : undefined,
```

After successful invoice generation, reset `setPartnerOverride(null)`.

### Test strategy

- Backend integration:
  - `POST /invoices` with `partner_override.partner_id` → invoice's
    partner_id is the override; order.partner_id unchanged.
  - `POST /invoices` with new-partner data, EIK matches existing → no
    INSERT, reuses existing.
  - `POST /invoices` with new-partner data, EIK doesn't match → INSERT
    - use the new id.
  - `POST /invoices` with partner_override on a non-individual order
    → silently ignored (or 400, see below).
  - `PUT /invoices/:id/regenerate` with `partner_override` → 400.
- Frontend manual smoke (see plan Task 11).

---

## Non-Functional Requirements

- **Performance:** +1 SELECT (partner-by-EIK lookup) + possibly +1
  INSERT (new partner). Trivial.
- **Scale:** no impact.
- **Security:** existing `INVOICES_MANAGE` check; no new attack
  surface. Validate EIK / fields server-side.
- **Reliability:** all DB writes in one transaction; rollback on any
  failure leaves state intact.
- **Maintenance:** +1 schema field, +1 helper for upsert-by-EIK,
  +1 sub-dialog. Small surface.

---

## Implementation Plan

(Generated next by `writing-plans` skill.)
