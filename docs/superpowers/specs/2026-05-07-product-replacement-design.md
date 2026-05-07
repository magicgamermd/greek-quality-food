# Product Replacement — Design Spec

**Date:** 2026-05-07
**Status:** Approved (brainstorm complete, ready for implementation plan)
**Scope:** Customer returns a previously purchased product on a стокова разписка (razpiska, без фактура) and exchanges it for a different product. The system records the exchange as a **new order of type "Замяна"** that contains both "given" lines and "returned" lines. The original order/razpiska is never modified. Out-of-scope for this iteration: invoice (ДДС-регистриран клиент) replacements.

---

## 1. Context and Goal

МЕРТ-М е дистрибутор на commercial kitchen equipment, продаван често на физически лица и фирми без ДДС регистрация — на стокова разписка + касова бележка, без фактура. Когато клиент се върне с купен уред и иска друг модел (ремисс на първоначалния избор, не гаранция), worker-ът на гише трябва бързо да:

1. Приеме обратно стария уред (вход в склад)
2. Издаде нов уред (изход от склад)
3. Изчисли разликата
4. Прибере / върне разликата в брой / POS / превод
5. Издаде документ "Стокова разписка за Замяна"
6. Изпрати към склад пакетиране

**Goal:** Workflow който worker-ът прави без обучение — просто отваря "Нова поръчка", натиска бутон "Замяна", избира двете страни на размяната, финализира.

**Non-goals (за тази итерация):**

- Замяна за ДДС-регистриран клиент (фактура за замяна с правилно ДДС). Бутонът ще е disabled с tooltip за такива партньори.
- Линкване към оригиналната поръчка / разписка. Оригиналът не се пипа и не се референцира — worker-ът може да напише в полето "забележка" "замяна за разписка №X", ако иска, но като свободен текст.
- Гаранционни замени с протокол (различен flow, без размяна на пари).
- Партньорски кредит / store credit / ваучери. Разликата винаги е cash event в момента.
- Връщане на цялата стока без замяна (return-only).
- Inspection / quarantine / scrap workflow за връщания. Връщаните артикули отиват директно в sellable наличност.

---

## 2. Approach Summary

**Замяната = една нова поръчка с маркер `is_replacement = true`,** която съдържа:

- **"Взема се"** редове (`is_returning = false`) — артикулите, които клиентът получава. Намаляват склада, добавят се със знак +.
- **"Връща се"** редове (`is_returning = true`) — артикулите, които клиентът връща. Увеличават склада, добавят се със знак −.

**Total = SUM(quantity × unit_price × sign), където sign = −1 за връщани редове, +1 за дадени.**

Резултатът е една от:

- `total > 0` → клиент доплаща (нормален payment)
- `total = 0` → без плащане
- `total < 0` → ние връщаме (refund payment)

**Никаква модификация на оригинала.** Старата поръчка / разписка / фактура остава точно както си е била. Не се издават кредитни известия, не се обвързва нищо.

---

## 3. Database

Една нова миграция: `076_orders_replacement.sql`

```sql
-- Замяна маркер на самата поръчка
ALTER TABLE orders
  ADD COLUMN is_replacement BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX idx_orders_replacement
  ON orders(is_replacement)
  WHERE is_replacement = true;

-- Per-line маркер: дава се (default) vs връща се
ALTER TABLE order_items
  ADD COLUMN is_returning BOOLEAN NOT NULL DEFAULT false;

-- Сигурност: returning редове само в replacement orders
ALTER TABLE order_items
  ADD CONSTRAINT chk_returning_only_in_replacement
  CHECK (
    is_returning = false
    OR EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_items.order_id
        AND orders.is_replacement = true
    )
  );
```

(Ако такъв cross-row CHECK не е поддържан в текущата Postgres конфигурация, заместваме с тригер `enforce_returning_only_in_replacement`.)

И втора миграция: `077_payments_is_refund.sql`

```sql
ALTER TABLE payments
  ADD COLUMN is_refund BOOLEAN NOT NULL DEFAULT false;
```

`amount` остава положителен; за refund се записва `is_refund = true` и worker-ът знае, че парите излизат от касата.

---

## 4. Backend

### 4.1 POST /orders

Приема нови полета:

```typescript
{
  partner_id: number,
  is_replacement: boolean,           // нов
  items: [{
    product_id: number,
    quantity: number,                // винаги > 0
    unit_price: number,              // винаги > 0
    is_returning: boolean            // нов; default false
  }],
  payment_method?: 'cash' | 'pos' | 'bank_transfer',  // за разликата
  notes?: string
}
```

