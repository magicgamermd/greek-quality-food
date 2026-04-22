# МЕРТ-М Telegram Bot Tester — Design Spec (v0.1.0)

**Date:** 2026-04-22
**Predecessor:** v0.3.0-telegram (Telegram agent + /chat)
**Goal:** Автономен "conversational tester" — LLM агент, който говори с `@mertm_sklad_bot` през истинска Telegram user session, изпълнява сценарии, записва transcript-а и вади rich verdict ("какво не работи, какво е frustrating, какви са bugs"). Output-ът е основа за следващия цикъл — подобрения на самия бот.

---

## 1. Problem

`telegram-bot/bot.js` е 2227 реда с много "живи" интеграции (Whisper voice, SMTP/IMAP email, Econt waybill, cron jobs, /chat-driven tool calls). Ръчно тестване на цял flow е скъпо време и не е systematic. Нужен е начин:

- **Да откриваме къде потребителското преживяване дъни** без да чакаме обаждане от склада
- **Да измерваме "колко добре работи" един flow** — goal achievement rate, turns-to-completion, frustrations
- **Да имаме артефакти** (transcripts, verdict-и) за всеки опит → постоянна основа за следващи подобрения

Това не е обикновен integration test — искаме UX/flow критика, не assertion-и.

---

## 2. Architecture

```
┌──────────────────────┐
│  telegram-bot-tester │     (нова директория, TypeScript + ESM)
│  ────────────────    │
│                      │
│  ┌────────────────┐  │
│  │ scenario loader│  │  ← чете scenarios/*.yaml (Zod)
│  └───────┬────────┘  │
│          │           │
│  ┌───────▼────────┐  │
│  │    runner      │  │  ← за всеки scenario: actor ↔ telegram ↔ judge
│  └───┬────────┬───┘  │
│      │        │      │
│      ▼        ▼      │
│  ┌─────┐  ┌──────┐   │
│  │actor│  │judge │   │
│  │Haiku│  │Sonnet│   │  ← Anthropic SDK, tool-calling actor
│  └──┬──┘  └──────┘   │
│     │                │
│     │ tools:         │
│     │  send_message  │
│     │  read_latest   │
│     │  give_up       │
│     │  goal_achieved │
│     │                │
│  ┌──▼──────────┐     │
│  │ GramJS user │     │  ← MTProto client, чат с @mertm_sklad_bot
│  │   session   │     │
│  └──────┬──────┘     │
└─────────┼────────────┘
          │ Telegram API
          ▼
┌────────────────────┐
│  @mertm_sklad_bot  │  ← реалният бот (bot.js, непроменен освен /reset)
└─────────┬──────────┘
          │
          ▼
┌────────────────────────────┐
│  warehouse-backend /chat   │  ← текущата тестова среда
└────────────────────────────┘

Output:
  telegram-bot-tester/reports/
    2026-04-22-143000.json        ← truth (машинно четимо)
    2026-04-22-143000.md          ← derived (за преглед)
```

### Data flow на един сценарий

1. Runner зарежда `scenario.yaml` + свързаната `persona.yaml`
2. Runner изпраща `/reset` през GramJS (чисти bot state за тестер user-а)
3. Actor LLM (Haiku 4.5) получава system prompt = persona + goal + criteria; влиза в loop:
   - Actor избира tool (`send_message` / `read_latest_reply` / `goal_achieved` / `give_up`)
   - Runner изпълнява tool → Telegram → получава reply → връща към actor
   - Цикълът продължава докато: `goal_achieved`, `give_up`, или `max_turns`
4. Целият transcript се подава на Judge (Sonnet 4.6) → rich verdict JSON
5. Reporter добавя verdict към run-level JSON; накрая генерира derived markdown

### Key design choices

| #   | Решение                                   | Обосновка                                              |
| --- | ----------------------------------------- | ------------------------------------------------------ |
| 1   | Hybrid тестер (scripted goals, LLM actor) | Баланс между coverage и realism                        |
| 2   | Истински Telegram (MTProto user session)  | Тества целия stack — Telegram API, polling, клавиатури |
| 3   | TypeScript + GramJS                       | Типизирано, остава в Node екосистемата                 |
| 4   | Haiku actor + Sonnet judge                | Евтин realism + сериозна оценка                        |
| 5   | YAML scenarios                            | Не-кодово, git-friendly, Zod-валидирано                |
| 6   | 2 persona-и (manager, new-employee)       | Покрива 80% от реалността                              |
| 7   | Rich verdict JSON + derived markdown      | Actionable findings за следващ цикъл                   |
| 8   | Ad-hoc CLI (не cron/CI за V1)             | Прост старт, cron в V1.1                               |
| 9   | Sequential, `/reset` между сценарии       | Прост, лесен за debug, без Telegram rate issues        |
| 10  | Tool-calling actor loop                   | По-близо до истински agent feel                        |

