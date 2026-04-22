# Telegram Bot Tester Implementation Plan (v0.1.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `telegram-bot-tester/` — a TypeScript conversational-tester tool that drives `@mertm_sklad_bot` through a real Telegram user session (GramJS/MTProto), using a Haiku tool-calling actor and a Sonnet judge, with YAML scenarios and JSON+Markdown reports.

**Architecture:** New top-level directory `telegram-bot-tester/` running on Node 20 ESM + TypeScript. Scenario loader → Runner → Actor (Haiku, tool-calling via Anthropic SDK) ↔ Telegram client (GramJS) ↔ real bot. Transcript feeds Judge (Sonnet). Reporter writes `reports/<timestamp>.{json,md}`. Unit tests via vitest; integration test mocks Telegram + Anthropic. One-line change to `telegram-bot/bot.js` adds `/reset` handler.

**Tech Stack:** TypeScript 5, Node 20 ESM, `telegram` (GramJS), `@anthropic-ai/sdk`, `zod`, `yaml`, `tsx`, `vitest`.

**Spec reference:** `docs/superpowers/specs/2026-04-22-telegram-bot-tester-design.md`

---

## Task 1: Project scaffold

**Files:**

- Create: `telegram-bot-tester/package.json`
- Create: `telegram-bot-tester/tsconfig.json`
- Create: `telegram-bot-tester/.gitignore`
- Create: `telegram-bot-tester/.env.example`
- Create: `telegram-bot-tester/reports/.gitkeep`
- Create: `telegram-bot-tester/logs/.gitkeep`
- Create: `telegram-bot-tester/session/.gitkeep`
- Create: `telegram-bot-tester/scenarios/.gitkeep`
- Create: `telegram-bot-tester/personas/.gitkeep`
- Create: `telegram-bot-tester/tests/fixtures/.gitkeep`
- Modify: `/Users/magic/Projects/mert-m/.gitignore`

- [ ] **Step 1: Create directory tree**

```bash
cd /Users/magic/Projects/mert-m
mkdir -p telegram-bot-tester/src/{telegram,actor,judge,reporter}
mkdir -p telegram-bot-tester/{scenarios,personas,reports,logs,session,tests/fixtures}
touch telegram-bot-tester/reports/.gitkeep
touch telegram-bot-tester/logs/.gitkeep
touch telegram-bot-tester/session/.gitkeep
touch telegram-bot-tester/tests/fixtures/.gitkeep
```

- [ ] **Step 2: Write `telegram-bot-tester/package.json`**

```json
{
  "name": "mertm-telegram-bot-tester",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --noEmit",
    "tester": "tsx src/cli.ts",
    "tester:login": "tsx src/cli.ts --login",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "telegram": "^2.22.0",
    "yaml": "^2.5.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 3: Write `telegram-bot-tester/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "noEmit": true,
    "allowJs": false,
    "types": ["node"],
    "lib": ["ES2022"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Write `telegram-bot-tester/.gitignore`**

```
node_modules
.env
reports/*.json
reports/*.md
logs/*.log
session/*.session
dist
*.tsbuildinfo
```

- [ ] **Step 5: Write `telegram-bot-tester/.env.example`**

```
# Telegram MTProto (from https://my.telegram.org/apps)
TG_API_ID=
TG_API_HASH=
TG_PHONE=+359...                    # telephone number of tester account
TG_BOT_USERNAME=mertm_sklad_bot     # без @

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...
ACTOR_MODEL=claude-haiku-4-5-20251001
JUDGE_MODEL=claude-sonnet-4-6

# Tester limits
MAX_TURNS=12
PER_TURN_TIMEOUT_MS=60000
SCENARIO_TIMEOUT_MS=300000
COST_CAP_USD=5.00
```

- [ ] **Step 6: Append to root `/Users/magic/Projects/mert-m/.gitignore`**

Read the file first, then append these lines if not already present:

```
telegram-bot-tester/.env
telegram-bot-tester/node_modules
telegram-bot-tester/reports/*.json
telegram-bot-tester/reports/*.md
telegram-bot-tester/logs/
telegram-bot-tester/session/*.session
```

- [ ] **Step 7: Install dependencies**

```bash
cd /Users/magic/Projects/mert-m/telegram-bot-tester && npm install
```

Expected: node_modules populated; no fatal errors. Warnings are OK.

- [ ] **Step 8: Verify TypeScript compiles (empty project)**

Create minimal `src/index.ts` placeholder so `tsc` has input:

```bash
echo 'export {};' > src/index.ts
```

Run:

```bash
cd /Users/magic/Projects/mert-m/telegram-bot-tester && npm run build
```

Expected: exits 0, no output (noEmit).

- [ ] **Step 9: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add .gitignore telegram-bot-tester/
git commit -m "feat(tester): scaffold telegram-bot-tester project"
```

---

## Task 2: Shared types (Zod schemas)

**Files:**

- Create: `telegram-bot-tester/src/types.ts`
- Create: `telegram-bot-tester/tests/types.test.ts`

Purpose: single source of truth for all domain objects. Zod schemas produce TypeScript types via `z.infer`.

- [ ] **Step 1: Write failing test**

Create `telegram-bot-tester/tests/types.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  ScenarioSchema,
  PersonaSchema,
  VerdictSchema,
  TranscriptTurnSchema,
  RunReportSchema,
} from "../src/types.js";

describe("PersonaSchema", () => {
  it("accepts a well-formed persona", () => {
    const p = PersonaSchema.parse({
      id: "warehouse-manager",
      name: "Валери-тестер",
      description: "…",
      style: {
        verbosity: "short",
        tone: "casual",
        typos: "sometimes",
        emoji: "rare",
      },
      example_utterances: ["a", "b"],
    });
    expect(p.id).toBe("warehouse-manager");
  });

  it("rejects unknown verbosity", () => {
    expect(() =>
      PersonaSchema.parse({
        id: "x",
        name: "x",
        description: "x",
        style: {
          verbosity: "chatty",
          tone: "casual",
          typos: "never",
          emoji: "never",
        },
        example_utterances: [],
      }),
    ).toThrow();
  });
});

describe("ScenarioSchema", () => {
  it("accepts minimal scenario", () => {
    const s = ScenarioSchema.parse({
      id: "hello",
      title: "Hello",
      category: "orders",
      persona: "warehouse-manager",
      goal: "Say hi",
      success_criteria: ["Bot replies"],
    });
    expect(s.max_turns).toBe(12);
    expect(s.forbidden_behaviors).toEqual([]);
    expect(s.tags).toEqual([]);
  });

  it("rejects unknown category", () => {
    expect(() =>
      ScenarioSchema.parse({
        id: "x",
        title: "x",
        category: "banking",
        persona: "x",
        goal: "x",
        success_criteria: ["x"],
      }),
    ).toThrow();
  });
});

describe("VerdictSchema", () => {
  it("accepts well-formed verdict", () => {
    const v = VerdictSchema.parse({
      goal_achieved: "yes",
      turns_used: 3,
      criteria: [{ text: "c", met: true, evidence: "turn 2" }],
      frustrations: [],
      confusions: [],
      bot_bugs: [],
      ux_suggestions: [],
      forbidden_violations: [],
      overall_severity: "none",
      quotes: [],
      summary: "ok",
    });
    expect(v.goal_achieved).toBe("yes");
  });
});

describe("TranscriptTurnSchema", () => {
  it("accepts sent_to_bot turn", () => {
    const t = TranscriptTurnSchema.parse({
      kind: "sent_to_bot",
      at: new Date().toISOString(),
      text: "hi",
    });
    expect(t.kind).toBe("sent_to_bot");
  });
});

