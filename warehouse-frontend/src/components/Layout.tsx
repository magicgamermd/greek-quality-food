import { useState, useRef, useEffect, useMemo } from "react";
import { NavLink, Outlet, useNavigate, useLocation } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  LayoutDashboard,
  Package,
  Warehouse,
  PackagePlus,
  ShoppingCart,
  Users,
  Truck,
  Send,
  FileText,
  CreditCard,
  BarChart3,
  LogOut,
  Menu,
  X,
  Bell,
  ChevronRight,
  Settings,
  CheckCheck,
  Boxes,
  ClipboardList,
  ArrowLeftRight,
  Trash2,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionContext";
import { PERMISSIONS, type Permission } from "@/lib/permissions";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAppSettings } from "@/hooks/useAppSettings";
import {
  useNotificationsPolling,
  type NotificationItem,
} from "@/hooks/useNotificationsPolling";
import { groupForType } from "@/lib/notificationTypes";

const allNavItems: Array<{
  to: string;
  icon: React.ElementType;
  label: string;
  permission?: Permission;
}> = [
  { to: "/", icon: LayoutDashboard, label: "Табло" },
  {
    to: "/products",
    icon: Package,
    label: "Продукти",
    permission: PERMISSIONS.PRODUCTS_VIEW,
  },
  {
    to: "/inventory",
    icon: Warehouse,
    label: "Склад",
    permission: PERMISSIONS.INVENTORY_VIEW,
  },
  {
    to: "/incoming",
    icon: PackagePlus,
    label: "Приемане на стоки",
    permission: PERMISSIONS.INCOMING_MANAGE,
  },
  {
    to: "/stock-movements",
    icon: ArrowLeftRight,
    label: "Завеждане / Изписване",
    permission: PERMISSIONS.STOCK_MOVEMENTS_MANAGE,
  },
  {
    to: "/writeoffs",
    icon: Trash2,
    label: "Брак",
    permission: PERMISSIONS.INVENTORY_VIEW,
  },
  {
    to: "/orders",
    icon: ShoppingCart,
    label: "Поръчки",
    permission: PERMISSIONS.ORDERS_MANAGE,
  },
  {
    to: "/warehouse",
    icon: Boxes,
    label: "Склад пакетиране",
    permission: PERMISSIONS.ORDERS_MANAGE,
  },
  {
    to: "/econt",
    icon: Send,
    label: "Еконт доставки",
    permission: PERMISSIONS.ECONT_MANAGE,
  },
  {
    to: "/partners",
    icon: Users,
    label: "Партньори",
    permission: PERMISSIONS.PARTNERS_MANAGE,
  },
  {
    to: "/suppliers",
    icon: Truck,
    label: "Доставчици",
    permission: PERMISSIONS.PARTNERS_MANAGE,
  },
  {
    to: "/invoices",
    icon: FileText,
    label: "Фактури",
    permission: PERMISSIONS.INVOICES_MANAGE,
  },
  {
    to: "/payments",
    icon: CreditCard,
    label: "Плащания",
    permission: PERMISSIONS.PAYMENTS_MANAGE,
  },
  {
    to: "/analytics",
    icon: BarChart3,
    label: "Анализи",
    permission: PERMISSIONS.REPORTS_VIEW,
  },
  {
    to: "/purchase-orders",
    icon: ClipboardList,
    label: "Заявки",
    permission: PERMISSIONS.PURCHASE_ORDERS_MANAGE,
  },
  {
    to: "/settings",
    icon: Settings,
    label: "Настройки",
    permission: PERMISSIONS.SETTINGS_MANAGE,
  },
];

const routeNames: Record<string, string> = {
  "/": "Табло",
  "/products": "Продукти",
  "/inventory": "Склад",
  "/incoming": "Приемане",
  "/stock-movements": "Завеждане / Изписване",
  "/writeoffs": "Брак",
  "/orders": "Поръчки",
  "/warehouse": "Склад пакетиране",
  "/econt": "Еконт доставки",
  "/partners": "Партньори",
  "/suppliers": "Доставчици",
  "/invoices": "Фактури",
  "/payments": "Плащания",
  "/analytics": "Анализи",
  "/purchase-orders": "Заявки",
  "/settings": "Настройки",
};

