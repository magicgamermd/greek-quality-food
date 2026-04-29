# MERT-M — Current Status

> **Single source of truth** for "where are we now". Read this first
> at the start of every session. Update after each significant step.
> Other `.md` files in the root are either historical (`docs/archive/`)
> or scoped (e.g. `PRODUCTION-READINESS-REPORT-2026-04-22.md`).

**Last updated:** 2026-04-29 (Phase 9 complete — feature SHIPPED, 27 of 27 tasks)
**Active branch:** `feature/MERTM-tester-attachments-buttons`
**Production readiness score:** 4/10 (per `PRODUCTION-READINESS-REPORT-2026-04-22.md`)
**Active feature:** Employee role + per-user permission overrides — **COMPLETE** (Phases 1–9). All 27 tasks committed. Backend: DB migration 053 + 16-permission registry + Redis-cached resolver + 5 REST endpoints (/auth/me extended, /permissions/registry, GET/PATCH/DELETE /users/:id/permissions, GET /users/:id/audit). Frontend: PermissionContext + Can/RequirePermission + permission-driven sidebar + admin UI at /settings/users/:id. E2E test scenarios cover sales role + admin matrix + lockout. Pending follow-ups documented below.

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