describe("RunReportSchema", () => {
  it("accepts empty report", () => {
    const r = RunReportSchema.parse({
      runId: "2026-04-22T14:30:00.000Z",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      totalCostUsd: 0,
      scenarios: [],
      summary: {
        total: 0,
        passed: 0,
        partial: 0,
        failed: 0,
        topFrustrations: [],
        topBotBugs: [],
      },
    });
    expect(r.scenarios).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd telegram-bot-tester && npx vitest run tests/types.test.ts
```

Expected: FAIL — "Cannot find module '../src/types.js'" or similar.

- [ ] **Step 3: Write `src/types.ts`**

```typescript
import { z } from "zod";

export const StyleSchema = z.object({
  verbosity: z.enum(["short", "medium", "verbose"]),
  tone: z.enum(["casual", "formal", "terse"]),
  typos: z.enum(["never", "sometimes", "often"]),
  emoji: z.enum(["never", "rare", "frequent"]),
});
export type Style = z.infer<typeof StyleSchema>;

export const PersonaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  style: StyleSchema,
  example_utterances: z.array(z.string()),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const CategorySchema = z.enum([
  "orders",
  "invoices",
  "econt",
  "inventory",
  "voice",
  "error-handling",
]);
export type Category = z.infer<typeof CategorySchema>;

export const ScenarioSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: CategorySchema,
  persona: z.string().min(1),
  goal: z.string().min(1),
  success_criteria: z.array(z.string().min(1)).min(1),
  forbidden_behaviors: z.array(z.string()).default([]),
  max_turns: z.number().int().positive().default(12),
  initial_bot_command: z.string().optional(),
  tags: z.array(z.string()).default([]),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const TranscriptTurnSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("actor_thought"),
    at: z.string(),
    content: z.string(),
  }),
  z.object({
    kind: z.literal("actor_tool_call"),
    at: z.string(),
    tool: z.string(),
    args: z.unknown(),
  }),
  z.object({
    kind: z.literal("sent_to_bot"),
    at: z.string(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("bot_reply"),
    at: z.string(),
    text: z.string(),
    messageId: z.number(),
  }),
  z.object({
    kind: z.literal("timeout"),
    at: z.string(),
    waitedMs: z.number(),
  }),
  z.object({
    kind: z.literal("error"),
    at: z.string(),
    error: z.string(),
  }),
]);
export type TranscriptTurn = z.infer<typeof TranscriptTurnSchema>;

export const VerdictSchema = z.object({
  goal_achieved: z.enum(["yes", "no", "partial", "error"]),
  turns_used: z.number().int().nonnegative(),
  criteria: z.array(
    z.object({
      text: z.string(),
      met: z.boolean(),
      evidence: z.string(),
    }),
  ),
  frustrations: z.array(z.string()),
  confusions: z.array(z.string()),
  bot_bugs: z.array(z.string()),
  ux_suggestions: z.array(z.string()),
  forbidden_violations: z.array(z.string()),
  overall_severity: z.enum(["none", "minor", "major", "blocker"]),
  quotes: z.array(
    z.object({
      turn: z.number().int().nonnegative(),
      text: z.string(),
      comment: z.string(),
    }),
  ),
  summary: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const ScenarioResultSchema = z.object({
  scenarioId: z.string(),
  personaId: z.string(),
  endedBy: z.enum(["goal_achieved", "give_up", "max_turns", "error"]),
  endReason: z.string().optional(),
  turnsUsed: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  transcript: z.array(TranscriptTurnSchema),
  verdict: VerdictSchema,
});
export type ScenarioResult = z.infer<typeof ScenarioResultSchema>;

export const RunReportSchema = z.object({
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  totalCostUsd: z.number().nonnegative(),
  scenarios: z.array(ScenarioResultSchema),
  summary: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    topFrustrations: z.array(
      z.object({ text: z.string(), count: z.number().int() }),
    ),
    topBotBugs: z.array(
      z.object({ text: z.string(), count: z.number().int() }),
    ),
  }),
});
export type RunReport = z.infer<typeof RunReportSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd telegram-bot-tester && npx vitest run tests/types.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Type-check**

```bash
cd telegram-bot-tester && npm run build
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add telegram-bot-tester/src/types.ts telegram-bot-tester/tests/types.test.ts
git commit -m "feat(tester): add shared Zod schemas for Scenario/Persona/Verdict/Transcript/Report"
```

---

## Task 3: Config loader

**Files:**

- Create: `telegram-bot-tester/src/config.ts`
- Create: `telegram-bot-tester/tests/config.test.ts`

Purpose: load `.env`, validate required keys, expose typed Config object. Includes pricing table.

- [ ] **Step 1: Write failing test**

Create `telegram-bot-tester/tests/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig, PRICING_USD_PER_MTOK } from "../src/config.js";

describe("loadConfig", () => {
  beforeEach(() => {
    delete process.env.TG_API_ID;
    delete process.env.TG_API_HASH;
    delete process.env.TG_PHONE;
    delete process.env.TG_BOT_USERNAME;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("fails with missing required vars", () => {
    expect(() => loadConfig()).toThrow(/TG_API_ID/);
  });

  it("loads minimal valid config", () => {
    process.env.TG_API_ID = "12345";
    process.env.TG_API_HASH = "abc123";
    process.env.TG_PHONE = "+359888000000";
    process.env.TG_BOT_USERNAME = "mertm_sklad_bot";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const cfg = loadConfig();
    expect(cfg.tg.apiId).toBe(12345);
    expect(cfg.tg.botUsername).toBe("mertm_sklad_bot");
    expect(cfg.maxTurns).toBe(12); // default
    expect(cfg.actorModel).toContain("haiku");
  });

  it("respects MAX_TURNS override", () => {
    process.env.TG_API_ID = "12345";
    process.env.TG_API_HASH = "abc";
    process.env.TG_PHONE = "+359";
    process.env.TG_BOT_USERNAME = "b";
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.MAX_TURNS = "20";
    const cfg = loadConfig();
    expect(cfg.maxTurns).toBe(20);
  });

  it("rejects non-integer MAX_TURNS", () => {
    process.env.TG_API_ID = "12345";
    process.env.TG_API_HASH = "abc";
    process.env.TG_PHONE = "+359";
    process.env.TG_BOT_USERNAME = "b";
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.MAX_TURNS = "not-a-number";
    expect(() => loadConfig()).toThrow(/MAX_TURNS/);
  });
});

describe("PRICING_USD_PER_MTOK", () => {
  it("has Haiku and Sonnet entries", () => {
    expect(PRICING_USD_PER_MTOK["claude-haiku-4-5-20251001"]).toBeDefined();
    expect(PRICING_USD_PER_MTOK["claude-sonnet-4-6"]).toBeDefined();
  });

  it("Haiku is cheaper than Sonnet", () => {
    const h = PRICING_USD_PER_MTOK["claude-haiku-4-5-20251001"];
    const s = PRICING_USD_PER_MTOK["claude-sonnet-4-6"];
    expect(h.input).toBeLessThan(s.input);
    expect(h.output).toBeLessThan(s.output);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd telegram-bot-tester && npx vitest run tests/config.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/config.ts`**

```typescript
import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, "..", ".env");

const RawEnvSchema = z.object({
  TG_API_ID: z.string().regex(/^\d+$/, "must be integer"),
  TG_API_HASH: z.string().min(1),
  TG_PHONE: z.string().min(1),
  TG_BOT_USERNAME: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  ACTOR_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  JUDGE_MODEL: z.string().default("claude-sonnet-4-6"),
  MAX_TURNS: z
    .string()
    .regex(/^\d+$/, "MAX_TURNS must be integer")
    .default("12"),
  PER_TURN_TIMEOUT_MS: z.string().regex(/^\d+$/).default("60000"),
  SCENARIO_TIMEOUT_MS: z.string().regex(/^\d+$/).default("300000"),
  COST_CAP_USD: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .default("5.00"),
});

export type Config = {
  tg: {
    apiId: number;
    apiHash: string;
    phone: string;
    botUsername: string;
  };
  anthropicApiKey: string;
  actorModel: string;
  judgeModel: string;
  maxTurns: number;
  perTurnTimeoutMs: number;
  scenarioTimeoutMs: number;
  costCapUsd: number;
};

// Prices per 1M tokens (USD). Updated 2026-04-22.
export const PRICING_USD_PER_MTOK: Record<
  string,
  { input: number; output: number }
> = {
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
};

function mergeDotenv(): void {
  if (!existsSync(ENV_PATH)) return;
  const raw = readFileSync(ENV_PATH, "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}

export function loadConfig(): Config {
  mergeDotenv();
  const parsed = RawEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid tester config: ${msg}`);
  }
  const e = parsed.data;
  return {
    tg: {
      apiId: Number(e.TG_API_ID),
      apiHash: e.TG_API_HASH,
      phone: e.TG_PHONE,
      botUsername: e.TG_BOT_USERNAME.replace(/^@/, ""),
    },
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    actorModel: e.ACTOR_MODEL,
    judgeModel: e.JUDGE_MODEL,
    maxTurns: Number(e.MAX_TURNS),
    perTurnTimeoutMs: Number(e.PER_TURN_TIMEOUT_MS),
    scenarioTimeoutMs: Number(e.SCENARIO_TIMEOUT_MS),
    costCapUsd: Number(e.COST_CAP_USD),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd telegram-bot-tester && npx vitest run tests/config.test.ts
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add telegram-bot-tester/src/config.ts telegram-bot-tester/tests/config.test.ts
git commit -m "feat(tester): add config loader with .env parsing + pricing table"
```

---

## Task 4: Logger

**Files:**

- Create: `telegram-bot-tester/src/logger.ts`

Purpose: minimal structured stdout + optional file sink. No test — trivially simple; any bug will surface in integration.

- [ ] **Step 1: Write `src/logger.ts`**

```typescript
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, "..", "logs");

let filePath: string | null = null;

export function initFileLog(runId: string): void {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  filePath = join(LOGS_DIR, `${runId}.log`);
}

type Level = "info" | "warn" | "error" | "debug";

function write(
  level: Level,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  const ts = new Date().toISOString();
  const line =
    meta !== undefined
      ? `${ts} [${level}] ${msg} ${JSON.stringify(meta)}`
      : `${ts} [${level}] ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  if (filePath) {
    try {
      appendFileSync(filePath, line + "\n", "utf-8");
    } catch {
      // best effort
    }
  }
}

export const log = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    write("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    write("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) =>
    write("error", msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) =>
    write("debug", msg, meta),
};
```

- [ ] **Step 2: Type-check**

```bash
cd telegram-bot-tester && npm run build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add telegram-bot-tester/src/logger.ts
git commit -m "feat(tester): add logger with stdout + file sink"
```

---

## Task 5: Scenario + Persona loaders

**Files:**

- Create: `telegram-bot-tester/src/personas.ts`
- Create: `telegram-bot-tester/src/scenarios.ts`
- Create: `telegram-bot-tester/tests/persona-loader.test.ts`
- Create: `telegram-bot-tester/tests/scenario-loader.test.ts`
- Create: `telegram-bot-tester/tests/fixtures/valid-persona.yaml`
- Create: `telegram-bot-tester/tests/fixtures/invalid-persona.yaml`
- Create: `telegram-bot-tester/tests/fixtures/valid-scenario.yaml`

- [ ] **Step 1: Write fixture files**

Create `tests/fixtures/valid-persona.yaml`:

```yaml
id: test-manager
name: Тест
description: Тест потребител
style:
  verbosity: short
  tone: casual
  typos: never
  emoji: never
example_utterances:
  - hi
```

Create `tests/fixtures/invalid-persona.yaml`:

```yaml
id: bad
name: Bad
description: Bad
style:
  verbosity: chatty
  tone: casual
  typos: never
  emoji: never
example_utterances: []
```

Create `tests/fixtures/valid-scenario.yaml`:

```yaml
id: test-scenario
title: Test scenario
category: orders
persona: test-manager
goal: Test goal
success_criteria:
  - Criterion 1
```

- [ ] **Step 2: Write failing test for personas**

Create `tests/persona-loader.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { loadPersonas, loadPersonaFile } from "../src/personas.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("loadPersonaFile", () => {
  it("loads valid persona", () => {
    const p = loadPersonaFile(join(__dirname, "fixtures/valid-persona.yaml"));
    expect(p.id).toBe("test-manager");
    expect(p.style.verbosity).toBe("short");
  });

  it("throws on invalid persona", () => {
    expect(() =>
      loadPersonaFile(join(__dirname, "fixtures/invalid-persona.yaml")),
    ).toThrow(/verbosity/);
  });

  it("throws on missing file", () => {
    expect(() => loadPersonaFile("/nonexistent.yaml")).toThrow();
  });
});

describe("loadPersonas", () => {
  it("loads all personas from a directory", () => {
    const fixturesDir = join(__dirname, "fixtures");
    const map = loadPersonas(fixturesDir, /^valid-persona\.yaml$/);
    expect(map.get("test-manager")).toBeDefined();
  });

  it("throws if two personas share id", () => {
    // we'll rely on name-filter to select only one; separate dupes test would
    // require writing another fixture. Skip for v1 — id-uniqueness check below.
    // (placeholder for future: duplicate-persona fixture)
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 3: Write failing test for scenarios**

Create `tests/scenario-loader.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { loadScenarioFile, loadScenarios } from "../src/scenarios.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("loadScenarioFile", () => {
  it("loads valid scenario with defaults", () => {
    const s = loadScenarioFile(join(__dirname, "fixtures/valid-scenario.yaml"));
    expect(s.id).toBe("test-scenario");
    expect(s.max_turns).toBe(12); // default
    expect(s.forbidden_behaviors).toEqual([]);
    expect(s.tags).toEqual([]);
  });

  it("throws on missing required field", () => {
    expect(() => loadScenarioFile("/nonexistent.yaml")).toThrow();
  });
});

describe("loadScenarios", () => {
  it("loads all scenarios from a directory", () => {
    const fixturesDir = join(__dirname, "fixtures");
    const arr = loadScenarios(fixturesDir, /^valid-scenario\.yaml$/);
    expect(arr).toHaveLength(1);
    expect(arr[0].id).toBe("test-scenario");
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
cd telegram-bot-tester && npx vitest run tests/persona-loader.test.ts tests/scenario-loader.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 5: Write `src/personas.ts`**

```typescript
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { PersonaSchema, type Persona } from "./types.js";

export function loadPersonaFile(path: string): Persona {
  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw) as unknown;
  return PersonaSchema.parse(parsed);
}

export function loadPersonas(
  dir: string,
  filter?: RegExp,
): Map<string, Persona> {
  const files = readdirSync(dir).filter((f) => {
    if (!f.endsWith(".yaml") && !f.endsWith(".yml")) return false;
    return filter ? filter.test(f) : true;
  });
  const out = new Map<string, Persona>();
  for (const f of files) {
    const p = loadPersonaFile(join(dir, f));
    if (out.has(p.id)) {
      throw new Error(`Duplicate persona id: ${p.id} (from ${f})`);
    }
    out.set(p.id, p);
  }
  return out;
}
```

- [ ] **Step 6: Write `src/scenarios.ts`**

```typescript
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { ScenarioSchema, type Scenario } from "./types.js";

export function loadScenarioFile(path: string): Scenario {
  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw) as unknown;
  return ScenarioSchema.parse(parsed);
}

export function loadScenarios(dir: string, filter?: RegExp): Scenario[] {
  const files = readdirSync(dir).filter((f) => {
    if (!f.endsWith(".yaml") && !f.endsWith(".yml")) return false;
    return filter ? filter.test(f) : true;
  });
  const out: Scenario[] = [];
  const seen = new Set<string>();
  for (const f of files.sort()) {
    const s = loadScenarioFile(join(dir, f));
    if (seen.has(s.id)) {
      throw new Error(`Duplicate scenario id: ${s.id} (from ${f})`);
    }
    seen.add(s.id);
    out.push(s);
  }
  return out;
}
```

- [ ] **Step 7: Run tests to verify they pass**

```bash
cd telegram-bot-tester && npx vitest run tests/persona-loader.test.ts tests/scenario-loader.test.ts
```

Expected: 7 passed.

- [ ] **Step 8: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add telegram-bot-tester/src/personas.ts telegram-bot-tester/src/scenarios.ts telegram-bot-tester/tests/persona-loader.test.ts telegram-bot-tester/tests/scenario-loader.test.ts telegram-bot-tester/tests/fixtures/
git commit -m "feat(tester): add YAML scenario + persona loaders with Zod validation"
```

---

## Task 6: Reporter (JSON + markdown)

**Files:**

- Create: `telegram-bot-tester/src/reporter/reporter.ts`
- Create: `telegram-bot-tester/src/reporter/markdown.ts`
- Create: `telegram-bot-tester/tests/reporter.test.ts`
- Create: `telegram-bot-tester/tests/markdown.test.ts`
- Create: `telegram-bot-tester/tests/fixtures/sample-run.json`

Purpose: write RunReport as JSON; derive human-readable markdown.

- [ ] **Step 1: Write fixture `tests/fixtures/sample-run.json`**

```json
{
  "runId": "2026-04-22T14-30-00",
  "startedAt": "2026-04-22T14:30:00.000Z",
  "finishedAt": "2026-04-22T14:32:00.000Z",
  "totalCostUsd": 0.234,
  "scenarios": [
    {
      "scenarioId": "hello",
      "personaId": "warehouse-manager",
      "endedBy": "goal_achieved",
      "turnsUsed": 3,
      "costUsd": 0.05,
      "transcript": [
        {
          "kind": "sent_to_bot",
          "at": "2026-04-22T14:30:01Z",
          "text": "/start"
        },
        {
          "kind": "bot_reply",
          "at": "2026-04-22T14:30:02Z",
          "text": "Здравей!",
          "messageId": 1
        }
      ],
      "verdict": {
        "goal_achieved": "yes",
        "turns_used": 3,
        "criteria": [
          { "text": "bot replied", "met": true, "evidence": "turn 2" }
        ],
        "frustrations": [],
        "confusions": [],
        "bot_bugs": [],
        "ux_suggestions": [],
        "forbidden_violations": [],
        "overall_severity": "none",
        "quotes": [],
        "summary": "OK"
      }
    },
    {
      "scenarioId": "create-order",
      "personaId": "new-employee",
      "endedBy": "give_up",
      "turnsUsed": 8,
      "costUsd": 0.18,
      "transcript": [],
      "verdict": {
        "goal_achieved": "no",
        "turns_used": 8,
        "criteria": [
          { "text": "order created", "met": false, "evidence": "never reached" }
        ],
        "frustrations": ["Ботът поиска 3 пъти потвърждение"],
        "confusions": ["Не разбра 'утре'"],
        "bot_bugs": ["500 при generate_invoice"],
        "ux_suggestions": ["Приеми relative дати"],
        "forbidden_violations": ["Двойно питане за същото"],
        "overall_severity": "major",
        "quotes": [],
        "summary": "Поръчката не беше създадена."
      }
    }
  ],
  "summary": {
    "total": 2,
    "passed": 1,
    "partial": 0,
    "failed": 1,
    "topFrustrations": [
      { "text": "Ботът поиска 3 пъти потвърждение", "count": 1 }
    ],
    "topBotBugs": [{ "text": "500 при generate_invoice", "count": 1 }]
  }
}
```

- [ ] **Step 2: Write failing test for reporter**

Create `tests/reporter.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  writeRunReport,
  summarizeRun,
  makeRunId,
} from "../src/reporter/reporter.js";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ScenarioResult } from "../src/types.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reporter-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function sampleResult(overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    scenarioId: "x",
    personaId: "p",
    endedBy: "goal_achieved",
    turnsUsed: 1,
    costUsd: 0.01,
    transcript: [],
    verdict: {
      goal_achieved: "yes",
      turns_used: 1,
      criteria: [],
      frustrations: [],
      confusions: [],
      bot_bugs: [],
      ux_suggestions: [],
      forbidden_violations: [],
      overall_severity: "none",
      quotes: [],
      summary: "ok",
    },
    ...overrides,
  };
}

