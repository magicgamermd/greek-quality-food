import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  RefreshControl,
  ScrollView,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRoute } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { useInventory, useLowStock, useExpiring } from "../hooks/useQueries";
import { useAuth } from "../hooks/useAuth";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ErrorView } from "../components/ErrorView";
import {
  daysUntilExpiry,
  expiryColor,
  formatDate,
  formatUnit,
} from "../utils/format";
import { colors } from "../theme/colors";
import type { InventoryItem, ExpiringBatchItem } from "../types";

type FilterMode = "all" | "low" | "expiring";

// Determine product icon color based on stock status
function getProductIconColor(
  hasLowStock: boolean,
  hasSoonExpiring: boolean,
  totalStock: number,
): { bg: string; stroke: string } {
  if (totalStock === 0)
    return { bg: "rgba(107,114,128,0.1)", stroke: "#9ca3af" };
  if (hasLowStock) return { bg: "rgba(249,115,22,0.1)", stroke: colors.orange };
  if (hasSoonExpiring)
    return { bg: "rgba(234,179,8,0.1)", stroke: colors.yellow };
  return { bg: "rgba(34,197,94,0.1)", stroke: colors.success };
}

// Determine status badge
function getStatusBadge(
  hasLowStock: boolean,
  hasSoonExpiring: boolean,
  totalStock: number,
): { label: string; bg: string; color: string } {
  if (totalStock === 0)
    return { label: "Каталог", bg: "rgba(107,114,128,0.12)", color: "#9ca3af" };
  if (hasLowStock)
    return { label: "Нисък", bg: colors.dangerLight, color: colors.danger };
  if (hasSoonExpiring)
    return { label: "Изтичащ", bg: colors.yellowLight, color: colors.yellow };
  return { label: "ОК", bg: colors.successLight, color: colors.success };
}

