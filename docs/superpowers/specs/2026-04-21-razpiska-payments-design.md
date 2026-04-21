# Плащания по стокови разписки — Design Spec

**Date:** 2026-04-21
**Status:** Design approved, ready for implementation plan
**Author:** magic + Claude (brainstorming skill)

---

## 1. Context and Goal

МЕРТ-М трябва да може да продава и без фактура — само на стокова разписка (СР).
Текущо таблицата `payments` позволява само плащания по `invoice_id`, така че
поръчките със СР без фактура нямат къде да се отбелязва плащане.

**Goal:** Записване на плащане по поръчка независимо дали има фактура. Плащанията
по СР да са отделно от фактурните, да се достъпват през **скрит таб с keyboard
shortcut** на страница `/payments`.

**Non-goals:**

- Не променяме съществуващата логика за фактурни плащания — тя работи както сега.
- Не правим миграция на стари записи (няма такива — всички текущи плащания са по фактура).

## 2. Database

Миграция `049_payments_order_id.sql`:

- `payments.order_id INT NULL` — FK към `orders.id`
- `payments.invoice_id` → става nullable (беше NOT NULL)
- CHECK constraint: `invoice_id IS NOT NULL OR order_id IS NOT NULL`
- Index по `order_id`

**Класификация на ред:**

| invoice_id | order_id | Вид                      | Видим в                        |
| ---------- | -------- | ------------------------ | ------------------------------ |
| NOT NULL   | NULL     | Фактурно плащане         | Таб "Фактурни"                 |
| NULL       | NOT NULL | Плащане по СР            | Таб "По разписки" (скрит)      |
| NOT NULL   | NOT NULL | (не се произвежда от UI) | Таб "Фактурни" (по invoice_id) |

## 3. Backend

### POST /payments

Приема **или** `invoice_id`, **или** `order_id` (не и двете).

- Ако е подаден `order_id` и поръчката има `invoice_id` → 400 "Използвай invoice_id вместо order_id".
- Ако поръчката е анулирана → 400.
- Частично плащане по СР: cumulative sum срещу `orders.total_amount`.

### GET /payments

Нов query param `type`:

- `type=invoice` (default, BC) → `WHERE invoice_id IS NOT NULL`
- `type=razpiska` → `WHERE invoice_id IS NULL AND order_id IS NOT NULL`

JOIN логика: при `razpiska` join-ваме `orders` + `partners` вместо `invoices`.
Response нормализира полетата: `order_number`, `order_total`, `partner_name`,
`cumulative_paid` (историческата логика като сега).

## 4. Frontend

### Orders page (`/orders`)

Kebab меню `⋮` в колона "Действия" с опции:

- **Запиши плащане** (винаги видимо)
  - Ако поръчката има фактура → модал пише `invoice_id`
  - Ако няма → модал пише `order_id`
  - Ако е анулирана → disabled (tooltip: "Анулирана поръчка")

### Payments page (`/payments`)

- Таб лента: **"Фактурни"** (default, винаги видим) и **"По разписки"** (скрит).
- Keyboard listener на page-level: `Cmd+Option+P` → `setRazpiskaTabVisible(true)`.
  На други OS — `Ctrl+Alt+P` (fallback).
- **Persistence:** `sessionStorage["razpiska_tab_unlocked"] = "true"`. Чисти се при
  затваряне на tab/прозорец; остава при F5/refresh. Истински скрит — без икона
  или индикатор, че е отключен.
- Когато е отключен, табът "По разписки" се рендерира видимо, с нормален стил.

### Компоненти

**Нови:**

- `components/RecordPaymentModal.tsx` — унифициран модал (работи и с
  `invoice_id`, и с `order_id`).
- `components/OrderActionsMenu.tsx` — kebab меню за Orders ред.

**Променени:**

- `pages/Payments.tsx` — tabs + keyboard listener.
- `pages/Orders.tsx` — kebab в колона "Действия".
- `types/index.ts` — `Payment.order_id?`, `Payment.order_number?`, `Payment.order_total?`.

## 5. Edge Cases

- **Поръчка с фактура и СР едновременно**: плащането върви към `invoice_id`.
  UI не позволява да избереш `order_id` в такава ситуация.
- **Анулирана поръчка**: кебап опцията е disabled; backend също отказва (400).
- **Частично плащане по СР**: работи като при фактура — cumulative sum срещу
  `orders.total_amount`, показва "Частично" / "Платена" по същата логика като
  фактурните (реализирана в `cd23606`).
- **Фактура генерирана след плащания по СР**: плащанията остават с `order_id`.
  Не е обичаен случай. Ако потрябва — ръчна корекция в DB.

## 6. Testing

- **Backend (vitest):**
  - POST /payments с `order_id` → 201, запис със СР тип.
  - POST /payments с `order_id` за поръчка с фактура → 400.
  - POST /payments с анулирана поръчка → 400.
  - GET /payments?type=razpiska → връща само СР плащания.
  - GET /payments (default) → връща само фактурни (BC).
- **Frontend (manual):**
  - Kebab меню на поръчка без фактура → "Запиши плащане" → записва се → не се
    вижда на /payments "Фактурни".
  - `Cmd+Option+P` на /payments → "По разписки" таб се появява → вижда се
    записаното плащане.
  - Refresh (F5) → табът остава отключен.
  - Затваряне и нов tab → табът отново скрит.

## 7. Success Criteria

- Потребител може да запише плащане по поръчка без фактура от Orders kebab меню.
- Плащането **не** се появява в `/payments` "Фактурни".
- `Cmd+Option+P` отключва "По разписки" таб; записаното плащане е там.
- Статус badge (Частично / Платена) работи и в двата таба.
- Всички backend тестове PASS; `npx tsc --noEmit` — зелено.

## 8. Out of Scope

- Експорт / отчети за СР плащания (ще се добави по-късно при нужда).
- Notifications за СР плащания (ще ползваме същата `notifications` таблица
  с `type='payment_razpiska'` ако потрябва отчетност).
- Global command palette (Cmd+K) — решено да е само директен shortcut.
