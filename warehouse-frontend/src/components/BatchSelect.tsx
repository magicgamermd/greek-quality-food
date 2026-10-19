import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Select } from "@/components/ui/select";
import { displayBatchNumber, formatDate, isoDateToday } from "@/lib/utils";

/**
 * GQF избор на партида за ред от поръчка. Greek Quality Food продава
 * нетрайни хранителни стоки → всяка партида има срок на годност.
 *
 * Опциите идват от GET /batches/available?product_id=X — наличността в
 * склада, подредена по срок. Изтеклите се показват неактивни и червени,
 * до 30 дни — кехлибарено.
 *
 * `Batch` по-долу е записът от GET /batches (страница Склад).
 */

export interface Batch {
  id: number;
  product_id: number;
  batch_number: string | null;
  expiry_date: string | null;
  quantity: number | string;
  // Произход — доставката, създала партидата (NULL за начална наличност)
  source_invoice_number?: string | null;
  source_invoice_date?: string | null;
  source_received_date?: string | null;
  source_supplier_name?: string | null;
}

const EXPIRY_WARNING_DAYS = 30;

/** True if the batch is past its expiry date (cannot be sold). */
export function isBatchExpired(expiryDate: string | null | undefined): boolean {
  if (!expiryDate) return false;
  const expiry = expiryDate.slice(0, 10);
  return expiry < isoDateToday();
}

/** True if the batch expires within the next EXPIRY_WARNING_DAYS days. */
export function isBatchExpiringSoon(
  expiryDate: string | null | undefined,
): boolean {
  if (!expiryDate) return false;
  const expiry = expiryDate.slice(0, 10);
  const today = isoDateToday();
  if (expiry < today) return false;
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + EXPIRY_WARNING_DAYS);
  return expiry <= cutoff.toISOString().slice(0, 10);
}

/** Tailwind class for an expiry date: red if expired, amber if <30d. */
export function expiryColorClass(
  expiryDate: string | null | undefined,
): string {
  if (isBatchExpired(expiryDate)) return "text-red-600";
  if (isBatchExpiringSoon(expiryDate)) return "text-amber-600";
  return "text-gray-700";
}

/** Партида, от която реално може да се изпише (наличност в склад 1). */
export interface AvailableBatch {
  id: number;
  product_id: number;
  batch_number: string | null;
  expiry_date: string | null;
  /** Наличност в склада (inventory), не броячът на партидата. */
  available: number | string;
  source_invoice_number?: string | null;
  source_received_date?: string | null;
  source_supplier_name?: string | null;
}

/**
 * Партидите на продукта с наличност в склада — същото, от което изписва
 * сървърът (GET /batches/available). Подредени по срок, най-ранният първи.
 * Никога не тегли без productId.
 */
export function useAvailableBatches(productId: string) {
  const query = useQuery({
    queryKey: ["batches", "available", productId],
    enabled: !!productId,
    // Наличността се мени с всяко изпълнение — при всяко отваряне наново.
    staleTime: 0,
    queryFn: async () => {
      const res = await api.get<{ data: AvailableBatch[] }>(
        "/batches/available",
        { params: { product_id: Number(productId) } },
      );
      return res.data.data ?? [];
    },
  });

  const batches = useMemo(() => query.data ?? [], [query.data]);

  /** Автоматичният избор при изпълнение: първата неизтекла (FEFO). */
  const fefoBatch = useMemo(
    () => batches.find((batch) => !isBatchExpired(batch.expiry_date)) ?? null,
    [batches],
  );

  return { ...query, batches, fefoBatch };
}

function batchLabel(batch: AvailableBatch): string {
  const qty = Number(batch.available);
  // Служебните лотове (АВТО-*/НАЧАЛНО — създадени при доставка без въведен
  // номер) нямат човешки номер: за касиера идентичността на лота Е срокът
  // на годност. Реално въведените номера се показват както досега.
  const realNumber = displayBatchNumber(batch.batch_number);
  if (realNumber) {
    const expiry = batch.expiry_date
      ? formatDate(batch.expiry_date)
      : "без срок";
    return `${realNumber} · ${expiry} · ${qty}`;
  }
  if (batch.expiry_date) {
    return `Срок ${formatDate(batch.expiry_date)} · ${qty}`;
  }
  return `Лот #${batch.id} · без срок · ${qty}`;
}

