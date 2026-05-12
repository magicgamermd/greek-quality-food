# MERT-M — Production Readiness Report

**Дата на одита:** 2026-04-22 (нощен QA маратон)
**Scope:** Finalize existing `/Users/magic/Projects/mert-m/` за production deploy на Mac Mini M4
**Timeline:** Scope D — 1+ месец, пълен cleanup + load testing + 100% test coverage

---

## TL;DR — отговори на двата директни въпроса

### 1. Колко ни остава до продукшън?

**Честен отговор: 4–6 седмици минимално work; 6–8 седмици с буфер за тест + физически тест на фискалния принтер и пилотен период с реални поръчки.**

- **P0 blockers (абсолютно трябва да се fix-нат):** ~**8–10 работни дни**
- **P1 high-severity (силно препоръчително):** ~**10–15 работни дни**
- **P2 hardening + observability + load testing:** ~**5–10 работни дни**
- **Физически тест на DAISY принтер + Econt live shipments + user pilot:** ~**7–10 календарни дни**

**Sum: 30–45 work-days от един dev full-time + 2 седмици пилот = ~6–8 седмици до confident go-live.**

Ако се съсредоточим САМО върху P0 → "можем да стартираме с ръчно подкрепяне" за ~2 седмици (не се препоръчва за реален бизнес).

### 2. Дали всичко е свързано и работи както трябва?

**Краткият отговор: архитектурно да, production-ready НЕ.** Системата се стартира и основните flows работят, но има **критични blocker-и за production deployment** и значителни **качество/сигурност** пропуски, неприемливи за реален търговски склад.

**Production Readiness Score: 4/10** (според DevOps audit)

**Работи:**

- Backend + Frontend + AI-service се стартират и говорят помежду си
- 196/198 backend тестове минават
- Econt live API smoke-test успешен (city lookup работи)
- OCR pipeline e функционален
- Razpiska payments работи (след ac1e8b6 fix)
- DB schema-та е стабилна (52 миграции, 31 таблици)
- Основните CRUD flows (поръчки/фактури/партньори) работят в UI

**НЕ работи / счупено / необезопасено:**

1. **Секрети в `.env` са placeholder-и** (DB password, JWT secret, Redis, INTERNAL_API_KEY) → backend няма да стартира в production
2. **Econt live парола `wkpYyWBM#WenMB7` е в `.env` с `-rw-r--r--` права** (world-readable) → трябва незабавна ротация + chmod 600
3. **AI-service няма `.env` изобщо** → OCR и service-to-service auth падат в runtime
4. **Econt API повиква се по HTTP, не HTTPS** → Basic auth credentials пътуват в plain text
5. **Фискален принтер не е тестван с физическо устройство** → DAISY binary protocol никога не е проверен срещу реална машина + няма тестове за BCC checksum/packet framing
6. **Mobile app все още branded "Greek Foods Analytics"** с `com.greekfoods.analytics` bundle ID
7. **Race condition на razpiska payments** (confirmed) → две паралелни плащания и двете успяват над лимита
8. **Няма error tracking** (Sentry/Bugsnag) навсякъде → production bug-ове ще бъдат невидими
9. **Няма `docker-compose.prod.yml`, nginx config, TLS, launchd script, DEPLOY.md** → deployment инфраструктурата липсва
10. **Telegram bot `.env` е напълно празен** + wrong port (3000 вместо 3003) + fail-open access control

---

## Финален Production Readiness Score по сервиз

| Component              | Score | Status                                        | Critical blockers                                                                              |
| ---------------------- | ----- | --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **warehouse-backend**  | 7/10  | Mostly works                                  | Placeholder secrets, race condition в payments, настройки endpoint leak-ва пароли              |
| **warehouse-frontend** | 6/10  | UI работи, но Railway URL в `.env.production` | ErrorBoundary не докладва грешки, стар deploy target                                           |
| **ai-service**         | 5/10  | Функционален, но no `.env` и 2 failing tests  | Wrong-product false positive при SKU-only match, venv symlinked към greek-foods                |
| **telegram-bot**       | 3/10  | Не стартира                                   | Empty `.env`, wrong port, fail-open access, GF- regex legacy, no crash handlers                |
| **mobile-app**         | 2/10  | Build-ва, но грешен продукт                   | Все още `com.greekfoods.analytics` — НЕ МОЖЕ да се publish-не така                             |
| **fiscal integration** | 2/10  | Код написан, но untested                      | Няма физически тест, няма packet/BCC тестове, няма retry queue                                 |
| **Econt integration**  | 6/10  | Работи, но insecure                           | HTTP not HTTPS, unbounded cache, empty catches, placeholder sender address                     |
| **DevOps / infra**     | 4/10  | Има CI, но няма prod deploy                   | No docker-compose.prod, no TLS, no backup cron, no monitoring                                  |
| **Security posture**   | 3/10  | Много дупки                                   | Placeholder JWT, `fiscal_operator_password` default `0000`, settings endpoint експозира пароли |
| **Observability**      | 2/10  | Почти нулева                                  | No Sentry, no Prometheus `/metrics`, no structured log shipping, no `pg_stat_statements`       |

