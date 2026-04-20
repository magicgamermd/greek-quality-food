import React, { useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  useConfirmIncomingGoods,
  useIncomingGoods,
  useIncomingGoodsById,
} from "../hooks/useOwnerQueries";
import { ErrorState } from "../components/ErrorState";
import { LoadingState } from "../components/LoadingState";
import { colors } from "../theme/colors";
import {
  formatCurrency,
  formatDate,
  formatQuantity,
  isoDateDaysAgo,
  isoDateToday,
} from "../utils/format";
import type { IncomingGoods, IncomingGoodsItem } from "../types";

const STATUS_LABELS: Record<string, string> = {
  pending: "Очаква приемане",
  received: "Приета",
  confirmed: "Потвърдена",
  cancelled: "Отказана",
};

function isMissingBatchExpiry(item: IncomingGoodsItem): boolean {
  return !item.batch_number || !item.expiry_date;
}

function buildSummary(entry?: IncomingGoods | null) {
  const items = entry?.items ?? [];
  const missing = items.filter(isMissingBatchExpiry);
  const ready = items.filter((item) => !isMissingBatchExpiry(item));
  return {
    all: items,
    missing,
    ready,
  };
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "confirmed"
      ? colors.success
      : status === "pending"
        ? colors.warning
        : status === "cancelled"
          ? colors.danger
          : colors.primary;

  return (
    <View style={[styles.statusBadge, { backgroundColor: `${tone}26` }]}>
      <Text style={[styles.statusText, { color: tone }]}>
        {STATUS_LABELS[status] || status}
      </Text>
    </View>
  );
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone: "blue" | "green" | "yellow";
}) {
  const accent = tone === "green" ? colors.success : tone === "yellow" ? colors.warning : colors.primary;
  return (
    <View style={[styles.metricCard, { borderColor: `${accent}44`, backgroundColor: `${accent}14` }]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function ItemCard({ item, currency, warning = false }: { item: IncomingGoodsItem; currency: string; warning?: boolean }) {
  const lineAmount =
    Number(item.total_price || 0) > 0
      ? Number(item.total_price)
      : Number(item.quantity || 0) * Number(item.unit_price || 0);

  return (
    <View style={[styles.itemCard, warning && styles.itemCardWarning]}>
      <View style={{ flex: 1 }}>
        <Text style={styles.itemName}>{item.name_bg || item.name_en || "Продукт"}</Text>
        <Text style={styles.itemMeta}>
          {formatQuantity(item.quantity)} {item.unit || "бр."} • SKU: {item.sku || "-"}
        </Text>
        <Text style={styles.itemMeta}>
          Партида: {item.batch_number || "липсва"} • Годен до: {item.expiry_date || "липсва"}
        </Text>
      </View>
      <Text style={styles.itemAmount}>{formatCurrency(lineAmount, currency)}</Text>
    </View>
  );
}

export function IncomingAcceptanceScreen() {
  const [statusFilter, setStatusFilter] = useState<"pending" | "confirmed">("pending");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [acceptedLocally, setAcceptedLocally] = useState<Record<number, boolean>>({});

  const dateFrom = useMemo(() => isoDateDaysAgo(30), []);
  const dateTo = useMemo(() => isoDateToday(), []);

  const listQuery = useIncomingGoods({
    status: statusFilter,
    dateFrom,
    dateTo,
  });
  const detailsQuery = useIncomingGoodsById(selectedId);
  const confirmMutation = useConfirmIncomingGoods();

  if (listQuery.isLoading) {
    return <LoadingState message="Зареждане на доставки..." />;
  }

  if (listQuery.isError) {
    return <ErrorState onRetry={listQuery.refetch} />;
  }

  const items = listQuery.data || [];
  const pendingCount = items.filter((item) => item.status === "pending").length;
  const confirmedCount = items.filter((item) => item.status === "confirmed").length;
  const selected = detailsQuery.data;
  const selectedSummary = buildSummary(selected);
  const canConfirm = selectedId !== null && acceptedLocally[selectedId] === true;

  const onConfirmDelivery = (id: number) => {
    Alert.alert("Потвърждение", "Да подам ли тази доставка към склада?", [
      { text: "Отказ", style: "cancel" },
      {
        text: "Потвърди",
        onPress: () => {
          confirmMutation.mutate(id, {
            onSuccess: () => {
              setAcceptedLocally((current) => ({ ...current, [id]: false }));
              Alert.alert("Готово", "Доставката е потвърдена към склада.");
              listQuery.refetch();
              detailsQuery.refetch();
              setSelectedId(null);
            },
            onError: (error: any) => {
              const message = error?.response?.data?.message || "Неуспешно потвърждение.";
              Alert.alert("Грешка", message);
            },
          });
        },
      },
    ]);
  };

  const renderItem = ({ item }: { item: IncomingGoods }) => {
    const summary = buildSummary(item);
    return (
      <TouchableOpacity style={styles.card} onPress={() => setSelectedId(item.id)}>
        <View style={styles.cardTopRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.invoiceText}>Фактура #{item.invoice_number || "-"}</Text>
            <Text style={styles.supplierText}>{item.supplier_name || "Няма доставчик"}</Text>
            <Text style={styles.metaText}>{formatDate(item.invoice_date || item.created_at)}</Text>
          </View>
          <StatusBadge status={item.status} />
        </View>

        <View style={styles.cardMetricsRow}>
          <MetricCard label="Позиции" value={item.item_count || 0} tone="blue" />
          <MetricCard label="Липсва партида/срок" value={summary.missing.length} tone="yellow" />
        </View>

        <View style={styles.cardBottomRow}>
          <Text style={styles.metaAmount}>{formatCurrency(item.total_amount, item.currency || "EUR")}</Text>
          <Text style={styles.cardActionHint}>
            {summary.missing.length > 0 ? "Има липси за довършване" : "Готова за потвърждение"}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        data={items}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View style={styles.heroCard}>
            <Text style={styles.heroEyebrow}>Owner receiving workflow</Text>
            <Text style={styles.title}>Приемане на доставки</Text>
            <Text style={styles.subtitle}>
              Първо сканирай и прегледай фактурата. После тук маркираш, че стоката е приета физически и я потвърждаваш към склада.
            </Text>

            <View style={styles.heroMetricsRow}>
              <MetricCard label="Очакват действие" value={pendingCount} tone="yellow" />
              <MetricCard label="Потвърдени" value={confirmedCount} tone="green" />
            </View>

            <View style={styles.filterRow}>
              <TouchableOpacity
                onPress={() => setStatusFilter("pending")}
                style={[styles.filterButton, statusFilter === "pending" && styles.filterButtonActive]}
              >
                <Text style={[styles.filterText, statusFilter === "pending" && styles.filterTextActive]}>
                  Очакват действие
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setStatusFilter("confirmed")}
                style={[styles.filterButton, statusFilter === "confirmed" && styles.filterButtonActive]}
              >
                <Text style={[styles.filterText, statusFilter === "confirmed" && styles.filterTextActive]}>
                  Потвърдени
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Ionicons name="cube-outline" color={colors.textMuted} size={28} />
            <Text style={styles.emptyTitle}>Няма доставки за този филтър.</Text>
            <Text style={styles.emptyText}>След сканиране на нова фактура тя ще се появи тук.</Text>
          </View>
        }
        refreshControl={
          <RefreshControl
            refreshing={listQuery.isFetching}
            onRefresh={listQuery.refetch}
            tintColor={colors.primary}
          />
        }
      />

      <Modal visible={selectedId !== null} animationType="slide" onRequestClose={() => setSelectedId(null)}>
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Приемане на доставка</Text>
            <TouchableOpacity onPress={() => setSelectedId(null)}>
              <Text style={styles.closeText}>Затвори</Text>
            </TouchableOpacity>
          </View>

          {detailsQuery.isLoading ? (
            <LoadingState message="Зареждане на детайли..." />
          ) : detailsQuery.isError || !selected ? (
            <ErrorState onRetry={detailsQuery.refetch} />
          ) : (
            <ScrollView contentContainerStyle={styles.modalContent}>
              <View style={styles.summaryCard}>
                <View style={styles.summaryTopRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.modalLabel}>Доставка #{selected.id}</Text>
                    <Text style={styles.summarySupplier}>{selected.supplier_name || "Няма доставчик"}</Text>
                    <Text style={styles.summaryMeta}>
                      Фактура {selected.invoice_number || "-"} • {formatDate(selected.invoice_date || selected.created_at)}
                    </Text>
                  </View>
                  <StatusBadge status={selected.status} />
                </View>

                <View style={styles.heroMetricsRow}>
                  <MetricCard label="Общо" value={formatCurrency(selected.total_amount, selected.currency || "EUR")} tone="blue" />
                  <MetricCard label="Без партида/срок" value={selectedSummary.missing.length} tone="yellow" />
                  <MetricCard label="Готови редове" value={selectedSummary.ready.length} tone="green" />
                </View>
              </View>

              <View style={styles.sectionCard}>
                <Text style={styles.sectionTitle}>Какво проверяваш сега</Text>
                <View style={styles.checkRow}><Ionicons name="checkmark-circle-outline" size={18} color={colors.primary} /><Text style={styles.checkText}>1. Виж има ли липсващи партиди и срокове.</Text></View>
                <View style={styles.checkRow}><Ionicons name="checkmark-circle-outline" size={18} color={colors.primary} /><Text style={styles.checkText}>2. Маркирай, че стоката е приета физически.</Text></View>
                <View style={styles.checkRow}><Ionicons name="checkmark-circle-outline" size={18} color={colors.primary} /><Text style={styles.checkText}>3. Потвърди към склада, за да се обновят наличностите.</Text></View>
              </View>

              {selectedSummary.missing.length > 0 ? (
                <View style={[styles.sectionCard, styles.warningSection]}>
                  <Text style={styles.warningTitle}>Липсва партида или срок по {selectedSummary.missing.length} реда</Text>
                  <Text style={styles.warningBody}>
                    Това е естественият сигнал да върнеш документа в стъпката за втори документ / ръчно попълване преди окончателното потвърждение.
                  </Text>
                  <View style={styles.sectionList}>
                    {selectedSummary.missing.map((item) => (
                      <ItemCard key={item.id} item={item} currency={selected.currency || "EUR"} warning />
                    ))}
                  </View>
                </View>
              ) : (
                <View style={[styles.sectionCard, styles.successSection]}>
                  <Text style={styles.successTitle}>Няма критични липси</Text>
                  <Text style={styles.successBody}>Редовете са готови за физическо приемане и потвърждение към склада.</Text>
                </View>
              )}

              <View style={styles.sectionCard}>
                <Text style={styles.sectionTitle}>Редове готови за приемане</Text>
                <View style={styles.sectionList}>
                  {selectedSummary.ready.length === 0 ? (
                    <Text style={styles.emptyInline}>Все още няма редове с пълна партида и срок.</Text>
                  ) : (
                    selectedSummary.ready.map((item) => (
                      <ItemCard key={item.id} item={item} currency={selected.currency || "EUR"} />
                    ))
                  )}
                </View>
              </View>

              {selected.status === "pending" && (
                <View style={styles.actionCard}>
                  <Text style={styles.sectionTitle}>Действия</Text>
                  <TouchableOpacity
                    style={styles.secondaryButton}
                    onPress={() => {
                      if (selectedId !== null) {
                        setAcceptedLocally((current) => ({ ...current, [selectedId]: !current[selectedId] }));
                      }
                    }}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {canConfirm ? "Физически приета – готово" : "Маркирай като физически приета"}
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    disabled={!canConfirm || confirmMutation.isPending}
                    onPress={() => {
                      if (selectedId !== null) {
                        onConfirmDelivery(selectedId);
                      }
                    }}
                    style={[styles.primaryButton, (!canConfirm || confirmMutation.isPending) && styles.buttonDisabled]}
                  >
                    <Text style={styles.primaryButtonText}>
                      {confirmMutation.isPending ? "Потвърждаване..." : "Потвърди към склад"}
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  listContent: {
    padding: 16,
    gap: 12,
    paddingBottom: 24,
  },
  heroCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    padding: 16,
    gap: 14,
  },
  heroEyebrow: {
    color: colors.textMuted,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "700",
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 20,
  },
  heroMetricsRow: {
    flexDirection: "row",
    gap: 10,
    flexWrap: "wrap",
  },
  metricCard: {
    flex: 1,
    minWidth: 100,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  metricLabel: {
    color: colors.textMuted,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  metricValue: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
    marginTop: 4,
  },
  filterRow: {
    flexDirection: "row",
    gap: 8,
  },
  filterButton: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 11,
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
  },
  filterButtonActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  filterText: {
    color: colors.textMuted,
    fontWeight: "600",
    fontSize: 12,
  },
  filterTextActive: {
    color: colors.primary,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 14,
    gap: 12,
  },
  cardTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
  },
  invoiceText: {
    color: colors.textMuted,
    fontSize: 12,
  },
  supplierText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
    marginTop: 4,
  },
  cardMetricsRow: {
    flexDirection: "row",
    gap: 10,
  },
  cardBottomRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  metaText: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 4,
  },
  metaAmount: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  cardActionHint: {
    color: colors.textMuted,
    fontSize: 12,
  },
  statusBadge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    alignSelf: "flex-start",
  },
  statusText: {
    fontSize: 11,
    fontWeight: "700",
  },
  emptyWrap: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 28,
    gap: 8,
  },
  emptyTitle: {
    color: colors.text,
    fontWeight: "700",
  },
  emptyText: {
    color: colors.textMuted,
    textAlign: "center",
  },
  modalContainer: {
    flex: 1,
    backgroundColor: colors.background,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  modalTitle: {
    color: colors.text,
    fontWeight: "700",
    fontSize: 18,
  },
  closeText: {
    color: colors.primary,
    fontWeight: "700",
    fontSize: 13,
  },
  modalContent: {
    padding: 16,
    gap: 12,
    paddingBottom: 28,
  },
  summaryCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    padding: 14,
    gap: 14,
    backgroundColor: colors.surface,
  },
  summaryTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
  },
  modalLabel: {
    color: colors.textMuted,
    fontSize: 12,
  },
  summarySupplier: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
    marginTop: 4,
  },
  summaryMeta: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 4,
  },
  sectionCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 14,
    backgroundColor: colors.surface,
    gap: 10,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  checkText: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
    flex: 1,
  },
  warningSection: {
    borderColor: `${colors.warning}55`,
    backgroundColor: `${colors.warning}10`,
  },
  warningTitle: {
    color: colors.warning,
    fontSize: 15,
    fontWeight: "700",
  },
  warningBody: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 19,
  },
  successSection: {
    borderColor: `${colors.success}55`,
    backgroundColor: `${colors.success}10`,
  },
  successTitle: {
    color: colors.success,
    fontSize: 15,
    fontWeight: "700",
  },
  successBody: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 19,
  },
  sectionList: {
    gap: 10,
  },
  itemCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    backgroundColor: colors.surfaceAlt,
    padding: 12,
    flexDirection: "row",
    gap: 10,
  },
  itemCardWarning: {
    borderColor: `${colors.warning}55`,
    backgroundColor: `${colors.warning}14`,
  },
  itemName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  itemMeta: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 3,
  },
  itemAmount: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "700",
  },
  emptyInline: {
    color: colors.textMuted,
    fontSize: 13,
  },
  actionCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 14,
    backgroundColor: colors.surface,
    gap: 10,
  },
  secondaryButton: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center",
    paddingVertical: 13,
  },
  secondaryButtonText: {
    color: colors.text,
    fontWeight: "700",
  },
  primaryButton: {
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: "center",
    paddingVertical: 14,
  },
  primaryButtonText: {
    color: colors.text,
    fontWeight: "700",
    fontSize: 15,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
});