---

## 3. Modules + interfaces

Всеки модул е един файл с една отговорност. Граници подредени да могат да се тестват изолирано.

| Модул             | Файл                       | Отговорност                                                           |
| ----------------- | -------------------------- | --------------------------------------------------------------------- |
| Entry/CLI         | `src/cli.ts`               | Парсва `--scenario=<id>`, `--all`, `--persona=<id>`, извиква runner   |
| Scenario loader   | `src/scenarios.ts`         | Чете `scenarios/*.yaml`, валидира с Zod, резолвира persona            |
| Persona loader    | `src/personas.ts`          | Чете `personas/*.yaml`, валидира с Zod                                |
| Telegram client   | `src/telegram/client.ts`   | GramJS wrapper — `sendMessage`, `waitForReply`, `reset`               |
| Actor             | `src/actor/actor.ts`       | LLM tool-calling loop                                                 |
| Actor tools       | `src/actor/tools.ts`       | 4-те tool schemas + изпълнение                                        |
| Actor prompt      | `src/actor/prompt.ts`      | System prompt template (persona + goal)                               |
| Judge             | `src/judge/judge.ts`       | Един Sonnet call: transcript + scenario → Verdict                     |
| Judge prompt      | `src/judge/prompt.ts`      | System prompt за judge-а                                              |
| Runner            | `src/runner.ts`            | Оркестрира reset → actor → judge → reporter                           |
| Reporter          | `src/reporter/reporter.ts` | Писане на JSON report                                                 |
| Markdown renderer | `src/reporter/markdown.ts` | JSON → markdown (derived)                                             |
| Logger            | `src/logger.ts`            | Structured logs към stdout + `logs/<timestamp>.log`                   |
| Config            | `src/config.ts`            | Зарежда `.env` с Zod validation                                       |
| Types             | `src/types.ts`             | Shared Zod schemas: Scenario, Persona, Transcript, Verdict, RunReport |

### Interface: TelegramClient

```typescript
export interface TelegramClient {
  start(): Promise<void>; // логва се с API_ID/API_HASH/phone
  sendMessage(text: string): Promise<void>;
  waitForReply(opts?: {
    timeoutMs?: number;
  }): Promise<{ text: string; receivedAt: Date }>;
  reset(): Promise<void>; // изпраща "/reset" към бота
  stop(): Promise<void>;
}
```

### Interface: Actor

```typescript
export interface ActorResult {
  transcript: TranscriptTurn[];
  endedBy: "goal_achieved" | "give_up" | "max_turns" | "error";
  endReason?: string;
  turnsUsed: number;
  costUsd: number;
}

export async function runActor(
  scenario: Scenario,
  persona: Persona,
  tg: TelegramClient,
  anthropic: Anthropic,
  opts: { maxTurns: number; perTurnTimeoutMs: number },
): Promise<ActorResult>;
```

### Actor tool definitions (Anthropic tool-calling)

```typescript
[
  {
    name: "send_message",
    description: "Изпрати текстово съобщение към бота",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "read_latest_reply",
    description:
      "Прочети последния отговор на бота (ако все още не си го видял)",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "goal_achieved",
    description: "Обяви че целта е постигната. Подай кратко резюме.",
    input_schema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    },
  },
  {
    name: "give_up",
    description: "Откажи се. Обясни защо.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
];
```

---

## 4. Data contracts

Всички schema-и са Zod в `src/types.ts`, валидират се при зареждане.

### `scenarios/<id>.yaml`

```yaml
id: create-order-dominos # uniq, matches filename stem
title: Поръчка към Доминос с 3 фритюрника
category: orders # orders | invoices | econt | inventory | voice | error-handling
persona: warehouse-manager # id от personas/
goal: |
  Създай поръчка за "Пицария Домино Бургас" с 3 броя HD-42,
  доставка за утре. Завърши когато имаш номер на поръчка.
success_criteria:
  - Ботът потвърждава създадена поръчка с номер
  - Общата сума се показва (3 × цена + ДДС)
  - Поръчката е в статус "pending"
forbidden_behaviors:
  - Ботът да пита 2 пъти за същото
  - Ботът да поиска SQL/technical параметри
max_turns: 12 # override на default
initial_bot_command: /start # преди actor-а
tags: [smoke, critical-path]
```

