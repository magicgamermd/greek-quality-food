import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { usePermissions } from "@/contexts/PermissionContext";
import type { Permission } from "@/lib/permissions";

interface RequirePermissionProps {
  permission: Permission;
  children: ReactNode;
  redirectTo?: string;
}

export function RequirePermission({
  permission,
  children,
  redirectTo = "/",
}: RequirePermissionProps) {
  const { hasPermission, isLoading } = usePermissions();

  if (isLoading) {
    return <div className="p-8 text-muted-foreground">Зареждане...</div>;
  }

  if (!hasPermission(permission)) {
    return <Navigate to={redirectTo} replace />;
  }

  return <>{children}</>;
}
