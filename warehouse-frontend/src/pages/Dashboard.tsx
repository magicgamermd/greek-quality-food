import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  TrendingUp,
  ShoppingCart,
  AlertTriangle,
  CreditCard,
  Package,
  ArrowRight,
} from "lucide-react";
import { api } from "@/lib/api";
import { formatCurrency, formatUnit, formatDate } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingOverlay, ErrorMessage } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import type { DashboardKPIs, Order, StockLevel } from "@/types";
import { Can } from "@/components/Can";
import { PERMISSIONS } from "@/lib/permissions";

const kpiCards = [
  {
    key: "total_stock_value",
    label: "Стойност на склада",
    icon: TrendingUp,
    color: "text-orange-600",
    bg: "bg-orange-50",
    format: (v: number) => formatCurrency(v),
    link: "/inventory",
  },
  {
    key: "todays_orders",
    label: "Поръчки днес",
    icon: ShoppingCart,
    color: "text-blue-600",
    bg: "bg-blue-50",
    format: (v: number) => v.toString(),
    link: "/orders",
  },
  {
    key: "low_stock_count",
    label: "Нисък запас",
    icon: AlertTriangle,
    color: "text-red-600",
    bg: "bg-red-50",
    format: (v: number) => `${v} продукта`,
    link: "/inventory?tab=low-stock",
  },
  {
    key: "pending_payments",
    label: "Неплатени фактури",
    icon: CreditCard,
    color: "text-orange-600",
    bg: "bg-orange-50",
    format: (v: number) => formatCurrency(v),
    link: "/invoices?status=unpaid",
  },
];

