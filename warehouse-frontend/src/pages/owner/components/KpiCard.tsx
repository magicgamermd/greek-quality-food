import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

export function KpiCard({
  label,
  value,
  valueSub,
  deltaPct,
  accent = "blue",
  icon,
}: {
  label: string;
  value: string;
  valueSub?: string;
  deltaPct?: number | null;
  accent?: "blue" | "green" | "amber" | "red";
  icon?: React.ReactNode;
}) {
  const accentClass = {
    blue: "text-[#4f7cff]",
    green: "text-[#25c38b]",
    amber: "text-[#ffb454]",
    red: "text-[#ff6b8a]",
  }[accent];

  const deltaSign =
    deltaPct === null || deltaPct === undefined
      ? "neutral"
      : deltaPct > 0.5
        ? "up"
        : deltaPct < -0.5
          ? "down"
          : "neutral";

  const DeltaIcon =
    deltaSign === "up"
      ? ArrowUpRight
      : deltaSign === "down"
        ? ArrowDownRight
        : Minus;
  const deltaColor = {
    up: "text-[#25c38b]",
    down: "text-[#ff6b8a]",
    neutral: "text-[#9aa8d6]",
  }[deltaSign];

  return (
    <div className="rounded-2xl border border-[#243055] bg-[#12162a] p-4 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-[#9aa8d6] uppercase tracking-wide">
          {label}
        </span>
        {icon ? <span className={accentClass}>{icon}</span> : null}
      </div>
      <div className={cn("text-2xl font-bold", accentClass)}>{value}</div>
      {valueSub ? (
        <div className="text-xs text-[#9aa8d6] mt-0.5">{valueSub}</div>
      ) : null}
      {deltaPct !== null && deltaPct !== undefined ? (
        <div className={cn("flex items-center gap-1 mt-2 text-xs", deltaColor)}>
          <DeltaIcon className="h-3.5 w-3.5" />
          <span>
            {deltaSign === "up" ? "+" : ""}
            {deltaPct.toFixed(1)}%
          </span>
          <span className="text-[#6b7692]">vs предишен</span>
        </div>
      ) : null}
    </div>
  );
}
