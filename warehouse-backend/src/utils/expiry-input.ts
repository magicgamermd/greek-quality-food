// Нормализация на срок на годност от ВХОДНИ данни (OCR/ръчно) към
// 'YYYY-MM-DD' преди запис в DATE колона.
//
// Проблемът: хранителните етикети (гръцки доставчици) пишат дати в
// европейски формат ДД-ММ-ГГ („18-07-27" = 18 юли 2027), а Postgres при
// суров INSERT ги чете като ГГ-ММ-ДД → година 0018 → след корекция на
// века 2018 → прясна стока се води „изтекла".
//
// Правило: генерираме кандидат-тълкувания, валидираме календарно и
// избираме НАЙ-БЛИЗКАТА ДО ДНЕС БЪДЕЩА дата в прозореца
// [днес − 2 г., днес + 10 г.] (срок на годност е почти винаги напред;
// леко минал срок при доставка е легитимен). Ако никое тълкуване не е в
// прозореца → null (review gate-ът кара човека да въведе срока ръчно).
const WINDOW_PAST_YEARS = 2;
const WINDOW_FUTURE_YEARS = 10;

function isValidCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function normalizeExpiryInput(
  raw: unknown,
  todayIso?: string,
): string | null {
  if (raw == null) return null;

  if (raw instanceof Date) {
    let year = raw.getFullYear();
    if (year >= 0 && year < 100) year += 2000;
    return iso(year, raw.getMonth() + 1, raw.getDate());
  }

  const str = String(raw).trim();
  if (!str) return null;

  const today = todayIso ?? new Date().toISOString().slice(0, 10);
  const todayYear = Number(today.slice(0, 4));
  const windowMin = `${todayYear - WINDOW_PAST_YEARS}${today.slice(4)}`;
  const windowMax = `${todayYear + WINDOW_FUTURE_YEARS}${today.slice(4)}`;

  const candidates: string[] = [];
  const push = (y: number, m: number, d: number) => {
    if (isValidCalendarDate(y, m, d)) candidates.push(iso(y, m, d));
  };

  let m: RegExpMatchArray | null;

  // ISO с 4-цифрена година: 2027-03-31 / 2027.03.31 / 2027/03/31
  if ((m = str.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/))) {
    push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  // Европейски с 4-цифрена година: 31.03.2027 / 31-03-2027 / 31/03/2027
  else if ((m = str.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})$/))) {
    push(Number(m[3]), Number(m[2]), Number(m[1]));
  }
  // Трите полета по 1-2 цифри — двусмислено (ДД-ММ-ГГ или ГГ-ММ-ДД).
  else if ((m = str.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{1,2})$/))) {
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    // Европейско тълкуване (етикетите на храни): ДД-ММ-ГГ.
    push(2000 + c, b, a);
    // ISO кратко: ГГ-ММ-ДД.
    push(2000 + a, b, c);
  } else {
    return null;
  }

  const unique = [...new Set(candidates)];
  if (unique.length === 0) return null;

  const inWindow = unique.filter((d) => d >= windowMin && d <= windowMax);
  const pool = inWindow.length > 0 ? inWindow : [];
  if (pool.length === 0) return null;

  // Най-близката бъдеща (≥ днес); ако няма бъдеща — най-късната минала.
  const future = pool.filter((d) => d >= today).sort();
  if (future.length > 0) return future[0];
  return pool.sort().reverse()[0];
}
