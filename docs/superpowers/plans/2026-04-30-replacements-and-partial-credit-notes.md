# Замяна на стока + Частично кредитно известие — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> **Branch:** `feature/MERTM-replacements-and-partial-credit-notes` from `main`.
> **Status:** Drafted 2026-04-30. Awaits user answers on open questions before execution.

---

## Goal

Позволи на касиера/owner-а да обработи **замяна на стока** като една атомична операция от UI-то — клиентът връща N артикула от стара поръчка, взима M нови, плаща/получава нет разликата. Системата автоматично генерира всички legal-compliant документи (КИ + нова фактура + протокол) и линковa поръчките.

Същевременно, разшири `credit_notes` flow-а да поддържа **частично сторниране** (per-line, не само цяла фактура), което е базовият building block.

## Бизнес сценарии

| #   | Случай                                                                    | Документи генерирани от системата              | Cash движение   |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------- | --------------- |
| 1   | Връща 1 от 5 артикула без замяна                                          | КИ (partial) + протокол                        | Връщане от каса |
| 2   | Връща всичко без замяна                                                   | КИ (full) + протокол                           | Връщане от каса |
| 3   | Замяна — нова стока е по-скъпа                                            | КИ (partial) + нова фактура + протокол         | Доплащане       |
| 4   | Замяна — нова стока е по-евтина                                           | КИ (partial) + нова фактура + протокол         | Връщане от каса |
| 5   | Замяна — нова стока е със същата цена                                     | КИ (partial) + нова фактура + протокол         | 0               |
| 6   | Поръчка само със стокова разписка (non-VAT individual) — частично връщане | Razpiska correction (negative line) + протокол | Връщане от каса |
| 7   | Поръчка само със стокова разписка — замяна                                | Razpiska correction + нова razpiska + протокол | По разлика      |

## Юридически правила (ЗДДС)

| Правило                                                            | Source              | Имплементация                                          |
| ------------------------------------------------------------------ | ------------------- | ------------------------------------------------------ |
| КИ има задължителна референция към оригиналната фактура            | Чл. 115, ал. 4 ЗДДС | `credit_notes.related_invoice_id` (вече има)           |
| Дата на КИ = дата на връщането (не на оригиналната фактура)        | НАП practice        | Backend сетва `created_at = NOW()`, не приема override |
| Срок за издаване на КИ: **5 дни от събитието** (т.е. от връщането) | Чл. 113, ал. 4 ЗДДС | Auto by design — wizard-ът прави всичко "сега"         |
| Оригиналната фактура не се анулира, не се редактира                | НАП requirement     | Wizard-ът никога не пипа оригиналната фактура          |
| Номерът на КИ е от същата серия като фактурите                     | НАП requirement     | Вече ползваме `generate_invoice_number()`              |
| Частично КИ е legal — не е нужно да сторнираш цялата фактура       | ЗДДС позволява      | Нова фийчъра — този план                               |

## Решения (одобрени от user 2026-04-30)

1. **Касови продажби** — няма касов апарат integration. Поддържат се **два пътя**:
   - **С фактура** → partial КИ + нова фактура + payment correction (стандартния flow)
   - **Само стокова разписка** (non-VAT individual) → корекция на разписката (или нова разписка със негативен sign), нова разписка за новите артикули, payment record за нет cash. **Без КИ** (няма фактура за сторниране).
2. **Per-line selection** — да (стандартното поведение)
3. **Цена на върнатия артикул** — оригиналната цена от поръчката (важно за audit + КИ legal accuracy)
4. **Dispatch на новата стока** — auto fulfilled (skip dispatch — клиентът я взима веднага в магазина)
5. **Payment method за разликата** — user избира всеки път в wizard step 3 (radio: брой / превод / карта)
6. **Decimals** — само цели бройки (Q6=A → quantity Zod schema е `.int().positive()`, не `.positive()`)
7. **Permission** — `ORDERS_MANAGE` (текущата) — никъв нов permission. Всеки който може да управлява поръчки може и да прави замени.
8. **Срок cutoff** — няма hard блокировка. **Soft warning** в wizard step 3 ако оригиналната поръчка е >30 дни (червен текст: "Внимание: оригиналната поръчка е от преди X дни"), но позволено.

---

## Architecture overview

### Database

Две нови колони + 1 audit таблица:

