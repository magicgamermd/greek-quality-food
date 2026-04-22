# Дневен отчет на плащания — Design Spec

**Date:** 2026-04-22
**Status:** Design approved, ready for implementation plan
**Author:** magic + Claude (brainstorming skill)

---

## 1. Context and Goal

В края на работния ден админът на МЕРТ-М трябва да може да:

1. Види **два списъка** за избрана дата — плащания по фактури и плащания по
   стокови разписки (СР).
2. Види **разбивка по начин на плащане** (в брой / по банка) за всеки списък.
3. **Принтира отчета** на хартия (A4) за архив и сверяване на касата.

Текущо `/payments` показва списък с плащания и филтри за дата, но няма:

- Разбивка на сумите по `payment_method` (cash vs bank+card) в summary-то.
- Бутон за бърз "днес" филтър.
- Print-friendly изглед.

**Goal:** Да разширим `Payments.tsx` минимално, така че admin в края на смяна
да може да филтрира по дата = днес, да види сумите в брой / по банка, и да
принтира чист отчет.

**Non-goals:**

- Не запазваме snapshot-и на отчети (ако се наложи, вж. Подход 2 в
  брейнсторма — `daily_reports` таблица).
- Не правим касова равносметка с начално салдо и въвеждане на преброени пари
  (решено: админът сам брои и сравнява с отчета).
- Не променяме съществуващи endpoint-и, няма БД миграции.
- Не добавяме analytics интеграция (`/analytics` остава извън scope-а).

## 2. Data Sources

**Използваме съществуващите таблици и endpoint:**

- `payments` (колони: `id`, `invoice_id`, `order_id`, `amount`,
  `payment_method` IN ('cash', 'bank', 'card'), `payment_date`, `reference`)
- `GET /payments?type=invoice|razpiska&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&limit=N`

**Класификация на плащане в таб:** следва съществуващия design в
`2026-04-21-razpiska-payments-design.md`:

| invoice_id | order_id | Таб      |
| ---------- | -------- | -------- |
| NOT NULL   | —        | Фактурни |
| NULL       | NOT NULL | Разписки |

**"Днес" означава:** ден в `Europe/Sofia` timezone. Backend сравнява
`payment_date::date` срещу ISO 8601 `YYYY-MM-DD` от query string. Сървърният
PGTZ трябва да е `Europe/Sofia`.

## 3. Frontend Changes

### Файл: `warehouse-frontend/src/pages/Payments.tsx`

**Ново състояние:** не се добавя ново — използваме съществуващия `filters` стейт
(`date_from`, `date_to`, `payment_method`, `search`).

### 3.1 Бутон "Днес"

Добавя се до date филтрите в Card секцията (~ред 240). On click:

```tsx
setFilters((prev) => ({
  ...prev,
  date_from: todayIso(),
  date_to: todayIso(),
}));
```

`todayIso()` връща `YYYY-MM-DD` в Europe/Sofia (използваме
`new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' })` —
шведският локал връща ISO формат).

### 3.2 Split summary (заместване на съществуващия 3-карти grid)

Условие: `filters.date_from && filters.date_to && filters.date_from === filters.date_to`.

Когато е вярно, summary-то е 4 карти:

```
┌──────────────────┬──────────────────┬──────────────────┬──────────────────┐
│ За [DD.MM.YYYY]  │ В брой           │ По банка         │ Общо за деня     │
│ (дата текст)     │ 2 500,00 лв.     │ 4 000,00 лв.     │ 6 500,00 лв.     │
│                  │                  │                  │ 5 плащания       │
└──────────────────┴──────────────────┴──────────────────┴──────────────────┘
```

Изчисление **client-side** от заредения `payments` масив:

```ts
const cashTotal = payments
  .filter((p) => p.payment_method === "cash")
  .reduce((s, p) => s + safeAmount(p.amount), 0);
const bankTotal = payments
  .filter((p) => p.payment_method === "bank" || p.payment_method === "card")
  .reduce((s, p) => s + safeAmount(p.amount), 0);
```

Когато не е един ден → връща се сегашния 3-карти summary ("Получени",
"Чакащи", "Общо транзакции"). Backward compatible.

### 3.3 Бутон "Принтирай отчет"

Добавя се до "Експорт CSV" (~ред 300). On click: `window.print()`.

### 3.4 Print CSS

Нов файл: `warehouse-frontend/src/pages/Payments.print.css` (или inline в
Payments.tsx чрез `<style>` таг). Импортира се в компонента.