**Validation:**

- Ако `is_replacement = true`:
  - Поне 1 ред с `is_returning = false` (нещо се дава)
  - Поне 1 ред с `is_returning = true` (нещо се връща)
  - Партньорът трябва да е **razpiska-eligible**. Дефиниция: партньор без ДДС регистрация — физическо лице (`partners.partner_type = 'individual'`) или фирма с `partners.vat_registered = false`. Точното поле/булева проверка ще се финализира при writing-plans фазата спрямо реалната схема на `partners` таблицата (виж `2026-04-22-private-individual-customer-design.md` за съществуващата ФЛ концепция). Иначе HTTP 400 _"Замяна за ДДС-фактуриран клиент още не е поддържана."_
- Ако `is_replacement = false`:
  - Никой ред не може да има `is_returning = true`. Иначе HTTP 400.
- Stock check за "взема се" редовете (по съществуващата `negative-inventory` политика). За "връща се" редовете няма stock check.
- Един и същ SKU може да се появи и в двете секции (легитимен случай — клиентът връща дефектен Hendi 226001 и взема нов Hendi 226001).

**Total изчисление (при INSERT и при всяка модификация):**

```sql
SELECT SUM(
  quantity * unit_price * (CASE WHEN is_returning THEN -1 ELSE 1 END)
) AS total
FROM order_items WHERE order_id = $1;
```

### 4.2 Fulfill flow (складови движения)

Преизползваме съществуващия helper `deductProductStock`, но прилагаме обратен знак за returning редове:

```typescript
for (const item of items) {
  const sign = item.is_returning ? +1 : -1;
  await applyStockMovement(item.product_id, item.quantity * sign);
}
```

Резултат: give редовете намаляват наличността (както нормална продажба), return редовете я увеличават (връщане в sellable).

### 4.3 Payment за разликата

След създаването на replacement поръчката:

| total | Действие                                                                          |
| ----- | --------------------------------------------------------------------------------- |
| `> 0` | Insert payment ред с `amount = total`, `is_refund = false`, метод от заявката     |
| `= 0` | Не се записва payment ред                                                         |
| `< 0` | Insert payment ред с `amount = ABS(total)`, `is_refund = true`, метод от заявката |

`payments.order_id` сочи към новата replacement поръчка (както при normal razpiska плащания).

### 4.4 Cancel замяна

`POST /orders/:id/cancel` за replacement поръчка:

- Реверсира двете складови движения (give: +qty обратно, return: −qty)
- Insert mirror payment запис: същата сума като оригиналния, с обърнат `is_refund` (ако оригиналът е `is_refund = false` → mirror е `is_refund = true`, и обратно). Двата реда се сумират до нула — cash балансът е коректен. Без нова колона `is_cancellation`; идентификацията на cancel pair се прави по `order_id` + `orders.status = 'cancelled'`.
- Сменя `orders.status` на `cancelled`

### 4.5 Filter в GET /orders

Нов query param: `?is_replacement=true|false`. Връща само поръчки с този маркер. По подразбиране (без param) връща всички.

### 4.6 PDF

Endpoint `GET /orders/:id/document/pdf` автоматично избира template-а:

- `is_replacement = false` → съществуващ `razpiska` template
- `is_replacement = true` → нов `razpiska-replacement` template (виж секция 6)

### 4.7 Notification за пакетиране

При финализиране на замяна → notification ред с тип `replacement_ready_for_packaging`, payload `{order_id: X, is_replacement: true}`. Същият notification механизъм както за нормални razpiska поръчки, но различен тип за UI индикация.

---

## 5. Frontend

### 5.1 Нова поръчка — toggle "Замяна"

В горната част на формата за нова поръчка (`/orders/new`) → toggle бутон **"🔄 Замяна"**.

Когато е активиран:

- Заглавието става червено: "🔄 НОВА ЗАМЯНА"
- Формата се преструктурира на **две секции**:
  - 🟢 **Взема се** (зелен ляв border) — артикулите, които клиентът получава
  - 🔴 **Връща се** (червен ляв border) — артикулите, които клиентът връща
- Всяка секция има свой "+ Добави артикул" бутон
- Долу се показва live изчислена разлика:
  - `+30 лв (клиент доплаща)` — зелено
  - `0 лв (равно)` — сиво
  - `−50 лв (връщаме на клиент)` — червено, удебелено
- Метод на плащане за разликата: радиобутони Брой / POS / Превод
- Финален бутон: **"Финализирай замяна"** (червен)

Toggle-ът се disable-ва, ако избраният партньор е ДДС-регистриран — с tooltip _"Замяна за ДДС-фактуриран клиент ще бъде добавена в следваща итерация."_