```sql
-- migration 062
ALTER TABLE orders
  ADD COLUMN replacement_of_order_id INTEGER REFERENCES orders(id);
CREATE INDEX idx_orders_replacement_of
  ON orders(replacement_of_order_id) WHERE replacement_of_order_id IS NOT NULL;

-- migration 063 — razpiska correction audit (за поръчки без фактура)
CREATE TABLE razpiska_corrections (
  id SERIAL PRIMARY KEY,
  original_order_id INTEGER NOT NULL REFERENCES orders(id),
  replacement_order_id INTEGER REFERENCES orders(id),
  correction_type VARCHAR(20) NOT NULL,  -- 'return' | 'replacement'
  reason TEXT NOT NULL,
  returned_total NUMERIC(10,2) NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE razpiska_correction_items (
  id SERIAL PRIMARY KEY,
  correction_id INTEGER NOT NULL REFERENCES razpiska_corrections(id) ON DELETE CASCADE,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  name_bg_snapshot TEXT NOT NULL,
  sku_snapshot TEXT,
  quantity NUMERIC(10,3) NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL,
  line_total NUMERIC(10,2) NOT NULL
);
CREATE INDEX idx_razpiska_corrections_original ON razpiska_corrections(original_order_id);
CREATE INDEX idx_razpiska_corrections_replacement ON razpiska_corrections(replacement_order_id);
```

`credit_notes` (вече има като row в `invoices` table с `document_type='credit_note'`) — items идват от `invoice_items` чрез `JOIN`, но за partial КИ ще трябва `invoice_items` редовете на КИ-то да съдържат само върнатите артикули с количеството което се връща (не цялото количество от оригиналната).

`razpiska_corrections` — паралелен audit trail за поръчки **без фактура** (само стокова разписка). Тук няма ЗДДС изискване за КИ, но трябва да следим връщанията/замените за: (a) аудит на cash движенията, (b) restock логика, (c) UI chips "Заменена/Замяна на #N", (d) дневен отчет.

### Backend endpoints

| Метод | Path                              | Какво прави                                                                                                                                                                                                        |
| ----- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST  | `/invoices/credit-note`           | **Разширен** — вече приема optional `items[{invoice_item_id, quantity}]`. Без `items` → backward-compatible пълно КИ. С `items` → partial.                                                                         |
| POST  | `/orders/:id/replace`             | **НОВ** — единна оркестрация. Според `original.has_invoice`: <br>• С фактура → partial КИ + нова поръчка + нова фактура + payment <br>• Без фактура → razpiska_correction + нова поръчка + нова razpiska + payment |
| POST  | `/orders/:id/razpiska-correction` | **НОВ** — само връщане (без замяна) за поръчки без фактура. Записва razpiska_correction (type='return'), restore stock, payment record за връщането от каса.                                                       |

### Frontend

| Локация                                         | Промяна                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Order/Invoice detail (с фактура)                | Бутон "Сторнирай" → разширен dialog с per-line selection (checkbox + quantity)                              |
| Order detail (без фактура, само razpiska)       | Нов бутон "Корекция на разписка" → similar dialog с per-line selection                                      |
| Order detail (за `fulfilled`/`invoiced` orders) | Нов бутон "Замяна" → 3-стъпков wizard (auto-detect фактура/razpiska режим)                                  |
| Order list                                      | На редовете на orders с `replacement_of_order_id` или с children → small ⚠ chip "Заменена" / "Замяна на #N" |
| Order list                                      | На редовете с razpiska_corrections → ⚠ chip "Коригирана" / "Корекция на #N"                                 |

---

## Pre-flight

- Branch: `git checkout main && git pull && git checkout -b feature/MERTM-replacements-and-partial-credit-notes`
- Backend tests: `cd warehouse-backend && npx vitest run`
- Type-check: `npx tsc --noEmit` (в двата проекта)
- All open questions answered (см. "Решения" секцията по-горе)

**Note за razpiska_corrections:** Phase 1 ще включи и migration 063. Phase 2/3 имат паралелен razpiska track в допълнение към КИ track-а — детайли при execution на всяка task. Тестовете покриват и двата пътя (фактура + само-разписка).

---

## Phase 1 — Database migration

### Task 1: Migration 062 — `orders.replacement_of_order_id`

**Files:**

- Create: `warehouse-backend/migrations/062_orders_replacement_of.sql`

