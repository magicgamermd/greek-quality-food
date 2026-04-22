import type Anthropic from "@anthropic-ai/sdk";
import type { TelegramClientHandle } from "./telegram/client.js";
import type { Persona, Scenario, ScenarioResult, RunReport } from "./types.js";
import { RunReportSchema } from "./types.js";
import { runActor } from "./actor/actor.js";
import { runJudge } from "./judge/judge.js";
import {
  writeRunReport,
  makeRunId,
  summarizeRun,
} from "./reporter/reporter.js";
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
  runId?: string;
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
  const runId = input.runId ?? makeRunId();
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

  const sigintHandler = async () => {
    log.warn("[runner] SIGINT received — writing partial report");
    try {
      writePartial();
    } catch (err) {
      log.error("[runner] partial report write failed", { error: String(err) });
    }
    try {
      await input.tg.stop();
    } catch (err) {
      log.error("[runner] tg.stop on SIGINT failed", { error: String(err) });
    }
    process.exit(130);
  };
  process.on("SIGINT", sigintHandler);

  let jsonPath: string;
  let mdPath: string;
  let report: RunReport;

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

      const abortController = new AbortController();
      let scenarioTimer: NodeJS.Timeout | undefined;
      const actorResult = await Promise.race([
        runActor(scenario, persona, input.tg, input.anthropic, {
          maxTurns: scenario.max_turns ?? input.maxTurns,
          perTurnTimeoutMs: input.perTurnTimeoutMs,
          model: input.actorModel,
          signal: abortController.signal,
        }),
        new Promise<never>((_, reject) => {
          scenarioTimer = setTimeout(() => {
            abortController.abort();
            reject(new Error("scenario timeout"));
          }, input.scenarioTimeoutMs);
        }),
      ])
        .catch((err) => {
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
        })
        .finally(() => {
          if (scenarioTimer) clearTimeout(scenarioTimer);
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

    const written = writePartial();
    jsonPath = written.jsonPath;
    mdPath = written.mdPath;

    report = RunReportSchema.parse({
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      totalCostUsd: totalCost,
      scenarios: results,
      summary: summarizeRun(results),
    });
  } finally {
    process.off("SIGINT", sigintHandler);
  }

  return { report, jsonPath, mdPath, stoppedEarly };
}
