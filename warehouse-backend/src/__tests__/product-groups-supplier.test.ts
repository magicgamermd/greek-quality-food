// Групи по доставчик: доставка слага в групата на доставчика продуктите
// без група; ръчно сложените в група не се местят (Microinvest, 04.11.2026).
import { describe, expect, it } from "vitest";
import { assignSupplierGroup, cleanGroupName } from "../lib/product-groups.js";
import { pickDefaultDiscount } from "../lib/partner-discount.js";

type Call = { sql: string; params: any[] };

function fakeClient(opts: {
  ungrouped: number;
  linkedGroupId?: number;
  supplierName?: string;
  freeGroups?: Array<{ id: number; name: string }>;
  insertedId?: number | null;
}) {
  const calls: Call[] = [];
  const client = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/SELECT COUNT\(\*\)::int AS count FROM products/.test(sql)) {
        return { rows: [{ count: opts.ungrouped }], rowCount: 1 };
      }
      if (/FROM product_groups WHERE supplier_id = \$1/.test(sql)) {
        return {
          rows: opts.linkedGroupId ? [{ id: opts.linkedGroupId }] : [],
          rowCount: opts.linkedGroupId ? 1 : 0,
        };
      }
      if (/SELECT name FROM suppliers/.test(sql)) {
        return { rows: [{ name: opts.supplierName ?? null }], rowCount: 1 };
      }
      if (/WHERE supplier_id IS NULL/.test(sql)) {
        return { rows: opts.freeGroups ?? [], rowCount: 0 };
      }
      if (/INSERT INTO product_groups/.test(sql)) {
        const id = opts.insertedId === undefined ? 50 : opts.insertedId;
        return { rows: id ? [{ id }] : [], rowCount: id ? 1 : 0 };
      }
      if (/^UPDATE products SET product_group_id/.test(sql.trim())) {
        return { rows: [], rowCount: opts.ungrouped };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return { client: client as any, calls };
}

const productUpdate = (calls: Call[]) =>
  calls.find((c) => /^UPDATE products SET product_group_id/.test(c.sql.trim()));

describe("assignSupplierGroup", () => {
  it("групата на доставчика вече има → само продуктите без група влизат", async () => {
    const { client, calls } = fakeClient({ ungrouped: 2, linkedGroupId: 7 });
    const moved = await assignSupplierGroup(client, 3, [10, 11, "12", 10]);
    expect(moved).toBe(2);
    const update = productUpdate(calls)!;
    expect(update.sql).toMatch(/product_group_id IS NULL/);
    expect(update.params).toEqual([7, [10, 11, 12]]);
    expect(calls.some((c) => /INSERT INTO product_groups/.test(c.sql))).toBe(
      false,
    );
  });

  it("всички вече са в група → нищо не се пипа и не се създава", async () => {
    const { client, calls } = fakeClient({ ungrouped: 0 });
    expect(await assignSupplierGroup(client, 3, [10])).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("без доставчик или без продукти → 0, без заявки", async () => {
    const { client, calls } = fakeClient({ ungrouped: 5 });
    expect(await assignSupplierGroup(client, null, [1])).toBe(0);
    expect(await assignSupplierGroup(client, 3, [null, undefined])).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("група със същото име (главни/малки) без доставчик → свързва се", async () => {
    const { client, calls } = fakeClient({
      ungrouped: 1,
      supplierName: "FARM  KOUKAKIS S.A.",
      freeGroups: [{ id: 4, name: "farm koukakis s.a." }],
    });
    expect(await assignSupplierGroup(client, 1, [10])).toBe(1);
    const link = calls.find((c) =>
      /UPDATE product_groups SET supplier_id/.test(c.sql),
    );
    expect(link?.params).toEqual([1, 4]);
    expect(productUpdate(calls)?.params[0]).toBe(4);
  });

  it("нов доставчик → нова група с името му (без двойни интервали)", async () => {
    const { client, calls } = fakeClient({
      ungrouped: 1,
      supplierName: " OLD  VERGIDIS MODESTOS ",
      insertedId: 51,
    });
    expect(await assignSupplierGroup(client, 2, [10])).toBe(1);
    const insert = calls.find((c) => /INSERT INTO product_groups/.test(c.sql));
    expect(insert?.params).toEqual(["OLD VERGIDIS MODESTOS", 2]);
    expect(productUpdate(calls)?.params[0]).toBe(51);
  });

  it("доставчик без име → нищо", async () => {
    const { client, calls } = fakeClient({ ungrouped: 1, supplierName: "  " });
    expect(await assignSupplierGroup(client, 2, [10])).toBe(0);
    expect(productUpdate(calls)).toBeUndefined();
  });

  it("cleanGroupName", () => {
    expect(cleanGroupName("  GOUROS DIMITRIOS  - SALATES ")).toBe(
      "GOUROS DIMITRIOS - SALATES",
    );
    expect(cleanGroupName(null)).toBe("");
  });
});

describe("отстъпка по подразбиране на нов ред", () => {
  it("своята на партньора е с предимство", () => {
    expect(pickDefaultDiscount("5.00", 3.5)).toBe(5);
  });
  it("иначе тази на ценовата група", () => {
    expect(pickDefaultDiscount("0.00", "3.5")).toBe(3.5);
    expect(pickDefaultDiscount(null, 2)).toBe(2);
  });
  it("нищо / боклук / извън 0–100 → 0", () => {
    expect(pickDefaultDiscount(null, null)).toBe(0);
    expect(pickDefaultDiscount("abc", undefined)).toBe(0);
    expect(pickDefaultDiscount(150, -2)).toBe(0);
  });
});
