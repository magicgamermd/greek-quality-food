import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Package,
  CheckCircle,
  Printer,
  Clock,
  FileText,
  ArrowDownLeft,
  ArrowUpRight,
  RefreshCcw,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatUnit } from "@/lib/utils";
import type { Order, OrderItem } from "@/types";
import { Spinner } from "@/components/ui/spinner";
import { confirm } from "@/components/ConfirmDialog";

export function WarehousePacking() {
  const qc = useQueryClient();
  const [now, setNow] = useState(new Date());
  const [checkedItems, setCheckedItems] = useState<Record<string, Set<number>>>(
    {},
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const { data: orders = [], isLoading } = useQuery<Order[]>({
    queryKey: ["warehouse-packing"],
    queryFn: () =>
      // Унифициран view: orders в processing (стандартно пакетиране) +
      // orders с pending_pickup линии (клиент дойде за платена-невзета
      // стока, касиерът ги изпрати към склад за финално опаковане).
      api.get("/orders?warehouse_view=true").then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      }),
    refetchInterval: 5_000,
  });

  const orderIds = orders.map((o) => o.id);
  const { data: orderDetails = [] } = useQuery<Order[]>({
    queryKey: ["warehouse-packing-details", orderIds.join(",")],
    queryFn: async () => {
      const results = await Promise.all(
        orders.map((o) =>
          api.get(`/orders/${o.id}`).then((r) => r.data?.data ?? r.data),
        ),
      );
      return results;
    },
    enabled: orders.length > 0,
    refetchInterval: 5_000,
  });

  const [waybillResult, setWaybillResult] = useState<
    Record<number, { success: boolean; message: string }>
  >({});
  const [printingLabelId, setPrintingLabelId] = useState<number | null>(null);

  // Print the internal packing label as a blob — using window.open on
  // the raw URL would lose the JWT (Authorization is stripped on
  // navigation), so we fetch via the api wrapper and open via blob URL.
  const handlePrintLabel = async (orderId: number) => {
    setPrintingLabelId(orderId);
    try {
      const res = await api.get(`/orders/${orderId}/packing-label-pdf`, {
        responseType: "blob",
      });
      // Try the configured Zebra printer first — packing notes are
      // label-format and meant for the Zebra. Backend exposes the file
      // path in X-Pdf-Path so we can spool it without re-uploading.
      // Falls back to opening the PDF in a new tab when the printer
      // isn't configured.
      const zebraPdfPath = (res.headers as any)?.["x-pdf-path"];
      if (zebraPdfPath) {
        try {
          const r = await api.post("/print/zebra", { pdf_path: zebraPdfPath });
          if (r.data?.ok) {
            toast.success(`Изпратено към ${r.data.printer}`);
            return;
          }
        } catch (err: any) {
          const msg = err?.response?.data?.error;
          if (!msg || !/не е конфигуриран/.test(msg)) {
            toast.error(msg ?? "Грешка при печат към Zebra");
            return;
          }
          // "не е конфигуриран" → fall through to browser print
        }
      }
      const blob = new Blob([res.data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      const e = err as {
        response?: { data?: { error?: string } };
        message?: string;
      };
      toast.error(
        e.response?.data?.error ||
          e.message ||
          "Грешка при принтиране на бележка",
      );
    } finally {
      setPrintingLabelId(null);
    }
  };

  const fulfillMutation = useMutation({
    mutationFn: (id: number) => api.post(`/orders/${id}/fulfill`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["warehouse-packing"] });
      qc.invalidateQueries({ queryKey: ["warehouse-packing-details"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
  });

  // Pickup confirmation — flips pending_pickup → normal per-item.
  // Складът натиска "Потвърди предаване" след като е опаковал
  // платените-невзети редове за дошлия клиент. Изпращаме сериен
  // POST за всеки checked item; при грешка прескачаме останалите.
  const pickupMutation = useMutation({
    mutationFn: async (params: { orderId: number; itemIds: number[] }) => {
      const results = [];
      for (const itemId of params.itemIds) {
        const res = await api.post(
          `/orders/${params.orderId}/items/${itemId}/handover`,
        );
        results.push(res.data);
      }
      return results;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["warehouse-packing"] });
      qc.invalidateQueries({ queryKey: ["warehouse-packing-details"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
  });

  const waybillMutation = useMutation({
    mutationFn: async (order: Order) => {
      const res = await api.post("/econt/create-shipment", {
        order_id: order.id,
        receiverName: order.econt_receiver_name,
        receiverPhone: order.econt_receiver_phone,
        receiverCity: order.econt_city,
        receiverOfficeCode: order.econt_office_code,
        receiverStreet: order.econt_street,
        receiverNum: order.econt_street_num,
        weight: order.econt_weight || 1,
        codAmount: order.econt_cod_amount,
        servicesPayer: order.econt_payer === "receiver" ? "RECEIVER" : "SENDER",
        shipmentDescription: "Кухненско оборудване",
      });
      return { orderId: order.id, data: res.data };
    },
    onSuccess: ({ orderId, data }) => {
      setWaybillResult((prev) => ({
        ...prev,
        [orderId]: {
          success: true,
          message: `Товарителница: ${data.shipmentNumber}`,
        },
      }));
      if (data.pdfURL) {
        window.open(data.pdfURL, "_blank");
      }
      qc.invalidateQueries({ queryKey: ["warehouse-packing-details"] });
    },
    onError: (err: unknown, order) => {
      const e = err as {
        response?: { data?: { error?: string } };
        message?: string;
      };
      const msg =
        e.response?.data?.error || e.message || "Грешка при създаване";
      setWaybillResult((prev) => ({
        ...prev,
        [order.id]: { success: false, message: msg },
      }));
    },
  });

  const toggleItem = (orderId: number, itemId: number) => {
    setCheckedItems((prev) => {
      const key = String(orderId);
      const set = new Set(prev[key] || []);
      if (set.has(itemId)) {
        set.delete(itemId);
      } else {
        set.add(itemId);
      }
      return { ...prev, [key]: set };
    });
  };

  const formatTime = (d: Date) =>
    d.toLocaleTimeString("bg-BG", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="min-h-screen bg-[#0f172a] p-6">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <Package className="h-8 w-8 text-violet-400" />
          <h1 className="text-3xl font-bold text-white">Склад — Пакетиране</h1>
        </div>
        <div className="flex items-center gap-2 text-white/60 text-lg">
          <Clock className="h-5 w-5" />
          <span>{formatTime(now)}</span>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <Spinner size="lg" />
          <span className="ml-3 text-white/60 text-lg">Зареждане...</span>
        </div>
      )}

      {!isLoading && orders.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-white/40">
          <Package className="h-16 w-16 mb-4" />
          <p className="text-2xl font-medium">Няма поръчки за пакетиране</p>
          <p className="text-lg mt-2">
            Всички поръчки са обработени. Списъкът се обновява автоматично.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
        {(orderDetails.length > 0 ? orderDetails : orders)
          // Hide orders with no packable lines — orders where every item
          // is `paid_not_taken` (already in customer hands) or `awaiting`
          // (pre-order, goods haven't arrived) shouldn't appear here.
          // Once a paid_not_taken line is handed over or an awaiting line
          // is confirmed, it transitions to `normal` and the order pops
          // back into the packing queue.
          .filter((order) => {
            const items: OrderItem[] = order.items ?? [];
            if (items.length === 0) return true; // still loading details
            // Показваме поръчката ако има поне едно "packable" — normal
            // (стандартно пакетиране, status='processing') ИЛИ
            // pending_pickup (финално предаване на клиент дошъл за
            // платена-невзета стока, status='fulfilled').
            return items.some((it) => {
              const ls = it.line_status ?? "normal";
              return ls === "normal" || (ls as string) === "pending_pickup";
            });
          })
          .map((order) => {
            const allItems: OrderItem[] = order.items ?? [];
            // Pickup mode = финална стъпка от 2-step предаване (миграция
            // 079). Поръчката е fulfilled, но касиерът е изпратил линия
            // към склада защото клиент дойде за невзета стока. Складът
            // вижда само pending_pickup редовете, опакова и натиска
            // "Потвърди предаване" → handover endpoint.
            const isPickupMode =
              order.status === "fulfilled" &&
              allItems.some(
                (it) => (it.line_status as string) === "pending_pickup",
              );
            const packStatus = (
              isPickupMode ? "pending_pickup" : "normal"
            ) as OrderItem["line_status"];
            const items = allItems.filter(
              (it) => (it.line_status ?? "normal") === packStatus,
            );
            const skipped = allItems.filter(
              (it) => (it.line_status ?? "normal") !== packStatus,
            );
            const checked = checkedItems[String(order.id)] || new Set();
            const allChecked =
              items.length > 0 && checked.size === items.length;
            const isReplacement = Boolean(order.is_replacement);
            const giveItems = items.filter((i) => !i.is_returning);
            const returnItems = items.filter((i) => Boolean(i.is_returning));

            return (
              <div
                key={order.id}
                className="bg-white rounded-2xl shadow-lg overflow-hidden"
              >
                <div className="bg-gray-50 px-6 py-4 border-b border-gray-200">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h2 className="text-xl font-bold text-gray-900">
                          Поръчка #{order.order_number ?? order.id}
                        </h2>
                        {isReplacement && (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-0.5 text-xs font-medium text-violet-700">
                            <RefreshCcw className="h-3 w-3" />
                            Замяна
                          </span>
                        )}
                      </div>
                      <p className="text-base text-gray-600 mt-1">
                        {order.partner?.name ??
                          order.partner_name ??
                          `Партньор #${order.partner_id}`}
                      </p>
                    </div>
                    {isPickupMode ? (
                      <div className="bg-amber-100 text-amber-800 px-3 py-1 rounded-full text-sm font-medium">
                        За предаване
                      </div>
                    ) : (
                      <div className="bg-blue-100 text-blue-700 px-3 py-1 rounded-full text-sm font-medium">
                        В обработка
                      </div>
                    )}
                  </div>
                </div>

                <div className="px-6 py-4">
                  {items.length === 0 ? (
                    <p className="text-gray-400 text-center py-4">
                      Зареждане на артикули...
                    </p>
                  ) : isReplacement ? (
                    <div className="space-y-4">
                      <PackingItemSection
                        label="Дай на клиента"
                        accent="give"
                        items={giveItems}
                        checked={checked}
                        onToggle={(itemId) => toggleItem(order.id, itemId)}
                        emptyText="Няма артикули за даване"
                      />
                      <PackingItemSection
                        label="Приеми обратно"
                        accent="return"
                        items={returnItems}
                        checked={checked}
                        onToggle={(itemId) => toggleItem(order.id, itemId)}
                        emptyText="Няма артикули за връщане"
                      />
                    </div>
                  ) : (
                    <ul className="space-y-3">
                      {items.map((item) => {
                        const isChecked = checked.has(item.id);
                        const prodName =
                          item.name_bg ||
                          item.product?.name_bg ||
                          item.name_en ||
                          item.product?.name_en ||
                          `Продукт #${item.product_id}`;
                        const unit = formatUnit(
                          item.unit || item.product?.unit,
                        );
                        return (
                          <li key={item.id}>
                            <label className="flex items-center gap-3 cursor-pointer group">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => toggleItem(order.id, item.id)}
                                className="h-6 w-6 rounded border-gray-300 text-violet-500 focus:ring-violet-500 cursor-pointer"
                              />
                              <div
                                className={`flex-1 text-lg ${isChecked ? "line-through text-gray-400" : "text-gray-900"}`}
                              >
                                {prodName}
                              </div>
                              <span
                                className={`text-lg font-bold ${isChecked ? "text-gray-400" : "text-gray-700"}`}
                              >
                                {item.quantity} {unit}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {skipped.length > 0 &&
                    !isPickupMode &&
                    (() => {
                      // Компактен banner — само бройки, без имена. Преди
                      // показвахме детайлен списък, но имената на
                      // paid_not_taken артикули често дублираха normal
                      // редове (същия SKU, две различни line_status-и) и
                      // объркваха склада. Banner-ът е чисто info че има
                      // още линии, които се управляват другаде.
                      // Не показваме в pickup mode — там горният списък
                      // обхваща точно това което се обработва.
                      const paidCount = skipped.filter(
                        (it) => it.line_status === "paid_not_taken",
                      ).length;
                      const awaitingCount = skipped.filter(
                        (it) => it.line_status === "awaiting",
                      ).length;
                      const pendingCount = skipped.filter(
                        (it) => (it.line_status as string) === "pending_pickup",
                      ).length;
                      const messages: string[] = [];
                      if (paidCount > 0) {
                        messages.push(
                          `${paidCount} ${paidCount === 1 ? "артикул е платен — невзет" : "артикула са платени — невзети"} (касата ги управлява)`,
                        );
                      }
                      if (pendingCount > 0) {
                        messages.push(
                          `${pendingCount} ${pendingCount === 1 ? "артикул е изпратен за предаване" : "артикула са изпратени за предаване"} (на склад)`,
                        );
                      }
                      if (awaitingCount > 0) {
                        messages.push(
                          `${awaitingCount} ${awaitingCount === 1 ? "артикул чака стока" : "артикула чакат стока"} (pre-order)`,
                        );
                      }
                      if (messages.length === 0) return null;
                      return (
                        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 flex items-start gap-2">
                          <span aria-hidden>📌</span>
                          <div className="flex-1">
                            {messages.map((m, idx) => (
                              <div key={idx}>{m}</div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                </div>

                {waybillResult[order.id] && (
                  <div
                    className={`mx-6 mt-2 px-4 py-2 rounded-lg text-sm font-medium ${
                      waybillResult[order.id].success
                        ? "bg-green-100 text-green-800"
                        : "bg-red-100 text-red-800"
                    }`}
                  >
                    {waybillResult[order.id].message}
                  </div>
                )}

                <div className="px-6 py-4 border-t border-gray-200 space-y-2">
                  <button
                    onClick={() => handlePrintLabel(order.id)}
                    disabled={printingLabelId === order.id}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-sky-100 hover:bg-sky-200 text-sky-800 rounded-xl text-base font-medium transition-colors disabled:opacity-60"
                  >
                    {printingLabelId === order.id ? (
                      <Spinner size="sm" />
                    ) : (
                      <FileText className="h-5 w-5" />
                    )}
                    Принтирай бележка
                  </button>
                  <div className="flex gap-3">
                    {order.econt_city ? (
                      <button
                        onClick={async () => {
                          if (order.econt_shipment_number) {
                            if (order.econt_pdf_url) {
                              window.open(order.econt_pdf_url, "_blank");
                            } else {
                              try {
                                const res = await api.get(
                                  `/econt/label-pdf/${order.econt_shipment_number}`,
                                );
                                if (res.data?.pdfURL) {
                                  window.open(res.data.pdfURL, "_blank");
                                } else {
                                  window.open(
                                    `https://www.econt.com/services/track-shipment/${order.econt_shipment_number}`,
                                    "_blank",
                                  );
                                }
                              } catch {
                                window.open(
                                  `https://www.econt.com/services/track-shipment/${order.econt_shipment_number}`,
                                  "_blank",
                                );
                              }
                            }
                            setWaybillResult((prev) => ({
                              ...prev,
                              [order.id]: {
                                success: true,
                                message: `Товарителница: ${order.econt_shipment_number}`,
                              },
                            }));
                            return;
                          }
                          waybillMutation.mutate(order);
                        }}
                        disabled={waybillMutation.isPending}
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl text-base font-medium transition-colors"
                      >
                        {waybillMutation.isPending ? (
                          <Spinner size="sm" />
                        ) : (
                          <Printer className="h-5 w-5" />
                        )}
                        Принтирай товарителница
                      </button>
                    ) : (
                      <div className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-blue-50 text-blue-700 rounded-xl text-base font-medium">
                        🏪 Вземане на място
                      </div>
                    )}
                    {isPickupMode ? (
                      <button
                        onClick={async () => {
                          // Pickup confirm — натискаме handover за всеки
                          // checked pending_pickup ред. По default и без
                          // checked items: предаваме всички.
                          const itemIds =
                            checked.size > 0
                              ? Array.from(checked)
                              : items.map((it) => it.id);
                          if (itemIds.length === 0) return;
                          const ok = await confirm({
                            title: `Потвърди предаване на Поръчка #${order.id}?`,
                            description: `Ще се маркират ${itemIds.length} ред(а) като предадени на клиента.`,
                            confirmText: "Потвърди предаване",
                          });
                          if (ok)
                            pickupMutation.mutate({
                              orderId: order.id,
                              itemIds,
                            });
                        }}
                        disabled={pickupMutation.isPending}
                        className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-base font-medium transition-colors ${
                          allChecked
                            ? "bg-amber-500 hover:bg-amber-600 text-white"
                            : "bg-amber-200 hover:bg-amber-300 text-amber-900"
                        }`}
                      >
                        {pickupMutation.isPending ? (
                          <Spinner size="sm" />
                        ) : (
                          <CheckCircle className="h-5 w-5" />
                        )}
                        Потвърди предаване
                      </button>
                    ) : (
                      <button
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Потвърди изпращане на Поръчка #${order.id}?`,
                            description:
                              "Поръчката ще бъде маркирана като изпълнена и ще се отрази в склада.",
                            confirmText: "Потвърди изпращане",
                          });
                          if (ok) fulfillMutation.mutate(order.id);
                        }}
                        disabled={fulfillMutation.isPending}
                        className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-base font-medium transition-colors ${
                          allChecked
                            ? "bg-violet-500 hover:bg-violet-600 text-white"
                            : "bg-violet-200 hover:bg-violet-300 text-violet-800"
                        }`}
                      >
                        {fulfillMutation.isPending ? (
                          <Spinner size="sm" />
                        ) : (
                          <CheckCircle className="h-5 w-5" />
                        )}
                        Потвърди изпращане
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/*  PackingItemSection                                                    */
/*                                                                        */
/*  One labeled section inside a replacement order's packing card —       */
/*  either "Дай на клиента" (give) or "Приеми обратно" (return). Lets     */
/*  the worker see at a glance which items leave the warehouse and which  */
/*  come back IN, so the same checklist UX works for both directions      */
/*  without confusion.                                                    */
/* ────────────────────────────────────────────────────────────────────── */
function PackingItemSection({
  label,
  accent,
  items,
  checked,
  onToggle,
  emptyText,
}: {
  label: string;
  accent: "give" | "return";
  items: OrderItem[];
  checked: Set<number>;
  onToggle: (itemId: number) => void;
  emptyText: string;
}) {
  const isGive = accent === "give";
  const Icon = isGive ? ArrowDownLeft : ArrowUpRight;
  const chipClass = isGive
    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : "bg-rose-50 text-rose-700 border-rose-200";

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${chipClass}`}
        >
          <Icon className="h-3 w-3" />
          {label}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm italic text-gray-400 ml-1">{emptyText}</p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => {
            const isChecked = checked.has(item.id);
            const prodName =
              item.name_bg ||
              item.product?.name_bg ||
              item.name_en ||
              item.product?.name_en ||
              `Продукт #${item.product_id}`;
            const unit = formatUnit(item.unit || item.product?.unit);
            return (
              <li key={item.id}>
                <label className="flex items-center gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => onToggle(item.id)}
                    className="h-6 w-6 rounded border-gray-300 text-violet-500 focus:ring-violet-500 cursor-pointer"
                  />
                  <div
                    className={`flex-1 text-lg ${isChecked ? "line-through text-gray-400" : "text-gray-900"}`}
                  >
                    {prodName}
                  </div>
                  <span
                    className={`text-lg font-bold ${isChecked ? "text-gray-400" : "text-gray-700"}`}
                  >
                    {item.quantity} {unit}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