export function InventoryScreen() {
  const route = useRoute();
  const initialFilter = (route.params as any)?.filter as FilterMode | undefined;
  const { user } = useAuth();
  const [filter, setFilter] = useState<FilterMode>(initialFilter || "all");
  const [search, setSearch] = useState("");

  const allQuery = useInventory();
  const lowQuery = useLowStock();
  const expiringQuery = useExpiring();

  if (user?.role === "accountant" || user?.role === "readonly") {
    return (
      <SafeAreaView
        style={[styles.container, styles.noAccessContainer]}
        edges={["top", "left", "right"]}
      >
        <Ionicons
          name="lock-closed-outline"
          size={48}
          color={colors.textMuted}
        />
        <Text style={styles.noAccessTitle}>Нямате достъп</Text>
        <Text style={styles.noAccessSubtitle}>
          Тази секция е достъпна само за администратори и складове.
        </Text>
      </SafeAreaView>
    );
  }

  const activeQuery =
    filter === "low"
      ? lowQuery
      : filter === "expiring"
        ? expiringQuery
        : allQuery;

  const { isLoading, isError, refetch, isFetching } = activeQuery;
  const rawData = activeQuery.data || [];

  const filtered = useMemo(() => {
    if (!search.trim()) return rawData;
    const q = search.toLowerCase();
    return rawData.filter(
      (item) =>
        (item.name_bg ?? "").toLowerCase().includes(q) ||
        (item.sku ?? "").toLowerCase().includes(q),
    );
  }, [rawData, search]);

  // Count badges for filter tabs
  const allCount = allQuery.data?.length ?? 0;
  const lowCount = lowQuery.data?.length ?? 0;
  const expiringCount = expiringQuery.data?.length ?? 0;

  if (isLoading) return <LoadingSpinner message="Зареждане на инвентар..." />;
  if (isError) return <ErrorView onRetry={refetch} />;

  const FILTERS: {
    key: FilterMode;
    label: string;
    count: number;
    countColor?: string;
  }[] = [
    { key: "all", label: "Всички", count: allCount },
    { key: "low", label: "Нисък", count: lowCount, countColor: colors.danger },
    {
      key: "expiring",
      label: "Изтичащ",
      count: expiringCount,
      countColor: colors.yellow,
    },
  ];

  const renderItem = ({ item }: { item: InventoryItem }) => {
    const product = item.product ?? item;
    const totalStock = parseFloat(
      String(item.total_stock ?? (item as any).total_quantity ?? 0),
    );
    const hasLowStock =
      totalStock < parseFloat(String(item.low_stock_threshold ?? 10));
    const soonExpiring = (item.batches || []).filter((b) => {
      const days = daysUntilExpiry(b.expiry_date);
      return days <= 30 && days >= 0;
    });
    const hasSoonExpiring = soonExpiring.length > 0;

    const iconColor = getProductIconColor(
      hasLowStock,
      hasSoonExpiring,
      totalStock,
    );
    const badge = getStatusBadge(hasLowStock, hasSoonExpiring, totalStock);

    return (
      <View style={[styles.card, hasLowStock && styles.cardLowStock]}>
        {/* Product icon */}
        <View style={[styles.productIcon, { backgroundColor: iconColor.bg }]}>
          <Ionicons name="cube-outline" size={22} color={iconColor.stroke} />
        </View>

        {/* Center info */}
        <View style={styles.productInfo}>
          <Text
            style={styles.productName}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {product?.name_bg || "Продукт"}
          </Text>
          <Text style={styles.productSku}>{product?.sku || "—"}</Text>
        </View>

        {/* Right side: stock + badge */}
        <View style={styles.productRight}>
          <Text
            style={[
              styles.productStock,
              hasLowStock && { color: colors.danger },
              hasSoonExpiring && !hasLowStock && { color: colors.yellow },
              totalStock === 0 && { color: "#9ca3af" },
            ]}
          >
            {totalStock} {product?.unit || "бр."}
          </Text>
          <View style={[styles.statusBadge, { backgroundColor: badge.bg }]}>
            <Text style={[styles.statusBadgeText, { color: badge.color }]}>
              {badge.label}
            </Text>
          </View>
        </View>
      </View>
    );
  };

  const renderExpiringItem = ({ item }: { item: ExpiringBatchItem }) => {
    const days = item.days_until_expiry;
    const urgencyColor = expiryColor(days);
    const urgencyBg =
      days <= 7
        ? colors.dangerLight
        : days <= 14
          ? colors.orangeLight
          : colors.yellowLight;
    const icon = days <= 7 ? "warning" : "time-outline";

    return (
      <View
        style={[
          styles.card,
          { borderLeftWidth: 3, borderLeftColor: urgencyColor },
        ]}
      >
        {/* Urgency icon */}
        <View style={[styles.productIcon, { backgroundColor: urgencyBg }]}>
          <Ionicons name={icon} size={22} color={urgencyColor} />
        </View>

        {/* Center: name, SKU, batch, expiry */}
        <View style={styles.productInfo}>
          <Text
            style={styles.productName}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {item.name_bg || "Продукт"}
          </Text>
          <Text style={styles.productSku}>{item.sku || "—"}</Text>
          <View style={styles.expiringMeta}>
            <View style={styles.batchPill}>
              <Text style={styles.batchPillText}>
                Партида: {item.batch_number}
              </Text>
            </View>
            <Text style={[styles.expiringDate, { color: urgencyColor }]}>
              {formatDate(item.expiry_date)}
            </Text>
          </View>
        </View>

        {/* Right: days + quantity */}
        <View style={styles.expiringRight}>
          <Text style={[styles.expiringDays, { color: urgencyColor }]}>
            {days <= 7 ? "⚠️" : "⏰"} {days} дни{days === 1 ? "" : ""}
          </Text>
          <Text style={styles.expiringQty}>
            {item.quantity} {formatUnit(item.unit)}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]}>
      <View style={styles.headerArea}>
        {/* Search Bar */}
        <View style={styles.searchBar}>
          <Ionicons
            name="search-outline"
            size={16}
            color={colors.textSecondary}
            style={{ marginRight: 10 }}
          />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Търси продукт..."
            placeholderTextColor={colors.textMuted}
            style={styles.searchInput}
          />
          <Ionicons name="options-outline" size={16} color={colors.textMuted} />
        </View>

        {/* Filter Tabs */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterTabsContainer}
        >
          {FILTERS.map((f) => {
            const isActive = filter === f.key;
            return (
              <TouchableOpacity
                key={f.key}
                onPress={() => setFilter(f.key)}
                style={[styles.filterTab, isActive && styles.filterTabActive]}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.filterTabText,
                    isActive && styles.filterTabTextActive,
                  ]}
                >
                  {f.label}
                </Text>
                <Text
                  style={[
                    styles.filterTabCount,
                    isActive && { color: colors.accent },
                    !isActive && f.countColor ? { color: f.countColor } : null,
                  ]}
                >
                  {f.count}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <FlatList
        data={filtered as any}
        keyExtractor={(item: any) =>
          filter === "expiring"
            ? String(item.batch_id)
            : String(item.product_id)
        }
        renderItem={
          filter === "expiring" ? (renderExpiringItem as any) : renderItem
        }
        contentContainerStyle={styles.listContent}
        removeClippedSubviews={true}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Ionicons name="cube-outline" size={48} color={colors.textMuted} />
            <Text style={styles.emptyText}>Няма намерени продукти</Text>
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
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
    fontSize: 18,
    fontWeight: "700",
    marginTop: 16,
  },
  noAccessSubtitle: {
    color: colors.textSecondary,
    fontSize: 14,
    marginTop: 8,
    textAlign: "center",
  },
  headerArea: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  // Search bar — matches mockup
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
  // Filter tabs — horizontal scroll
  filterTabsContainer: {
    gap: 6,
    marginBottom: 16,
  },
  filterTab: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    gap: 4,
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
  filterTabCount: {
    fontSize: 11,
    color: colors.textMuted,
  },
  // Product list
  listContent: {
    paddingHorizontal: 20,
    paddingTop: 0,
    paddingBottom: 16,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingVertical: 14,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginBottom: 8,
  },
  cardLowStock: {
    borderColor: "rgba(239,68,68,0.15)",
  },
  productIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  productInfo: {
    flex: 1,
    minWidth: 0,
  },
  productName: {
    fontSize: 14,
    fontWeight: "600",
    color: "#f3f4f6",
    letterSpacing: -0.2,
  },
  productSku: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 2,
    fontWeight: "500",
  },
  productRight: {
    alignItems: "flex-end",
  },
  productStock: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textLight,
    marginBottom: 4,
  },
  statusBadge: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 7,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  // Expiring batch cards
  expiringMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 6,
    flexWrap: "wrap",
  },
  batchPill: {
    backgroundColor: colors.border,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  batchPillText: {
    fontSize: 10,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  expiringDate: {
    fontSize: 11,
    fontWeight: "600",
  },
  expiringRight: {
    alignItems: "flex-end",
    minWidth: 60,
  },
  expiringDays: {
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 4,
  },
  expiringQty: {
    fontSize: 12,
    fontWeight: "500",
    color: colors.textSecondary,
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
});
