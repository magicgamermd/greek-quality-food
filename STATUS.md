# MERT-M — Current Status

> **Single source of truth** for "where are we now". Read this first
> at the start of every session. Update after each significant step.
> Other `.md` files in the root are either historical (`docs/archive/`)
> or scoped (e.g. `PRODUCTION-READINESS-REPORT-2026-04-22.md`).

**Last updated:** 2026-05-07 (Product replacement — "Замяна" — feature complete on `feature/MERTM-product-replacement`; pending final review + merge to main)
**Active branch:** `feature/MERTM-product-replacement` (worktree at `.claude/worktrees/product-replacement/`)
**Production readiness score:** 4/10 (per `PRODUCTION-READINESS-REPORT-2026-04-22.md`)
**Active task:** Final code review on the replacement branch, then merge to main and `./scripts/push-to-client.sh`. Earlier Econt diagnostic remains open as separate work-in-progress on `feature/MERTM-purchase-orders-redesign`.

**Product replacement (Замяна) feature — COMPLETE (2026-05-07, 20 commits on `feature/MERTM-product-replacement`):**

Feature lets a worker create an exchange order — customer brings back a previously bought item and takes a different one. The original razpiska is never touched; a new order with `is_replacement = true` carries both "give" and "return" lines, signed total, and an auto-generated payment row for the difference.

- Spec: `docs/superpowers/specs/2026-05-07-product-replacement-design.md`
- Plan: `docs/superpowers/plans/2026-05-07-product-replacement.md` (20 tasks, all delivered)
- Migrations:
  - `077_orders_replacement.sql` — `orders.is_replacement` + `order_items.is_returning` + partial index
  - `078_payments_is_refund.sql` — `payments.is_refund` (cash-out flag for refund/cancel-mirror entries)
- Backend (`warehouse-backend/src/routes/orders.ts` + helpers):
  - POST /orders accepts replacement payload, validates ≥1 give + ≥1 return, blocks VAT-registered partners (deferred to next iteration)
  - Signed total computed inside the create transaction; auto-inserted `payments` row (positive total → is_refund=false; negative → is_refund=true; zero → no row)
  - POST /orders/:id/fulfill bidirectional stock movements (give -qty, return +qty); same-SKU warranty case nets to zero
  - GET /orders accepts `?is_replacement=true|false` filter
  - DELETE /orders/:id reverses both stock movements and inserts a mirror payment with flipped `is_refund` so the cash trail balances
  - Notification `replacement_ready_for_packaging` emitted on create with payload `{order_id, is_replacement: true}`
  - PDF generator `services/razpiska-replacement-pdf.ts` ("СТОКОВА РАЗПИСКА ЗА ЗАМЯНА") — pdfkit, Roboto, two coloured sections, signed difference, descriptive sentence, signatures
  - New helper `isRazpiskaEligible(partner)` in `constants/partners.ts` (extracted to share across routes)
  - New permission `REPLACEMENT_CREATE` granted to admin/accountant/warehouse/sales by default
- Frontend (`warehouse-frontend/src/`):
  - `Order.is_replacement` + `OrderItem.is_returning` types
  - New component `components/orders/ReplacementForm.tsx` — toggle, two sections (green Взема се / red Връща се), live signed-diff banner, conditional payment-method picker (Брой / POS / Превод)
  - `pages/Orders.tsx` — toggle "🔄 Замяна" inside the New Order form, disabled for VAT-registered partners with tooltip; submit branches between order/replacement payloads; "Създай замяна" button replaces "Създай поръчка" in replacement mode
  - List view: filter pill "🔄 Замени"; replacement rows shown red with "🔄 ЗАМЯНА" label and signed total
  - New component `components/orders/ReplacementDetail.tsx` — red title, two sections, signed footer, three actions (Печат / Към пакетиране / Анулирай with confirm)
  - Partner history drawer (`PartnerHistoryDrawer.tsx`) — red badge "🔄 Замяна" on replacement rows, signed total
