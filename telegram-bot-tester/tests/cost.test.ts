import { describe, it, expect } from "vitest";
import { computeCost } from "../src/cost.js";

describe("computeCost", () => {
  it("computes Haiku cost correctly", () => {
    const cost = computeCost("claude-haiku-4-5-20251001", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(6.0, 6); // 1.0 + 5.0
  });

  it("computes Sonnet cost correctly", () => {
    const cost = computeCost("claude-sonnet-4-6", {
      input_tokens: 500_000,
      output_tokens: 100_000,
    });
    // 0.5*3 + 0.1*15 = 1.5 + 1.5 = 3.0
    expect(cost).toBeCloseTo(3.0, 6);
  });

  it("returns 0 for unknown model", () => {
    const cost = computeCost("unknown-model", {
      input_tokens: 1000,
      output_tokens: 1000,
    });
    expect(cost).toBe(0);
  });
});