**Overall: 4/10 — не е готово за production.**

---

## P0 — Production blockers (BLOCKER, не тръгваме без тях)

### Security / Secrets — P0

| #    | Issue                                                                                                                                                                | Файл / локация                                                  | Estimate |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------- |
| P0-1 | 6 placeholder secrets в `warehouse-backend/.env`: `POSTGRES_PASSWORD`, `PGPASSWORD`, `DATABASE_URL`, `REDIS_PASSWORD`, `REDIS_URL`, `JWT_SECRET`, `INTERNAL_API_KEY` | `warehouse-backend/.env`                                        | 0.5d     |
| P0-2 | Econt live парола `wkpYyWBM#WenMB7` — **незабавна ротация** + `chmod 600` на всички `.env` файлове                                                                   | `warehouse-backend/.env:57`                                     | 0.5d     |
| P0-3 | `ai-service` няма `.env` → OCR и AI↔backend auth не работят в runtime                                                                                                | `ai-service/`                                                   | 0.25d    |
| P0-4 | `GET /settings` връща `fiscal_operator_password` в plain text на warehouse/accountant роли                                                                           | `warehouse-backend/src/routes/settings.ts:71-96`                | 0.5d     |
| P0-5 | Startup assertion срещу placeholder JWT (`change-me-to-a-random-64-char-string`)                                                                                     | `warehouse-backend/src/index.ts`                                | 0.25d    |
| P0-6 | Econt endpoint по `http://ee.econt.com/services` — преминаване към `https://` + `ECONT_BASE_URL` env                                                                 | `warehouse-backend/src/routes/econt.ts:9`, `econt-sender.ts:12` | 0.25d    |
| P0-7 | `fiscal_operator_password` default `"0000"` в кода — махни fallback                                                                                                  | `warehouse-backend/src/services/fiscal-printer.ts:63`           | 0.25d    |
| P0-8 | Admin парола все още `AdminTest123` (reset по време на QA) — reset към силна production парола                                                                       | DB                                                              | 0.1d     |

**Subtotal: ~2.5 work-days**

### Data Integrity / Correctness — P0

| #     | Issue                                                                                                                                                                                            | Файл / локация                                              | Estimate |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | -------- |
| P0-9  | **Race condition:** razpiska payments — две паралелни плащания в същата секунда преминават лимита (confirmed via integration test: 2×70 BGN на 100 BGN поръчка успяха и двете, total 140 > cap)  | `warehouse-backend/src/routes/payments.ts:302-368`          | 1d       |
| P0-10 | 2 failing tests в `ai-service/app/routers/match.py::_sku_code_match` — SKU-only matches връщат 0.99 confidence дори при конфликт по име И цена (wrong-product false positives с финансов impact) | `ai-service/app/routers/match.py`                           | 0.5d     |
| P0-11 | 2 failing tests в `payments-razpiska.test.ts:57` и `:135` след ac1e8b6 fix — семантиката се промени, fixture-ите не са обновени                                                                  | `warehouse-backend/src/__tests__/payments-razpiska.test.ts` | 0.25d    |
| P0-12 | DELETE endpoints нямат role guards: `/suppliers/:id`, `/categories/:id`, `/product-aliases/:id` — всеки authenticated user може да трие                                                          | `warehouse-backend/src/routes/*.ts`                         | 0.5d     |
| P0-13 | `POST /inventory/reset-stock` трие ЦЯЛ inventory без confirmation/audit/idempotency                                                                                                              | `warehouse-backend/src/routes/inventory.ts:346`             | 0.5d     |