- Daily report PDF (`services/daily-report-pdf.ts` + `routes/reports.ts`) — new "🔄 ЗАМЕНИ" section between orders/payments and expectedCod, with per-row table and a "Брой замени | Нетна разлика" footer (signed)
- Tests: 23 new BE tests (replacement-create×8, payment×3, fulfill×2, filter×3, cancel×2, notification×2, pdf×3) — full BE suite **382 passing / 8 failing** (same 8 pre-existing failures: document-pdf, econt-update-shipment, invoices-partner-override ×4, orders-below-cost, orders-quotation — none related to this feature). Frontend `vite build` passes; `tsc --noEmit` clean.
- **Out of scope (deferred to next iteration, per spec section 11):** invoice (ДДС-фактура) replacements, link to original order (`replaces_order_id`), warranty-protocol flow, return-only.
- **Open items before merge:** (1) final cross-feature code review; (2) manual E2E pass on the local stack covering all 10 scenarios in plan task 20; (3) note that the worktree branch was created off `feature/MERTM-purchase-orders-redesign` HEAD, which carries uncommitted migrations 071/074/075/076 in the main checkout — those need to land on `main` before this branch can deploy cleanly (not a code conflict; just migration sequencing).

**Econt calendar validation + price-bug diagnostic — COMPLETE (merged 2026-05-05 via `65c2f37`):**

- Backend: new endpoint `POST /econt/validate-shipment-date` — wraps Econt's `LabelService.createLabel.json` in `mode:"validate"` and reflects accept / reject as `{valid, reason?}`. 24h in-memory cache by `(receiverCity|officeCode|street/num, date)` keyed.
- Backend: `/calculate` gains a debug log gated by `ECONT_DEBUG=1` env var — prints `mode=office|address city=… weight=… → priceBGN=…` so we can compare what Econt actually returns for both delivery types. Set `ECONT_DEBUG=1` in `warehouse-backend/.env`, restart, then test in UI and `tail -f /tmp/mertm-backend.log | grep "\[econt/calculate\]"` to confirm whether the user-reported "same price" issue is an Econt quirk or a payload bug.
- Frontend: new `lib/bgCalendar.ts` — 2026/2027 БГ official holidays + `isWorkingDay` / `isPast` / `nonWorkingReason` helpers.
- Frontend: new `components/ui/WorkingDayPicker.tsx` — popover-style calendar that greys out past dates, weekends, БГ holidays, and (when `econtRoute` provided) Econt-rejected dates with the reason in a tooltip. Pre-validates the visible month's working days in parallel through the new endpoint; cached server-side so re-opens are free.
- Frontend: `EcontShippingPicker.tsx` swaps native `<input type="date">` for `WorkingDayPicker` in address-mode delivery. Tomorrow stays the default; the picker won't allow clicking a Saturday or a known holiday.
- Tests: `econt-validate-shipment-date.test.ts` (5 tests — accept, reject with Econt reason, missing-fields 400, address-mode payload, 24h cache hit). All 5 pass.
- 333/340 BE tests pass — 7 failures = 6 pre-existing (Batch F1 baseline) + 1 new from parallel `feature/MERTM-orders-quotation` work that landed on main in the same window. None of the 7 are from this branch.
- BE+FE type-check clean (pre-existing `negative-inventory.test.ts(321)` overload only).
- **Open item:** Live verification of the price-bug diagnostic — user must `ECONT_DEBUG=1` and capture two `[econt/calculate]` log lines (office mode + address mode) for the same city/weight to confirm whether Econt API returns identical prices.

**Batch I — Notifications UX upgrade — COMPLETE (merged 2026-05-05 via `5c0c5bc`):**

