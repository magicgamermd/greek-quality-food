import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Search,
  Pencil,
  Trash2,
  Package,
  ChevronLeft,
  ChevronRight,
  FolderInput,
  FolderTree,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { SHOW_ALL_LIMIT } from "@/lib/pagination";
import { toast } from "@/lib/toast";
import { confirm } from "@/components/ConfirmDialog";
import type { Product, Category } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingOverlay, ErrorMessage, Spinner } from "@/components/ui/spinner";
import {
  formatUnitPrice,
  formatUnit,
  getApiErrorMessage,
  stockColorClass,
} from "@/lib/utils";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { HighlightMatch } from "@/lib/highlight";
import { Can } from "@/components/Can";
import { PERMISSIONS } from "@/lib/permissions";
import { usePermissions } from "@/contexts/PermissionContext";
import { ProductModal } from "@/components/products/ProductModal";
import { GroupSidebar } from "@/components/groups/GroupSidebar";
import { MoveToGroupDialog } from "@/components/groups/MoveToGroupDialog";
import {
  countLabel,
  GROUP_FILTER_ALL,
  GROUP_FILTER_NONE,
  groupFilterParam,
  useGroupActions,
  useGroups,
  type GroupFilter,
} from "@/lib/groups";

function CategoryManagerModal({
  open,
  onClose,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  categories: Category[];
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name_bg: "", name_en: "" });

  const createMutation = useMutation({
    mutationFn: async () => api.post("/categories", form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["categories"] });
      setForm({ name_bg: "", name_en: "" });
      toast.success("Категорията е създадена");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при запис на категорията",
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => api.delete(`/categories/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["categories"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      toast.success("Категорията е изтрита");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при изтриване на категорията",
      );
    },
  });

  const createError = createMutation.error
    ? getApiErrorMessage(
        createMutation.error,
        "Грешка при запис на категорията.",
      )
    : "";
  const deleteError = deleteMutation.error
    ? getApiErrorMessage(
        deleteMutation.error,
        "Грешка при изтриване на категорията.",
      )
    : "";

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Категории</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-lg border p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Име (БГ)</Label>
                <Input
                  value={form.name_bg}
                  onChange={(e) =>
                    setForm((current) => ({
                      ...current,
                      name_bg: e.target.value,
                    }))
                  }
                  placeholder="напр. Сирена"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Име (EN)</Label>
                <Input
                  value={form.name_en}
                  onChange={(e) =>
                    setForm((current) => ({
                      ...current,
                      name_en: e.target.value,
                    }))
                  }
                  placeholder="optional"
                />
              </div>
            </div>
            {createError ? <ErrorMessage message={createError} /> : null}
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || !form.name_bg.trim()}
              >
                {createMutation.isPending ? <Spinner size="sm" /> : null}
                Добави категория
              </Button>
            </div>
          </div>

          {deleteError ? <ErrorMessage message={deleteError} /> : null}

          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Категория</TableHead>
                  <TableHead>EN</TableHead>
                  <TableHead className="text-right">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categories.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="py-6 text-center text-gray-500"
                    >
                      Няма категории.
                    </TableCell>
                  </TableRow>
                ) : (
                  categories.map((category) => (
                    <TableRow key={category.id}>
                      <TableCell className="font-medium">
                        {category.name_bg}
                      </TableCell>
                      <TableCell>{category.name_en || "—"}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-red-600 hover:text-red-700"
                          onClick={() => deleteMutation.mutate(category.id)}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type PriceFilter =
  "with_price" | "all" | "no_price" | "zero_stock" | "negative_stock";
type StockTab = "active" | "catalog";

const GROUPS_PANEL_KEY = "gqf.products.groupsPanel";

export function Products() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 300);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [priceFilter, setPriceFilter] = useState<PriceFilter>("with_price");
  const [stockTab, setStockTab] = useState<StockTab>("active");
  const [modalOpen, setModalOpen] = useState(false);
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [page, setPage] = useState(1);
  // Групи (Microinvest): филтър вляво + избрани редове за масово местене.
  const [groupFilter, setGroupFilter] = useState<GroupFilter>(GROUP_FILTER_ALL);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [moveOpen, setMoveOpen] = useState(false);
  // Списъкът с групите вляво: сам отворен на широк екран; на 1366 px
  // таблицата иначе не се събира. Изборът се помни в браузъра.
  const [showGroups, setShowGroups] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(GROUPS_PANEL_KEY);
      if (saved === "1" || saved === "0") return saved === "1";
    } catch {
      // няма достъп до localStorage — по ширината
    }
    return typeof window !== "undefined" && window.innerWidth >= 1600;
  });
  const toggleGroups = () =>
    setShowGroups((prev) => {
      try {
        localStorage.setItem(GROUPS_PANEL_KEY, prev ? "0" : "1");
      } catch {
        // само за удобство
      }
      return !prev;
    });
  const { hasPermission } = usePermissions();
  const canManageProducts = hasPermission(PERMISSIONS.PRODUCTS_MANAGE);
  const { data: groupsData } = useGroups("product");
  const { move: moveToGroup } = useGroupActions("product");
  const selectGroup = (filter: GroupFilter) => {
    setGroupFilter(filter);
    setSelectedIds(new Set());
    setPage(1);
  };
  // Без страници — целият каталог се показва на екрана.
  const pageSize = SHOW_ALL_LIMIT;

  const {
    data: productsData,
    isLoading,
    error,
  } = useQuery<{
    data: Product[];
    pagination: { page: number; limit: number; total: number };
    active_count?: number;
    catalog_count?: number;
  }>({
    queryKey: [
      "products",
      debouncedSearch,
      categoryFilter,
      groupFilter,
      brandFilter,
      priceFilter,
      stockTab,
      page,
    ],
    queryFn: () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (categoryFilter) params.set("category", categoryFilter);
      const groupParam = groupFilterParam(groupFilter);
      if (groupParam) params.set("group", groupParam);
      if (brandFilter) params.set("brand", brandFilter);
      if (priceFilter === "no_price") params.set("no_selling_price", "true");
      if (priceFilter === "with_price") params.set("has_price", "true");
      if (priceFilter === "zero_stock") params.set("zero_stock", "true");
      if (priceFilter === "negative_stock")
        params.set("negative_stock", "true");
      // Stock tab: active_only=true for "Налични", catalog=true for "Каталог".
      // The new stock-based filters (zero/negative) need the catalog scope so
      // the HAVING clause they push can match products that are currently
      // outside the active_only=true cut.
      const stockFilterActive =
        priceFilter === "zero_stock" || priceFilter === "negative_stock";
      if (stockTab === "active" && !stockFilterActive) {
        params.set("active_only", "true");
      } else {
        params.set("catalog", "true");
        params.set("active_only", "false");
      }
      params.set("page", String(page));
      params.set("limit", String(pageSize));
      return api.get(`/products?${params}`).then((r) => {
        const d = r.data;
        if (d?.data && d?.pagination) return d;
        const items = Array.isArray(d)
          ? d
          : Array.isArray(d?.data)
            ? d.data
            : [];
        return {
          data: items,
          pagination: { page: 1, limit: pageSize, total: items.length },
        };
      });
    },
    refetchInterval: 30000,
  });

  const products = productsData?.data ?? [];
  const pagination = productsData?.pagination ?? {
    page: 1,
    limit: pageSize,
    total: 0,
  };
  const activeCount = productsData?.active_count ?? 0;
  const catalogCount = productsData?.catalog_count ?? 0;
  const uncategorizedCount = products.filter(
    (product) => !product.category_id,
  ).length;
  const visibleIds = products.map((product) => product.id);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const toggleSelected = (id: number) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAllVisible = () =>
    setSelectedIds((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        visibleIds.forEach((id) => next.delete(id));
        return next;
      }
      return new Set([...prev, ...visibleIds]);
    });
  const selectedGroupName =
    groupFilter === GROUP_FILTER_NONE
      ? "Без група"
      : (groupsData?.data.find((group) => String(group.id) === groupFilter)
          ?.name ?? "");

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ["categories"],
    queryFn: () =>
      api.get("/categories").then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      }),
  });

  const { data: brands = [] } = useQuery<string[]>({
    queryKey: ["brands"],
    queryFn: () =>
      api.get("/products/brands").then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : [];
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/products/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      toast.success("Продуктът е изтрит");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при изтриване на продукта",
      );
    },
  });

  const openAdd = () => {
    setEditProduct(null);
    setModalOpen(true);
  };
  const openEdit = (p: Product) => {
    setEditProduct(p);
    setModalOpen(true);
  };

  const priceFilterTabs: { value: PriceFilter; label: string }[] = [
    { value: "all", label: "Всички" },
    { value: "with_price", label: "С цени" },
    { value: "no_price", label: "Без цени" },
    { value: "zero_stock", label: "🟡 Нулеви" },
    { value: "negative_stock", label: "🔴 На минус" },
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Продукти</h1>
          <p className="text-gray-500 text-sm mt-1">
            Управление на продуктовия каталог
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={showGroups ? "default" : "outline"}
            className={showGroups ? "" : "hidden lg:inline-flex"}
            onClick={toggleGroups}
            aria-pressed={showGroups}
            title={showGroups ? "Скрий групите вляво" : "Покажи групите вляво"}
          >
            <FolderTree className="h-4 w-4" />
            Групи
          </Button>
          <Button variant="outline" onClick={() => setCategoryModalOpen(true)}>
            Категории
          </Button>
          <Button onClick={openAdd}>
            <Plus className="h-4 w-4" />
            Нов продукт
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs uppercase tracking-wide text-gray-500">
              Каталог
            </p>
            <p className="mt-1 text-2xl font-semibold text-gray-900">
              {catalogCount}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs uppercase tracking-wide text-gray-500">
              Налични
            </p>
            <p className="mt-1 text-2xl font-semibold text-gray-900">
              {activeCount}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-500">
                Без категория
              </p>
              <p className="mt-1 text-2xl font-semibold text-amber-700">
                {uncategorizedCount}
              </p>
            </div>
            {uncategorizedCount > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCategoryModalOpen(true)}
              >
                Управлявай
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="flex items-start gap-4">
        <GroupSidebar
          kind="product"
          selected={groupFilter}
          onSelect={selectGroup}
          canManage={canManageProducts}
          className={`sticky top-4 hidden w-56 shrink-0 rounded-lg border border-gray-200 bg-white p-3 max-h-[calc(100vh-2rem)] overflow-y-auto ${showGroups ? "lg:block" : ""}`}
        />
        <div className="min-w-0 flex-1 space-y-6">
          {/* Stock tabs: Налични / Каталог */}
          <div className="flex gap-4 border-b border-gray-200">
            <button
              onClick={() => {
                setStockTab("active");
                setPage(1);
              }}
              className={`px-4 py-2 font-medium border-b-2 transition-colors ${
                stockTab === "active"
                  ? "border-[#6c3dff] text-[#6c3dff]"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              Налични
              <span
                className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
                  stockTab === "active"
                    ? "bg-[#6c3dff]/10 text-[#6c3dff]"
                    : "bg-gray-100 text-gray-500"
                }`}
              >
                {activeCount}
              </span>
            </button>
            <button
              onClick={() => {
                setStockTab("catalog");
                setPage(1);
              }}
              className={`px-4 py-2 font-medium border-b-2 transition-colors ${
                stockTab === "catalog"
                  ? "border-[#6c3dff] text-[#6c3dff]"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              Каталог
              <span
                className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
                  stockTab === "catalog"
                    ? "bg-[#6c3dff]/10 text-[#6c3dff]"
                    : "bg-gray-100 text-gray-500"
                }`}
              >
                {catalogCount}
              </span>
            </button>
          </div>

          {/* Filters */}
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex flex-wrap gap-3">
                <div className="relative flex-1 min-w-48">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    placeholder="Търси по име, SKU или марка..."
                    className="pl-9"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>
                <Select
                  value={groupFilter}
                  onChange={(e) => selectGroup(e.target.value)}
                  className={`w-48 ${showGroups ? "lg:hidden" : ""}`}
                  aria-label="Група"
                >
                  <option value={GROUP_FILTER_ALL}>Всички групи</option>
                  <option value={GROUP_FILTER_NONE}>Без група</option>
                  {(groupsData?.data ?? []).map((group) => (
                    <option key={group.id} value={String(group.id)}>
                      {group.name}
                    </option>
                  ))}
                </Select>
                <Select
                  value={categoryFilter}
                  onChange={(e) => {
                    setCategoryFilter(e.target.value);
                    setPage(1);
                  }}
                  className="w-48"
                >
                  <option value="">Всички категории</option>
                  {categories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name_bg}
                    </option>
                  ))}
                </Select>
                <Select
                  value={brandFilter}
                  onChange={(e) => {
                    setBrandFilter(e.target.value);
                    setPage(1);
                  }}
                  className="w-48"
                >
                  <option value="">Всички марки</option>
                  {brands.map((brand) => (
                    <option key={brand} value={brand}>
                      {brand}
                    </option>
                  ))}
                </Select>
                {(search ||
                  categoryFilter ||
                  groupFilter ||
                  brandFilter ||
                  priceFilter !== "with_price") && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSearch("");
                      setCategoryFilter("");
                      setGroupFilter(GROUP_FILTER_ALL);
                      setSelectedIds(new Set());
                      setBrandFilter("");
                      setPriceFilter("with_price");
                      setPage(1);
                    }}
                  >
                    Изчисти филтрите
                  </Button>
                )}
              </div>
              {/* Price filter tabs */}
              <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
                {priceFilterTabs.map((tab) => (
                  <button
                    key={tab.value}
                    onClick={() => {
                      setPriceFilter(tab.value);
                      setPage(1);
                    }}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      priceFilter === tab.value
                        ? "bg-white text-gray-900 shadow-sm"
                        : "text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Table */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Package className="h-5 w-5 text-[#6c3dff]" />
                {pagination.total} продукта
                {selectedGroupName && (
                  <span className="font-normal text-gray-500">
                    в „{selectedGroupName}“
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            {canManageProducts && selectedIds.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-y border-[#6c3dff]/20 bg-[#6c3dff]/5 px-4 py-2 text-sm">
                <span className="font-medium text-gray-800">
                  Избрани: {countLabel("product", selectedIds.size)}
                </span>
                <Button size="sm" onClick={() => setMoveOpen(true)}>
                  <FolderInput className="h-4 w-4" />
                  Премести в група…
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelectedIds(new Set())}
                >
                  <X className="h-4 w-4" />
                  Откажи избора
                </Button>
              </div>
            )}
            <CardContent className="p-0">
              {isLoading ? (
                <LoadingOverlay />
              ) : error ? (
                <div className="p-4">
                  <ErrorMessage message="Грешка при зареждане" />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      {canManageProducts && (
                        <TableHead className="w-10 px-2">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-[#6c3dff]"
                            checked={allVisibleSelected}
                            onChange={toggleAllVisible}
                            aria-label="Избери всички показани"
                          />
                        </TableHead>
                      )}
                      <TableHead>Наименование</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>Мярка</TableHead>
                      <TableHead>Категория</TableHead>
                      <Can
                        permission={PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE}
                      >
                        <TableHead>Доставна цена</TableHead>
                      </Can>
                      <TableHead>Цена на едро</TableHead>
                      <Can
                        permission={PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE}
                      >
                        <TableHead>Марж</TableHead>
                      </Can>
                      <TableHead>Наличност</TableHead>
                      <TableHead className="sticky right-0 bg-white text-right shadow-[-6px_0_6px_-6px_rgba(0,0,0,0.15)]">
                        Действия
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {products.map((p) => {
                      const purchaseNum = Number(p.purchase_price) || 0;
                      const sellingNum = Number(p.selling_price) || 0;
                      const margin =
                        purchaseNum > 0 && sellingNum > 0
                          ? ((sellingNum - purchaseNum) / purchaseNum) * 100
                          : null;
                      const marginColor =
                        margin === null
                          ? "text-gray-400"
                          : margin > 20
                            ? "text-green-600"
                            : margin >= 10
                              ? "text-yellow-600"
                              : "text-red-600";

                      const hasStock =
                        parseFloat(String(p.total_stock ?? 0)) > 0;
                      const rowOpacity =
                        stockTab === "catalog" && !hasStock ? "opacity-50" : "";

                      return (
                        <TableRow
                          key={p.id}
                          className={`group ${rowOpacity} ${selectedIds.has(p.id) ? "bg-[#f6f3ff]" : ""}`}
                        >
                          {canManageProducts && (
                            <TableCell className="w-10 px-2">
                              <input
                                type="checkbox"
                                className="h-4 w-4 accent-[#6c3dff]"
                                checked={selectedIds.has(p.id)}
                                onChange={() => toggleSelected(p.id)}
                                aria-label={`Избери ${p.name_bg}`}
                              />
                            </TableCell>
                          )}
                          <TableCell>
                            <div>
                              <p className="font-medium text-gray-900">
                                <HighlightMatch
                                  text={p.name_bg}
                                  query={debouncedSearch}
                                />
                              </p>
                              {p.name_en && (
                                <p className="text-xs text-gray-400">
                                  <HighlightMatch
                                    text={p.name_en}
                                    query={debouncedSearch}
                                  />
                                </p>
                              )}
                              {p.product_group_name &&
                                groupFilter !== String(p.product_group_id) && (
                                  <button
                                    type="button"
                                    className="mt-0.5 inline-block max-w-full rounded bg-gray-100 px-1.5 py-0.5 text-left text-[11px] leading-tight text-gray-600 [overflow-wrap:anywhere] hover:bg-[#6c3dff]/10 hover:text-[#6c3dff]"
                                    title={`Група „${p.product_group_name}“ — покажи само нея`}
                                    onClick={() =>
                                      selectGroup(
                                        String(p.product_group_id ?? ""),
                                      )
                                    }
                                  >
                                    {p.product_group_name}
                                  </button>
                                )}
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            <HighlightMatch
                              text={p.sku}
                              query={debouncedSearch}
                            />
                          </TableCell>
                          <TableCell>{formatUnit(p.unit)}</TableCell>
                          <TableCell>
                            {p.category_name_bg ? (
                              <Badge variant="secondary">
                                {p.category_name_bg}
                              </Badge>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                          <Can
                            permission={
                              PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE
                            }
                          >
                            <TableCell>
                              {p.purchase_price
                                ? formatUnitPrice(p.purchase_price)
                                : "—"}
                            </TableCell>
                          </Can>
                          <TableCell>
                            {p.selling_price
                              ? formatUnitPrice(p.selling_price)
                              : "—"}
                          </TableCell>
                          <Can
                            permission={
                              PERMISSIONS.INVENTORY_VIEW_PURCHASE_PRICE
                            }
                          >
                            <TableCell className={marginColor}>
                              {margin !== null ? `${margin.toFixed(1)}%` : "—"}
                            </TableCell>
                          </Can>
                          <TableCell>
                            {p.total_stock !== null &&
                            p.total_stock !== undefined ? (
                              <span
                                className={stockColorClass(
                                  parseFloat(String(p.total_stock || 0)),
                                  p.low_stock_threshold,
                                )}
                              >
                                {parseFloat(String(p.total_stock))}{" "}
                                {formatUnit(String(p.unit))}
                              </span>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </TableCell>
                          <TableCell
                            className={`sticky right-0 text-right shadow-[-6px_0_6px_-6px_rgba(0,0,0,0.15)] ${
                              selectedIds.has(p.id)
                                ? "bg-[#f6f3ff]"
                                : "bg-white group-hover:bg-gray-50"
                            }`}
                          >
                            <div className="flex items-center justify-end gap-2">
                              <Can permission={PERMISSIONS.PRODUCTS_MANAGE}>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  aria-label="Редактирай продукт"
                                  onClick={() => openEdit(p)}
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                              </Can>
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label="Изтрий продукт"
                                className="text-red-500 hover:text-red-600"
                                onClick={async () => {
                                  const ok = await confirm({
                                    title: "Изтриване на продукт",
                                    description: `Сигурни ли сте, че искате да изтриете "${p.name_bg}"? Действието не може да бъде отменено.`,
                                    confirmText: "Изтрий",
                                    variant: "danger",
                                  });
                                  if (ok) deleteMutation.mutate(p.id);
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
            {/* Без страници: каталогът е цял на екрана, футърът отчита броя. */}
            {pagination.total > 0 && (
              <div className="flex items-center justify-between px-4 py-3 border-t">
                <p className="text-sm text-gray-500">
                  Показани всички {pagination.total}
                </p>
              </div>
            )}
          </Card>
        </div>
      </div>

      <ProductModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        product={editProduct}
        categories={categories}
        brands={brands}
        defaultGroupId={/^\d+$/.test(groupFilter) ? groupFilter : ""}
      />
      <MoveToGroupDialog
        kind="product"
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        title="Премести в група"
        description={`${countLabel("product", selectedIds.size)} отиват в избраната група.`}
        confirmText="Премести"
        onConfirm={async (groupId) => {
          const moved = await moveToGroup.mutateAsync({
            ids: [...selectedIds],
            groupId,
          });
          toast.success(`Преместени: ${countLabel("product", moved)}`);
          setSelectedIds(new Set());
        }}
      />
      <CategoryManagerModal
        open={categoryModalOpen}
        onClose={() => setCategoryModalOpen(false)}
        categories={categories}
      />
    </div>
  );
}
