// Непипнат избор на партиди в неизпълнена поръчка не се проверява наново
// (поръчка №453, 13.11.2026 — смяна само на цената).
import { describe, expect, it } from "vitest";
import {
  keepsSavedPlan,
  savedPartMissingFrom,
  savedPlanOf,
  selectedBatchIds,
} from "./savedBatchPlan";

const MARTICHKI = {
  batch_id: 1416,
  batch_number: "АВТО-88-565",
  expiry_date: "2027-06-06T00:00:00.000Z",
  quantity: "2.366",
};

describe("savedPlanOf", () => {
  it("връща и единичната партида, със срок без час", () => {
    expect(savedPlanOf({ planned_batches: [MARTICHKI] })).toEqual([
      {
        batch_id: 1416,
        batch_number: "АВТО-88-565",
        expiry_date: "2027-06-06",
        quantity: 2.366,
      },
    ]);
  });

  it("ред на „Автоматично“ или без полето → празно", () => {
    expect(savedPlanOf({ planned_batches: [] })).toEqual([]);
    expect(savedPlanOf({})).toEqual([]);
    expect(savedPlanOf(null)).toEqual([]);
  });

  it("маха невалидните части", () => {
    expect(
      savedPlanOf({
        planned_batches: [
          { batch_id: 0, quantity: 1 },
          { batch_id: 5, quantity: 0 },
          null,
          MARTICHKI,
        ],
      }),
    ).toHaveLength(1);
  });
});

describe("selectedBatchIds", () => {
  it("една избрана партида", () => {
    expect(selectedBatchIds({ batch_id: "1416" })).toEqual([1416]);
  });

  it("„Автоматично“ → няма партиди", () => {
    expect(selectedBatchIds({ batch_id: "" })).toEqual([]);
  });

  it("разпределението е с предимство пред единичния избор", () => {
    expect(
      selectedBatchIds({
        batch_id: "",
        batch_plan: [
          { batch_id: 1350 },
          { batch_id: 1303 },
          { batch_id: 1350 },
        ],
      }),
    ).toEqual([1303, 1350]);
  });
});

describe("keepsSavedPlan", () => {
  const saved = [{ batch_id: 1416 }];

  it("№453: партидата не е пипана → изборът е същият", () => {
    expect(keepsSavedPlan({ batch_id: "1416", saved_plan: saved })).toBe(true);
  });

  it("избрана е друга партида → не е същият", () => {
    expect(keepsSavedPlan({ batch_id: "1083", saved_plan: saved })).toBe(false);
  });

  it("върнато на „Автоматично“ → не е същият", () => {
    expect(keepsSavedPlan({ batch_id: "", saved_plan: saved })).toBe(false);
  });

  it("нов ред (без записан избор) → не е същият", () => {
    expect(keepsSavedPlan({ batch_id: "1416" })).toBe(false);
    expect(keepsSavedPlan({ batch_id: "1416", saved_plan: [] })).toBe(false);
  });

  it("разпределение по същите партиди, в друг ред → същият", () => {
    expect(
      keepsSavedPlan({
        batch_id: "",
        batch_plan: [{ batch_id: 1303 }, { batch_id: 1350 }],
        saved_plan: [{ batch_id: 1350 }, { batch_id: 1303 }],
      }),
    ).toBe(true);
  });

  it("добавена е още една партида → не е същият", () => {
    expect(
      keepsSavedPlan({
        batch_id: "",
        batch_plan: [{ batch_id: 1416 }, { batch_id: 1083 }],
        saved_plan: saved,
      }),
    ).toBe(false);
  });
});

describe("savedPartMissingFrom", () => {
  const plan = savedPlanOf({ planned_batches: [MARTICHKI] });

  it("записаната партида е изчерпана → показва се от записа", () => {
    expect(savedPartMissingFrom("1416", plan, [1083, 1480])?.batch_id).toBe(
      1416,
    );
  });

  it("партидата още е сред наличните → нищо допълнително", () => {
    expect(savedPartMissingFrom("1416", plan, [1416, 1480])).toBeNull();
  });

  it("„Автоматично“, друга партида или липсващ запис → нищо", () => {
    expect(savedPartMissingFrom("", plan, [])).toBeNull();
    expect(savedPartMissingFrom("999", plan, [])).toBeNull();
    expect(savedPartMissingFrom("1416", undefined, [])).toBeNull();
  });
});
