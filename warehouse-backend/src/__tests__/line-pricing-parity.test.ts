import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as backend from "../lib/line-pricing.js";

// Екранът и сървърът трябва да смятат ЕДНАКВО, иначе касиерът вижда една
// сума, а на фактурата излиза друга. Фронтендът няма собствен тест runner,
// затова двата файла се сверяват тук.

const CASES: Array<[number | string, number | string, number | string]> = [
  [2.8, 6.317, 0],
  [2.8, 6.317, 10],
  [1.54, 19.75, 0],
  [2.275, 7.8, 0],
  [3, 2.005, 0],
  [25, 0.043, 0],
  [20, 45, 5.56],
  ["2.800", "6.317", "0.00"],
  [-2.8, 6.317, 0],
  [1.0004, 100, 0],
];

// Динамичен импорт по път-променлива: файлът е извън rootDir на бекенда и
// tsc (продукционният билд) не бива да го влачи. Vitest го зарежда.
const FRONTEND_MODULE = path.resolve(
  __dirname,
  "../../../warehouse-frontend/src/lib/linePricing.ts",
);
let frontend: typeof backend;

describe("фронтенд и бекенд смятат цени и суми еднакво", () => {
  beforeAll(async () => {
    frontend = await import(FRONTEND_MODULE);
  });

  it.each(CASES)("%s × %s при %s%%", (qty, price, discount) => {
    expect(frontend.computeLineTotal(qty, price, discount)).toBe(
      backend.computeLineTotal(qty, price, discount),
    );
    expect(frontend.effectiveUnitPrice(price, discount)).toBe(
      backend.effectiveUnitPrice(price, discount),
    );
    const line = {
      quantity: qty,
      unit_price: price,
      discount_percent: discount,
    };
    expect(frontend.getDisplayLine(line)).toEqual(backend.getDisplayLine(line));
  });

  it("кодът след заглавния коментар е идентичен", () => {
    const strip = (file: string) =>
      fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((row) => !row.startsWith("//"))
        .join("\n")
        .trim();
    const root = path.resolve(__dirname, "../../..");
    expect(
      strip(path.join(root, "warehouse-frontend/src/lib/linePricing.ts")),
    ).toBe(strip(path.join(root, "warehouse-backend/src/lib/line-pricing.ts")));
  });
});
