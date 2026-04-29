import type { ReactNode } from "react";
import { usePermissions } from "@/contexts/PermissionContext";
import type { Permission } from "@/lib/permissions";

interface CanProps {
  permission: Permission | Permission[];
  mode?: "any" | "all";
  fallback?: ReactNode;
  children: ReactNode;
}

export function Can({
  permission,
  mode = "any",
  fallback = null,
  children,
}: CanProps) {
  const { hasPermission } = usePermissions();
  const perms = Array.isArray(permission) ? permission : [permission];
  const allowed =
    mode === "all" ? perms.every(hasPermission) : perms.some(hasPermission);
  return <>{allowed ? children : fallback}</>;
}
