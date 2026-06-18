import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Send,
  Package2,
  CheckCircle2,
  Banknote,
  Truck,
  Search,
  X,
  ExternalLink,
  Printer,
} from "lucide-react";
import { api } from "@/lib/api";
import { formatCurrency, formatDate, isoDateToday } from "@/lib/utils";
import { matchesAnyField } from "@/lib/translit";
import { HighlightMatch } from "@/lib/highlight";
import { useAuth } from "@/contexts/AuthContext";
import { EcontShippingPicker } from "@/components/EcontShippingPicker";
import type { EcontShippingValue } from "@/components/EcontShippingPicker";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingOverlay, ErrorMessage } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface EcontQueueItem {
  id: number;
  order_number: number;
  partner_name: string | null;
  econt_cod_amount: string | number | null;
  econt_shipment_number: string | null;
  econt_tracking_url: string | null;
  econt_pdf_url: string | null;
  econt_requested_at: string;
  created_at: string;
  paid: boolean;
  items: Array<{
    name: string;
    quantity: string | number;
    product_id: number;
    weight_kg: string | number | null;
  }>;
}

type Tab = "todo" | "shipped";

// ── Helpers ──────────────────────────────────────────────────────────────────

function codAmount(o: EcontQueueItem): number {
  return Number(o.econt_cod_amount ?? 0);
}

function trackingHref(o: EcontQueueItem): string {
  return (
    o.econt_tracking_url ||
    `https://www.econt.com/services/track-shipment/${o.econt_shipment_number}`
  );
}

/**
 * Статус бадж за Еконт реда — огледало на стила на статус-бейджите в
 * Поръчки (inline-flex pill с цветова рамка). Без цени — само логистичен
 * статус + (за наложен платеж) дали е събран.
 */
