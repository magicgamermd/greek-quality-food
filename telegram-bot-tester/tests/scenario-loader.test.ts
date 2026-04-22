import { describe, it, expect } from "vitest";
import { loadScenarioFile, loadScenarios } from "../src/scenarios.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("loadScenarioFile", () => {
  it("loads valid scenario with defaults", () => {
    const s = loadScenarioFile(join(__dirname, "fixtures/valid-scenario.yaml"));
    expect(s.id).toBe("test-scenario");
    expect(s.max_turns).toBe(12); // default
    expect(s.forbidden_behaviors).toEqual([]);
    expect(s.tags).toEqual([]);
  });

  it("throws on missing required field", () => {
    expect(() => loadScenarioFile("/nonexistent.yaml")).toThrow();
  });
});

describe("loadScenarios", () => {
  it("loads all scenarios from a directory", () => {
    const fixturesDir = join(__dirname, "fixtures");
    const arr = loadScenarios(fixturesDir, /^valid-scenario\.yaml$/);
    expect(arr).toHaveLength(1);
    expect(arr[0].id).toBe("test-scenario");
  });
});