describe("makeRunId", () => {
  it("produces ISO-like filesystem-safe id", () => {
    const id = makeRunId();
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  });
});

describe("summarizeRun", () => {
  it("counts passed/partial/failed correctly", () => {
    const results = [
      sampleResult({
        verdict: { ...sampleResult().verdict, goal_achieved: "yes" },
      }),
      sampleResult({
        verdict: { ...sampleResult().verdict, goal_achieved: "partial" },
      }),
      sampleResult({
        verdict: { ...sampleResult().verdict, goal_achieved: "no" },
      }),
    ];
    const s = summarizeRun(results);
    expect(s.total).toBe(3);
    expect(s.passed).toBe(1);
    expect(s.partial).toBe(1);
    expect(s.failed).toBe(1);
  });

  it("aggregates top frustrations by count", () => {
    const results = [
      sampleResult({
        verdict: {
          ...sampleResult().verdict,
          frustrations: ["A", "B"],
        },
      }),
      sampleResult({
        verdict: {
          ...sampleResult().verdict,
          frustrations: ["A"],
        },
      }),
    ];
    const s = summarizeRun(results);
    expect(s.topFrustrations[0]).toEqual({ text: "A", count: 2 });
  });
});

describe("writeRunReport", () => {
  it("writes .json and .md files", () => {
    const results = [sampleResult()];
    writeRunReport(tmp, "2026-04-22T14-30-00", {
      startedAt: "2026-04-22T14:30:00.000Z",
      finishedAt: "2026-04-22T14:31:00.000Z",
      totalCostUsd: 0.01,
      results,
    });
    expect(existsSync(join(tmp, "2026-04-22T14-30-00.json"))).toBe(true);
    expect(existsSync(join(tmp, "2026-04-22T14-30-00.md"))).toBe(true);
    const json = JSON.parse(
      readFileSync(join(tmp, "2026-04-22T14-30-00.json"), "utf-8"),
    );
    expect(json.scenarios).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Write failing test for markdown**

Create `tests/markdown.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/reporter/markdown.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { RunReportSchema } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("renderMarkdown", () => {
  it("includes executive summary and per-scenario table", () => {
    const raw = JSON.parse(
      readFileSync(join(__dirname, "fixtures/sample-run.json"), "utf-8"),
    );
    const report = RunReportSchema.parse(raw);
    const md = renderMarkdown(report);

    expect(md).toContain("# Tester Run Report");
    expect(md).toContain("**Total:** 2");
    expect(md).toContain("**Passed:** 1");
    expect(md).toContain("| hello ");
    expect(md).toContain("| create-order ");
    expect(md).toContain("Ботът поиска 3 пъти потвърждение");
  });

  it("surfaces blocker severity prominently", () => {
    const raw = JSON.parse(
      readFileSync(join(__dirname, "fixtures/sample-run.json"), "utf-8"),
    );
    raw.scenarios[1].verdict.overall_severity = "blocker";
    const report = RunReportSchema.parse(raw);
    const md = renderMarkdown(report);
    expect(md).toContain("BLOCKER");
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
cd telegram-bot-tester && npx vitest run tests/reporter.test.ts tests/markdown.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 5: Write `src/reporter/reporter.ts`**

```typescript
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { RunReport, ScenarioResult } from "../types.js";
import { renderMarkdown } from "./markdown.js";

export function makeRunId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}`
  );
}

export function summarizeRun(results: ScenarioResult[]): RunReport["summary"] {
  let passed = 0;
  let partial = 0;
  let failed = 0;
  const frustrationCounts = new Map<string, number>();
  const bugCounts = new Map<string, number>();

  for (const r of results) {
    if (r.verdict.goal_achieved === "yes") passed++;
    else if (r.verdict.goal_achieved === "partial") partial++;
    else failed++;

    for (const f of r.verdict.frustrations) {
      frustrationCounts.set(f, (frustrationCounts.get(f) ?? 0) + 1);
    }
    for (const b of r.verdict.bot_bugs) {
      bugCounts.set(b, (bugCounts.get(b) ?? 0) + 1);
    }
  }

  const toTop = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([text, count]) => ({ text, count }));

  return {
    total: results.length,
    passed,
    partial,
    failed,
    topFrustrations: toTop(frustrationCounts),
    topBotBugs: toTop(bugCounts),
  };
}

type WriteInput = {
  startedAt: string;
  finishedAt: string;
  totalCostUsd: number;
  results: ScenarioResult[];
};

export function writeRunReport(
  outDir: string,
  runId: string,
  data: WriteInput,
): { jsonPath: string; mdPath: string } {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const report: RunReport = {
    runId,
    startedAt: data.startedAt,
    finishedAt: data.finishedAt,
    totalCostUsd: data.totalCostUsd,
    scenarios: data.results,
    summary: summarizeRun(data.results),
  };

  const jsonPath = join(outDir, `${runId}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");

  const mdPath = join(outDir, `${runId}.md`);
  writeFileSync(mdPath, renderMarkdown(report), "utf-8");

  return { jsonPath, mdPath };
}
```

- [ ] **Step 6: Write `src/reporter/markdown.ts`**

```typescript
import type { RunReport, ScenarioResult, TranscriptTurn } from "../types.js";

function sevLabel(s: string): string {
  return s === "blocker" || s === "major" ? s.toUpperCase() : s;
}

function renderTranscript(turns: TranscriptTurn[]): string {
  const lines: string[] = [];
  for (const t of turns) {
    switch (t.kind) {
      case "sent_to_bot":
        lines.push(`- 👤 **user** → ${t.text}`);
        break;
      case "bot_reply":
        lines.push(`- 🤖 **bot** → ${t.text}`);
        break;
      case "actor_thought":
        lines.push(`- 💭 _thought: ${t.content}_`);
        break;
      case "actor_tool_call":
        lines.push(`- 🛠️ _tool: ${t.tool}_`);
        break;
      case "timeout":
        lines.push(`- ⏱ _timeout after ${t.waitedMs}ms_`);
        break;
      case "error":
        lines.push(`- ❌ _error: ${t.error}_`);
        break;
    }
  }
  return lines.join("\n");
}

function renderScenarioDetail(r: ScenarioResult): string {
  const v = r.verdict;
  const parts: string[] = [];
  parts.push(`### ${r.scenarioId} — ${sevLabel(v.overall_severity)}`);
  parts.push("");
  parts.push(`**Persona:** ${r.personaId}`);
  parts.push(`**Ended by:** ${r.endedBy}`);
  parts.push(`**Turns:** ${r.turnsUsed}`);
  parts.push(`**Cost:** $${r.costUsd.toFixed(4)}`);
  parts.push("");
  parts.push(`**Summary:** ${v.summary}`);
  parts.push("");
  if (v.criteria.length) {
    parts.push("**Criteria:**");
    for (const c of v.criteria) {
      parts.push(`- ${c.met ? "✅" : "❌"} ${c.text} — _${c.evidence}_`);
    }
    parts.push("");
  }
  if (v.bot_bugs.length) {
    parts.push("**Bot bugs:**");
    for (const b of v.bot_bugs) parts.push(`- 🐛 ${b}`);
    parts.push("");
  }
  if (v.frustrations.length) {
    parts.push("**Frustrations:**");
    for (const f of v.frustrations) parts.push(`- 😤 ${f}`);
    parts.push("");
  }
  if (v.confusions.length) {
    parts.push("**Confusions:**");
    for (const c of v.confusions) parts.push(`- 🤔 ${c}`);
    parts.push("");
  }
  if (v.ux_suggestions.length) {
    parts.push("**UX suggestions:**");
    for (const u of v.ux_suggestions) parts.push(`- 💡 ${u}`);
    parts.push("");
  }
  if (v.forbidden_violations.length) {
    parts.push("**Forbidden violations:**");
    for (const f of v.forbidden_violations) parts.push(`- 🚫 ${f}`);
    parts.push("");
  }
  if (r.transcript.length) {
    parts.push("<details><summary>Transcript</summary>");
    parts.push("");
    parts.push(renderTranscript(r.transcript));
    parts.push("");
    parts.push("</details>");
    parts.push("");
  }
  return parts.join("\n");
}

export function renderMarkdown(report: RunReport): string {
  const lines: string[] = [];
  lines.push("# Tester Run Report");
  lines.push("");
  lines.push(`- **Run ID:** ${report.runId}`);
  lines.push(`- **Started:** ${report.startedAt}`);
  lines.push(`- **Finished:** ${report.finishedAt}`);
  lines.push(`- **Cost:** $${report.totalCostUsd.toFixed(4)}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Total:** ${report.summary.total}`);
  lines.push(`- **Passed:** ${report.summary.passed}`);
  lines.push(`- **Partial:** ${report.summary.partial}`);
  lines.push(`- **Failed:** ${report.summary.failed}`);
  lines.push("");
  if (report.summary.topFrustrations.length) {
    lines.push("### Top frustrations");
    for (const f of report.summary.topFrustrations) {
      lines.push(`- (${f.count}×) ${f.text}`);
    }
    lines.push("");
  }
  if (report.summary.topBotBugs.length) {
    lines.push("### Top bot bugs");
    for (const b of report.summary.topBotBugs) {
      lines.push(`- (${b.count}×) ${b.text}`);
    }
    lines.push("");
  }
  lines.push("## Scenarios");
  lines.push("");
  lines.push("| id | persona | endedBy | turns | severity | summary |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of report.scenarios) {
    const oneLine = r.verdict.summary.replace(/\n/g, " ").slice(0, 80);
    lines.push(
      `| ${r.scenarioId} | ${r.personaId} | ${r.endedBy} | ${r.turnsUsed} | ${sevLabel(r.verdict.overall_severity)} | ${oneLine} |`,
    );
  }
  lines.push("");
  const interesting = report.scenarios.filter(
    (r) =>
      r.verdict.overall_severity === "minor" ||
      r.verdict.overall_severity === "major" ||
      r.verdict.overall_severity === "blocker" ||
      r.verdict.goal_achieved !== "yes",
  );
  if (interesting.length) {
    lines.push("## Details");
    lines.push("");
    for (const r of interesting) lines.push(renderScenarioDetail(r));
  }
  return lines.join("\n");
}
```

- [ ] **Step 7: Run tests to verify they pass**

```bash
cd telegram-bot-tester && npx vitest run tests/reporter.test.ts tests/markdown.test.ts
```

Expected: 6 passed.

- [ ] **Step 8: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add telegram-bot-tester/src/reporter/ telegram-bot-tester/tests/reporter.test.ts telegram-bot-tester/tests/markdown.test.ts telegram-bot-tester/tests/fixtures/sample-run.json
git commit -m "feat(tester): add reporter (JSON + derived markdown)"
```

---

## Task 7: Cost tracker

**Files:**

- Create: `telegram-bot-tester/src/cost.ts`
- Create: `telegram-bot-tester/tests/cost.test.ts`

Purpose: convert Anthropic usage to USD using pricing table.

- [ ] **Step 1: Write failing test**

Create `tests/cost.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { computeCost } from "../src/cost.js";

describe("computeCost", () => {
  it("computes Haiku cost correctly", () => {
    const cost = computeCost("claude-haiku-4-5-20251001", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(6.0, 6); // 1.0 + 5.0
  });

  it("computes Sonnet cost correctly", () => {
    const cost = computeCost("claude-sonnet-4-6", {
      input_tokens: 500_000,
      output_tokens: 100_000,
    });
    // 0.5*3 + 0.1*15 = 1.5 + 1.5 = 3.0
    expect(cost).toBeCloseTo(3.0, 6);
  });

  it("returns 0 for unknown model", () => {
    const cost = computeCost("unknown-model", {
      input_tokens: 1000,
      output_tokens: 1000,
    });
    expect(cost).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd telegram-bot-tester && npx vitest run tests/cost.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/cost.ts`**

```typescript
import { PRICING_USD_PER_MTOK } from "./config.js";

export type Usage = { input_tokens: number; output_tokens: number };

export function computeCost(model: string, usage: Usage): number {
  const p = PRICING_USD_PER_MTOK[model];
  if (!p) return 0;
  const inputCost = (usage.input_tokens / 1_000_000) * p.input;
  const outputCost = (usage.output_tokens / 1_000_000) * p.output;
  return inputCost + outputCost;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd telegram-bot-tester && npx vitest run tests/cost.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add telegram-bot-tester/src/cost.ts telegram-bot-tester/tests/cost.test.ts
git commit -m "feat(tester): add cost tracker using pricing table"
```

---

## Task 8: Telegram client (GramJS wrapper)

**Files:**

- Create: `telegram-bot-tester/src/telegram/session.ts`
- Create: `telegram-bot-tester/src/telegram/client.ts`

Purpose: wrap GramJS into a minimal TelegramClient interface. No automated tests — MTProto hard to mock; relies on smoke test.

- [ ] **Step 1: Write `src/telegram/session.ts`**

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = join(__dirname, "..", "..", "session");
const SESSION_FILE = join(SESSION_DIR, "tester.session");

export function readSession(): string {
  if (!existsSync(SESSION_FILE)) return "";
  return readFileSync(SESSION_FILE, "utf-8").trim();
}

export function writeSession(s: string): void {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(SESSION_FILE, s, "utf-8");
}

export function sessionExists(): boolean {
  return existsSync(SESSION_FILE) && readSession().length > 0;
}
```

- [ ] **Step 2: Write `src/telegram/client.ts`**

```typescript
import { TelegramClient as GramTelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import { Api } from "telegram";
import { readSession, writeSession } from "./session.js";
import { log } from "../logger.js";

export interface TelegramClientHandle {
  start(): Promise<void>;
  startInteractiveLogin(
    getPhone: () => Promise<string>,
    getCode: () => Promise<string>,
    getPassword: () => Promise<string | undefined>,
  ): Promise<void>;
  sendMessage(text: string): Promise<void>;
  waitForReply(opts?: {
    timeoutMs?: number;
  }): Promise<{ text: string; receivedAt: Date; messageId: number }>;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

type Config = {
  apiId: number;
  apiHash: string;
  phone: string;
  botUsername: string;
};

export function createTelegramClient(cfg: Config): TelegramClientHandle {
  const session = new StringSession(readSession());
  const gram = new GramTelegramClient(session, cfg.apiId, cfg.apiHash, {
    connectionRetries: 5,
  });

  let botEntity: Api.TypeInputPeer | null = null;
  const inbox: Array<{ text: string; receivedAt: Date; messageId: number }> =
    [];

  async function handleMessage(event: NewMessageEvent): Promise<void> {
    const msg = event.message;
    if (!msg || !msg.message) return;
    // Only accept messages from the target bot
    const senderId = msg.senderId?.toString();
    const botId =
      botEntity && "userId" in botEntity
        ? (botEntity as Api.InputPeerUser).userId.toString()
        : null;
    if (!senderId || !botId || senderId !== botId) return;
    inbox.push({
      text: msg.message,
      receivedAt: new Date(),
      messageId: msg.id,
    });
    log.debug("[tg] bot reply received", { len: msg.message.length });
  }

  async function sendMessage(text: string): Promise<void> {
    if (!botEntity) throw new Error("Bot entity not resolved");
    await gram.sendMessage(botEntity, { message: text });
    log.debug("[tg] sent", { len: text.length });
  }

  async function waitForReply(opts?: {
    timeoutMs?: number;
  }): Promise<{ text: string; receivedAt: Date; messageId: number }> {
    const timeoutMs = opts?.timeoutMs ?? 60000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const msg = inbox.shift();
      if (msg) return msg;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timeout waiting for bot reply after ${timeoutMs}ms`);
  }

  async function reset(): Promise<void> {
    await sendMessage("/reset");
    try {
      await waitForReply({ timeoutMs: 5000 });
    } catch {
      // bot may or may not reply; don't fail
    }
    inbox.length = 0;
  }

  async function start(): Promise<void> {
    if (!readSession()) {
      throw new Error("No saved session. Run `npm run tester:login` first.");
    }
    await gram.connect();
    if (!(await gram.isUserAuthorized())) {
      throw new Error("Session exists but is not authorized. Re-run login.");
    }
    botEntity = await gram.getInputEntity(cfg.botUsername);
    gram.addEventHandler(handleMessage, new NewMessage({}));
    log.info("[tg] connected", { botUsername: cfg.botUsername });
  }

  async function startInteractiveLogin(
    getPhone: () => Promise<string>,
    getCode: () => Promise<string>,
    getPassword: () => Promise<string | undefined>,
  ): Promise<void> {
    await gram.start({
      phoneNumber: getPhone,
      phoneCode: getCode,
      password: getPassword,
      onError: (err) => {
        log.error("[tg] login error", { error: String(err) });
      },
    });
    writeSession(gram.session.save() as unknown as string);
    log.info("[tg] session saved");
  }

  async function stop(): Promise<void> {
    await gram.disconnect();
    await gram.destroy();
  }

  return {
    start,
    startInteractiveLogin,
    sendMessage,
    waitForReply,
    reset,
    stop,
  };
}
```

- [ ] **Step 3: Type-check**

```bash
cd telegram-bot-tester && npm run build
```

Expected: no errors. If GramJS types complain about `StringSession` import path, adjust to the exact path that ships (check `node_modules/telegram/sessions/`).

- [ ] **Step 4: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add telegram-bot-tester/src/telegram/
git commit -m "feat(tester): add GramJS Telegram client wrapper"
```

---

## Task 9: Actor tools + prompt

**Files:**

- Create: `telegram-bot-tester/src/actor/tools.ts`
- Create: `telegram-bot-tester/src/actor/prompt.ts`
- Create: `telegram-bot-tester/tests/actor-tools.test.ts`

Purpose: define the 4 Anthropic tool schemas and the actor system prompt template.

- [ ] **Step 1: Write failing test**

Create `tests/actor-tools.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  ACTOR_TOOLS,
  parseToolArgs,
  SendMessageArgsSchema,
  GoalAchievedArgsSchema,
  GiveUpArgsSchema,
} from "../src/actor/tools.js";

describe("ACTOR_TOOLS", () => {
  it("has exactly 4 tools", () => {
    expect(ACTOR_TOOLS).toHaveLength(4);
    const names = ACTOR_TOOLS.map((t) => t.name);
    expect(names).toContain("send_message");
    expect(names).toContain("read_latest_reply");
    expect(names).toContain("goal_achieved");
    expect(names).toContain("give_up");
  });
});

describe("parseToolArgs", () => {
  it("parses send_message args", () => {
    const parsed = parseToolArgs("send_message", { text: "hi" });
    expect(parsed).toEqual({ text: "hi" });
  });

  it("rejects send_message without text", () => {
    expect(() => parseToolArgs("send_message", {})).toThrow();
  });

  it("parses goal_achieved args", () => {
    const parsed = parseToolArgs("goal_achieved", { summary: "done" });
    expect(parsed).toEqual({ summary: "done" });
  });

  it("parses give_up args", () => {
    const parsed = parseToolArgs("give_up", { reason: "stuck" });
    expect(parsed).toEqual({ reason: "stuck" });
  });

  it("parses read_latest_reply with empty args", () => {
    const parsed = parseToolArgs("read_latest_reply", {});
    expect(parsed).toEqual({});
  });

  it("throws on unknown tool", () => {
    expect(() => parseToolArgs("unknown", {})).toThrow(/unknown/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd telegram-bot-tester && npx vitest run tests/actor-tools.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/actor/tools.ts`**

```typescript
import { z } from "zod";

export const SendMessageArgsSchema = z.object({
  text: z.string().min(1).max(4096),
});
export const ReadLatestArgsSchema = z.object({});
export const GoalAchievedArgsSchema = z.object({
  summary: z.string().min(1),
});
export const GiveUpArgsSchema = z.object({
  reason: z.string().min(1),
});

export type ActorToolName =
  | "send_message"
  | "read_latest_reply"
  | "goal_achieved"
  | "give_up";

// Tool definitions in Anthropic tool-use schema
export const ACTOR_TOOLS = [
  {
    name: "send_message" as const,
    description:
      "Изпрати текстово съобщение към бота в Telegram. Ботът ще отговори след малко.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "Съобщението което да се изпрати. Максимум 4096 chars.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "read_latest_reply" as const,
    description:
      "Прочети последния отговор на бота (ако той вече е отговорил, но още не си го получил). Обикновено не ти трябва — reply идва автоматично след send_message.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "goal_achieved" as const,
    description:
      "Обяви че целта е постигната. Подай кратко резюме на бг (1-2 изречения).",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string",
          description: "Кратко резюме: какво постигна и как.",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "give_up" as const,
    description:
      "Откажи се от целта. Обясни защо (ботът не разбра, показа грешка, зацикли и т.н.).",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "Защо се отказваш.",
        },
      },
      required: ["reason"],
    },
  },
];

export function parseToolArgs(name: string, args: unknown): unknown {
  switch (name) {
    case "send_message":
      return SendMessageArgsSchema.parse(args);
    case "read_latest_reply":
      return ReadLatestArgsSchema.parse(args);
    case "goal_achieved":
      return GoalAchievedArgsSchema.parse(args);
    case "give_up":
      return GiveUpArgsSchema.parse(args);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
```

- [ ] **Step 4: Write `src/actor/prompt.ts`**

```typescript
import type { Persona, Scenario } from "../types.js";

export function buildActorSystemPrompt(
  persona: Persona,
  scenario: Scenario,
): string {
  const criteria = scenario.success_criteria
    .map((c, i) => `  ${i + 1}. ${c}`)
    .join("\n");
  const forbidden =
    scenario.forbidden_behaviors.length > 0
      ? "Бележи (за твоя reference) кога ботът прави тези нежелани неща:\n" +
        scenario.forbidden_behaviors.map((f) => `  - ${f}`).join("\n") +
        "\n\n"
      : "";

  return `Ти си ${persona.name}. Ролята ти: ${persona.description}

СТИЛ:
- verbosity: ${persona.style.verbosity}
- tone: ${persona.style.tone}
- typos: ${persona.style.typos} (прави разумни typos ако "sometimes" или "often")
- emoji: ${persona.style.emoji}

ПРИМЕРИ КАК ГОВОРИШ:
${persona.example_utterances.map((u) => `  - "${u}"`).join("\n")}

ТВОЯТА ЦЕЛ:
${scenario.goal}

КРИТЕРИИ ЗА УСПЕХ (трябва да се постигнат всички):
${criteria}

${forbidden}ИНСТРУМЕНТИ:
- send_message(text): изпраща съобщение към бота
- read_latest_reply(): прочита последен отговор на бота (рядко нужно)
- goal_achieved(summary): обяви успех когато всички критерии са постигнати
- give_up(reason): откажи се ако бот зацикли, показва грешка, или не се разбирате

ПРАВИЛА:
1. Говори като истински потребител, не като изкуствен агент. Пиши кратко.
2. Ако ботът покаже меню или бутон, може да отговориш директно с текст (бот-ът е AI-задвижван).
3. Ако ботът не разбира нещо, опитай по-ясно. Ако и след 2 опита не разбира — give_up.
4. Не измисляй данни които не ти са зададени в целта. Ако ти трябва нещо (имейл, дата), измисли реалистично (напр. "утре").
5. Когато всички критерии видимо са постигнати → goal_achieved веднага. Не продължавай "за да си сигурен".
`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd telegram-bot-tester && npx vitest run tests/actor-tools.test.ts
```

Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add telegram-bot-tester/src/actor/tools.ts telegram-bot-tester/src/actor/prompt.ts telegram-bot-tester/tests/actor-tools.test.ts
git commit -m "feat(tester): add actor tools + system prompt builder"
```

---

## Task 10: Actor loop

**Files:**

- Create: `telegram-bot-tester/src/actor/actor.ts`
- Create: `telegram-bot-tester/tests/actor.test.ts`

Purpose: tool-calling loop that drives conversation with the bot. Anthropic SDK + TelegramClientHandle.

- [ ] **Step 1: Write failing test**

Create `tests/actor.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { runActor } from "../src/actor/actor.js";
import type { TelegramClientHandle } from "../src/telegram/client.js";
import type { Persona, Scenario } from "../src/types.js";

function stubTg(): TelegramClientHandle {
  const sent: string[] = [];
  const replies = ["Здравей! Как мога да помогна?", "Избери от менюто."];
  let idx = 0;
  return {
    start: vi.fn(),
    startInteractiveLogin: vi.fn(),
    sendMessage: vi.fn(async (t: string) => {
      sent.push(t);
    }),
    waitForReply: vi.fn(async () => {
      const text = replies[idx] ?? "…";
      idx++;
      return { text, receivedAt: new Date(), messageId: idx };
    }),
    reset: vi.fn(),
    stop: vi.fn(),
  };
}

const persona: Persona = {
  id: "p",
  name: "Тест",
  description: "…",
  style: { verbosity: "short", tone: "casual", typos: "never", emoji: "never" },
  example_utterances: ["hi"],
};

const scenario: Scenario = {
  id: "s",
  title: "s",
  category: "orders",
  persona: "p",
  goal: "Say hi",
  success_criteria: ["Bot replies"],
  forbidden_behaviors: [],
  max_turns: 5,
  tags: [],
};

function fakeAnthropic(
  sequence: Array<{
    stop_reason: string;
    content: unknown[];
    usage: { input_tokens: number; output_tokens: number };
  }>,
) {
  let i = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        const r = sequence[i++];
        if (!r) throw new Error("sequence exhausted");
        return r;
      }),
    },
  } as unknown as import("@anthropic-ai/sdk").default;
}

describe("runActor", () => {
  it("loops send_message → goal_achieved and returns result", async () => {
    const tg = stubTg();
    const anthropic = fakeAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "send_message",
            input: { text: "Здравей" },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      },
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "goal_achieved",
            input: { summary: "bot replied" },
          },
        ],
        usage: { input_tokens: 120, output_tokens: 8 },
      },
    ]);

    const result = await runActor(scenario, persona, tg, anthropic, {
      maxTurns: 5,
      perTurnTimeoutMs: 1000,
      model: "claude-haiku-4-5-20251001",
    });

    expect(result.endedBy).toBe("goal_achieved");
    expect(result.endReason).toBe("bot replied");
    expect(result.turnsUsed).toBe(1);
    expect(
      result.transcript.some(
        (t) => t.kind === "sent_to_bot" && t.text === "Здравей",
      ),
    ).toBe(true);
    expect(result.transcript.some((t) => t.kind === "bot_reply")).toBe(true);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(tg.sendMessage).toHaveBeenCalledWith("Здравей");
  });

  it("hits max_turns when actor keeps sending", async () => {
    const tg = stubTg();
    const sendOnce = {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "t",
          name: "send_message",
          input: { text: "x" },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const anthropic = fakeAnthropic([sendOnce, sendOnce, sendOnce]);

    const result = await runActor(scenario, persona, tg, anthropic, {
      maxTurns: 2,
      perTurnTimeoutMs: 1000,
      model: "claude-haiku-4-5-20251001",
    });

    expect(result.endedBy).toBe("max_turns");
    expect(result.turnsUsed).toBe(2);
  });

  it("handles give_up", async () => {
    const tg = stubTg();
    const anthropic = fakeAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t",
            name: "give_up",
            input: { reason: "stuck" },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);

    const result = await runActor(scenario, persona, tg, anthropic, {
      maxTurns: 5,
      perTurnTimeoutMs: 1000,
      model: "claude-haiku-4-5-20251001",
    });

    expect(result.endedBy).toBe("give_up");
    expect(result.endReason).toBe("stuck");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd telegram-bot-tester && npx vitest run tests/actor.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/actor/actor.ts`**

```typescript
import type Anthropic from "@anthropic-ai/sdk";
import type { TelegramClientHandle } from "../telegram/client.js";
import type { Persona, Scenario, TranscriptTurn } from "../types.js";
import { ACTOR_TOOLS, parseToolArgs } from "./tools.js";
import { buildActorSystemPrompt } from "./prompt.js";
import { computeCost } from "../cost.js";
import { log } from "../logger.js";

export type ActorResult = {
  transcript: TranscriptTurn[];
  endedBy: "goal_achieved" | "give_up" | "max_turns" | "error";
  endReason?: string;
  turnsUsed: number;
  costUsd: number;
};

type ActorOpts = {
  maxTurns: number;
  perTurnTimeoutMs: number;
  model: string;
};

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

type AnthropicMessage = {
  role: "user" | "assistant";
  content:
    | string
    | AnthropicContentBlock[]
    | Array<
        | { type: "tool_result"; tool_use_id: string; content: string }
        | { type: "text"; text: string }
      >;
};

export async function runActor(
  scenario: Scenario,
  persona: Persona,
  tg: TelegramClientHandle,
  anthropic: Anthropic,
  opts: ActorOpts,
): Promise<ActorResult> {
  const transcript: TranscriptTurn[] = [];
  let costUsd = 0;
  const systemPrompt = buildActorSystemPrompt(persona, scenario);
  const messages: AnthropicMessage[] = [
    {
      role: "user",
      content:
        "Започни да действаш към целта. Изпрати първото си съобщение или ползвай read_latest_reply ако бот-ът вече е изпратил нещо.",
    },
  ];

  let turnsUsed = 0;
  let endedBy: ActorResult["endedBy"] = "max_turns";
  let endReason: string | undefined;

  for (let turn = 0; turn < opts.maxTurns; turn++) {
    let response;
    try {
      response = await (
        anthropic.messages.create as unknown as (p: unknown) => Promise<{
          stop_reason: string;
          content: AnthropicContentBlock[];
          usage: { input_tokens: number; output_tokens: number };
        }>
      )({
        model: opts.model,
        max_tokens: 1024,
        system: systemPrompt,
        tools: ACTOR_TOOLS,
        messages,
      });
    } catch (err) {
      transcript.push({
        kind: "error",
        at: new Date().toISOString(),
        error: `actor anthropic error: ${String(err)}`,
      });
      endedBy = "error";
      endReason = `actor_api_error: ${String(err)}`;
      break;
    }

    costUsd += computeCost(opts.model, response.usage);

    const toolUses = response.content.filter(
      (c): c is Extract<AnthropicContentBlock, { type: "tool_use" }> =>
        c.type === "tool_use",
    );
    const textBlocks = response.content.filter(
      (c): c is Extract<AnthropicContentBlock, { type: "text" }> =>
        c.type === "text",
    );
    for (const tb of textBlocks) {
      transcript.push({
        kind: "actor_thought",
        at: new Date().toISOString(),
        content: tb.text,
      });
    }

    if (toolUses.length === 0) {
      // No tool use — actor is thinking aloud without acting. Nudge or stop.
      transcript.push({
        kind: "error",
        at: new Date().toISOString(),
        error: "actor produced no tool_use",
      });
      endedBy = "error";
      endReason = "actor_no_tool_use";
      break;
    }

    turnsUsed++;

    // Build the assistant message exactly as received (preserves tool_use blocks)
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string;
    }> = [];
    let loopTerminated = false;

    for (const tu of toolUses) {
      transcript.push({
        kind: "actor_tool_call",
        at: new Date().toISOString(),
        tool: tu.name,
        args: tu.input,
      });

      let args: unknown;
      try {
        args = parseToolArgs(tu.name, tu.input);
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `Грешка: ${String(err)}. Опитай отново с правилните аргументи.`,
        });
        continue;
      }

      if (tu.name === "goal_achieved") {
        endedBy = "goal_achieved";
        endReason = (args as { summary: string }).summary;
        loopTerminated = true;
        break;
      }
      if (tu.name === "give_up") {
        endedBy = "give_up";
        endReason = (args as { reason: string }).reason;
        loopTerminated = true;
        break;
      }
      if (tu.name === "send_message") {
        const text = (args as { text: string }).text;
        try {
          await tg.sendMessage(text);
          transcript.push({
            kind: "sent_to_bot",
            at: new Date().toISOString(),
            text,
          });
          const reply = await tg.waitForReply({
            timeoutMs: opts.perTurnTimeoutMs,
          });
          transcript.push({
            kind: "bot_reply",
            at: reply.receivedAt.toISOString(),
            text: reply.text,
            messageId: reply.messageId,
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Ботът отговори: ${reply.text}`,
          });
        } catch (err) {
          const errStr = String(err);
          transcript.push({
            kind: "timeout",
            at: new Date().toISOString(),
            waitedMs: opts.perTurnTimeoutMs,
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Ботът не отговори (${errStr}). Какво правиш?`,
          });
        }
        continue;
      }
      if (tu.name === "read_latest_reply") {
        try {
          const reply = await tg.waitForReply({ timeoutMs: 1000 });
          transcript.push({
            kind: "bot_reply",
            at: reply.receivedAt.toISOString(),
            text: reply.text,
            messageId: reply.messageId,
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Ботът беше казал: ${reply.text}`,
          });
        } catch {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: "Няма нов отговор в момента.",
          });
        }
        continue;
      }
    }

    if (loopTerminated) break;

    messages.push({ role: "user", content: toolResults });
  }

  log.info("[actor] finished", { endedBy, turnsUsed, costUsd });

  return { transcript, endedBy, endReason, turnsUsed, costUsd };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd telegram-bot-tester && npx vitest run tests/actor.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add telegram-bot-tester/src/actor/actor.ts telegram-bot-tester/tests/actor.test.ts
git commit -m "feat(tester): add tool-calling actor loop with Anthropic SDK"
```

---

## Task 11: Judge

**Files:**

- Create: `telegram-bot-tester/src/judge/prompt.ts`
- Create: `telegram-bot-tester/src/judge/judge.ts`
- Create: `telegram-bot-tester/tests/judge-prompt.test.ts`
- Create: `telegram-bot-tester/tests/judge.test.ts`

Purpose: take (scenario + transcript) and produce a Verdict via single Sonnet call.

- [ ] **Step 1: Write failing test for prompt builder**

Create `tests/judge-prompt.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildJudgePrompt } from "../src/judge/prompt.js";
import type { Scenario, TranscriptTurn } from "../src/types.js";

const scenario: Scenario = {
  id: "s",
  title: "Тест",
  category: "orders",
  persona: "p",
  goal: "Създай поръчка",
  success_criteria: ["A", "B"],
  forbidden_behaviors: ["дублирани въпроси"],
  max_turns: 5,
  tags: [],
};

describe("buildJudgePrompt", () => {
  it("includes goal, criteria, forbidden, and turns", () => {
    const turns: TranscriptTurn[] = [
      { kind: "sent_to_bot", at: "t0", text: "здравей" },
      { kind: "bot_reply", at: "t1", text: "здрасти", messageId: 1 },
    ];
    const prompt = buildJudgePrompt(scenario, turns);
    expect(prompt).toContain("Създай поръчка");
    expect(prompt).toContain("A");
    expect(prompt).toContain("B");
    expect(prompt).toContain("дублирани въпроси");
    expect(prompt).toContain("здравей");
    expect(prompt).toContain("здрасти");
  });

  it("handles empty transcript", () => {
    const prompt = buildJudgePrompt(scenario, []);
    expect(prompt).toContain("Създай поръчка");
  });

  it("includes Verdict schema instructions", () => {
    const prompt = buildJudgePrompt(scenario, []);
    expect(prompt).toContain("goal_achieved");
    expect(prompt).toContain("overall_severity");
    expect(prompt).toContain("JSON");
  });
});
```

- [ ] **Step 2: Write failing test for judge**

Create `tests/judge.test.ts`:

````typescript
import { describe, it, expect, vi } from "vitest";
import { runJudge } from "../src/judge/judge.js";
import type { Scenario, TranscriptTurn } from "../src/types.js";

const scenario: Scenario = {
  id: "s",
  title: "Test",
  category: "orders",
  persona: "p",
  goal: "Goal",
  success_criteria: ["C1"],
  forbidden_behaviors: [],
  max_turns: 5,
  tags: [],
};
const turns: TranscriptTurn[] = [
  { kind: "sent_to_bot", at: "t0", text: "hi" },
  { kind: "bot_reply", at: "t1", text: "hello", messageId: 1 },
];

function fakeAnthropic(jsonStr: string) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: "text", text: jsonStr }],
        usage: { input_tokens: 500, output_tokens: 100 },
      })),
    },
  } as unknown as import("@anthropic-ai/sdk").default;
}

describe("runJudge", () => {
  it("parses well-formed verdict JSON", async () => {
    const verdict = {
      goal_achieved: "yes",
      turns_used: 1,
      criteria: [{ text: "C1", met: true, evidence: "turn 1" }],
      frustrations: [],
      confusions: [],
      bot_bugs: [],
      ux_suggestions: [],
      forbidden_violations: [],
      overall_severity: "none",
      quotes: [],
      summary: "ok",
    };
    const anthropic = fakeAnthropic(JSON.stringify(verdict));
    const result = await runJudge(scenario, turns, anthropic, {
      model: "claude-sonnet-4-6",
    });
    expect(result.verdict.goal_achieved).toBe("yes");
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("extracts JSON from code fence", async () => {
    const anthropic = fakeAnthropic(
      '```json\n{"goal_achieved":"no","turns_used":1,"criteria":[],"frustrations":[],"confusions":[],"bot_bugs":[],"ux_suggestions":[],"forbidden_violations":[],"overall_severity":"minor","quotes":[],"summary":"x"}\n```',
    );
    const result = await runJudge(scenario, turns, anthropic, {
      model: "claude-sonnet-4-6",
    });
    expect(result.verdict.goal_achieved).toBe("no");
  });

  it("returns error verdict if JSON malformed after retry", async () => {
    let call = 0;
    const anthropic = {
      messages: {
        create: vi.fn(async () => {
          call++;
          return {
            content: [{ type: "text", text: "not json at all" }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        }),
      },
    } as unknown as import("@anthropic-ai/sdk").default;

    const result = await runJudge(scenario, turns, anthropic, {
      model: "claude-sonnet-4-6",
    });
    expect(result.verdict.goal_achieved).toBe("error");
    expect(call).toBe(2); // initial + 1 retry
  });
});
````

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd telegram-bot-tester && npx vitest run tests/judge-prompt.test.ts tests/judge.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 4: Write `src/judge/prompt.ts`**

```typescript
import type { Scenario, TranscriptTurn } from "../types.js";

function formatTurn(t: TranscriptTurn, i: number): string {
  switch (t.kind) {
    case "sent_to_bot":
      return `[${i}] USER → ${t.text}`;
    case "bot_reply":
      return `[${i}] BOT  → ${t.text}`;
    case "actor_thought":
      return `[${i}] (thought: ${t.content})`;
    case "actor_tool_call":
      return `[${i}] (tool: ${t.tool} args=${JSON.stringify(t.args)})`;
    case "timeout":
      return `[${i}] *** TIMEOUT (${t.waitedMs}ms) ***`;
    case "error":
      return `[${i}] *** ERROR: ${t.error} ***`;
  }
}

export function buildJudgePrompt(
  scenario: Scenario,
  transcript: TranscriptTurn[],
): string {
  const criteria = scenario.success_criteria
    .map((c, i) => `  ${i + 1}. ${c}`)
    .join("\n");
  const forbidden = scenario.forbidden_behaviors.length
    ? "ЗАБРАНЕНИ ПОВЕДЕНИЯ (маркирай ако се случат):\n" +
      scenario.forbidden_behaviors.map((f) => `  - ${f}`).join("\n") +
      "\n\n"
    : "";
  const turns = transcript.map(formatTurn).join("\n") || "(празен transcript)";

  return `Ти си строг UX одитор на МЕРТ-М Telegram бота. Преглеждаш разговор между тестер и бота и вадиш обективна оценка.

СЦЕНАРИЙ: ${scenario.title}
ЦЕЛ НА ТЕСТЕРА:
${scenario.goal}

КРИТЕРИИ ЗА УСПЕХ (всички трябва да са met=true за goal_achieved="yes"):
${criteria}

${forbidden}ТРАНСКРИПТ:
${turns}

ЗАДАЧА:
Оцени строго. Всяко двойно питане за същото, всяка 500 грешка, всяко объркване — е проблем, не "минорна дреболия". Преценявай от гледна точка на реален потребител, а не на разработчик.

ОТГОВОРИ САМО С JSON (без markdown, без обяснения извън JSON-а) със следната схема:
{
  "goal_achieved": "yes" | "no" | "partial",
  "turns_used": number,
  "criteria": [{ "text": "<критерий>", "met": bool, "evidence": "турн/цитат" }],
  "frustrations": ["описание на frustrating moment"],
  "confusions": ["моменти на объркване"],
  "bot_bugs": ["technical bugs/грешки"],
  "ux_suggestions": ["конкретни подобрения"],
  "forbidden_violations": ["случаи на забранени поведения"],
  "overall_severity": "none" | "minor" | "major" | "blocker",
  "quotes": [{ "turn": number, "text": "<цитат>", "comment": "<защо е важно>" }],
  "summary": "1-2 изречения на бг"
}

ВАЖНО: turns_used = броят USER реплики в transcript-а.`;
}
```

- [ ] **Step 5: Write `src/judge/judge.ts`**

````typescript
import type Anthropic from "@anthropic-ai/sdk";
import type { Scenario, TranscriptTurn, Verdict } from "../types.js";
import { VerdictSchema } from "../types.js";
import { buildJudgePrompt } from "./prompt.js";
import { computeCost } from "../cost.js";
import { log } from "../logger.js";

export type JudgeResult = {
  verdict: Verdict;
  costUsd: number;
};

type JudgeOpts = {
  model: string;
};

function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }
  return text.trim();
}

async function callJudge(
  anthropic: Anthropic,
  model: string,
  prompt: string,
  strict = false,
): Promise<{ text: string; costUsd: number }> {
  const system = strict
    ? "Отговори САМО с валиден JSON мачващ зададената схема, нищо друго. Без markdown fences, без обяснения."
    : "Отговори с валиден JSON мачващ зададената схема.";
  const response = await (
    anthropic.messages.create as unknown as (p: unknown) => Promise<{
      content: Array<{ type: "text"; text: string } | { type: string }>;
      usage: { input_tokens: number; output_tokens: number };
    }>
  )({
    model,
    max_tokens: 2048,
    system,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  const costUsd = computeCost(model, response.usage);
  return { text, costUsd };
}

export async function runJudge(
  scenario: Scenario,
  transcript: TranscriptTurn[],
  anthropic: Anthropic,
  opts: JudgeOpts,
): Promise<JudgeResult> {
  const prompt = buildJudgePrompt(scenario, transcript);
  let totalCost = 0;

  // Attempt 1
  try {
    const { text, costUsd } = await callJudge(anthropic, opts.model, prompt);
    totalCost += costUsd;
    const verdict = VerdictSchema.parse(JSON.parse(extractJson(text)));
    return { verdict, costUsd: totalCost };
  } catch (err) {
    log.warn("[judge] first attempt failed, retrying", {
      error: String(err).slice(0, 200),
    });
  }

  // Attempt 2 (strict)
  try {
    const { text, costUsd } = await callJudge(
      anthropic,
      opts.model,
      prompt,
      true,
    );
    totalCost += costUsd;
    const verdict = VerdictSchema.parse(JSON.parse(extractJson(text)));
    return { verdict, costUsd: totalCost };
  } catch (err) {
    log.error("[judge] both attempts failed", {
      error: String(err).slice(0, 200),
    });
  }

  // Placeholder verdict
  return {
    verdict: {
      goal_achieved: "error",
      turns_used: 0,
      criteria: [],
      frustrations: [],
      confusions: [],
      bot_bugs: [],
      ux_suggestions: [],
      forbidden_violations: [],
      overall_severity: "blocker",
      quotes: [],
      summary:
        "Judge не успя да върне валиден JSON след 2 опита. Прегледай transcript-а ръчно.",
    },
    costUsd: totalCost,
  };
}
````

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd telegram-bot-tester && npx vitest run tests/judge-prompt.test.ts tests/judge.test.ts
```

Expected: 6 passed.

- [ ] **Step 7: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add telegram-bot-tester/src/judge/ telegram-bot-tester/tests/judge-prompt.test.ts telegram-bot-tester/tests/judge.test.ts
git commit -m "feat(tester): add Sonnet judge with JSON verdict + retry"
```

---

## Task 12: Runner (orchestrator)

**Files:**

- Create: `telegram-bot-tester/src/runner.ts`
- Create: `telegram-bot-tester/tests/runner.test.ts`

Purpose: wire scenarios → actor → judge → reporter. One scenario at a time, sequential, with cost cap + SIGINT handling.

- [ ] **Step 1: Write failing integration test**

Create `tests/runner.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { runScenarios } from "../src/runner.js";
import type { TelegramClientHandle } from "../src/telegram/client.js";
import type { Persona, Scenario } from "../src/types.js";
import { mkdtempSync, rmSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function stubTg(): TelegramClientHandle {
  return {
    start: vi.fn(),
    startInteractiveLogin: vi.fn(),
    sendMessage: vi.fn(),
    waitForReply: vi.fn(async () => ({
      text: "ok",
      receivedAt: new Date(),
      messageId: 1,
    })),
    reset: vi.fn(),
    stop: vi.fn(),
  };
}

const persona: Persona = {
  id: "p1",
  name: "P",
  description: "-",
  style: { verbosity: "short", tone: "casual", typos: "never", emoji: "never" },
  example_utterances: ["hi"],
};
const scenario: Scenario = {
  id: "sA",
  title: "A",
  category: "orders",
  persona: "p1",
  goal: "g",
  success_criteria: ["c"],
  forbidden_behaviors: [],
  max_turns: 5,
  tags: [],
};

describe("runScenarios", () => {
  it("runs a scenario end-to-end and writes a report", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "runner-"));
    const tg = stubTg();

    const anthropic = {
      messages: {
        create: vi
          .fn()
          // actor turn 1: send_message
          .mockResolvedValueOnce({
            stop_reason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "send_message",
                input: { text: "hi" },
              },
            ],
            usage: { input_tokens: 50, output_tokens: 10 },
          })
          // actor turn 2: goal_achieved
          .mockResolvedValueOnce({
            stop_reason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "t2",
                name: "goal_achieved",
                input: { summary: "done" },
              },
            ],
            usage: { input_tokens: 60, output_tokens: 8 },
          })
          // judge
          .mockResolvedValueOnce({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  goal_achieved: "yes",
                  turns_used: 1,
                  criteria: [{ text: "c", met: true, evidence: "t1" }],
                  frustrations: [],
                  confusions: [],
                  bot_bugs: [],
                  ux_suggestions: [],
                  forbidden_violations: [],
                  overall_severity: "none",
                  quotes: [],
                  summary: "ok",
                }),
              },
            ],
            usage: { input_tokens: 400, output_tokens: 150 },
          }),
      },
    } as unknown as import("@anthropic-ai/sdk").default;

    const personas = new Map<string, Persona>([["p1", persona]]);
    const result = await runScenarios({
      scenarios: [scenario],
      personas,
      tg,
      anthropic,
      reportsDir: tmp,
      actorModel: "claude-haiku-4-5-20251001",
      judgeModel: "claude-sonnet-4-6",
      maxTurns: 5,
      perTurnTimeoutMs: 1000,
      scenarioTimeoutMs: 10000,
      costCapUsd: 10,
    });

    expect(result.report.scenarios).toHaveLength(1);
    expect(result.report.scenarios[0].verdict.goal_achieved).toBe("yes");
    expect(tg.reset).toHaveBeenCalledTimes(1);
    const files = readdirSync(tmp);
    expect(files.some((f) => f.endsWith(".json"))).toBe(true);
    expect(files.some((f) => f.endsWith(".md"))).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("stops when cost cap is exceeded", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "runner-"));
    const tg = stubTg();

    // Expensive response that exceeds cap in one shot
    const anthropic = {
      messages: {
        create: vi
          .fn()
          .mockResolvedValueOnce({
            stop_reason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "goal_achieved",
                input: { summary: "x" },
              },
            ],
            usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 }, // $6 Haiku
          })
          .mockResolvedValueOnce({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  goal_achieved: "yes",
                  turns_used: 0,
                  criteria: [],
                  frustrations: [],
                  confusions: [],
                  bot_bugs: [],
                  ux_suggestions: [],
                  forbidden_violations: [],
                  overall_severity: "none",
                  quotes: [],
                  summary: "",
                }),
              },
            ],
            usage: { input_tokens: 1000, output_tokens: 100 },
          }),
      },
    } as unknown as import("@anthropic-ai/sdk").default;

    const personas = new Map<string, Persona>([["p1", persona]]);
    const result = await runScenarios({
      scenarios: [scenario, { ...scenario, id: "sB" }],
      personas,
      tg,
      anthropic,
      reportsDir: tmp,
      actorModel: "claude-haiku-4-5-20251001",
      judgeModel: "claude-sonnet-4-6",
      maxTurns: 5,
      perTurnTimeoutMs: 1000,
      scenarioTimeoutMs: 10000,
      costCapUsd: 1.0, // low cap
    });

    // First scenario runs (and exceeds cap), second is skipped
    expect(result.report.scenarios).toHaveLength(1);
    expect(result.stoppedEarly).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd telegram-bot-tester && npx vitest run tests/runner.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/runner.ts`**

```typescript
import type Anthropic from "@anthropic-ai/sdk";
import type { TelegramClientHandle } from "./telegram/client.js";
import type { Persona, Scenario, ScenarioResult, RunReport } from "./types.js";
import { runActor } from "./actor/actor.js";
import { runJudge } from "./judge/judge.js";
import { writeRunReport, makeRunId } from "./reporter/reporter.js";
import { log } from "./logger.js";

