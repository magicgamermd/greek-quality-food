// Дата като ДД.ММ.ГГГГ — срокът на годност в доставката. Родният календар
// на браузъра показва мм/дд/гггг на английски Chrome, а складът мисли в
// ДД.ММ.ГГГГ. Тук е само преводът между двата вида; полето е
// components/ui/smart-date-input.tsx.

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * „ДД.ММ.ГГГГ“ или „ДД.ММ.ГГ“ (ГГ → 20ГГ) → ISO `YYYY-MM-DD`; null за
 * непълна или невъзможна дата (31.02, 13-и месец).
 */
export function isoFromDottedDate(text: string): string | null {
  const match = String(text ?? "")
    .trim()
    .match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year =
    match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  return isRealDate(year, month, day) ? iso(year, month, day) : null;
}

/**
 * Каквото дойде отвън (ISO от базата или „18-07-27“ от сканиране) → ISO
 * или "", ако не е разпознаваема дата.
 */
export function toIsoDate(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const [y, m, d] = [
      Number(isoMatch[1]),
      Number(isoMatch[2]),
      Number(isoMatch[3]),
    ];
    return isRealDate(y, m, d) ? iso(y, m, d) : "";
  }
  return isoFromDottedDate(text) ?? "";
}

/** ISO `YYYY-MM-DD` → „ДД.ММ.ГГГГ“ (празно за празно/невалидно). */
export function dottedFromIso(value: string | null | undefined): string {
  const isoValue = toIsoDate(value);
  if (!isoValue) return "";
  const [y, m, d] = isoValue.split("-");
  return `${d}.${m}.${y}`;
}