**Subtotal: ~2.75 work-days**

### Mobile App Branding — P0 (НЕ може да се публикува така)

| #     | Issue                                                                                                                                              | Файл / локация        | Estimate |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------- |
| P0-14 | `mobile-app/app.json` все още `"name": "Greek Foods Analytics"`, `bundleIdentifier: com.greekfoods.analytics`, `package: com.greekfoods.analytics` | `mobile-app/app.json` | 0.5d     |
| P0-15 | 6 branding refs в source (`src/theme/colors.ts`, 4× screens)                                                                                       | `mobile-app/src/`     | 0.25d    |
| P0-16 | **Decision:** keep `mobile-owner-app/` or delete? (Owner PWA вече в warehouse-frontend — дублираща функционалност)                                 | —                     | 0.1d     |

**Subtotal: ~0.85 work-days** (if keeping mobile-app; delete mobile-owner-app saves time)

### Deployment Infrastructure — P0

| #     | Issue                                                                                                                           | Файл / локация                       | Estimate |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------- |
| P0-17 | No `docker-compose.prod.yml`                                                                                                    | `/`                                  | 1d       |
| P0-18 | Empty `nginx/` + no TLS config                                                                                                  | `/`                                  | 1d       |
| P0-19 | `.env.production` в frontend сочи Railway (`backend-production-252f.up.railway.app`), а не Mac Mini                             | `warehouse-frontend/.env.production` | 0.1d     |
| P0-20 | No `launchd` plist / autostart за Mac Mini self-hosting                                                                         | `/`                                  | 0.5d     |
| P0-21 | No `DEPLOY.md` runbook                                                                                                          | `/docs/`                             | 0.5d     |
| P0-22 | Backup script `scripts/backup/nightly-pg-dump.sh` все още `greek-foods-platform` в коментарите + S3 bucket `greekfoods-backups` | `scripts/backup/nightly-pg-dump.sh`  | 0.25d    |
| P0-23 | PM2 config / frontend Dockerfile липсва; ai-service работи в `--reload` dev mode                                                | няколко места                        | 0.5d     |
| P0-24 | Cron job за backup + restore test                                                                                               | `/`                                  | 0.5d     |

**Subtotal: ~4.35 work-days**

### Telegram Bot — P0

| #     | Issue                                                                                                                             | Файл / локация                  | Estimate |
| ----- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------- |
| P0-25 | `telegram-bot/.env` е напълно празен                                                                                              | `telegram-bot/.env`             | 0.1d     |
| P0-26 | `API_URL=http://localhost:3000` — грешен порт (backend е 3003)                                                                    | `telegram-bot/.env`             | 0.05d    |
| P0-27 | **Fail-open access control:** `if (ALLOWED_USERS.length === 0) return true;` — празен ALLOWED_USERS = всеки може да използва бота | `telegram-bot/bot.js:361`       | 0.25d    |
| P0-28 | Hardcoded `GF-` invoice regex (legacy Greek Foods)                                                                                | `telegram-bot/bot.js:250, 1417` | 0.25d    |
| P0-29 | No `unhandledRejection` / `uncaughtException` handlers — crash без restart                                                        | `telegram-bot/bot.js:1514`      | 0.1d     |

**Subtotal: ~0.75 work-days**

**P0 TOTAL: ~11 work-days** (~2 weeks)

---

## P1 — High severity (сериозно препоръчително преди launch)

### Performance + Observability

| #    | Issue                                                                                                                 | Estimate |
| ---- | --------------------------------------------------------------------------------------------------------------------- | -------- |
| P1-1 | **Добави Sentry** към backend, frontend, ai-service, telegram-bot — error tracking е critical за production debugging | 1d       |
| P1-2 | Frontend `ErrorBoundary.tsx:26` swallow-ва грешки в `console.error` — errors никога не напускат browser-а             | 0.25d    |
| P1-3 | `pg.Pool` max = 10 (default) → saturation при 9-10 concurrent queries. Бумни на 20-30 или добави pgbouncer            | 0.5d     |
| P1-4 | Enable `pg_stat_statements` + добави `/internal/db-stats` admin endpoint                                              | 0.5d     |
| P1-5 | `/metrics` endpoint (`fastify-metrics` / prom-client) за backend + ai-service                                         | 1d       |
| P1-6 | ai-service `/health` не проверява DB/OCR модел — false positive                                                       | 0.25d    |
| P1-7 | Log rotation + shipping (docker log driver + max-size или launchd + logrotate)                                        | 0.5d     |
| P1-8 | Backend `GET /partners?search=ресторант` → HTTP 400 (Cyrillic param bug)                                              | 0.25d    |

