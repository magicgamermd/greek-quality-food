import "./global.css";
import React, { useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AppNavigator } from "./src/navigation/AppNavigator";
import { AuthContext, useAuthState } from "./src/hooks/useAuth";
import { authStore } from "./src/store/authStore";
import { LoadingSpinner } from "./src/components/LoadingSpinner";
import { colors } from "./src/theme/colors";

// ─── React Query client ───────────────────────────────────────────────────────
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 30_000,      // 30 seconds
      gcTime: 5 * 60_000,     // 5 minutes
      refetchOnWindowFocus: false,
    },
  },
});

// ─── Auth Provider ────────────────────────────────────────────────────────────
function AuthProvider({ children }: { children: React.ReactNode }) {
  const authState = useAuthState();

  useEffect(() => {
    // Restore session on startup
    (async () => {
      try {
        const token = await authStore.getToken();
        const user = await authStore.getUser();
        if (token && user) {
          authState.setToken(token);
          authState.setUser(user);
        }
      } catch (e) {
        console.error("[Auth] Restore error:", e);
      } finally {
        authState.setIsLoading(false);
      }
    })();
  }, []);

  if (authState.isLoading) {
    return <LoadingSpinner message="Зареждане..." />;
  }

  return (
    <AuthContext.Provider value={authState}>
      {children}
    </AuthContext.Provider>
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <StatusBar style="light" backgroundColor={colors.background} />
          <AppNavigator />
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
