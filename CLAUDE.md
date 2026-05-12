# Greek Quality Food — Project Guide

## ⚠️ READ FIRST — Every Session

**Before starting any work**, read `STATUS.md` at the repo root. It is
the single source of truth for "where we are now" — current branch,
recent commits, active blockers, key decisions, and live ports/creds.

**After completing a significant step**, update `STATUS.md` so the
next session (or the next compacted context) doesn't have to re-derive
state from git history. Historical MERT-M docs (преди форка) live в
`docs/archive-mertm-*`.

## Project Overview

Warehouse management system за **Greek Quality Food** — български
дистрибутор на гръцки хранителни продукти (нетрайни стоки,
изискват lot/batch tracking и срокове на годност).

**Произход:** склониран от MERT-M на 2026-05-12. MERT-M беше форк
от Greek Foods Platform с премахнати партиди/срокове (защото
продаваше кухненско оборудване — durable goods). За Greek Quality
Food **връщаме партиди/срокове/брак** от Greek Foods Platform, а
запазваме всички напреднали MERT-M features (покупни поръчки, права,
продуктови замени, частични плащания, гаранции, Econt подобрения,
Telegram bot и пр.).

## Services

- warehouse-backend (Fastify / TS / PostgreSQL 16) — port **3005**
  (Greek Foods :3003, MERT-M :3004, Greek Quality Food :3005)
- warehouse-frontend (React / Vite / Tailwind v4) — port **5175** dev
  (Greek Foods :5173, MERT-M :5174, Greek Quality Food :5175)
- ai-service (Python / FastAPI) — port 8000, OCR of incoming documents
  (един контейнер обслужва всички проекти — внимателно с конфликтите)
- greekquality-postgres Docker — host port **5434**
  (Greek Foods :5432, MERT-M :5433, Greek Quality Food :5434)
- greekquality-redis Docker — host port **6381**
  (Greek Foods :6379, MERT-M :6380, Greek Quality Food :6381)
- telegram-bot-tester (Node.js / TS) — conversational tester за
  Telegram бота, YAML сценарии, Haiku actor + Sonnet judge

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
- **Batch / expiry tracking АКТИВЕН** — Greek Quality Food продава
  хранителни стоки, така че всяка партида има срок на годност,
  FEFO логика при експедиране, бракуване при просрочване.

## Branding

- Тема: тъмен sidebar `#1a1a2e`, accent **лилав `#6c3dff`**
  (наследен от Greek Foods Platform)
- Лого/име: Greek Quality Food (на места: GQF като акроним)
- PWA: "Greek Quality Food Owner PWA"

## Git Workflow

- Branching: `main` → `feature/GQF-*` / `fix/GQF-*`
- Commits: conventional (feat, fix, refactor, test, docs, chore)
- Never force push to main

## Reference Docs

- Design spec: `docs/superpowers/specs/2026-05-12-greek-quality-food-design.md` (TODO: write)
- Plans: `docs/superpowers/plans/`
- MERT-M historical docs: `docs/archive-mertm-*.md` (за контекст преди форка)

## Deployment

Self-hosted on Mac Mini (target: Greek Quality Food office).
Docker Desktop + launchd auto-start (виж scripts/start-greekquality.sh).
