import React from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  StyleSheet,
  TouchableOpacity,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import {
  useDashboardKPI,
  useOrders,
  useIncomingGoodsByDate,
} from "../hooks/useQueries";
import { KpiCard } from "../components/KpiCard";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ErrorView } from "../components/ErrorView";
import { useAuth } from "../hooks/useAuth";
import { formatCurrency, formatDateTime } from "../utils/format";
import { colors } from "../theme/colors";

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Добро утро";
  if (hour < 18) return "Добър ден";
  return "Добър вечер";
}

interface ActivityItem {
  id: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  iconBg: string;
  title: string;
  subtitle: string;
  time: string;
}

function RecentActivityItem({ item }: { item: ActivityItem }) {
  return (
    <View style={styles.activityItem}>
      <View style={[styles.activityIcon, { backgroundColor: item.iconBg }]}>
        <Ionicons name={item.icon} size={18} color={item.iconColor} />
      </View>
      <View style={styles.activityContent}>
        <Text style={styles.activityTitle} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={styles.activitySubtitle} numberOfLines={1}>
          {item.subtitle}
        </Text>
      </View>
      <Text style={styles.activityTime}>{item.time}</Text>
    </View>
  );
}

export function DashboardScreen() {
  const navigation = useNavigation();
  const { user } = useAuth();
  const { data, isLoading, isError, refetch, isFetching } = useDashboardKPI();
  const { data: recentOrders } = useOrders({ limit: 5 });

  if (isLoading) return <LoadingSpinner message="Зареждане на панела..." />;
  if (isError) return <ErrorView onRetry={refetch} />;
  if (!data) return null;

  const kpi = data;

  // Build recent activity from orders
  const activities: ActivityItem[] = (recentOrders || [])
    .slice(0, 4)
    .map((order: any) => ({
      id: String(order.id),
      icon:
        order.status === "fulfilled"
          ? ("checkmark-circle-outline" as const)
          : order.status === "pending"
            ? ("time-outline" as const)
            : ("receipt-outline" as const),
      iconColor:
        order.status === "fulfilled"
          ? "#10B981"
          : order.status === "pending"
            ? "#F59E0B"
            : colors.accent,
      iconBg:
        order.status === "fulfilled"
          ? "#10B98118"
          : order.status === "pending"
            ? "#F59E0B18"
            : colors.accentLight,
      title: `Поръчка #${order.id}`,
      subtitle: order.partner?.name || `${formatCurrency(order.total_amount)}`,
      time: order.order_date
        ? new Date(order.order_date).toLocaleTimeString("bg-BG", {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "",
    }));

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 100 }}
        refreshControl={
          <RefreshControl
            refreshing={isFetching && !isLoading}
            onRefresh={refetch}
            tintColor={colors.accent}
            colors={[colors.accent]}
          />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.greetingSmall}>{getGreeting()}</Text>
          <Text style={styles.greetingMain}>
            {getGreeting()}, {user?.name || "Потребител"} 👋
          </Text>
          <Text style={styles.headerSub}>Greek Foods Warehouse</Text>
        </View>

        {/* KPI Grid — 2x2 */}
        <View style={styles.kpiGrid}>
          <View style={styles.kpiItem}>
            <KpiCard
              label="Поръчки днес"
              value={kpi.today_orders}
              subtitle={`Приход: ${formatCurrency(kpi.today_revenue)}`}
              icon="bag-outline"
              iconColor={colors.info}
              iconBg={colors.infoLight}
            />
          </View>
          <View style={styles.kpiItem}>
            <KpiCard
              label="Стойност"
              value={formatCurrency(kpi.total_stock_value)}
              icon="cash-outline"
              iconColor={colors.purple}
              iconBg={colors.purpleLight}
            />
          </View>
          <View style={styles.kpiItem}>
            <KpiCard
              label="Нисък запас"
              value={kpi.low_stock_count}
              subtitle="продукта"
              icon="warning-outline"
              iconColor={colors.orange}
              iconBg={colors.orangeLight}
              valueColor={colors.orange}
            />
          </View>
          <View style={styles.kpiItem}>
            <KpiCard
              label="Неплатени"
              value={formatCurrency(kpi.pending_payments_amount)}
              subtitle={`${kpi.pending_payments} фактури`}
              icon="checkmark-outline"
              iconColor={colors.success}
              iconBg={colors.successLight}
            />
          </View>
        </View>

        {/* Expiring soon alert */}
        {kpi.expiring_soon_count > 0 && (
          <TouchableOpacity
            onPress={() =>
              (navigation as any).navigate("Inventory", { filter: "expiring" })
            }
            activeOpacity={0.7}
          >
            <View style={styles.alertBanner}>
              <View style={styles.alertIconWrap}>
                <Ionicons
                  name="warning-outline"
                  size={16}
                  color={colors.warning}
                />
              </View>
              <Text style={styles.alertText}>
                {kpi.expiring_soon_count} партиди изтичат скоро
              </Text>
              <View style={styles.alertBadge}>
                <Text style={styles.alertBadgeText}>Виж →</Text>
              </View>
            </View>
          </TouchableOpacity>
        )}

        {/* Recent Activity */}
        {activities.length > 0 && (
          <View style={styles.activitySection}>
            <Text style={styles.sectionTitle}>ПОСЛЕДНА АКТИВНОСТ</Text>
            <View style={styles.activityList}>
              {activities.map((item) => (
                <RecentActivityItem key={item.id} item={item} />
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },

  // Header
  header: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 16,
  },
  greetingSmall: {
    fontSize: 13,
    color: colors.textSecondary,
    fontWeight: "500",
    letterSpacing: 0.1,
    marginBottom: 4,
  },
  greetingMain: {
    fontSize: 26,
    fontWeight: "700",
    letterSpacing: -0.6,
    color: colors.text,
    marginBottom: 2,
  },
  headerSub: {
    fontSize: 14,
    color: colors.textMuted,
    fontWeight: "400",
    letterSpacing: -0.1,
  },

  // KPI Grid
  kpiGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 20,
    gap: 12,
    marginBottom: 14,
  },
  kpiItem: {
    flexBasis: "47%",
    flexGrow: 1,
  },

  // Alert Banner
  alertBanner: {
    marginHorizontal: 20,
    marginBottom: 18,
    backgroundColor: "rgba(251,191,36,0.12)",
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.25)",
    gap: 10,
  },
  alertIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "rgba(251,191,36,0.2)",
    justifyContent: "center",
    alignItems: "center",
  },
  alertText: {
    flex: 1,
    color: colors.warning,
    fontSize: 13.5,
    fontWeight: "500",
    letterSpacing: -0.1,
  },
  alertBadge: {
    backgroundColor: "rgba(251,191,36,0.25)",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  alertBadgeText: {
    color: colors.warning,
    fontSize: 11,
    fontWeight: "700",
  },

  // Activity Section
  activitySection: {
    paddingHorizontal: 20,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 10,
  },
  activityList: {
    gap: 8,
  },
  activityItem: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  activityIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  activityContent: {
    flex: 1,
  },
  activityTitle: {
    fontSize: 13.5,
    fontWeight: "600",
    color: colors.textLight,
    letterSpacing: -0.1,
  },
  activitySubtitle: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
  activityTime: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: "500",
  },
});
