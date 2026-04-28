# MERT-M — Current Status

> **Single source of truth** for "where are we now". Read this first
> at the start of every session. Update after each significant step.
> Other `.md` files in the root are either historical (`docs/archive/`)
> or scoped (e.g. `PRODUCTION-READINESS-REPORT-2026-04-22.md`).

**Last updated:** 2026-04-28 (mid-session: Phase 1 + 75% of Phase 2 done on permissions feature)
**Active branch:** `feature/MERTM-tester-attachments-buttons`
**Production readiness score:** 4/10 (per `PRODUCTION-READINESS-REPORT-2026-04-22.md`)
**Active feature:** Employee role + per-user permission overrides — see `docs/superpowers/specs/2026-04-28-employee-role-permissions-design.md` and plan `docs/superpowers/plans/2026-04-28-employee-role-permissions.md`. **8 of 27 tasks committed** (foundation + 3 of 4 route refactors). Resume at Task 9.

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

**Permission system feature — in progress** (2026-04-28):

- `a3b7d24` Task 1 — DB migration 053 (sales role + user_permission_overrides table)
- `43e2f3a` Task 2 — Redis singleton at `lib/redis.ts` (uses `ioredis`)
- `de9e1f6` Task 3 — Permission registry constants (16 perms, 4 roles, ROLE_DEFAULTS, PERMISSION_REGISTRY)
- `85c77d0` Task 4 — getUserPermissions + hasPermission + invalidateUserPermissions + 9 tests
- `40964ab` Task 5 — requirePermission middleware + stripFieldsForUser + 5 tests
- `b62b055` Task 6 — users.ts + settings.ts refactor (2 sites → USERS_MANAGE / SETTINGS_MANAGE)
- `cb1c9f9` Task 7 — invoices.ts refactor (10 sites; **accountants now can create invoices**, fixed inverted bug)
- `e429e3b` Task 8 — orders.ts + incoming.ts refactor (15 sites; GET /incoming now gated by INCOMING_MANAGE)

**Tasks 9-27 remain.** Resume in next session via subagent-driven-development OR executing-plans skill, using the plan file. Test baseline: 248 passed, 2 pre-existing failures.

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
