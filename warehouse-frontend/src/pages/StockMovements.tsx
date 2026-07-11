import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  History,
  AlertTriangle,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  formatDate,
  formatUnit,
  isoDateToday,
  getApiErrorMessage,
} from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import { useAuth } from "@/contexts/AuthContext";

type MovementType = "in" | "out";

interface ReasonOption {
  value: string;
  label: string;
}

interface ReasonsResponse {
  in: ReasonOption[];
  out: ReasonOption[];
}

interface Movement {
  id: number;
  product_id: number;
  movement_type: MovementType;
  quantity: number;
  quantity_before: number;
  quantity_after: number;
  reason: string;
  reason_label: string;
  note: string | null;
  created_at: string;
  created_by: string | null;
  product_name: string;
  product_sku: string;
  product_unit: string;
  created_by_name: string | null;
  created_by_email: string | null;
}

interface ProductOption {
  id: number;
  name_bg: string;
  sku: string;
  unit: string;
  total_stock: number;
  is_service?: boolean;
}

/**
 * StockMovements — обединена страница за ръчни in/out движения.
 * Tabs:
 *   • 📥 Завеждане — добавя количество (доставка без фактура, корекция,
 *     връщане от клиент, free sample)
 *   • 📤 Изписване — намаля количество (брак, експирация, кражба, и т.н.)
 *   • 📊 История — full audit trail с филтри по тип/продукт/период/потребител
 *
 * Permission: STOCK_MOVEMENTS_MANAGE (admin + accountant). Warehouse —
 * няма достъп (route guard в App.tsx).
 */
export function StockMovements() {
  const [tab, setTab] = useState<"in" | "out" | "history">("in");

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">
          📦 Завеждане и изписване на стока
        </h1>
        <p className="text-sm text-gray-500">
          Ръчни inventory adjustments извън стандартния flow на поръчките и
          входящите доставки. Всяко движение се записва с потребител, време и
          причина за пълен audit trail.
        </p>
      </div>

      <div className="flex gap-1 border-b border-gray-200">
        <TabButton
          active={tab === "in"}
          onClick={() => setTab("in")}
          icon={<ArrowDownToLine className="h-4 w-4" />}
          label="📥 Завеждане"
          color="emerald"
        />
        <TabButton
          active={tab === "out"}
          onClick={() => setTab("out")}
          icon={<ArrowUpFromLine className="h-4 w-4" />}
          label="📤 Изписване"
          color="rose"
        />
        <TabButton
          active={tab === "history"}
          onClick={() => setTab("history")}
          icon={<History className="h-4 w-4" />}
          label="📊 История"
          color="slate"
        />
      </div>

      {tab === "in" && <MovementForm movementType="in" />}
      {tab === "out" && <MovementForm movementType="out" />}
      {tab === "history" && <HistoryView />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  color,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  color: "emerald" | "rose" | "slate";
}) {
  const colorClasses = active
    ? color === "emerald"
      ? "border-emerald-500 text-emerald-700 bg-emerald-50"
      : color === "rose"
        ? "border-rose-500 text-rose-700 bg-rose-50"
        : "border-slate-500 text-slate-700 bg-slate-50"
    : "border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${colorClasses}`}
    >
      {icon}
      {label}
    </button>
  );
}