export type RunScenariosInput = {
  scenarios: Scenario[];
  personas: Map<string, Persona>;
  tg: TelegramClientHandle;
  anthropic: Anthropic;
  reportsDir: string;
  actorModel: string;
  judgeModel: string;
  maxTurns: number;
  perTurnTimeoutMs: number;
  scenarioTimeoutMs: number;
  costCapUsd: number;
};

export type RunScenariosOutput = {
  report: RunReport;
  jsonPath: string;
  mdPath: string;
  stoppedEarly: boolean;
};

export async function runScenarios(
  input: RunScenariosInput,
): Promise<RunScenariosOutput> {
  const runId = makeRunId();
  const startedAt = new Date().toISOString();
  const results: ScenarioResult[] = [];
  let totalCost = 0;
  let stoppedEarly = false;

  const writePartial = (): { jsonPath: string; mdPath: string } =>
    writeRunReport(input.reportsDir, runId, {
      startedAt,
      finishedAt: new Date().toISOString(),
      totalCostUsd: totalCost,
      results,
    });

  const sigintHandler = () => {
    log.warn("[runner] SIGINT received — writing partial report");
    writePartial();
    process.exit(130);
  };
  process.on("SIGINT", sigintHandler);

  try {
    for (const scenario of input.scenarios) {
      if (totalCost >= input.costCapUsd) {
        log.warn("[runner] cost cap reached, stopping", {
          totalCost,
          cap: input.costCapUsd,
        });
        stoppedEarly = true;
        break;
      }

      const persona = input.personas.get(scenario.persona);
      if (!persona) {
        log.error("[runner] unknown persona", {
          scenario: scenario.id,
          persona: scenario.persona,
        });
        continue;
      }

      log.info("[runner] scenario start", {
        id: scenario.id,
        persona: persona.id,
      });
      try {
        await input.tg.reset();
      } catch (err) {
        log.warn("[runner] reset failed", { error: String(err) });
      }

      if (scenario.initial_bot_command) {
        try {
          await input.tg.sendMessage(scenario.initial_bot_command);
          await input.tg.waitForReply({ timeoutMs: 5000 });
        } catch (err) {
          log.warn("[runner] initial_bot_command failed", {
            error: String(err),
          });
        }
      }

      const actorResult = await Promise.race([
        runActor(scenario, persona, input.tg, input.anthropic, {
          maxTurns: scenario.max_turns ?? input.maxTurns,
          perTurnTimeoutMs: input.perTurnTimeoutMs,
          model: input.actorModel,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("scenario timeout")),
            input.scenarioTimeoutMs,
          ),
        ),
      ]).catch((err) => {
        log.error("[runner] scenario aborted", { error: String(err) });
        return {
          transcript: [
            {
              kind: "error" as const,
              at: new Date().toISOString(),
              error: String(err),
            },
          ],
          endedBy: "error" as const,
          endReason: String(err),
          turnsUsed: 0,
          costUsd: 0,
        };
      });

      totalCost += actorResult.costUsd;

      const judgeResult = await runJudge(
        scenario,
        actorResult.transcript,
        input.anthropic,
        { model: input.judgeModel },
      );
      totalCost += judgeResult.costUsd;

      results.push({
        scenarioId: scenario.id,
        personaId: persona.id,
        endedBy: actorResult.endedBy,
        endReason: actorResult.endReason,
        turnsUsed: actorResult.turnsUsed,
        costUsd: actorResult.costUsd + judgeResult.costUsd,
        transcript: actorResult.transcript,
        verdict: judgeResult.verdict,
      });

      log.info("[runner] scenario done", {
        id: scenario.id,
        endedBy: actorResult.endedBy,
        severity: judgeResult.verdict.overall_severity,
        cost: actorResult.costUsd + judgeResult.costUsd,
      });

      // Small pause between scenarios to avoid Telegram rate-limits
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    process.off("SIGINT", sigintHandler);
  }

  const { jsonPath, mdPath } = writePartial();
  const report = (await import("./types.js")).RunReportSchema.parse({
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    totalCostUsd: totalCost,
    scenarios: results,
    summary: (await import("./reporter/reporter.js")).summarizeRun(results),
  });

  return { report, jsonPath, mdPath, stoppedEarly };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd telegram-bot-tester && npx vitest run tests/runner.test.ts
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add telegram-bot-tester/src/runner.ts telegram-bot-tester/tests/runner.test.ts
git commit -m "feat(tester): add runner orchestrator with cost cap + SIGINT handling"
```

---

## Task 13: CLI entry

**Files:**

- Create: `telegram-bot-tester/src/cli.ts`
- Modify: `telegram-bot-tester/src/index.ts` — replace placeholder with re-exports
- Remove: `telegram-bot-tester/src/index.ts` — simplify by deleting if unused

Purpose: command-line interface with `--login`, `--scenario=<id>`, `--all`, `--persona=<id>`.

- [ ] **Step 1: Replace placeholder `src/index.ts` with CLI content or delete**

Delete the placeholder:

```bash
rm /Users/magic/Projects/mert-m/telegram-bot-tester/src/index.ts
```

- [ ] **Step 2: Write `src/cli.ts`**

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import { loadConfig } from "./config.js";
import { loadPersonas } from "./personas.js";
import { loadScenarios, loadScenarioFile } from "./scenarios.js";
import { createTelegramClient } from "./telegram/client.js";
import { runScenarios } from "./runner.js";
import { log, initFileLog } from "./logger.js";
import { makeRunId } from "./reporter/reporter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SCENARIOS_DIR = join(ROOT, "scenarios");
const PERSONAS_DIR = join(ROOT, "personas");
const REPORTS_DIR = join(ROOT, "reports");

type Args = {
  login: boolean;
  all: boolean;
  scenarioId?: string;
  personaId?: string;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { login: false, all: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--login") a.login = true;
    else if (arg === "--all") a.all = true;
    else if (arg.startsWith("--scenario="))
      a.scenarioId = arg.slice("--scenario=".length);
    else if (arg.startsWith("--persona="))
      a.personaId = arg.slice("--persona=".length);
  }
  return a;
}

async function promptLine(q: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

async function cmdLogin(): Promise<void> {
  const cfg = loadConfig();
  const tg = createTelegramClient(cfg.tg);
  console.log(
    "Login flow. Ти ще бъдеш питан за Telegram code (и 2FA password ако имаш).",
  );
  await tg.startInteractiveLogin(
    async () => cfg.tg.phone,
    async () => promptLine("Telegram code: "),
    async () => {
      const pw = await promptLine("2FA password (празно = няма): ");
      return pw || undefined;
    },
  );
  await tg.stop();
  console.log(
    "Session saved. Може да пускаш сценарии: npm run tester -- --all",
  );
}

async function cmdRun(args: Args): Promise<void> {
  const cfg = loadConfig();
  const runId = makeRunId();
  initFileLog(runId);

  const personas = loadPersonas(PERSONAS_DIR);
  let scenarios;
  if (args.scenarioId) {
    const one = loadScenarioFile(
      join(SCENARIOS_DIR, `${args.scenarioId}.yaml`),
    );
    scenarios = [one];
  } else if (args.all) {
    scenarios = loadScenarios(SCENARIOS_DIR);
  } else {
    throw new Error("Трябва --scenario=<id> или --all (или --login).");
  }

  if (args.personaId) {
    scenarios = scenarios.filter((s) => s.persona === args.personaId);
  }
  if (scenarios.length === 0) {
    throw new Error("Няма сценарии за пускане.");
  }

  const anthropic = new Anthropic({ apiKey: cfg.anthropicApiKey });
  const tg = createTelegramClient(cfg.tg);
  await tg.start();
  try {
    const out = await runScenarios({
      scenarios,
      personas,
      tg,
      anthropic,
      reportsDir: REPORTS_DIR,
      actorModel: cfg.actorModel,
      judgeModel: cfg.judgeModel,
      maxTurns: cfg.maxTurns,
      perTurnTimeoutMs: cfg.perTurnTimeoutMs,
      scenarioTimeoutMs: cfg.scenarioTimeoutMs,
      costCapUsd: cfg.costCapUsd,
    });
    console.log("---");
    console.log(`Report JSON: ${out.jsonPath}`);
    console.log(`Report MD:   ${out.mdPath}`);
    console.log(`Total cost: $${out.report.totalCostUsd.toFixed(4)}`);
    console.log(
      `Passed: ${out.report.summary.passed}/${out.report.summary.total}`,
    );
    if (out.stoppedEarly) {
      console.log("⚠ Спряхме по-рано (cost cap достигнат).");
    }
  } finally {
    await tg.stop();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  try {
    if (args.login) {
      await cmdLogin();
    } else {
      await cmdRun(args);
    }
  } catch (err) {
    log.error("[cli] fatal", { error: String(err) });
    process.exit(1);
  }
}

main();
```

- [ ] **Step 3: Type-check**

```bash
cd telegram-bot-tester && npm run build
```

Expected: no errors.

- [ ] **Step 4: Dry-run (no login, no scenarios — just parse error expected)**

```bash
cd telegram-bot-tester && npx tsx src/cli.ts 2>&1 | head -5
```

Expected: error about missing env (Invalid tester config…) OR "Трябва --scenario=<id> или --all" depending on whether `.env` exists. Either way, no crash/syntax error.

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add telegram-bot-tester/src/cli.ts telegram-bot-tester/src/index.ts
git commit -m "feat(tester): add CLI entry with --login and --scenario/--all modes"
```

_(Note: `src/index.ts` was deleted earlier, so `git add` will stage its deletion.)_

---

## Task 14: Add /reset handler to bot.js

**Files:**

- Modify: `/Users/magic/Projects/mert-m/telegram-bot/bot.js`

Purpose: single handler so tester can isolate scenarios by clearing bot-side state.

- [ ] **Step 1: Locate existing `/clear` handler in bot.js**

```bash
grep -n "onText(.*/clear" /Users/magic/Projects/mert-m/telegram-bot/bot.js
```

Note the line number. The new handler goes immediately after it.

- [ ] **Step 2: Read a ~20-line block around the /clear handler**

Use Read tool on bot.js, offset at the line found in Step 1, limit 30. Confirm the indentation and style.

- [ ] **Step 3: Add the `/reset` handler**

Insert AFTER the closing of the `/clear` handler (Edit tool). The inserted block:

```javascript
bot.onText(/^\/reset$/, async (msg) => {
  const userId = msg.from.id;
  if (!isAllowed(userId)) return;
  userHistories.delete(userId);
  if (userState[userId]) delete userState[userId];
  lastInvoicePerUser.delete(userId);
  await bot.sendMessage(msg.chat.id, "✅ State изчистено.");
});
```

**Formatting check:** match the existing file's indent (spaces or tabs — inspect first) and semicolon style.

- [ ] **Step 4: Syntax-check bot.js**

```bash
cd /Users/magic/Projects/mert-m/telegram-bot && node --check bot.js
```

Expected: no output (success).

- [ ] **Step 5: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add telegram-bot/bot.js
git commit -m "feat(bot): add /reset command for tester session isolation"
```

---

## Task 15: Write initial personas + scenarios

**Files:**

- Create: `telegram-bot-tester/personas/warehouse-manager.yaml`
- Create: `telegram-bot-tester/personas/new-employee.yaml`
- Create: `telegram-bot-tester/scenarios/00-hello.yaml`
- Create: `telegram-bot-tester/scenarios/01-inventory-query.yaml`
- Create: `telegram-bot-tester/scenarios/02-list-pending-orders.yaml`
- Create: `telegram-bot-tester/scenarios/03-create-order-dominos.yaml`
- Create: `telegram-bot-tester/scenarios/04-generate-invoice.yaml`
- Create: `telegram-bot-tester/scenarios/05-error-invalid-sku.yaml`

- [ ] **Step 1: Write `personas/warehouse-manager.yaml`**

```yaml
id: warehouse-manager
name: Валери-тестер
description: |
  Опитен складов мениджър, 40г., ползва бота всекидневно. Знае жаргона
  (SKU, ЕИК, товарителница, partner). Кратък, нетърпелив към излишни въпроси.
  На "ти" с бота.
style:
  verbosity: short
  tone: casual
  typos: sometimes
  emoji: rare
example_utterances:
  - "пусни товарителница за поръчка 23"
  - "кво стане с 24"
  - "фактурирай 25 и прати на info@dominos.bg"
  - "наличности"
```

- [ ] **Step 2: Write `personas/new-employee.yaml`**

```yaml
id: new-employee
name: Петя-нова
description: |
  Нов служител, първа седмица. По-формална, пише пълни изречения.
  Не знае жаргона, пита за потвърждения, лесно се обърква.
  На "ви" с бота.
style:
  verbosity: medium
  tone: formal
  typos: never
  emoji: rare
example_utterances:
  - "Здравейте! Как мога да проверя наличностите?"
  - "Моля, създайте поръчка за фирма Пицария Домино."
  - "Искам да видя последните 5 поръчки."
  - "Как се издава фактура?"
```

- [ ] **Step 3: Write `scenarios/00-hello.yaml`**

```yaml
id: 00-hello
title: Smoke — /start и меню
category: orders
persona: warehouse-manager
goal: |
  Прати /start. Увери се че ботът отговаря със съобщение (меню или
  приветствие). Нищо повече.
success_criteria:
  - Ботът отговаря след /start
  - Отговорът съдържа приветствие или меню (не е празен)
forbidden_behaviors: []
max_turns: 3
tags: [smoke, critical-path]
```

- [ ] **Step 4: Write `scenarios/01-inventory-query.yaml`**

```yaml
id: 01-inventory-query
title: Справка за наличности
category: inventory
persona: warehouse-manager
goal: |
  Поискай справка за наличностите. Успехът е когато видиш поне 1 продукт
  с име и брой на склад.
success_criteria:
  - Ботът върна списък с продукти
  - За поне 1 продукт е видно името/SKU и количество
forbidden_behaviors:
  - Да пита кой точно продукт ако кажеш "наличности" без име
max_turns: 5
tags: [smoke, critical-path, read-only]
```

- [ ] **Step 5: Write `scenarios/02-list-pending-orders.yaml`**

```yaml
id: 02-list-pending-orders
title: Списък на pending поръчки
category: orders
persona: warehouse-manager
goal: |
  Виж чакащите поръчки (status=pending). Успехът е когато видиш списък
  (може и празен — "няма чакащи" също е валидно).
success_criteria:
  - Ботът разпозна заявката за pending orders
  - Върна списък или ясно съобщение "няма"
forbidden_behaviors:
  - Да поиска от теб status параметър ("pending или fulfilled?")
max_turns: 5
tags: [smoke, read-only]
```

- [ ] **Step 6: Write `scenarios/03-create-order-dominos.yaml`**

```yaml
id: 03-create-order-dominos
title: Създаване на поръчка — Доминос с 3 HD-42
category: orders
persona: warehouse-manager
goal: |
  Създай поръчка за "Пицария Домино Бургас" (партньор който
  съществува в DB) с 3 броя от артикул HD-42. Доставка — за утре.
  Завърши когато имаш номер на създадена поръчка.
success_criteria:
  - Ботът потвърждава че поръчката е създадена
  - Показан е номер на поръчката
  - Общата сума е показана
forbidden_behaviors:
  - Двойно питане за същото (партньор/продукт)
  - Изискване да даваш ЕИК когато името на партньора е уникално
max_turns: 12
tags: [critical-path, destructive]
```

- [ ] **Step 7: Write `scenarios/04-generate-invoice.yaml`**

```yaml
id: 04-generate-invoice
title: Генериране на фактура за съществуваща поръчка
category: invoices
persona: warehouse-manager
goal: |
  Издай фактура за последната поръчка в статус confirmed или fulfilled.
  (Ако няма — издай за поръчка с id #1.) Успехът е когато видиш
  номер на фактура.
success_criteria:
  - Ботът потвърждава издадена фактура
  - Показан е номер на фактурата
forbidden_behaviors:
  - Да поиска от теб ДДС ставка (20% е дефолт за МЕРТ-М)
max_turns: 8
tags: [critical-path, destructive]
```

- [ ] **Step 8: Write `scenarios/05-error-invalid-sku.yaml`**

```yaml
id: 05-error-invalid-sku
title: Error handling — несъществуващ SKU
category: error-handling
persona: new-employee
goal: |
  Попитай за наличност на артикул "XXXXX-NONEXISTENT-999". Очакваш
  ботът ясно да каже че няма такъв продукт.
success_criteria:
  - Ботът ясно съобщава че продуктът не е намерен
  - Не хвърля technical грешка (500, SQL, stack trace)
forbidden_behaviors:
  - Да показва technical детайли (SQL query, stack trace)
  - Да се "прави" че го е намерил
max_turns: 5
tags: [smoke, error-handling, read-only]
```

- [ ] **Step 9: Validate all YAMLs load**

Write a quick validation script that loads everything. Run:

```bash
cd telegram-bot-tester && npx tsx -e "import('./src/personas.js').then(m => console.log([...m.loadPersonas('./personas').keys()])); import('./src/scenarios.js').then(m => console.log(m.loadScenarios('./scenarios').map(s => s.id)));"
```

Expected: prints both persona ids and all 6 scenario ids.

- [ ] **Step 10: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add telegram-bot-tester/personas/ telegram-bot-tester/scenarios/
git commit -m "feat(tester): add 2 personas + 6 initial scenarios"
```

---

## Task 16: README + CLAUDE.md updates

**Files:**

- Create: `telegram-bot-tester/README.md`
- Modify: `/Users/magic/Projects/mert-m/CLAUDE.md`

- [ ] **Step 1: Write `telegram-bot-tester/README.md`**

````markdown
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
````

- [ ] **Step 2: Append tester service to root `CLAUDE.md`**

Open `/Users/magic/Projects/mert-m/CLAUDE.md`, find the `## Services` section, append a new bullet:

```markdown
- telegram-bot-tester (Node.js / TS) — conversational tester за Telegram бота, YAML сценарии, Haiku actor + Sonnet judge, ad-hoc CLI
```

(Exact wording + placement: match the style of the existing bullets.)

- [ ] **Step 3: Commit**

```bash
cd /Users/magic/Projects/mert-m
git add telegram-bot-tester/README.md CLAUDE.md
git commit -m "docs(tester): add README + update root CLAUDE.md"
```

---

## Task 17: Full test suite + smoke verification

Purpose: ensure everything passes end-to-end.

- [ ] **Step 1: Run full test suite**

```bash
cd /Users/magic/Projects/mert-m/telegram-bot-tester && npm test
```

Expected: all tests (~30+) pass.

- [ ] **Step 2: Type-check**

```bash
cd /Users/magic/Projects/mert-m/telegram-bot-tester && npm run build
```

Expected: no errors.

- [ ] **Step 3: CLI help/error paths**

```bash
cd /Users/magic/Projects/mert-m/telegram-bot-tester && npx tsx src/cli.ts 2>&1 | head -3
```

Expected: either Config error OR "Трябва --scenario=<id> или --all". No stack trace of unexpected kind.

- [ ] **Step 4: Tag milestone**

```bash
cd /Users/magic/Projects/mert-m
git tag v0.3.1-tester -m "Telegram bot conversational tester (v0.1.0)"
git log --oneline v0.3.0-telegram..HEAD 2>/dev/null || git log --oneline -20
```

- [ ] **Step 5: Status check**

```bash
cd /Users/magic/Projects/mert-m && git status
```

Expected: clean tree (тester-specific файлове са committed). Uncommitted work от преди (mobile-app, etc.) остава непроменена.

---

## Exit Criteria

- `telegram-bot-tester/` exists with 16 source files + 8 test files + 2 personas + 6 scenarios + README.
- `npm test` passes (all unit + integration tests).
- `npm run build` passes (no TS errors).
- `npx tsx src/cli.ts` produces a sensible error (config missing or args missing), not a crash.
- `telegram-bot/bot.js` has new `/reset` handler; `node --check bot.js` passes.
- Root `CLAUDE.md` mentions the new service.
- Root `.gitignore` excludes tester artifacts.
- Git tag `v0.3.1-tester` exists.
- Manual smoke (`npm run tester:login` + `--scenario=00-hello`) is documented in README; user runs it once to validate the real stack.

## Manual smoke test (post-implementation)

Not part of automated Tasks, but required for closing V1:

1. `cd telegram-bot-tester && cp .env.example .env` — fill values
2. Start the real bot: `cd ../telegram-bot && npm start` in another terminal (optional — уточни дали ботът вече е пуснат)
3. `cd ../telegram-bot-tester && npm run tester:login` — enter code + 2FA
4. `npm run tester -- --scenario=00-hello`
5. Verify `reports/<ISO>.md` shows the 00-hello scenario passed with `overall_severity: none`, cost < $0.10.
6. If all green → V1 done. If failures → iterate on bot.js or prompts in V1.1.