### `personas/<id>.yaml`

```yaml
id: warehouse-manager
name: Валери-тестер
description: |
  Опитен складов мениджър, 40г. Ползва бота всекидневно.
  Знае жаргона (SKU, ЕИК, товарителница). Нетърпелив към излишни въпроси.
style:
  verbosity: short # short | medium | verbose
  tone: casual # casual | formal | terse
  typos: sometimes # never | sometimes | often
  emoji: rare # never | rare | frequent
example_utterances:
  - "пусни товарителница за поръчка 23"
  - "кво стане с 24"
  - "фактурирай 25 и прати на info@dominos.bg"
```

### Transcript

```typescript
type TranscriptTurn =
  | { kind: "actor_thought"; at: string; content: string }
  | { kind: "actor_tool_call"; at: string; tool: string; args: unknown }
  | { kind: "sent_to_bot"; at: string; text: string }
  | { kind: "bot_reply"; at: string; text: string; messageId: number }
  | { kind: "timeout"; at: string; waitedMs: number }
  | { kind: "error"; at: string; error: string };
```

### Verdict

```typescript
type Verdict = {
  goal_achieved: "yes" | "no" | "partial";
  turns_used: number;
  criteria: Array<{ text: string; met: boolean; evidence: string }>;
  frustrations: string[];
  confusions: string[];
  bot_bugs: string[];
  ux_suggestions: string[];
  forbidden_violations: string[];
  overall_severity: "none" | "minor" | "major" | "blocker";
  quotes: Array<{ turn: number; text: string; comment: string }>;
  summary: string;
};
```

### RunReport

```typescript
type RunReport = {
  runId: string; // ISO timestamp
  startedAt: string;
  finishedAt: string;
  totalCostUsd: number;
  scenarios: Array<{
    scenarioId: string;
    personaId: string;
    endedBy: "goal_achieved" | "give_up" | "max_turns" | "error";
    turnsUsed: number;
    costUsd: number;
    transcript: TranscriptTurn[];
    verdict: Verdict;
  }>;
  summary: {
    total: number;
    passed: number;
    partial: number;
    failed: number;
    topFrustrations: Array<{ text: string; count: number }>;
    topBotBugs: Array<{ text: string; count: number }>;
  };
};
```

### Derived markdown `reports/<timestamp>.md`

Генерира се от JSON-а. Съдържа:

- Executive summary (X/Y passed, топ 3 frustrations, топ 3 bugs)
- Таблица per scenario: id | persona | endedBy | turns | severity | 1-ред summary
- Detail секция за всеки scenario със severity ≥ `minor` (transcript + verdict body)

---

## 5. Directory structure

```
telegram-bot-tester/
├── .env                              # local, gitignored
├── .env.example                      # committed
├── .gitignore
├── package.json
├── tsconfig.json
├── README.md
│
├── src/
│   ├── cli.ts
│   ├── runner.ts
│   ├── config.ts
│   ├── types.ts
│   ├── logger.ts
│   ├── scenarios.ts
│   ├── personas.ts
│   ├── telegram/
│   │   ├── client.ts
│   │   └── session.ts
│   ├── actor/
│   │   ├── actor.ts
│   │   ├── tools.ts
│   │   └── prompt.ts
│   ├── judge/
│   │   ├── judge.ts
│   │   └── prompt.ts
│   └── reporter/
│       ├── reporter.ts
│       └── markdown.ts
│
├── scenarios/
│   ├── 00-hello.yaml                 # smoke test (/start → меню)
│   ├── 01-create-order-dominos.yaml
│   ├── 02-generate-invoice.yaml
│   ├── 03-create-econt-waybill.yaml
│   ├── 04-send-invoice-email.yaml
│   └── 05-inventory-query.yaml
│
├── personas/
│   ├── warehouse-manager.yaml
│   └── new-employee.yaml
│
├── reports/                           # gitignored (.gitkeep committed)
├── logs/                              # gitignored
├── session/                           # gitignored — GramJS session string
│
└── tests/
    ├── scenario-loader.test.ts
    ├── persona-loader.test.ts
    ├── judge-prompt.test.ts
    ├── reporter.test.ts
    ├── markdown.test.ts
    ├── actor-tools.test.ts
    ├── config.test.ts
    ├── cost.test.ts
    ├── runner.test.ts                 # integration, mocked Telegram + Anthropic
    └── fixtures/
        ├── sample-transcript.json
        └── sample-verdict.json
```

