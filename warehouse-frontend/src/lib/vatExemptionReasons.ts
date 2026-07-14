// Mirror of warehouse-backend/src/lib/vat-exemption-reasons.ts.
// Keep in sync.

export const VAT_EXEMPTION_REASONS: ReadonlyArray<string> = [
  "Износ — нулева ставка по чл. 28 ЗДДС",
  "ВОД — нулева ставка по чл. 53, ал. 1 във връзка с чл. 7 ЗДДС",
  "EU reverse charge / обратно начисляване",
  "Освободена доставка по чл. 38 ЗДДС",
  "Освободена доставка по чл. 39 ЗДДС",
] as const;

export const DEFAULT_VAT_EXEMPTION_REASON = VAT_EXEMPTION_REASONS[0];
