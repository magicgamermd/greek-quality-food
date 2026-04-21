import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Package, CheckCircle, Printer, Clock } from "lucide-react";
import { api } from "@/lib/api";
import type { Order, OrderItem } from "@/types";
import { Spinner } from "@/components/ui/spinner";

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
      api.get("/orders?status=processing").then((r) => {
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

  const fulfillMutation = useMutation({
    mutationFn: (id: number) => api.post(`/orders/${id}/fulfill`),
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
          <Package className="h-8 w-8 text-orange-400" />
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
        {(orderDetails.length > 0 ? orderDetails : orders).map((order) => {
          const items: OrderItem[] = order.items ?? [];
          const checked = checkedItems[String(order.id)] || new Set();
          const allChecked = items.length > 0 && checked.size === items.length;

          return (
            <div
              key={order.id}
              className="bg-white rounded-2xl shadow-lg overflow-hidden"
            >
              <div className="bg-gray-50 px-6 py-4 border-b border-gray-200">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-xl font-bold text-gray-900">
                      Поръчка #{order.id}
                    </h2>
                    <p className="text-base text-gray-600 mt-1">
                      {order.partner?.name ??
                        order.partner_name ??
                        `Партньор #${order.partner_id}`}
                    </p>
                  </div>
                  <div className="bg-blue-100 text-blue-700 px-3 py-1 rounded-full text-sm font-medium">
                    В обработка
                  </div>
                </div>
              </div>

              <div className="px-6 py-4">
                {items.length === 0 ? (
                  <p className="text-gray-400 text-center py-4">
                    Зареждане на артикули...
                  </p>
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
                      const unit = item.unit || item.product?.unit || "бр.";
                      return (
                        <li key={item.id}>
                          <label className="flex items-center gap-3 cursor-pointer group">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleItem(order.id, item.id)}
                              className="h-6 w-6 rounded border-gray-300 text-orange-500 focus:ring-orange-500 cursor-pointer"
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

              <div className="px-6 py-4 border-t border-gray-200 flex gap-3">
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
                <button
                  onClick={() => {
                    if (
                      confirm(`Потвърди изпращане на Поръчка #${order.id}?`)
                    ) {
                      fulfillMutation.mutate(order.id);
                    }
                  }}
                  disabled={fulfillMutation.isPending}
                  className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-base font-medium transition-colors ${
                    allChecked
                      ? "bg-orange-500 hover:bg-orange-600 text-white"
                      : "bg-orange-200 hover:bg-orange-300 text-orange-800"
                  }`}
                >
                  {fulfillMutation.isPending ? (
                    <Spinner size="sm" />
                  ) : (
                    <CheckCircle className="h-5 w-5" />
                  )}
                  Потвърди изпращане
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