- Migration 067 — drops vestigial `notifications.read` global column (per-user read state lives in `notification_reads`)
- Backend: GET /notifications rewritten — unified feed merging computed alerts (low_stock, expiring) with persistent `notifications` rows; ID prefixes (`low-`, `exp-`, `db-`) avoid collision; per-user `is_read`/`read_at`/`dismissed` from `notification_reads`; new `payload` field carried through. New endpoint GET /notifications/unread-count for fast bell-badge polling.
- Tests: `notifications-per-user-read.test.ts` (3 tests — A's read state doesn't leak to B; PUT /:id/read scoped to caller; DELETE /:id sets dismissed for caller only). **329/335 BE tests pass — same 6 pre-existing failures as Batch F1 baseline.**
- Frontend: new `lib/notificationTypes.ts` (TOAST_WORTHY allowlist + group helpers — Поръчки / Склад / Общи); new `hooks/useNotificationsPolling.ts` (30s `refetchInterval` + toast on new TOAST_WORTHY items, primed on first mount to avoid initial spam, "Виж" action button when navigation context provided); `lib/toast.ts` extended to forward sonner's native `action` option.
- Layout.tsx bell dropdown rewritten: groups by category, `•` (unread) / `✓` (read) indicators, click to mark-read + navigate via payload (`order_id` → `/orders?highlight=`, `product_id` → `/products?highlight=`), "Маркирай всички" button; per-row dismiss × preserved.
- Systematic action toasts on Orders / Invoices / Partners / Products mutations (Bulgarian-language success + error fallback chain `err?.response?.data?.error ?? .message ?? "…"`); Settings + 4 Invoices mutations skipped to preserve their existing in-page banner UX.
- BE+FE type-check clean (only pre-existing `negative-inventory.test.ts(321)` overload error from Batch F1).
- **Open item:** Task 9 manual E2E (8-step script: bell badge / groups / mark-all / click navigation / per-user isolation across two browsers / 30s polling toast / action toasts on Orders+Invoices+Payments / error toast on rejected fulfill) deferred to post-merge user verification.
- **Deferred to Batch I.2** (per plan "Future work"): banner alerts, per-type user prefs, Web Notifications API, full /notifications page, group collapse/expand, SSE realtime.

**Batch F1 — COMPLETE (all 18 tasks of the plan):**

- Migrations 064 (`order_items.line_status` enum + partial index) + 065
  (`notifications.payload` jsonb)
- Backend: shared `ORDER_LINE_STATUSES` constant,
  `deductProductStock({allowNegative})` helper, fulfill branches per
  status, persistence in 3 INSERT sites, 2 transition endpoints
  (`/handover`, `/confirm-from-awaiting`), `pending_order_ready`
  notification trigger on incoming confirm, 2 filter params
  (`?has_paid_not_taken=`, `?has_awaiting=`)
