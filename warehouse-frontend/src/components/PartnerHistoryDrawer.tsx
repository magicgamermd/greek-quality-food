import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

export interface PartnerHistoryItem {
  product_id: number;
  product_name: string;
  quantity: number;
  unit: string;
  unit_price: number;
  discount_percent: number;
  stock_now: number;
}

export interface PartnerHistoryDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partnerId: string;
  partnerName: string;
  currentProductIds: Set<number>;
  onAddItem: (item: PartnerHistoryItem) => void;
  onRepeatOrder: (items: PartnerHistoryItem[]) => void;
}

export function PartnerHistoryDrawer({
  open,
  onOpenChange,
  partnerName,
}: PartnerHistoryDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>История на партньора</SheetTitle>
          <SheetDescription>{partnerName}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-6 py-4 text-sm text-gray-500">
          Зареждане…
        </div>
      </SheetContent>
    </Sheet>
  );
}
