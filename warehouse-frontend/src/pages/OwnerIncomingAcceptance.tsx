import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  FileWarning,
  Package,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorMessage, LoadingOverlay, Spinner } from "@/components/ui/spinner";
import {
  useOwnerCancelIncomingGoods,
  useOwnerConfirmIncomingGoods,
  useOwnerIncomingGoods,
  useOwnerIncomingGoodsById,
  type OwnerIncomingGoods,
  type OwnerIncomingGoodsItem,
} from "@/hooks/useOwnerQueries";
import { formatCurrency, formatDate } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { confirm, prompt } from "@/components/ConfirmDialog";
import { useNavigate, useSearchParams } from "react-router-dom";

const STATUS_LABELS: Record<string, string> = {
  pending: "Очаква приемане",
  received: "Приета",
  confirmed: "Потвърдена",
  cancelled: "Отказана",
};

function isoDateDaysAgo(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function isoDateToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatQuantity(value: unknown): string {
  return asNumber(value).toLocaleString("bg-BG", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

function isMissingBatchExpiry(item: OwnerIncomingGoodsItem): boolean {
  return !item.batch_number || !item.expiry_date;
}

function buildAcceptanceSummary(entry?: OwnerIncomingGoods | null) {
  const items = entry?.items ?? [];
  const missingBatchExpiry = items.filter(isMissingBatchExpiry);
  const readyItems = items.filter((item) => !isMissingBatchExpiry(item));

  return {
    totalItems: items.length,
    missingBatchExpiry,
    readyItems,
  };
}

function StatusBadge({ status }: { status: string }) {
  const toneClass =
    status === "confirmed"
      ? "bg-[rgba(37,195,139,0.16)] text-[#25c38b] border border-[rgba(37,195,139,0.26)]"
      : status === "pending"
        ? "bg-[rgba(242,184,75,0.18)] text-[#f2b84b] border border-[rgba(242,184,75,0.25)]"
        : status === "cancelled"
          ? "bg-[rgba(242,111,111,0.16)] text-[#f26f6f] border border-[rgba(242,111,111,0.25)]"
          : "bg-[rgba(79,124,255,0.2)] text-[#4f7cff] border border-[rgba(79,124,255,0.28)]";

  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${toneClass}`}
    >
      {STATUS_LABELS[status] || status}
    </span>
  );
}

function SummaryPill({
  tone,
  label,
  value,
}: {
  tone: "green" | "yellow" | "red" | "blue";
  label: string;
  value: string | number;
}) {
  const toneClass =
    tone === "green"
      ? "border-[rgba(37,195,139,0.28)] bg-[rgba(37,195,139,0.10)] text-[#baf4dd]"
      : tone === "yellow"
        ? "border-[rgba(242,184,75,0.28)] bg-[rgba(242,184,75,0.10)] text-[#f8e7b2]"
        : tone === "red"
          ? "border-[rgba(242,111,111,0.28)] bg-[rgba(242,111,111,0.10)] text-[#ffd0d0]"
          : "border-[rgba(79,124,255,0.28)] bg-[rgba(79,124,255,0.10)] text-[#dbe4ff]";

  return (
    <div className={`rounded-xl border px-3 py-2 text-sm ${toneClass}`}>
      <p className="text-[11px] uppercase tracking-[0.16em] opacity-80">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

function ItemLine({
  item,
  currency,
  tone = "default",
}: {
  item: OwnerIncomingGoodsItem;
  currency: string;
  tone?: "default" | "warning";
}) {
  const lineAmount =
    asNumber(item.total_price) > 0
      ? asNumber(item.total_price)
      : asNumber(item.quantity) * asNumber(item.unit_price);

  return (
    <div
      className={`flex items-start justify-between gap-3 rounded-xl border px-3 py-3 ${
        tone === "warning"
          ? "border-[rgba(242,184,75,0.28)] bg-[rgba(242,184,75,0.08)]"
          : "border-[#243055] bg-[#12162a]"
      }`}
    >
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-[#f3f6ff] truncate">
          {item.name_bg || item.name_en || "Продукт"}
        </p>
        <p className="text-xs text-[#9aa8d6]">
          {formatQuantity(item.quantity)} {item.unit || "бр."} • SKU:{" "}
          {item.sku || "-"}
        </p>
        <p className="text-xs text-[#9aa8d6]">
          Партида: {item.batch_number || "липсва"} • Годен до:{" "}
          {item.expiry_date || "липсва"}
        </p>
      </div>
      <p className="shrink-0 text-sm font-semibold text-[#f3f6ff]">
        {formatCurrency(lineAmount, currency)}
      </p>
    </div>
  );
}

export function OwnerIncomingAcceptance() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedIncomingId = Number(searchParams.get("incoming") || "");
  const [statusFilter, setStatusFilter] = useState<"pending" | "confirmed">(
    "pending",
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [acceptedLocally, setAcceptedLocally] = useState<
    Record<number, boolean>
  >({});

  const dateFrom = useMemo(() => isoDateDaysAgo(30), []);
  const dateTo = useMemo(() => isoDateToday(), []);

  const listQuery = useOwnerIncomingGoods({
    status: statusFilter,
    dateFrom,
    dateTo,
  });
  const detailsQuery = useOwnerIncomingGoodsById(selectedId);
  const confirmMutation = useOwnerConfirmIncomingGoods();
  const cancelMutation = useOwnerCancelIncomingGoods();

  const selected = detailsQuery.data;
  const selectedSummary = buildAcceptanceSummary(selected);
  const canConfirm =
    selectedId !== null && acceptedLocally[selectedId] === true;
  const pendingItems = (listQuery.data || []).filter(
    (item) => item.status === "pending",
  );
  const confirmedItems = (listQuery.data || []).filter(
    (item) => item.status === "confirmed",
  );

  useEffect(() => {
    if (!Number.isFinite(requestedIncomingId) || requestedIncomingId <= 0)
      return;
    if (selectedId === requestedIncomingId) return;
    if (!listQuery.data?.some((item) => item.id === requestedIncomingId))
      return;

    setSelectedId(requestedIncomingId);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("incoming");
        return next;
      },
      { replace: true },
    );
  }, [listQuery.data, requestedIncomingId, selectedId, setSearchParams]);

  const handleConfirmToWarehouse = async (id: number) => {
    const shouldConfirm = await confirm({
      title: "Потвърждение към склад",
      description:
        "Потвърждавам, че физически приех доставката и мога да я подам към склада.",
      confirmText: "Потвърди",
    });
    if (!shouldConfirm) return;

    confirmMutation.mutate(id, {
      onSuccess: () => {
        setAcceptedLocally((current) => ({ ...current, [id]: false }));
        listQuery.refetch();
        detailsQuery.refetch();
        setSelectedId(null);
      },
      onError: (error: any) => {
        const message =
          error?.response?.data?.message || "Неуспешно потвърждение.";
        toast.error(message);
      },
    });
  };

  const handleCancelIncoming = async (id: number) => {
    const shouldCancel = await confirm({
      title: "Анулиране на доставка",
      description:
        "Сигурни ли сте, че искате да анулирате тази доставка? Действието не може да бъде отменено.",
      confirmText: "Анулирай",
      variant: "danger",
    });
    if (!shouldCancel) return;

    const cancelReasonInput = await prompt({
      title: "Причина за отказ",
      description: "По избор — минимум 2 символа ако е въведена.",
      placeholder: "напр. Повредена стока, грешни артикули, ...",
      confirmText: "Продължи",
    });
    if (cancelReasonInput === null) return;

    const cancelReason = cancelReasonInput.trim();
    if (cancelReason.length > 0 && cancelReason.length < 2) {
      toast.error("Причината трябва да е поне 2 символа.");
      return;
    }

    cancelMutation.mutate(
      { id, reason: cancelReason.length > 0 ? cancelReason : undefined },
      {
        onSuccess: () => {
          setAcceptedLocally((current) => ({ ...current, [id]: false }));
          listQuery.refetch();
          detailsQuery.refetch();
          setSelectedId(null);
        },
        onError: (error: any) => {
          const message =
            error?.response?.data?.message || "Неуспешно отказване.";
          toast.error(message);
        },
      },
    );
  };

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-5">
      <Card className="rounded-3xl border-[#243055] bg-[linear-gradient(135deg,#12162a_0%,#171d35_100%)] text-[#f3f6ff] shadow-none">
        <CardContent className="pt-6 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2 max-w-2xl">
              <p className="text-[11px] uppercase tracking-[0.22em] text-[#9aa8d6]">
                Owner receiving workflow
              </p>
              <h1 className="text-2xl font-bold">Приемане на доставки</h1>
              <p className="text-sm text-[#c8d3ff] leading-6">
                Работният ред е ясен: сканираш фактура → преглеждаш критичните
                липси → добавяш втори документ за партиди/срокове при нужда →
                маркираш, че стоката е приета → потвърждаваш към склада.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                className="bg-[#4f7cff] hover:bg-[#4672ec] text-white"
                onClick={() => navigate("/owner/incoming/scan?pick=1")}
              >
                Сканирай нова фактура
              </Button>
              <Button
                variant="outline"
                className="border-[#243055] bg-[#12162a] text-[#f3f6ff] hover:bg-[#161c34]"
                onClick={() => listQuery.refetch()}
              >
                <RefreshCw className="h-4 w-4" />
                Обнови списъка
              </Button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryPill
              tone="yellow"
              label="Чакат приемане"
              value={pendingItems.length}
            />
            <SummaryPill
              tone="green"
              label="Потвърдени"
              value={confirmedItems.length}
            />
            <SummaryPill
              tone="blue"
              label="Период на преглед"
              value={`${formatDate(dateFrom)} – ${formatDate(dateTo)}`}
            />
          </div>
        </CardContent>
      </Card>

      <div className="inline-flex rounded-xl border border-[#243055] p-1 bg-[#161c34]">
        <button
          onClick={() => setStatusFilter("pending")}
          className={`px-4 py-2 text-sm rounded-lg font-semibold transition-colors ${
            statusFilter === "pending"
              ? "bg-[rgba(79,124,255,0.2)] text-[#4f7cff]"
              : "text-[#9aa8d6] hover:text-[#f3f6ff]"
          }`}
        >
          Очакват действие
        </button>
        <button
          onClick={() => setStatusFilter("confirmed")}
          className={`px-4 py-2 text-sm rounded-lg font-semibold transition-colors ${
            statusFilter === "confirmed"
              ? "bg-[rgba(79,124,255,0.2)] text-[#4f7cff]"
              : "text-[#9aa8d6] hover:text-[#f3f6ff]"
          }`}
        >
          Потвърдени към склад
        </button>
      </div>

      {listQuery.isLoading ? (
        <LoadingOverlay />
      ) : listQuery.isError ? (
        <div className="space-y-3">
          <ErrorMessage message="Грешка при зареждане на доставките." />
          <Button
            variant="outline"
            className="border-[#243055] bg-[#12162a] text-[#f3f6ff] hover:bg-[#161c34]"
            onClick={() => listQuery.refetch()}
          >
            Опитай отново
          </Button>
        </div>
      ) : (listQuery.data || []).length === 0 ? (
        <div className="rounded-3xl border border-dashed border-[#243055] bg-[#12162a] p-12 text-center text-[#9aa8d6] space-y-4">
          <Package className="h-8 w-8 mx-auto" />
          <div>
            <p className="text-[#f3f6ff] font-semibold">
              Няма доставки за този филтър.
            </p>
            <p className="text-sm text-[#8090bf] mt-1">
              За нова доставка първо сканирай фактура и я запази като чакаща.
            </p>
          </div>
          <div className="flex justify-center">
            <Button
              className="bg-[#4f7cff] hover:bg-[#4672ec] text-white"
              onClick={() => navigate("/owner/incoming/scan?pick=1")}
            >
              Сканирай фактура
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {(listQuery.data || []).map((item) => {
            const summary = buildAcceptanceSummary(item);
            const missingCount = summary.missingBatchExpiry.length;
            const readyCount = summary.readyItems.length;
            const actionLabel =
              item.status === "confirmed"
                ? "Само преглед"
                : missingCount > 0
                  ? "Има липси"
                  : "Готова за потвърждение";

            return (
              <Card
                key={item.id}
                className="cursor-pointer rounded-3xl border-[#243055] bg-[#12162a] text-[#f3f6ff] shadow-none hover:bg-[#161c34] transition-colors"
                onClick={() => setSelectedId(item.id)}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-2">
                      <p className="text-[11px] uppercase tracking-[0.18em] text-[#9aa8d6]">
                        Документ № {item.invoice_number || `#${item.id}`}
                      </p>
                      <CardTitle className="text-lg truncate">
                        {item.supplier_name || "Няма доставчик"}
                      </CardTitle>
                      <p className="text-sm text-[#9aa8d6]">
                        {formatDate(item.invoice_date || item.created_at)} •{" "}
                        {item.item_count || 0} позиции
                      </p>
                    </div>
                    <StatusBadge status={item.status} />
                  </div>
                </CardHeader>

                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-[#243055] bg-[#161c34] px-3 py-2.5">
                      <p className="text-[11px] uppercase tracking-[0.16em] text-[#9aa8d6]">
                        Общо
                      </p>
                      <p className="mt-1 text-lg font-semibold text-[#f3f6ff]">
                        {formatCurrency(
                          item.total_amount,
                          item.currency || "EUR",
                        )}
                      </p>
                    </div>
                    <div className="rounded-xl border border-[#243055] bg-[#161c34] px-3 py-2.5">
                      <p className="text-[11px] uppercase tracking-[0.16em] text-[#9aa8d6]">
                        Оперативен статус
                      </p>
                      <p className="mt-1 text-sm font-semibold text-[#f3f6ff]">
                        {actionLabel}
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="rounded-xl border border-[rgba(37,195,139,0.22)] bg-[rgba(37,195,139,0.08)] px-3 py-2.5">
                      <p className="text-xs text-[#9fe7ca]">
                        Редове готови за приемане
                      </p>
                      <p className="mt-1 text-lg font-semibold text-[#f3f6ff]">
                        {readyCount}
                      </p>
                    </div>
                    <div className="rounded-xl border border-[rgba(242,184,75,0.22)] bg-[rgba(242,184,75,0.08)] px-3 py-2.5">
                      <p className="text-xs text-[#f8e7b2]">
                        Редове без партида/срок
                      </p>
                      <p className="mt-1 text-lg font-semibold text-[#f3f6ff]">
                        {missingCount}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog
        open={selectedId !== null}
        onOpenChange={(open) => !open && setSelectedId(null)}
      >
        <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto border border-[#243055] bg-[#090c18] text-[#f3f6ff]">
          <DialogHeader>
            <DialogTitle className="text-[#f3f6ff]">
              Приемане на доставка • документ{" "}
              {selected?.invoice_number || `#${selectedId}`}
            </DialogTitle>
            <DialogDescription className="text-[#9aa8d6]">
              Прегледай блокиращите липси, маркирай физически прием и после
              потвърди към склада.
            </DialogDescription>
          </DialogHeader>

          {detailsQuery.isLoading ? (
            <LoadingOverlay />
          ) : detailsQuery.isError || !selected ? (
            <div className="space-y-3">
              <ErrorMessage message="Неуспешно зареждане на детайли." />
              <Button
                variant="outline"
                className="border-[#243055] bg-[#12162a] text-[#f3f6ff] hover:bg-[#161c34]"
                onClick={() => detailsQuery.refetch()}
              >
                Опитай отново
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <Card className="rounded-3xl border-[#243055] bg-[linear-gradient(135deg,#12162a_0%,#171d35_100%)] text-[#f3f6ff] shadow-none">
                <CardContent className="pt-6 space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-2 min-w-0">
                      <p className="text-[11px] uppercase tracking-[0.18em] text-[#9aa8d6]">
                        Доставка #{selected.id}
                      </p>
                      <h2 className="text-2xl font-bold text-[#f3f6ff]">
                        {selected.supplier_name || "Няма доставчик"}
                      </h2>
                      <p className="text-sm text-[#cbd5ff]">
                        Фактура {selected.invoice_number || "-"} •{" "}
                        {formatDate(
                          selected.invoice_date || selected.created_at,
                        )}
                      </p>
                    </div>
                    <StatusBadge status={selected.status} />
                  </div>

                  <div className="grid gap-3 md:grid-cols-4">
                    <SummaryPill
                      tone="blue"
                      label="Обща сума"
                      value={formatCurrency(
                        selected.total_amount,
                        selected.currency || "EUR",
                      )}
                    />
                    <SummaryPill
                      tone="blue"
                      label="Всички редове"
                      value={selectedSummary.totalItems}
                    />
                    <SummaryPill
                      tone={
                        selectedSummary.missingBatchExpiry.length > 0
                          ? "yellow"
                          : "green"
                      }
                      label="Без партида/срок"
                      value={selectedSummary.missingBatchExpiry.length}
                    />
                    <SummaryPill
                      tone="green"
                      label="Готови редове"
                      value={selectedSummary.readyItems.length}
                    />
                  </div>
                </CardContent>
              </Card>

              <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
                <Card className="rounded-3xl border-[#243055] bg-[#12162a] text-[#f3f6ff] shadow-none">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <ClipboardCheck className="h-4 w-4 text-[#4f7cff]" />
                      Оперативен чеклист
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div className="rounded-xl border border-[#243055] bg-[#161c34] px-4 py-3">
                      <p className="font-semibold text-[#f3f6ff]">
                        1. Провери критичните липси
                      </p>
                      <p className="mt-1 text-[#9aa8d6]">
                        Ако има редове без партида или срок, върни се към
                        сканирането и добави втория документ / ръчно попълване
                        преди окончателното приемане.
                      </p>
                    </div>
                    <div className="rounded-xl border border-[#243055] bg-[#161c34] px-4 py-3">
                      <p className="font-semibold text-[#f3f6ff]">
                        2. Маркирай, че стоката е приета физически
                      </p>
                      <p className="mt-1 text-[#9aa8d6]">
                        Това е локална стъпка за оператора преди подаване към
                        склада.
                      </p>
                    </div>
                    <div className="rounded-xl border border-[#243055] bg-[#161c34] px-4 py-3">
                      <p className="font-semibold text-[#f3f6ff]">
                        3. Потвърди към склада
                      </p>
                      <p className="mt-1 text-[#9aa8d6]">
                        След потвърждение наличностите се актуализират и
                        доставката става окончателна.
                      </p>
                    </div>
                  </CardContent>
                </Card>

                <Card className="rounded-3xl border-[#243055] bg-[#12162a] text-[#f3f6ff] shadow-none">
                  <CardHeader>
                    <CardTitle className="text-base">
                      Какво още блокира приемането
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {selectedSummary.missingBatchExpiry.length > 0 ? (
                      <div className="rounded-2xl border border-[rgba(242,184,75,0.3)] bg-[rgba(242,184,75,0.08)] px-4 py-3 text-sm text-[#f8e7b2] space-y-2">
                        <p className="font-semibold flex items-center gap-2">
                          <FileWarning className="h-4 w-4" />
                          Липсват партида или срок на годност по{" "}
                          {selectedSummary.missingBatchExpiry.length} реда
                        </p>
                        <p>
                          Това е типичният сигнал да се добави придружителен
                          документ за партиди и срокове преди складовото
                          потвърждение.
                        </p>
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-[rgba(37,195,139,0.3)] bg-[rgba(37,195,139,0.08)] px-4 py-3 text-sm text-[#baf4dd] space-y-2">
                        <p className="font-semibold flex items-center gap-2">
                          <CheckCircle2 className="h-4 w-4" />
                          Няма критични липси по редовете
                        </p>
                        <p>
                          Доставката е готова за физическо приемане и
                          потвърждение към склада.
                        </p>
                      </div>
                    )}

                    {selected.status === "confirmed" && (
                      <div className="rounded-2xl border border-[rgba(37,195,139,0.3)] bg-[rgba(37,195,139,0.08)] px-4 py-3 text-sm text-[#baf4dd]">
                        Тази доставка вече е потвърдена и наличностите са
                        обновени.
                      </div>
                    )}
                    {selected.status === "cancelled" && (
                      <div className="rounded-2xl border border-[rgba(242,111,111,0.3)] bg-[rgba(242,111,111,0.08)] px-4 py-3 text-sm text-[#ffd0d0]">
                        Тази доставка е отказана и не може да се потвърждава.
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              {selectedSummary.missingBatchExpiry.length > 0 && (
                <Card className="rounded-3xl border-[rgba(242,184,75,0.3)] bg-[rgba(242,184,75,0.08)] text-[#f3f6ff] shadow-none">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2 text-[#f8e7b2]">
                      <AlertTriangle className="h-4 w-4" />
                      Редове за допълване
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {selectedSummary.missingBatchExpiry.map((item) => (
                      <ItemLine
                        key={item.id}
                        item={item}
                        currency={selected.currency || "EUR"}
                        tone="warning"
                      />
                    ))}
                  </CardContent>
                </Card>
              )}

              <Card className="rounded-3xl border-[#243055] bg-[#12162a] text-[#f3f6ff] shadow-none">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Package className="h-4 w-4 text-[#4f7cff]" />
                    Редове готови за приемане
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {selectedSummary.readyItems.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-[#243055] bg-[#101427] px-4 py-6 text-sm text-[#9aa8d6] text-center">
                      Все още няма редове с пълна партида и срок на годност.
                    </div>
                  ) : (
                    selectedSummary.readyItems.map((item) => (
                      <ItemLine
                        key={item.id}
                        item={item}
                        currency={selected.currency || "EUR"}
                      />
                    ))
                  )}
                </CardContent>
              </Card>

              {selected.status === "pending" && (
                <Card className="rounded-3xl border-[#243055] bg-[#12162a] text-[#f3f6ff] shadow-none sticky bottom-0">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <ShieldAlert className="h-4 w-4 text-[#4f7cff]" />
                      Действия по приемането
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <Button
                      variant="outline"
                      className="w-full border-[#243055] bg-[#161c34] text-[#f3f6ff] hover:bg-[#1b2340]"
                      onClick={() => {
                        if (selectedId !== null) {
                          setAcceptedLocally((current) => ({
                            ...current,
                            [selectedId]: !current[selectedId],
                          }));
                        }
                      }}
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      {canConfirm
                        ? "Физически приета – готово за склад"
                        : "Маркирай като физически приета"}
                    </Button>
                    <Button
                      className="w-full bg-[#4f7cff] hover:bg-[#4672ec] text-white"
                      disabled={
                        !canConfirm ||
                        confirmMutation.isPending ||
                        cancelMutation.isPending
                      }
                      onClick={() => {
                        if (selectedId !== null)
                          handleConfirmToWarehouse(selectedId);
                      }}
                    >
                      {confirmMutation.isPending ? (
                        <>
                          <Spinner size="sm" />
                          Потвърждаване...
                        </>
                      ) : (
                        "Потвърди към склад"
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      className="w-full border-[rgba(242,111,111,0.45)] bg-[rgba(242,111,111,0.08)] text-[#f8b0b0] hover:bg-[rgba(242,111,111,0.16)] hover:text-[#ffd0d0]"
                      disabled={
                        confirmMutation.isPending || cancelMutation.isPending
                      }
                      onClick={() => {
                        if (selectedId !== null)
                          handleCancelIncoming(selectedId);
                      }}
                    >
                      {cancelMutation.isPending ? (
                        <>
                          <Spinner size="sm" />
                          Отказване...
                        </>
                      ) : (
                        "Анулирай доставка"
                      )}
                    </Button>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              className="border-[#243055] bg-[#12162a] text-[#f3f6ff] hover:bg-[#161c34]"
              onClick={() => setSelectedId(null)}
            >
              Затвори
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