```sql
-- 062_orders_replacement_of.sql
-- Audit link from a replacement order to the order it replaced.
-- A "replacement" is a new order created via the Замяна wizard, after
-- the customer returned items from the original (which gets a partial
-- or full credit note in the same transaction).
-- NULL = not a replacement (default for all existing rows).

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS replacement_of_order_id INTEGER REFERENCES orders(id);

CREATE INDEX IF NOT EXISTS idx_orders_replacement_of
  ON orders(replacement_of_order_id)
  WHERE replacement_of_order_id IS NOT NULL;

COMMENT ON COLUMN orders.replacement_of_order_id IS
  'If set, this order was created via the Замяна wizard to replace the referenced original order. The original keeps its status; a credit note is issued for the returned items.';
```

**Verification:**

```bash
docker exec -i mertm-postgres-1 psql -U warehouse -d mertm_warehouse < warehouse-backend/migrations/062_orders_replacement_of.sql
docker exec mertm-postgres-1 psql -U warehouse -d mertm_warehouse -c "\d orders" | grep replacement
```

**Commit:**

```bash
git add warehouse-backend/migrations/062_orders_replacement_of.sql
git commit -m "feat(orders): add replacement_of_order_id for Замяна audit trail"
```

---

## Phase 2 — Backend: partial credit notes

### Task 2: Extend `createCreditNoteSchema` with optional `items[]`

**Files:**

- Modify: `warehouse-backend/src/routes/invoices.ts:171` (createCreditNoteSchema)

```ts
const createCreditNoteSchema = z.object({
  related_invoice_id: z.number().int(),
  reason: z.string().trim().min(1).max(500),
  include_vat: z.boolean().optional(),
  restore_stock: z.boolean().optional(),
  // НОВО: ако присъства, КИ-то е partial — само избраните редове с
  // указано количество. Ако липсва, поведението е backward-compatible
  // (full credit note за всички items на оригиналната фактура).
  items: z
    .array(
      z.object({
        invoice_item_id: z.number().int().positive(),
        quantity: z.number().positive(), // decimals позволени — Q6
      }),
    )
    .min(1)
    .optional(),
});
```

**Test:** запиши Zod parse тест с `items` + без `items`.

### Task 3: Partial КИ logic в POST /credit-note

**Files:**

- Modify: `warehouse-backend/src/routes/invoices.ts:1361` (POST /credit-note handler)

**Промени:**

1. Ако `body.items` присъства:
   - SELECT всички `invoice_items` на оригиналната фактура
   - Validate всеки `invoice_item_id` е от тази фактура (security)
   - Validate всяко `quantity ≤ original quantity` (не може да върне повече)
   - INSERT само избраните редове в нов credit note `invoice_items`, със подаденото количество и оригиналните цени
   - Calculate totals от подадените items, не от parent
2. Ако `body.items` липсва:
   - Текущо поведение (copy всички items от parent)
3. `restore_stock`:
   - Ако true + partial → restore само върнатите количества (не всички)
   - Ако true + full → текущо поведение
4. `credit_note.total_amount` = sum of selected items × VAT logic

**Test cases (нов файл `warehouse-backend/src/__tests__/credit-note-partial.test.ts`):**

- Full credit note (без items) — backward-compatible
- Partial credit note — 1 от 5 items, цялото количество
- Partial credit note — 2 items, частични количества
- Reject: invoice_item_id не е от тази фактура
- Reject: quantity > original quantity
- Stock restore — partial restore само на върнатите

### Task 4: Credit note PDF — render само partial items

**Files:**

- Modify: `warehouse-backend/src/services/invoice-pdf.ts` (или там където credit-note PDF се generate-ва)

PDF-ът на КИ-то трябва да чете items от **own credit note's invoice_items**, не от parent invoice. Текущо може би прави второто. Verify and fix.

**Test:** генерирай partial КИ → assert PDF съдържа само върнатите items + correct totals.

---

## Phase 3 — Backend: replacement orchestration

### Task 5: POST `/orders/:id/replace` endpoint

**Files:**

- Modify: `warehouse-backend/src/routes/orders.ts` (нов endpoint)

**Schema:**