### God-routes Refactor (тъй като Scope D е 1+ месец = "pълно почистване")

| #     | Issue                                                                                                                               | Estimate |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | -------- |
| P1-9  | `incoming.ts` (2419 lines), `orders.ts` (2054), `invoices.ts` (1077) — 50% of всички route файлове. Разделяне на подсервисни модули | 4-5d     |
| P1-10 | Fastify плъгини за повторно използваните middleware (auth, role guards, rate-limits)                                                | 1d       |

### Econt Hardening

| #     | Issue                                                                                                         | Estimate |
| ----- | ------------------------------------------------------------------------------------------------------------- | -------- |
| P1-11 | `citiesCache` / `officesCache` unbounded `let` vars без TTL — добави 24h TTL + manual cache-bust endpoint     | 0.5d     |
| P1-12 | 5× empty `catch {}` blocks в `econt.ts:287-289, 369-371, 485-487, 540-542, 563-565` — поне `request.log.warn` | 0.25d    |
| P1-13 | `econt.ts:56` — upstream error body leak-ва в client response, sanitize                                       | 0.25d    |
| P1-14 | `1.95583` BGN/EUR conversion constant duplicated 3× (econt.ts:196, 308, 415) — extract                        | 0.1d     |
| P1-15 | Replace placeholder sender env `Example` street + `0888123456` phone с реалния MERT-M pickup address          | 0.1d     |

### Fiscal Integration (HARD requirement ако ще се използва)

| #     | Issue                                                                                                                                       | Estimate     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| P1-16 | Unit tests за `buildDaisyPacket` / `parseDaisyResponse` (BCC, framing, NAK/SYN handling) — НАП одит няма да прости грешки в binary protocol | 2d           |
| P1-17 | Retry queue / `fiscal_status='pending'` колона + background worker — текущо receipts могат да се загубят мълчаливо при offline printer      | 1-2d         |
| P1-18 | Decision: drop serial driver OR add `serialport` to deps + integration test                                                                 | 0.5d         |
| P1-19 | Физически тест с DAISY Compact M 02 (при клиента) — запознаване, първи Z-report, fiscal acceptance test                                     | 2d (on-site) |

### Data Layer Cleanup

| #     | Issue                                                                                                                       | Estimate |
| ----- | --------------------------------------------------------------------------------------------------------------------------- | -------- |
| P1-20 | `analytics.ts:222-232, 291-293` все още reads `batches`/`batch_id`/`expiry_date` — dead code (MERT-M не проследява партиди) | 0.5d     |
| P1-21 | No LIMIT on `/sales` или `/stock-forecast` — unbounded result sets                                                          | 0.25d    |
| P1-22 | Query params `as any` cast в `analytics.ts` — proper Zod parsing                                                            | 0.5d     |
| P1-23 | `import.ts:102` sync `XLSX.read(buffer)` unbounded; цял 50MB import в single TX                                             | 1d       |
| P1-24 | `export.ts:317` CSV escape не префиксва `= + - @` клетки → CSV injection confirmed                                          | 0.5d     |

### AI-service

| #     | Issue                                                                                                                                                                         | Estimate |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| P1-25 | venv symlinked към greek-foods-platform — recreate own venv                                                                                                                   | 0.25d    |
| P1-26 | `main.py` и `celery_app.py` self-identify as "Greek Foods AI Service" / `greek_foods_ai` — shares Redis queue ако двата проекта работят заедно                                | 0.25d    |
| P1-27 | 9 undocumented env vars в `ai-service` (`.env.example` непълен): `DATABASE_URL`, `OPENROUTER_*`, `OPENAI_VISION_MODEL`, `GOOGLE_API_KEY`, `SCAN_*`, `MATCH_CACHE_TTL_SECONDS` | 0.25d    |

### Dependencies (HIGH CVE)

