import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type KeptBatchAllocation,
  type PlannedBatch,
  expiryColorClass,
  isBatchExpired,
  useAvailableBatches,
} from "@/components/BatchSelect";
import { displayBatchNumber, formatDate } from "@/lib/utils";

/**
 * „Разпредели по партиди“ — складът задава от кои партиди и колко да излезе
 * един ред: напр. 10 кг = 5 кг с годност 15.12 + 5 кг с 08.12. Точно това
 * се печата на търговския документ и точно то се изписва при изпълнение.
 *
 * Родителят го монтира само докато е отворен (key = редът), затова
 * началните стойности се четат веднъж — повторно рендериране не трие
 * написаното.
 */

interface BatchSplitDialogProps {
  productId: string;
  productName: string;
  unit: string;
  /** Количеството на реда — сумата по партиди трябва да е точно толкова. */
  quantity: number;
  /** Досегашното разпределение на реда (ако има). */
  initialPlan?: PlannedBatch[];
  /**
   * Редакция на изпълнена поръчка: изписаното по този ред. При запис то се
   * връща в склада, затова се брои като налично за реда.
   */
  keptAllocations?: KeptBatchAllocation[];
  /** Празен списък = „автоматично“. */
  onSave: (plan: PlannedBatch[]) => void;
  onClose: () => void;
}

