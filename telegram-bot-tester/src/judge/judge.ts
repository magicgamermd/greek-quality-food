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