### Промени в други части на repo-то

1. `telegram-bot/bot.js` — един нов handler:
   ```javascript
   bot.onText(/^\/reset$/, async (msg) => {
     const userId = msg.from.id;
     if (!isAllowed(userId)) return;
     userHistories.delete(userId);
     delete userState[userId];
     lastInvoicePerUser.delete(userId);
     await bot.sendMessage(msg.chat.id, "✅ State изчистено.");
   });
   ```
2. Root `.gitignore` — добавки:
   ```
   telegram-bot-tester/.env
   telegram-bot-tester/node_modules
   telegram-bot-tester/reports/*.json
   telegram-bot-tester/reports/*.md
   telegram-bot-tester/logs/
   telegram-bot-tester/session/
   ```
   (Не ignore-ваме `.gitkeep` файловете — те държат празни директории в git.)
3. Root `CLAUDE.md` — нов service в "Services" секцията.

### package.json scripts

```json
{
  "scripts": {
    "build": "tsc --noEmit",
    "tester": "tsx src/cli.ts",
    "tester:login": "tsx src/cli.ts --login",
    "test": "vitest run"
  }
}
```

### Ключови зависимости

- `telegram` (GramJS) — MTProto client
- `@anthropic-ai/sdk` — LLM
- `zod` + `yaml` — schema + parsing
- Dev: `tsx`, `typescript`, `vitest`

---

## 6. Error handling + constraints

### Defaults

| Параметър             | Default        | Override                             |
| --------------------- | -------------- | ------------------------------------ |
| `MAX_TURNS`           | 12             | scenario YAML `max_turns` или `.env` |
| `PER_TURN_TIMEOUT_MS` | 60000          | `.env`                               |
| `SCENARIO_TIMEOUT_MS` | 300000 (5 min) | `.env`                               |
| `COST_CAP_USD`        | 5.00 per run   | `.env`                               |
| `MAX_CONCURRENCY`     | 1              | CLI флаг (планиран за V1.1)          |

### Error paths

1. **Bot timeout** → transcript добавя `{ kind: "timeout" }`, actor получава "Ботът не отговори. Какво правиш?" и може да `give_up`
2. **GramJS disconnect/flood wait** → exponential backoff (1s, 2s, 4s, max 30s, 5 attempts). Ако продължава — fail + partial report.
3. **Actor вика невалиден tool** → error в tool result → LLM поправя сам. 3 поредни грешки → `endedBy: "error"`.
4. **Max turns exceeded** → judge оценява дали goal е бил постижим; `endedBy: "max_turns"`.
5. **Judge malformed JSON** → retry 1 път с по-строг prompt. Failure → placeholder verdict `{ goal_achieved: "error", summary: "Judge failed" }`, markdown маркира червено.
6. **Anthropic 429/500** → exponential backoff 3 опита → fail-ва scenario (не run-а).
7. **SIGINT (Ctrl+C)** → partial JSON + markdown се записват от вече завършени scenario-и.
8. **.env / session грешки при старт** → Zod validation, ясна грешка, `exit 1`.

### Cost tracking

- След всеки Anthropic call: `response.usage.input_tokens + output_tokens × pricing`
- Pricing table hardcoded в `src/config.ts` (2026 актуално)
- Runner проверява `totalCostUsd >= COST_CAP_USD` след всеки scenario → спира, пише partial report
- Cost присъства в `RunReport.totalCostUsd` + markdown summary

### Production safety (V1 note)

Текущата среда е тестова → приемаме риск.

**Преди production deploy** — sandbox switch за destructive tools (`generate_invoice`, `create_econt_shipment`, `send_invoice_email`): флаг в bot.js / backend, който връща fake success без да пише в DB / да чука external API. Това ще е отделен spec за V1.1 или за milestone v0.4.0.

---

## 7. Testing strategy

### Unit tests (vitest)

