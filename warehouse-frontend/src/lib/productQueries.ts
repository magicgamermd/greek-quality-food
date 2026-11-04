import { api } from "@/lib/api";
import type { Product } from "@/types";

/** Ключът на един продукт — под ["products"], за да се презарежда с тях. */
export function productDetailQueryKey(productId: number) {
  return ["products", "detail", productId] as const;
}

/** GET /products/:id */
export function fetchProductById(productId: number): Promise<Product> {
  return api.get(`/products/${productId}`).then((r) => r.data as Product);
}
