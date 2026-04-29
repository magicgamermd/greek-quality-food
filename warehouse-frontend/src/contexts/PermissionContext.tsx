import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Permission, UserRole } from "@/lib/permissions";

interface MeResponse {
  user: {
    id: string;
    email: string;
    name: string;
    role: UserRole;
  };
  permissions: Permission[];
}

interface PermissionContextValue {
  user: MeResponse["user"] | null;
  permissions: Set<Permission>;
  isLoading: boolean;
  hasPermission: (perm: Permission) => boolean;
  refresh: () => Promise<unknown>;
}

const PermissionContext = createContext<PermissionContextValue | null>(null);

export function PermissionProvider({ children }: { children: ReactNode }) {
  const { data, isLoading, refetch } = useQuery<MeResponse>({
    queryKey: ["me"],
    queryFn: () => api.get("/auth/me").then((r) => r.data),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: false,
  });

  const permissions = useMemo(
    () => new Set<Permission>(data?.permissions ?? []),
    [data?.permissions],
  );

  const hasPermission = useCallback(
    (perm: Permission) => {
      if (data?.user?.role === "admin") return true;
      return permissions.has(perm);
    },
    [permissions, data?.user?.role],
  );

  const value = useMemo<PermissionContextValue>(
    () => ({
      user: data?.user ?? null,
      permissions,
      isLoading,
      hasPermission,
      refresh: refetch,
    }),
    [data?.user, permissions, isLoading, hasPermission, refetch],
  );

  return (
    <PermissionContext.Provider value={value}>
      {children}
    </PermissionContext.Provider>
  );
}

export function usePermissions() {
  const ctx = useContext(PermissionContext);
  if (!ctx) {
    throw new Error("usePermissions must be used within PermissionProvider");
  }
  return ctx;
}
