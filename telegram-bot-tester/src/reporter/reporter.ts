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