function EcontStatusBadge({ o }: { o: EcontQueueItem }) {
  const cod = codAmount(o);
  if (!o.econt_shipment_number) {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200">
        <Package2 className="h-3 w-3" />
        Чака товарителница
      </span>
    );
  }
  if (o.paid) {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200">
        <CheckCircle2 className="h-3 w-3" />
        Платено
      </span>
    );
  }
  if (cod > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200">
        <Banknote className="h-3 w-3" />
        Чака плащане
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md bg-sky-50 text-sky-700 border border-sky-200">
      <Truck className="h-3 w-3" />
      Изпратена
    </span>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export function EcontQueue() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("todo");
  const [filters, setFilters] = useState({
    order_number: "",
    partner: "",
    shipment: "",
  });
  const [detailOrder, setDetailOrder] = useState<EcontQueueItem | null>(null);

  // Date filter — същият механизъм като при Поръчки: default „днешни",
  // бутон „История" → single-day (На дата) или период (От–До).
  const todayIso = isoDateToday();
  const thirtyDaysAgoIso = new Date(Date.now() - 30 * 86_400_000)
    .toISOString()
    .split("T")[0];
  const [showHistory, setShowHistory] = useState(false);
  const [dateMode, setDateMode] = useState<"single" | "range">("single");
  const [singleDate, setSingleDate] = useState(todayIso);
  const [dateFrom, setDateFrom] = useState(thirtyDaysAgoIso);
  const [dateTo, setDateTo] = useState(todayIso);
  const activeDateFrom = showHistory
    ? dateMode === "single"
      ? singleDate
      : dateFrom
    : todayIso;
  const activeDateTo = showHistory
    ? dateMode === "single"
      ? singleDate
      : dateTo
    : todayIso;

  const { data, isLoading, error } = useQuery<EcontQueueItem[]>({
    queryKey: ["econt-queue"],
    queryFn: async () => {
      const res = await api.get("/orders/econt-queue");
      return res.data?.data ?? [];
    },
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  const orders = data ?? [];
  const todo = orders.filter((o) => !o.econt_shipment_number);
  const shipped = orders.filter((o) => o.econt_shipment_number);
  const tabOrders = tab === "todo" ? todo : shipped;

  // Client-side търсене по 3-те релевантни полета (№ поръчка, партньор,
  // № товарителница). Толерира БГ/латиница чрез matchesAnyField.
  const filtered = useMemo(
    () =>
      tabOrders.filter((o) => {
        if (
          filters.order_number.trim() &&
          !matchesAnyField(filters.order_number, [
            String(o.order_number ?? ""),
            String(o.id),
          ])
        )
          return false;
        if (
          filters.partner.trim() &&
          !matchesAnyField(filters.partner, [o.partner_name ?? ""])
        )
          return false;
        if (
          filters.shipment.trim() &&
          !matchesAnyField(filters.shipment, [o.econt_shipment_number ?? ""])
        )
          return false;
        // Date range (default = днешни доставки; История разширява обхвата).
        const iso = (o.econt_requested_at || o.created_at || "").slice(0, 10);
        if (activeDateFrom && iso && iso < activeDateFrom) return false;
        if (activeDateTo && iso && iso > activeDateTo) return false;
        return true;
      }),
    [tabOrders, filters, activeDateFrom, activeDateTo],
  );

  const hasActiveFilters = Object.values(filters).some((v) => v.trim());

  // Live row от свежите query данни (за да отрази create-waybill / mark-paid
  // без преотваряне). Ако поръчката ИЗЧЕЗНЕ от опашката докато drawer-ът е
  // отворен (анулирана другаде или Еконт-заявката е махната от Orders toggle),
  // detailLive става null → drawer-ът се затваря, вместо да показва остарял
  // snapshot върху който работникът може да действа. React Query пази data-та
  // по време на background refetch, така че няма да flick-не при обновяване.
  const detailLive = detailOrder
    ? (orders.find((o) => o.id === detailOrder.id) ?? null)
    : null;
  useEffect(() => {
    if (
      detailOrder &&
      !isLoading &&
      data &&
      !orders.some((o) => o.id === detailOrder.id)
    ) {
      setDetailOrder(null);
    }
  }, [detailOrder, isLoading, data, orders]);

  const markPaid = useMutation({
    mutationFn: async (order: EcontQueueItem) => {
      const amount = codAmount(order);
      // Инвариант: не записваме плащане от 0 лв (backend изисква positive
      // amount). Всички call site-ове вече gate-ват на cod > 0, но guard-ът
      // тук пази инварианта при мутацията, не само при извикването.
      if (amount <= 0) {
        toast.info("Няма наложен платеж за маркиране");
        return;
      }
      // Дата на плащане по Europe/Sofia (не UTC) — за коректен бизнес-ден.
      const today = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Europe/Sofia",
      }).format(new Date());
      await api.post("/payments", {
        order_id: order.id,
        amount,
        payment_method: "cod",
        paid_at: today,
      });
    },
    onSuccess: () => {
      toast.success("✅ Маркирано като платено");
      qc.invalidateQueries({ queryKey: ["econt-queue"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
    onError: (err: unknown) => {
      const e = err as {
        response?: { data?: { detail?: string; error?: string } };
        message?: string;
      };
      toast.error(
        e?.response?.data?.detail ||
          e?.response?.data?.error ||
          e?.message ||
          "Грешка",
      );
    },
  });

  return (
    <div className="p-6 space-y-6">
      {/* Header — същият стил като Поръчки */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Send className="h-6 w-6" /> Еконт доставки
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          Поръчки маркирани за Еконт доставка
        </p>
      </div>

      {/* Табове като pill-чиповете при Поръчки */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => setTab("todo")}
          className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
            tab === "todo"
              ? "bg-[#f97316] text-white"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          <Package2 className="h-3.5 w-3.5" />
          За обработка ({todo.length})
        </button>
        <button
          onClick={() => setTab("shipped")}
          className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
            tab === "shipped"
              ? "bg-[#f97316] text-white"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          Изпратени ({shipped.length})
        </button>
      </div>

      {/* Date filter — същият механизъм като при Поръчки: днешни по
          подразбиране + бутон „История" (На дата / Период). */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="font-medium text-gray-700">
          {showHistory
            ? "📋 История на доставките"
            : `📦 Днешни доставки — ${new Date().toLocaleDateString("bg-BG")}`}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {showHistory && (
            <>
              <div className="inline-flex rounded-md border border-gray-200 overflow-hidden text-xs">
                <button
                  type="button"
                  onClick={() => setDateMode("single")}
                  className={`px-2.5 py-1 transition-colors ${
                    dateMode === "single"
                      ? "bg-[#f97316] text-white font-medium"
                      : "bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  На дата
                </button>
                <button
                  type="button"
                  onClick={() => setDateMode("range")}
                  className={`px-2.5 py-1 transition-colors border-l border-gray-200 ${
                    dateMode === "range"
                      ? "bg-[#f97316] text-white font-medium"
                      : "bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  Период
                </button>
              </div>
              {dateMode === "single" ? (
                <div className="flex items-center gap-2 text-sm">
                  <label className="text-gray-500">Дата:</label>
                  <input
                    type="date"
                    value={singleDate}
                    onChange={(e) => setSingleDate(e.target.value)}
                    className="border rounded px-2 py-1 text-sm"
                  />
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm">
                  <label className="text-gray-500">От:</label>
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className="border rounded px-2 py-1 text-sm"
                  />
                  <label className="text-gray-500">До:</label>
                  <input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className="border rounded px-2 py-1 text-sm"
                  />
                </div>
              )}
            </>
          )}
          <button
            type="button"
            onClick={() => {
              if (!showHistory) {
                setDateMode("single");
                setSingleDate(todayIso);
              }
              setShowHistory((h) => !h);
            }}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              showHistory
                ? "bg-[#f97316] text-white"
                : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
            }`}
          >
            {showHistory ? "← Днес" : "📋 История"}
          </button>
        </div>
      </div>

      {/* Търсачки — 3 релевантни полета (като лентата при Поръчки) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-1.5">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400" />
          <Input
            value={filters.order_number}
            onChange={(e) =>
              setFilters((f) => ({ ...f, order_number: e.target.value }))
            }
            placeholder="№ поръчка"
            className="pl-7 h-8 text-xs"
          />
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400" />
          <Input
            value={filters.partner}
            onChange={(e) =>
              setFilters((f) => ({ ...f, partner: e.target.value }))
            }
            placeholder="Партньор"
            className="pl-7 h-8 text-xs"
          />
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400" />
          <Input
            value={filters.shipment}
            onChange={(e) =>
              setFilters((f) => ({ ...f, shipment: e.target.value }))
            }
            placeholder="№ товарителница"
            className="pl-7 h-8 text-xs"
          />
        </div>
      </div>

      {(hasActiveFilters || showHistory) && (
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <span>
            Намерени:{" "}
            <span className="font-medium text-gray-900">{filtered.length}</span>{" "}
            от {tabOrders.length}
          </span>
          <button
            type="button"
            onClick={() => {
              setFilters({ order_number: "", partner: "", shipment: "" });
              setShowHistory(false);
            }}
            className="flex items-center gap-1 text-xs text-red-600 hover:text-red-700"
          >
            <X className="h-3 w-3" />
            Изчисти филтрите
          </button>
        </div>
      )}

      {/* Таблица — същият layout като Поръчки, без цени/функционалности */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <LoadingOverlay />
          ) : error ? (
            <div className="p-4">
              <ErrorMessage message="Грешка при зареждане" />
            </div>
          ) : (
            <Table className="table-fixed [&_th]:px-2 [&_td]:px-2 [&_th]:py-2 [&_td]:py-3">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[44px]">№</TableHead>
                  <TableHead className="w-[200px]">Партньор</TableHead>
                  <TableHead className="w-[96px] whitespace-nowrap">
                    Дата
                  </TableHead>
                  <TableHead className="w-[120px]">Артикули</TableHead>
                  <TableHead className="w-[130px] whitespace-nowrap text-right">
                    Наложен платеж
                  </TableHead>
                  <TableHead className="w-[150px]">Статус</TableHead>
                  <TableHead className="w-[150px]">№ товарителница</TableHead>
                  <TableHead className="w-[150px] text-right">
                    Действия
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="text-center text-gray-400 py-8"
                    >
                      {hasActiveFilters
                        ? "Няма намерени поръчки за филтрите"
                        : showHistory
                          ? "Няма доставки за избрания период."
                          : "Няма доставки за днес. Виж 📋 История за по-стари."}
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((o) => {
                    const cod = codAmount(o);
                    const totalQty = (o.items ?? []).reduce(
                      (s, it) => s + Number(it.quantity ?? 0),
                      0,
                    );
                    const itemsTitle = (o.items ?? [])
                      .map((it) => `${it.name} — ${Number(it.quantity)} бр.`)
                      .join("\n");
                    return (
                      <TableRow
                        key={o.id}
                        className="cursor-pointer hover:bg-gray-50"
                        onClick={() => setDetailOrder(o)}
                      >
                        <TableCell className="font-mono">
                          <HighlightMatch
                            text={String(o.order_number ?? o.id)}
                            query={filters.order_number}
                          />
                        </TableCell>
                        <TableCell
                          className="font-medium truncate max-w-[220px]"
                          title={o.partner_name ?? "—"}
                        >
                          {o.partner_name ? (
                            <HighlightMatch
                              text={o.partner_name}
                              query={filters.partner}
                            />
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {formatDate(o.econt_requested_at || o.created_at)}
                        </TableCell>
                        <TableCell
                          className="text-gray-600 whitespace-nowrap"
                          title={itemsTitle}
                        >
                          {totalQty} бр.
                        </TableCell>
                        <TableCell className="font-medium text-right whitespace-nowrap">
                          {cod > 0 ? (
                            <span className="text-[#f97316]">
                              {formatCurrency(cod)}
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <EcontStatusBadge o={o} />
                        </TableCell>
                        <TableCell>
                          {o.econt_shipment_number ? (
                            <a
                              href={trackingHref(o)}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 text-blue-600 underline font-mono text-xs"
                              title="Проследи пратката в Еконт"
                            >
                              <HighlightMatch
                                text={o.econt_shipment_number}
                                query={filters.shipment}
                              />
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {!o.econt_shipment_number ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDetailOrder(o);
                              }}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-[#f97316] text-white hover:bg-[#ea580c]"
                            >
                              Въведи данни
                            </button>
                          ) : !o.paid && cod > 0 ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                markPaid.mutate(o);
                              }}
                              disabled={markPaid.isPending}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-green-600 text-white hover:bg-green-700 disabled:bg-gray-300"
                            >
                              Маркирай платено
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDetailOrder(o);
                              }}
                              className="text-xs text-gray-500 hover:text-gray-700"
                            >
                              Детайли
                            </button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {detailLive && (
        <EcontOrderDrawer
          order={detailLive}
          onClose={() => setDetailOrder(null)}
          onMarkPaid={() => markPaid.mutate(detailLive)}
          markPaidPending={markPaid.isPending}
          onChanged={() => {
            qc.invalidateQueries({ queryKey: ["econt-queue"] });
            qc.invalidateQueries({ queryKey: ["orders"] });
          }}
        />
      )}
    </div>
  );
}

// ── Scoped detail drawer (Еконт работник изглед — без цени/фактури) ───────────

function EcontOrderDrawer({
  order,
  onClose,
  onMarkPaid,
  markPaidPending,
  onChanged,
}: {
  order: EcontQueueItem;
  onClose: () => void;
  onMarkPaid: () => void;
  markPaidPending: boolean;
  onChanged: () => void;
}) {
  const cod = codAmount(order);
  const hasShipment = Boolean(order.econt_shipment_number);
  const [printing, setPrinting] = useState(false);

  // Печат на товарителницата (етикета). Ползва cache-натия econt_pdf_url, а
  // ако липсва — fallback към GET /econt/label-pdf/:shipmentNumber (същия
  // endpoint като WarehousePacking; econt роля има достъп). Отваря PDF-а в
  // нов таб откъдето работникът печата директно.
  const printWaybill = async () => {
    if (!order.econt_shipment_number) return;
    setPrinting(true);
    try {
      let url = order.econt_pdf_url;
      if (!url) {
        const res = await api.get(
          `/econt/label-pdf/${order.econt_shipment_number}`,
        );
        url = res.data?.pdfURL ?? null;
      }
      if (url) {
        window.open(url, "_blank", "noopener");
      } else {
        toast.error("Товарителницата не е достъпна за печат");
      }
    } catch {
      toast.error("Грешка при зареждане на товарителницата за печат");
    } finally {
      setPrinting(false);
    }
  };

  // ── Тегла по продукт ──────────────────────────────────────────────
  // Еконт работникът въвежда теглото (kg/бр.) на продукт без заредено
  // тегло; запазва се в продукта (PATCH /econt/product-weight) и общото
  // тегло (Σ тегло × бройки) захранва товарителницата. weightEdits държи
  // само РЕДАКТИРАНИТЕ стойности; иначе fallback към item.weight_kg.
  const [weightEdits, setWeightEdits] = useState<Record<number, string>>({});

  const weightStr = (it: EcontQueueItem["items"][number]) =>
    weightEdits[it.product_id] !== undefined
      ? weightEdits[it.product_id]
      : it.weight_kg != null && Number(it.weight_kg) > 0
        ? String(it.weight_kg)
        : "";

  const totalWeight = (order.items ?? []).reduce((sum, it) => {
    const w = parseFloat((weightStr(it) || "0").replace(",", "."));
    return sum + (isFinite(w) ? w : 0) * Number(it.quantity || 0);
  }, 0);

  const fmtKg = (n: number) =>
    n > 0
      ? n
          .toFixed(3)
          .replace(/\.?0+$/, "")
          .replace(".", ",") + " кг"
      : "—";

  const saveWeight = async (productId: number, raw: string) => {
    const w = parseFloat((raw || "").replace(",", "."));
    if (!isFinite(w) || w < 0) return;
    try {
      await api.patch("/econt/product-weight", {
        product_id: productId,
        weight_kg: w,
      });
    } catch {
      toast.error("Грешка при запис на теглото");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} modal={false}>
      <DialogContent className="sm:max-w-[1120px] max-h-[94vh] flex flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 flex-wrap">
            <span>Поръчка #{order.order_number}</span>
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200">
              <Send className="h-3 w-3" /> Еконт
            </span>
            <EcontStatusBadge o={order} />
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Партньор */}
          <div className="text-sm">
            <span className="text-gray-500">Партньор:</span>{" "}
            <span className="font-medium">{order.partner_name ?? "—"}</span>
          </div>

          {/* Артикули — БЕЗ цени (Еконт работникът не вижда стойности) */}
          <div>
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Артикули
            </div>
            <div className="border rounded-lg divide-y">
              {(order.items ?? []).length === 0 ? (
                <div className="px-3 py-2 text-sm text-gray-400">
                  Няма артикули
                </div>
              ) : (
                (order.items ?? []).map((it, i) => (
                  <div
                    key={i}
                    className="px-3 py-2 text-sm flex items-center gap-2"
                  >
                    <span className="text-gray-700 flex-1 min-w-0 truncate">
                      {it.name}
                    </span>
                    {/* Тегло на единица (kg/бр.) — въвежда се ако липсва,
                        запазва се в продукта при blur за следващите пъти. */}
                    <div className="flex items-center gap-1 shrink-0">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={weightStr(it)}
                        onChange={(e) =>
                          setWeightEdits((m) => ({
                            ...m,
                            [it.product_id]: e.target.value,
                          }))
                        }
                        onBlur={(e) =>
                          saveWeight(it.product_id, e.target.value)
                        }
                        placeholder="—"
                        title="Тегло на брой в кг (запомня се за продукта)"
                        className="w-16 h-7 px-2 text-right border rounded text-xs focus:outline-none focus:ring-1 focus:ring-[#f97316]"
                      />
                      <span className="text-gray-400 text-xs w-5">кг</span>
                    </div>
                    <span className="font-medium text-gray-900 w-12 text-right shrink-0">
                      {Number(it.quantity)} бр.
                    </span>
                  </div>
                ))
              )}
            </div>
            {(order.items ?? []).length > 0 && (
              <div className="flex items-center justify-between text-xs mt-1 px-1">
                <span className="text-gray-400">
                  Тегло/бр. — запомня се за продукта
                </span>
                <span className="text-gray-700">
                  Общо тегло:{" "}
                  <span className="font-semibold">{fmtKg(totalWeight)}</span>
                </span>
              </div>
            )}
          </div>

          {/* Наложен платеж */}
          <div className="flex items-center justify-between border rounded-lg px-3 py-2.5 bg-gray-50">
            <div className="flex items-center gap-2 text-sm">
              <Banknote className="h-4 w-4 text-[#f97316]" />
              <span className="text-gray-600">Наложен платеж:</span>
              {cod > 0 ? (
                <span className="font-semibold text-[#f97316]">
                  {formatCurrency(cod)}
                </span>
              ) : (
                <span className="text-gray-400">няма</span>
              )}
            </div>
            {hasShipment &&
              (order.paid ? (
                <span className="text-green-600 text-sm font-medium flex items-center gap-1">
                  <CheckCircle2 className="h-4 w-4" /> Платено
                </span>
              ) : cod > 0 ? (
                <button
                  onClick={onMarkPaid}
                  disabled={markPaidPending}
                  title="Отбележи, че наложеният платеж е събран (когато Еконт преведе сумата)"
                  className="px-2.5 py-1 text-xs font-medium text-green-700 border border-green-600 rounded hover:bg-green-50 disabled:opacity-50"
                >
                  Маркирай платено
                </button>
              ) : (
                <span className="text-gray-400 text-sm">
                  Без наложен платеж
                </span>
              ))}
          </div>

          {/* Еконт товарителница */}
          <div>
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Еконт товарителница
            </div>
            {hasShipment ? (
              <div className="border rounded-lg px-3 py-2.5 space-y-2.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">Товарителница:</span>
                  <a
                    href={trackingHref(order)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-blue-600 underline font-mono"
                  >
                    {order.econt_shipment_number}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                {/* Печат на товарителницата — основното действие веднага след
                    създаване (етикетът за пакета). */}
                <button
                  type="button"
                  onClick={printWaybill}
                  disabled={printing}
                  className="w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-semibold bg-[#f97316] text-white rounded-lg hover:bg-orange-600 disabled:bg-gray-300 transition"
                >
                  <Printer className="h-4 w-4" />
                  {printing ? "Зареждане…" : "Принтирай товарителница"}
                </button>
              </div>
            ) : (
              <EcontCreatePanel
                order={order}
                weightFromProducts={totalWeight}
                onDone={() => {
                  onChanged();
                }}
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── EcontCreatePanel (товарителница) — преизползва create-shipment контракта ──

function EcontCreatePanel({
  order,
  onDone,
  weightFromProducts,
}: {
  order: EcontQueueItem;
  onDone: () => void;
  weightFromProducts: number;
}) {
  const { token: authToken } = useAuth();

  // The EcontShippingPicker carries ALL receiver + destination + weight + COD
  // fields in one EcontShippingValue object, matching the /econt/create-shipment
  // contract used by WarehousePacking exactly.
  const [shipping, setShipping] = useState<Partial<EcontShippingValue>>({
    econt_delivery_type: "office",
    econt_receiver_name: "",
    econt_receiver_phone: "",
    econt_city: "",
    econt_weight: weightFromProducts > 0 ? weightFromProducts : 1,
    econt_cod_amount: Number(order.econt_cod_amount ?? 0),
    econt_has_cod: Number(order.econt_cod_amount ?? 0) > 0,
    econt_payer: "receiver",
    econt_shipment_description: "Хранителни продукти",
  });

  // Синхронизирай теглото на товарителницата с общото тегло от продуктите
  // (Σ тегло × бройки). Per-product теглата са източникът на истината.
  useEffect(() => {
    if (weightFromProducts > 0) {
      setShipping((prev) => ({ ...prev, econt_weight: weightFromProducts }));
    }
  }, [weightFromProducts]);

  const create = useMutation({
    mutationFn: async () => {
      await api.post("/econt/create-shipment", {
        order_id: order.id,
        receiverName: shipping.econt_receiver_name,
        receiverPhone: shipping.econt_receiver_phone,
        receiverCity: shipping.econt_city,
        receiverOfficeCode: shipping.econt_office_code,
        receiverStreet: shipping.econt_street,
        receiverNum: shipping.econt_street_num,
        weight: shipping.econt_weight || 1,
        // Уважаваме редактираната в picker-а стойност: ако работникът махне
        // отметката „Наложен платеж" → 0; иначе въведената сума (default-ва
        // се от order COD-а, който е неплатеният остатък).
        codAmount: shipping.econt_has_cod
          ? Number(shipping.econt_cod_amount ?? 0)
          : 0,
        servicesPayer:
          shipping.econt_payer === "receiver" ? "RECEIVER" : "SENDER",
        shipmentDescription:
          shipping.econt_shipment_description || "Хранителни продукти",
      });
    },
    onSuccess: () => {
      toast.success("✅ Товарителница създадена");
      onDone();
    },
    onError: (err: unknown) => {
      const e = err as {
        response?: { data?: { detail?: string; error?: string } };
        message?: string;
      };
      toast.error(
        e?.response?.data?.detail ||
          e?.response?.data?.error ||
          e?.message ||
          "Грешка при товарителница",
      );
    },
  });

  const canCreate = Boolean(
    shipping.econt_receiver_name?.trim() &&
    shipping.econt_receiver_phone?.trim() &&
    shipping.econt_city?.trim() &&
    // For office delivery: need office code; for address delivery: need street
    (shipping.econt_delivery_type === "office"
      ? shipping.econt_office_code
      : shipping.econt_street?.trim()),
  );

  if (!authToken) {
    return (
      <div className="text-sm text-red-500">
        Не сте влезли в системата — не може да се създаде товарителница.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <EcontShippingPicker
        value={shipping}
        onChange={(patch) => setShipping((prev) => ({ ...prev, ...patch }))}
        token={authToken}
        defaultOpen={true}
        defaultCodAmount={Number(order.econt_cod_amount ?? 0)}
      />

      <div className="flex justify-end">
        <button
          onClick={() => create.mutate()}
          disabled={!canCreate || create.isPending}
          className="px-4 py-1.5 text-sm bg-[#f97316] text-white rounded hover:bg-orange-600 disabled:bg-gray-300 disabled:cursor-not-allowed"
        >
          {create.isPending ? "Създаване…" : "Направи товарителница"}
        </button>
      </div>
    </div>
  );
}
