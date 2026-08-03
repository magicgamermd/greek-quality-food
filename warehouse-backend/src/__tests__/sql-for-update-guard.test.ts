import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * PostgreSQL отказва `FOR UPDATE`, ако SELECT-ът съдържа агрегат:
 *   ERROR: FOR UPDATE is not allowed with aggregate functions
 *
 * Заявка от вида
 *   SELECT COALESCE(SUM(quantity), 0) ... FOR UPDATE
 * се компилира и минава през mock-натите unit тестове, но гърми в
 * лицето на потребителя при първото истинско извикване. Точно така
 * „Изписване" и „Брак" стояха счупени.
 *
 * Правилният начин е в две стъпки: първо заключваш редовете (SELECT id
 * ... FOR UPDATE), после ги сумираш в отделна заявка — вътре в същата
 * транзакция сумата е стабилна, защото редовете вече са заключени.
 *
 * Този тест е статичен пазач: чете сорса и проверява, че никоя
 * заключваща заявка няма агрегат в select-листа си.
 */

const SRC_DIR = path.resolve("src");
const AGGREGATES =
  /\b(SUM|COUNT|AVG|MIN|MAX|ARRAY_AGG|STRING_AGG|JSON_AGG)\s*\(/i;

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

/**
 * За SQL, който съдържа FOR UPDATE: връща select-листа (текста между
 * SELECT и съответстващото му FROM) на заявката, която НОСИ ключалката —
 * тоест на дълбочина 0 спрямо скобите. Агрегат в подзаявка е позволен,
 * затова се брои само най-външното ниво.
 */
function lockingSelectList(sql: string): string | null {
  const forUpdate = /FOR\s+UPDATE/i.exec(sql);
  if (!forUpdate) return null;
  const head = sql.slice(0, forUpdate.index);

  let depth = 0;
  let selectIdx = -1;
  for (let i = 0; i < head.length; i += 1) {
    const ch = head[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (depth === 0 && /^select\b/i.test(head.slice(i, i + 7))) {
      selectIdx = i;
    }
  }
  if (selectIdx < 0) return null;

  depth = 0;
  for (let i = selectIdx + 6; i < head.length; i += 1) {
    const ch = head[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (depth === 0 && /^\sfrom\b/i.test(head.slice(i, i + 6))) {
      return head.slice(selectIdx, i);
    }
  }
  return head.slice(selectIdx);
}

describe("SQL: FOR UPDATE не се комбинира с агрегат", () => {
  it("никоя заключваща заявка няма агрегат в select-листа", () => {
    const offenders: string[] = [];

    for (const file of collectTsFiles(SRC_DIR)) {
      const source = fs.readFileSync(file, "utf8");
      // Всеки template literal (там живеят SQL заявките).
      for (const match of source.matchAll(/`([^`]*)`/g)) {
        const sql = match[1];
        if (!/FOR\s+UPDATE/i.test(sql)) continue;
        const selectList = lockingSelectList(sql);
        if (selectList && AGGREGATES.test(selectList)) {
          const line = source.slice(0, match.index).split("\n").length;
          offenders.push(
            `${path.relative(SRC_DIR, file)}:${line} → ${selectList
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 90)}`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("самият пазач разпознава счупената форма", () => {
    // Регресия на пазача: ако това спре да лови, тестът отгоре е сляп.
    const broken = `SELECT COALESCE(SUM(quantity), 0) AS total
       FROM inventory WHERE product_id = $1 FOR UPDATE`;
    expect(AGGREGATES.test(lockingSelectList(broken) ?? "")).toBe(true);

    // Агрегат в ПОДзаявка е позволен от Postgres — не бива да се лови.
    const fine = `SELECT id FROM inventory
       WHERE quantity > (SELECT AVG(quantity) FROM inventory) FOR UPDATE`;
    expect(AGGREGATES.test(lockingSelectList(fine) ?? "")).toBe(false);
  });
});
