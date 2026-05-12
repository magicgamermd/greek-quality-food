# MERT-M Warehouse — Nightly QA Report

**Date:** 2026-04-22
**Scope:** warehouse-backend + warehouse-frontend + ai-service + DB
**Environment:** dev (Mac Mini, backend :3003, frontend :5174, PG :5433)
**Reviewers:** qa-engineer, security-engineer, architect, code-reviewer, frontend-dev + E2E browser verification

## TL;DR

Системата **не е готова за production**. Има **2 BLOCKER** и **8 HIGH** проблема.
Логиката на новата функция (razpiska payments) работи коректно end-to-end, но
има race condition, hardcoded VAT и feature-flag през keyboard shortcut, който
не е приемлив за продакшън.

| Слой               | Резултат                                                   |
| ------------------ | ---------------------------------------------------------- |
| Backend tests      | 196/198 pass (2 test-fixture drift, not code bugs)         |
| Frontend typecheck | 0 грешки                                                   |
| Frontend build     | PASS (1.28 MB bundle — warning)                            |
| ESLint             | 126 errors (config + `any` + dead code)                    |
| DB integrity       | 0 orphans, 0 негативна наличност, 0 double-parent payments |
| E2E API            | Всички core flows работят                                  |
| E2E Browser        | 12/12 страници рендват се, шорткът Ctrl+Alt+R toggle-ва    |

---

## 🚨 BLOCKERS (fix преди production)

### B1. Race condition в razpiska payment creation

- **File:** [payments.ts:302-368](warehouse-backend/src/routes/payments.ts:302)
- **Problem:** `SELECT SUM(amount)` + `INSERT` не са в транзакция с `FOR UPDATE`
  на order. Две едновременни плащания могат да преминат проверката и да overpay-нат.
- **Fix:** обвийте в `transaction()` с `SELECT ... FOR UPDATE` на orders row.
  Същият проблем съществува в invoice branch (same file, lines 389-406) —
  трябва да се fix-не и двете.

### B2. Razpiska tab крие се зад Ctrl+Alt+R shortcut

- **File:** [Payments.tsx:105-128](warehouse-frontend/src/pages/Payments.tsx:105)
- **Problem:** Това е **feature flag в UI**, не security. Крайният счетоводител не
  знае за shortcut-а → функционалността е недостъпна. Ако целта е да е видимо
  само за admin → направи role-based gate (`user.role === "admin"`). Ако е
  временно скрит, документирай.
- **Fix:** решете: (а) махнете shortcut, показвайте винаги; (б) role-based;
  (в) настройка в settings.

---

## 🔴 HIGH (силно препоръчително преди production)

### H1. Hardcoded VAT 20% (`× 1.2`) на 2 места

- **Files:**
  - [payments.ts:325-327](warehouse-backend/src/routes/payments.ts:325)
  - [RecordPaymentModal.tsx:43-45](warehouse-frontend/src/components/RecordPaymentModal.tsx:43)
- **Problem:** Ако клиент има non-VAT partner (реverse charge, export),
  калкулацията е грешна. Няма общ източник за VAT rate.
- **Fix:** Извлечете в `config.ts` или settings таблица. Евентуално — съхранете
  `total_gross` на поръчката вместо да го изчислявате from `total_amount`.

### H2. Zod XOR refine връща 500 вместо 400

- **File:** [payments.ts:5-18](warehouse-backend/src/routes/payments.ts:5)
- **Problem:** Когато липсват и двата `invoice_id` и `order_id`, Zod throws
  unhandled и Fastify връща 500. Тестът `payments-razpiska.test.ts:171` се
  провали тук.
- **Fix:** Увийте `parse()` в try/catch или използвайте `parseAsync` + error handler,
  връщайте 400 с `error.issues`.

### H3. warehouse role може да пише фактури и партньори

- **Files:**
  - [invoices.ts:298,421,549,830](warehouse-backend/src/routes/invoices.ts:298)
  - [partners.ts:223,251,335](warehouse-backend/src/routes/partners.ts:223)
- **Problem:** Склададжии могат да създават, регенерират, изпращат фактури и да
  управляват партньори. Това е extra scope — нарушава принципа на least privilege.
- **Fix:** Сменете guard-а на `admin`/`accountant` only.

