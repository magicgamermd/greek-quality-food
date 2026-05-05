import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { getHoliday, isPast, isWeekend, toIsoDate } from "@/lib/bgCalendar";

export interface WorkingDayPickerRoute {
  receiverCity: string;
  receiverPostCode?: string;
  receiverOfficeCode?: string;
  receiverStreet?: string;
  receiverNum?: string;
  weight: number;
}

export interface WorkingDayPickerProps {
  /** ISO YYYY-MM-DD or empty. */
  value: string;
  onChange: (iso: string) => void;
  /** When provided, opening the picker pre-validates the visible month
   *  through `/econt/validate-shipment-date`. If absent, only static rules
   *  (past/weekend/BG holiday) gate the calendar. */
  econtRoute?: WorkingDayPickerRoute | null;
  apiBaseUrl?: string;
  token?: string;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}

interface ValidateResp {
  valid: boolean;
  reason?: string;
}

async function fetchValidation(
  apiBaseUrl: string,
  token: string,
  route: WorkingDayPickerRoute,
  date: string,
): Promise<ValidateResp> {
  const r = await fetch(`${apiBaseUrl}/econt/validate-shipment-date`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...route, date }),
  });
  if (!r.ok) return { valid: false, reason: `HTTP ${r.status}` };
  return r.json();
}

