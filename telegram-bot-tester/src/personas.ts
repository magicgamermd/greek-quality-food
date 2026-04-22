import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { PersonaSchema, type Persona } from "./types.js";

export function loadPersonaFile(path: string): Persona {
  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw) as unknown;
  return PersonaSchema.parse(parsed);
}

export function loadPersonas(
  dir: string,
  filter?: RegExp,
): Map<string, Persona> {
  const files = readdirSync(dir).filter((f) => {
    if (!f.endsWith(".yaml") && !f.endsWith(".yml")) return false;
    return filter ? filter.test(f) : true;
  });
  const out = new Map<string, Persona>();
  for (const f of files) {
    const p = loadPersonaFile(join(dir, f));
    if (out.has(p.id)) {
      throw new Error(`Duplicate persona id: ${p.id} (from ${f})`);
    }
    out.set(p.id, p);
  }
  return out;
}