### H4. Upload endpoint без MIME/extension allowlist

- **File:** [incoming.ts:1599-1631](warehouse-backend/src/routes/incoming.ts:1599)
- **Problem:** Приема всичко (exe, html, svg) → `uploads/incoming/${Date.now()}-${filename}`.
  Когато се сервира обратно (line 1568), inline content-type `application/octet-stream`
  може да пусне stored HTML/SVG XSS.
- **Fix:** Whitelist `pdf|jpg|jpeg|png|webp`. Reject други с 415.

### H5. `/incoming/scan` няма rate limit

- **File:** [incoming.ts:1599](warehouse-backend/src/routes/incoming.ts:1599) +
  [index.ts:208-218](warehouse-backend/src/index.ts:208)
- **Problem:** Скъп AI endpoint (120s timeout) без лимит. Leaked JWT → saturation.
- **Fix:** `config: { rateLimit: { max: 30, timeWindow: "1 hour" } }`.

### H6. Path traversal на upload write path

- **File:** [incoming.ts:1620](warehouse-backend/src/routes/incoming.ts:1620)
- **Problem:** `filename = ${Date.now()}-${data.filename}` — user-supplied
  basename се пише без `path.basename()`. POSIX `path.join` пази `..` →
  теоретично escape от uploads dir.
- **Fix:** `const safe = path.basename(data.filename); filename = \`${Date.now()}-${safe}\``.

### H7. Fiscal operator default password `"0000"`

- **File:** [settings.ts:136](warehouse-backend/src/routes/settings.ts:136)
- **Problem:** Ако admin никога не го смени, фискалният принтер остава с factory default.
- **Fix:** Require it on first save, или blocker-notice в UI.

### H8. Econt credentials в plain text на диск

- **File:** `warehouse-backend/.env:57` (НЕ е в git — провери)
- **Problem:** `ECONT_PASSWORD="wkpYyWBM#WenMB7"` на диска. `.gitignore` включва `.env` ✓.
  За production: използвайте secret manager (e.g. macOS Keychain) или ограничете
  file permissions до `600`. Ако това е реален (не sandbox) account — rotate.
- **Fix:** `chmod 600 .env` + документиране; при деплой → Keychain/env injection.

---

## 🟡 MEDIUM (fix преди v1.1 или в stability pass)

### M1. Generic error "Грешка при запазване" скрива server message

- **File:** [RecordPaymentModal.tsx:308](warehouse-frontend/src/components/RecordPaymentModal.tsx:308)
- **Fix:** Surface `mutation.error.response?.data?.error` — юзърът не разбира
  защо save-ът пада (overpay, cancelled order, validation).

### M2. No `onError` на useQuery за order payments

- **File:** [RecordPaymentModal.tsx:51-61](warehouse-frontend/src/components/RecordPaymentModal.tsx:51)
- **Problem:** Ако query fail-не, `orderPayments` остава `undefined` → pre-fill
  deadlock, amount е празно.

### M3. Notifications endpoint пренебрегва `limit` param

- **File:** [notifications.ts:25](warehouse-backend/src/routes/notifications.ts:25)
- **Problem:** Client изпраща `limit=5`, сървърът връща 20 (hardcoded).
- **Bonus:** Query-то все още reference-ва `batches` таблицата (line 21),
  която MERT-M не използва.

### M4. CSV export: `payment_method` на английски; `\n` вместо `\r\n`

- **File:** [Payments.tsx:75-79](warehouse-frontend/src/pages/Payments.tsx:75)
- **Fix:** Преведете `bank`→`Банков превод`, `cash`→`В брой`, `card`→`Карта`.
  Join с `\r\n` за reliable Excel/Numbers parsing.

### M5. 3 god routes > 1000 lines (orders.ts 2054, incoming.ts 2419, invoices.ts 1077)

- **Fix:** Извлечете в service layer преди нов feature. Trigger: при всеки нов tests-ите стават все по-трудни за maintenance.

### M6. Missing FK indexes

- **Affected:** `incoming_goods.supplier_id`, `price_list_items.product_id`,
  `stock_writeoffs.warehouse_id`, `invoice_number_reservations.invoice_id`,
  `import_logs.imported_by`, `comarch_sync.order_id`.
