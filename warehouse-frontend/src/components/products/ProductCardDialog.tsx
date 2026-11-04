import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Category, Product } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorMessage } from "@/components/ui/spinner";
import { getApiErrorMessage } from "@/lib/utils";
import { ProductModal } from "@/components/products/ProductModal";
import { fetchProductById, productDetailQueryKey } from "@/lib/productQueries";

// Същите query-та като на страница „Продукти“ — споделен кеш.
function useCategories() {
  return useQuery<Category[]>({
    queryKey: ["categories"],
    queryFn: () =>
      api.get("/categories").then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      }),
  });
}

function useBrands() {
  return useQuery<string[]>({
    queryKey: ["brands"],
    queryFn: () =>
      api.get("/products/brands").then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : [];
      }),
  });
}

function CardSkeleton() {
  return (
    <div className="grid gap-4 py-2" aria-hidden>
      <div className="grid grid-cols-2 gap-4">
        <div className="h-10 rounded-md bg-gray-100 animate-pulse" />
        <div className="h-10 rounded-md bg-gray-100 animate-pulse" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="h-10 rounded-md bg-gray-100 animate-pulse" />
        <div className="h-10 rounded-md bg-gray-100 animate-pulse" />
      </div>
      <div className="h-10 rounded-md bg-gray-100 animate-pulse" />
      <div className="grid grid-cols-3 gap-3">
        <div className="h-8 rounded-md bg-gray-100 animate-pulse" />
        <div className="h-8 rounded-md bg-gray-100 animate-pulse" />
        <div className="h-8 rounded-md bg-gray-100 animate-pulse" />
      </div>
      <div className="h-20 rounded-md bg-gray-100 animate-pulse" />
    </div>
  );
}

/**
 * Картата на продукта по id — отваря се над друг прозорец (напр. доставка),
 * без да го затваря. Рендерира се само докато е отворена: всяко отваряне е
 * ново монтиране и продуктът се чете наново (виж `isFetchedAfterMount`).
 */
export function ProductCardDialog({
  productId,
  onClose,
  onSaved,
}: {
  productId: number;
  onClose: () => void;
  onSaved?: (saved: Product) => void;
}) {
  const productQuery = useQuery<Product>({
    queryKey: productDetailQueryKey(productId),
    queryFn: () => fetchProductById(productId),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const categoriesQuery = useCategories();
  const brandsQuery = useBrands();

  // Формата се пълни веднъж при показване — затова чакаме свежите данни,
  // а не стария кеш (иначе би показала доставната цена отпреди записа).
  const ready =
    productQuery.isFetchedAfterMount &&
    !!productQuery.data &&
    !categoriesQuery.isLoading &&
    !brandsQuery.isLoading;

  if (ready && productQuery.data) {
    return (
      <ProductModal
        open
        onClose={onClose}
        product={productQuery.data}
        categories={categoriesQuery.data ?? []}
        brands={brandsQuery.data ?? []}
        onSaved={onSaved}
      />
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Редактиране на продукт</DialogTitle>
          <DialogDescription>
            {productQuery.isError
              ? "Картата на продукта не се зареди."
              : "Зареждане на картата на продукта…"}
          </DialogDescription>
        </DialogHeader>
        {productQuery.isError ? (
          <ErrorMessage
            message={getApiErrorMessage(
              productQuery.error,
              "Продуктът не може да бъде зареден.",
            )}
          />
        ) : (
          <CardSkeleton />
        )}
        <DialogFooter className="gap-2 shrink-0">
          <Button variant="outline" onClick={onClose}>
            Затвори
          </Button>
          {productQuery.isError && (
            <Button onClick={() => void productQuery.refetch()}>
              Опитай пак
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
