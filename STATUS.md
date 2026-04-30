# MERT-M — Current Status

> **Single source of truth** for "where are we now". Read this first
> at the start of every session. Update after each significant step.
> Other `.md` files in the root are either historical (`docs/archive/`)
> or scoped (e.g. `PRODUCTION-READINESS-REPORT-2026-04-22.md`).

**Last updated:** 2026-04-30 (Daily Report merged + live-validated)
**Active branch:** `main`
**Production readiness score:** 4/10 (per `PRODUCTION-READINESS-REPORT-2026-04-22.md`)
**Active feature:** Daily Report (Дневен отчет) — **MERGED + LIVE-VALIDATED**. `GET /reports/daily-pdf?date=YYYY-MM-DD` returns 200 + valid PDF against real Postgres for today/yesterday/older dates; bad date format returns 400. Two schema mismatches that mocked tests missed (`credit_note_id` and `payment_date`) were caught and hot-fixed in commit `7be88f9`.

---

## Where We Are

**Phase:** Hard separation between MERT-M and the upstream
greek-foods-platform clone is **complete**. Operational cleanup +
production-readiness blockers are next.

**Current blocker focus:** P0 items from the production-readiness report
(secrets rotation, observability gaps, fiscal printer test, etc).

---

## Local Dev Setup (verified 2026-04-28)

### Ports

| Service                | Host port | What is it                                 |
| ---------------------- | --------- | ------------------------------------------ |
| MERT-M backend         | **3004**  | Fastify dev (tsx watch) — `/health` 200    |
| MERT-M frontend        | **5174**  | Vite dev — proxies `/api → :3004`          |
| MERT-M ai-service      | **8000**  | Uvicorn — `/health` `{service:"mertm-ai"}` |
| MERT-M Postgres Docker | **5433**  | container `mertm-postgres-1`               |
| MERT-M Redis Docker    | **6380**  | container `mertm-redis-1`                  |
| Greek Foods backend    | 3003      | **Other project — do not touch**           |
| Greek Foods Postgres   | 5432      | **Other project**                          |
| Greek Foods Redis      | 6379      | **Other project**                          |

Greek Foods Docker stack is allowed to run in parallel; MERT-M dev
ports are picked specifically to avoid collision.

### Start everything

```bash
./scripts/start-mertm.sh           # idempotent boot of full dev stack
./scripts/start-mertm.sh --status  # health probe only
./scripts/start-mertm.sh --stop    # stop dev processes (Docker stays up)
```

Logs: `/tmp/mertm-{backend,frontend,ai}.log`

### Admin login (dev only)

- Email: `admin@mertm.bg`
- Password: see `e2e-tests/.env.local` (gitignored)
- **For production**: rotate before go-live.

---

## Done — Recent Sessions

**Daily Report (Дневен отчет)** (2026-04-30, branch `feature/MERTM-daily-report` from main):

- New endpoint `GET /reports/daily-pdf?date=YYYY-MM-DD` returns a 6-section A4 PDF: Поръчки (per-order list + summary by status), Фактури (active/credit-noted/cancelled + per-payment-method breakdown), Постъпления (real cash inflow by method), Еконт доставки (only if any), Неплатени (top 10 oldest unpaid AS OF end-of-day), Top 5 артикула.
- New service `services/daily-report-pdf.ts` mirroring `offer-pdf.ts`; auto-page-break for long order lists; local `fmtEur` wrapper appends " €" to all amounts.
- 7 aggregation SQL queries inside `assembleDailyReportData` — uses Batch B's `name_bg_snapshot` / `sku_snapshot` for top products.
- Permission `REPORTS_VIEW` already in registry (admin + accountant); warehouse blocked.
- Frontend Dashboard gets a "Дневен отчет" button (gated by `<Can permission={REPORTS_VIEW}>`) → date-picker dialog → authed blob fetch → opens PDF in new tab. Local-tz date helper (`toLocaleDateString("sv-SE")`) avoids UTC midnight off-by-one. In-flight guard disables button during download (`Сваляне…`); blob-error path reads `Blob.text()` → `JSON.parse` so backend error messages reach the user.
- All amounts in EUR via existing `formatEurAmount`.
- 5 integration tests (`reports-daily.test.ts`): admin happy default + explicit date, 400 invalid format, 403 warehouse, 200 future date.
- 2 unit tests (`daily-report-pdf.test.ts`): non-empty PDF for a populated day, valid PDF for an empty day. (Third test for Еконт-mixed path was added after spec review caught the missing case.)
- Bonus bug fix: `services/offer-pdf.ts` was using `fmtBGN` (" лв.") — switched to `formatEurAmount` (€) via local `fmtEur` wrapper to match daily-report and codebase EUR migration.
- BE+FE type-check clean; new tests passing (orders-quotation 7/7 still green after offer-pdf swap).
- **Merged to main 2026-04-30** (commit `2689e1a`); live smoke against real Postgres surfaced two SQL/schema mismatches the mocked tests didn't catch — hot-fixed in commit `7be88f9`:
  - `invoices.credit_note_id` doesn't exist in MERT-M (Greek Foods inheritance leak); MERT-M uses `document_type` + `related_invoice_id` pattern. Re-wrote 4 SQL queries with `LEFT JOIN invoices cn ON cn.related_invoice_id = i.id AND cn.document_type='credit_note'`.
  - `payments.payment_date` doesn't exist; column is `paid_at`.
