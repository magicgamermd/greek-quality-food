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
