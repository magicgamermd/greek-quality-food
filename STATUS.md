# Greek Quality Food — STATUS

**Last updated:** 2026-05-12

## Origin

Project клониран от MERT-M (`/Users/magic/Projects/mert-m`) с пълна git
история. MERT-M беше форк от Greek Foods Platform с премахнати
партиди/срокове/брак.

За Greek Quality Food (български дистрибутор на гръцки хранителни
стоки — нетрайни) **връщаме партидите, сроковете на годност и
брака** от Greek Foods Platform, а **запазваме** всички MERT-M
подобрения (покупни поръчки, права, продуктови замени, частични
плащания, гаранции, Econt подобрения, Telegram bot, MCP server).

## Setup phase — DONE

- [x] Git clone MERT-M → greek-quality-food (с пълна история)
- [x] Премахнат remote към оригиналния MERT-M (за безопасност)
- [x] Docker project preimenuван: mertm → greekquality
- [x] Docker портове: postgres 5433→5434, redis 6380→6381, backend 3004→3005
- [x] Frontend dev port: 5174 → 5175
- [x] Volume names: mertm*\* → greekquality*\*
- [x] package.json names обновени (backend, frontend, telegram-bot, tester)
- [x] pyproject.toml (ai-service) обновен
- [x] .env.example файлове (backend, ai-service, telegram-bot, tester)
- [x] CLAUDE.md, README.md обновени за Greek Quality Food
- [x] STATUS.md и PRODUCTION-READINESS-REPORT (MERT-M) архивирани в docs/

## Setup phase — TODO

- [ ] Branding: цветове на Greek Foods (`#6c3dff` лилав вместо `#f97316` оранжев)
- [ ] UI текстове: "МЕРТ-М" → "Greek Quality Food" (Dashboard, sidebar, login)
- [x] Лого/favicon на Greek Foods (копирани)
- [x] Връщане на партиди (batches): миграция 080 + routes + ETL данни
- [x] Връщане на бракуване (writeoffs): routes + UI наследени
- [x] Връщане на срокове на годност: в batches schema
- [x] Verify partner objects/sites UI — Greek Foods полета върнати в Orders
- [x] Миграция на данни от Greek Foods DB: 1799 продукта + 428 партньори + 64 доставчици + 13 батча + 12 inventory
- [x] Smoke test: 3 проекта работят паралелно без конфликти

## Допълнителни Greek Foods features възстановени

- Номер на заявка + Обект/магазин dropdown + Име/Код на обект (Orders new dialog)
- Партида + Годност колони в линиите на продукта (FEFO auto-select)
- CompanyBook API ключ (споделен с MERT-M, от `~/.openclaw/auth/key-companybook.key`)
- Econt master switch в Settings → Интеграции (мигр. 081)
- ВКЛ ДДС логика винаги (премахнати "с/без ДДС" dropdown-ите)

## AI Service

GQF има отделна ai-service инстанция на host port **8001**
(MERT-M / Greek Foods ползват :8000). Конфиг в
`ai-service/.env`: WAREHOUSE_API_URL=http://127.0.0.1:3005,
INTERNAL_API_KEY=devinternal_gqf_001234567890.

Стартиране:

```bash
cd ai-service
.venv311/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001
```

Endpoints: /ai/scan-invoice, /ai/quick-invoice-check,
/ai/confirm-invoice-template, /ai/match-products, /ai/forecast,
/ai/anomalies.

## Ports cheat sheet

| Service        | Greek Foods               | MERT-M | **Greek Quality Food** |
| -------------- | ------------------------- | ------ | ---------------------- |
| Backend        | 3003                      | 3004   | **3005**               |
| Frontend dev   | 5173                      | 5174   | **5175**               |
| Postgres       | 5432                      | 5433   | **5434**               |
| Redis          | 6379                      | 6380   | **6381**               |
| AI Service     | 8000 (shared with MERT-M) | 8000   | **8001**               |
| Docker project | greekfoods                | mertm  | **greekquality**       |