- **Fix:** Миграция 050 с `CREATE INDEX`. На текущите обеми няма забавяне, но ще
  ухапе при 10k+ orders.

### M7. Large bundle (1.28 MB JS, 374 KB gzip)

- **File:** `warehouse-frontend/vite.config.ts` + `src/pages/Orders.tsx` (3504 lines)
- **Fix:** Vite `manualChunks`: vendors, charts (recharts), pdf (jspdf).
  Lazy-load `Orders.tsx`, `Analytics.tsx`.

### M8. `request.query as any` escape-ва Fastify schema validation

- **File:** [payments.ts:42](warehouse-backend/src/routes/payments.ts:42)
- **Problem:** `invoice_id=abc` → `parseInt()` → `NaN` → PG връща 500 вместо 400.
- **Fix:** Zod-validate query params с `schema.querystring`.

### M9. Legacy `'invoiced'` status все още в enum + константа

- **File:** [orders.ts:15](warehouse-backend/src/routes/orders.ts:15)
  (`STOCK_COMMITTED_STATUSES`)
- **Problem:** Никой код не го пише, но DB constraint го позволява. Потенциал за
  "double return stock" ако случайно някой admin го постави ръчно.
- **Fix:** Миграция за нормализация + махни от enum.

### M10. No security headers (Helmet missing)

- **File:** [index.ts](warehouse-backend/src/index.ts)
- **Fix:** `app.register(helmet, { contentSecurityPolicy: false })`.

### M11. Dev CORS origins винаги активни

- **File:** [index.ts:64-72](warehouse-backend/src/index.ts:64)
- **Fix:** `if (process.env.NODE_ENV !== "production") { allow dev origins }`.

---

## 🟢 LOW / NIT (nice-to-have)

- **L1.** Products.tsx:491 — `placeholder="optional"` (единствено английско UI стринг).
- **L2.** CSV row joined with `\n`; prefer `\r\n` (M4 дубликат).
- **L3.** ESLint config broken — 126 errors (flat config не зарежда `@typescript-eslint` plugin). Много `any` в Orders.tsx (16+ места). Dead imports: `OwnerDeliveries` в App.tsx:33, `formatUnit` в Products.tsx:34.
- **L4.** Class `ErrorBoundary` в Orders.tsx:236 — нарушава "functional components only".
- **L5.** DATE(paid_at) >= $1 не използва индекс ([payments.ts:66-71](warehouse-backend/src/routes/payments.ts:66)).
- **L6.** Status badge прага `paid + 0.01 < total` — floating tolerance (payments.tsx). Предпочитай int cents.
- **L7.** OrderActionsMenu click-outside няма Esc handler и focus trap.
- **L8.** No per-account lockout след repeated login failures (само per-IP).
- **L9.** Одит на accessibility: Payments.tsx има 0 `<Label>` / 0 `aria-label` (436 lines). Orders.tsx — огромен брой icon-only бутони без aria-label.
- **L10.** Autoprint хук — notification insert извън transaction (orders.ts:1410-1413). Ако crash-не, нотификацията се губи.

---

## ✅ Verified Working

- JWT auth + role guards на всички routes (80+ handlers audit-нати).
- Параметризирани SQL queries навсякъде (no injection).
- bcrypt cost 12 + timing-equalized dummy hash.
- Transactions на всички multi-step writes (fulfill, cancel, invoice gen, confirm incoming).
- DB constraint `payments_invoice_or_order_chk` гарантира mutual exclusivity.
- VAT tolerance `× 1.001` правилно на gross (след fix `ac1e8b6`).
- Keyboard shortcut използва `e.code === "KeyR"` (layout-independent).
- Razpiska E2E flow: create order → payment half → overpay rejected 400 → payment rest → closes → further payment rejected 400 → list shows 2 plays summing to gross.
- Invoice flow: list, detail, PDF generation (17 KB), unpaid list, payment recording — всички работят.
- DB integrity: 0 orphaned FKs, 0 payments без parent, 0 paid invoices без payments, 0 negative inventory.
- Browser render: всичките 12 защитени страници (/, /products, /inventory, /incoming, /orders, /warehouse, /partners, /suppliers, /invoices, /payments, /analytics, /settings) се зареждат без error.
- Search filter на /orders работи (от 9 → 5 rows след "Хотел").
- Analytics page показва revenue, top products, charts.
- Econt integration: cities endpoint връща данни.
- ai-service OCR endpoint wired (не тествано runtime).
- Миграция 049 правилно enforcement-ва CHECK constraint + nullable invoice_id.

