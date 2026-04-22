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