export function Layout() {
  const { user, logout } = useAuth();
  const { hasPermission } = usePermissions();
  // Econt master switch (Настройки → Интеграции, мигр. 081): когато
  // Еконт е изключен, „Еконт доставки" се крие от sidebar-а за всички роли.
  const { econtEnabled } = useAppSettings();
  // Еконт работникът е тясна роля — вижда САМО „Еконт доставки" в sidebar-а
  // (огледало на /econt route guard-а). Останалите роли филтрират по
  // permissions както досега.
  const visibleNavItems = allNavItems.filter((item) => {
    if (item.to === "/econt" && !econtEnabled) return false;
    if (user?.role === "econt") return item.to === "/econt";
    return !item.permission || hasPermission(item.permission);
  });
  const navigate = useNavigate();
  const location = useLocation();
  const currentRouteName = routeNames[location.pathname] ?? routeNames["/"];
  const qc = useQueryClient();
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.innerWidth >= 768,
  );
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);

  // Track screen size for responsive sidebar
  useEffect(() => {
    const onResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (mobile) setSidebarOpen(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const navigateFromPayload = (payload: any, _type: string) => {
    setNotifOpen(false);
    if (payload?.order_id) {
      navigate(`/orders?highlight=${payload.order_id}`);
    } else if (payload?.product_id) {
      navigate(`/products?highlight=${payload.product_id}`);
    }
  };

  const { data: notificationsResp } = useNotificationsPolling({
    onClickPayload: navigateFromPayload,
  });
  const notifications: NotificationItem[] = notificationsResp?.data ?? [];
  const unreadCount = notifications.filter((n) => !n.is_read).length;

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
    };
    if (notifOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [notifOpen]);

  const markReadMutation = useMutation({
    mutationFn: (id: string) => api.put(`/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const markAllReadMutation = useMutation({
    mutationFn: () =>
      api.post("/notifications/read-all", {
        ids: notifications.filter((n) => !n.is_read).map((n) => n.id),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const dismissMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/notifications/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const grouped = useMemo(() => {
    const out: Record<string, NotificationItem[]> = {};
    for (const n of notifications) {
      const g = groupForType(n.type);
      (out[g] ??= []).push(n);
    }
    return out;
  }, [notifications]);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Mobile backdrop */}
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 transition-opacity"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "flex flex-col bg-[#1a1a2e] text-white transition-all duration-300 shrink-0",
          isMobile
            ? cn(
                "fixed inset-y-0 left-0 z-50 w-64 transform transition-transform duration-300",
                sidebarOpen ? "translate-x-0" : "-translate-x-full",
              )
            : sidebarOpen
              ? "w-64"
              : "w-16",
        )}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-4 py-5 border-b border-white/10">
          <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-[#6c3dff] shrink-0">
            <span className="text-white font-bold text-sm">GQ</span>
          </div>
          {(sidebarOpen || isMobile) && (
            <div className="overflow-hidden">
              <p className="font-bold text-sm leading-tight">
                Greek Quality Food
              </p>
              <p className="text-xs text-white/50">Складова система</p>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 py-4 overflow-y-auto">
          {visibleNavItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              onClick={() => {
                if (isMobile) setSidebarOpen(false);
              }}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 px-4 py-2.5 mx-2 rounded-lg text-sm transition-colors group relative",
                  isActive
                    ? "bg-[#6c3dff] text-white"
                    : "text-white/70 hover:bg-white/10 hover:text-white",
                )
              }
            >
              <Icon className="h-5 w-5 shrink-0" />
              {(sidebarOpen || isMobile) && (
                <span className="truncate">{label}</span>
              )}
              {!sidebarOpen && !isMobile && (
                <div className="absolute left-full ml-2 z-50 hidden group-hover:block bg-gray-900 text-white text-xs px-2 py-1 rounded whitespace-nowrap">
                  {label}
                </div>
              )}
            </NavLink>
          ))}
        </nav>

        {/* User & Logout */}
        <div className="border-t border-white/10 p-4">
          {sidebarOpen || isMobile ? (
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-full bg-[#6c3dff] flex items-center justify-center shrink-0">
                <span className="text-xs font-bold">
                  {user?.name?.charAt(0)}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{user?.name}</p>
                <p className="text-xs text-white/50 truncate">{user?.role}</p>
              </div>
              <button
                onClick={handleLogout}
                className="text-white/50 hover:text-white transition-colors"
                title="Изход"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <button
              onClick={handleLogout}
              className="flex items-center justify-center w-full text-white/50 hover:text-white transition-colors"
            >
              <LogOut className="h-5 w-5" />
            </button>
          )}
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Header */}
        <header className="flex items-center gap-4 bg-white border-b border-gray-200 px-6 py-3 shrink-0">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="text-gray-500 hover:text-gray-700 transition-colors"
          >
            {sidebarOpen ? (
              <X className="h-5 w-5" />
            ) : (
              <Menu className="h-5 w-5" />
            )}
          </button>

          {/* Breadcrumb */}
          <div className="flex items-center gap-1 text-sm text-gray-500">
            <span>Greek Quality Food</span>
            <ChevronRight className="h-4 w-4" />
            <span className="text-gray-900 font-medium">
              {currentRouteName}
            </span>
          </div>

          <div className="flex-1" />

          {/* Notifications */}
          <div className="relative" ref={notifRef}>
            <button
              onClick={() => setNotifOpen(!notifOpen)}
              className="relative text-gray-500 hover:text-gray-700 transition-colors"
            >
              <Bell className="h-5 w-5" />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 h-4 min-w-4 px-0.5 rounded-full bg-red-500 text-[10px] text-white flex items-center justify-center">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </button>

            {/* Notification dropdown */}
            {notifOpen && (
              <div className="absolute right-0 top-full mt-2 w-[min(24rem,calc(100vw-1rem))] bg-white rounded-xl shadow-xl border border-gray-200 z-50 max-h-[28rem] flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
                  <h3 className="text-sm font-semibold text-gray-900">
                    Известия
                  </h3>
                  {unreadCount > 0 && (
                    <button
                      onClick={() => markAllReadMutation.mutate()}
                      className="flex items-center gap-1 text-xs text-[#6c3dff] hover:underline"
                      disabled={markAllReadMutation.isPending}
                    >
                      <CheckCheck className="h-3.5 w-3.5" />
                      Маркирай всички
                    </button>
                  )}
                </div>

                {/* Grouped list */}
                <div className="flex-1 overflow-y-auto">
                  {notifications.length === 0 ? (
                    <div className="px-4 py-8 text-center text-gray-400 text-sm">
                      Нямаш нови известия
                    </div>
                  ) : (
                    Object.entries(grouped).map(([group, items]) => (
                      <div key={group}>
                        <div className="px-3 py-1 text-[11px] uppercase tracking-wide font-semibold text-gray-500 bg-gray-50 sticky top-0">
                          {group}
                        </div>
                        {items.map((n) => (
                          <div
                            key={n.id}
                            className={`flex items-start gap-2 border-b last:border-b-0 ${
                              n.is_read ? "opacity-60" : ""
                            }`}
                          >
                            <button
                              onClick={() => {
                                if (!n.is_read) markReadMutation.mutate(n.id);
                                navigateFromPayload(n.payload, n.type);
                              }}
                              className="flex-1 text-left px-3 py-2 hover:bg-gray-50 min-w-0"
                            >
                              <div className="flex items-start gap-2">
                                <span
                                  className={`mt-1 text-xs shrink-0 ${
                                    n.is_read
                                      ? "text-gray-400"
                                      : "text-[#6c3dff]"
                                  }`}
                                  aria-hidden="true"
                                >
                                  {n.is_read ? "✓" : "•"}
                                </span>
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm text-gray-900 truncate">
                                    {n.message}
                                  </div>
                                  <div className="text-xs text-gray-400 mt-0.5">
                                    {new Date(n.created_at).toLocaleString(
                                      "bg-BG",
                                    )}
                                  </div>
                                </div>
                              </div>
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                dismissMutation.mutate(n.id);
                              }}
                              className="text-gray-300 hover:text-gray-500 transition-colors shrink-0 px-2 py-2"
                              title="Премахни"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* User */}
          <div className="flex items-center gap-2 text-sm">
            <div className="h-8 w-8 rounded-full bg-[#6c3dff] flex items-center justify-center">
              <span className="text-xs text-white font-bold">
                {user?.name?.charAt(0)}
              </span>
            </div>
            <span className="text-gray-700 font-medium hidden sm:block">
              {user?.name}
            </span>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