| Test                      | Проверява                                                                     |
| ------------------------- | ----------------------------------------------------------------------------- |
| `scenario-loader.test.ts` | Валиден YAML → Scenario; невалиден → ясна грешка                              |
| `persona-loader.test.ts`  | Персони + enum validation                                                     |
| `judge-prompt.test.ts`    | Fixture transcript + scenario → очакваният prompt съдържа goal/criteria/turns |
| `reporter.test.ts`        | JSON структура + ISO timestamp в filename                                     |
| `markdown.test.ts`        | Snapshot: fixture JSON → очакван markdown                                     |
| `actor-tools.test.ts`     | 4-те tool schemas валидират input                                             |
| `config.test.ts`          | Липсващ `API_ID` → грешка                                                     |
| `cost.test.ts`            | Haiku/Sonnet usage → правилен USD                                             |

### Integration

`runner.test.ts` — цял scenario lifecycle с mocked TelegramClient (in-memory) + mocked Anthropic (stub responses). Verify: reset called, actor turns execute, judge called, report file се пише, transcript е правилен.

### Smoke test (manual)

`docs/smoke-test.md`:

1. `npm run tester:login` → phone + code → session записан
2. `npm run tester -- --scenario=00-hello`
3. Verify: `reports/<timestamp>.json` съществува, `verdict.goal_achieved === "yes"`, cost < $0.10

### Pre-commit

- `tsc --noEmit`
- `vitest run`

### Не-автоматизирано

- Качество на actor/judge prompt-ите → human review на първите 5-10 run-а
- Реална GramJS връзка → manual smoke

---

## 8. Success criteria

V1 "приключен" когато:

1. `npm install && npm run tester:login` работи (phone + code → session saved).
2. `scenarios/00-hello.yaml` (actor прати `/start`, очаква меню) → pass, cost < $0.10.
3. `scenarios/01-create-order-dominos.yaml` → actor създава реална поръчка, judge дава rich verdict, markdown е actionable.
4. Минимум **5 сценария** написани (orders, invoices, econt, inventory, error-handling).
5. Human review на markdown — ясно кой passed, какви frustrations/bugs, без да е нужно JSON.
6. Един пълен run (5 сценария) < $1.
7. Runner не crash-ва при bot timeout / LLM rate limit / Ctrl+C — във всички записва partial report.
8. Всички unit + integration тестове минават.
9. README обяснява setup + как се пише нов сценарий (3-стъпков guide).
10. Промяната в `telegram-bot/bot.js` е само `/reset` handler — ревертбилно.

### Out of scope за V1

- Паралелни сценарии (V1.1)
- Cron автоматизация (V1.1)
- GitHub Actions CI (V2)
- Web dashboard (V2)
- Voice/photo симулация (V2)
- Multi-language (само бг)
- Persistent memory/learning за actor между run-ове

---

## 9. Risks + mitigations

| Risk                                                   | Impact                    | Mitigation                                                                                                                           |
| ------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| GramJS MTProto auth / 2FA / flood wait при първи login | Blocker                   | Login е еднократен ръчен stage. Ясна грешка + troubleshooting в README. Session reuse → няма повторно auth.                          |
| Actor "cheats" — `goal_achieved` без реално постигане  | False positives           | Judge е independent; actor-а връщане е само hint, judge решава.                                                                      |
| Judge "прощава" проблеми                               | False negatives           | Judge prompt е агресивен ("ти си UX одитор; всяко двойно питане, 500 грешка или объркване е проблем"). Human review на първите runs. |
| Destructive tools пълнят test DB с боклук              | DB расте, номерация скача | V1 приемаме. V1.1: `[QA-]` prefix в actor съобщения + cleanup script.                                                                |
| Cost runaway (безкраен loop)                           | Скъп run                  | `MAX_TURNS=12` hard limit; `COST_CAP_USD=5`; runner спира.                                                                           |
| Telegram "Too Many Requests"                           | Тестерът блокиран         | Sequential V1, 2s sleep между сценарии, user account → меки rate limits.                                                             |
| `/reset` конфликтира с `/clear`                        | Объркване                 | `/reset` е superset (history + userState + lastInvoicePerUser). `/clear` остава за потребители.                                      |
| Scenario YAMLs се разминават със бот                   | Verdicts нерелевантни     | Git versioning; при промяна на бота сверяваме scenarios. Пиши сценарии от реални use cases.                                          |

---

## 10. Next steps

1. След одобрение на този spec → `writing-plans` skill за implementation plan.
2. Planът ще бъде task-by-task checklist с test-first подход (unit tests → interface → integration).
3. Очакван milestone: `v0.3.1-tester` (не bumped-ва основна версия — инструмент, не feature в бота).
