import { useMemo } from "react";
import { PermissionRow } from "./PermissionRow";
import type {
  Permission,
  PermissionRegistryEntry,
  UserPermissionsResponse,
} from "@/lib/permissions";

interface PermissionMatrixProps {
  registry: PermissionRegistryEntry[];
  data: UserPermissionsResponse;
  disabled: boolean;
  onToggle: (permission: Permission, currentlyEffective: boolean) => void;
  onReset: (permission: Permission) => void;
}

export function PermissionMatrix({
  registry,
  data,
  disabled,
  onToggle,
  onReset,
}: PermissionMatrixProps) {
  const roleDefaults = useMemo(
    () => new Set(data.role_defaults),
    [data.role_defaults],
  );
  const effective = useMemo(() => new Set(data.effective), [data.effective]);
  const overridesMap = useMemo(() => {
    const m = new Map<
      Permission,
      { granted: boolean; reason: string | null }
    >();
    for (const o of data.overrides) {
      m.set(o.permission, { granted: o.granted, reason: o.reason });
    }
    return m;
  }, [data.overrides]);

  const groups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, PermissionRegistryEntry[]>();
    for (const entry of registry) {
      if (!map.has(entry.group)) {
        map.set(entry.group, []);
        order.push(entry.group);
      }
      map.get(entry.group)!.push(entry);
    }
    return order.map((g) => ({ group: g, entries: map.get(g)! }));
  }, [registry]);

  return (
    <div>
      {groups.map(({ group, entries }) => (
        <div key={group} className="mb-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">{group}</h3>
          {entries.map((entry) => (
            <PermissionRow
              key={entry.permission}
              entry={entry}
              effective={effective.has(entry.permission)}
              override={overridesMap.get(entry.permission) ?? null}
              isFromRoleDefault={roleDefaults.has(entry.permission)}
              roleLabel={data.role}
              disabled={disabled}
              onToggle={onToggle}
              onReset={onReset}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
