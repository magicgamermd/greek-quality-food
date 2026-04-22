import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/reporter/markdown.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { RunReportSchema } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("renderMarkdown", () => {
  it("includes executive summary and per-scenario table", () => {
    const raw = JSON.parse(
      readFileSync(join(__dirname, "fixtures/sample-run.json"), "utf-8"),
    );
    const report = RunReportSchema.parse(raw);
    const md = renderMarkdown(report);

    expect(md).toContain("# Tester Run Report");
    expect(md).toContain("**Total:** 2");
    expect(md).toContain("**Passed:** 1");
    expect(md).toContain("| hello ");
    expect(md).toContain("| create-order ");
    expect(md).toContain("Ботът поиска 3 пъти потвърждение");
  });

  it("surfaces blocker severity prominently", () => {
    const raw = JSON.parse(
      readFileSync(join(__dirname, "fixtures/sample-run.json"), "utf-8"),
    );
    raw.scenarios[1].verdict.overall_severity = "blocker";
    const report = RunReportSchema.parse(raw);
    const md = renderMarkdown(report);
    expect(md).toContain("BLOCKER");
  });
});
