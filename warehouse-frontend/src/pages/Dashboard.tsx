import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  TrendingUp,
  ShoppingCart,
  AlertTriangle,
  CreditCard,
  Package,
  ArrowRight,
  Printer,
  Eye,
  EyeOff,
  ChevronDown,
  CalendarDays,
  CalendarRange,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import {
  formatCurrency,
  formatOrderTotal,
  formatUnit,
  formatDate,
} from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingOverlay, ErrorMessage } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useAuth } from "@/contexts/AuthContext";
import type { DashboardKPIs, Order, StockLevel } from "@/types";
import { Can } from "@/components/Can";
import { PERMISSIONS } from "@/lib/permissions";
import { toast } from "@/lib/toast";

const kpiCards = [
  {
    key: "total_stock_value",
    label: "Стойност на склада",
    icon: TrendingUp,
    color: "text-violet-600",
    bg: "bg-violet-50",
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
    color: "text-violet-600",
    bg: "bg-violet-50",
    format: (v: number) => formatCurrency(v),
    link: "/invoices?status=unpaid",
  },
];

const todayLocal = (): string => new Date().toLocaleDateString("sv-SE");

// "YYYY-MM" за текущия месец, в локален timezone — sv-SE locale дава
// ISO формат при toLocaleDateString, така че slice(0, 7) е безопасен.
const currentMonthLocal = (): string =>
  new Date().toLocaleDateString("sv-SE").slice(0, 7);

// localStorage key за persist на reveal state — на mobile девайс където
// касеро споделя екран с клиент, потребителят често иска "Стойност на
// склада" да остане скрита между навигации, иначе се връща обратно при
// всеки таб switch.
const STOCK_VALUE_HIDDEN_KEY = "mertm:dashboard:stock-value-hidden";

