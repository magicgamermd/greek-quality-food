# МЕРТ-М Telegram Bot Tester

Автономен "conversational tester" — чати с `@mertm_sklad_bot` от реална Telegram user session, изпълнява сценарии, вади rich verdict-и.

## Бърз старт

### 1. Инсталирай зависимости

```bash
cd telegram-bot-tester
npm install
```

### 2. Попълни `.env`

Копирай `.env.example` в `.env` и попълни:

- `TG_API_ID`, `TG_API_HASH` — от https://my.telegram.org/apps
- `TG_PHONE` — телефонен номер на **втория** Telegram акаунт (не админски)
- `TG_BOT_USERNAME` — без @ (напр. `mertm_sklad_bot`)
- `ANTHROPIC_API_KEY` — от console.anthropic.com

### 3. Еднократно вписване (login)

```bash
npm run tester:login
```

Ще те попита за Telegram code (идва SMS/в Telegram на втория акаунт) и опционално 2FA парола. След успех, session се записва в `session/tester.session`.

### 4. Пускай сценарии

Един сценарий:

```bash
npm run tester -- --scenario=00-hello
```

Всички:

```bash
npm run tester -- --all
```

Само за конкретна persona:

```bash
npm run tester -- --all --persona=warehouse-manager
```

### 5. Виж резултатите

```
reports/2026-04-22T14-30-00.md      # за преглед
reports/2026-04-22T14-30-00.json    # машинно четимо
```

## Как се пише нов сценарий

Създай `scenarios/<id>.yaml`:

```yaml
id: my-new-scenario
title: Какво тества
category: orders # orders|invoices|econt|inventory|voice|error-handling
persona: warehouse-manager # или new-employee
goal: |
  Многоредов текст с конкретната цел на actor-а.
success_criteria:
  - Критерий 1 (обективен, проверим)
  - Критерий 2
forbidden_behaviors:
  - Какво бот-ът НЕ трябва да прави (по желание)
max_turns: 10 # по желание, default 12
tags: [smoke]
```

Пускай го: `npm run tester -- --scenario=my-new-scenario`

## Как се пише нова persona

Създай `personas/<id>.yaml` по образа на `warehouse-manager.yaml`.

## Архитектура

- `src/cli.ts` — entry
- `src/runner.ts` — orchestrator
- `src/telegram/client.ts` — GramJS wrapper
- `src/actor/` — tool-calling LLM actor (Haiku)
- `src/judge/` — Sonnet judge
- `src/reporter/` — JSON + markdown output

Виж `docs/superpowers/specs/2026-04-22-telegram-bot-tester-design.md` за детайлите.

## Тестове

```bash
npm test
```

## Ограничения (V1)

- Speaks с current тестовия warehouse-backend директно (destructive tools създават реални данни). Преди production → sandbox switch.
- Sequential scenarios (няма parallelism).
- Няма cron/CI — само ad-hoc.
- Текст само (voice/photo в V2).

## Troubleshooting

**"No saved session. Run `npm run tester:login` first."** — не си се логнал.

**"PHONE_CODE_INVALID"** — грешен Telegram code, опитай пак с нов.

**"FLOOD_WAIT_X"** — Telegram rate-limit. Изчакай X секунди.

**Judge връща error verdict** — виж `logs/<runId>.log` за детайли; transcript-а е запазен в JSON-а за ръчен преглед.
