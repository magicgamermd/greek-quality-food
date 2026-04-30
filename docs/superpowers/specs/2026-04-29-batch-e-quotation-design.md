# Batch E — Quotation (Оферта) workflow design

**Date:** 2026-04-29
**Status:** Approved (brainstorm complete, ready for implementation plan)
**Scope:** A new `quoted` order status, an offer-PDF generator, a
filter pill "Оферта", and the transitions to enter / exit the quoted
state. No stock deduction while quoted.

---

## Understanding Summary

**What we're building:**

- New order status `'quoted'`. Orders in this state do NOT deduct
  stock; they appear in a dedicated filter pill "Оферта" in the orders
  list.
- A new "Оферта" PDF document (`OF-{order_number 7-digit}`) generated
  on demand. Replaces "Търговски документ" _contextually_ — quoted
  orders show "Оферта" actions; processing+ orders still show the
  Търговски документ as today.
- Two entry points to `quoted`:
  1. **At create time** — alongside the normal "Запази" button there
     is "Запази като оферта" which sets `status='quoted'` and
     immediately generates the offer PDF.
  2. **From a pending order** — the drawer offers a "Генерирай оферта"
     button that flips status `pending → quoted` and generates the
     PDF.
- Two exits from `quoted`:
  1. `quoted → pending` via "Премини към обработка" — normal flow
     resumes (Потвърди → Изпълни → Фактура).
  2. `quoted → cancelled` via "Откажи оферта".
- Same OF number on regenerate; PDF re-rendered with current item data.

**Why:** Customers often ask for an offer to think about. Without this
flow the cashier would print "Търговски документ" which incorrectly
deducts stock and creates a fulfilment artefact for goods that haven't
been bought. Quoted is the right semantic.

**For whom:** Cashiers (`sales`), admin. Existing `ORDERS_MANAGE`
permission.

**Key constraints:**

- Quoted does NOT deduct stock (fulfill / processing remain the only
  stock-changing transitions).
- One-way state machine: only the transitions listed above are valid.
- No expiry; UI shows "Издадена преди N дни" as a visual hint.
- Same OF number always; regenerate produces a fresh PDF.
- Item prices are preserved through `quoted → pending` transition
  (snapshot semantics — no re-pricing from the catalog).

**Non-goals:**

- No automatic expiry (cron job, status flips).
- No email-the-offer feature (printed paper handed to the customer).
- No separate offer_number sequence — `OF-` prefix on the order number.
- No per-offer expiry date.

---

## Assumptions

1. Existing fulfill / stock-deduction flow gates on
   `status='processing'` or explicit `POST /orders/:id/fulfill`. Quoted
   status will be inherently safe — verified.
2. The `orders.status` CHECK constraint must be relaxed to include
   `'quoted'` — handled by migration 059.
3. The frontend `statusLabels` map auto-generates filter pills; adding
   `quoted: "Оферта"` is enough to surface the new pill.
4. The offer PDF generator (`offer-pdf.ts`) is modeled on
   `document-pdf.ts` (commercial-doc PDF). Layout differs minimally:
   title says "ОФЕРТА", footer says "Валидна до уговаряне" or similar,
   no "съгласно сключения договор" wording.
5. The drawer UI conditionally renders the right buttons based on
   `detail.status`. For `quoted`:
   - "Регенерирай оферта" (re-renders PDF with same OF number)
   - "Премини към обработка" (transition to pending)
   - "Откажи оферта" (transition to cancelled)
   - The Документи row (Стокова разписка / Търговски / Гаранция /
     Приемо-предавателен) is hidden — those documents are not
     applicable until processing+.

---

## Decision Log

| #   | Decision                                 | Alternatives                             | Reason                                                         |
| --- | ---------------------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| 1   | New order status `'quoted'` in enum      | column + flag; hybrid                    | Natural fit; minimal UI code (filter pill via statusLabels)    |
| 2   | `quoted → pending` (or cancelled)        | `quoted → confirmed` direct; user choice | Symmetric with pending as a draft; easy to edit before confirm |
| 3   | No expiry                                | 30-day default; per-offer date           | YAGNI; UI hint sufficient                                      |
| 4   | Regenerate, same OF number               | New number; smart detect                 | Symmetric with invoice regenerate; one offer = one lifecycle   |
| 5   | One-way state machine                    | Allow more (cancelled→quoted)            | Cancelled is final; new offer = new order                      |
| 6   | Item prices preserved through transition | Recalc current; user choice              | Standard ethical/legal: an offer is a (soft) commitment        |

---

## Final Design

### DB migration (059)

```sql
-- 059_orders_quoted_status.sql
-- Adds 'quoted' to the orders.status CHECK constraint so orders can
-- live in the "Оферта" state — printed offer PDF, no stock deduction,
-- waiting for the customer's decision.

BEGIN;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN (
    'pending', 'confirmed', 'processing', 'fulfilled',
    'invoiced', 'cancelled', 'quoted'
  ));

COMMIT;
```

### Backend — order status type extension

`warehouse-frontend/src/types/index.ts` Order interface:

```ts
status:
  | "pending" | "confirmed" | "processing" | "fulfilled"
  | "cancelled" | "invoiced" | "quoted";   // ← add
```

(Backend uses raw strings; no central type to update.)

