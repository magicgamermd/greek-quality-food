import { useQueries } from "@tanstack/react-query";
import { AlertTriangle, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Can } from "@/components/Can";
import { PERMISSIONS } from "@/lib/permissions";
import { formatUnitPrice } from "@/lib/utils";
import {
  computeMarginPercent,
  formatPlainPrice,
  formatSignedPercent,
  type PriceChangeAlert,
} from "@/lib/priceChange";
import { fetchProductById, productDetailQueryKey } from "@/lib/productQueries";

function marginClass(margin: number | null): string {
  // Праговете са като в колоната „Марж“ на „Продукти“.
  if (margin === null) return "text-gray-400";
  if (margin > 20) return "text-green-600";
  if (margin >= 10) return "text-yellow-600";
  return "text-red-600";
}

/**
 * Съобщение след запис на доставка с нова доставна цена. Не спира нищо —
 * доставката вече е записана; само изброява продуктите, за да се провери
 * продажната цена (✎ отваря картата на продукта).
 */
export function PriceChangeAlertDialog({
  alerts,
  onClose,
  onEditProduct,
}: {
  alerts: PriceChangeAlert[];
  onClose: () => void;
  onEditProduct: (productId: number) => void;
}) {
  // Текущата продажна цена се чете от продукта — след ✎ и запис се
  // презарежда сама (ключът е под ["products"]).
  const productQueries = useQueries({
    queries: alerts.map((alert) => ({
      queryKey: productDetailQueryKey(alert.productId),
      queryFn: () => fetchProductById(alert.productId),
      staleTime: 0,
    })),
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" aria-hidden />
            Нова доставна цена
          </DialogTitle>
          <DialogDescription>
            Доставката е записана. Продажните цени не се променят автоматично —
            провери ги и ги смени на ръка от ✎, ако трябва.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-gray-500">
                <th className="py-2 pr-3 font-medium">Продукт</th>
                <th className="py-2 pr-3 font-medium">Доставна цена</th>
                <th className="py-2 pr-3 font-medium text-right">
                  Цена на едро
                </th>
                <th className="py-2 pr-3 font-medium text-right">
                  Марж с новата
                </th>
                <th className="py-2 w-10">
                  <span className="sr-only">Карта на продукта</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((alert, index) => {
                const query = productQueries[index];
                const product = query?.data;
                const sellingRaw = product?.selling_price;
                const selling =
                  sellingRaw != null && Number(sellingRaw) > 0
                    ? Number(sellingRaw)
                    : null;
                const margin = computeMarginPercent(selling, alert.newPrice);
                const up = alert.direction === "up";
                const belowCost = selling != null && selling < alert.newPrice;
                return (
                  <tr key={alert.productId} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      <div className="font-medium text-gray-900">
                        {product?.name_bg || alert.productName}
                      </div>
                      {product?.sku && (
                        <div className="text-xs text-gray-500">
                          SKU {product.sku}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap tabular-nums">
                      <span className="text-gray-500">
                        {formatPlainPrice(alert.oldPrice)}
                      </span>
                      {" → "}
                      <span className="font-medium text-gray-900">
                        {formatUnitPrice(alert.newPrice)}
                      </span>{" "}
                      <span
                        className={
                          up
                            ? "text-amber-700 font-medium"
                            : "text-emerald-700 font-medium"
                        }
                      >
                        {up ? "▲" : "▼"} {formatSignedPercent(alert.percent)}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">
                      {query?.isLoading ? (
                        <span
                          className="inline-block h-4 w-14 rounded bg-gray-100 animate-pulse align-middle"
                          aria-label="Зареждане"
                        />
                      ) : selling != null ? (
                        formatUnitPrice(selling)
                      ) : (
                        <span className="text-gray-400">няма</span>
                      )}
                    </td>
                    <td
                      className={`py-2 pr-3 text-right whitespace-nowrap tabular-nums ${marginClass(margin)}`}
                    >
                      {query?.isLoading ? (
                        <span
                          className="inline-block h-4 w-10 rounded bg-gray-100 animate-pulse align-middle"
                          aria-label="Зареждане"
                        />
                      ) : margin != null ? (
                        <>
                          {margin.toFixed(1).replace(".", ",")} %
                          {belowCost && (
                            <div className="text-[11px] font-medium">
                              под доставната
                            </div>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <Can permission={PERMISSIONS.PRODUCTS_MANAGE}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          title="Карта на продукта — смени продажната цена"
                          aria-label={`Карта на продукта ${
                            product?.name_bg || alert.productName
                          }`}
                          onClick={() => onEditProduct(alert.productId)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </Can>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <DialogFooter className="gap-2 shrink-0">
          <Button onClick={onClose}>Разбрах</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
