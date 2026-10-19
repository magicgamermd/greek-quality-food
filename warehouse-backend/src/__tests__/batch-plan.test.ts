import { describe, expect, it } from "vitest";
import {
  isExpiredOn,
  normalizePlan,
  planMatchesQuantity,
  planTotal,
  takeFromBudget,
  todayInSofia,
} from "../lib/batch-plan.js";

describe("normalizePlan", () => {
  it("обединява една и съща партида, закръгля и маха нулите", () => {
    expect(
      normalizePlan([
        { batch_id: 1350, quantity: 2.5 },
        { batch_id: 1303, quantity: 5 },
        { batch_id: 1350, quantity: 2.5004 },
        { batch_id: 1299, quantity: 0 },
      ]),
    ).toEqual([
      { batch_id: 1350, quantity: 5 },
      { batch_id: 1303, quantity: 5 },
    ]);
  });

  it("изхвърля невалидни id-та", () => {
    expect(
      normalizePlan([
        { batch_id: 0, quantity: 1 },
        { batch_id: -3, quantity: 1 },
        { batch_id: 7, quantity: 1 },
      ]),
    ).toEqual([{ batch_id: 7, quantity: 1 }]);
  });
});

describe("сумата спрямо количеството на реда", () => {
  it("5 + 5 = 10 съвпада", () => {
    const plan = [
      { batch_id: 1, quantity: 5 },
      { batch_id: 2, quantity: 5 },
    ];
    expect(planTotal(plan)).toBe(10);
    expect(planMatchesQuantity(plan, 10)).toBe(true);
  });

  it("2.8 = 1.4 + 1.4 без двоична грешка", () => {
    expect(
      planMatchesQuantity(
        [
          { batch_id: 1, quantity: 1.4 },
          { batch_id: 2, quantity: 1.4 },
        ],
        2.8,
      ),
    ).toBe(true);
  });

  it("5 + 4 ≠ 10", () => {
    expect(
      planMatchesQuantity(
        [
          { batch_id: 1, quantity: 5 },
          { batch_id: 2, quantity: 4 },
        ],
        10,
      ),
    ).toBe(false);
  });
});

describe("срок на годност", () => {
  it("в деня на срока още се продава; ден след това — не", () => {
    expect(isExpiredOn("2026-12-08", "2026-12-08")).toBe(false);
    expect(isExpiredOn("2026-12-08", "2026-12-09")).toBe(true);
    expect(isExpiredOn(null, "2026-12-09")).toBe(false);
  });

  it("„днес“ е по София, не по UTC (00:00–03:00 ч. българско време)", () => {
    // 19.10.2026 01:30 в София = 18.10.2026 22:30 UTC
    expect(todayInSofia(new Date("2026-10-18T22:30:00Z"))).toBe("2026-10-19");
    expect(todayInSofia(new Date("2026-10-19T12:00:00Z"))).toBe("2026-10-19");
  });
});

describe("бюджет на вече изписаното (редакция на изпълнена поръчка)", () => {
  it("до вече изписаното е „старо“, над него е „ново“", () => {
    const budget = new Map([["55:900", 3]]);
    // 2 от вече изписаните 3 → нищо ново
    expect(takeFromBudget(budget, 55, 900, 2)).toBe(0);
    // остава 1 в бюджета → от 4 новото е 3
    expect(takeFromBudget(budget, 55, 900, 4)).toBe(3);
    // бюджетът е изчерпан
    expect(takeFromBudget(budget, 55, 900, 1)).toBe(1);
  });

  it("без бюджет всичко е ново", () => {
    expect(takeFromBudget(undefined, 55, 900, 5)).toBe(5);
  });
});
