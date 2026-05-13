import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Package,
  PackageX,
  Plus,
  RefreshCw,
} from "lucide-react";
import { api } from "@/lib/api";
import type { Order } from "@/types";
import { formatCurrency, formatOrderTotal, formatDate } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

export interface PartnerHistoryItem {
  product_id: number;
  product_name: string;
  quantity: number;
  unit: string;
  unit_price: number;
  discount_percent: number;
  stock_now: number;
}

export interface PartnerHistoryDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partnerId: string;
  partnerName: string;
  currentProductIds: Set<number>;
  onAddItem: (item: PartnerHistoryItem) => void;
  onRepeatOrder: (items: PartnerHistoryItem[]) => void;
}

const PAGE_SIZE = 20;

interface OrderDetailResponse {
  id: number;
  items: Array<{
    product_id: number;
    name_bg?: string;
    name_en?: string;
    unit?: string;
    quantity: number | string;
    unit_price: number | string;
    discount_percent?: number | string;
    total_stock?: number | string | null;
    product_is_deleted?: boolean;
  }>;
}

function parseNum(v: unknown): number {
  if (typeof v === "number") return v;
  const n = parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
}

function formatReplacementTotal(amount: number | null | undefined): string {
  const n = Number(amount ?? 0);
  if (Math.abs(n) < 0.005) return "0.00 лв";
  const abs = Math.abs(n).toLocaleString("bg-BG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (n > 0) return `+${abs} лв`;
  return `−${abs} лв`;
}

interface HistoryPage {
  data: Order[];
  pagination: { page: number; limit: number; total: number };
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Чакаща",
  confirmed: "Потвърдена",
  processing: "В обработка",
  fulfilled: "Изпълнена",
  invoiced: "Фактурирана",
  cancelled: "Анулирана",
};

const STATUS_COLOR: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  confirmed: "bg-blue-100 text-blue-800",
  processing: "bg-indigo-100 text-indigo-800",
  fulfilled: "bg-green-100 text-green-800",
  invoiced: "bg-purple-100 text-purple-800",
  cancelled: "bg-red-100 text-red-800",
};

