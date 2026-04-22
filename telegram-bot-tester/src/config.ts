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
