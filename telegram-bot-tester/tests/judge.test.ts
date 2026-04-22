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
