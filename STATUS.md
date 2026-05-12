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
- [ ] Лого/favicon на Greek Foods (копиране от `/Users/magic/Projects/greek-foods-platform/warehouse-frontend/public/`)
- [ ] Връщане на партиди (batches): миграция + routes + UI от Greek Foods
- [ ] Връщане на бракуване (writeoffs): миграция + routes + UI от Greek Foods
- [ ] Връщане на срокове на годност (FEFO): свързано с партидите
- [ ] Verify partner objects/sites (обекти/магазини) UI works
- [ ] Миграция на данни от Greek Foods DB: партньори, доставчици, продукти
- [ ] Smoke test: docker compose up без конфликти с оригиналите

## Ports cheat sheet

| Service        | Greek Foods | MERT-M | **Greek Quality Food** |
| -------------- | ----------- | ------ | ---------------------- |
| Backend        | 3003        | 3004   | **3005**               |
| Frontend dev   | 5173        | 5174   | **5175**               |
| Postgres       | 5432        | 5433   | **5434**               |
| Redis          | 6379        | 6380   | **6381**               |
| Docker project | greekfoods  | mertm  | **greekquality**       |
