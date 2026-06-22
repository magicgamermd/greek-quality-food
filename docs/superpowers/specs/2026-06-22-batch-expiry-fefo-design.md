# Партиди, срокове на годност и FEFO — дизайн

**Дата:** 2026-06-22
**Статус:** Одобрен (magic)
**Клон:** `feat/GQF-batch-expiry-fefo`

## 1. Проблем (резултат от анализа)

Схемата за партиди/срокове/брак съществува в базата (върната с миграция 080), но
**кодът не я използва никъде**. Партидите са осиротял остров:

- **Доставка (ръчна + OCR):** няма полета за партида/срок; backend Zod схемата ги
  маха нарочно (стар MERT-M код); при потвърждение наличността се вдига по продукт
  с `batch_id = NULL` — партида не се създава.
- **OCR:** ai-service вади партида + срок богато, но review екранът ги изхвърля.
- **Поръчки:** колоните „Партида/Годност" са фалшиви (надпис „авто (FEFO)"); FEFO е
  изтрит (`fefo-allocator.ts` липсва); изписва се по продукт.
- **Наличност:** по продукт, не по партида → няма „колко от лот X е останал".
- **Брак** (`writeoffs.ts`): единственото партидно-наясно нещо, но изолирано.
- **Owner app в продукция е счупен** по 3 причини (виж §7).
- ⚠️ **Латентен бъг (потвърден на живата БД):** индексът
  `inventory_product_warehouse_nobatch_uidx` е премахнат от 080, но кодът още прави
  `ON CONFLICT (product_id, warehouse_id) WHERE batch_id IS NULL` → потвърждаване на
  доставка / отказ на поръчка гърми. Новият модел го оправя.

## 2. Решения (одобрени)

| Решение                       | Избор                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------ |
| Дълбочина                     | **Пълно:** партиди + FEFO + наличност по партида                               |
| Изтекъл срок при продажба     | **Блокирай изтекли** + предупреждавай за изтичащи (<30 дни)                    |
| Обхват                        | **Всичко наведнъж** (един голям клон)                                          |
| Текуща наличност              | Прехвърля се в синтетична **откриваща партида** „НАЧАЛНО" (без срок)           |
| Разделяне на линия по партиди | Нова таблица **`order_item_batches`**                                          |
| Документи                     | Партида/срок **само на търговския документ**; фактура + разписка остават чисти |

## 3. Модел на данните (миграция `098_batch_inventory_fefo.sql`, additive)

- **Наличност по партида:** всеки `inventory` ред е за (product_id, warehouse_id,
  **batch_id**). Кодът винаги пише non-NULL `batch_id`.
- **Откриваща партида:** за всеки продукт с наличност в NULL-партида ред →
  find-or-create партида `batch_number = 'НАЧАЛНО'`, `expiry_date = NULL`,
  `purchase_price = products.purchase_price`; прехвърля количеството; обновява
  `inventory.batch_id`. След това няма NULL-партида редове.
- **Уникалност:** ползваме съществуващия `UNIQUE(product_id, batch_id, warehouse_id)`
  (`inventory_product_id_batch_id_warehouse_id_key`) за upsert-ите → оправя счупения
  ON CONFLICT. Сменяме `ON CONFLICT (product_id, warehouse_id) WHERE batch_id IS NULL`
  на `ON CONFLICT (product_id, warehouse_id, batch_id)`.
- **Нова таблица `order_item_batches`:**
  - `id SERIAL PK`
  - `order_item_id INT NOT NULL` FK → order_items(id) ON DELETE CASCADE
  - `batch_id INT NOT NULL` FK → batches(id) ON DELETE RESTRICT
  - `quantity NUMERIC(12,3) NOT NULL CHECK (> 0)`
  - `unit_cost DECIMAL(12,4) NOT NULL` (себестойност от партидата при изписване)
  - `created_at TIMESTAMPTZ DEFAULT NOW()`
  - индекси по order_item_id и batch_id
- **`incoming_items`:** добавяме `batch_number VARCHAR(100)` + `expiry_date DATE`
  (държат въведените стойности преди потвърждение; `batch_id` се сетва при confirm).
- Без `NOT NULL` смени по съществуващи колони (additive-only; инвариантът non-NULL
  `batch_id` се пази в кода, не със схемна промяна → безопасен rollback).

## 4. Входяща доставка (ръчна + сканиране)

### Backend (`routes/incoming.ts`)

- `createIncomingSchema` (per-line): + опционални `batch_number`, `expiry_date`,
  `production_date`. Спираме да ги махаме.
- Line INSERT: записва `batch_number` + `expiry_date` в `incoming_items`.
- `PUT /incoming/:id/confirm`: за всеки ред → find-or-create партида по
  (product_id, batch_number) (ако няма номер: генерира от срок/производство или
  ползва откриваща); сетва expiry/purchase_price/delivery_id; вдига
  `batches.quantity`; upsert наличност **по партида**.
- `PATCH /incoming/:id/items`: вече пази batch/expiry.
- Записва `stock_movements` с `batch_id` (вход).

### Frontend

