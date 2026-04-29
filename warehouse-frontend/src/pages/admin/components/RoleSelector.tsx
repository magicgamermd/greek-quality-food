import { useState } from "react";
import type { UserRole } from "@/lib/permissions";

interface RoleSelectorProps {
  current: UserRole;
  disabled: boolean;
  onChange: (newRole: UserRole) => void;
}

const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Admin",
  accountant: "Accountant (Счетоводител)",
  warehouse: "Warehouse (Склад)",
  sales: "Sales (Служител)",
};

export function RoleSelector({
  current,
  disabled,
  onChange,
}: RoleSelectorProps) {
  const [pending, setPending] = useState<UserRole | null>(null);

  return (
    <div>
      <select
        value={current}
        disabled={disabled}
        onChange={(e) => setPending(e.target.value as UserRole)}
        className="border rounded px-3 py-1.5 text-sm"
      >
        {(Object.keys(ROLE_LABELS) as UserRole[]).map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </select>

      {pending && pending !== current && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md">
            <h3 className="text-lg font-semibold mb-2">Смяна на роля</h3>
            <p className="text-sm mb-4">
              Промяната на ролята <strong>изтрива всички overrides</strong> за
              този user. Сигурен ли си?
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPending(null)}
                className="px-3 py-1.5 border rounded text-sm"
              >
                Отказ
              </button>
              <button
                onClick={() => {
                  onChange(pending);
                  setPending(null);
                }}
                className="px-3 py-1.5 rounded bg-[#f97316] text-white text-sm"
              >
                Промени
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
