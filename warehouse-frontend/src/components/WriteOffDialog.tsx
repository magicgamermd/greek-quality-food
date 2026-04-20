import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { formatCurrency, getApiErrorMessage } from "@/lib/utils";

/**
 * Stock write-off ("бракуване") dialog — records physical disposal of
 * expired / damaged / lost goods with an immutable audit record plus
 * an auto-generated БРАК-YYYY-NNNN protocol number for НАП compliance.
 */
export type WriteOffTarget = {
  product_id: number;
  product_name: string;
  batch_id: number | null;
  batch_number: string | null;
  expiry_date: string | null;
  current_quantity: number;
  unit_cost: number | null;
  unit: string | null;
};

const REASON_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "expired", label: "Изтекъл срок на годност" },
  { value: "damaged", label: "Повреден / физическо увреждане" },
  { value: "theft", label: "Липса / открадване" },
  { value: "count_correction", label: "Коригиране при инвентаризация" },
  { value: "recall", label: "Изтегляне от пазара" },
  { value: "other", label: "Друго" },
];

interface Props {
  open: boolean;
  target: WriteOffTarget | null;
  onClose: () => void;
}

export function WriteOffDialog({ open, target, onClose }: Props) {
  const qc = useQueryClient();

  const [quantity, setQuantity] = useState<string>("");
  const [reason, setReason] = useState<string>("expired");
  const [notes, setNotes] = useState<string>("");

  // Reset form whenever the target changes (user clicks a different row)
  // or when the dialog is reopened. Keyed on (product_id, batch_id) so
  // revisiting the same row keeps any in-progress edits from a partial
  // interaction.
  useEffect(() => {
    if (!open || !target) return;
    setQuantity(String(target.current_quantity));
    setReason("expired");
    setNotes("");
  }, [open, target?.product_id, target?.batch_id]);

  // Live unit-cost preview — fetches the authoritative batch cost the
  // backend will actually use for the write-off. Inventory list API
  // returns product-level purchase_price but batches may carry their
  // own unit_cost; this query reads it straight from the batches table
  // so the "Общо стойност" preview matches the real total_cost the
  // server will record.
  const batchCostQ = useQuery<{ unit_cost: number }>({
    queryKey: ["batch-unit-cost", target?.product_id, target?.batch_id],
    queryFn: async () => {
      if (!target) return { unit_cost: 0 };
      // Use the existing list endpoint filtered by product — cheaper than
      // adding a new GET /batches/:id route and sufficient since products
      // typically have a handful of batches. Find our specific batch_id.
      if (target.batch_id != null) {
        try {
          const res = await api.get(`/batches?product_id=${target.product_id}`);
          const rows: any[] = Array.isArray(res.data)
            ? res.data
            : (res.data?.data ?? []);
          const batch = rows.find((b) => b.id === target.batch_id);
          if (batch) {
            const cost = Number(batch.unit_cost ?? batch.purchase_price ?? 0);
            if (Number.isFinite(cost) && cost > 0) return { unit_cost: cost };
          }
        } catch {
          /* fall through to item fallback */
        }
      }
      // Fallback: product-level purchase_price snapshot from inventory row
      return { unit_cost: Number(target.unit_cost ?? 0) || 0 };
    },
    enabled: open && target != null,
    staleTime: 60_000,
  });

  const writeOffMutation = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error("No target");
      const qty = parseFloat(quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error("Невалидно количество");
      }
      if (qty > target.current_quantity + 1e-6) {
        throw new Error(
          `Количеството надвишава наличното (${target.current_quantity})`,
        );
      }
      const res = await api.post("/inventory/write-offs", {
        product_id: target.product_id,
        batch_id: target.batch_id,
        quantity: qty,
        reason,
        notes: notes.trim() || undefined,
      });
      return res.data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["inventory-writeoffs-summary"] });
      qc.invalidateQueries({ queryKey: ["writeoffs"] });
      toast.success(
        `Бракувано. Протокол ${data.document_number ?? "генериран"}.`,
      );
      onClose(); // useEffect on next target change will re-init form
    },
    onError: (err) => {
      toast.error(getApiErrorMessage(err, "Грешка при бракуване."));
    },
  });

  const qtyNum = parseFloat(quantity);
  // Prefer the freshly-fetched batch cost; fall back to the stale value
  // passed in from the inventory row while the fetch is in-flight. Both
  // may be string (DB NUMERIC) in the wild — Number() coerces safely.
  const unitCost =
    Number(batchCostQ.data?.unit_cost ?? target?.unit_cost ?? 0) || 0;
  const totalCost = Number.isFinite(qtyNum) ? qtyNum * unitCost : 0;
  const qtyInvalid =
    !Number.isFinite(qtyNum) ||
    qtyNum <= 0 ||
    (target != null && qtyNum > target.current_quantity + 1e-6);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-red-700">Бракуване на стока</DialogTitle>
        </DialogHeader>

        {target ? (
          <div className="space-y-3">
            {/* Read-only context block */}
            <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm space-y-1">
              <div>
                <span className="text-gray-500">Артикул:</span>{" "}
                <span className="font-medium">{target.product_name}</span>
              </div>
              {target.batch_number ? (
                <div>
                  <span className="text-gray-500">Партида №:</span>{" "}
                  <span className="font-mono">{target.batch_number}</span>
                </div>
              ) : null}
              {target.expiry_date ? (
                <div>
                  <span className="text-gray-500">Срок:</span>{" "}
                  {new Date(target.expiry_date).toLocaleDateString("bg-BG")}
                </div>
              ) : null}
              <div>
                <span className="text-gray-500">Налично:</span>{" "}
                <span className="font-mono">
                  {target.current_quantity.toFixed(3)}
                </span>{" "}
                {target.unit ?? ""}
              </div>
            </div>

            {/* Quantity + reason */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Количество за бракуване</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.001"
                  max={target.current_quantity}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className={
                    qtyInvalid
                      ? "border-red-500 focus-visible:ring-red-300"
                      : undefined
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>Причина</Label>
                <Select
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                >
                  {REASON_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            {/* Notes */}
            <div className="space-y-1">
              <Label>Забележки (по избор)</Label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value.slice(0, 500))}
                maxLength={500}
                rows={3}
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6c3dff]"
                placeholder={
                  reason === "other"
                    ? "Опиши причината..."
                    : "Допълнителни обстоятелства..."
                }
              />
            </div>

            {/* Cost summary */}
            <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm">
              <div className="flex justify-between">
                <span>Ед. цена (от партидата):</span>
                <span className="font-mono">{formatCurrency(unitCost)}</span>
              </div>
              <div className="flex justify-between font-semibold text-red-800 pt-1 border-t border-red-200 mt-1">
                <span>Обща стойност за бракуване:</span>
                <span className="font-mono">{formatCurrency(totalCost)}</span>
              </div>
            </div>

            <p className="text-xs text-gray-500">
              Ще бъде генериран протокол БРАК-
              {new Date().getFullYear()}-NNNN за НАП audit trail. Записът е
              необратим след потвърждаване.
            </p>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={writeOffMutation.isPending}
          >
            Отказ
          </Button>
          <Button
            variant="destructive"
            onClick={() => writeOffMutation.mutate()}
            disabled={
              qtyInvalid || writeOffMutation.isPending || target == null
            }
          >
            {writeOffMutation.isPending ? "Бракува се..." : "Бракувай"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
