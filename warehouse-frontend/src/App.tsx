import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { Layout } from "@/components/Layout";
import { OwnerLayout } from "@/components/OwnerLayout";
import { Login } from "@/pages/Login";
import { Dashboard } from "@/pages/Dashboard";
import { Products } from "@/pages/Products";
import { Inventory } from "@/pages/Inventory";
import { IncomingGoods } from "@/pages/IncomingGoods";
import { Orders } from "@/pages/Orders";
import { WarehousePacking } from "@/pages/WarehousePacking";
import { Partners } from "@/pages/Partners";
import { Suppliers } from "@/pages/Suppliers";
import { Invoices } from "@/pages/Invoices";
import { Payments } from "@/pages/Payments";
import { Analytics } from "@/pages/Analytics";
import { Settings } from "@/pages/Settings";
import { OwnerAnalytics } from "@/pages/OwnerAnalytics";
import { OwnerDashboard } from "@/pages/owner/OwnerDashboard";
import { OwnerScan } from "@/pages/owner/OwnerScan";
import { OwnerPayments } from "@/pages/owner/OwnerPayments";
import { OwnerTop } from "@/pages/owner/OwnerTop";
import { OwnerDeliveries } from "@/pages/owner/OwnerDeliveries";
import { NotFound } from "@/pages/NotFound";
import { PWAInstallPrompt } from "@/components/PWAInstallPrompt";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

function ProtectedRoute({
  children,
  allowedRoles,
  loginPath = "/login",
  redirectTo = "/",
  blockOwnerMobileSession = false,
}: {
  children: React.ReactNode;
  allowedRoles?: string[];
  loginPath?: string;
  redirectTo?: string;
  blockOwnerMobileSession?: boolean;
}) {
  const { isAuthenticated, user, isOwnerMobileSession } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) return <Navigate to={loginPath} replace />;
  if (
    blockOwnerMobileSession &&
    isOwnerMobileSession &&
    !location.pathname.startsWith("/owner")
  ) {
    return <Navigate to="/owner" replace />;
  }
  if (allowedRoles && !allowedRoles.includes(user?.role || "")) {
    return <Navigate to={redirectTo} replace />;
  }
  return <>{children}</>;
}

function AppRoutes() {
  const { isAuthenticated, isOwnerMobileSession } = useAuth();
  return (
    <Routes>
      <Route
        path="/owner/login"
        element={
          isAuthenticated ? (
            <Navigate to={isOwnerMobileSession ? "/owner" : "/"} replace />
          ) : (
            <Login
              redirectTo="/owner"
              appTitle="МЕРТ-М Owner"
              subtitle="Owner PWA: анализи и приемане на доставки"
              loginHeading="Вход в owner PWA"
              theme="owner"
              loginProfile="owner_mobile"
              allowedRoles={["admin", "owner_mobile"]}
            />
          )
        }
      />
      <Route
        path="/owner"
        element={
          <ProtectedRoute
            allowedRoles={["admin", "owner_mobile"]}
            loginPath="/owner/login"
            redirectTo="/"
          >
            <OwnerLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/owner/dashboard" replace />} />
        <Route path="dashboard" element={<OwnerDashboard />} />
        <Route path="scan" element={<OwnerScan />} />
        <Route path="payments" element={<OwnerPayments />} />
        <Route path="top" element={<OwnerTop />} />
        {/* Legacy routes kept for backwards compatibility / deep links */}
        <Route path="analytics" element={<OwnerAnalytics />} />
        <Route
          path="incoming"
          element={<Navigate to="/owner/scan" replace />}
        />
        <Route
          path="incoming/scan"
          element={<Navigate to="/owner/scan" replace />}
        />
        <Route path="*" element={<Navigate to="/owner/dashboard" replace />} />
      </Route>
      <Route
        path="/login"
        element={
          isAuthenticated ? (
            <Navigate to={isOwnerMobileSession ? "/owner" : "/"} replace />
          ) : (
            <Login />
          )
        }
      />
      <Route
        path="/"
        element={
          <ProtectedRoute
            allowedRoles={["admin", "warehouse", "accountant"]}
            blockOwnerMobileSession
            redirectTo="/owner"
          >
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route
          path="products"
          element={
            <ProtectedRoute allowedRoles={["admin", "warehouse"]}>
              <Products />
            </ProtectedRoute>
          }
        />
        <Route
          path="inventory"
          element={
            <ProtectedRoute allowedRoles={["admin", "warehouse"]}>
              <Inventory />
            </ProtectedRoute>
          }
        />
        <Route
          path="incoming"
          element={
            <ProtectedRoute allowedRoles={["admin", "warehouse"]}>
              <IncomingGoods />
            </ProtectedRoute>
          }
        />
        <Route
          path="orders"
          element={
            <ProtectedRoute allowedRoles={["admin", "warehouse"]}>
              <Orders />
            </ProtectedRoute>
          }
        />
        <Route
          path="warehouse"
          element={
            <ProtectedRoute allowedRoles={["admin", "warehouse"]}>
              <WarehousePacking />
            </ProtectedRoute>
          }
        />
        <Route
          path="partners"
          element={
            <ProtectedRoute allowedRoles={["admin", "warehouse"]}>
              <Partners />
            </ProtectedRoute>
          }
        />
        <Route
          path="suppliers"
          element={
            <ProtectedRoute allowedRoles={["admin", "warehouse"]}>
              <Suppliers />
            </ProtectedRoute>
          }
        />
        <Route
          path="invoices"
          element={
            <ProtectedRoute allowedRoles={["admin", "accountant"]}>
              <Invoices />
            </ProtectedRoute>
          }
        />
        <Route
          path="payments"
          element={
            <ProtectedRoute allowedRoles={["admin", "accountant"]}>
              <Payments />
            </ProtectedRoute>
          }
        />
        <Route
          path="analytics"
          element={
            <ProtectedRoute allowedRoles={["admin"]}>
              <Analytics />
            </ProtectedRoute>
          }
        />
        <Route
          path="settings"
          element={
            <ProtectedRoute allowedRoles={["admin"]}>
              <Settings />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route
        path="*"
        element={
          isAuthenticated && isOwnerMobileSession ? (
            <Navigate to="/owner" replace />
          ) : (
            <NotFound />
          )
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={200}>
          <AuthProvider>
            <BrowserRouter>
              <AppRoutes />
              <PWAInstallPrompt />
              <Toaster
                richColors
                position="top-right"
                closeButton
                expand
                duration={4000}
              />
            </BrowserRouter>
          </AuthProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
