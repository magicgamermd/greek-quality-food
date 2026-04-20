import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Search,
  Phone,
  Mail,
  MapPin,
  Eye,
  Trash2,
  ExternalLink,
  Pencil,
} from "lucide-react";
import { api } from "@/lib/api";
import type { Supplier, IncomingGoods } from "@/types";
import { formatDate, formatCurrency, getApiErrorMessage } from "@/lib/utils";
import { matchesAnyField } from "@/lib/translit";
import { HighlightMatch } from "@/lib/highlight";
import { useUrlState } from "@/hooks/useUrlState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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

function SupplierForm({
  open,
  onClose,
  supplier,
}: {
  open: boolean;
  onClose: () => void;
  supplier?: Supplier | null;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: supplier?.name ?? "",
    microinvest_code: supplier?.microinvest_code ?? "",
    eik: supplier?.eik ?? "",
    vat_number: supplier?.vat_number ?? "",
    address: supplier?.address ?? "",
    contact_person: supplier?.contact_person ?? "",
    phone: supplier?.phone ?? "",
    email: supplier?.email ?? "",
    print_name: supplier?.print_name ?? "",
    fax: supplier?.fax ?? "",
    bank_name: supplier?.bank_name ?? "",
    bic: supplier?.bic ?? "",
    iban: supplier?.iban ?? "",
    client_type: supplier?.client_type ?? "",
    price_group: supplier?.price_group ?? "",
    discount_percent: supplier?.discount_percent ?? 0,
  });

  // Re-populate form whenever the supplier changes (edit mode)
  useEffect(() => {
    setForm({
      name: supplier?.name ?? "",
      microinvest_code: supplier?.microinvest_code ?? "",
      eik: supplier?.eik ?? "",
      vat_number: supplier?.vat_number ?? "",
      address: supplier?.address ?? "",
      contact_person: supplier?.contact_person ?? "",
      phone: supplier?.phone ?? "",
      email: supplier?.email ?? "",
      print_name: supplier?.print_name ?? "",
      fax: supplier?.fax ?? "",
      bank_name: supplier?.bank_name ?? "",
      bic: supplier?.bic ?? "",
      iban: supplier?.iban ?? "",
      client_type: supplier?.client_type ?? "",
      price_group: supplier?.price_group ?? "",
      discount_percent: supplier?.discount_percent ?? 0,
    });
  }, [supplier]);

  const mutation = useMutation({
    mutationFn: () =>
      supplier
        ? api.put(`/suppliers/${supplier.id}`, form)
        : api.post("/suppliers", form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      onClose();
    },
  });
  const saveError = mutation.error
    ? getApiErrorMessage(mutation.error, "Грешка при запазване на доставчика.")
    : "";

  const set = (f: string, v: string) =>
    setForm((prev) => ({ ...prev, [f]: v }));

  const handleCheckEIK = () => {
    if (form.eik) {
      window.open(
        `https://portal.registryagency.bg/CR/en/UICSearch?uic=${encodeURIComponent(form.eik)}`,
        "_blank",
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh]">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {supplier ? "Редактиране на доставчик" : "Нов доставчик"}
          </DialogTitle>
          <DialogDescription>Данни за фирмата на доставчика</DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto min-h-0 grid gap-4 py-2 pr-1">
          {/* Basic Info */}
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Основни данни
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Наименование *</Label>
              <Input
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Наименование на фирмата"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Код</Label>
              <Input
                value={form.microinvest_code}
                onChange={(e) => set("microinvest_code", e.target.value)}
                placeholder="Вътрешен код"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Име за печат</Label>
              <Input
                value={form.print_name}
                onChange={(e) => set("print_name", e.target.value)}
                placeholder="Име за печат"
              />
            </div>
            <div className="space-y-1.5" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>ЕИК</Label>
              <div className="flex gap-2">
                <Input
                  value={form.eik}
                  onChange={(e) => set("eik", e.target.value)}
                  placeholder="ЕИК"
                />
                {form.eik && (
                  <Button
                    variant="outline"
                    size="sm"
                    title="Проверка в реестър"
                    onClick={handleCheckEIK}
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>ДДС номер</Label>
              <Input
                value={form.vat_number}
                onChange={(e) => set("vat_number", e.target.value)}
                placeholder="ДДС номер"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Адрес</Label>
            <Input
              value={form.address}
              onChange={(e) => set("address", e.target.value)}
              placeholder="Адрес"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Лице за контакт</Label>
              <Input
                value={form.contact_person}
                onChange={(e) => set("contact_person", e.target.value)}
                placeholder="Име"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Телефон</Label>
              <Input
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
                placeholder="Телефон"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Имейл</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                placeholder="Имейл"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Факс</Label>
              <Input
                value={form.fax}
                onChange={(e) => set("fax", e.target.value)}
                placeholder="Факс"
              />
            </div>
          </div>

          {/* Banking */}
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide pt-2 border-t">
            Банкови данни
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Банка</Label>
              <Input
                value={form.bank_name}
                onChange={(e) => set("bank_name", e.target.value)}
                placeholder="Име на банка"
              />
            </div>
            <div className="space-y-1.5">
              <Label>BIC</Label>
              <Input
                value={form.bic}
                onChange={(e) => set("bic", e.target.value)}
                placeholder="BIC код"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>IBAN</Label>
            <Input
              value={form.iban}
              onChange={(e) => set("iban", e.target.value)}
              placeholder="IBAN"
            />
          </div>

          {/* Pricing */}
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide pt-2 border-t">
            Ценообразуване
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label>Тип</Label>
              <Input
                value={form.client_type}
                onChange={(e) => set("client_type", e.target.value)}
                placeholder="напр. Клиент"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Ценова група</Label>
              <Input
                value={form.price_group}
                onChange={(e) => set("price_group", e.target.value)}
                placeholder="напр. Цена на едро"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Отстъпка (%)</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                max="100"
                value={form.discount_percent}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    discount_percent: parseFloat(e.target.value) || 0,
                  }))
                }
                placeholder="0"
              />
            </div>
          </div>
        </div>
        {saveError && <ErrorMessage message={saveError} />}
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