| #     | Issue                                                                                                 | Estimate |
| ----- | ----------------------------------------------------------------------------------------------------- | -------- |
| P1-28 | 3 HIGH в backend/frontend (`fastify`, `nodemailer`, `xlsx`) + 1 CRITICAL в telegram-bot (`form-data`) | 0.5d     |

**P1 TOTAL: ~22 work-days** (~4-5 weeks if parallel; ~4.5 weeks sequential)

---

## P2 — Nice-to-have hardening

| #     | Issue                                                                                                   | Estimate                            |
| ----- | ------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| P2-1  | Author `docs/SECRET-ROTATION-GUIDE.md` (referenced by `.gitleaks.toml` but doesn't exist)               | 0.5d                                |
| P2-2  | macOS Keychain за JWT_SECRET и Econt парола — launchd wrapper                                           | 0.5d                                |
| P2-3  | CI job за `gitleaks detect --no-git` на всеки PR (не само pre-commit)                                   | 0.25d                               |
| P2-4  | Enforce `BACKUP_GPG_RECIPIENT` като задължителен в `nightly-pg-dump.sh`                                 | 0.1d                                |
| P2-5  | Wire `e2e-tests/` в CI workflow (`.github/workflows/ci.yml`)                                            | 0.5d                                |
| P2-6  | Update `e2e-tests/README.md` path от `greek-foods-platform` към `mert-m`                                | 0.1d                                |
| P2-7  | Decision + cleanup: **delete `mobile-owner-app/`** (dublicate на Owner PWA)                             | 0.25d                               |
| P2-8  | Decision + cleanup: **delete or rebuild `b2b-website/`** (77 "Greek Foods" refs, static demo)           | 0.25d (delete) или 10-15d (rebuild) |
| P2-9  | Load testing срещу staging DB със seed на 10k orders + 500MB data (k6 или vegeta)                       | 2d                                  |
| P2-10 | Fastify `fastify-rate-limit` plugin на public endpoints                                                 | 0.5d                                |
| P2-11 | `fastify-helmet` за security headers                                                                    | 0.1d                                |
| P2-12 | Typed API client на frontend (openapi-fetch / hey-api) вместо raw axios — подсигурява FE↔BE schema sync | 1d                                  |
| P2-13 | Switch `fiscal.ts` error-reply pattern към consistent 503 Service Unavailable (сега 500)                | 0.25d                               |
| P2-14 | OpenAPI / Swagger docs за backend (Fastify има plugin)                                                  | 1d                                  |
| P2-15 | Replace `const label: any = {...}` в econt.ts с typed `EcontSender`                                     | 0.5d                                |

**P2 TOTAL: ~8 work-days** (без rebuild на b2b-website)

---

## Timeline — Scope D (1+ month full cleanup)

### Week 1 (P0 part 1): Secrets + Deploy infra

- Day 1-2: Secrets rotation (P0-1 to P0-8)
- Day 3-4: Docker Compose prod + nginx + TLS (P0-17 to P0-19)
- Day 5: Mac Mini launchd + DEPLOY.md (P0-20, P0-21, P0-22, P0-23, P0-24)

### Week 2 (P0 part 2): Correctness + Mobile

- Day 6-7: Razpiska race condition + failing tests (P0-9, P0-11, P0-12, P0-13)
- Day 8: AI-service match fix (P0-10)
- Day 9: Mobile app rebranding (P0-14, P0-15, P0-16)
- Day 10: Telegram bot hardening (P0-25 to P0-29)

### Week 3 (P1 part 1): Observability + god-routes

- Day 11-12: Sentry + metrics + log rotation + pg_stat_statements (P1-1 to P1-8)
- Day 13-15: Refactor incoming.ts / orders.ts / invoices.ts (P1-9, P1-10)

### Week 4 (P1 part 2): Integrations

- Day 16-18: Econt hardening + placeholder fixes (P1-11 to P1-15)
- Day 19-20: Fiscal unit tests + retry queue (P1-16 to P1-18)
- Day 21: Data layer cleanup (P1-20 to P1-24)
- Day 22: AI-service fixes (P1-25 to P1-27)
- Day 23: Dependency updates (P1-28)

### Week 5 (P2 + Physical testing)

- Day 24: P2 hardening selectieve (rotation guide, gitleaks CI, rate limits, helmet)
- Day 25-26: On-site DAISY принтер testing (P1-19) — това е календарен gap
- Day 27-28: Load testing (P2-9)

### Week 6 (Pilot + rollout)

- Day 29-30: Closed пилот с малка част от реалните поръчки
- Day 31-35: Monitoring, bugfixing, tuning

**Realistic calendar: 6-7 weeks full-time от един dev.**

Ако има **двама** dev-та paralelно: ~**4-5 weeks**.
Ако има само **частична заангажираност** (2-3h/day): ~**3-4 месеца**.

---

## Приоритизиран fix order (препоръчителен execution plan)

1. **First (bloker-и + бъзови fix-ове):**
   - Ротация на Econt парола + chmod 600 (P0-2) — **днес/утре**
   - Replace secrets (P0-1, P0-3, P0-7) — 1 ден
   - Fix race condition (P0-9) + failing tests (P0-10, P0-11) — 1-2 дни
   - Mobile rebrand (P0-14 to P0-16) — 1 ден
   - Telegram bot config (P0-25 to P0-29) — 0.5 ден

2. **Second (deployment инфра):**
   - docker-compose.prod + nginx + TLS + launchd (P0-17 до P0-24) — 4-5 дни

3. **Third (security finalize):**
   - Settings leak (P0-4), role guards (P0-12), reset-stock (P0-13), admin pass (P0-8), Econt HTTPS (P0-6), JWT assertion (P0-5) — 1-2 дни

4. **Fourth (high-value observability):**
   - Sentry + pg_stat_statements + log rotation + frontend ErrorBoundary (P1-1, P1-2, P1-4, P1-7) — 2-3 дни

5. **Fifth (integrations hardening):**
   - Fiscal unit tests + retry queue + физически тест (P1-16 до P1-19) — 5-7 дни
   - Econt fixes (P1-11 до P1-15) — 1.5 дни

6. **Sixth (quality полиране):**
   - God-routes refactor (P1-9) — 4-5 дни
   - Data layer cleanup + dependency updates (P1-20 до P1-28) — 2-3 дни

7. **Seventh (P2 + load test + пилот):**
   - Selective P2 hardening + load testing — 3-4 дни
   - Pilot + monitoring — 5-10 календарни дни

---

## Architectural verdict (от architect agent)

**"Mostly fine with risks"** — архитектурата е работоспособна за малък търговски склад (1-3 работни места), но има конкретни проблеми:

- **God-routes:** 3 route файла = 50% от целия route code
- **FK inconsistency:** няколко колони с ON DELETE CASCADE vs RESTRICT объркани
- **Zombie `batches` table:** MERT-M не проследява партиди, но таблицата + FK-ите са там, а analytics.ts все още ги чете
- **No caching:** Econt cities, product searches — всеки request hits DB/upstream
- **Thin external-call resilience:** Econt / OCR / SMTP — no retries, no circuit breaker
- **In-memory TTL caches:** Не horizontal-scale friendly (ако се replicate на 2 node-а)
- **Single tenant:** Multi-user но single-tenant — OK за MERT-M (self-hosted едно копие)

**Подходящо за:** Self-hosted малък офис склад със до 3 concurrent users и до 10k orders/година (сегашният target).

**НЕ е подходящо за:** Multi-tenant SaaS, high-load (100+ concurrent users), horizontal scaling.

---

## Какво е направено добре (positives)

- **52 миграции, additive-only** — DB schema evolution е чиста
- **pg_trgm индекси** на всички важни search поли (products.name_bg, sku, partners.name) — fuzzy search-ът е оптимизиран
- **Zod валидация** на input boundaries
- **React Query** за data fetching (няма useEffect)
- **pre-commit hook + gitleaks config** — secret scanning
- **Parameterized SQL queries** — no injection
- **196/198 backend tests passing** (98.99%)
- **28/28 Econt tests passing**
- **CI workflow съществува** с 8 jobs (backend, frontend, ai-service, mobile, audits, gitleaks, trivy)
- **Nightly pg_dump backup script** със GPG encryption option + S3 upload + retention
- **JWT auth работи**, 3 роли дефинирани
- **Fastify 5 + TypeScript + pino logger** stack е modern
- **Frontend ErrorBoundary съществува** (макар и без reporting)
- **Razpiska payments имплементация** (включително gross VAT fix)

---

## Decisions needed from user

1. **`mobile-owner-app/` — delete?** Owner PWA вече е в warehouse-frontend. Dublicate.
2. **`b2b-website/` — delete или rebuild?** 77 Greek Foods refs, static demo, no backend integration. Ако MERT-M иска B2B portal → rebuild fresh with MERT-M branding.
3. **`mobile-app/` — launch scope?** Ако ще се публикува в App Store/Play — rebrand takes 1-2 дни. Ако internal only (TestFlight/Expo) — може да се пусне по-късно.
4. **Fiscal принтер — ще се използва ли?** Ако да: трябват физически тестове + retry queue (P1-16, P1-17, P1-19 = 5-7 дни). Ако не: skip fiscal routes изцяло.
5. **Ще има ли staging environment?** Препоръчително за load testing (P2-9) и pilot (Week 6). Mac Mini M4 може да бъде staging + prod същевременно ако има два PostgreSQL instance-а (различни портове).
6. **Ще има ли external access?** Tailscale VPN? Cloudflare Tunnel? Port-forward + TLS? Това влияе на nginx config и firewall.
7. **Backup destination?** S3 + GPG вече е готов в код-а. Ако няма S3 → external drive + rotation?

---

## Тревожен признак — "untouched since initial clone"

**Auxiliary services audit показа:** `b2b-website/`, `mobile-app/`, `mobile-owner-app/`, `microinvest-export/`, `e2e-tests/`, `test-invoices/` — **всичките** са untouched от commit `02ce200 chore: clone Greek Foods platform as MERT-M baseline`. Значи работа върху warehouse-backend + warehouse-frontend + ai-service + telegram-bot е концентрирана, но auxiliary-те се pull-ваха копия които няма никога да работят без rebrand.

**Препоръка:** decision-tree:

- Keep + rebrand → mobile-app, e2e-tests, test-invoices, scripts/, microinvest-export/
- Delete → mobile-owner-app, b2b-website (след user confirmation)
- Leave as-is → microinvest-export (sample data), test-invoices (fixtures), scripts/ (production-ready)

---

## Final recommendation

**НЕ go-live на Mac Mini преди поне P0 blockers да са fix-нати** (~2 седмици).

**Приоритетен execution path (за ~4-6 weeks full-time):**

1. Week 1-2: P0 (secrets, correctness, mobile, telegram bot, deploy infra)
2. Week 3-4: P1 high-value (Sentry, fiscal, Econt, god-routes refactor)
3. Week 5: P2 selective + физически DAISY testing
4. Week 6: Pilot + monitoring + tuning

**Минимален safe launch (само P0):** ~2 седмици + ръчен watch в pilot mode (НЕ се препоръчва за реален търговски склад, но е възможно).

**Confident production launch:** 6-8 седмици с буфер.

---

## Appendix — файлове с детайлна информация

- `/Users/magic/Projects/mert-m/QA-NIGHT-REPORT-2026-04-22.md` — Round 1 детайли (29 findings)
- Round 2/3 agent outputs: `/private/tmp/claude-501/-Users-magic/88e7e6b2-23eb-45ac-a45f-b3ebd1f122cf/tasks/`
  - `a78e9e452373e18b9.output` — Performance + observability
  - `ad18f4c89ff6a3ceb.output` — Env + secrets
  - `aba66cb71cf645d98.output` — Fiscal + Econt
  - `a1c7b80f1a62900a9.output` — Auxiliary services

---

## Важно за сутринта

**Admin парола:** `AdminTest123` (reset-нах я по време на QA — трябва пак да я reset-неш към силна production парола преди deploy).

**Backend .env Econt парола:** `wkpYyWBM#WenMB7` — **РОТИРАЙ ЛОГИНА В ЕКОНТ ПОРТАЛА НЕЗАБАВНО**, пропагирай новата в `.env` (с `chmod 600`) и commit-ни `.env.example`.

**Нищо не е deploy-нато в production** по време на overnight QA — всичко е локални smoke tests + static analysis. Безопасно е да спиш.

**Следващ стъп когато се събудиш:** reviewrай този доклад + QA-NIGHT-REPORT и реши кои P0 items ще атакуваме първо. Препоръчвам да започнем с Secrets Rotation (P0-1, P0-2) като най-спешно — Econt паролата виси в `-rw-r--r--` файл.

Лека нощ! 🌙
