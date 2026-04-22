import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { ScenarioSchema, type Scenario } from "./types.js";

export function loadScenarioFile(path: string): Scenario {
  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw) as unknown;
  return ScenarioSchema.parse(parsed);
}

export function loadScenarios(dir: string, filter?: RegExp): Scenario[] {
  const files = readdirSync(dir).filter((f) => {
    if (!f.endsWith(".yaml") && !f.endsWith(".yml")) return false;
    return filter ? filter.test(f) : true;
  });
  const out: Scenario[] = [];
  const seen = new Set<string>();
  for (const f of files.sort()) {
    const s = loadScenarioFile(join(dir, f));
    if (seen.has(s.id)) {
      throw new Error(`Duplicate scenario id: ${s.id} (from ${f})`);
    }
    seen.add(s.id);
    out.push(s);
  }
  return out;
}