export function PartnerHistoryDrawer({
  open,
  onOpenChange,
  partnerId,
  partnerName,
  currentProductIds,
  onAddItem,
  onRepeatOrder,
}: PartnerHistoryDrawerProps) {
  const numericPartnerId = Number(partnerId);
  const enabled =
    open && Number.isFinite(numericPartnerId) && numericPartnerId > 0;

  const {
    data,
    isLoading,
    isError,
    isPaused,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<HistoryPage>({
    queryKey: ["partner-history", numericPartnerId, PAGE_SIZE],
    queryFn: async ({ pageParam = 1 }) => {
      const res = await api.get(
        `/orders?partner_id=${numericPartnerId}&page=${pageParam}&limit=${PAGE_SIZE}`,
      );
      return res.data as HistoryPage;
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const { page, limit, total } = lastPage.pagination;
      return page * limit < total ? page + 1 : undefined;
    },
    enabled,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });

  const orders = useMemo<Order[]>(() => {
    const all = data?.pages.flatMap((p) => p.data) ?? [];
    return all.filter((o) => o.status !== "cancelled");
  }, [data]);

  // TanStack Query pauses queries (fetchStatus: "paused") on network failures
  // without transitioning to `isError`. Treat a paused-with-no-data state
  // as an error so the retry banner still surfaces when backend is offline.
  const showError = isError || (isPaused && !data);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col p-0">
        <SheetHeader>
          <SheetTitle>История на партньора</SheetTitle>
          <SheetDescription>
            {partnerName || "—"}
            {orders.length > 0 && (
              <span className="block text-xs text-gray-400 mt-1">
                {orders.length} {orders.length === 1 ? "поръчка" : "поръчки"}{" "}
                заредени
              </span>
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {isLoading && (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-20 bg-gray-100 rounded-lg animate-pulse"
                />
              ))}
            </div>
          )}

          {showError && (
            <div className="flex flex-col items-center text-center py-8">
              <AlertCircle className="h-10 w-10 text-red-400 mb-2" />
              <p className="text-sm text-red-700 mb-3">
                Грешка при зареждане на историята.
              </p>
              <button
                type="button"
                onClick={() => refetch()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gray-300 text-sm hover:bg-gray-50"
              >
                <RefreshCw className="h-4 w-4" />
                Опитай пак
              </button>
            </div>
          )}

          {!isLoading && !showError && orders.length === 0 && (
            <div className="flex flex-col items-center text-center py-12 text-gray-500">
              <PackageX className="h-12 w-12 mb-3 text-gray-300" />
              <p className="text-sm">Няма минали поръчки от този партньор.</p>
            </div>
          )}

          {!isLoading &&
            !showError &&
            orders.map((o) => (
              <OrderCard
                key={o.id}
                order={o}
                currentProductIds={currentProductIds}
                onAddItem={onAddItem}
                onRepeatOrder={onRepeatOrder}
              />
            ))}

          {hasNextPage && (
            <button
              type="button"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              className="w-full py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-md border border-gray-200 disabled:opacity-50"
            >
              {isFetchingNextPage ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner size="sm" /> Зареждане…
                </span>
              ) : (
                "Зареди още"
              )}
            </button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function OrderCard({
  order,
  currentProductIds,
  onAddItem,
  onRepeatOrder,
}: {
  order: Order;
  currentProductIds: Set<number>;
  onAddItem: (item: PartnerHistoryItem) => void;
  onRepeatOrder: (items: PartnerHistoryItem[]) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const statusLabel = STATUS_LABEL[order.status] ?? order.status;
  const statusColor = STATUS_COLOR[order.status] ?? "bg-gray-100 text-gray-700";

  const {
    data: detail,
    isLoading: detailLoading,
    isError: detailError,
  } = useQuery<OrderDetailResponse>({
    queryKey: ["partner-history-detail", order.id],
    queryFn: async () => {
      const res = await api.get(`/orders/${order.id}`);
      const raw = res.data?.data ?? res.data;
      if (!raw || !Array.isArray(raw.items)) {
        throw new Error("Невалиден отговор от сървъра (липсват артикули)");
      }
      return raw as OrderDetailResponse;
    },
    enabled: expanded,
    staleTime: 2 * 60_000,
    gcTime: 10 * 60_000,
  });

  const items: PartnerHistoryItem[] = useMemo(() => {
    if (!detail) return [];
    return detail.items.map((it) => ({
      product_id: it.product_id,
      product_name: it.name_bg || it.name_en || `Продукт #${it.product_id}`,
      quantity: parseNum(it.quantity),
      unit: it.unit || "бр.",
      unit_price: parseNum(it.unit_price),
      discount_percent: parseNum(it.discount_percent),
      stock_now: parseNum(it.total_stock),
    }));
  }, [detail]);

  const isReplacement = order.is_replacement === true;

  return (
    <div
      className={`rounded-lg border bg-white ${
        isReplacement ? "border-red-200" : "border-gray-200"
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`w-full px-4 py-3 flex items-start justify-between gap-3 text-left hover:bg-gray-50 ${
          isReplacement ? "text-red-700" : ""
        }`}
      >
        <div className="min-w-0 flex-1">
          <div
            className={`flex items-center gap-2 text-sm font-semibold ${
              isReplacement ? "text-red-700" : "text-gray-900"
            }`}
          >
            <Package
              className={`h-4 w-4 shrink-0 ${
                isReplacement ? "text-red-400" : "text-gray-400"
              }`}
            />
            <span>
              #{order.order_number ?? order.id} · {formatDate(order.order_date)}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs flex-wrap">
            {isReplacement ? (
              <span
                className="inline-flex items-center gap-0.5 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700"
                title="Замяна — двупосочно движение на стока"
              >
                🔄 Замяна
              </span>
            ) : (
              <span
                className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-700"
                title="Стандартна поръчка"
              >
                Поръчка
              </span>
            )}
            <span className={`px-2 py-0.5 rounded-full ${statusColor}`}>
              {statusLabel}
            </span>
            <span className="text-gray-500">
              {order.item_count ?? 0}{" "}
              {(order.item_count ?? 0) === 1 ? "артикул" : "артикула"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`text-sm font-semibold whitespace-nowrap ${
              isReplacement ? "text-red-700" : "text-gray-900"
            }`}
          >
            {isReplacement
              ? formatReplacementTotal(order.total_amount)
              : formatOrderTotal(order.total_amount)}
          </span>
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-gray-400" />
          ) : (
            <ChevronDown className="h-4 w-4 text-gray-400" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-200 px-4 py-3 space-y-2">
          {detailLoading && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Spinner size="sm" />
              Зареждане на артикули…
            </div>
          )}

          {detailError && (
            <div className="text-xs text-red-700">
              Грешка при зареждане на артикулите.
            </div>
          )}

          {!detailLoading && !detailError && items.length === 0 && (
            <div className="text-xs text-gray-500">Няма артикули.</div>
          )}

          {!detailLoading && !detailError && items.length > 0 && (
            <>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRepeatOrder(items);
                  }}
                  className="text-xs px-2.5 py-1 rounded-md border border-gray-300 hover:bg-gray-50"
                >
                  Повтори цялата поръчка
                </button>
              </div>
              <ul className="space-y-2">
                {items.map((it, idx) => {
                  const already = currentProductIds.has(it.product_id);
                  const outOfStock = it.stock_now <= 0;
                  const disabled = already || outOfStock;
                  const disabledReason = already
                    ? "Вече в поръчката"
                    : outOfStock
                      ? "Няма наличност"
                      : "";
                  return (
                    <li
                      key={`${it.product_id}-${idx}`}
                      className="flex items-start gap-2 text-sm"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-900 truncate">
                          {it.product_name}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {it.quantity} {it.unit} ×{" "}
                          {formatCurrency(it.unit_price)}
                          {it.discount_percent > 0 && (
                            <>
                              {" "}
                              · отст.{" "}
                              {it.discount_percent.toFixed(
                                it.discount_percent % 1 === 0 ? 0 : 2,
                              )}
                              %
                            </>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAddItem(it);
                        }}
                        disabled={disabled}
                        title={disabledReason || "Добави в поръчката"}
                        className="shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