### Backend — POST /orders accepts initial `quoted` status

In the create-order schema (`routes/orders.ts`):

```ts
const createOrderSchema = z.object({
  // …existing…
  status: z.enum(["pending", "quoted"]).optional().default("pending"),
});
```

Inside the handler, the INSERT uses the chosen status. If `quoted`,
the same handler also generates the offer PDF (via call to a new
helper or by side-effect — see Task 6).

### Backend — `POST /orders/:id/quote` endpoint

For converting an existing `pending` order to `quoted`:

```ts
app.post(
  "/:id/quote",
  { preHandler: ordersManagePreHandler },
  async (req, reply) => {
    const id = Number(req.params.id);
    const result = await transaction(async (client) => {
      const {
        rows: [order],
      } = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [
        id,
      ]);
      if (!order) throw HttpError(404, "Order not found");
      if (order.status !== "pending") {
        throw HttpError(400, "Only pending orders can be quoted");
      }
      await client.query(
        "UPDATE orders SET status = 'quoted', updated_at = NOW() WHERE id = $1",
        [id],
      );
      return { id, status: "quoted" };
    });
    return result;
  },
);
```

### Backend — `POST /orders/:id/unquote` endpoint

For `quoted → pending`:

```ts
app.post(
  "/:id/unquote",
  { preHandler: ordersManagePreHandler },
  async (req, reply) => {
    const id = Number(req.params.id);
    // Verify status === 'quoted'; UPDATE to 'pending'.
  },
);
```

(Cancellation uses the existing DELETE flow — no new endpoint needed.)

### Backend — Offer PDF service

New file `warehouse-backend/src/services/offer-pdf.ts`. Modeled on
`document-pdf.ts` (commercial-doc). Title: "ОФЕРТА"; document number:
`OF-{order_number padded to 7}`; footer text: "Цените са валидни до
уговаряне." Rest mirrors the commercial-doc layout.

### Backend — `GET /orders/:id/offer-pdf`

```ts
app.get<{ Params: { id: string } }>(
  "/:id/offer-pdf",
  { preHandler: ordersManagePreHandler },
  async (req, reply) => {
    const id = Number(req.params.id);
    const data = await loadOrderWithBatches(id);
    if (!data) return reply.status(404).send({ error: "Order not found" });
    if (data.order.status !== "quoted") {
      return reply.status(400).send({
        error: "Offer PDF only for quoted orders",
      });
    }
    // … generate, send …
  },
);
```

### Frontend — orders list filter pill

Just adding `quoted: "Оферта"` to `statusLabels` (around `Orders.tsx:103`)
should be enough — the existing pills are auto-generated from this
map. Same for `statusVariants` (color choice — yellow/amber).

### Frontend — drawer actions

Conditional rendering based on `detail.status`:

```tsx
{
  detail.status === "pending" && (
    <Button onClick={() => quoteMutation.mutate(detail.id)}>
      Генерирай оферта
    </Button>
  );
}

{
  detail.status === "quoted" && (
    <>
      <Button onClick={() => openOfferPdf(detail.id)}>
        Регенерирай оферта
      </Button>
      <Button onClick={() => unquoteMutation.mutate(detail.id)}>
        Премини към обработка
      </Button>
      <Button variant="destructive" onClick={() => cancelOrder(detail.id)}>
        Откажи оферта
      </Button>
      <span className="text-xs text-gray-500">
        Издадена преди {daysSince(detail.updated_at)} дни
      </span>
    </>
  );
}
```

The Документи row is hidden when `status === 'quoted'`.

### Frontend — new-order form: "Запази като оферта" button

In the new-order modal, alongside the existing "Запази":

```tsx
<Button onClick={handleSave}>
  Запази
</Button>
<Button
  variant="outline"
  onClick={() => handleSave({ asQuoted: true })}
>
  Запази като оферта
</Button>
```

`handleSave` wraps the existing mutation; when `asQuoted` is set, the
payload includes `status: "quoted"`. After successful create, the offer
PDF endpoint is called and the file is opened in a new tab.

### Test strategy

**Backend integration:**

- Migration 059 changes the CHECK constraint successfully.
- POST /orders with `status: 'quoted'` creates a quoted order; SELECT
  inventory shows no stock deduction.
- POST /orders/:id/quote on a `pending` order moves it to quoted.
- POST /orders/:id/quote on a non-pending order returns 400.
- POST /orders/:id/unquote on a `quoted` order moves it to pending.
- GET /orders/:id/offer-pdf returns 200 + application/pdf when status
  is quoted; 400 otherwise.
- POST /orders/:id/fulfill on a quoted order returns 400 (existing
  guard already covers this — verify).
- Filter `?status=quoted` in GET /orders returns only quoted orders.

**Frontend manual smoke** (see plan).

---

## Non-Functional Requirements

- **Performance:** trivial — 2 endpoints + 1 PDF generator + 1
  migration
- **Scale:** no impact
- **Security:** standard `ORDERS_MANAGE`; no new attack surface
- **Reliability:** atomic state transitions in a single transaction
- **Maintenance:** +1 migration, +1 PDF service, +2 endpoints, +UI
  conditionals + new pill (auto via map)

---

## Implementation Plan

(Generated next by the `writing-plans` skill.)
