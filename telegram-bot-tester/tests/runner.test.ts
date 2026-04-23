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
    clickButton: vi.fn(async () => ({ messageId: 1, callbackData: "x" })),
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
