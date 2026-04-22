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
}

export interface OversellConfirmDialogProps {
  open: boolean;
  items: OversellItem[];
  onConfirm: () => void;
  onCancel: () => void;
}

export function OversellConfirmDialog({
  open,
  items,
  onConfirm,
  onCancel,
}: OversellConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-700">
            <AlertTriangle className="h-5 w-5" />
            Наличността ще отиде под нулата
          </DialogTitle>
          <DialogDescription>
            Потвърди, че искаш да продължиш — стоките ще влязат в минус и ще се
            появят в раздел „На минус" в склада.
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
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel}>
            Отказ
          </Button>
          <Button variant="destructive" onClick={onConfirm} autoFocus>
            Продължи
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
