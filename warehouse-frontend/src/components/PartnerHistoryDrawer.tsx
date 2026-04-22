import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertCircle, Package, PackageX, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { Order } from "@/types";
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

interface HistoryPage {
  data: Order[];
  pagination: { page: number; limit: number; total: number };
}

function formatBGN(value: number | string | null | undefined): string {
  const num =
    typeof value === "number" ? value : parseFloat(String(value ?? 0));
  if (!Number.isFinite(num)) return "0,00 €";
  return `${num.toLocaleString("bg-BG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("bg-BG", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
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
}: PartnerHistoryDrawerProps) {
  const numericPartnerId = Number(partnerId);
  const enabled =
    open && Number.isFinite(numericPartnerId) && numericPartnerId > 0;

  const {
    data,
    isLoading,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<HistoryPage>({
    queryKey: ["partner-history", numericPartnerId],
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

          {isError && (
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

          {!isLoading && !isError && orders.length === 0 && (
            <div className="flex flex-col items-center text-center py-12 text-gray-500">
              <PackageX className="h-12 w-12 mb-3 text-gray-300" />
              <p className="text-sm">Няма минали поръчки от този партньор.</p>
            </div>
          )}

          {!isLoading &&
            !isError &&
            orders.map((o) => <OrderCard key={o.id} order={o} />)}

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

function OrderCard({ order }: { order: Order }) {
  const statusLabel = STATUS_LABEL[order.status] ?? order.status;
  const statusColor = STATUS_COLOR[order.status] ?? "bg-gray-100 text-gray-700";
  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="px-4 py-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            <Package className="h-4 w-4 text-gray-400 shrink-0" />
            <span>
              #{order.order_number ?? order.id} · {formatDate(order.order_date)}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs">
            <span className={`px-2 py-0.5 rounded-full ${statusColor}`}>
              {statusLabel}
            </span>
            <span className="text-gray-500">
              {order.item_count ?? 0}{" "}
              {(order.item_count ?? 0) === 1 ? "артикул" : "артикула"}
            </span>
          </div>
        </div>
        <div className="text-sm font-semibold text-gray-900 whitespace-nowrap">
          {formatBGN(order.total_amount)}
        </div>
      </div>
    </div>
  );
}
