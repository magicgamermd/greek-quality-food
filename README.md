# Greek Quality Food — Warehouse Software

Warehouse management system за Greek Quality Food (български
дистрибутор на гръцки хранителни продукти).

**История:** склониран от MERT-M (който е форк на Greek Foods Platform).
За Greek Quality Food са върнати партидите, сроковете на годност
и бракуването от Greek Foods, а са запазени напредналите MERT-M
features (покупни поръчки, права, замени, частични плащания).

Виж `CLAUDE.md` и `STATUS.md` за подробности.

## Quick Start

```bash
# Backend
cd warehouse-backend && docker-compose up -d && npm install && npm run migrate && npm run dev

# Frontend
cd warehouse-frontend && npm install && npm run dev

# AI Service
cd ai-service && docker-compose -f docker-compose.ai.yml up -d
```

## Ports (не пресичат Greek Foods и MERT-M)

| Service        | Greek Foods | MERT-M | **Greek Quality Food** |
| -------------- | ----------- | ------ | ---------------------- |
| Backend        | 3003        | 3004   | **3005**               |
| Frontend dev   | 5173        | 5174   | **5175**               |
| Postgres       | 5432        | 5433   | **5434**               |
| Redis          | 6379        | 6380   | **6381**               |
| Docker project | greekfoods  | mertm  | **greekquality**       |

## Status

Initial setup от MERT-M base. Виж `STATUS.md`.