- After hotfix: live `GET /reports/daily-pdf?date=...` returns 200 + valid PDF for today / yesterday / older dates; Zod still rejects bad-format dates with 400.
- **Follow-up filed for separate task:** mocked-DB integration tests (`vi.mock("../db.js")`) never validate column names against real schema — consider a real-DB or schema-aware fixture pattern for SQL-heavy routes.

**Batch E — Quotation (Оферта)** (2026-04-29, branch `feature/MERTM-batch-e-quotation` from main):

- Migration 059 — `'quoted'` added to `orders.status` CHECK constraint
- POST `/orders` accepts initial `status: 'quoted'` (skips oversell validation; never deducts stock)
- POST `/orders/:id/quote` (pending → quoted) + POST `/orders/:id/unquote` (quoted → pending)
- POST `/orders/:id/fulfill` rejects `400` when status is `quoted` ("convert to pending first")
- PUT `/orders/:id/status` rejects direct workflow transitions out of `quoted` (only `cancelled` allowed)
- New PDF service `services/offer-pdf.ts` — title "ОФЕРТА", number `OF-NNNNNNN`, items table with prices/discount, totals (net + VAT 20% + gross), validity-disclaimer footer
- New endpoint `GET /orders/:id/offer-pdf` — only available for `quoted` status, returns PDF stream
- 7 integration tests (`orders-quotation.test.ts`): create-with-quoted, /quote happy + reject, /unquote happy + reject, fulfill rejection, offer-pdf rejection
- Frontend `Order.status` union adds `'quoted'`
- `statusLabels.quoted = "Оферта"` + `statusVariants.quoted = "warning"` (auto-generates filter pill + amber badge)
- New `quoteMutation` + `unquoteMutation` (quote auto-opens offer PDF in new tab on success)
- Drawer workflow row gates on status:
  - `pending` → "Генерирай оферта" + "Потвърди поръчка"
  - `quoted` → "Регенерирай оферта" + "Премини към обработка" + "Откажи оферта" + days-since hint
  - other statuses → existing flow (dispatch/fulfill); both `quoted` and `pending` excluded from dispatch
- Документи row hidden for `quoted` (excluded from confirmed/processing/fulfilled/invoiced gate)
- New-order modal: "Запази като оферта" button alongside "Създай поръчка" (auto-opens PDF on success)
- BE+FE type-check clean; new tests 7/7 passing
- **Open item:** manual E2E (Task 14 in plan, 7-step script) deferred to post-merge user verification

**Batch G+H — Invoice extra fields + Acceptance protocol** (2026-04-29, branch `feature/MERTM-batch-gh-invoice-fields-protocol` from main):

- Migration 058 — `invoices.vat_exemption_reason` (TEXT) + `invoice_note` (TEXT)
- Shared `VAT_EXEMPTION_REASONS` BE+FE constant — five common BG legal-basis suggestions
- `createInvoiceSchema` accepts both new fields with empty-string-to-null transform; `regenerateInvoiceSchema` accepts them as plain optional strings
- POST /invoices INSERT writes both fields; PUT /invoices/:id/regenerate UPDATE uses COALESCE for both → preserves stored values when the body omits them
- `invoice-pdf.ts` renders `invoice_note` as a 'Забележка: <text>' line below the totals, before the payment-method block
- New `protocol-pdf.ts` service generates an A4 'Приемо-предавателен протокол' (title + place/date + items table + signature lines) — built from scratch with pdfkit (mirroring `document-pdf.ts`)
- New endpoint `GET /orders/:id/protocol-pdf` accepts `?place / ?date / ?seller_rep / ?buyer_rep` overrides; defaults from company settings + partner row
- Frontend invoice dialog gains 'Забележка' input (always) + 'Основание (без ДДС)' input with VAT-exemption datalist (only when no-VAT)
- Frontend order-detail Документи row gains a 'Приемо-предавателен' button + override dialog
- 4 new integration tests (2 invoice-fields capture-and-throw + 2 protocol-pdf smoke)
- BE TS clean except 1 pre-existing; FE TS clean
- BE tests: 295 passed, 2 pre-existing failures
- **Open item:** manual E2E (Task 13 in plan, 4-section script) deferred to post-merge user verification

