# Greek Quality Food — STATUS

**Last updated:** 2026-06-18

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
- ⏳ Остават: проформи + invoice инструменти (в `invoices.ts` — NET money файл, изискват внимание), OCR/PWA подобрения, frontend search

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
