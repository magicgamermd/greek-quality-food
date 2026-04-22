# MERT-M Warehouse Software — Project Guide

## Project Overview

Warehouse management system for MERT-M, a Bulgarian distributor of commercial
kitchen equipment (Hendi, Bartscher, KitchenAid, Liebherr and similar brands).
Cloned from greek-foods-platform. Batch/expiry tracking removed (not needed for
durable goods).

## Services

- warehouse-backend (Fastify / TS / PostgreSQL 16) — port 3003
- warehouse-frontend (React / Vite / Tailwind v4) — port 5173 dev
- ai-service (Python / FastAPI) — port 8000, OCR of incoming documents
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