export function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [dailyReportOpen, setDailyReportOpen] = useState(false);
  const [reportDate, setReportDate] = useState<string>(todayLocal());
  const [monthlyReportOpen, setMonthlyReportOpen] = useState(false);
  const [reportMonth, setReportMonth] = useState<string>(currentMonthLocal());
  const [isDownloading, setIsDownloading] = useState(false);

  // "Стойност на склада" е чувствителна цифра — кешъра често има клиент
  // зад гърба си. Default скрит (както при банковите приложения) и
  // persistnat-о в localStorage, за да не се отгръща при таб switch.
  const [stockValueHidden, setStockValueHidden] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    // Дефолтът е "скрита". Само expлицитно "0" в localStorage я разкрива.
    return window.localStorage.getItem(STOCK_VALUE_HIDDEN_KEY) !== "0";
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(
        STOCK_VALUE_HIDDEN_KEY,
        stockValueHidden ? "1" : "0",
      );
    } catch {
      // localStorage може да е disabled в private mode — не fail-ваме UI-a.
    }
  }, [stockValueHidden]);

  // Общ download flow за дневен/месечен отчет — двата endpoint-а връщат
  // application/pdf blob, отварят се в нов таб. Различава се само
  // URL-ът и success callback (затваряне на съответния dialog).
  const downloadReport = async (
    url: string,
    onSuccess: () => void,
    fallbackErrorMsg: string,
  ) => {
    if (isDownloading) return;
    setIsDownloading(true);
    try {
      const res = await api.get(url, { responseType: "blob" });
      const blob = new Blob([res.data], { type: "application/pdf" });
      const objectUrl = URL.createObjectURL(blob);
      window.open(objectUrl, "_blank");
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      onSuccess();
    } catch (err: any) {
      console.error("Error downloading report:", err);
      let msg = fallbackErrorMsg;
      try {
        if (err?.response?.data instanceof Blob) {
          const text = await err.response.data.text();
          const json = JSON.parse(text);
          if (json.error) msg = json.error;
        } else if (err?.response?.data?.error) {
          msg = err.response.data.error;
        }
      } catch {}
      toast.error(msg);
    } finally {
      setIsDownloading(false);
    }
  };

  const downloadDailyReport = () =>
    downloadReport(
      `/reports/daily-pdf?date=${reportDate}`,
      () => setDailyReportOpen(false),
      "Грешка при сваляне на дневния отчет",
    );

  const downloadMonthlyReport = () =>
    downloadReport(
      `/reports/monthly-pdf?month=${reportMonth}`,
      () => setMonthlyReportOpen(false),
      "Грешка при сваляне на месечния отчет",
    );

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
      // `Promise.all` (instead of `allSettled`) so a network glitch on a
      // freshly started backend surfaces as a real query error — React
      // Query then runs the configured retries with exponential back-off,
      // and on persistent failure the dashboard renders "—" instead of
      // silently showing zeros for every card.
      const [dashRes, lowStockRes] = await Promise.all([
        api.get("/analytics/dashboard"),
        api.get("/inventory/low-stock"),
      ]);

      const dash = dashRes?.data ?? {};
      const lowStockArr = Array.isArray(lowStockRes?.data)
        ? lowStockRes.data
        : (lowStockRes?.data?.data ?? []);

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Табло</h1>
          <p className="text-gray-500 text-sm mt-1">
            Преглед на текущото състояние на склада
          </p>
        </div>
        <Can permission={PERMISSIONS.REPORTS_VIEW}>
          {/* Split button — главното action остава "Дневен отчет"
              (default behavior съвпада с предишния бутон). Стрелката
              отваря dropdown с другите варианти (засега месечен; в
              бъдеще годишен / по партньор). */}
          <div className="inline-flex">
            <Button
              variant="outline"
              onClick={() => setDailyReportOpen(true)}
              title="Дневен отчет (PDF)"
              className="rounded-r-none border-r-0"
            >
              <Printer className="h-4 w-4" />
              Дневен отчет
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  title="Други отчети"
                  aria-label="Други отчети"
                  className="rounded-l-none px-2"
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                <DropdownMenuItem
                  onSelect={() => setDailyReportOpen(true)}
                  className="gap-2"
                >
                  <CalendarDays className="h-4 w-4 text-gray-500" />
                  Дневен отчет
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => setMonthlyReportOpen(true)}
                  className="gap-2"
                >
                  <CalendarRange className="h-4 w-4 text-gray-500" />
                  Месечен отчет
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </Can>
      </div>

      {/* KPI Cards */}
      {kpiLoading ? (
        <LoadingOverlay />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          {visibleKpiCards.map(
            ({ key, label, icon: Icon, color, bg, format, link }) => {
              const isStockValue = key === "total_stock_value";
              const rawValue = kpis
                ? format(kpis[key as keyof DashboardKPIs] as number)
                : "—";
              const isHidden =
                isStockValue && stockValueHidden && rawValue !== "—";

              const card = (
                <Card
                  key={key}
                  className="hover:shadow-md transition-shadow cursor-pointer"
                  onClick={() => navigate(link)}
                >
                  <CardContent className="p-5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm text-gray-500 font-medium">
                          {label}
                        </p>
                        <div className="flex items-center gap-2 mt-1 min-h-[2rem]">
                          {isHidden ? (
                            // Fixed-width placeholder (4 bullets) така че НЕ
                            // издаваме колко е дълга сумата. Не render-ваме
                            // реалната стойност в DOM-а изобщо — view-source /
                            // copy-paste / accessibility tree всичко вижда
                            // същия placeholder. Blur ефектът върху истински
                            // числа би могъл да бъде reverse-нат с screenshot
                            // tools, затова не разчитаме само на CSS.
                            <span
                              aria-label="Скрита стойност"
                              className="text-2xl font-bold text-gray-400 tracking-[0.25em] select-none"
                            >
                              ••••
                            </span>
                          ) : (
                            <p className="text-2xl font-bold text-gray-900">
                              {rawValue}
                            </p>
                          )}
                          {isStockValue && rawValue !== "—" && (
                            <button
                              type="button"
                              aria-label={
                                stockValueHidden
                                  ? "Покажи стойността"
                                  : "Скрий стойността"
                              }
                              title={
                                stockValueHidden
                                  ? "Покажи стойността"
                                  : "Скрий стойността"
                              }
                              onClick={(e) => {
                                // Stop propagation, иначе click-ът на картата
                                // веднага ще navigate-не към /inventory.
                                e.stopPropagation();
                                setStockValueHidden((v) => !v);
                              }}
                              className="p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                            >
                              {stockValueHidden ? (
                                <Eye className="h-4 w-4" />
                              ) : (
                                <EyeOff className="h-4 w-4" />
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                      <div
                        className={`h-12 w-12 rounded-xl ${bg} flex items-center justify-center shrink-0`}
                      >
                        <Icon className={`h-6 w-6 ${color}`} />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
              if (isStockValue) {
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
                <ShoppingCart className="h-5 w-5 text-[#6c3dff]" />
                Последни поръчки
              </CardTitle>
              <button
                onClick={() => navigate("/orders")}
                className="text-sm text-[#6c3dff] hover:underline flex items-center gap-1"
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
                        {formatOrderTotal(order.total_amount)}
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
                className="text-sm text-[#6c3dff] hover:underline flex items-center gap-1"
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

      <Dialog open={dailyReportOpen} onOpenChange={setDailyReportOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Дневен отчет</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-1.5">
            <Label className="text-xs">За дата</Label>
            <Input
              type="date"
              value={reportDate}
              onChange={(e) => setReportDate(e.target.value)}
              max={todayLocal()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDailyReportOpen(false)}>
              Отказ
            </Button>
            <Button
              onClick={() => void downloadDailyReport()}
              disabled={isDownloading}
              className="bg-[#6c3dff] hover:bg-[#5a30d9]"
            >
              <Printer className="h-4 w-4" />
              {isDownloading ? "Сваляне…" : "Свали PDF"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={monthlyReportOpen} onOpenChange={setMonthlyReportOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Месечен отчет</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-1.5">
            <Label className="text-xs">За месец</Label>
            {/* type="month" дава на browser-а native month picker
                (Chrome/Edge/Safari всички поддържат). Връща "YYYY-MM"
                което backend-ът очаква. max-ът ограничава до текущия
                месец — бъдещ месец би върнал празен отчет. */}
            <Input
              type="month"
              value={reportMonth}
              onChange={(e) => setReportMonth(e.target.value)}
              max={currentMonthLocal()}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMonthlyReportOpen(false)}
            >
              Отказ
            </Button>
            <Button
              onClick={() => void downloadMonthlyReport()}
              disabled={isDownloading}
              className="bg-[#6c3dff] hover:bg-[#5a30d9]"
            >
              <Printer className="h-4 w-4" />
              {isDownloading ? "Сваляне…" : "Свали PDF"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
