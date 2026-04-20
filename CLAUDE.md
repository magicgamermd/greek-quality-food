# Greek Foods Platform — Project Guide

## Project Overview
B2B warehouse management platform for a Greek food distributor in Bulgaria.
5 services: warehouse-backend, warehouse-frontend, ai-service, mobile-app, b2b-website.

## Agent Army
All agent configurations live in `.claude/agents/`. When working on a specific service,
read the corresponding agent file first to understand the role, standards, and rules.

| Agent | File | Scope |
|-------|------|-------|
| Architect | `.claude/agents/architect.md` | System design, DB schema, API contracts |
| Backend Dev | `.claude/agents/backend-dev.md` | warehouse-backend (Fastify/TS/PostgreSQL) |
| Frontend Dev | `.claude/agents/frontend-dev.md` | warehouse-frontend (React/Vite/Tailwind) |
| AI Engineer | `.claude/agents/ai-engineer.md` | ai-service (FastAPI/Celery/GPT-4) |
| Mobile Dev | `.claude/agents/mobile-dev.md` | mobile-app (React Native/Expo) |
| B2B Web Dev | `.claude/agents/b2b-web-dev.md` | b2b-website (HTML/CSS/JS) |
| QA Engineer | `.claude/agents/qa-engineer.md` | Testing across all services |
| DevOps | `.claude/agents/devops.md` | Docker, Nginx, CI/CD, infra |
| Code Reviewer | `.claude/agents/code-reviewer.md` | Quality enforcement |
| Integration Tester | `.claude/agents/integration-tester.md` | Cross-service verification |
| Security Engineer | `.claude/agents/security-agent.md` | OWASP audit, secrets, vulnerability scanning |

## Workflow
1. **Architect** designs the solution (schema, API contract, data flow)
2. **Backend Dev** implements backend logic
3. **AI Engineer** implements AI/automation tasks
4. **Frontend Dev** / **Mobile Dev** / **B2B Web Dev** build UI
5. **Security Engineer** audits for vulnerabilities
6. **Code Reviewer** reviews the code
7. **QA Engineer** tests functionality
8. **Integration Tester** verifies cross-service flows
9. **DevOps** deploys and monitors

## Git Workflow
- **Branching**: `main` → `develop` → `feature/GF-XXX-desc` / `fix/GF-XXX-desc` / `hotfix/GF-XXX-desc`
- **Commits**: `<type>(<scope>): <description>` — types: feat, fix, refactor, test, docs, chore, ci, perf, security
- **PRs**: Code Reviewer + Security Engineer (if auth/API changes) approve before merge
- **Full protocol**: see `.claude/agents/README.md`

## Critical Rules (ALL agents must follow)
- Language: Bulgarian for user-facing text, English for code/comments
- Currency: BGN, VAT: 20%
- Timezone: Europe/Sofia
- Auth: JWT (8h expiry), roles: admin, warehouse, accountant
- DB: PostgreSQL 16, parameterized queries only
- No hardcoded secrets — use .env files
- All dates: ISO 8601 / TIMESTAMPTZ
- Bilingual: name_bg + name_en for entities

## Service Ports
| Service | Dev Port | Docker Port |
|---------|----------|-------------|
| warehouse-backend | 3000 | 3003 |
| warehouse-frontend | 5173 | — |
| ai-service | 8000 | 8000 |
| PostgreSQL | 5432 | 5432 |
| Redis | 6379 | 6379 |
| Nginx | — | 80/443 |

## Quick Start
```bash
# Backend
cd warehouse-backend && docker-compose up -d && npm run migrate && npm run dev

# AI Service
cd ai-service && docker-compose -f docker-compose.ai.yml up -d && uvicorn app.main:app --reload

# Frontend
cd warehouse-frontend && npm run dev

# Mobile
cd mobile-app && npx expo start
```