/**
 * Стойност на селекта за ред от редактирана поръчка, който пази досегашното
 * си разпределение по партиди (order_item_batches). Не е id на партида.
 */
export const KEPT_BATCHES_VALUE = "kept";

/** Една досегашна част от реда: колко е изписано от коя партида. */
export interface KeptBatchAllocation {
  batch_id: number;
  batch_number: string | null;
  expiry_date: string | null;
  quantity: number;
}

function allocationName(
  allocation: Pick<
    KeptBatchAllocation,
    "batch_id" | "batch_number" | "expiry_date"
  >,
): string {
  return (
    displayBatchNumber(allocation.batch_number) ??
    (allocation.expiry_date
      ? `срок ${formatDate(allocation.expiry_date)}`
      : `лот #${allocation.batch_id}`)
  );
}

/**
 * Надпис за досегашното разпределение: една партида → номер и срок;
 * няколко → „2 партиди: 00170926 (0.5) + 00250926 (2.5)“.
 */
function keptAllocationsLabel(allocations: KeptBatchAllocation[]): string {
  if (allocations.length === 1) {
    const [only] = allocations;
    const expiry = only.expiry_date ? formatDate(only.expiry_date) : "без срок";
    return `${allocationName(only)} · ${expiry} · в поръчката`;
  }
  const parts = allocations
    .map(
      (allocation) => `${allocationName(allocation)} (${allocation.quantity})`,
    )
    .join(" + ");
  return `${allocations.length} партиди: ${parts}`;
}

/** Стойност на селекта: „Разпредели по партиди…“ (отваря прозореца). */
export const SPLIT_BATCHES_VALUE = "__split__";
/** Стойност на селекта: редът вече има избрано разпределение по партиди. */
export const PLAN_BATCHES_VALUE = "__plan__";

/** Една част от избраното разпределение: колко от коя партида. */
export interface PlannedBatch {
  batch_id: number;
  quantity: number;
  batch_number: string | null;
  expiry_date: string | null;
}

/** „2 партиди: 00151226 (7.2) + 00081026 (2.8)“ */
function planLabel(plan: PlannedBatch[]): string {
  const parts = plan
    .map((part) => `${allocationName(part)} (${part.quantity})`)
    .join(" + ");
  return `${plan.length} партиди: ${parts}`;
}

interface BatchSelectProps {
  productId: string;
  /**
   * Избраната партида (id като низ). "" = автоматично — при изпълнение
   * програмата взима най-ранния срок (FEFO).
   */
  value: string;
  /**
   * Извиква се с избраната партида ("" = автоматично) и срока за показване.
   * При „автоматично“ срокът е на партидата, която FEFO би взел —
   * само за информация, нищо не се фиксира.
   */
  onChange: (batchId: string, expiryDate: string) => void;
  disabled?: boolean;
  /**
   * Редакция: досегашното разпределение на реда. Показва се като опция
   * KEPT_BATCHES_VALUE, дори партидите вече да са на нула — стоката им е
   * в тази поръчка и се връща при запис.
   */
  keptAllocations?: KeptBatchAllocation[];
  /** Избраното разпределение по 2+ партиди (ако има). */
  plan?: PlannedBatch[];
  /** „Разпредели по партиди…“ — родителят отваря прозореца. */
  onSplitRequest?: () => void;
}

/**
 * Изборът на партида за ред от поръчка (създаване и редакция).
 *
 * До 19.10.2026 менюто сам предизбираше най-старата партида, а сървърът
 * игнорираше избора — при изпълнение пак вземаше най-старата. Поръчка №363
 * излезе с партида на хартия, различна от изписаната. Сега:
 *   • „Автоматично“ (по подразбиране) — както досега, FEFO при изпълнение;
 *   • избрана партида — изписва се точно тя;
 *   • „Разпредели по партиди…“ — от няколко партиди, с количество от всяка.
 */
