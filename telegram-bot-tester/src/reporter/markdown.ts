import type { RunReport, ScenarioResult, TranscriptTurn } from "../types.js";

function sevLabel(s: string): string {
  return s === "blocker" || s === "major" ? s.toUpperCase() : s;
}

function renderTranscript(turns: TranscriptTurn[]): string {
  const lines: string[] = [];
  for (const t of turns) {
    switch (t.kind) {
      case "sent_to_bot":
        lines.push(`- 👤 **user** → ${t.text}`);
        break;
      case "bot_reply": {
        const extras: string[] = [];
        if (t.document) {
          const kb = Math.max(1, Math.round(t.document.size / 1024));
          extras.push(
            `📎 ${t.document.fileName} (${t.document.mimeType}, ${kb} KB)`,
          );
        }
        if (t.buttons && t.buttons.length > 0) {
          extras.push("🔘 " + t.buttons.map((b) => `\`${b.text}\``).join(" "));
        }
        const suffix = extras.length ? ` — ${extras.join(" · ")}` : "";
        lines.push(`- 🤖 **bot** → ${t.text}${suffix}`);
        break;
      }
      case "clicked_button":
        lines.push(`- 👆 **user clicked** → \`${t.buttonText}\``);
        break;
      case "actor_thought":
        lines.push(`- 💭 _thought: ${t.content}_`);
        break;
      case "actor_tool_call":
        lines.push(`- 🛠️ _tool: ${t.tool}_`);
        break;
      case "timeout":
        lines.push(`- ⏱ _timeout after ${t.waitedMs}ms_`);
        break;
      case "error":
        lines.push(`- ❌ _error: ${t.error}_`);
        break;
    }
  }
  return lines.join("\n");
}

function renderScenarioDetail(r: ScenarioResult): string {
  const v = r.verdict;
  const parts: string[] = [];
  parts.push(`### ${r.scenarioId} — ${sevLabel(v.overall_severity)}`);
  parts.push("");
  parts.push(`**Persona:** ${r.personaId}`);
  parts.push(`**Ended by:** ${r.endedBy}`);
  parts.push(`**Turns:** ${r.turnsUsed}`);
  parts.push(`**Cost:** $${r.costUsd.toFixed(4)}`);
  parts.push("");
  parts.push(`**Summary:** ${v.summary}`);
  parts.push("");
  if (v.criteria.length) {
    parts.push("**Criteria:**");
    for (const c of v.criteria) {
      parts.push(`- ${c.met ? "✅" : "❌"} ${c.text} — _${c.evidence}_`);
    }
    parts.push("");
  }
  if (v.bot_bugs.length) {
    parts.push("**Bot bugs:**");
    for (const b of v.bot_bugs) parts.push(`- 🐛 ${b}`);
    parts.push("");
  }
  if (v.frustrations.length) {
    parts.push("**Frustrations:**");
    for (const f of v.frustrations) parts.push(`- 😤 ${f}`);
    parts.push("");
  }
  if (v.confusions.length) {
    parts.push("**Confusions:**");
    for (const c of v.confusions) parts.push(`- 🤔 ${c}`);
    parts.push("");
  }
  if (v.ux_suggestions.length) {
    parts.push("**UX suggestions:**");
    for (const u of v.ux_suggestions) parts.push(`- 💡 ${u}`);
    parts.push("");
  }
  if (v.forbidden_violations.length) {
    parts.push("**Forbidden violations:**");
    for (const f of v.forbidden_violations) parts.push(`- 🚫 ${f}`);
    parts.push("");
  }
  if (r.transcript.length) {
    parts.push("<details><summary>Transcript</summary>");
    parts.push("");
    parts.push(renderTranscript(r.transcript));
    parts.push("");
    parts.push("</details>");
    parts.push("");
  }
  return parts.join("\n");
}

export function renderMarkdown(report: RunReport): string {
  const lines: string[] = [];
  lines.push("# Tester Run Report");
  lines.push("");
  lines.push(`- **Run ID:** ${report.runId}`);
  lines.push(`- **Started:** ${report.startedAt}`);
  lines.push(`- **Finished:** ${report.finishedAt}`);
  lines.push(`- **Cost:** $${report.totalCostUsd.toFixed(4)}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Total:** ${report.summary.total}`);
  lines.push(`- **Passed:** ${report.summary.passed}`);
  lines.push(`- **Partial:** ${report.summary.partial}`);
  lines.push(`- **Failed:** ${report.summary.failed}`);
  lines.push("");
  if (report.summary.topFrustrations.length) {
    lines.push("### Top frustrations");
    for (const f of report.summary.topFrustrations) {
      lines.push(`- (${f.count}×) ${f.text}`);
    }
    lines.push("");
  }
  if (report.summary.topBotBugs.length) {
    lines.push("### Top bot bugs");
    for (const b of report.summary.topBotBugs) {
      lines.push(`- (${b.count}×) ${b.text}`);
    }
    lines.push("");
  }
  lines.push("## Scenarios");
  lines.push("");
  lines.push("| id | persona | endedBy | turns | severity | summary |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of report.scenarios) {
    const oneLine = r.verdict.summary.replace(/\n/g, " ").slice(0, 80);
    lines.push(
      `| ${r.scenarioId} | ${r.personaId} | ${r.endedBy} | ${r.turnsUsed} | ${sevLabel(r.verdict.overall_severity)} | ${oneLine} |`,
    );
  }
  lines.push("");
  const interesting = report.scenarios.filter(
    (r) =>
      r.verdict.overall_severity === "minor" ||
      r.verdict.overall_severity === "major" ||
      r.verdict.overall_severity === "blocker" ||
      r.verdict.goal_achieved !== "yes",
  );
  if (interesting.length) {
    lines.push("## Details");
    lines.push("");
    for (const r of interesting) lines.push(renderScenarioDetail(r));
  }
  return lines.join("\n");
}
