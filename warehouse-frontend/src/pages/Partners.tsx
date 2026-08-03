import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Pencil,
  Users,
  Phone,
  Mail,
  Search,
  Loader2,
  CheckCircle2,
} from "lucide-react";
import { api } from "@/lib/api";
import { SHOW_ALL_LIMIT } from "@/lib/pagination";
import { toast } from "@/lib/toast";
import type { Partner, PriceListItem, Product } from "@/types";
import { formatCurrency } from "@/lib/utils";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useUrlState } from "@/hooks/useUrlState";
import { HighlightMatch } from "@/lib/highlight";
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
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { LoadingOverlay, ErrorMessage, Spinner } from "@/components/ui/spinner";

function PartnerModal({
  open,
  onClose,
  partner,
}: {
  open: boolean;
  onClose: () => void;
  partner?: Partner | null;
}) {
  const qc = useQueryClient();

  const buildForm = (p?: Partner | null) => {
    // Normalise legacy values (e.g. "customer") to "legal_entity" so the
    // UI can present a clean binary choice.
    const rawType = (p as any)?.partner_type;
    const partnerType: "legal_entity" | "individual" =
      rawType === "individual" ? "individual" : "legal_entity";
    return {
      partner_type: partnerType,
      name: p?.name ?? "",
      microinvest_code: p?.microinvest_code ?? "",
      eik: p?.eik ?? "",
      vat_number: p?.vat_number ?? "",
      address: p?.address ?? "",
      contact_person: p?.contact_person ?? "",
      phone: p?.phone ?? "",
      email: p?.email ?? "",
      city: (p as any)?.city ?? "",
      print_name: (p as any)?.print_name ?? "",
      client_type: (p as any)?.client_type ?? "",
      price_group: (p as any)?.price_group ?? "",
      discount_percent: String((p as any)?.discount_percent ?? "0"),
      bank_name: (p as any)?.bank_name ?? "",
      bic: (p as any)?.bic ?? "",
      iban: (p as any)?.iban ?? "",
      category: p?.category ?? "",
    };
  };

  const [form, setForm] = useState(buildForm(partner));

  // Re-populate form when partner changes (edit mode)
  useEffect(() => {
    setForm(buildForm(partner));
  }, [partner]);

  const isIndividual = form.partner_type === "individual";
  const eikValid =
    isIndividual ||
    !form.eik ||
    /^\d{9}$/.test(form.eik) ||
    /^\d{13}$/.test(form.eik);
  const [eikWarning, setEikWarning] = useState("");
  const [eikLoading, setEikLoading] = useState(false);
  const [eikAutoFilled, setEikAutoFilled] = useState(false);

  const handleEikLookup = async (eik: string) => {
    if (!/^\d{9,13}$/.test(eik.trim())) return;
    try {
      setEikLoading(true);
      setEikAutoFilled(false);
      const res = await api.get(`/partners/lookup/${eik.trim()}`);
      const data = res.data;
      setForm((prev) => ({
        ...prev,
        name: data.name || prev.name,
        address: data.address || prev.address,
        city: data.city || prev.city,
        vat_number: data.vat_number || prev.vat_number,
        contact_person: data.manager || prev.contact_person,
      }));
      setEikAutoFilled(true);
      setTimeout(() => setEikAutoFilled(false), 4000);
    } catch {
      // Silently fail — user can fill manually
    } finally {
      setEikLoading(false);
    }
  };

  const mutation = useMutation({
    mutationFn: () => {
      // Scrub EIK / VAT / bank fields when switching to individual, so the
      // server's superRefine doesn't reject the payload because of lingering
      // values from a previous legal_entity state.
      const payload =
        form.partner_type === "individual"
          ? {
              ...form,
              eik: "",
              vat_number: "",
              bank_name: "",
              bic: "",
              iban: "",
            }
          : form;
      return partner
        ? api.put(`/partners/${partner.id}`, payload)
        : api.post("/partners", payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["partners"] });
      onClose();
      toast.success(partner ? "Партньорът е обновен" : "Партньорът е създаден");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при запис на партньора",
      );
    },
  });

  const set = (f: string, v: string) => {
    setForm((prev) => ({ ...prev, [f]: v }));
    if (f === "eik") {
      if (v && !/^\d{9}$/.test(v) && !/^\d{13}$/.test(v)) {
        setEikWarning("ЕИК трябва да е 9 или 13 цифри");
      } else {
        setEikWarning("");
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {partner ? "Редактиране на партньор" : "Нов партньор"}
          </DialogTitle>
          <DialogDescription>Данни за фирмата на партньора</DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto min-h-0 grid gap-4 py-2 pr-1">
          {/* Тип партньор (сегмент) */}
          <div className="space-y-1.5">
            <Label>Тип клиент</Label>
            <div className="inline-flex rounded-lg border bg-gray-50 p-1">
              <button
                type="button"
                onClick={() => set("partner_type", "legal_entity")}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition ${
                  form.partner_type === "legal_entity"
                    ? "bg-white shadow text-gray-900"
                    : "text-gray-500 hover:text-gray-900"
                }`}
              >
                🏢 Юридическо лице
              </button>
              <button
                type="button"
                onClick={() => set("partner_type", "individual")}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition ${
                  form.partner_type === "individual"
                    ? "bg-white shadow text-gray-900"
                    : "text-gray-500 hover:text-gray-900"
                }`}
              >
                👤 Физическо лице
              </button>
            </div>
            {form.partner_type === "individual" && (
              <p className="text-xs text-gray-500">
                Физическите лица не изискват ЕИК и банкова информация.
              </p>
            )}
          </div>

          {/* Основни данни */}
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            Основни данни
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Наименование</Label>
              <Input
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Код</Label>
              <Input
                value={form.microinvest_code}
                onChange={(e) => set("microinvest_code", e.target.value)}
                placeholder="Microinvest код"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Име за печат</Label>
              <Input
                value={form.print_name}
                onChange={(e) => set("print_name", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Град</Label>
              <Input
                value={form.city}
                onChange={(e) => set("city", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Категория</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={form.category}
                onChange={(e) => set("category", e.target.value)}
              >
                <option value="">— Без категория —</option>
                <option value="Магазин">🏪 Магазин</option>
                <option value="Ресторант">🍽️ Ресторант</option>
              </select>
            </div>
          </div>
          {!isIndividual && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>ЕИК</Label>
                <div className="relative">
                  <Input
                    value={form.eik}
                    onChange={(e) => set("eik", e.target.value)}
                    onBlur={(e) => handleEikLookup(e.target.value)}
                    className={eikWarning ? "border-violet-400" : ""}
                  />
                  {eikLoading && (
                    <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-gray-400" />
                  )}
                </div>
                {eikWarning && (
                  <p className="text-xs text-violet-500">{eikWarning}</p>
                )}
                {eikAutoFilled && (
                  <p className="text-xs text-green-600 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" />
                    Данните са попълнени автоматично
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>ДДС номер</Label>
                <Input
                  value={form.vat_number}
                  onChange={(e) => set("vat_number", e.target.value)}
                />
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Адрес</Label>
            <Input
              value={form.address}
              onChange={(e) => set("address", e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Лице за контакт</Label>
              <Input
                value={form.contact_person}
                onChange={(e) => set("contact_person", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Телефон</Label>
              <Input
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Имейл</Label>
            <Input
              type="email"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
            />
          </div>

          {/* Ценообразуване */}
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mt-2">
            Ценообразуване
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label>Тип</Label>
              <Input
                value={form.client_type}
                onChange={(e) => set("client_type", e.target.value)}
                placeholder="Клиент"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Ценова група</Label>
              <Select
                value={form.price_group}
                onChange={(e) => set("price_group", e.target.value)}
              >
                <option value="">Без ценова група</option>
                <option value="Цена на едро">Цена на едро</option>
                <option value="Цена на дребно">Цена на дребно</option>
                <option value="Ценова група 1">Ценова група 1</option>
                <option value="Ценова група 2">Ценова група 2</option>
                <option value="Ценова група 3">Ценова група 3</option>
                <option value="Ценова група 4">Ценова група 4</option>
                <option value="Ценова група 5">Ценова група 5</option>
                <option value="Ценова група 6">Ценова група 6</option>
                <option value="Ценова група 7">Ценова група 7</option>
                <option value="Ценова група 8">Ценова група 8</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Отстъпка %</Label>
              <Input
                type="number"
                value={form.discount_percent}
                onChange={(e) => set("discount_percent", e.target.value)}
              />
            </div>
          </div>

          {!isIndividual && (
            <>
              {/* Банкови данни */}
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mt-2">
                Банкови данни
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Банка</Label>
                  <Input
                    value={form.bank_name}
                    onChange={(e) => set("bank_name", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>BIC</Label>
                  <Input
                    value={form.bic}
                    onChange={(e) => set("bic", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5 col-span-2">
                  <Label>IBAN</Label>
                  <Input
                    value={form.iban}
                    onChange={(e) => set("iban", e.target.value)}
                  />
                </div>
              </div>
            </>
          )}
        </div>
        {mutation.error && <ErrorMessage message="Грешка при запазване" />}
        <DialogFooter className="gap-2 shrink-0">
          <Button variant="outline" onClick={onClose}>
            Отказ
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !form.name}
          >
            {mutation.isPending ? (
              <>
                <Spinner size="sm" />
                Запазване...
              </>
            ) : (
              "Запази"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PriceListModal({
  open,
  onClose,
  partner,
  products,
}: {
  open: boolean;
  onClose: () => void;
  partner: Partner;
  products: Product[];
}) {
  const qc = useQueryClient();
  const { data: priceList = [] } = useQuery<PriceListItem[]>({
    queryKey: ["price-list", partner.id],
    queryFn: () =>
      api.get(`/partners/${partner.id}/price-list`).then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      }),
    enabled: open,
  });

  const [prices, setPrices] = useState<Record<number, string>>({});

  const mutation = useMutation({
    mutationFn: () =>
      api.put(`/partners/${partner.id}/price-list`, {
        items: Object.entries(prices).map(([product_id, price]) => ({
          product_id: Number(product_id),
          price: Number(price),
        })),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["price-list", partner.id] });
      onClose();
      toast.success("Ценовата листа е запазена");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при запис на ценовата листа",
      );
    },
  });

  const getPrice = (productId: number) => {
    if (prices[productId] !== undefined) return prices[productId];
    const existing = priceList.find((p) => p.product_id === productId);
    return existing?.price?.toString() ?? "";
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>Ценова листа — {partner.name}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto min-h-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Продукт</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Цена (€)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.name_bg}</TableCell>
                  <TableCell className="font-mono text-sm">{p.sku}</TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      step="0.001"
                      className="w-28"
                      value={getPrice(p.id)}
                      onChange={(e) =>
                        setPrices((prev) => ({
                          ...prev,
                          [p.id]: e.target.value,
                        }))
                      }
                      placeholder="—"
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {mutation.error && <ErrorMessage message="Грешка при запазване" />}
        <DialogFooter className="gap-2 shrink-0">
          <Button variant="outline" onClick={onClose}>
            Отказ
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? (
              <>
                <Spinner size="sm" />
                Запазване...
              </>
            ) : (
              "Запази цените"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Inline quick-select for a partner's `price_group` — lets the user change
 * the pricing tier directly from the partners table row without opening
 * the full edit dialog. On change, issues a partial PUT /partners/:id
 * and invalidates the partners query so the badge + any downstream price
 * resolution updates immediately.
 */
const PRICE_GROUP_OPTIONS = [
  { value: "", label: "—" },
  { value: "Цена на едро", label: "Цена на едро" },
  { value: "Цена на дребно", label: "Цена на дребно" },
  { value: "Ценова група 1", label: "Група 1" },
  { value: "Ценова група 2", label: "Група 2" },
  { value: "Ценова група 3", label: "Група 3" },
  { value: "Ценова група 4", label: "Група 4" },
  { value: "Ценова група 5", label: "Група 5" },
  { value: "Ценова група 6", label: "Група 6" },
  { value: "Ценова група 7", label: "Група 7" },
  { value: "Ценова група 8", label: "Група 8" },
];

function PriceGroupSelect({
  partnerId,
  current,
}: {
  partnerId: number;
  current: string | null | undefined;
}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (price_group: string) =>
      api.put(`/partners/${partnerId}`, { price_group }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["partners"] });
      toast.success("Ценовата група е обновена");
    },
    onError: (err: any) => {
      toast.error(
        err?.response?.data?.error ??
          err?.response?.data?.message ??
          "Грешка при смяна на ценова група",
      );
    },
  });

  const value = current ?? "";
  const isEmpty = !value;
  return (
    <select
      value={value}
      onChange={(e) => {
        e.stopPropagation();
        mutation.mutate(e.target.value);
      }}
      onClick={(e) => e.stopPropagation()}
      disabled={mutation.isPending}
      // Styled like the old Badge so the row still reads as a pill when
      // the user isn't interacting with it. Cursor hints that it's
      // actionable; the native caret keeps it keyboard-accessible.
      className={
        "px-2 py-0.5 rounded-full border text-xs font-semibold cursor-pointer " +
        "focus:outline-none focus:ring-2 focus:ring-[#6c3dff] focus:ring-offset-1 " +
        (isEmpty
          ? "border-gray-200 bg-gray-50 text-gray-400"
          : "border-transparent bg-blue-100 text-blue-700")
      }
      title="Смяна на ценова група"
    >
      {PRICE_GROUP_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

// Stable reference — useUrlState memoises against `defaults` so passing
// a new object literal each render would cause the memoised `current`
// state to recompute on every render and the URL→state read race to
// drop intermediate values (e.g. typing in the search input).
const PARTNERS_URL_DEFAULTS = { search: "", category: "", page: "1" };

export function Partners() {
  const [modalOpen, setModalOpen] = useState(false);
  const [editPartner, setEditPartner] = useState<Partner | null>(null);
  const [priceListPartner, setPriceListPartner] = useState<Partner | null>(
    null,
  );
  // URL-persisted filters so reload / share preserves state
  const [urlFilters, setUrlFilters] = useUrlState(PARTNERS_URL_DEFAULTS);
  const search = urlFilters.search;
  const category = urlFilters.category;
  const page = Math.max(1, parseInt(urlFilters.page, 10) || 1);
  const setSearch = (v: string) => setUrlFilters({ search: v, page: "1" });
  const setCategory = (v: string) => setUrlFilters({ category: v, page: "1" });
  const setPage = (v: number | ((p: number) => number)) =>
    setUrlFilters({
      page: String(typeof v === "function" ? v(page) : v),
    });

  const debouncedSearch = useDebouncedValue(search, 300);
  // Без страници — целият списък се показва на екрана.
  const pageSize = SHOW_ALL_LIMIT;

  const {
    data: result,
    isLoading,
    error,
  } = useQuery<{ items: Partner[]; total: number }>({
    queryKey: ["partners", debouncedSearch, page, category],
    queryFn: () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (category) params.set("category", category);
      params.set("page", String(page));
      params.set("limit", String(pageSize));
      return api.get(`/partners?${params}`).then((r) => {
        const d = r.data;
        const arr = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
        const total = d?.pagination?.total ?? arr.length;
        return { items: arr, total };
      });
    },
    refetchInterval: 30000,
  });

  const partners = result?.items ?? [];
  const totalItems = result?.total ?? 0;

  const { data: products = [] } = useQuery<Product[]>({
    queryKey: ["products"],
    queryFn: () =>
      api.get("/products").then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      }),
  });

  const { data: orderCounts = {} } = useQuery<Record<number, number>>({
    queryKey: ["partner-order-counts"],
    queryFn: () => api.get("/partners/order-counts").then((r) => r.data ?? {}),
    enabled: partners.length > 0,
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Партньори</h1>
          <p className="text-gray-500 text-sm mt-1">Клиенти и ценови листи</p>
        </div>
        <Button
          onClick={() => {
            setEditPartner(null);
            setModalOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
          Нов партньор
        </Button>
      </div>

      {/* Category Tabs + Search */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {[
            { value: "", label: "Всички" },
            { value: "Магазин", label: "🏪 Магазини" },
            { value: "Ресторант", label: "🍽️ Ресторанти" },
          ].map((tab) => (
            <button
              key={tab.value}
              // setCategory вече връща page на 1. Допълнителен setPage(1)
              // тук се състезава с него: и двете пишат в URL-а през
              // setSearchParams в един tick, вторият тръгва от СТАРИТЕ
              // параметри и презаписва категорията → URL оставаше само
              // „?page=1" и филтърът никога не стигаше до заявката.
              // (Същият капан е описан и при полето за търсене по-долу.)
              onClick={() => setCategory(tab.value)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                category === tab.value
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Търси по име, ЕИК или код..."
            className="pl-9"
            value={search}
            onChange={(e) => {
              // setSearch already resets page to 1 — calling setPage(1)
              // here in addition would race against setSearch in
              // react-router's setSearchParams (each call's functional
              // updater sees the URL *before* the previous call lands),
              // overwriting the search value with just page=1.
              setSearch(e.target.value);
            }}
          />
        </div>
      </div>

      <Card>
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
                  <TableHead>Код</TableHead>
                  <TableHead>Наименование</TableHead>
                  <TableHead>Категория</TableHead>
                  <TableHead>ЕИК</TableHead>
                  <TableHead>Ценова група</TableHead>
                  <TableHead>Контакт</TableHead>
                  <TableHead>Телефон</TableHead>
                  <TableHead>Имейл</TableHead>
                  <TableHead className="text-center">Поръчки</TableHead>
                  <TableHead className="text-right">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {partners.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={10}
                      className="text-center text-gray-400 py-8"
                    >
                      Няма партньори
                    </TableCell>
                  </TableRow>
                ) : (
                  partners.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-mono text-sm text-gray-500">
                        {p.microinvest_code ? (
                          <HighlightMatch
                            text={p.microinvest_code}
                            query={debouncedSearch}
                          />
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <div>
                          <p className="font-medium text-gray-900">
                            <HighlightMatch
                              text={p.name}
                              query={debouncedSearch}
                            />
                          </p>
                          {p.vat_number && (
                            <p className="text-xs text-gray-400">
                              ДДС: {p.vat_number}
                            </p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {p.category ? (
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                              p.category === "Магазин"
                                ? "bg-blue-50 text-blue-700"
                                : p.category === "Ресторант"
                                  ? "bg-violet-50 text-violet-700"
                                  : "bg-gray-50 text-gray-600"
                            }`}
                          >
                            {p.category === "Магазин"
                              ? "🏪"
                              : p.category === "Ресторант"
                                ? "🍽️"
                                : ""}{" "}
                            {p.category}
                          </span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {p.eik && !/^(.)\1{8,}$/.test(p.eik) ? (
                          <HighlightMatch
                            text={p.eik}
                            query={debouncedSearch}
                          />
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <PriceGroupSelect
                          partnerId={p.id}
                          current={(p as any).price_group}
                        />
                      </TableCell>
                      <TableCell>{p.contact_person ?? "—"}</TableCell>
                      <TableCell>
                        {p.phone ? (
                          <a
                            href={`tel:${p.phone}`}
                            className="flex items-center gap-1 text-sm text-[#6c3dff] hover:underline"
                          >
                            <Phone className="h-3.5 w-3.5" />
                            {p.phone}
                          </a>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        {p.email ? (
                          <a
                            href={`mailto:${p.email}`}
                            className="flex items-center gap-1 text-sm text-[#6c3dff] hover:underline"
                          >
                            <Mail className="h-3.5 w-3.5" />
                            {p.email}
                          </a>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        {orderCounts[p.id] ? (
                          <span className="inline-flex items-center justify-center min-w-[28px] px-2 py-0.5 rounded-full text-xs font-semibold bg-[#6c3dff]/10 text-[#6c3dff]">
                            {orderCounts[p.id]}
                          </span>
                        ) : (
                          <span className="text-gray-300">0</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setPriceListPartner(p)}
                          >
                            Ценова листа
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Редактирай партньор"
                            onClick={() => {
                              setEditPartner(p);
                              setModalOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Без страници: списъкът е цял на екрана, футърът само отчита броя. */}
      {totalItems > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">
            Показани всички {totalItems}
          </p>
        </div>
      )}

      <PartnerModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        partner={editPartner}
      />

      {priceListPartner && (
        <PriceListModal
          open={!!priceListPartner}
          onClose={() => setPriceListPartner(null)}
          partner={priceListPartner}
          products={products}
        />
      )}
    </div>
  );
}