const WEEKDAY_LABELS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const MONTH_NAMES = [
  "Януари",
  "Февруари",
  "Март",
  "Април",
  "Май",
  "Юни",
  "Юли",
  "Август",
  "Септември",
  "Октомври",
  "Ноември",
  "Декември",
];

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function buildGrid(monthStart: Date): Date[] {
  // Build a 6×7 grid starting from the Monday on/before the 1st.
  const grid: Date[] = [];
  const firstWeekday = monthStart.getDay(); // 0=Sun
  // Shift to ISO week (Monday = 0).
  const offset = firstWeekday === 0 ? 6 : firstWeekday - 1;
  const cursor = new Date(monthStart);
  cursor.setDate(cursor.getDate() - offset);
  for (let i = 0; i < 42; i++) {
    grid.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return grid;
}

export function WorkingDayPicker({
  value,
  onChange,
  econtRoute,
  apiBaseUrl = "/api",
  token,
  disabled,
  className,
  placeholder = "Избери дата",
}: WorkingDayPickerProps) {
  const [open, setOpen] = useState(false);
  const [viewDate, setViewDate] = useState(() => {
    if (value) {
      const d = new Date(value);
      if (!isNaN(d.getTime())) return startOfMonth(d);
    }
    return startOfMonth(new Date());
  });
  const [econtChecks, setEcontChecks] = useState<
    Record<string, ValidateResp | "loading">
  >({});
  const popRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const grid = useMemo(() => buildGrid(viewDate), [viewDate]);

  // Pre-validate the visible month through Econt when route + token are
  // both available. Office mode is skipped (backend short-circuits to
  // valid). Address mode validates ALL future dates including weekends —
  // the courier service Econt offers for some routes does include
  // Saturday/Sunday pickup, so static weekend exclusion would mislead
  // the user. Each call is cached server-side for 24h.
  useEffect(() => {
    if (!open || !econtRoute || !token || !econtRoute.weight) return;
    // Skip pre-validation for office delivery — Econt accepts every date
    // for any valid office, so the API calls would be pure noise.
    if (econtRoute.receiverOfficeCode) return;
    const candidates = grid.filter(
      (d) => d.getMonth() === viewDate.getMonth() && !isPast(d),
    );
    let cancelled = false;
    const next: typeof econtChecks = { ...econtChecks };
    for (const d of candidates) {
      const iso = toIsoDate(d);
      if (next[iso] !== undefined) continue;
      next[iso] = "loading";
    }
    setEcontChecks(next);
    Promise.all(
      candidates.map(async (d) => {
        const iso = toIsoDate(d);
        if (econtChecks[iso] && econtChecks[iso] !== "loading")
          return [iso, econtChecks[iso]] as const;
        try {
          const res = await fetchValidation(apiBaseUrl, token, econtRoute, iso);
          return [iso, res] as const;
        } catch {
          return [iso, { valid: true }] as const; // soft-fail to selectable
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setEcontChecks((prev) => {
        const merged = { ...prev };
        for (const [iso, res] of results) merged[iso] = res;
        return merged;
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    viewDate.getFullYear(),
    viewDate.getMonth(),
    econtRoute?.receiverCity,
    econtRoute?.receiverOfficeCode,
    econtRoute?.receiverStreet,
    econtRoute?.receiverNum,
    econtRoute?.weight,
    token,
  ]);

  const formatBg = (iso: string): string => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("bg-BG", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
  };

  return (
    <div className={`relative ${className ?? ""}`} ref={popRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white hover:border-gray-400 disabled:bg-gray-50 disabled:text-gray-400"
      >
        <span className={value ? "text-gray-900" : "text-gray-400"}>
          {value ? formatBg(value) : placeholder}
        </span>
        <Calendar className="h-4 w-4 text-gray-400" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-72 rounded-lg border border-gray-200 bg-white shadow-lg p-3">
          {/* Month nav */}
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={() =>
                setViewDate(
                  new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1),
                )
              }
              className="p-1 rounded hover:bg-gray-100"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="text-sm font-medium">
              {MONTH_NAMES[viewDate.getMonth()]} {viewDate.getFullYear()}
            </div>
            <button
              type="button"
              onClick={() =>
                setViewDate(
                  new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1),
                )
              }
              className="p-1 rounded hover:bg-gray-100"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Weekday headers */}
          <div className="grid grid-cols-7 gap-1 text-[10px] uppercase tracking-wide text-gray-400 mb-1">
            {WEEKDAY_LABELS.map((w) => (
              <div key={w} className="text-center py-1">
                {w}
              </div>
            ))}
          </div>

          {/* Grid */}
          <div className="grid grid-cols-7 gap-1">
            {grid.map((d) => {
              const iso = toIsoDate(d);
              const inMonth = d.getMonth() === viewDate.getMonth();
              // Hard blockers: only past dates are unconditionally
              // blocked. Weekends and BG holidays are advisory only —
              // Econt actually offers Sat/Sun courier service for some
              // routes, so static blocking would over-restrict. Econt's
              // own validation result decides for the rest.
              const past = isPast(d);
              const econtState = econtChecks[iso];
              const econtReason =
                econtState && econtState !== "loading" && !econtState.valid
                  ? econtState.reason || "Еконт отказва тази дата"
                  : null;
              const isSelected = value === iso;
              const isLoading = econtState === "loading";
              const blocked = past || !!econtReason;

              // Visual hints (greyed but still selectable):
              const holidayName = getHoliday(d);
              const weekend = isWeekend(d);
              const advisory = holidayName ?? (weekend ? "Уикенд" : null);

              const tooltip = past
                ? "Минала дата"
                : econtReason
                  ? `Еконт: ${econtReason}`
                  : (advisory ?? "");

              return (
                <button
                  key={iso}
                  type="button"
                  disabled={blocked || !inMonth}
                  title={tooltip}
                  onClick={() => {
                    if (blocked) return;
                    onChange(iso);
                    setOpen(false);
                  }}
                  className={[
                    "h-8 text-xs rounded relative flex items-center justify-center",
                    !inMonth ? "text-gray-300" : "",
                    blocked && inMonth
                      ? "text-gray-300 line-through cursor-not-allowed"
                      : "",
                    isSelected
                      ? "bg-[#f97316] text-white font-semibold"
                      : !blocked && inMonth
                        ? advisory
                          ? "hover:bg-orange-50 text-gray-500 italic"
                          : "hover:bg-orange-50 text-gray-900"
                        : "",
                  ].join(" ")}
                >
                  {d.getDate()}
                  {isLoading && (
                    <Loader2 className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 text-gray-300 animate-spin" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Legend */}
          <div className="mt-2 pt-2 border-t border-gray-100 text-[10px] text-gray-500 leading-relaxed">
            Зачертаните дни са минали или Еконт ги отказва за този маршрут.
            <span className="italic text-gray-400">
              {" "}
              Курсивни — почивни (събота / неделя / празник), но някои са
              достъпни за пратки според маршрута.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
