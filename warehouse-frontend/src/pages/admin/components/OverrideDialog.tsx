import { useState, useEffect } from "react";
import type { Permission } from "@/lib/permissions";

interface OverrideDialogProps {
  open: boolean;
  permission: Permission | null;
  permissionLabel: string;
  newGranted: boolean;
  userName: string;
  onConfirm: (reason: string | null) => void;
  onCancel: () => void;
}

export function OverrideDialog({
  open,
  permission,
  permissionLabel,
  newGranted,
  userName,
  onConfirm,
  onCancel,
}: OverrideDialogProps) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) setReason("");
  }, [open, permission]);

  if (!open) return null;

  const action = newGranted ? "Грантни" : "Отнеми";

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-md w-full">
        <h3 className="text-lg font-semibold mb-2">
          {action} `{permissionLabel}` за {userName}
        </h3>
        <p className="text-sm text-gray-500 mb-4">
          Permission: <code className="text-xs">{permission}</code>
        </p>

        <label className="block mb-4">
          <span className="text-sm font-medium">Бележка (незадължителна):</span>
          <input
            type="text"
            maxLength={255}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="напр. Временно за инвентаризация"
            className="mt-1 w-full border rounded px-3 py-2 text-sm"
          />
        </label>

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded border text-sm"
          >
            Отказ
          </button>
          <button
            onClick={() => onConfirm(reason.trim() || null)}
            className="px-3 py-1.5 rounded bg-[#f97316] text-white text-sm"
          >
            Потвърди
          </button>
        </div>
      </div>
    </div>
  );
}