### 5.2 Списък с поръчки (`/orders`)

Нов filter pill: `[Всички] [Поръчки] [Замени 🔄] [Анулирани]`

Замените се показват в червен текст в реда си:

```
#241  🔄 ЗАМЯНА   | Иван Петров | +30 лв  | 07.05.2026
#239  🔄 ЗАМЯНА   | ФЛ          | −50 лв  | 06.05.2026
#240  Поръчка     | ООО Алфа    | 1240 лв | 07.05.2026
```

Колоната "Сума" показва signed разликата (с +/− префикс) за замени.

### 5.3 Детайлна страница на замяна (`/orders/:id`)

- Заглавие: червено "🔄 ЗАМЯНА #241" (вместо "Поръчка #241")
- Двете секции "Взема се" / "Връща се" с отделни таблици
- Footer: "Разлика: +30 лв | Метод: Брой | Платил: Иван Петров"
- Бутони:
  - "Печат Стокова разписка за Замяна"
  - "Към склад пакетиране"
  - "Анулирай замяна" (с потвърждение)

### 5.4 Партньорска история (`PartnerOrderHistory` drawer)

Замените се появяват в реда с червен label "🔄 Замяна". Партньорът вижда цялата си история подредено.

### 5.5 Дневен отчет (`/daily-report`)

Нова секция между "Поръчки" и "Анулирани":

```
🔄 Замени (3)
─────────────────
#241 — Иван Петров     — +30.00 лв — Брой
#239 — ФЛ              — −50.00 лв — POS reverse
#245 — Тодор Иванов    —   0.00 лв — без плащане
─────────────────
Брой замени: 3
Нетна разлика: −20.00 лв
```

Сумите се добавят в общия дневен оборот със signed знак, за да остане балансът коректен.

### 5.6 Translation strings (`bg.json`)

```json
{
  "order.replacement.label": "Замяна",
  "order.replacement.giving": "Взема се",
  "order.replacement.returning": "Връща се",
  "order.replacement.difference_positive": "Клиент доплаща",
  "order.replacement.difference_negative": "Връщаме на клиент",
  "order.replacement.difference_zero": "Равно — без плащане",
  "order.replacement.button": "🔄 Замяна",
  "order.replacement.finalize": "Финализирай замяна",
  "order.replacement.cancel": "Анулирай замяна",
  "order.replacement.cancel_confirm": "Това ще върне склада в първоначалното състояние и ще анулира платената разлика. Сигурни ли сте?",
  "order.replacement.disabled_for_invoiced": "Замяна за ДДС-фактуриран клиент ще бъде добавена в следваща итерация."
}
```

---

## 6. PDF Document — "Стокова разписка за Замяна"

Шапка (червен акцент за заглавието):

```
            СТОКОВА РАЗПИСКА ЗА ЗАМЯНА №25-000241
            Дата: 07.05.2026         МЕРТ-М ЕООД
            ─────────────────────────────────────
            Клиент: Иван Петров
            ЕГН/ЕИК: ...
```

**Секция 1 — Взема се** (зелен хедър):

| #   | Артикул                | Код     | Кол. | Ед. цена  | Стойност      |
| --- | ---------------------- | ------- | ---- | --------- | ------------- |
| 1   | Hendi фритюрник 226001 | H226001 | 1    | 230.00    | 230.00        |
|     |                        |         |      | **Сума:** | **230.00 лв** |

**Секция 2 — Връща се** (червен хедър):

| #   | Артикул                | Код     | Кол. | Ед. цена  | Стойност      |
| --- | ---------------------- | ------- | ---- | --------- | ------------- |
| 1   | Hendi фритюрник 226000 | H226000 | 1    | 200.00    | 200.00        |
|     |                        |         |      | **Сума:** | **200.00 лв** |

**Долу:**

```
─────────────────────────────────────
Разлика за плащане:        +30.00 лв
Платено в брой:             30.00 лв
─────────────────────────────────────
```

**Описателен текст под таблиците** (генерира се автоматично от данните, на български, с правилно склонение):

> _"Със настоящата стокова разписка клиентът **взема**: 1 бр. Hendi 226001 фритюрник на стойност 230.00 лв. Клиентът **връща**: 1 бр. Hendi 226000 фритюрник на стойност 200.00 лв. Разликата от 30.00 лв е заплатена в брой от клиента."_

Когато разликата е < 0:

> _"...Разликата от 50.00 лв е възстановена на клиента в брой."_

Когато е = 0:

