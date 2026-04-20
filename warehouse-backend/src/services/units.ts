// Shared unit-of-measure mapping for all document PDFs.
// Maps internal (English/catalog) unit codes to Bulgarian display form.
export const UNIT_MAP: Record<string, string> = {
  kg: "кг.",
  pcs: "бр.",
  pc: "бр.",
  l: "л.",
  g: "г.",
  mg: "мг.",
  ml: "мл.",
  box: "кутия",
  carton: "кашон",
  case: "кашон",
  pack: "пакет",
  bottle: "бутилка",
  tin: "кутия",
  jar: "буркан",
};

export function mapUnit(unit?: string | null): string {
  const normalized = String(unit ?? "").trim();
  if (!normalized) return "бр.";
  return UNIT_MAP[normalized.toLowerCase()] || normalized;
}
