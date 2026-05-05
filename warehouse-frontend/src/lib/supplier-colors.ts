// Deterministic supplier → color mapping. Used for the small dot next
// to the supplier name in the notes list.

const PALETTE = [
  { name: "amber", bg: "#f59e0b" },
  { name: "blue", bg: "#3b82f6" },
  { name: "pink", bg: "#ec4899" },
  { name: "emerald", bg: "#10b981" },
  { name: "violet", bg: "#8b5cf6" },
  { name: "rose", bg: "#f43f5e" },
  { name: "cyan", bg: "#06b6d4" },
  { name: "lime", bg: "#84cc16" },
] as const;

export type SupplierColor = (typeof PALETTE)[number];

export function colorForSupplier(supplierId: number): SupplierColor {
  // Deterministic — same supplier always gets same color across reloads.
  const idx = Math.abs(supplierId) % PALETTE.length;
  return PALETTE[idx];
}
