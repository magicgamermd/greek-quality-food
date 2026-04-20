import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Modal,
  ScrollView,
  TextInput,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useOrders, useOrder } from "../hooks/useQueries";
import { useAuth } from "../hooks/useAuth";
import { StatusBadge } from "../components/StatusBadge";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ErrorView } from "../components/ErrorView";
import { formatCurrency, formatDate, formatDateTime } from "../utils/format";
import { colors } from "../theme/colors";
import type { Order, OrderStatus } from "../types";

const STATUS_FILTERS: { key: OrderStatus | "all"; label: string }[] = [
  { key: "all", label: "Всички" },
  { key: "pending", label: "Изчаква" },
  { key: "processing", label: "Обработва се" },
  { key: "fulfilled", label: "Изпълнена" },
  { key: "invoiced", label: "Фактурирана" },
  { key: "cancelled", label: "Отказана" },
];

// ─── Order Detail Modal ─────────────────────────────────────────────────────
function OrderDetailModal({
  orderId,
  onClose,
}: {
  orderId: number | null;
  onClose: () => void;
}) {
  const { data, isLoading, isError } = useOrder(orderId);

  return (
    <Modal
      visible={orderId !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={s.modalContainer}>
        {/* Header */}
        <View style={s.modalHeader}>
          <Text style={s.modalTitle}>Детайли на поръчка</Text>
          <TouchableOpacity
            onPress={onClose}
            style={s.modalCloseBtn}
            activeOpacity={0.7}
          >
            <Text style={s.modalCloseBtnText}>Затвори</Text>
          </TouchableOpacity>
        </View>

        {isLoading && <LoadingSpinner message="Зареждане..." />}
        {isError && <ErrorView message="Неуспешно зареждане на поръчката" />}
        {data && (
          <ScrollView contentContainerStyle={{ padding: 20 }}>
            {/* Order header info */}
            <View style={s.detailCard}>
              <View style={s.detailCardHeader}>
                <View>
                  <Text style={s.detailLabel}>Поръчка #{data.id}</Text>
                  <Text style={s.detailPartnerName}>
                    {data.partner?.name || "Партньор"}
                  </Text>
                </View>
                <StatusBadge status={data.status} />
              </View>

              <View style={{ gap: 8 }}>
                <InfoRow label="Дата" value={formatDateTime(data.order_date)} />
                {data.delivery_date && (
                  <InfoRow
                    label="Доставка"
                    value={formatDate(data.delivery_date)}
                  />
                )}
                <InfoRow
                  label="Источник"
                  value={
                    data.source === "comarch"
                      ? "Comarch"
                      : data.source === "web"
                        ? "Уеб"
                        : "Ръчна"
                  }
                />
                <InfoRow
                  label="Общо"
                  value={formatCurrency(data.total_amount)}
                  valueColor={colors.success}
                />
                {data.notes && <InfoRow label="Забележки" value={data.notes} />}
              </View>
            </View>

            {/* Order items */}
            {(data.items || []).length > 0 && (
              <>
                <Text style={s.sectionLabel}>Артикули</Text>
                {(data.items || []).map((item) => (
                  <View
                    key={item.id}
                    style={[s.detailCard, { marginBottom: 8 }]}
                  >
                    <View style={s.itemRow}>
                      <View style={{ flex: 1, marginRight: 12 }}>
                        <Text style={s.itemName} numberOfLines={2}>
                          {item.product?.name_bg ||
                            `Продукт #${item.product_id}`}
                        </Text>
                        <Text style={s.itemMeta}>
                          {item.quantity} {item.product?.unit || "бр."} x{" "}
                          {formatCurrency(item.unit_price)}
                        </Text>
                      </View>
                      <Text style={s.itemTotal}>
                        {formatCurrency(item.total_price)}
                      </Text>
                    </View>
                  </View>
                ))}
              </>
            )}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function InfoRow({
  label,
  value,
  valueColor = colors.textLight,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={s.infoRow}>
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={[s.infoValue, { color: valueColor }]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

// ─── Main Screen ─────────────────────────────────────────────────────────────
export function OrdersScreen() {
  const { user } = useAuth();
  const [statusFilter, setStatusFilter] = useState<OrderStatus | "all">("all");
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  // Hooks must always be called
  const params =
    statusFilter !== "all"
      ? { status: statusFilter, limit: 50 }
      : { limit: 50 };
  const { data, isLoading, isError, refetch, isFetching } = useOrders(params);

  // Only admin and warehouse users can view orders
  if (user?.role === "accountant" || user?.role === "readonly") {
    return (
      <SafeAreaView
        style={[s.container, s.noAccessContainer]}
        edges={["top", "left", "right"]}
      >
        <Ionicons
          name="lock-closed-outline"
          size={48}
          color={colors.textMuted}
        />
        <Text style={s.noAccessTitle}>Нямате достъп</Text>
        <Text style={s.noAccessSubtitle}>
          Тази секция е достъпна само за администратори и складове.
        </Text>
      </SafeAreaView>
    );
  }

  const filtered = (data || []).filter((o: Order) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      String(o.id).includes(q) || o.partner?.name?.toLowerCase().includes(q)
    );
  });

  if (isLoading) return <LoadingSpinner message="Зареждане на поръчки..." />;
  if (isError) return <ErrorView onRetry={refetch} />;

  const renderOrder = ({ item }: { item: Order }) => (
    <TouchableOpacity
      onPress={() => setSelectedOrderId(item.id)}
      activeOpacity={0.7}
    >
      <View style={s.orderCard}>
        <View style={{ flex: 1, marginRight: 12 }}>
          <Text style={s.orderPartner} numberOfLines={1}>
            {item.partner?.name || `Поръчка #${item.id}`}
          </Text>
          <Text style={s.orderMeta}>
            #{item.id} {"\u2022"} {formatDate(item.order_date)}
          </Text>
          {item.source !== "manual" && (
            <Text style={s.orderSource}>
              {item.source === "comarch" ? "Comarch" : "Уеб"}
            </Text>
          )}
        </View>
        <View style={{ alignItems: "flex-end", gap: 6 }}>
          <StatusBadge status={item.status} />
          <Text style={s.orderAmount}>{formatCurrency(item.total_amount)}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={s.container} edges={["top", "left", "right"]}>
      {/* Search & Filters */}
      <View style={s.headerArea}>
        {/* Search bar */}
        <View style={s.searchBar}>
          <Ionicons
            name="search-outline"
            size={16}
            color={colors.textSecondary}
            style={{ marginRight: 10 }}
          />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Търси по #ID или партньор..."
            placeholderTextColor={colors.textMuted}
            style={s.searchInput}
          />
          <Ionicons name="options-outline" size={16} color={colors.textMuted} />
        </View>

        {/* Status filter chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.filterTabsContainer}
        >
          {STATUS_FILTERS.map((f) => {
            const isActive = statusFilter === f.key;
            return (
              <TouchableOpacity
                key={f.key}
                onPress={() => setStatusFilter(f.key)}
                style={[s.filterTab, isActive && s.filterTabActive]}
                activeOpacity={0.7}
              >
                <Text
                  style={[s.filterTabText, isActive && s.filterTabTextActive]}
                >
                  {f.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderOrder}
        contentContainerStyle={s.listContent}
        ListEmptyComponent={
          <View style={s.emptyContainer}>
            <Ionicons
              name="receipt-outline"
              size={48}
              color={colors.textMuted}
            />
            <Text style={s.emptyText}>Няма намерени поръчки</Text>
          </View>
        }
        refreshControl={
          <RefreshControl
            refreshing={isFetching && !isLoading}
            onRefresh={refetch}
            tintColor={colors.accent}
            colors={[colors.accent]}
          />
        }
      />

      <OrderDetailModal
        orderId={selectedOrderId}
        onClose={() => setSelectedOrderId(null)}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  noAccessContainer: {
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  noAccessTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
    marginTop: 16,
  },
  noAccessSubtitle: {
    color: colors.textSecondary,
    fontSize: 14,
    marginTop: 8,
    textAlign: "center",
  },

  // Header area
  headerArea: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },

  // Search bar
  searchBar: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 14,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: colors.text,
    padding: 0,
  },

  // Filter tabs
  filterTabsContainer: {
    gap: 6,
    marginBottom: 16,
  },
  filterTab: {
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  filterTabActive: {
    backgroundColor: colors.accentLight,
    borderColor: "rgba(99,102,241,0.3)",
  },
  filterTabText: {
    fontSize: 13,
    fontWeight: "500",
    color: colors.textSecondary,
  },
  filterTabTextActive: {
    color: colors.accentAlt,
  },

  // List
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 16,
  },

  // Order cards
  orderCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingVertical: 14,
    paddingHorizontal: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 8,
  },
  orderPartner: {
    color: "#f3f4f6",
    fontWeight: "600",
    fontSize: 14,
  },
  orderMeta: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  orderSource: {
    color: colors.accent,
    fontSize: 11,
    marginTop: 2,
  },
  orderAmount: {
    color: colors.success,
    fontWeight: "700",
    fontSize: 14,
  },

  // Empty
  emptyContainer: {
    alignItems: "center",
    paddingTop: 60,
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: 15,
    marginTop: 12,
  },

  // ─── Modal styles ───────────────────────────────────────────────────
  modalContainer: {
    flex: 1,
    backgroundColor: colors.background,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalTitle: {
    color: colors.textLight,
    fontSize: 18,
    fontWeight: "700",
  },
  modalCloseBtn: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalCloseBtnText: {
    color: colors.textSecondary,
    fontSize: 13,
  },

  // Detail card
  detailCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.borderLight,
    marginBottom: 16,
  },
  detailCardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 12,
  },
  detailLabel: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  detailPartnerName: {
    color: colors.textLight,
    fontWeight: "700",
    fontSize: 16,
    marginTop: 2,
  },

  // Section label
  sectionLabel: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 10,
  },

  // Info row
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  infoLabel: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  infoValue: {
    color: colors.textLight,
    fontSize: 13,
    fontWeight: "600",
    maxWidth: "60%",
    textAlign: "right",
  },

  // Item row
  itemRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  itemName: {
    color: colors.textLight,
    fontWeight: "600",
    fontSize: 14,
  },
  itemMeta: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 4,
  },
  itemTotal: {
    color: colors.textLight,
    fontWeight: "700",
    fontSize: 15,
  },
});