function MovementForm({ movementType }: { movementType: MovementType }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [productId, setProductId] = useState<string>("");
  const [productMeta, setProductMeta] = useState<ProductOption | null>(null);
  const [quantity, setQuantity] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [allowNegative, setAllowNegative] = useState(false);
  // СПИСЪЧЕН режим: няколко продукта се добавят в списък и се завеждат/
  // изписват с ЕДНО натискане (преди — само 1 продукт на запис).
  const [rows, setRows] = useState<
    Array<{
      productId: number;
      label: string;
      sku: string;
      unit: string;
      qty: number;
      allowNegative: boolean;
    }>
  >([]);

  // Reasons dropdown — server е source of truth (вижта един списък,
  // едно място за промяна). Filter-натo по тип на движението.
  const { data: reasonsData } = useQuery<ReasonsResponse>({
    queryKey: ["stock-movements-reasons"],
    queryFn: () => api.get("/stock-movements/reasons").then((r) => r.data),
    staleTime: 1000 * 60 * 60, // 1h — рядко се променят
  });
  const reasons = useMemo(
    () => (movementType === "in" ? reasonsData?.in : reasonsData?.out) ?? [],
    [reasonsData, movementType],
  );

  // Default reason при смяна на tab/type
  useEffect(() => {
    if (reasons.length > 0 && !reason) {
      setReason(reasons[0].value);
    }
  }, [reasons, reason]);

  // Reset на reason при смяна на movementType (т.к. dropdown-ите имат
  // различни опции и старият value може да е invalid).
  useEffect(() => {
    setReason("");
  }, [movementType]);

  // Catalog за product picker. Backend връща lightweight list.
  const { data: catalog = [] } = useQuery<ProductOption[]>({
    queryKey: ["products-catalog-for-movements"],
    queryFn: () =>
      api.get("/products?catalog=true&limit=25000").then((r) =>
        (Array.isArray(r.data) ? r.data : r.data?.data || []).map((p: any) => ({
          id: p.id,
          name_bg: p.name_bg ?? "",
          sku: p.sku ?? "",
          unit: p.unit ?? "",
          total_stock: parseFloat(String(p.total_stock ?? 0)),
          is_service: p.is_service === true,
        })),
      ),
    staleTime: 1000 * 30,
  });
  const productOptions = useMemo(
    () =>
      catalog
        // Услуги нямат stock, не са приложими за movements
        .filter((p) => !p.is_service)
        .map((p) => ({
          value: String(p.id),
          label: `${p.name_bg} · ${p.sku}`,
        })),
    [catalog],
  );

  useEffect(() => {
    if (!productId) {
      setProductMeta(null);
      return;
    }
    const pid = parseInt(productId, 10);
    const p = catalog.find((c) => c.id === pid);
    setProductMeta(p ?? null);
  }, [productId, catalog]);

  const mutation = useMutation({
    // Последователни POST-ове (не паралелни) — стоковата математика на
    // backend-а чете текущата наличност преди всеки запис.
    mutationFn: async (payloads: any[]) => {
      const done: string[] = [];
      for (const p of payloads) {
        try {
          // _label е само за съобщенията тук — не отива към API-то.
          const { _label, ...body } = p;
          await api.post("/stock-movements/", body);
          done.push(_label ?? String(body.product_id));
        } catch (err) {
          throw Object.assign(err instanceof Error ? err : new Error("fail"), {
            _doneCount: done.length,
            _failedLabel: p._label,
          });
        }
      }
      return done.length;
    },
    onSuccess: (count: number) => {
      const verb = movementType === "in" ? "Заведени" : "Изписани";
      toast.success(
        count === 1
          ? `${movementType === "in" ? "Заведена" : "Изписана"} стока · inventory обновен`
          : `${verb} ${count} продукта · inventory обновен`,
      );
      qc.invalidateQueries({ queryKey: ["stock-movements-history"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["products-catalog-for-movements"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      // Reset form
      setProductId("");
      setProductMeta(null);
      setQuantity("");
      setNote("");
      setAllowNegative(false);
      setRows([]);
    },
    onError: (err: any) => {
      const doneCount = err?._doneCount ?? 0;
      const failed = err?._failedLabel ? ` („${err._failedLabel}")` : "";
      toast.error(
        getApiErrorMessage(
          err,
          doneCount > 0
            ? `Записани ${doneCount}, грешка при следващия${failed}`
            : "Грешка при запис на движението",
        ),
      );
      // Не чистим списъка при грешка — операторът вижда какво остава.
      qc.invalidateQueries({ queryKey: ["stock-movements-history"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });

  const qty = parseFloat(quantity) || 0;
  const stock = productMeta?.total_stock ?? 0;
  const newStock = movementType === "in" ? stock + qty : stock - qty;
  const willGoNegative = movementType === "out" && newStock < 0;
  const pickerValid =
    !!productId && qty > 0 && (!willGoNegative || (isAdmin && allowNegative));
  // Submit-ва се: списъкът (ако има редове) + текущо попълненият продукт
  // (удобство — не е нужно "Добави" преди последния).
  const canSubmit =
    !!reason &&
    !mutation.isPending &&
    (rows.length > 0 ? !productId || pickerValid : pickerValid);

  const addToList = () => {
    if (!pickerValid || !productMeta) return;
    setRows((curr) => {
      const pid = parseInt(productId, 10);
      const existing = curr.find((r) => r.productId === pid);
      if (existing) {
        return curr.map((r) =>
          r.productId === pid ? { ...r, qty: r.qty + qty } : r,
        );
      }
      return [
        ...curr,
        {
          productId: pid,
          label: productMeta.name_bg,
          sku: productMeta.sku,
          unit: productMeta.unit,
          qty,
          allowNegative: willGoNegative && isAdmin && allowNegative,
        },
      ];
    });
    setProductId("");
    setProductMeta(null);
    setQuantity("");
    setAllowNegative(false);
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    const payloads: any[] = rows.map((r) => ({
      product_id: r.productId,
      movement_type: movementType,
      quantity: r.qty,
      reason,
      note: note.trim() || undefined,
      ...(r.allowNegative ? { allow_negative: true } : {}),
      _label: r.label,
    }));
    // Текущо попълненият (но не "Добавен") продукт също влиза.
    if (pickerValid && productMeta) {
      payloads.push({
        product_id: parseInt(productId, 10),
        movement_type: movementType,
        quantity: qty,
        reason,
        note: note.trim() || undefined,
        ...(willGoNegative && isAdmin && allowNegative
          ? { allow_negative: true }
          : {}),
        _label: productMeta.name_bg,
      });
    }
    if (payloads.length === 0) return;
    mutation.mutate(payloads);
  };

  const colorTheme = movementType === "in" ? "emerald" : "rose";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-4 bg-white rounded-lg border border-gray-200 p-5">
        <div className="space-y-1.5">
          <Label>Продукт *</Label>
          <Combobox
            items={productOptions}
            value={productId}
            onChange={(v) => setProductId(v)}
            placeholder="Избери продукт..."
            emptyMessage="Няма намерени продукти"
          />
          {productMeta && (
            <div className="text-xs text-gray-500 mt-1">
              SKU: <span className="font-mono">{productMeta.sku}</span> · Мерна
              единица: {formatUnit(productMeta.unit)} · Наличност:{" "}
              <span
                className={
                  productMeta.total_stock > 0
                    ? "text-emerald-600 font-medium"
                    : "text-red-500 font-medium"
                }
              >
                {productMeta.total_stock}
              </span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>
              Количество * {movementType === "in" ? "(добави)" : "(извади)"}
            </Label>
            <Input
              type="number"
              step="0.001"
              min="0.001"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="0.000"
              className={
                willGoNegative ? "border-amber-500 text-amber-700" : ""
              }
            />
            {productMeta && qty > 0 && (
              <div
                className={`text-xs ${willGoNegative ? "text-amber-700" : "text-gray-500"}`}
              >
                {movementType === "in" ? "След завеждане" : "След изписване"}:{" "}
                <span
                  className={
                    newStock < 0
                      ? "font-bold text-red-600"
                      : newStock === 0
                        ? "font-bold text-amber-600"
                        : "font-bold text-emerald-600"
                  }
                >
                  {newStock}
                </span>
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Причина *</Label>
            <Select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">Избери причина...</option>
              {reasons.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {/* Списъчен режим: добави продукта и продължи със следващия. */}
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={addToList}
            disabled={!pickerValid || mutation.isPending}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-dashed border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            ➕ Добави към списъка
          </button>
          {rows.length > 0 && (
            <span className="text-xs text-gray-500">
              {rows.length} {rows.length === 1 ? "продукт" : "продукта"} в
              списъка
            </span>
          )}
        </div>

        {rows.length > 0 && (
          <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
            {rows.map((r) => (
              <div
                key={r.productId}
                className="flex items-center gap-3 px-3 py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-gray-900">
                    {r.label}
                  </div>
                  <div className="text-xs text-gray-400 font-mono">{r.sku}</div>
                </div>
                <div className="shrink-0 font-bold text-gray-900">
                  {r.qty} {formatUnit(r.unit)}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setRows((curr) =>
                      curr.filter((x) => x.productId !== r.productId),
                    )
                  }
                  disabled={mutation.isPending}
                  aria-label="Премахни от списъка"
                  className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50"
                >
                  Премахни
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-1.5">
          <Label>Бележка (свободен текст)</Label>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Допълнителни детайли — за audit-а..."
            rows={2}
          />
        </div>

        {willGoNegative && (
          <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-300 bg-amber-50">
            <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-amber-900">
                Inventory ще отиде на минус ({newStock})
              </div>
              {isAdmin ? (
                <>
                  <div className="text-xs text-amber-700 mb-2">
                    Само admin може да одобри изписване над наличността. Markaй,
                    за да позволиш операцията.
                  </div>
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={allowNegative}
                      onChange={(e) => setAllowNegative(e.target.checked)}
                      className="h-4 w-4 accent-amber-600"
                    />
                    Потвърждавам — изпиши на минус
                  </label>
                </>
              ) : (
                <div className="text-xs text-amber-700">
                  Само admin може да одобри. Помоли admin да го направи или
                  намали количеството.
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={
              colorTheme === "emerald"
                ? "bg-emerald-600 hover:bg-emerald-700"
                : "bg-rose-600 hover:bg-rose-700"
            }
          >
            {(() => {
              if (mutation.isPending) return "Записва...";
              const count = rows.length + (pickerValid ? 1 : 0);
              if (movementType === "in") {
                return count > 1
                  ? `📥 Заведи ${count} продукта`
                  : "📥 Заведи в склада";
              }
              return count > 1
                ? `📤 Изпиши ${count} продукта`
                : "📤 Изпиши от склада";
            })()}
          </Button>
        </div>
      </div>

      <div className="lg:col-span-1">
        <RecentMovementsCard movementType={movementType} />
      </div>
    </div>
  );
}

function RecentMovementsCard({ movementType }: { movementType: MovementType }) {
  const { data: list } = useQuery<{ data: Movement[] }>({
    queryKey: ["stock-movements-recent", movementType],
    queryFn: () =>
      api
        .get(`/stock-movements/?movement_type=${movementType}&limit=15`)
        .then((r) => r.data),
    refetchInterval: 10000,
  });

  const rows = list?.data ?? [];

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">
        Последни {movementType === "in" ? "завеждания" : "изписвания"} (15)
      </h3>
      {rows.length === 0 ? (
        <div className="text-xs text-gray-400 italic py-3 text-center">
          Няма записи
        </div>
      ) : (
        <div className="space-y-2 max-h-[600px] overflow-y-auto">
          {rows.map((m) => (
            <div
              key={m.id}
              className="text-xs border-b border-gray-100 pb-2 last:border-0"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-gray-800 truncate flex-1 mr-2">
                  {m.product_name}
                </span>
                <span
                  className={`font-bold shrink-0 ${
                    m.movement_type === "in"
                      ? "text-emerald-600"
                      : "text-rose-600"
                  }`}
                >
                  {m.movement_type === "in" ? "+" : "−"}
                  {m.quantity}
                </span>
              </div>
              <div className="text-gray-500 flex justify-between">
                <span>{m.reason_label}</span>
                <span>{formatDateTime(m.created_at)}</span>
              </div>
              {m.created_by_name && (
                <div className="text-gray-400">от {m.created_by_name}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryView() {
  const [filterType, setFilterType] = useState<"" | MovementType>("");
  const [dateFrom, setDateFrom] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [dateTo, setDateTo] = useState<string>(isoDateToday());

  const { data: list, isLoading } = useQuery<{ data: Movement[] }>({
    queryKey: ["stock-movements-history", filterType, dateFrom, dateTo],
    queryFn: () => {
      const parts: string[] = [];
      if (filterType) parts.push(`movement_type=${filterType}`);
      if (dateFrom) parts.push(`date_from=${dateFrom}`);
      if (dateTo) parts.push(`date_to=${dateTo}`);
      parts.push("limit=10000");
      return api
        .get(`/stock-movements/?${parts.join("&")}`)
        .then((r) => r.data);
    },
  });

  const rows = list?.data ?? [];
  const totalIn = rows
    .filter((r) => r.movement_type === "in")
    .reduce((s, r) => s + r.quantity, 0);
  const totalOut = rows
    .filter((r) => r.movement_type === "out")
    .reduce((s, r) => s + r.quantity, 0);

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg border border-gray-200 p-4 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Тип</Label>
          <Select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as any)}
            className="h-9"
          >
            <option value="">Всички</option>
            <option value="in">📥 Завеждане</option>
            <option value="out">📤 Изписване</option>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">От</Label>
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-9"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">До</Label>
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-9"
          />
        </div>
        <div className="flex-1 flex justify-end gap-4 text-sm">
          <Badge
            variant="secondary"
            className="bg-emerald-100 text-emerald-700"
          >
            📥 Заведени: {totalIn.toFixed(3)}
          </Badge>
          <Badge variant="secondary" className="bg-rose-100 text-rose-700">
            📤 Изписани: {totalOut.toFixed(3)}
          </Badge>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">Дата</TableHead>
              <TableHead className="w-20">Тип</TableHead>
              <TableHead>Продукт</TableHead>
              <TableHead className="w-28 text-right">Количество</TableHead>
              <TableHead className="w-32 text-right">Преди → След</TableHead>
              <TableHead>Причина</TableHead>
              <TableHead>Потребител</TableHead>
              <TableHead>Бележка</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="text-center text-gray-400 py-6"
                >
                  Зарежда...
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="text-center text-gray-400 py-6"
                >
                  Няма записи за избрания период
                </TableCell>
              </TableRow>
            ) : (
              rows.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="text-xs">
                    {formatDateTime(m.created_at)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="secondary"
                      className={
                        m.movement_type === "in"
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-rose-100 text-rose-700"
                      }
                    >
                      {m.movement_type === "in" ? "📥 IN" : "📤 OUT"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    <div className="font-medium">{m.product_name}</div>
                    <div className="text-xs text-gray-400 font-mono">
                      {m.product_sku}
                    </div>
                  </TableCell>
                  <TableCell
                    className={`text-right font-bold ${
                      m.movement_type === "in"
                        ? "text-emerald-600"
                        : "text-rose-600"
                    }`}
                  >
                    {m.movement_type === "in" ? "+" : "−"}
                    {m.quantity}
                  </TableCell>
                  <TableCell className="text-right text-xs text-gray-500">
                    {m.quantity_before} → {m.quantity_after}
                  </TableCell>
                  <TableCell className="text-sm">{m.reason_label}</TableCell>
                  <TableCell className="text-xs">
                    {m.created_by_name ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs text-gray-500 max-w-xs truncate">
                    {m.note ?? "—"}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("bg-BG", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return formatDate(iso);
  }
}