```ts
const replaceOrderSchema = z.object({
  // Items от оригиналната които се връщат (същият формат като partial КИ)
  returned_items: z
    .array(
      z.object({
        invoice_item_id: z.number().int().positive(),
        quantity: z.number().positive(),
      }),
    )
    .min(1),
  reason: z.string().trim().min(1).max(500),
  // Items за новата поръчка (същият формат като POST /orders items)
  new_items: z
    .array(
      z.object({
        product_id: z.number().int().positive(),
        quantity: z.number().positive(),
        unit_price: z.number().nonnegative(),
        discount: z.number().min(0).max(100).optional(),
      }),
    )
    .min(1),
  // Settlement: how to handle the cash difference
  payment_method: invoicePaymentMethodSchema, // Q5
  // Behavior of new order
  fulfill_immediately: z.boolean().default(true), // Q4
});
```

**Логика (вътре в `transaction(async (client) => {...})`):**

1. Load original order + verify е `fulfilled` или `invoiced`
2. Verify оригиналната има invoice (или гледай Q1 за касови)
3. Calculate сума на върнатите items (от оригиналните цени)
4. Calculate сума на новите items
5. Net difference = new − returned (положително = доплащане; отрицателно = връщане)
6. **Issue partial КИ** (reuse helper от Task 3)
7. **Create нова поръчка** със `replacement_of_order_id = original.id`, status зависи от Q4
8. **Create нова фактура** за новата поръчка (reuse existing invoice flow)
9. **Create payment record** за нет разликата (положителна или отрицателна)
10. Return `{credit_note_id, new_order_id, new_invoice_id, payment_id, net_amount}`

**Permission:** `ORDERS_REPLACE` (Q7) — изисква нова entry в permissions registry.

**Test cases (нов `warehouse-backend/src/__tests__/orders-replace.test.ts`):**

- Замяна с по-скъпа стока → positive payment
- Замяна с по-евтина → negative payment
- Замяна със същата сума → 0 payment, no payment record
- Reject: оригиналната не е fulfilled/invoiced
- Reject: missing permission
- Reject: returned quantity > original quantity
- Verify: original order status НЕ се променя
- Verify: replacement_of_order_id е попълнено в новата поръчка
- Verify: КИ-то има correct related_invoice_id

---

## Phase 4 — Frontend: partial credit note dialog

### Task 6: Extend Сторнирай dialog с per-line selection

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` (creditNoteOpen dialog area, ~line 567)

**UI:**

```
Кредитно известие към Фактура #001

[ Чекбокс на ред + редактируема quantity на ред ]

Сума за кредитиране (с ДДС): X €

Причина: [____________________]
☑ Върни артикулите в склада
☐ Включи ДДС

[Откажи] [Издай КИ]
```

**State:**

- `selectedItems: Map<invoice_item_id, quantity>`
- Default: всички items selected с full quantity (така backward-compatible UX за пълно КИ)

**Mutation payload:**

- Ако всички items selected с full quantity → не пращай `items` (full КИ)
- Иначе → пращай `items[]` с избраните

### Task 7: TypeScript типове

**Files:**

- Modify: `warehouse-frontend/src/types/index.ts`

Добави `CreditNoteItem` тип, разширя `CreditNoteRequest` с `items?: CreditNoteItem[]`.

---

## Phase 5 — Frontend: Замяна wizard

### Task 8: Нов бутон "Замяна" в Order detail

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` (около бутоните "Сторнирай" / "Анулирай" в drawer)

**Visibility:**

- Само за orders със `status IN ('fulfilled', 'invoiced')`
- Гейтнат от `Can permission={ORDERS_REPLACE}`

### Task 9: Replacement Wizard component (нов файл)

**Files:**

- Create: `warehouse-frontend/src/components/ReplacementWizard.tsx`

**3 стъпки:**

**Стъпка 1 — Връщане:**

- Per-line checkbox + quantity selector (max = original qty)
- Сума за връщане в реално време

**Стъпка 2 — Нови артикули:**

- Reuse Combobox + product table от new-order modal
- Сума за нови артикули в реално време

**Стъпка 3 — Преглед & потвърждение:**

- Резюме:
  - "Връща: X € (включва [списък])"
  - "Ново: Y €"
  - "Net: ZZZ €" (с цвят: червено = доплащане, зелено = връщане)
- Payment method селектор (default: от оригиналната — Q5)
- Бутон "Потвърди замяна" → POST /orders/:id/replace

**Post-success:**

- Auto-open новата фактура PDF
- Toast "Замяна на поръчка #N обработена успешно"
- Invalidate orders + invoices queries

### Task 10: Visual indicators

**Files:**

- Modify: `warehouse-frontend/src/pages/Orders.tsx` (orders table + detail drawer)

**Promene:**

