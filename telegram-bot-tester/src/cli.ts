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
  try {
    await tg.startInteractiveLogin(
      async () => cfg.tg.phone,
      async () => promptLine("Telegram code: "),
      async () => {
        const pw = await promptLine("2FA password (празно = няма): ");
        return pw || undefined;
      },
    );
  } finally {
    await tg.stop();
  }
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
      runId,
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