> _"...Размяната е равностойностна — без доплащане."_

**Подписи:** Предал **\*\***\_**\*\*** | Приел **\*\***\_**\*\***

**Червен щемпъл "ЗАМЯНА"** в горния десен ъгъл на документа.

**За склад пакетиране:** Същият документ отива във flow-a към пакетировачите. Те виждат заглавие "ЗАМЯНА" + две ясни секции "ДАЙ" (зелена) и "ПРИЕМИ ОБРАТНО" (червена), за да изнесат новия артикул и приберат върнатия в един обход.

**Технологично:** Преизползваме съществуващия PDF generation pipeline (`document-pdf.test.ts`). Добавяме нов template `razpiska-replacement` с двусекционно оформление.

---

## 7. Permissions

Нов permission `REPLACEMENT_CREATE` в `lib/permissions.ts`. По подразбиране даден на роли:

- `admin`
- `accountant`
- `warehouse` (worker-ите на гише)

Без този permission бутонът "🔄 Замяна" не се вижда във формата за нова поръчка.

---

## 8. Edge Cases & Rules

| Случай                          | Поведение                                                               |
| ------------------------------- | ----------------------------------------------------------------------- |
| Партньор е ДДС-регистриран      | Бутонът "Замяна" disabled с tooltip                                     |
| Поне 1 give + 0 return          | Backend HTTP 400, frontend disable на "Финализирай"                     |
| 0 give + поне 1 return          | Backend HTTP 400 (return-only не е в scope)                             |
| Същият SKU и в give, и в return | Позволено (гаранционна логика)                                          |
| Replacement-of-replacement      | Позволено — replacement orders се третират като нормални за нова замяна |
| Cancel на замяна                | Реверсира двете движения + cancellation payment                         |
| Stock = 0 за give артикул       | Следваме съществуващата `negative-inventory` политика                   |
| Worker без `REPLACEMENT_CREATE` | Бутонът невидим                                                         |
| Partial finalize                | Не съществува — замяна се финализира цяла или не                        |

---

## 9. Tests

**Минимален набор unit / integration тестове:**

- `replacement-create.test.ts`
  - Validation: reject ако само give редове / само return редове
  - Validation: reject ако `is_returning = true` в не-replacement order
  - Validation: reject ако партньор е ДДС-регистриран
  - Total calculation с mixed signs
  - Stock movements в двете посоки на fulfill
  - Payment запис: `is_refund = false` при положителен total
  - Payment запис: `is_refund = true` при отрицателен total
  - Без payment запис при total = 0

- `replacement-cancel.test.ts`
  - Реверсира give редовете (+qty)
  - Реверсира return редовете (−qty)
  - Записва mirror payment (същата сума, обърнат `is_refund`); двата реда сумират до нула

- `replacement-filter.test.ts`
  - GET /orders?is_replacement=true връща само replacement orders
  - GET /orders?is_replacement=false връща без replacement orders
  - Без param връща всичко

- `replacement-pdf.test.ts`
  - Snapshot на PDF template-а с positive / negative / zero diff

**Manual E2E scenarios** (за post-merge user verification):

1. Клиент с positive diff (доплаща в брой)
2. Клиент с negative diff (POS reverse)
3. Клиент с zero diff
4. Cancel на замяна — двете движения revertнати, payment cancellation
5. Replacement-of-replacement (трикратна замяна на същия артикул)
6. Toggle disabled при ДДС-регистриран партньор
7. Filter pill "Замени" показва правилните поръчки
8. Дневен отчет включва нова "Замени" секция с правилен signed нетен сбор
9. PDF документът се генерира и принтира коректно

---

## 10. Migration Files Summary

| File                         | Description                                                          |
| ---------------------------- | -------------------------------------------------------------------- |
| `076_orders_replacement.sql` | `orders.is_replacement` + `order_items.is_returning` + index + CHECK |
| `077_payments_is_refund.sql` | `payments.is_refund` bool                                            |

---

## 11. Open Questions / Future Work

- **Фактура за замяна** (ДДС-регистриран клиент) — следваща итерация. Workflow-ът ще е аналогичен, но с правилно ДДС изчисление върху разликата (или върху двете страни отделно — ще се решава тогава).
- **Линкване към оригиналната поръчка** — ако след пускане на feature-а worker-ите се оплачат, че им трябва audit trail кой replacement идва от коя стара покупка, ще добавим опционална колона `replaces_order_id` в следваща итерация.
- **Гаранционни замени** (без cash event, протокол) — отделен flow, не е в scope на тази спецификация.
- **Return-only** (връщане без замяна) — отделна спецификация.
