import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ArrowLeft } from "lucide-react";
import { PermissionMatrix } from "./components/PermissionMatrix";
import { OverrideDialog } from "./components/OverrideDialog";
import { RoleSelector } from "./components/RoleSelector";
import { AuditTrail } from "./components/AuditTrail";
import { usePermissions } from "@/contexts/PermissionContext";
import type {
  Permission,
  PermissionRegistryEntry,
  UserPermissionsResponse,
  UserRole,
} from "@/lib/permissions";

interface UserSummary {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  created_at: string;
}

export function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { user: currentUser } = usePermissions();

  const userQuery = useQuery<UserSummary>({
    queryKey: ["admin", "user", id],
    queryFn: () => api.get(`/users/${id}`).then((r) => r.data),
    enabled: !!id,
  });
  const permsQuery = useQuery<UserPermissionsResponse>({
    queryKey: ["admin", "user", id, "permissions"],
    queryFn: () => api.get(`/users/${id}/permissions`).then((r) => r.data),
    enabled: !!id,
  });
  const registryQuery = useQuery<PermissionRegistryEntry[]>({
    queryKey: ["permissions", "registry"],
    queryFn: () => api.get("/permissions/registry").then((r) => r.data),
    staleTime: Infinity,
  });

  const [dialog, setDialog] = useState<{
    open: boolean;
    permission: Permission | null;
    label: string;
    newGranted: boolean;
  }>({ open: false, permission: null, label: "", newGranted: true });

  const setOverride = useMutation({
    mutationFn: ({
      permission,
      granted,
      reason,
    }: {
      permission: Permission;
      granted: boolean;
      reason: string | null;
    }) =>
      api
        .patch(`/users/${id}/permissions/${permission}`, { granted, reason })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["admin", "user", id, "permissions"],
      });
      queryClient.invalidateQueries({ queryKey: ["audit", "user", id] });
    },
  });

  const resetOverride = useMutation({
    mutationFn: (permission: Permission) =>
      api.delete(`/users/${id}/permissions/${permission}`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["admin", "user", id, "permissions"],
      });
      queryClient.invalidateQueries({ queryKey: ["audit", "user", id] });
    },
  });

  const changeRole = useMutation({
    mutationFn: (role: UserRole) =>
      api.patch(`/users/${id}/role`, { role }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "user", id] });
      queryClient.invalidateQueries({
        queryKey: ["admin", "user", id, "permissions"],
      });
    },
  });

  if (!id) return <div className="p-8">Invalid user id.</div>;
  if (userQuery.isLoading || permsQuery.isLoading || registryQuery.isLoading) {
    return <div className="p-8">Зареждане...</div>;
  }
  if (!userQuery.data || !permsQuery.data || !registryQuery.data) {
    return <div className="p-8 text-red-600">Грешка при зареждане.</div>;
  }

  const user = userQuery.data;
  const perms = permsQuery.data;
  const registry = registryQuery.data;

  const isAdminTarget = user.role === "admin";
  const isSelfTarget = currentUser?.id === id;
  const matrixDisabled =
    isAdminTarget ||
    isSelfTarget ||
    setOverride.isPending ||
    resetOverride.isPending;

  const handleToggle = (
    permission: Permission,
    currentlyEffective: boolean,
  ) => {
    const entry = registry.find((r) => r.permission === permission)!;
    setDialog({
      open: true,
      permission,
      label: entry.label,
      newGranted: !currentlyEffective,
    });
  };

  const handleConfirm = (reason: string | null) => {
    if (!dialog.permission) return;
    setOverride.mutate({
      permission: dialog.permission,
      granted: dialog.newGranted,
      reason,
    });
    setDialog({ open: false, permission: null, label: "", newGranted: true });
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Link
        to="/settings/users"
        className="flex items-center gap-1 text-sm text-blue-600 mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Users
      </Link>

      <div className="bg-white border rounded-lg p-4 mb-6">
        <h1 className="text-xl font-semibold">{user.name}</h1>
        <div className="text-sm text-gray-500">{user.email}</div>
        <div className="text-xs text-gray-400 mt-1">
          Created: {new Date(user.created_at).toLocaleDateString("bg-BG")}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <span className="text-sm">Роля:</span>
          <RoleSelector
            current={user.role}
            disabled={isSelfTarget || changeRole.isPending}
            onChange={(role) => changeRole.mutate(role)}
          />
        </div>
      </div>

      {isAdminTarget && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded text-sm">
          Admin има всички разрешения. За да управляваш правата му, смени ролята
          първо.
        </div>
      )}
      {isSelfTarget && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded text-sm">
          Не можеш да променяш собствените си разрешения.
        </div>
      )}

      <h2 className="text-lg font-semibold mb-3">Разрешения</h2>
      <PermissionMatrix
        registry={registry}
        data={perms}
        disabled={matrixDisabled}
        onToggle={handleToggle}
        onReset={(permission) => resetOverride.mutate(permission)}
      />

      <h2 className="text-lg font-semibold mt-8 mb-3">Audit история</h2>
      <AuditTrail userId={id} />

      <OverrideDialog
        open={dialog.open}
        permission={dialog.permission}
        permissionLabel={dialog.label}
        newGranted={dialog.newGranted}
        userName={user.name}
        onConfirm={handleConfirm}
        onCancel={() =>
          setDialog({
            open: false,
            permission: null,
            label: "",
            newGranted: true,
          })
        }
      />
    </div>
  );
}