```css
@media print {
  /* Скрий цялата навигация и chrome */
  aside,
  header,
  nav,
  .sidebar,
  .app-header {
    display: none !important;
  }

  /* Скрий интерактивни елементи */
  .no-print,
  button,
  input,
  select,
  .filters-card {
    display: none !important;
  }

  /* Основния контейнер — full width */
  main,
  .payments-page {
    padding: 0 !important;
    margin: 0 !important;
  }

  /* Заглавие за принта */
  .print-title {
    display: block !important;
    font-size: 16pt;
    text-align: center;
  }

  /* Summary и таблица остават */
  /* Footer с дата/час на отпечатване */
  .print-footer {
    display: block !important;
    font-size: 9pt;
    color: #555;
  }

  @page {
    size: A4 portrait;
    margin: 1.5cm;
  }
}
```

**Нови елементи в JSX** (скрити в normal view, видими само на принт):

```tsx
<div className="print-title hidden print:block">
  <h1>МЕРТ-М — Дневен отчет ({activeTab === 'invoice' ? 'Фактурни' : 'По разписки'})</h1>
  <p>{formatDateBg(filters.date_from)}</p>
</div>

<div className="print-footer hidden print:block">
  Отпечатано на {formatDateBg(new Date())} {formatTime(new Date())}
</div>
```

### 3.5 Заявка — вдигане на лимит в "дневен режим"

В `useQuery` `queryFn`, ако `date_from === date_to`, промени `limit` от 100 на
500:

```ts
params.set("limit", filters.date_from === filters.date_to ? "500" : "100");
```

## 4. Backend Changes

**Няма.** Съществуващият `GET /payments` handler приема всички нужни query
параметри. Единствена потенциална проверка: handler-ът трябва да приема
`limit=500` (не е hardcoded cap по-ниско). Ако е — вдигни cap-а до 1000.

## 5. Edge Cases

1. **Празен ден.** Split summary показва 0 лв. по всяка карта. Таблицата показва
   "Няма плащания". Принтът работи — "Няма движения" в table body.
2. **Анулирани документи.** Плащането остава в справката, но в колоната
   "Фактура"/"Поръчка" има visual tag "АНУЛИРАНА" (червен/strikethrough).
   Сумата **влиза** в summary.
3. **Множество плащания към един документ.** Всяко плащане = отделен ред
   (`payment_id`). Не групираме client-side. Summary агрегира правилно.
4. **>500 плащания за един ден.** Warning banner над таблицата: "Показват се
   първите 500. Сумите може да не са пълни." За МЕРТ-М практически недостижимо.
5. **Бъдеща дата.** Позволено. Връща празна справка.
6. **Timezone boundary.** Плащания в 23:50 UTC при сървърен TZ=UTC ще попаднат
   на грешен ден за български потребител. Сървърният PostgreSQL TZ трябва да е
   `Europe/Sofia`. Проверка при deploy.
7. **`card` payment_method.** Агрегира се в "По банка" (заедно с `bank`),
   защото и двете са безкасови и равностойни за целта на дневния отчет.

## 6. Testing

### Backend

Без промени → без нови тестове. `npm test` в `warehouse-backend` трябва да
минава зелено преди merge.

### Frontend — manual checklist

Стартирано приложение с реални данни:

1. "Днес" бутон → `date_from = date_to = today`, списъкът филтрира.
2. Split summary (един ден): 4 карти, `cash + bank = total`, сумите съвпадат с
   визуалния списък.
3. Summary (range / no filter): връща 3-карти изглед.
4. "Принтирай отчет": print preview показва заглавие + summary + таблица +
   footer; скрити sidebar, header, филтри, бутони.
5. И двата таба: "Фактурни" и "По разписки" (след `Cmd+Option+R`) принтират
   правилните заглавия.
6. Празен ден: 0 лв., "Няма движения" в принта.
7. Анулирана фактура: tag "АНУЛИРАНА" в реда, сумата е в summary.
8. Browsers: Chrome (основен) + Safari print preview.

### Frontend — unit (nice-to-have)

`Payments.test.tsx`:

- GIVEN 3 плащания (2 cash, 1 bank), `date_from === date_to`
- WHEN render
- THEN split cards показват правилни суми

Не е блокиращо за merge — manual checklist е приоритет.

## 7. Success Criteria

- Admin може да кликне "Днес" → да види днешните плащания филтрирани.
- Split summary показва в брой / по банка / общо коректно.
- "Принтирай отчет" дава clean A4 отчет без chrome на приложението.
- И "Фактурни", и "По разписки" табове работят независимо.
- `npm run lint` и `npx tsc --noEmit` в `warehouse-frontend` — зелено.
- Backend тестове — зелено.

## 8. Out of Scope

- Snapshot/история на дневни отчети (`daily_reports` таблица) — може да се
  добави по-късно, ако admin поиска "виж отчета за миналия понеделник".
- Касова равносметка с начално салдо и въвеждане на преброена сума.
- Експорт в PDF/Excel извън принта.
- Мулти-дневни обобщения (седмичен/месечен отчет) — `/analytics` обхваща това.
- Телеграм нотификация "дневен отчет готов".
