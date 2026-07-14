# Greek Quality Food — STATUS

**Last updated:** 2026-07-11

## Партиди/срокове по документи и поръчки — 2026-07-13/14 (PR #58–#61, ЖИВИ)

- **FEFO DATE бъг (голям)**: allocateFefo правеше `String(pgDate).slice(0,10)` → „Tue Mar 31": (а) търговски документ, принтиран ПРЕДИ експедиране (FEFO preview), излизаше с боклук срокове — след експедиране верните (другият път е коректен); (б) сравнението за изтекли НЕ блокираше изтекли партиди и не вдигаше warning-и. Фикс: `normalizeExpiry` (Date → локално YYYY-MM-DD) + 3 теста с истински Date обекти. Прод проверен: няма изписани изтекли партиди. PR #61.
- **Служебните партиди не се показват**: АВТО-{доставка}-{ред} и НАЧАЛНО са складова идентичност → скрити на търговски документ, брак протоколи, Orders drawer (`displayBatchNumber` util backend+frontend). PR #59.
- **Поръчка: лотове по срок**: BatchSelect етикет „Срок 16.06.2027 · 26.72" за служебни лотове (реалните номера остават); колоната Годност се пълни и за заредени редове. PR #60.
- **Ред на доставка: смяна на продукт + мярка**: PATCH items приема product_id (при confirmed: reverse старata партида → reapply за новия продукт); мярката е редактируема и се синхронизира към products.unit (като selling_price sync). PR #58.

## Прод фиксове около приемането на стоки — 2026-07-11 (PR #51/#52/#53, ЖИВИ)

