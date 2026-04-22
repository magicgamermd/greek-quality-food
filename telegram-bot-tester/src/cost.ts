import { PRICING_USD_PER_MTOK } from "./config.js";

export type Usage = { input_tokens: number; output_tokens: number };

export function computeCost(model: string, usage: Usage): number {
  const p = PRICING_USD_PER_MTOK[model];
  if (!p) return 0;
  const inputCost = (usage.input_tokens / 1_000_000) * p.input;
  const outputCost = (usage.output_tokens / 1_000_000) * p.output;
  return inputCost + outputCost;
}
