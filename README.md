# MERT-M Warehouse Software

Warehouse management system for MERT-M (commercial kitchen equipment distributor).

See `docs/superpowers/specs/2026-04-20-mert-m-warehouse-software-design.md`
for the full architecture and rationale.

## Quick Start

```bash
# Backend
cd warehouse-backend && docker-compose up -d && npm install && npm run migrate && npm run dev

# Frontend
cd warehouse-frontend && npm install && npm run dev

# AI Service
cd ai-service && docker-compose -f docker-compose.ai.yml up -d
```

## Status

Implementation in progress — see `docs/superpowers/plans/`.
