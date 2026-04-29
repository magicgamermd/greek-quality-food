import type { Permission, PermissionRegistryEntry } from "@/lib/permissions";

interface OverrideInfo {
  granted: boolean;
  reason: string | null;
}

interface PermissionRowProps {
  entry: PermissionRegistryEntry;
  effective: boolean;
  override: OverrideInfo | null;
  isFromRoleDefault: boolean;
  roleLabel: string;
  disabled: boolean;
  onToggle: (permission: Permission, currentlyEffective: boolean) => void;
  onReset: (permission: Permission) => void;
}

export function PermissionRow({
  entry,
  effective,
  override,
  isFromRoleDefault,
  roleLabel,
  disabled,
  onToggle,
  onReset,
}: PermissionRowProps) {
  return (
    <div
      className={`border rounded p-3 mb-2 bg-white ${disabled ? "opacity-60" : "hover:bg-gray-50"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <label
          className={`flex items-start gap-3 flex-1 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
        >
          <input
            type="checkbox"
            checked={effective}
            disabled={disabled}
            onChange={() => onToggle(entry.permission, effective)}
            className="mt-1 h-4 w-4 cursor-pointer disabled:cursor-not-allowed"
          />
          <div className="flex-1 select-none">
            <div className="flex items-center gap-2">
              <div className="font-medium">{entry.label}</div>
              {override && (
                <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                  ✏️ override
                </span>
              )}
            </div>
            <div className="text-sm text-gray-500">{entry.description}</div>
            <div className="text-xs text-gray-400 mt-1">
              default {isFromRoleDefault ? "✓" : "✗"} от {roleLabel}
              {override?.reason && (
                <span className="ml-2 italic">— „{override.reason}"</span>
              )}
            </div>
          </div>
        </label>
        {override && (
          <button
            onClick={() => onReset(entry.permission)}
            disabled={disabled}
            className="text-xs text-blue-600 hover:underline disabled:opacity-50 disabled:cursor-not-allowed self-start mt-1"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
