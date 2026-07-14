import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Select } from "@/components/ui/select";
import { displayBatchNumber, formatDate, isoDateToday } from "@/lib/utils";

/**
 * GQF batch picker for order lines. Greek Quality Food продава нетрайни
 * хранителни стоки → всяка партида има срок на годност и продаваме по
 * FEFO (First-Expired-First-Out). Този компонент заменя старата фалшива
 * "авто (FEFO)" клетка с реален избор на партида.
 *
 * Backend contract (GET /batches?product_id=X, ordered expiry_date ASC
 * NULLS LAST), отговор `{ data: Batch[], pagination }`. Показваме само
 * партиди с quantity > 0. Изтеклите партиди се рендерират disabled +
 * червено и не могат да се избират. Партиди до 30 дни — кехлибарено.
 */

export interface Batch {
  id: number;
  product_id: number;
  batch_number: string | null;
  expiry_date: string | null;
  quantity: number | string;
}

interface BatchListResponse {
  data: Batch[];
  pagination?: { page: number; limit: number; total: number };
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

/**
 * Fetches a product's available (quantity > 0) batches via React Query,
 * cached per product_id. Never fetches when productId is empty.
 */
export function useProductBatches(productId: string) {
  const query = useQuery({
    queryKey: ["batches", productId],
    enabled: !!productId,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await api.get<BatchListResponse>("/batches", {
        params: { product_id: Number(productId), limit: 100 },
      });
      return res.data.data ?? [];
    },
  });

  const batches = useMemo(
    () => (query.data ?? []).filter((batch) => Number(batch.quantity) > 0),
    [query.data],
  );

  /** FEFO suggestion: first non-expired batch (earliest expiry, NULLS last). */
  const fefoBatch = useMemo(
    () => batches.find((batch) => !isBatchExpired(batch.expiry_date)) ?? null,
    [batches],
  );

  return { ...query, batches, fefoBatch };
}

function batchLabel(batch: Batch): string {
  const qty = Number(batch.quantity);
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

interface BatchSelectProps {
  productId: string;
  /** Selected batch id (as string, matching the row's batch_id field). */
  value: string;
  /**
   * Called with the chosen batch id (string, "" when cleared) plus the
   * matching expiry_date so the caller can keep its row in sync.
   */
  onChange: (batchId: string, expiryDate: string) => void;
  disabled?: boolean;
}

/**
 * Reusable batch dropdown used by BOTH order forms (create + edit drawer).
 * Owns its own React Query fetch so Orders.tsx doesn't grow further.
 */
export function BatchSelect({
  productId,
  value,
  onChange,
  disabled,
}: BatchSelectProps) {
  const { batches, fefoBatch, isLoading, isError } =
    useProductBatches(productId);

  // FEFO default: when batches arrive and no batch is chosen yet, pre-select
  // the earliest non-expired batch. This syncs derived UI selection into the
  // parent row state — it is NOT data fetching (React Query owns that above).
  useEffect(() => {
    if (!productId || isLoading) return;
    if (value) return;
    if (fefoBatch) {
      onChange(String(fefoBatch.id), fefoBatch.expiry_date ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, isLoading, value, fefoBatch?.id]);

  // Заредени редове (редакция на поръчка) идват с batch_id, но БЕЗ срока
  // на лота → колоната „Годност" стоеше на „—". Щом опциите пристигнат,
  // подаваме срока на вече избрания лот нагоре (същият batch_id, само
  // expiry-то се попълва).
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

  if (batches.length === 0) {
    // No stock → leave batch_id empty; backend decides (back-order for
    // paid lines, or a clean 400). Do NOT hard-block here.
    return <span className="text-xs text-gray-400">няма налична партида</span>;
  }

  return (
    <Select
      value={value}
      disabled={disabled}
      className="text-xs"
      aria-label="Избор на партида"
      onChange={(event) => {
        const id = event.target.value;
        const chosen = batches.find((batch) => String(batch.id) === id);
        onChange(id, chosen?.expiry_date ?? "");
      }}
    >
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
    </Select>
  );
}
