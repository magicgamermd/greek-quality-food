// warehouse-frontend/src/components/OversellConfirmDialog.tsx
import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface OversellItem {
  product_name: string;
  available: number;
  requested: number;
  final_stock: number; // negative
  // Batch F1 — required for the new split actions. Optional for
  // backward compat with any old caller that didn't pass it; the
  // split buttons hide when missing so the dialog still works.
  product_id?: number;
}

export interface OversellConfirmDialogProps {
  open: boolean;
  items: OversellItem[];
  onConfirm: () => void;
  onCancel: () => void;
  // Batch F1 split actions — optional. When provided, the dialog shows
  // three additional buttons:
  //   - reduce          → caller clamps each over-stock line to its
  //                       available qty (no split)
  //   - splitPaidNotTaken / splitAwaiting → caller splits each over-stock
  //                       line into 'normal at available' + 'flagged for
  //                       the rest', with the chosen line_status
  // Each callback receives the oversell items so the caller can iterate.
  onReduceToAvailable?: (items: OversellItem[]) => void;
  onSplitToPaidNotTaken?: (items: OversellItem[]) => void;
  onSplitToAwaiting?: (items: OversellItem[]) => void;
}

export function OversellConfirmDialog({
  open,
  items,
  onConfirm,
  onCancel,
  onReduceToAvailable,
  onSplitToPaidNotTaken,
  onSplitToAwaiting,
}: OversellConfirmDialogProps) {
  const hasSplitActions =
    onReduceToAvailable && onSplitToPaidNotTaken && onSplitToAwaiting;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-700">
            <AlertTriangle className="h-5 w-5" />
            Наличността ще отиде под нулата
          </DialogTitle>
          <DialogDescription>
            {hasSplitActions
              ? 'Избери как да обработиш недостигащите количества — намали ги до наличното, маркирай ги като „платени, но невзети" или „на изчакване". Можеш и да продължиш с минус, ако сделката е спешна.'
              : 'Потвърди, че искаш да продължиш — стоките ще влязат в минус и ще се появят в раздел „На минус" в склада.'}
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2 py-2 max-h-64 overflow-y-auto">
          {items.map((item, idx) => (
            <li
              key={`${item.product_name}-${idx}`}
              className="text-sm leading-snug"
            >
              <span className="font-medium text-gray-900">
                {item.product_name}
              </span>
              {" — ще стане "}
              <span className="font-semibold text-red-600">
                {item.final_stock}
              </span>{" "}
              <span className="text-xs text-gray-500">
                (налично: {item.available}, поръчка: {item.requested})
              </span>
            </li>
          ))}
        </ul>
        {hasSplitActions && (
          <div className="flex flex-wrap gap-2 pt-2 border-t">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onReduceToAvailable!(items)}
              className="border-blue-400 text-blue-700 hover:bg-blue-50"
            >
              Намали до наличност
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onSplitToPaidNotTaken!(items)}
              className="border-amber-400 text-amber-700 hover:bg-amber-50"
            >
              💰 Платена невзета
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onSplitToAwaiting!(items)}
              className="border-gray-400 text-gray-700 hover:bg-gray-100"
            >
              ⏳ На изчакване
            </Button>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel}>
            Отказ
          </Button>
          <Button variant="destructive" onClick={onConfirm} autoFocus>
            Продължи (с минус)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