function SupplierDetailModal({
  open,
  onClose,
  supplier,
}: {
  open: boolean;
  onClose: () => void;
  supplier?: Supplier | null;
}) {
  const [deliveryTab, setDeliveryTab] = useState(true);
  const qc = useQueryClient();

  const { data: deliveries = [], isLoading } = useQuery<IncomingGoods[]>({
    queryKey: ["incoming", "supplier", supplier?.id],
    enabled: open && !!supplier?.id,
    queryFn: () =>
      api.get(`/incoming?supplier_id=${supplier?.id}&limit=100`).then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/suppliers/${supplier?.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      onClose();
    },
  });

  const totalAmount = deliveries.reduce(
    (sum, d) => sum + (d.total_amount || 0),
    0,
  );

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center justify-between">
            <span>{supplier?.name}</span>
            <Button
              variant="ghost"
              size="sm"
              className="text-red-600 hover:text-red-700 hover:bg-red-50"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </DialogTitle>
          <DialogDescription>Подробна информация</DialogDescription>
        </DialogHeader>

        {supplier && (
          <div className="flex-1 overflow-y-auto min-h-0 space-y-6 py-4 pr-1">
            {/* Basic Info */}
            <div className="grid grid-cols-2 gap-4">
              {supplier.microinvest_code && (
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide">
                    Код
                  </p>
                  <p className="font-medium">{supplier.microinvest_code}</p>
                </div>
              )}
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide">
                  ЕИК
                </p>
                <p className="font-medium">{supplier.eik || "—"}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide">
                  ДДС номер
                </p>
                <p className="font-medium">{supplier.vat_number || "—"}</p>
              </div>
              {supplier.city && (
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide">
                    Град
                  </p>
                  <p className="font-medium">{supplier.city}</p>
                </div>
              )}
              {supplier.print_name && (
                <div className="col-span-2">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">
                    Име за печат
                  </p>
                  <p className="font-medium">{supplier.print_name}</p>
                </div>
              )}
              <div className="flex items-start gap-2">
                <Phone className="h-4 w-4 text-gray-400 mt-1 flex-shrink-0" />
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide">
                    Телефон
                  </p>
                  <p className="font-medium">{supplier.phone || "—"}</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Mail className="h-4 w-4 text-gray-400 mt-1 flex-shrink-0" />
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide">
                    Имейл
                  </p>
                  <p
                    className={`font-medium ${supplier.email ? "text-blue-600" : ""}`}
                  >
                    {supplier.email || "—"}
                  </p>
                </div>
              </div>
              {supplier.fax && (
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide">
                    Факс
                  </p>
                  <p className="font-medium">{supplier.fax}</p>
                </div>
              )}
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide">
                  Лице за контакт
                </p>
                <p className="font-medium">{supplier.contact_person || "—"}</p>
              </div>
              <div className="flex items-start gap-2 col-span-2">
                <MapPin className="h-4 w-4 text-gray-400 mt-1 flex-shrink-0" />
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide">
                    Адрес
                  </p>
                  <p className="font-medium">{supplier.address || "—"}</p>
                </div>
              </div>
            </div>

            {/* Banking */}
            {(supplier.bank_name || supplier.bic || supplier.iban) && (
              <div className="border-t pt-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                  Банкови данни
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wide">
                      Банка
                    </p>
                    <p className="font-medium">{supplier.bank_name || "—"}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wide">
                      BIC
                    </p>
                    <p className="font-medium font-mono">
                      {supplier.bic || "—"}
                    </p>
                  </div>
                  {supplier.iban && (
                    <div className="col-span-2">
                      <p className="text-xs text-gray-500 uppercase tracking-wide">
                        IBAN
                      </p>
                      <p className="font-medium font-mono">{supplier.iban}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Pricing */}
            {(supplier.client_type ||
              supplier.price_group ||
              (supplier.discount_percent && supplier.discount_percent > 0)) && (
              <div className="border-t pt-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                  Ценообразуване
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {supplier.client_type && (
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-wide">
                        Тип
                      </p>
                      <p className="font-medium">{supplier.client_type}</p>
                    </div>
                  )}
                  {supplier.price_group && (
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-wide">
                        Ценова група
                      </p>
                      <p className="font-medium">{supplier.price_group}</p>
                    </div>
                  )}
                  {supplier.discount_percent != null &&
                    supplier.discount_percent > 0 && (
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wide">
                          Отстъпка
                        </p>
                        <p className="font-medium">
                          {supplier.discount_percent}%
                        </p>
                      </div>
                    )}
                </div>
              </div>
            )}

            <div className="border-t pt-4">
              <h4 className="font-medium mb-3">
                Доставки ({deliveries.length})
              </h4>
              {isLoading ? (
                <LoadingOverlay />
              ) : deliveries.length === 0 ? (
                <p className="text-gray-500 text-sm">
                  Няма доставки от този доставчик
                </p>
              ) : (
                <div className="space-y-3">
                  <div className="rounded-lg bg-blue-50 p-3 text-sm">
                    <p className="text-gray-600">
                      <strong>Обща сума:</strong> {formatCurrency(totalAmount)}
                    </p>
                  </div>
                  <div className="border rounded-lg overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Номер</TableHead>
                          <TableHead>Дата</TableHead>
                          <TableHead className="text-right">Сума</TableHead>
                          <TableHead>Статус</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {deliveries.map((d) => (
                          <TableRow key={d.id}>
                            <TableCell className="font-mono font-medium">
                              {d.invoice_number || `#${d.id}`}
                            </TableCell>
                            <TableCell>
                              {formatDate(d.invoice_date || d.created_at)}
                            </TableCell>
                            <TableCell className="text-right font-medium">
                              {formatCurrency(d.total_amount || 0)}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={
                                  d.status === "confirmed"
                                    ? "success"
                                    : d.status === "pending"
                                      ? "warning"
                                      : "secondary"
                                }
                              >
                                {d.status === "confirmed"
                                  ? "Потвърдено"
                                  : d.status === "pending"
                                    ? "Чакащо"
                                    : "Чернова"}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onClose}>
            Затвори
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const SUPPLIERS_URL_DEFAULTS = { search: "" };

export function Suppliers() {
  const [urlFilters, setUrlFilters] = useUrlState(SUPPLIERS_URL_DEFAULTS);
  const searchQuery = urlFilters.search;
  const setSearchQuery = (value: string) => setUrlFilters({ search: value });
  const [formOpen, setFormOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(
    null,
  );
  const [editSupplier, setEditSupplier] = useState<Supplier | null>(null);
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const {
    data: suppliers = [],
    isLoading,
    error,
  } = useQuery<Supplier[]>({
    queryKey: ["suppliers"],
    queryFn: () =>
      api.get("/suppliers").then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      }),
    refetchInterval: 30000,
  });

  const { data: deliveryCounts = {} } = useQuery<Record<number, number>>({
    queryKey: ["supplier-delivery-counts"],
    queryFn: () =>
      api.get("/suppliers/delivery-counts").then((r) => r.data ?? {}),
    enabled: suppliers.length > 0,
  });

  const filtered = suppliers.filter((s) =>
    matchesAnyField(searchQuery, [s.name, s.eik, s.microinvest_code]),
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paginatedSuppliers = filtered.slice(
    (page - 1) * pageSize,
    page * pageSize,
  );

  const handleViewDetails = (supplier: Supplier) => {
    setSelectedSupplier(supplier);
    setDetailOpen(true);
  };

  const handleEdit = (supplier: Supplier) => {
    setEditSupplier(supplier);
    setFormOpen(true);
  };

  const handleNewSupplier = () => {
    setEditSupplier(null);
    setFormOpen(true);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Доставчици</h1>
          <p className="text-gray-500 text-sm mt-1">
            Управление на доставчици и техните доставки
          </p>
        </div>
        <Button onClick={handleNewSupplier}>
          <Plus className="h-4 w-4" />
          Нов доставчик
        </Button>
      </div>

      {/* Search */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Search className="h-5 w-5 text-gray-400" />
            <Input
              placeholder="Търси по код, име или ЕИК..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(1);
              }}
              className="border-0 focus-visible:ring-0 text-sm"
            />
          </div>
        </CardHeader>
      </Card>

      {/* Suppliers Grid/Table */}
      <Card>
        <CardHeader>
          <CardTitle>
            Списък (
            {searchQuery
              ? `${filtered.length} от ${suppliers.length}`
              : filtered.length}
            )
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <LoadingOverlay />
          ) : error ? (
            <div className="p-4">
              <ErrorMessage message="Грешка при зареждане на доставчиците" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              {suppliers.length === 0
                ? "Няма добавени доставчици"
                : "Няма резултати за търсене"}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Код</TableHead>
                    <TableHead>Наименование</TableHead>
                    <TableHead>ЕИК</TableHead>
                    <TableHead>Контакт</TableHead>
                    <TableHead className="text-center">Доставки</TableHead>
                    <TableHead className="text-right">Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedSuppliers.map((supplier) => (
                    <TableRow
                      key={supplier.id}
                      className="cursor-pointer hover:bg-blue-50/10"
                    >
                      <TableCell className="font-mono text-sm text-gray-500">
                        {supplier.microinvest_code ? (
                          <HighlightMatch
                            text={supplier.microinvest_code}
                            query={searchQuery}
                          />
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="font-medium">
                        <HighlightMatch
                          text={supplier.name}
                          query={searchQuery}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {supplier.eik ? (
                          <HighlightMatch
                            text={supplier.eik}
                            query={searchQuery}
                          />
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 text-sm text-gray-600">
                          {supplier.phone && <Phone className="h-3.5 w-3.5" />}
                          {supplier.email && <Mail className="h-3.5 w-3.5" />}
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="secondary">
                          {deliveryCounts[supplier.id] || 0}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleViewDetails(supplier)}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleEdit(supplier)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
        {filtered.length > pageSize && (
          <div className="flex items-center justify-between border-t px-4 py-3">
            <p className="text-sm text-gray-500">
              Показани {(page - 1) * pageSize + 1}–
              {Math.min(page * pageSize, filtered.length)} от {filtered.length}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Назад
              </Button>
              <span className="text-sm text-gray-700">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() =>
                  setPage((current) => Math.min(totalPages, current + 1))
                }
              >
                Напред
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Modals */}
      <SupplierForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        supplier={editSupplier}
      />
      <SupplierDetailModal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        supplier={selectedSupplier}
      />
    </div>
  );
}
