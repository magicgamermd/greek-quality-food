# MERT-M Warehouse Software — Project Guide

## ⚠️ READ FIRST — Every Session

**Before starting any work**, read `STATUS.md` at the repo root. It is
the single source of truth for "where we are now" — current branch,
recent commits, active blockers, key decisions, and live ports/creds.

**After completing a significant step**, update `STATUS.md` so the
next session (or the next compacted context) doesn't have to re-derive
state from git history. The other `.md` files in the repo root are
either project intro (`README.md`, this `CLAUDE.md`) or scoped
artifacts (`PRODUCTION-READINESS-REPORT-2026-04-22.md`,
`QA-NIGHT-REPORT-2026-04-22.md`); historical reports live in
`docs/archive/`.

## Project Overview

Warehouse management system for MERT-M, a Bulgarian distributor of commercial
kitchen equipment (Hendi, Bartscher, KitchenAid, Liebherr and similar brands).
Cloned from greek-foods-platform. Batch/expiry tracking removed (not needed for
durable goods).

## Services

- warehouse-backend (Fastify / TS / PostgreSQL 16) — port **3004** (Greek Foods Docker държи :3003)
- warehouse-frontend (React / Vite / Tailwind v4) — port **5174** dev (Greek Foods държи :5173)
- ai-service (Python / FastAPI) — port 8000, OCR of incoming documents
- mertm-postgres Docker — host port **5433** (Greek Foods PG държи :5432)
- mertm-redis Docker — host port **6380** (Greek Foods Redis държи :6379)
- telegram-bot-tester (Node.js / TS) — conversational tester за Telegram бота, YAML сценарии, Haiku actor + Sonnet judge, ad-hoc CLI

## Agent Army

All agent configurations live in `.claude/agents/`. Read the corresponding agent
file before working on a specific service.

## Critical Rules

- Language: Bulgarian for user-facing text, English for code/comments
- Currency: BGN, VAT: 20%, Timezone: Europe/Sofia
- Auth: JWT (8h expiry), roles: admin, accountant, warehouse
- DB: PostgreSQL 16, parameterized queries only
- No hardcoded secrets — use .env files
- Dates: ISO 8601 / TIMESTAMPTZ
- **No batch/expiry tracking — MERT-M sells durable goods, not perishables.**

## Git Workflow

- Branching: `main` → `feature/MERTM-*` / `fix/MERTM-*`
- Commits: conventional (feat, fix, refactor, test, docs, chore)
- Never force push to main

## Reference Docs

- Design spec: `docs/superpowers/specs/2026-04-20-mert-m-warehouse-software-design.md`
- Plans: `docs/superpowers/plans/`

## Deployment

Self-hosted on Mac Mini M4 at MERT-M office (see spec section 3.2).
