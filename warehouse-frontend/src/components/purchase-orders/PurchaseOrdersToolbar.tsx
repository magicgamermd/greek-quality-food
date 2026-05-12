import { Search } from "lucide-react";

export type PeriodFilter = "today" | "this-week" | "this-month" | "all";
export type StatusFilter = "" | "note" | "draft" | "sent" | "received";

interface ToolbarProps {
  period: PeriodFilter;
  status: StatusFilter;
  search: string;
  counts: Record<StatusFilter, number>;
  onPeriod: (p: PeriodFilter) => void;
  onStatus: (s: StatusFilter) => void;
  onSearch: (q: string) => void;
}

const PERIODS: { key: PeriodFilter; label: string }[] = [
  { key: "today", label: "Днес" },
  { key: "this-week", label: "Тази седмица" },
  { key: "this-month", label: "Този месец" },
  { key: "all", label: "Всички" },
];

const STATUSES: { key: StatusFilter; label: string }[] = [
  { key: "", label: "Всички" },
  { key: "note", label: "Бележки" },
  { key: "draft", label: "Чернови" },
  { key: "sent", label: "Изпратени" },
  { key: "received", label: "Получени" },
];

export function PurchaseOrdersToolbar({
  period,
  status,
  search,
  counts,
  onPeriod,
  onStatus,
  onSearch,
}: ToolbarProps) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-3.5 items-center pb-3.5 mb-3.5 border-b border-gray-100">
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold mr-1">
          Период
        </span>
        {PERIODS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => onPeriod(p.key)}
            className={pillClass(period === p.key)}
          >
            {p.label}
          </button>
        ))}
        <span className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold ml-3 mr-1">
          Статус
        </span>
        {STATUSES.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => onStatus(s.key)}
            className={pillClass(status === s.key)}
          >
            {s.label}
            <span className="ml-1 opacity-70 font-normal">{counts[s.key]}</span>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5 bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 w-60">
        <Search className="w-4 h-4 text-gray-400" />
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Търси продукт или доставчик…"
          className="bg-transparent outline-none flex-1 text-sm text-gray-900 placeholder:text-gray-400"
        />
      </div>
    </div>
  );
}

function pillClass(active: boolean) {
  return (
    "px-3 py-1 rounded-full text-xs font-medium border transition-colors " +
    (active
      ? "bg-[#6c3dff] text-white border-[#6c3dff]"
      : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50")
  );
}