- Frontend: types, bg-tint + chip in drawer items, per-row
  "✓ Предадено" / "✓ Потвърди" buttons, 3-button split-on-oversell in
  `OversellConfirmDialog`, 2 filter pills, parse-error fix in same dialog
  (typographic " inside double-quoted string)
- Tests: `orders-line-status.test.ts` (11 tests — fulfill skip/allow-neg
  branches, /handover, /confirm-from-awaiting, filter EXISTS clauses) +
  `incoming-pending-notification.test.ts` (3 tests — 1-per-line emit,
  no-match, cancelled excluded). Updated `negative-inventory.test.ts` and
  `incoming-confirm-inventory.test.ts` to mock the new SELECT pendingLines
  call/`paid_not_taken` opt-in. **326/332 tests pass; the 6 remaining
  failures are pre-existing on `main` (verified before F1 work)**
- Task 17 manual E2E **pending** on real client data (paid_not_taken flow,
  handover, awaiting flow, filter pills, cancel-with-paid_not_taken)

---

## 🔁 Session handover

**Read this whole file FIRST** at the start of every new session. Then read
`/Users/magic/CLAUDE.md` and `/Users/magic/Projects/mert-m/CLAUDE.md` for the
permanent project rules.

**End of session checklist** — before closing the conversation:

1. Update **"Active task"** at the top with what's in flight.
2. Update **"Pending commits"** — list every modified file not yet committed.
3. Update **"Live deployment"** — what's already pushed to the client.
4. Append to **"Session log"** — what got done today, dated entry.
5. Optional: `git add -p && git commit` so changes are persisted.

**Start of session checklist:**

1. Read `STATUS.md` (this file) top to bottom.
2. `git status` — see uncommitted changes from previous session.
3. Run `./scripts/start-mertm.sh` if local dev stack isn't up.
4. Open the client tunnel: `ssh mertm@100.83.242.8 'echo connected'`.
5. Confirm with user what's the priority for today.

---

## Where We Are

**Phase:** First live client deployment on a Mac Mini at МЕРТ-М. Catalog
imported from Microinvest exports (14,959 products + 12,568 partners).
We're now hardening the UI and Econt integration based on user testing.

**Current focus (2026-04-30):** Bug fixes + Econt waybill flow + auto-fill
new partner from Bulgarian commercial registry.

---

## 🚚 Live deployment (Mac Mini at client site)

|              |                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| Host         | Mac Mini M4, macOS 26.2, hostname `MERTMs-Mac-mini.local`                                                   |
| User         | `mertm`, sudo password `0000`, admin                                                                        |
| Tailscale IP | `100.83.242.8` (SSH key already installed from dev Mac)                                                     |
| LAN IP       | `192.168.0.122`                                                                                             |
| Project root | `/Applications/MERT-M/`                                                                                     |
| Docker       | Docker Desktop (auto-start hidden on boot, see Login Items)                                                 |
| LaunchAgent  | `bg.mertm.app` runs `start-mertm.sh` at login (auto-warmup)                                                 |
| LaunchAgent  | `bg.mertm.backup` daily 03:00 → `~/mertm-data/backups/*.sql.gz` (30-day retention)                          |
| Launchers    | `~/Desktop/Start MERT-M.app` + Stop + Update (custom MERT logo)                                             |
| Login        | `admin@mertm.bg` / `admin123`                                                                               |
| Browser      | Chrome `--app=http://localhost:5174` (from Start launcher)                                                  |
| Econt        | Username `magicgamermd@gmail.com` (private profile, sender = "Валери Тошков Иванов" София бул. Тотлебен 67) |

### Push code to client

```bash
./scripts/push-to-client.sh           # default: pack + scp + migrate + restart
./scripts/push-to-client.sh --no-restart   # push only (Vite hot-reload only)
```

### Remote SSH

```bash
ssh mertm@100.83.242.8                 # passwordless via Tailscale
tail -f /tmp/mertm-{backend,frontend,ai,launcher,launchagent}.log
```

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

## 🚧 Pending commits

Current uncommitted state on `main` (run `git status` to refresh):

**Modified:**

- `warehouse-backend/src/index.ts` — CORS adds 5174 + LAN/Tailscale patterns
- `warehouse-backend/src/routes/econt.ts` — receiverAgent + sendDate (NOT shipmentDate) + shipment_description plumbing
- `warehouse-backend/src/routes/orders.ts` — econt_shipment_description + econt_shipment_date insert/update + 3-tier sort + word-position rank in /products-for-order
- `warehouse-backend/src/routes/partners.ts` — maxLimit 5000 → 25000
- `warehouse-backend/src/routes/products.ts` — maxLimit 5000 → 25000
- `warehouse-frontend/src/components/EcontShipmentActions.tsx` — pass shipment_description + shipment_date
- `warehouse-frontend/src/components/EcontShippingPicker.tsx` — new "Съдържание" input + date picker (address delivery only)
- `warehouse-frontend/src/components/ui/combobox.tsx` — React Portal + fixed-position dropdown + stopPropagation + onMouseDown selection (fixes clipping inside Dialog)
- `warehouse-frontend/src/pages/Orders.tsx` — partner picker limit=25000 (×2), shipment fields wired, debounced EIK lookup in new-partner form
- `warehouse-frontend/src/pages/owner/OwnerScan.tsx` — limit=25000
- `warehouse-frontend/src/types/index.ts` — `econt_shipment_description` + `econt_shipment_date` on `Order`
- `STATUS.md` — this update

**New (untracked):**

- `data-imports/` — Microinvest .txt parsers + CSV/SQL outputs (products + partners)
- `macos-installer/` — Start/Stop/Update .app bundles + install.sh + README + assets/mertm.icns
- `scripts/push-to-client.sh` — automate dev→client deploy
- `warehouse-backend/migrations/060_orders_econt_shipment_description.sql`
- `warehouse-backend/migrations/061_orders_econt_shipment_date.sql`
- `warehouse-backend/backups/` — pre-import DB dumps from dev sessions

When you're ready to commit, do small focused commits per concern (Econt
fixes / Combobox fix / partner-import tooling / installer / etc) so PR
review (or future bisect) stays sane.

---

## 📝 Session log

### 2026-04-30 (afternoon) — Client deployment + Econt + UI fixes — IN PROGRESS

Done in this session (uncommitted, see "Pending commits" below):

**Deployment**

