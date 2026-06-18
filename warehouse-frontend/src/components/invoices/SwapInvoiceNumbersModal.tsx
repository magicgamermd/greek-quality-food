import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import type { AxiosError } from "axios";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { X, Plus, RefreshCw } from "lucide-react";

interface SwapResult {
  swapped: Array<{
    id: number;
    old_number: string;
    new_number: string;
    order_id: number | null;
    partner_name: string | null;
  }>;
  cycle_length: number;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function SwapInvoiceNumbersModal({ isOpen, onClose, onSuccess }: Props) {
  const [numbers, setNumbers] = useState<string[]>(["", ""]);

  // Reset state when modal is hidden (handles parent keeping component mounted)
  useEffect(() => {
    if (!isOpen) setNumbers(["", ""]);
  }, [isOpen]);

  const swapMutation = useMutation({
    mutationFn: async (nums: string[]) => {
      const { data } = await api.post<SwapResult>("/invoices/swap-numbers", {
        numbers: nums,
      });
      return data;
    },
    onSuccess: (data) => {
      const summary = data.swapped
        .map((s) => `${s.old_number} → ${s.new_number}`)
        .join(", ");
      toast.success(`Номерата разменени: ${summary}`);
      setNumbers(["", ""]);
      onSuccess?.();
      onClose();
    },
    onError: (err: AxiosError<{ detail?: string }>) => {
      const detail =
        err.response?.data?.detail ?? err.message ?? "Грешка при размяна";
      toast.error(detail);
    },
  });

  if (!isOpen) return null;

  const tenDigit = (s: string) => /^\d{10}$/.test(s);
  const allValid =
    numbers.length >= 2 &&
    numbers.length <= 3 &&
    numbers.every(tenDigit) &&
    new Set(numbers).size === numbers.length;

  const handleAddThird = () => {
    if (numbers.length < 3) setNumbers([...numbers, ""]);
  };

  const handleRemoveThird = () => {
    if (numbers.length === 3) setNumbers(numbers.slice(0, 2));
  };

  const handleChange = (i: number, value: string) => {
    const next = [...numbers];
    next[i] = value.trim();
    setNumbers(next);
  };

  // Preview: rotation A→B→...→A
  const preview = allValid
    ? numbers.map((src, i) => ({
        src,
        dst: numbers[(i + 1) % numbers.length],
      }))
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-gray-700" />
            Размяна на номера на фактури
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            aria-label="Затвори"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="text-sm text-gray-600 mb-4">
          Admin tool: разменя само <code>invoice_number</code> между
          съществуващи фактури. Поръчките, артикулите, плащанията и партньорите
          остават непроменени.
        </p>

        <div className="space-y-3">
          {numbers.map((n, i) => (
            <div key={i} className="flex items-center gap-2">
              <label className="text-sm text-gray-700 w-24">
                Фактура {String.fromCharCode(65 + i)}:
              </label>
              <input
                type="text"
                value={n}
                onChange={(e) => handleChange(i, e.target.value)}
                placeholder="напр. 0000000034"
                className="flex-1 border rounded px-3 py-1.5 text-sm font-mono"
                maxLength={10}
              />
            </div>
          ))}

          {numbers.length === 2 ? (
            <button
              type="button"
              onClick={handleAddThird}
              className="text-xs text-[#6c3dff] hover:underline flex items-center gap-1"
            >
              <Plus className="h-3 w-3" />
              Добави трета фактура (3-cycle)
            </button>
          ) : (
            <button
              type="button"
              onClick={handleRemoveThird}
              className="text-xs text-gray-500 hover:underline"
            >
              Премахни трета фактура
            </button>
          )}
        </div>

        {preview && (
          <div className="mt-4 p-3 bg-gray-50 border rounded text-sm">
            <div className="font-medium text-gray-700 mb-2">Преглед:</div>
            {preview.map((p, i) => (
              <div key={i} className="font-mono">
                <span className="text-gray-900">{p.src}</span>
                <span className="text-gray-400 mx-2">→ ще получи номер →</span>
                <span className="text-gray-900 font-semibold">{p.dst}</span>
              </div>
            ))}
            <div className="mt-2 text-xs text-amber-700">
              ⚠️ Поръчките и данните остават непроменени. Само номерата се
              разменят.
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm border rounded hover:bg-gray-50"
            disabled={swapMutation.isPending}
          >
            Отказ
          </button>
          <button
            type="button"
            onClick={() => swapMutation.mutate(numbers)}
            disabled={!allValid || swapMutation.isPending}
            className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            {swapMutation.isPending ? "Размяна..." : "Размени"}
          </button>
        </div>
      </div>
    </div>
  );
}
