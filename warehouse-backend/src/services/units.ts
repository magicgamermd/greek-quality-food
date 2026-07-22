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

// English display form — за документи на английски (?lang=en). Мапва и
// каталожни кодове, и български форми (products.unit понякога е на БГ).
export const UNIT_MAP_EN: Record<string, string> = {
  kg: "kg",
  "кг": "kg",
  "кг.": "kg",
  pcs: "pcs",
  pc: "pcs",
  "бр": "pcs",
  "бр.": "pcs",
  l: "l",
  "л": "l",
  "л.": "l",
  g: "g",
  "г": "g",
  "г.": "g",
  mg: "mg",
  ml: "ml",
  "мл": "ml",
  box: "box",
  "кутия": "box",
  carton: "carton",
  case: "carton",
  "кашон": "carton",
  pack: "pack",
  "пакет": "pack",
  bottle: "bottle",
  "бутилка": "bottle",
  tin: "tin",
  jar: "jar",
  "буркан": "jar",
};

export function mapUnitEn(unit?: string | null): string {
  const normalized = String(unit ?? "").trim();
  if (!normalized) return "pcs";
  return UNIT_MAP_EN[normalized.toLowerCase()] || normalized;
}