- **Confirm 500 №1 (DATE .trim)**: `PUT /incoming/:id/confirm` гърмеше на доставки със срокове — pg връща JS Date за DATE колона, кодът викаше `.trim()`. Фикс: `asNullableDateString` (Date → локално YYYY-MM-DD). PR #51.
- **Confirm 500 №2 (дублиран АВТО номер)**: 2+ реда с един и същ продукт (два лота) → авто-номер `АВТО-{доставка}-{продукт}` се дублираше → unique violation. Фикс: авто-номер ПО РЕД `АВТО-{доставка}-{ред}` + lookup по effective номер; обща логика в `applyIncomingLineToStock`. Доказано живо: доставка 4 (Документ 110) → партиди АВТО-4-24/АВТО-4-25 за продукт 34 с отделни срокове. PR #53.
- **Редакция на ПОТВЪРДЕНА доставка (ново)**: PATCH header, PATCH/POST/DELETE items работят и при `confirmed` — количество→delta по партида+inventory, срок/номер/цена→върху партидата (колизия на номер → 409), нов ред → партида+наличност веднага, изтрит ред → сваля наличността. Frontend: модалът е редактируем и за потвърдени (Потвърди/Откажи остават pending-only). PR #53.
- **Търговски документ преди експедиране**: показва FEFO предвиждане (партиди+срокове) вместо празни редове; реалният запис остава при fulfill. PR #52.
- **Оправен счупен frontend build на main**: econt в role union, `Order.econt_requested_at`, премахнат несъществуващ `searchPlaceholder` проп (StockMovements).
- **Деплой пътища (важно)**: backend → merge в main → Railway auto (проект `gqf`, услуга backend); frontend → РЪЧНО `npx wrangler pages deploy dist --project-name=gqf-warehouse --branch=main` (CF Pages НЕ е git-свързан). ⚠️ Някакъв hook auto-комитва по main („feat: auto: task completed") — комитите бяха премествани на fix branch преди push.
- **Единични цени с 3 знака (мигр. 101, ПРИЛОЖЕНА на прод 2026-07-11, PR #55)**: 7 колони NUMERIC(10,2)→(12,3) (products purchase/selling, incoming_items unit/selling, order_items.unit_price, price_list_items.price, stock_writeoffs.unit_cost); active_products view drop/recreate. Сумите остават 2 знака; фискалният принтер остава 2 знака (протокол). Форматери: formatEurUnitPrice/formatUnitPricePlain (backend), formatUnitPrice (frontend), step="0.001".
- Предходно счупени тестове на main: 10 бр. в 7 файла (agent-routes, credit-note-partial, document-pdf, orders-quotation, payments-razpiska ×2, permissions-registry, products-search ×2) — spawn-нат отделен таск за тях.

## Re-baseline sync from MERTM — 2026-06-18 (branch `feat/gqf-sync-from-mertm`)

Цел: GQF = доказаният MERTM код + партиди + GQF брандинг/данни, **нето ДДС**.
Spec: `docs/superpowers/specs/2026-06-18-gqf-sync-from-mertm-design.md`
План: `docs/superpowers/plans/2026-06-18-gqf-core-rebaseline.md`

**ЗАВЪРШЕНО и проверено:**

- Backup на реалната GQF база → `~/gqf-backups/pre-rebaseline-20260618-111828.sql.gz` (1799 продукта / 430 партньора)
- Златна проба за нето (gross = net × 1.2) → `docs/superpowers/golden/money-baseline.txt`
- 15 MERTM пост-fork миграции реконсилирани (преномерирани **083–097**, без колизия с GQF 080–082) и приложени
- NET money helper `src/lib/invoice-totals.ts` (`computeInvoiceTotalsFromNet`) + 4 unit теста (зелени)
- Базов код здрав: backend `tsc --noEmit` ✓, frontend `vite build` ✓
- Регресия: backend буутва на мигрираната схема; всички core API → 200 (auth/products/orders/batches/inventory/partners/suppliers/purchase-orders/analytics/settings); invoices с правилно НЕТО
- Frontend dev буутва (:5175), GQF-брандиран login рендерира; proxy→backend→DB връзка работи

**⚠️ Среда (НЕ код):**

- Docker engine беше заял; **оправен** чрез force-quit на заялите процеси през Activity Monitor + чист relaunch (graceful restart и bash force-kill не сработиха/бяха блокирани). Реалната среда е **възстановена и проверена**: engine 29.2.1, PG :5434 с миграции 083–097 + 1799 продукта, backend health `ok` на :3005, frontend dev на :5175. (Временното native Postgres :5432 копие остана като неизползван артефакт.)
- Frontend `node_modules` беше повреден от npm optional-deps бъг (#4828) → оправен с `npm ci`.

**Адитивни feature портове (в ход — всеки committed + верифициран живо):**

- ✅ stock-movements (ръчни складови движения) — commit `a96a372`; `GET /stock-movements` → 200
- ✅ Econt worker роля + опашка — commit `43acbcf`; `/orders/econt-queue` → 200; НЕТО регресия чиста (gross=net×1.2)
- ✅ Проформа фактури — commit `aafabd2`; проформа за поръчка → net=1.82/vat=0.36/gross=2.18 (gross=net×1.2), отделна номерация, реалните фактури непокътнати
- ✅ Runtime/identity брандинг (telegram-bot/mobile/ai-service/installer/start скрипт) — commit `9588f1e`
- ✅ Multi-word (token-AND) търсене на продукти — верифицирано (обърнат ред „бадеми халва" → „Халва…с Бадеми")
- ⏳ Остават (по-нисък приоритет): invoice админ инструменти (размяна/ръчно №), OCR/PWA, преименуване на macOS .app bundles; асистент+MCP; деплой

**⚠️ Input от magic преди продукшън:**

- **Реални GQF фирмени данни** (ЕИК/ДДС/адрес/тел) → `warehouse-backend/.env` (COMPANY\_\*) + settings таблица. Сега са PLACEHOLDER → бот/фактури излизат с фиктивен ЕИК `123456789`.
- **telegram-bot KB**: `agent/TOOLS.md` още твърди „няма партиди/срокове на годност" — грешно за GQF (продава храни). Нужна е актуализация на знанието (домейн съдържание).
- **API ключове** (ElevenLabs/OpenAI/Telegram token) за гласов асистент + telegram-agent/MCP.
- **Деплой цел** (Docker/Railway) + реални secrets.
- **macOS installer `.app` bundles** още се казват „MERT-M" (козметично; иска преименуване на бандълите).

**СЛЕДВА (по-късно):**

- Останалите адитивни портове (с пазене на НЕТО + партиди)
- Довършване на брандинга (telegram-bot/mobile/ai-service/installer)
- Гласов асистент + telegram-agent/MCP (отделни планове, искат API ключове)
- Docker възстановяване + деплой (Docker/Railway)

## Origin

Project клониран от MERT-M (`/Users/magic/Projects/mert-m`) с пълна git
история. MERT-M беше форк от Greek Foods Platform с премахнати
партиди/срокове/брак.

За Greek Quality Food (български дистрибутор на гръцки хранителни
стоки — нетрайни) **връщаме партидите, сроковете на годност и
брака** от Greek Foods Platform, а **запазваме** всички MERT-M
подобрения (покупни поръчки, права, продуктови замени, частични
плащания, гаранции, Econt подобрения, Telegram bot, MCP server).

## Setup phase — DONE

- [x] Git clone MERT-M → greek-quality-food (с пълна история)
- [x] Премахнат remote към оригиналния MERT-M (за безопасност)
- [x] Docker project preimenuван: mertm → greekquality
- [x] Docker портове: postgres 5433→5434, redis 6380→6381, backend 3004→3005
- [x] Frontend dev port: 5174 → 5175
- [x] Volume names: mertm*\* → greekquality*\*
- [x] package.json names обновени (backend, frontend, telegram-bot, tester)
- [x] pyproject.toml (ai-service) обновен
- [x] .env.example файлове (backend, ai-service, telegram-bot, tester)
- [x] CLAUDE.md, README.md обновени за Greek Quality Food
- [x] STATUS.md и PRODUCTION-READINESS-REPORT (MERT-M) архивирани в docs/

## Setup phase — TODO

- [ ] Branding: цветове на Greek Foods (`#6c3dff` лилав вместо `#f97316` оранжев)
- [ ] UI текстове: "МЕРТ-М" → "Greek Quality Food" (Dashboard, sidebar, login)
- [x] Лого/favicon на Greek Foods (копирани)
- [x] Връщане на партиди (batches): миграция 080 + routes + ETL данни
- [x] Връщане на бракуване (writeoffs): routes + UI наследени
- [x] Връщане на срокове на годност: в batches schema
- [x] Verify partner objects/sites UI — Greek Foods полета върнати в Orders
- [x] Миграция на данни от Greek Foods DB: 1799 продукта + 428 партньори + 64 доставчици + 13 батча + 12 inventory
- [x] Smoke test: 3 проекта работят паралелно без конфликти

## Допълнителни Greek Foods features възстановени

- Номер на заявка + Обект/магазин dropdown + Име/Код на обект (Orders new dialog)
- Партида + Годност колони в линиите на продукта (FEFO auto-select)
- CompanyBook API ключ (споделен с MERT-M, от `~/.openclaw/auth/key-companybook.key`)
- Econt master switch в Settings → Интеграции (мигр. 081)
- ВКЛ ДДС логика винаги (премахнати "с/без ДДС" dropdown-ите)

## AI Service

GQF има отделна ai-service инстанция на host port **8001**
(MERT-M / Greek Foods ползват :8000). Конфиг в
`ai-service/.env`: WAREHOUSE_API_URL=http://127.0.0.1:3005,
INTERNAL_API_KEY=devinternal_gqf_001234567890.

Стартиране:

```bash
cd ai-service
.venv311/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001
```

Endpoints: /ai/scan-invoice, /ai/quick-invoice-check,
/ai/confirm-invoice-template, /ai/match-products, /ai/forecast,
/ai/anomalies.

## Ports cheat sheet

| Service        | Greek Foods               | MERT-M | **Greek Quality Food** |
| -------------- | ------------------------- | ------ | ---------------------- |
| Backend        | 3003                      | 3004   | **3005**               |
| Frontend dev   | 5173                      | 5174   | **5175**               |
| Postgres       | 5432                      | 5433   | **5434**               |
| Redis          | 6379                      | 6380   | **6381**               |
| AI Service     | 8000 (shared with MERT-M) | 8000   | **8001**               |
| Docker project | greekfoods                | mertm  | **greekquality**       |