**Batch D — Invoice partner override** (2026-04-29, branch `feature/MERTM-batch-d-invoice-partner-override` from main):

- `createInvoiceSchema` accepts optional `partner_override` — Zod union of `{partner_id}` (existing partner) OR full new-partner data
- Backend helper `resolveOverridePartner` — upserts by EIK (reuse existing or INSERT new with `partner_type='company'`), runs inside the same transaction as the invoice INSERT
- POST /invoices: when override is set, invoice's `partner_id` becomes the resolved override id; order's `partner_id` is left unchanged; `client_display_name` forced to NULL (mutually exclusive); 400 if order partner is not individual
- PDF re-fetches the invoice partner so the company name (not the original individual) is printed on the PDF
- regenerate explicitly rejects `partner_override` (`z.never()` field with custom error message)
- Frontend `Orders.tsx` — `PartnerOverride` type + state + sub-dialog with mode toggle (Съществуваща combobox / + Нов партньор inline form, 7 fields), gated on `partner_partner_type === 'individual'`; chip preview ("Фактура на: <name> (ЕИК ...)") with × to clear; `invoiceMutation` sends `partner_override` when set
- 6 new integration tests (direct partner_id, EIK reuse, EIK upsert, 400 on non-individual, client_display_name nulled, regenerate rejection); all 6 pass
- BE test baseline: 296 passed, 3 pre-existing/WIP failures (2 razpiska, 1 econt from concurrent agent's WIP — none caused by Batch D)
- BE+FE TS clean
- **Open item:** full 9-step manual E2E (Task 10 in plan — invoice generation + PDF verification + EIK reuse round-trip) deferred to post-merge user verification; smoke check via preview confirmed button visibility, sub-dialog open/close, and mode toggle work cleanly

**Batch C — Orders search by article** (2026-04-29, branch `feature/MERTM-batch-c-search-by-article` from main):

- Backend `GET /orders?article=…` — EXISTS subquery on `order_items` using `oi.name_bg_snapshot` / `oi.name_en_snapshot` / `oi.sku_snapshot` (Batch B's snapshots → renames don't retroactively hide matches)
- `matched_items` enrichment — when `?article=` is set, response carries `data[].matched_items: [{ name_bg, sku }]` (single batched query for the whole page, LIMIT 1000)
- Order TS interface gets `matched_items?: Array<{ name_bg, sku }>`
- Frontend "Артикул" inline filter (300ms debounce via `useDebouncedValue`)
- Conditional "Намерен артикул" table column with `HighlightMatch` (only renders when `filters.article.trim()` is non-empty); shows up to 3 matches + "+N още"
- Combines naturally with existing `?status=`, `?date_from/to=`, `?below_cost_only=` filters
- 4 new integration tests (whitespace skip, EXISTS-with-snapshot, no-matched-items absence, AND-with-date-range)
- BE+FE TS clean (only 2 pre-existing); plan's "Follow-up after Batch B merges" consolidated into Task 1 (snapshot used directly, no second commit needed)
- **Open item:** manual E2E (Task 8 in plan, 8-step script) deferred to post-merge user verification

**Batch B — Product name snapshot in order_items** (2026-04-29, branch `feature/MERTM-batch-b-snapshot` from main):

- Migration 057 — `order_items.name_bg_snapshot` (NOT NULL), `name_en_snapshot`, `sku_snapshot`; backfill from current products (55 rows). All future rows snapshot at INSERT time.
- INSERT paths in `routes/orders.ts` (3 sites: main POST, from-comarch import, PUT edit) populate snapshot from current products
- Read paths swap `JOIN products` for `oi.*_snapshot` columns: 2 sites in `routes/orders.ts` (drawer detail, edit-fetch + dispatch/commercial PDF data fetcher) + 5 sites in `routes/invoices.ts` (invoice create, regenerate, copies=2 PDF, credit-note PDF, credit-note create). Inner JOIN downgraded to LEFT JOIN throughout — deleted product no longer collapses the row.
- UPDATE paths verified by tests not to touch snapshot columns
- Frontend untouched (response shape preserved — `items[].name_bg/name_en/sku` still come back)
- 4 new integration tests (3 write-path + 1 read-path)
- BE tests: 276 passed, 2 pre-existing failures unrelated; BE TS clean except 2 pre-existing
- **Open item:** manual rename-and-reopen E2E (Task 10 in plan, 7-step script) deferred to post-merge user verification

**Batch A — Permission features** (2026-04-29, 16 commits on `feature/MERTM-batch-a-permissions`, branched off `feature/MERTM-tester-attachments-buttons`):

- Migration 056 — `orders.below_cost_approved_by/at/details` audit columns + partial index
- New permissions `BELOW_COST_OVERRIDE`, `ORDERS_EDIT_AFTER_FULFILL` (admin-only by default; per-user override-able)
- Backend hard-block on POST/PUT /orders for below-cost lines without admin override (400/403 with `below_cost_items` payload)
- Backend admin-only edit guard on `fulfilled`/`invoiced` orders (PUT /orders/:id returns 403 for non-admin)
- `?below_cost_only=true` filter on GET /orders + approver JOIN on GET /orders/:id
- Frontend confirm dialog (admin) + hard inline error (non-admin) in both new-order modal and edit-items modal
- Audit banner in drawer + ⚠ chip in orders list + below-cost reports filter pill (admin-only visibility)
- 16 new tests (6 helper unit + 4 POST integration + 4 PUT/edit-fulfill + 2 GET filter); permissions registry test updated 16→18
- BE+FE type-check clean (only pre-existing `index.ts` agent.ts ref + `negative-inventory.test.ts` + payments-razpiska — all unrelated)
- **Open item:** manual E2E walkthrough (Task 16 — 9-step script in plan) deferred to post-merge user verification

**Phase 1–3 separation** (2026-04-28, 8 commits on this branch):

- `64673bb` Phase 1 — defaults: reconciliation/lib.ts, start-frontend.sh,
  ai-service config defaults, env templates, e2e-tests ports `:3003 → :3004`
- `75ff74d` Phase 2a — ai-service rebrand (FastAPI title, Celery, /health)
- `5642e5a` Phase 2b — mobile-owner-app rebrand (bundle ID, slug, storage)
- `4943b4a` Phase 2c — frontend PWA manifest rebrand
- `235dcab` Phase 2d — invoices.ts SMTP/subject, CORS regex security fix,
  scripts, agent specs, tests
- `71f7d97` Phase 3 Q2 — deleted `b2b-website/` (-5431 lines)
- `d29a928` Phase 3 Q5 — DEPRECATED markers on Comarch + batch/expiry scripts
- `5de6d98` Phase 3 Q4 — admin password rotated + 13 e2e files updated

**Phase 4 — operational cleanup** (2026-04-28, 5 commits):

- `a6fa4d8` STATUS.md as single source of truth + archived 8 stale
  reports to `docs/archive/`; CLAUDE.md "READ FIRST" rule
- `9063457` `scripts/start-mertm.sh` — single-command idempotent boot
  (`start | --status | --stop`)
- `e2e99e8` ai-service `.venv311` recreated fresh (no longer copy of
  greek-foods-platform venv); pyproject build-backend bug fixed
  (`setuptools.backends.legacy:build` → `setuptools.build_meta`)
- `9d77f84` `.claude/agents/mobile-dev.md` rewritten for mobile-owner-app
  scope (3 screens) instead of the deleted general-purpose mobile-app
- `aa59d6a` `docker-compose.backup.yml` header fixed + nightly-pg-dump
  defaults rebranded (DB name, dump filename pattern)

**Permission system feature — shipped** (2026-04-28 → 2026-04-29):

- `a3b7d24` Task 1 — DB migration 053 (sales role + user_permission_overrides table)
- `43e2f3a` Task 2 — Redis singleton at `lib/redis.ts` (uses `ioredis`)
- `de9e1f6` Task 3 — Permission registry constants (16 perms, 4 roles, ROLE_DEFAULTS, PERMISSION_REGISTRY)
- `85c77d0` Task 4 — getUserPermissions + hasPermission + invalidateUserPermissions + 9 tests
- `40964ab` Task 5 — requirePermission middleware + stripFieldsForUser + 5 tests
- `b62b055` Task 6 — users.ts + settings.ts refactor (2 sites → USERS_MANAGE / SETTINGS_MANAGE)
- `cb1c9f9` Task 7 — invoices.ts refactor (10 sites; **accountants now can create invoices**, fixed inverted bug)
- `e429e3b` Task 8 — orders.ts + incoming.ts refactor (15 sites; GET /incoming now gated by INCOMING_MANAGE)
- `3060efa` STATUS checkpoint
- `e951736` Task 9 — products + payments + partners + export + import + fiscal + auth (14 sites — Phase 2 complete; auth.ts:82 register endpoint preserves first-user bootstrap)

**Phase 3 — purchase_price stripping (2026-04-29):**

- `e512aed` Task 10 — strip purchase_price server-side for sales role on inventory/products/incoming list responses

**Phase 4 — /me + permissions management API (2026-04-29):**

- `2100472` Task 11 — /me returns effective permissions (`{user, permissions[]}` envelope)
- `f42934e` fix(permissions) — stripFieldsForUser bails on empty rows
- `ee13305` fix(auth) — mobile-owner-app /me caller adapts to new envelope; add /me 404 test
- `43b6074` Task 12 — GET /permissions/registry endpoint
- `1f2fc9b` test(permissions) — add 401 case for /permissions/registry
- `039d85f` Task 13 — GET /users/:id/permissions returns role+overrides+effective
- `4c6714c` Task 14 — PATCH /users/:id/permissions/:permission with audit + cache invalidation
- `5862806` fix(permissions) — wrap PATCH override in transaction; self-check before admin-lockout
- `ea56bca` Task 15 — DELETE /users/:id/permissions/:permission resets to role default

**Phase 5 — FE permission infra (2026-04-29):**

- `72659cc` Task 16 — Permission TypeScript constants + types
- `2396642` Task 17 — PermissionContext provider + usePermissions hook
- `6f7e393` Task 18 — Can + RequirePermission components

**Phase 6 — FE page gating (2026-04-29):**

- `5660a06` Task 19 — permissions-driven sidebar + 403 interceptor
- `eb337e3` Task 20 — hide purchase_price columns + margin widgets for unauthorised users
- `f7e61ab` Task 21 — hide invoice cancel button for users without INVOICES_CANCEL

**Phase 7 — Admin UI (2026-04-29):**

- `46b105b` Task 22 — UsersListPage at /settings/users + overrides count in API
- `a298c71` Task 23 — PermissionMatrix + PermissionRow components
- `7fabcbf` Task 24 — OverrideDialog + RoleSelector + AuditTrail + audit endpoint
- `5464476` Task 25 — UserDetailPage with PermissionMatrix + RoleSelector + AuditTrail (full admin UI at /settings/users/:id)

**Phase 8–9 — E2E + verification (2026-04-29):**

- `0f6e43b` Task 26 — E2E test scenarios: sales role + admin matrix + lockout

Test baseline: **262 passed, 2 pre-existing payments-razpiska failures** (unrelated to permissions work).

**Behavioral changes from Phase 2 alignments with spec ROLE_DEFAULTS** (intentional — flagged in commit messages):

- accountants can now create/regenerate/email invoices (Task 7)
- accountants can now manage incoming workflow (Task 8)
- sales can now print order PDFs (stock-dispatch, commercial-doc, warranty)
- GET /incoming now requires INCOMING_MANAGE (sales blocked)
- owner_mobile session loses cancel-incoming access (re-eval if mobile-owner-app needs accommodation)

**Behavioral changes from Phases 3–6 (Tasks 10–21):**

- Task 10: purchase_price stripped server-side for sales role on inventory/products/incoming list responses
- Task 11: `/auth/me` response shape changed from `{...userFields}` to `{user, permissions[]}` — mobile-owner-app updated to match
- Task 19: sidebar now permission-driven, role-based filter removed; sales user sees ~7 items vs admin's 12
- Task 20: Доставна цена + Марж columns hidden in Products table for users without INVENTORY_VIEW_PURCHASE_PRICE; total_stock_value KPI hidden in Dashboard; Edit button gated by PRODUCTS_MANAGE
- Task 21: invoice cancel button hidden for users without INVOICES_CANCEL

**Follow-ups tracked (non-blocking, schedule for a future session):**

- Audit other purchase_price leaks: `orders.ts:366`, `analytics.ts:283`, `agent.ts:69`
- Backend minor polish: perms→permissions naming in /me, optional .sort() of permission array, fail-closed comment, error-string casing consistency, Zod blank-reason rejection, remove `as any` casts on `request.user`
- Discuss response envelope for /permissions/registry (bare array vs `{data: [...]}` for codebase consistency)
- 404 test for GET /users/:id/permissions + `return reply` cleanup in `requirePermission`
- 4 missing test cases for DELETE override (404, self, admin, unknown_permission)
- PermissionContext polish: enabled gate for /me; treat /me 401 as logout
- Task 25: transaction wrap for PATCH /users/:id/role + audit log row for role change
- Task 26: optional `data-permission` attribute on PermissionRow checkbox for stable E2E selectors

**Earlier (pre-permissions feature):**

- `aac0cf3` Overnight QA + production-readiness report
- Razpiska payments feature shipped (commits up to `2e6886b`)

---

## Next (ordered by impact)

### Phase 4 leftovers (deferred — not blocking)

1. **Refactor e2e specs to use `loginAsAdmin()`** instead of duplicating
   login flow in 12 files (DRY cleanup, not functional)
2. **EAS dashboard** — register `com.mertm.owner` bundle for the
   rebranded mobile-owner-app build (manual web action, can't be
   automated from CLI)
3. **Comarch + batch/expiry actual deletion** — currently DEPRECATED
   markers; future cleanup commit can remove the dead code entirely

### Production blockers (from PRODUCTION-READINESS-REPORT-2026-04-22.md)

- **P0** Secrets rotation (`JWT_SECRET`, `INTERNAL_API_KEY`, Postgres / Redis passwords) — 11 work-days
- **P0** Sentry + `/metrics` endpoint — observability is currently 0
- **P0** DAISY fiscal printer integration test against real device
- **P1** Econt HTTPS migration + cache bounds + remove empty catch blocks
- **P1** Performance: pg pool tuning (saturates at 9–10 concurrent), cyrillic-search 400 bug
- **Total** est. **6–8 weeks** to confident go-live (Scope D)

---

## Key Decisions (don't re-ask)

| #   | Decision                                                                                  | Date                 |
| --- | ----------------------------------------------------------------------------------------- | -------------------- |
| 1   | Scope D — full cleanup + load testing + 100% coverage                                     | 2026-04-22           |
| 2   | Mobile: `mobile-app/` deleted, `mobile-owner-app/` kept                                   | 2026-04-22           |
| 3   | No batch/expiry tracking — MERT-M sells durable goods                                     | 2026-04-20 (initial) |
| 4   | Greek Foods coexists at `:3003 / :5432 / :6379`; never touched                            | 2026-04-28           |
| 5   | Q1 (B): API keys shared until production deploy                                           | 2026-04-28           |
| 6   | Q2 (A): `b2b-website/` deleted entirely                                                   | 2026-04-28           |
| 7   | Q3 (B): Greek Foods Bash permission stays in `.claude/settings.local.json`                | 2026-04-28           |
| 8   | Q4: New admin password rotated; e2e specs use env vars + new defaults                     | 2026-04-28           |
| 9   | Q5 (B): Comarch + batch/expiry scripts marked DEPRECATED, not deleted                     | 2026-04-28           |
| 10  | Phase 4 complete: STATUS + boot script + fresh venv + mobile-dev rewrite + backup cleanup | 2026-04-28           |

---

## Source of Truth Map

| Topic                          | File                                                                    |
| ------------------------------ | ----------------------------------------------------------------------- |
| **Current status (this file)** | `STATUS.md`                                                             |
| Project intro + agent guide    | `CLAUDE.md`                                                             |
| Repo overview                  | `README.md`                                                             |
| Production readiness scorecard | `PRODUCTION-READINESS-REPORT-2026-04-22.md`                             |
| Most recent QA pass            | `QA-NIGHT-REPORT-2026-04-22.md`                                         |
| Architecture spec              | `docs/superpowers/specs/2026-04-20-mert-m-warehouse-software-design.md` |
| Agent specs                    | `.claude/agents/*.md`                                                   |
| Telegram bot KB                | `telegram-bot/KB/`, `telegram-bot/agent/`                               |
| Historical reports / audits    | `docs/archive/`                                                         |