- В orders list table: ако `replacement_of_order_id != null` → ⚠ chip "Замяна на #N" (clickable)
- В orders list table: ако order има replacement (children) → ⚠ chip "Заменена с #N" (изисква backend да върне `replaced_by_order_id` в response — JOIN от другата страна)
- В drawer header: същите chips, но по-prominent

---

## Phase 6 — PDF & Daily Report integration

### Task 11: Daily report — verify replacement scenarios

**Files:**

- Modify: `warehouse-backend/src/services/daily-report-pdf.ts`

**Verify:**

- Section "Фактури": нова фактура от замяна се появява normally
- Section "Сторно/КИ": partial КИ-то се появява със correct сума
- Section "Постъпления": net cash от replacement се отразява точно
- Add new section/note "Замени днес" ако има такива? (Optional — само ако е useful)

### Task 12: Receipt-style document for cash replacements (Q1 dependent)

**Дискусионно — зависи от Q1.** Ако касовите замяни се правят без КИ:

- Нов PDF "Replacement receipt" / "Документ за замяна"
- Показва върнати + нови + net cash, без VAT detail

---

## Phase 7 — Tests + verification

### Task 13: Backend integration tests

**Files:**

- New: `warehouse-backend/src/__tests__/orders-replace.test.ts`
- New: `warehouse-backend/src/__tests__/credit-note-partial.test.ts`

**Coverage targets:**

- Partial КИ: 6+ test cases (Task 3 list)
- Replace endpoint: 8+ test cases (Task 5 list)

### Task 14: Manual E2E walkthrough

**Script:**

1. Create order, fulfill, invoice
2. Open detail → "Сторнирай" → uncheck 1 от 3 items → modify qty на 2-ри → submit → verify КИ PDF има само избраните items
3. Create нова order, fulfill, invoice
4. Open detail → "Замяна":
   - Стъпка 1: select 2 от 4 items
   - Стъпка 2: добави 3 нови items, по-скъпи общо
   - Стъпка 3: confirm
5. Verify в orders list: оригиналната → "Заменена с #N", новата → "Замяна на #M"
6. Verify в /invoices: старата фактура е там, КИ-то има link, новата фактура е там
7. Verify payment record за разликата
8. Verify daily-pdf за днешна дата показва всичко правилно

---

## Phase 8 — Documentation + STATUS

### Task 15: Update STATUS.md + CLAUDE.md

**Files:**

- Modify: `STATUS.md` (Session log entry)
- Optionally: `CLAUDE.md` (Critical rules — добави "Замяна = КИ + нова фактура, не редакция")

### Task 16: User-facing changelog (optional)

В `docs/` ако има changelog → добави entry за новия feature.

---

## Out of scope

- Дебитни известия (ДИ) — рядко използвани, не са нужни за замяна
- Multi-step партньорска замяна (връщане към доставчик при свръхзамяна) — отделен бизнес flow
- Замяна между различни партньори — нелогично, не се поддържа
- Backdated замени (с дата в миналото) — НАП non-compliant, не позволяваме

---

## Estimated effort

| Phase                                         | Effort           |
| --------------------------------------------- | ---------------- |
| Phase 1 — Migrations 062 + 063                | 1 ч              |
| Phase 2 — Partial КИ backend + razpiska track | 6-8 ч            |
| Phase 3 — Replace endpoint (dual-mode)        | 6-8 ч            |
| Phase 4 — Partial КИ + razpiska correction UI | 4-6 ч            |
| Phase 5 — Replacement wizard UI               | 6-8 ч            |
| Phase 6 — PDF/report integration              | 3-4 ч            |
| Phase 7 — Tests + E2E (фактура + razpiska)    | 6-8 ч            |
| Phase 8 — Docs                                | 1 ч              |
| **Total**                                     | **~4 work-days** |

---

## Risks & mitigations

| Risk                                                        | Mitigation                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Partial КИ счупва съществуващия full-КИ flow                | Schema е strictly additive (`items?` optional); тестове за двата пътя         |
| Replace endpoint е голяма transaction → rollback complexity | Helper функции, integration test с simulated mid-failure                      |
| User обърка "Сторнирай" с "Замяна"                          | Различни цветове на бутоните, distinct icons, confirmation dialog             |
| Грешно calculate-нат net cash при decimals                  | Floating-point precision tests, използваме същия rounding като invoice totals |
| Касови продажби workflow остава неясен (Q1)                 | Block execution до user отговор                                               |
