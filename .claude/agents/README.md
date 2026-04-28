# МЕРТ-М Warehouse Platform — Agent Army

## Overview

This directory contains specialized Claude Code agent configurations
for building, testing, and maintaining the MERT-M Warehouse Platform.

## Agent Roster

| #   | Agent                  | File                    | Role                                         | Scope                |
| --- | ---------------------- | ----------------------- | -------------------------------------------- | -------------------- |
| 1   | **Architect**          | `architect.md`          | System design, API contracts, DB schema      | All services         |
| 2   | **Backend Dev**        | `backend-dev.md`        | Fastify routes, DB queries, business logic   | warehouse-backend    |
| 3   | **Frontend Dev**       | `frontend-dev.md`       | React pages, components, UI/UX               | warehouse-frontend   |
| 4   | **AI Engineer**        | `ai-engineer.md`        | FastAPI, Celery tasks, ML pipelines          | ai-service           |
| 5   | **Mobile Dev**         | `mobile-dev.md`         | React Native screens, navigation, offline    | mobile-app           |
| 6   | **B2B Web Dev**        | `b2b-web-dev.md`        | HTML/CSS/JS, portal, SEO                     | b2b-website          |
| 7   | **QA Engineer**        | `qa-engineer.md`        | E2E tests, integration tests, bug hunting    | e2e-tests + all      |
| 8   | **DevOps**             | `devops.md`             | Docker, nginx, CI/CD, monitoring, backups    | infra                |
| 9   | **Code Reviewer**      | `code-reviewer.md`      | Review PRs, enforce standards, catch bugs    | all                  |
| 10  | **Integration Tester** | `integration-tester.md` | Cross-service communication, API contracts   | all services         |
| 11  | **Security Engineer**  | `security-agent.md`     | OWASP audit, secrets, vulnerability scanning | all services + infra |

---

## Inter-Agent Protocol

### Handoff Format

When one agent passes work to another, use this format in the task description:

```markdown
## Handoff: [Source Agent] → [Target Agent]

### Context

- What was done and why
- Links to changed files

### Deliverables

- What was produced (files, migrations, endpoints)

### Requirements for Target Agent

- Specific expectations for the receiving agent
- Acceptance criteria

### Dependencies

- Other agents/tasks that must complete first

### Blockers

- Known issues or open questions
```

### Common Handoff Chains

```
Feature Development:
  Architect → Backend Dev → Frontend Dev → Code Reviewer → QA Engineer → DevOps
                         → AI Engineer ↗
                         → Mobile Dev  ↗
                         → B2B Web Dev ↗

Bug Fix:
  QA Engineer → [responsible agent] → Code Reviewer → QA Engineer (verify)

Security Audit:
  Security Engineer → [responsible agents for fixes] → Security Engineer (verify)

Deployment:
  Code Reviewer (approved) → DevOps → Integration Tester → QA Engineer (smoke test)
```

### Escalation Matrix

| Problem                | First Responder    | Escalate To                            |
| ---------------------- | ------------------ | -------------------------------------- |
| API endpoint bug       | Backend Dev        | Architect (if design issue)            |
| UI rendering issue     | Frontend Dev       | —                                      |
| AI OCR accuracy drop   | AI Engineer        | Architect (if data flow issue)         |
| Mobile crash           | Mobile Dev         | Backend Dev (if API issue)             |
| B2B portal broken      | B2B Web Dev        | Backend Dev (if API issue)             |
| Test failure (flaky)   | QA Engineer        | DevOps (if infra issue)                |
| Container crash        | DevOps             | Backend Dev / AI Engineer              |
| Cross-service failure  | Integration Tester | Architect                              |
| Security vulnerability | Security Engineer  | DevOps (if infra) / relevant dev agent |
| Database performance   | Backend Dev        | Architect (if schema issue)            |

---

## Git Workflow

### Branching Strategy

```
main                    ← production-ready, protected
  └── develop           ← integration branch, CI runs here
       ├── feature/GF-XXX-description   ← new features
       ├── fix/GF-XXX-description       ← bug fixes
       ├── hotfix/GF-XXX-description    ← urgent production fixes
       └── chore/description            ← infra, deps, docs
```

### Branch Rules

1. `main` — protected, requires PR + Code Reviewer approval
2. `develop` — integration, requires passing CI
3. Feature branches — created from `develop`, merged back via PR
4. Hotfixes — created from `main`, merged to both `main` and `develop`

### Commit Convention

```
<type>(<scope>): <description>

Types: feat, fix, refactor, test, docs, chore, ci, perf, security
Scopes: backend, frontend, ai, mobile, b2b, infra, db

Examples:
  feat(backend): add FEFO batch deduction endpoint
  fix(frontend): resolve login redirect loop on expired JWT
  test(qa): add E2E tests for order fulfillment flow
  security(backend): parameterize raw SQL in analytics route
  chore(infra): update PostgreSQL to 16.3-alpine
```

### PR Process

1. Agent creates branch + implements changes
2. Agent opens PR with description (what, why, how to test)
3. **Code Reviewer** reviews (security, standards, correctness)
4. **Security Engineer** reviews (if auth/data/API changes)
5. Fix review feedback → re-request review
6. Approval → merge to `develop`
7. **QA Engineer** runs tests on `develop`
8. **Integration Tester** verifies cross-service flows
9. Release: `develop` → `main` via release PR

### PR Description Template

```markdown
## What

Brief description of changes.

## Why

Business reason or bug reference.

## Changes

- file1.ts: added X
- file2.py: fixed Y

## How to Test

1. Step-by-step testing instructions
2. ...

## Checklist

- [ ] Tests added/updated
- [ ] No hardcoded secrets
- [ ] Parameterized SQL queries
- [ ] Error handling complete
- [ ] Bilingual text (BG/EN)
```

---

## Performance Benchmarks

### API Response Times

| Endpoint Category     | P50 Target | P95 Target | Critical Threshold |
| --------------------- | ---------- | ---------- | ------------------ |
| Auth (login/register) | < 200ms    | < 500ms    | > 1000ms           |
| CRUD (single record)  | < 100ms    | < 300ms    | > 500ms            |
| List (paginated)      | < 200ms    | < 500ms    | > 1000ms           |
| Search (full-text)    | < 300ms    | < 800ms    | > 2000ms           |
| Report/Analytics      | < 500ms    | < 1500ms   | > 3000ms           |
| Invoice PDF gen       | < 2s       | < 5s       | > 10s              |
| AI OCR scan           | < 10s      | < 20s      | > 45s              |

### Frontend Metrics

| Metric                   | Target  | Measured With |
| ------------------------ | ------- | ------------- |
| First Contentful Paint   | < 1.5s  | Lighthouse    |
| Largest Contentful Paint | < 2.5s  | Lighthouse    |
| Time to Interactive      | < 3s    | Lighthouse    |
| Cumulative Layout Shift  | < 0.1   | Lighthouse    |
| Bundle size (gzipped)    | < 200KB | Vite build    |

### Infrastructure

| Metric                     | Target |
| -------------------------- | ------ |
| Docker compose up (cold)   | < 60s  |
| Docker compose up (warm)   | < 15s  |
| Database migration run     | < 10s  |
| Health check interval      | 30s    |
| Max PostgreSQL connections | 20     |
| Redis memory limit         | 256MB  |