- **Ръчна форма** (`IncomingGoods.tsx` редовете): + колони **Партида** и
  **Срок на годност**; обновяваме `manualItems` state + payload.
- **Сканиране desktop + owner** (`IncomingGoods.tsx`, `OwnerScan.tsx`): показваме
  batch/expiry (предв. попълнени от OCR raw), редактируеми, в payload-а при запис;
  маркираме липсващите (OCR `missing_batch`/`missing_expiry`).

## 5. Поръчки + FEFO

### Backend (`routes/orders.ts` + нов `services/fefo-allocator.ts`)

- `orderItemSchema`: + опционален `batch_id` (ръчен override).
- `fefo-allocator.ts`: за (product_id, warehouse_id, qty) разпределя по партиди
  `ORDER BY expiry_date ASC NULLS LAST` (датираните първи, откриващата последна),
  **пропуска изтекли**; връща allocations `[{batch_id, qty, unit_cost}]`. Ако няма
  достатъчно неизтекла наличност → ясна грешка.
- Замяна на `deductProductStock` с партидно-наясно изписване: ако има ръчен
  `batch_id` → от нея (блокира ако е изтекла); иначе FEFO. Намалява наличност **по
  партида** + `batches.quantity`; пълни `order_item_batches`; сетва
  `order_items.batch_id` (основната) + `cost_unit_price`/`cost_source_batch_id`.
- Изтичащи <30 дни → warning във отговора (за UI).
- `stock_movements` с `batch_id` (изход).

### Frontend (`Orders.tsx`)

- При избор на продукт: fetch `GET /batches?product_id=X` (наличните, със срок),
  падащо меню (номер · срок · налично кол-во); FEFO подсказва най-ранния неизтекъл;
  ръчен избор позволен. Изтекли = disabled (червено); изтичащи = жълто.
- Блокира submit при изтекла/недостатъчна неизтекла наличност (огледало на backend).

## 6. Документи (твърдо правило)

- **Фактура** (`invoice-pdf.ts`) → БЕЗ партида/срок. **Не се пипа** (вече е правилна).
- **Стокова разписка** (`document-pdf.ts` razpiska / `razpiska-replacement-pdf.ts`)
  → БЕЗ партида/срок.
- **Търговски документ** (`document-pdf.ts:1558+`) → показва партида + срок за всички
  продукти от фактурата. Рендерът **вече има** тези колони (ред 1633-1634) — стоят
  празни само защото нищо не ги пълни. Захранва се от `order_item_batches`: ако
  линия е разделена по няколко партиди → няколко реда (по партида · срок · кол-во).
- Данновата функция, която зарежда редовете за търговския документ, се разширява да
  чете allocations от `order_item_batches` (вместо празния JOIN по `order_items.batch_id`).

## 7. Спешни поправки в продукция (owner app „не работи")

- **Роля `owner_mobile`:** миграция добавя `'owner_mobile'` към CHECK на `users.role`
  - в `auth.ts` register enum → owner може да влиза (днес само admin минава gate-а).
- **CORS:** Railway env `CORS_ORIGIN` да включва `https://gqf-warehouse.pages.dev`
  (+ при нужда pattern за `*.pages.dev` в `index.ts`).
- **`AI_SERVICE_URL`:** Railway backend env да сочи деплойнатия ai-service
  (Railway private networking) → `/incoming/scan` стига до OCR в прод.

## 8. Тестове

- **TDD** за `fefo-allocator.ts` (най-ранен срок първи, пропуска изтекли, разделяне
  по партиди, недостатъчна наличност, откриваща последна).
- Пренаписване на `__tests__/orders-no-batch.test.ts` → партиден/FEFO контракт
  (items имат batch_id; SQL пише `order_item_batches`; COGS по партида).
- Тестове: доставка → създава партида + наличност по партида; миграция на откриваща
  партида (идемпотентна); блокиране на изтекли при поръчка.
- **Златни проби:** парите остават NET×1.2; COGS вече по партида.
- Регресия: `tsc --noEmit`, backend build, frontend `vite build`.

## 9. Изкарване в продукция

1. Всички тестове минават; backend build + frontend build успешни.
2. **Бекъп на прод БД** (преди миграцията).
3. Деплой backend (`098` миграция тече при старт) — следи за грешки.
4. Деплой ai-service + сетни Railway env (`AI_SERVICE_URL`, `CORS_ORIGIN`).
5. Деплой frontend (CF Pages) + миграция за `owner_mobile`.
6. Smoke: вход (admin + owner), доставка с партида, поръчка с FEFO, търговски
   документ показва партида/срок, фактура чиста.

## 10. Рискове

- **Най-чувствително:** миграцията на наличността (откриваща партида) + смяната на
  изписването. Митигиране: бекъп преди миграция, идемпотентна миграция, златни
  проби, пълни тестове преди merge към `main`.
- Раздалечени партиди в една линия → търговският документ трябва коректно да реди
  под-редове. Покрито от `order_item_batches` + тест.
- Прод данни (1799 продукта) с текуща наличност → откриващата партида трябва да
  запази точните количества (verify сума преди/след).
