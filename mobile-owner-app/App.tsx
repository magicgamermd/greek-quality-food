import React, { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { OwnerNavigator } from "./src/navigation/OwnerNavigator";
import { AuthContext, useAuthState } from "./src/hooks/useAuth";
import { authStore } from "./src/store/authStore";
import { LoadingState } from "./src/components/LoadingState";
import { colors } from "./src/theme/colors";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
    },
  },
});

function AuthProvider({ children }: { children: React.ReactNode }) {
  const authState = useAuthState();

  useEffect(() => {
    (async () => {
      try {
        const token = await authStore.getToken();
        const user = await authStore.getUser();
        if (token && user) {
          authState.setToken(token);
          authState.setUser(user);
        }
      } finally {
        authState.setIsLoading(false);
      }
    })();
  }, []);

  if (authState.isLoading) {
    return <LoadingState message="Зареждане на owner приложението..." />;
  }

  return <AuthContext.Provider value={authState}>{children}</AuthContext.Provider>;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <StatusBar style="light" backgroundColor={colors.background} />
          <OwnerNavigator />
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
