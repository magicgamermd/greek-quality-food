# MERT-M — AI MAX Roadmap Estimate

Date: 2026-05-07

## Summary

MERT-M was built very fast (~1 month) and already has serious product substance. Remaining work is not mainly “more code”; it is stabilization, real business edge cases, and production confidence.

## Realistic Timeline with AI MAX

- **7–10 days** → stable pilot at MERT-M
- **14–21 days** → production-ready for MERT-M's actual business, if scope stays controlled
- **30–45 days** → sellable product for other warehouse/distribution businesses

## Aggressive Execution Plan

### Days 1–3 — Stabilization
- Fix backend/frontend build errors
- Clean git state and split WIP into sensible commits
- Verify/apply migrations
- Bring local stack up
- Run tests and basic E2E smoke

### Days 4–10 — Business-critical Modules
- Serial numbers + warranties
- Service/RMA workflow
- Backorders / awaiting stock
- Supplier purchase orders completed end-to-end
- Returns/replacements/partial credit notes
- Accounting export

### Days 11–14 — Real Pilot
- MERT-M staff use it with real orders
- Econt live flow
- Invoices/payments in real scenarios
- UX corrections from warehouse/accounting feedback

### Days 15–21 — Production Hardening
- Backup/restore verification
- Permissions cleanup
- Secrets/security cleanup
- Monitoring/error tracking
- Fiscal printer validation if required immediately
- Final deployment process

## Core Insight

AI can produce the code quickly. The bottleneck is validating the system against reality: Econt, accountant workflows, fiscal device, warehouse habits, and real client behavior.

If scope is controlled: **2 weeks to a very strong working product, 3 weeks to safely let it run the business.**