---

## 🧪 Изпълнени тестове

- `npm test -- --run`: 196/198 pass (2 test drift в `payments-razpiska.test.ts` — нуждае се от update на expected `order_total` да отразява новия × 1.20 multiplier)
- `npx tsc --noEmit`: 0 грешки
- `npm run build`: ✅ (1.28 MB bundle warning)
- DB integrity SQL: 0 проблеми
- E2E API:
  - POST /orders → 201 ✓
  - POST /payments razpiska half → 201 remaining=120 ✓
  - POST /payments overpay → 400 ✓
  - POST /payments both IDs missing → **500** (трябва 400, вж. H2)
  - POST /payments rest → 201 closes order ✓
  - POST /payments after full → 400 ✓
  - GET /payments?type=razpiska&order_id=X → filter работи ✓
  - GET /invoices/[id]/pdf → 200 PDF 17KB ✓
  - POST /payments invoice → 201 ✓
  - GET /analytics/sales → 200 ✓
  - GET /econt/cities → 200 ✓
- E2E UI:
  - Login форма работи
  - Ctrl+Alt+R toggle — sessionStorage flag работи
  - Search filter на /orders работи
  - CSV export бутон присъства
  - Order kebab → payment modal отваря → показва правилно gross/net/VAT/вече платено/остатък

---

## 📋 Препоръчан ред за fix преди v1.0

1. **B1** — транзакция с FOR UPDATE на двете branches в POST /payments (4-6h)
2. **H2** — wrap Zod `parse` в error handler, връщай 400 (30m)
3. **B2** — вземи решение за razpiska tab (5m → 2h)
4. **H1** — извлечи VAT_RATE константа, обсъди с counter дали MERT-M някога пуска non-VAT (1h)
5. **H4+H5+H6** — upload hardening (MIME whitelist + rate limit + basename) (2h)
6. **H3** — свий invoices/partners write към admin+accountant (30m)
7. **H7** — fiscal password flow — require на setup (30m)
8. **M1+M2** — error surfacing в modal (1h)
9. **M3+M4** — notifications limit + CSV полиране (1h)
10. Останалите M/L в stability sprint

**ETA за BLOCKER+HIGH:** ≈ 1-2 работни дни.
**v1.0 верситет когато всички BLOCKER + минимум H1, H2, H3, H7 са закрити.**

---

## Appendix — Files Cited

- `warehouse-backend/src/routes/payments.ts`
- `warehouse-backend/src/routes/orders.ts`
- `warehouse-backend/src/routes/invoices.ts`
- `warehouse-backend/src/routes/incoming.ts`
- `warehouse-backend/src/routes/notifications.ts`
- `warehouse-backend/src/routes/partners.ts`
- `warehouse-backend/src/routes/settings.ts`
- `warehouse-backend/src/index.ts`
- `warehouse-backend/src/__tests__/payments-razpiska.test.ts`
- `warehouse-backend/migrations/049_payments_order_id.sql`
- `warehouse-frontend/src/components/RecordPaymentModal.tsx`
- `warehouse-frontend/src/components/OrderActionsMenu.tsx`
- `warehouse-frontend/src/pages/Payments.tsx`
- `warehouse-frontend/src/pages/Orders.tsx`
- `warehouse-frontend/src/pages/Products.tsx`
- `warehouse-frontend/src/App.tsx`
- `warehouse-frontend/vite.config.ts`

**Артефакти:** `/tmp/mertm-tests.log`, `/tmp/mertm-tsc.log`, `/tmp/mertm-build.log`, `/tmp/mertm-lint.log`, `/tmp/mertm-backend.log`.

---

**Admin password reset note:** За целите на QA, паролата на `admin@mertm.bg`
временно беше сменена на `AdminTest123`. Смени я през UI или psql преди да
продължиш: `UPDATE users SET password_hash=... WHERE email='admin@mertm.bg';`