export function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  // Role-based KPI visibility
  const visibleKpiCards = kpiCards.filter(({ key }) => {
    if (user?.role === "accountant") {
      return [
        "pending_payments",
        "todays_orders",
        "total_stock_value",
      ].includes(key);
    }
    if (user?.role === "warehouse") {
      return ["total_stock_value", "low_stock_count", "todays_orders"].includes(
        key,
      );
    }
    return true; // admin sees all
  });

  const {
    data: kpis,
    isLoading: kpiLoading,
    error: kpiError,
  } = useQuery<DashboardKPIs>({
    queryKey: ["dashboard-kpis"],
    queryFn: async () => {
      // Use individual endpoints for accurate counts
      const [dashRes, lowStockRes] = await Promise.allSettled([
        api.get("/analytics/dashboard"),
        api.get("/inventory/low-stock"),
      ]);

      const dash = dashRes.status === "fulfilled" ? dashRes.value?.data : {};
      const lowStockArr =
        lowStockRes.status === "fulfilled"
          ? Array.isArray(lowStockRes.value?.data)
            ? lowStockRes.value.data
            : lowStockRes.value?.data?.data || []
          : [];

      return {
        total_stock_value: parseFloat(dash.total_stock_value) || 0,
        todays_orders: dash.today_orders || 0,
        low_stock_count: lowStockArr.length,
        pending_payments: parseFloat(dash.pending_payments_amount) || 0,
      };
    },
    refetchInterval: 30000,
  });

  const { data: recentOrders, isLoading: ordersLoading } = useQuery<Order[]>({
    queryKey: ["recent-orders"],
    queryFn: () =>
      api.get("/orders?limit=5").then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      }),
    refetchInterval: 30000,
  });

  const { data: lowStockItems, isLoading: lowStockLoading } = useQuery<
    StockLevel[]
  >({
    queryKey: ["low-stock-dashboard"],
    queryFn: () =>
      api.get("/inventory/low-stock").then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      }),
    refetchInterval: 30000,
  });

  const orderStatusLabels: Record<string, string> = {
    pending: "Чакаща",
    confirmed: "Потвърдена",
    fulfilled: "Изпълнена",
    cancelled: "Анулирана",
    invoiced: "Фактурирана",
  };

  const orderStatusVariants: Record<
    string,
    "default" | "secondary" | "success" | "warning" | "destructive" | "info"
  > = {
    pending: "warning",
    confirmed: "info",
    fulfilled: "success",
    cancelled: "destructive",
    invoiced: "default",
  };

  if (kpiError)
    return (
      <div className="p-6">
        <ErrorMessage message="Грешка при зареждане на таблото" />
      </div>
    );

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Табло</h1>
        <p className="text-gray-500 text-sm mt-1">
          Преглед на текущото състояние на склада
        </p>
      </div>

      {/* KPI Cards */}
      {kpiLoading ? (
        <LoadingOverlay />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          {visibleKpiCards.map(
            ({ key, label, icon: Icon, color, bg, format, link }) => {
              const card = (
                <Card
                  key={key}
                  className="hover:shadow-md transition-shadow cursor-pointer"
                  onClick={() => navigate(link)}
                >
                  <CardContent className="p-5">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-gray-500 font-medium">
                          {label}
                        </p>
                        <p className="text-2xl font-bold text-gray-900 mt-1">
                          {kpis
                            ? format(kpis[key as keyof DashboardKPIs] as number)
                            : "—"}
                        </p>
                      </div>
                      <div
                        className={`h-12 w-12 rounded-xl ${bg} flex items-center justify-center`}
                      >
                        <Icon className={`h-6 w-6 ${color}`} />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
              if (key === "total_stock_value") {
                return (
                  <Can
                    key={key}
                    permission={PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE}
                  >
                    {card}
                  </Can>
                );
              }
              return card;
            },
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Orders */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <ShoppingCart className="h-5 w-5 text-[#f97316]" />
                Последни поръчки
              </CardTitle>
              <button
                onClick={() => navigate("/orders")}
                className="text-sm text-[#f97316] hover:underline flex items-center gap-1"
              >
                Виж всички
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {ordersLoading ? (
              <LoadingOverlay />
            ) : recentOrders && recentOrders.length > 0 ? (
              <div className="divide-y divide-gray-100">
                {recentOrders.map((order) => (
                  <div
                    key={order.id}
                    className="flex items-center justify-between px-6 py-3 hover:bg-gray-50 cursor-pointer transition-colors"
                    onClick={() => navigate("/orders")}
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {order.partner?.name ??
                          order.partner_name ??
                          `Партньор #${order.partner_id}`}
                      </p>
                      <p className="text-xs text-gray-500">
                        {formatDate(order.order_date)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium">
                        {formatCurrency(order.total_amount)}
                      </span>
                      <Badge
                        variant={
                          orderStatusVariants[order.status] ?? "secondary"
                        }
                      >
                        {orderStatusLabels[order.status] ?? order.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-6 py-8 text-center text-gray-400 text-sm">
                Няма поръчки
              </div>
            )}
          </CardContent>
        </Card>

        {/* Low Stock */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Package className="h-5 w-5 text-red-500" />
                Нисък запас
              </CardTitle>
              <button
                onClick={() => navigate("/inventory?tab=low-stock")}
                className="text-sm text-[#f97316] hover:underline flex items-center gap-1"
              >
                Виж всички
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {lowStockLoading ? (
              <LoadingOverlay />
            ) : lowStockItems && lowStockItems.length > 0 ? (
              <div className="divide-y divide-gray-100">
                {lowStockItems.slice(0, 5).map((item) => (
                  <div
                    key={item.product_id}
                    className="flex items-center justify-between px-6 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {item.name_bg || item.product_name || item.sku}
                      </p>
                      {item.name_en && (
                        <p className="text-xs text-gray-400 uppercase tracking-wide truncate">
                          {item.name_en}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <span className="text-sm font-bold text-red-600">
                        {parseFloat(
                          String(item.total_stock ?? item.total_quantity ?? 0),
                        )}{" "}
                        {formatUnit(item.unit)}
                      </span>
                      <Badge variant="destructive">Нисък</Badge>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-6 py-8 text-center text-gray-400 text-sm">
                Няма продукти с нисък запас
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