- First production install on Mac Mini at client (see "Live deployment").
- Tailscale SSH (key-based, no password) from dev Mac → client.
- Docker Desktop auto-starts hidden on boot (settings-store.json patched).
- Two LaunchAgents: `bg.mertm.app` (backend warmup at login), `bg.mertm.backup` (daily 03:00 pg_dump).
- Three custom-icon `.app` launchers on Desktop (Start / Stop / Update).
- Daily backup → `~/mertm-data/backups/`, 30-day rotation.
- Imported 14,959 products + 12,568 partners from Microinvest .txt exports
  (parsers in `data-imports/parse_*.py`; CSV+SQL in same folder).

**Bug fixes shipped to client**

1. CORS: backend allowed only port 5173; bumped to also accept 5174 + LAN
   `192.168.x.x:517[34]` + Tailscale `100.x.x.x:517[34]`. (`warehouse-backend/src/index.ts`)
2. Partner search cap: backend limit 5,000 → 25,000 (we have 12,568).
   `warehouse-backend/src/routes/partners.ts:69` + `Orders.tsx` callsites.
3. Product catalog cap: backend limit 5,000 → 25,000.
   `warehouse-backend/src/routes/products.ts:237` + `OwnerScan.tsx`.
4. Products-for-order sort hierarchy (matches user request "стъпаловидно"):
   tier (in-stock+price → 0-stock+price → priceless) → word-position of
   search term in name → alphabetical. `warehouse-backend/src/routes/orders.ts:391`.
5. Econt credentials configured in client `.env` (note: password contains `#`,
   MUST be quoted in `.env` or dotenv strips it as comment).
6. Econt receiver_agent always sent (previously missing → error 517 "За
   юридическо лице, задължително се попълва упълномощено лице").
   `warehouse-backend/src/routes/econt.ts`.
7. Econt `sendDate` (NOT `shipmentDate` — Econt API quirk, took an hour to
   find) defaults to tomorrow if caller omits. Required for address delivery.
8. Migrations 060 (`econt_shipment_description`) + 061 (`econt_shipment_date`)
   on orders.
9. New "Съдържание на пратката" + "Дата на доставка" inputs in
   `EcontShippingPicker.tsx` (date only shown for address delivery).
10. Cleanup of all today's test orders + restock of fulfilled inventory.

**In-progress (NOT yet pushed to client at end of session)**

- Combobox dropdown was clipped inside dialogs → switched to React Portal +
  `position: fixed` + `stopPropagation` + `onMouseDown` on options.
  `warehouse-frontend/src/components/ui/Combobox.tsx`.
- New-partner form in Orders.tsx now has debounced EIK auto-lookup
  (papagal.bg endpoint already at `/partners/lookup/:eik`). Last user test
  said clicking on a partner option in the dropdown still closes without
  selecting — `onMouseDown` fix may resolve this; pending live confirmation.

**API issue with EIK auto-fill**

- `papagal.bg` is now Cloudflare-blocked from server-side calls (returns
  HTML challenge). User mentioned having a paid trade-registry API key for
  the Telegram bot but didn't share it. Need to ask user for:
  - API URL
  - API key
  - Sample response shape
    Then swap papagal.bg out for the working service.

**Open questions / things to remember**

- User wants to review FULL Econt API documentation and craft a waybill
  template that matches Econt's standard form. Pending screenshot/template.
- After 4 today's orders + linked invoices were deleted, order numbering
  sequence kept going (next will be #5 etc). User aware.
- Local dev stack now mirrors client exactly (same DB content, same admin
  password). Vite hot-reload + `tsx watch` make iteration fast on dev Mac;
  `./scripts/push-to-client.sh` ships changes when ready.

**Plan parked for next session — Замяна на стока + Частично КИ:**

- File: `docs/superpowers/plans/2026-04-30-replacements-and-partial-credit-notes.md`
- 16 tasks across 8 phases (~3 work-days)
- **Awaits user answers on 8 open questions before execution** (касови
  продажби flow, decimals в qty, permissions, срок-cutoff и т.н. — изброени
  в plan-а)
- When ready: `git checkout main && git pull && git checkout -b feature/MERTM-replacements-and-partial-credit-notes` then run `executing-plans` skill against the file.

### Earlier today — Daily Report

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