interface SplitRow {
  batch_id: number;
  batch_number: string | null;
  expiry_date: string | null;
  /** Колко може да се вземе за този ред. */
  available: number;
  expired: boolean;
  /** Вече изписана по този ред (редакция) — изтекла или не, връща се. */
  kept: boolean;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const parseQty = (raw: string | undefined) => {
  const parsed = parseFloat(String(raw ?? "").replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? round3(parsed) : 0;
};

export function BatchSplitDialog({
  productId,
  productName,
  unit,
  quantity,
  initialPlan,
  keptAllocations,
  onSave,
  onClose,
}: BatchSplitDialogProps) {
  const { batches, isLoading, isError } = useAvailableBatches(productId);
  // Досегашното разпределение, иначе изписаното по реда (редакция).
  const [entered, setEntered] = useState<Record<number, string>>(() => {
    const source =
      initialPlan && initialPlan.length > 0
        ? initialPlan
        : (keptAllocations ?? []);
    return Object.fromEntries(
      source.map((part) => [part.batch_id, String(part.quantity)]),
    );
  });

  // Наличното за реда = в склада + изписаното по него (при редакция).
  const rows: SplitRow[] = useMemo(() => {
    const kept = new Map<number, KeptBatchAllocation>();
    for (const allocation of keptAllocations ?? []) {
      kept.set(allocation.batch_id, allocation);
    }
    const byId = new Map<number, SplitRow>();
    for (const batch of batches) {
      byId.set(batch.id, {
        batch_id: batch.id,
        batch_number: batch.batch_number,
        expiry_date: batch.expiry_date,
        available: round3(
          Number(batch.available) + (kept.get(batch.id)?.quantity ?? 0),
        ),
        expired: isBatchExpired(batch.expiry_date),
        kept: kept.has(batch.id),
      });
    }
    for (const allocation of kept.values()) {
      if (byId.has(allocation.batch_id)) continue;
      // Изписана изцяло по този ред — в склада е на нула, но се връща.
      byId.set(allocation.batch_id, {
        batch_id: allocation.batch_id,
        batch_number: allocation.batch_number,
        expiry_date: allocation.expiry_date,
        available: allocation.quantity,
        expired: isBatchExpired(allocation.expiry_date),
        kept: true,
      });
    }
    return [...byId.values()].sort((a, b) =>
      String(a.expiry_date ?? "9999").localeCompare(
        String(b.expiry_date ?? "9999"),
      ),
    );
  }, [batches, keptAllocations]);

  const total = round3(
    rows.reduce((sum, row) => sum + parseQty(entered[row.batch_id]), 0),
  );
  const remaining = round3(quantity - total);
  const exact = Math.abs(remaining) < 0.0005;
  const overAvailable = rows.filter(
    (row) => parseQty(entered[row.batch_id]) > row.available + 0.0005,
  );
  // Изтекла партида — само ако вече е по реда (сървърът не проверява срока
  // до изписаното количество).
  const usesExpired = rows.filter(
    (row) => row.expired && !row.kept && parseQty(entered[row.batch_id]) > 0,
  );
  const canSave =
    exact &&
    overAvailable.length === 0 &&
    usesExpired.length === 0 &&
    !isLoading;

  const fillRest = (row: SplitRow) => {
    const others = round3(total - parseQty(entered[row.batch_id]));
    const rest = round3(
      Math.max(0, Math.min(row.available, quantity - others)),
    );
    setEntered((prev) => ({
      ...prev,
      [row.batch_id]: rest ? String(rest) : "",
    }));
  };

  const save = () => {
    const plan: PlannedBatch[] = rows
      .map((row) => ({
        batch_id: row.batch_id,
        quantity: parseQty(entered[row.batch_id]),
        batch_number: row.batch_number,
        expiry_date: row.expiry_date,
      }))
      .filter((part) => part.quantity > 0);
    onSave(plan);
  };

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : null)}>
      <DialogContent
        className="z-[60] sm:max-w-xl"
        // Клавишите остават тук — във формата на поръчката отдолу
        // Ctrl+Enter я записва.
        onKeyDown={(event) => event.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>Разпредели по партиди</DialogTitle>
          <DialogDescription>
            {productName} — общо{" "}
            <span className="font-semibold text-gray-800">
              {quantity} {unit}
            </span>
            . Колко да излезе от всяка партида: точно това се печата на
            търговския документ и се изписва при изпълнение.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex min-h-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) save();
          }}
        >
          {isLoading ? (
            <div className="h-24 animate-pulse rounded-md bg-gray-100" />
          ) : isError ? (
            <p className="text-sm text-red-600">Партидите не се заредиха.</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-gray-500">Няма налични партиди.</p>
          ) : (
            <div className="max-h-80 overflow-y-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Партида</th>
                    <th className="px-3 py-2 text-left font-medium">Годност</th>
                    <th className="px-3 py-2 text-right font-medium">
                      Налично
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      Количество
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const value = entered[row.batch_id] ?? "";
                    const tooMuch = parseQty(value) > row.available + 0.0005;
                    const locked = row.expired && !row.kept;
                    const name =
                      displayBatchNumber(row.batch_number) ?? "без номер";
                    return (
                      <tr
                        key={row.batch_id}
                        className={`border-t ${locked ? "bg-gray-50 text-gray-400" : ""}`}
                      >
                        <td className="px-3 py-2 font-mono text-xs">{name}</td>
                        <td
                          className={`px-3 py-2 text-xs whitespace-nowrap ${expiryColorClass(row.expiry_date)}`}
                        >
                          {row.expiry_date
                            ? formatDate(row.expiry_date)
                            : "без срок"}
                          {row.expired ? " · ИЗТЕКЛА" : ""}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {row.available}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-1">
                            <Input
                              type="number"
                              inputMode="decimal"
                              min={0}
                              step="0.001"
                              value={value}
                              disabled={locked}
                              aria-label={`Количество от партида ${name}`}
                              className={`h-8 w-24 text-right ${tooMuch ? "border-red-500" : ""}`}
                              onChange={(event) =>
                                setEntered((prev) => ({
                                  ...prev,
                                  [row.batch_id]: event.target.value,
                                }))
                              }
                            />
                            {!locked && (
                              <button
                                type="button"
                                className="text-xs text-violet-700 hover:underline"
                                onClick={() => fillRest(row)}
                                title="Попълни остатъка от тази партида"
                              >
                                остатъка
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div
            role="status"
            className={`text-sm ${
              canSave
                ? "text-green-700"
                : overAvailable.length > 0 || remaining < 0
                  ? "text-red-600"
                  : "text-amber-700"
            }`}
          >
            Разпределени {total} от {quantity} {unit}
            {!exact &&
              (remaining > 0
                ? ` — остават ${remaining}`
                : ` — над количеството с ${round3(-remaining)}`)}
            {overAvailable.length > 0 &&
              ` · ${overAvailable.length === 1 ? "една партида няма" : "партиди нямат"} толкова наличност`}
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onSave([])}
              title="Без избор — при изпълнение се взима най-ранният срок"
            >
              Автоматично
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Отказ
              </Button>
              <Button type="submit" disabled={!canSave}>
                Запази
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
