// Bulgarian working-day helpers.
// Hardcoded list of national holidays through 2027 — refresh annually.
// "Movable" feasts (Easter / Good Friday) follow Orthodox calendar, so they
// rotate yearly; the dates below are the official Държавен вестник values.

const BG_HOLIDAYS: Record<string, string> = {
  // 2026
  "2026-01-01": "Нова година",
  "2026-03-03": "Ден на Освобождението",
  "2026-04-10": "Велики петък",
  "2026-04-11": "Велика събота",
  "2026-04-12": "Великден",
  "2026-04-13": "Велики понеделник",
  "2026-05-01": "Ден на труда",
  "2026-05-06": "Гергьовден",
  "2026-05-24": "Ден на българската просвета и култура",
  "2026-09-06": "Ден на Съединението",
  "2026-09-22": "Ден на Независимостта",
  "2026-12-24": "Бъдни вечер",
  "2026-12-25": "Коледа",
  "2026-12-26": "Втори ден на Коледа",
  // 2027
  "2027-01-01": "Нова година",
  "2027-03-03": "Ден на Освобождението",
  "2027-04-30": "Велики петък",
  "2027-05-01": "Велика събота / Ден на труда",
  "2027-05-02": "Великден",
  "2027-05-03": "Велики понеделник",
  "2027-05-06": "Гергьовден",
  "2027-05-24": "Ден на българската просвета и култура",
  "2027-09-06": "Ден на Съединението",
  "2027-09-22": "Ден на Независимостта",
  "2027-12-24": "Бъдни вечер",
  "2027-12-25": "Коледа",
  "2027-12-26": "Втори ден на Коледа",
};

export function toIsoDate(d: Date): string {
  // Local-tz YYYY-MM-DD (avoid UTC-shift).
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

export function getHoliday(d: Date): string | null {
  return BG_HOLIDAYS[toIsoDate(d)] ?? null;
}

export function isWorkingDay(d: Date): boolean {
  if (isWeekend(d)) return false;
  if (getHoliday(d)) return false;
  return true;
}

export function isPast(d: Date, now: Date = new Date()): boolean {
  // Compare by day, not by time — a date with 00:00 today is NOT past.
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return a.getTime() < b.getTime();
}

/** Reason a date should be greyed out, or null if it's selectable. */
export function nonWorkingReason(
  d: Date,
  now: Date = new Date(),
): string | null {
  if (isPast(d, now)) return "Минала дата";
  if (isWeekend(d)) return d.getDay() === 0 ? "Неделя" : "Събота";
  const holiday = getHoliday(d);
  if (holiday) return holiday;
  return null;
}
