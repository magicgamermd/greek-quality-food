import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
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
  // AuthContext loads `user` synchronously from localStorage on mount,
  // so we have the user's role before `/auth/me` resolves. We use this
  // as a fallback during the initial query load — without it, all
  // permission-gated nav items, KPIs and buttons disappear briefly on
  // every cold open until /auth/me completes (looks like a broken UI
  // until you refresh the page).
  const { user: authUser } = useAuth();

  const { data, isLoading, refetch } = useQuery<MeResponse>({
    queryKey: ["me"],
    queryFn: () => api.get("/auth/me").then((r) => r.data),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: false,
  });

  const queryClient = useQueryClient();
  useEffect(() => {
    const handler = () => {
      queryClient.invalidateQueries({ queryKey: ["me"] });
    };
    window.addEventListener("permissions:revoked", handler);
    return () => window.removeEventListener("permissions:revoked", handler);
  }, [queryClient]);

  const permissions = useMemo(
    () => new Set<Permission>(data?.permissions ?? []),
    [data?.permissions],
  );

  // Effective role: prefer the freshly-fetched value from /auth/me,
  // fall back to the locally stored auth user while the query is
  // loading. Both are typed the same (UserRole) so this is safe.
  const effectiveRole: UserRole | undefined =
    (data?.user?.role as UserRole | undefined) ??
    (authUser?.role as UserRole | undefined);

  const hasPermission = useCallback(
    (perm: Permission) => {
      if (effectiveRole === "admin") return true;
      // While /auth/me is still loading we don't yet know the
      // permission set for non-admin users — be optimistic so the
      // sidebar/KPIs don't flicker out and back in. The backend is
      // the actual gatekeeper for any mutating action.
      if (isLoading && !data && authUser) return true;
      return permissions.has(perm);
    },
    [permissions, effectiveRole, isLoading, data, authUser],
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
