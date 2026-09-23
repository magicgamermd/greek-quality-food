import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// Всяка НОВА фактура/проформа/КИ трябва да се запише с unit_price_rule =
// 'entered'. Колоната е с подразбиране 'legacy_total_div_qty' (мигр. 106),
// за да изглеждат издадените преди 23.09.2026 документи точно както са
// издадени. Забравено INSERT би печатало новите фактури по старото
// правило (6,318 вместо 6,317) — този пазач не го позволява.

const SRC_DIR = path.resolve("src");

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      collectTsFiles(full, acc);
    } else if (entry.name.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
}

describe("новите фактури се записват с правилото за въведена цена", () => {
  it("всяко INSERT INTO invoices задава unit_price_rule = 'entered'", () => {
    const missing: string[] = [];
    let inserts = 0;
    for (const file of collectTsFiles(SRC_DIR)) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/`([^`]*INSERT INTO invoices[^`]*)`/g)) {
        inserts += 1;
        const sql = match[1];
        if (!/unit_price_rule/.test(sql) || !/'entered'/.test(sql)) {
          const line = source.slice(0, match.index).split("\n").length;
          missing.push(`${path.relative(SRC_DIR, file)}:${line}`);
        }
      }
    }
    expect(inserts).toBeGreaterThanOrEqual(4);
    expect(missing).toEqual([]);
  });
});