export function BatchSelect({
  productId,
  value,
  onChange,
  disabled,
  keptAllocations,
  plan,
  onSplitRequest,
}: BatchSelectProps) {
  const hasKept = !!keptAllocations && keptAllocations.length > 0;
  const hasPlan = !!plan && plan.length > 1;
  const { batches, fefoBatch, isLoading, isError } =
    useAvailableBatches(productId);

  // „Автоматично“: показваме срока на партидата, която FEFO би взел, без
  // да я фиксираме. Синхронизация на производна стойност към реда — не е
  // теглене на данни (React Query държи заявката горе).
  useEffect(() => {
    if (!productId || isLoading || value !== "" || hasPlan) return;
    onChange("", fefoBatch?.expiry_date ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, isLoading, value, hasPlan, fefoBatch?.id]);

  // Заредени редове (редакция) идват с batch_id, но БЕЗ срока на лота —
  // щом опциите пристигнат, подаваме срока на вече избрания лот нагоре.
  const chosenExpiry = useMemo(() => {
    if (!value) return null;
    const chosen = batches.find((batch) => String(batch.id) === value);
    return chosen ? (chosen.expiry_date ?? "") : null;
  }, [batches, value]);
  useEffect(() => {
    if (!productId || isLoading || !value) return;
    if (chosenExpiry == null) return;
    onChange(value, chosenExpiry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, isLoading, value, chosenExpiry]);

  if (!productId) {
    return <span className="text-xs text-gray-400">—</span>;
  }

  if (isLoading) {
    // House style: lightweight skeleton placeholder, not a spinner.
    return <div className="h-9 w-full animate-pulse rounded-md bg-gray-100" />;
  }

  if (isError) {
    return <span className="text-xs text-red-500">грешка при зареждане</span>;
  }

  if (batches.length === 0 && !hasKept && !hasPlan) {
    // No stock → leave batch_id empty; backend decides (back-order for
    // paid lines, or a clean 400). Do NOT hard-block here.
    return <span className="text-xs text-gray-400">няма налична партида</span>;
  }

  const selectValue = hasPlan ? PLAN_BATCHES_VALUE : value;
  const autoLabel = fefoBatch
    ? `Автоматично · ${batchLabel(fefoBatch)}`
    : "Автоматично";

  // Клетката е тясна — пълният надпис на избраното се вижда при посочване.
  const selectedBatch = batches.find((batch) => String(batch.id) === value);
  const selectedLabel = hasPlan
    ? planLabel(plan!)
    : value === KEPT_BATCHES_VALUE && keptAllocations?.length
      ? keptAllocationsLabel(keptAllocations)
      : selectedBatch
        ? batchLabel(selectedBatch)
        : autoLabel;

  return (
    <Select
      value={selectValue}
      disabled={disabled}
      className="text-xs"
      title={selectedLabel}
      aria-label="Избор на партида"
      onChange={(event) => {
        const id = event.target.value;
        if (id === SPLIT_BATCHES_VALUE) {
          // Само отваря прозореца — изборът се сменя, когато го запазят.
          onSplitRequest?.();
          return;
        }
        if (id === PLAN_BATCHES_VALUE) return;
        if (id === KEPT_BATCHES_VALUE && keptAllocations?.[0]) {
          onChange(id, keptAllocations[0].expiry_date ?? "");
          return;
        }
        if (id === "") {
          onChange("", fefoBatch?.expiry_date ?? "");
          return;
        }
        const chosen = batches.find((batch) => String(batch.id) === id);
        onChange(id, chosen?.expiry_date ?? "");
      }}
    >
      {hasPlan && (
        <option value={PLAN_BATCHES_VALUE}>{planLabel(plan!)}</option>
      )}
      {hasKept && (
        <option value={KEPT_BATCHES_VALUE}>
          {keptAllocationsLabel(keptAllocations!)}
        </option>
      )}
      <option value="">{autoLabel}</option>
      {batches.map((batch) => {
        const expired = isBatchExpired(batch.expiry_date);
        return (
          <option
            key={batch.id}
            value={String(batch.id)}
            disabled={expired}
            className={
              expired
                ? "text-red-600"
                : isBatchExpiringSoon(batch.expiry_date)
                  ? "text-amber-600"
                  : ""
            }
          >
            {batchLabel(batch)}
            {expired ? " · ИЗТЕКЛА" : ""}
          </option>
        );
      })}
      {onSplitRequest && (
        <option value={SPLIT_BATCHES_VALUE}>Разпредели по партиди…</option>
      )}
    </Select>
  );
}
