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
