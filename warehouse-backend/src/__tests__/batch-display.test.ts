import { describe, expect, it } from "vitest";
import { displayBatchNumber } from "../utils/batch-display.js";

describe("displayBatchNumber — служебните партиди не се показват на документи", () => {
  it("скрива авто-партидите (АВТО-{доставка}-{ред})", () => {
    expect(displayBatchNumber("АВТО-4-24")).toBeNull();
    expect(displayBatchNumber("АВТО-113-77")).toBeNull();
  });

  it("скрива откриващата партида (НАЧАЛНО, back-order)", () => {
    expect(displayBatchNumber("НАЧАЛНО")).toBeNull();
  });

  it("показва реално въведени номера на партиди", () => {
    expect(displayBatchNumber("L2024-15")).toBe("L2024-15");
    expect(displayBatchNumber("2726R55M3-4")).toBe("2726R55M3-4");
    // Trim, но съдържание с АВТО по средата си е легитимно.
    expect(displayBatchNumber("  0127J37M612 ")).toBe("0127J37M612");
  });

  it("празно/липсващо → null (редът просто няма партида)", () => {
    expect(displayBatchNumber(null)).toBeNull();
    expect(displayBatchNumber(undefined)).toBeNull();
    expect(displayBatchNumber("   ")).toBeNull();
  });
});
