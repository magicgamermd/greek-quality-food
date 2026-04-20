import React, { useState } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Dimensions,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { BarChart } from "react-native-gifted-charts";
import { useSalesAnalytics } from "../hooks/useQueries";
import { PeriodSelector } from "../components/PeriodSelector";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ErrorView } from "../components/ErrorView";
import { useAuth } from "../hooks/useAuth";
import { formatCurrency } from "../utils/format";
import { colors } from "../theme/colors";
import type { SalesPeriod } from "../types";

const SCREEN_WIDTH = Dimensions.get("window").width;

// Period label map for chart badge
const PERIOD_LABELS: Record<SalesPeriod, string> = {
  today: "Днес",
  week: "Седмица",
  month: "Месец",
  custom: "По избор",
};

export function SalesScreen() {
  const { user } = useAuth();

  // Hooks must always be called — move all hooks before any early return
  const [period, setPeriod] = useState<SalesPeriod>("week");
  const { data, isLoading, isError, refetch, isFetching } =
    useSalesAnalytics(period);

  // Only admin and warehouse users can view sales
  if (user?.role === "accountant" || user?.role === "readonly") {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.accessDenied}>
          <Ionicons
            name="lock-closed-outline"
            size={48}
            color={colors.textMuted}
          />
          <Text style={styles.accessDeniedTitle}>Нямате достъп</Text>
          <Text style={styles.accessDeniedText}>
            Тази секция е достъпна само за администратори и складове.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (isLoading) return <LoadingSpinner message="Зареждане на продажби..." />;
  if (isError) return <ErrorView onRetry={refetch} />;
  if (!data) return null;

  const sales = data;

  // Prepare bar chart data
  const barData = (sales.series || []).map((s) => ({
    value: s.total_amount,
    label: s.period,
    frontColor: colors.accent,
    gradientColor: colors.purple,
    topLabelComponent: () => (
      <Text style={styles.barTopLabel}>{s.order_count}</Text>
    ),
  }));

  // Decorative faded bars for empty chart state
  const emptyBars = [40, 70, 50, 90, 60, 80, 45];

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        style={styles.flex1}
        contentContainerStyle={styles.scrollContent}
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
          <Text style={styles.headerTitle}>Продажби</Text>
          <Text style={styles.headerSubtitle}>Статистика и приходи</Text>
        </View>

        <PeriodSelector value={period} onChange={setPeriod} />

        {/* Stats Row */}
        <View style={styles.statsRow}>
          {/* Total Revenue Card */}
          <View style={styles.statCard}>
            <View style={styles.statCardHeader}>
              <View
                style={[
                  styles.statIconCircle,
                  { backgroundColor: colors.purpleLight },
                ]}
              >
                <Ionicons name="cash-outline" size={18} color={colors.purple} />
              </View>
              <Text style={styles.statLabel}>Общ приход</Text>
            </View>
            <Text style={styles.statValue}>
              {formatCurrency(sales.total_revenue)}
            </Text>
            <Text style={styles.statChange}>
              <Ionicons
                name="trending-up-outline"
                size={12}
                color={colors.success}
              />{" "}
              за периода
            </Text>
          </View>

          {/* Orders Card */}
          <View style={styles.statCard}>
            <View style={styles.statCardHeader}>
              <View
                style={[
                  styles.statIconCircle,
                  { backgroundColor: colors.accentLight },
                ]}
              >
                <Ionicons name="bag-outline" size={18} color={colors.accent} />
              </View>
              <Text style={styles.statLabel}>Поръчки</Text>
            </View>
            <Text style={styles.statValue}>{sales.total_orders}</Text>
            <Text style={styles.statChange}>
              <Ionicons
                name="trending-up-outline"
                size={12}
                color={colors.success}
              />{" "}
              за периода
            </Text>
          </View>
        </View>

        {/* Chart Section */}
        <View style={styles.chartCard}>
          <View style={styles.chartHeader}>
            <Text style={styles.chartTitle}>График приходи</Text>
            <View style={styles.chartPeriodBadge}>
              <Text style={styles.chartPeriodText}>
                {PERIOD_LABELS[period]}
              </Text>
            </View>
          </View>

          {barData.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <BarChart
                data={barData}
                width={Math.max(SCREEN_WIDTH - 80, barData.length * 60)}
                height={200}
                barWidth={40}
                spacing={16}
                roundedTop
                roundedBottom
                hideRules
                xAxisThickness={0}
                yAxisThickness={0}
                yAxisTextStyle={{ color: colors.textSecondary, fontSize: 10 }}
                noOfSections={4}
                maxValue={Math.max(...barData.map((d) => d.value), 100) * 1.2}
                isAnimated
                animationDuration={800}
                backgroundColor="transparent"
                xAxisLabelTextStyle={{
                  color: colors.textSecondary,
                  fontSize: 9,
                  width: 40,
                  textAlign: "center",
                }}
              />
            </ScrollView>
          ) : (
            <View style={styles.emptyChartContainer}>
              {/* Decorative faded bars */}
              <View style={styles.emptyBarsRow}>
                {emptyBars.map((h, i) => (
                  <View key={i} style={styles.emptyBarWrapper}>
                    <View
                      style={[
                        styles.emptyBar,
                        {
                          height: h,
                          backgroundColor: colors.accentLight,
                          opacity: 0.4,
                        },
                      ]}
                    />
                  </View>
                ))}
              </View>
              <Text style={styles.emptyChartText}>
                Няма данни за избрания период
              </Text>
            </View>
          )}
        </View>

        {/* Top Products Section */}
        <View style={styles.topProductsHeader}>
          <Text style={styles.topProductsTitle}>Топ продукти</Text>
        </View>

        {(sales.top_products || []).length === 0 ? (
          <View style={styles.emptyProductsCard}>
            <Ionicons
              name="trophy-outline"
              size={36}
              color={colors.textMuted}
            />
            <Text style={styles.emptyProductsText}>Няма данни</Text>
          </View>
        ) : (
          (sales.top_products || []).map((product, index) => (
            <View key={product.product_id} style={styles.productCard}>
              <View style={styles.productRow}>
                <View
                  style={[
                    styles.productRank,
                    {
                      backgroundColor:
                        index === 0
                          ? colors.accentLight
                          : index === 1
                            ? colors.purpleLight
                            : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.productRankText,
                      {
                        color:
                          index === 0
                            ? colors.accentAlt
                            : index === 1
                              ? colors.purple
                              : colors.textSecondary,
                      },
                    ]}
                  >
                    #{index + 1}
                  </Text>
                </View>
                <View style={styles.productInfo}>
                  <Text
                    style={styles.productName}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {product.product_name}
                  </Text>
                  <Text style={styles.productSold}>
                    {product.total_sold} {product.unit} продадени
                  </Text>
                </View>
                <Text style={styles.productAmount}>
                  {formatCurrency(product.total_amount)}
                </Text>
              </View>
            </View>
          ))
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
  flex1: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  // ── Header ─────────────────────────────────────────────────────────────────
  header: {
    paddingTop: 16,
    paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 26,
    fontWeight: "700",
    color: colors.text,
  },
  headerSubtitle: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2,
  },
  // ── Access denied ──────────────────────────────────────────────────────────
  accessDenied: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  accessDeniedTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
    marginTop: 16,
  },
  accessDeniedText: {
    color: colors.textSecondary,
    fontSize: 14,
    marginTop: 8,
    textAlign: "center",
  },
  // ── Stats Row ──────────────────────────────────────────────────────────────
  statsRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 16,
  },
  statCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  statCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
  },
  statIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 8,
  },
  statLabel: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: "500",
  },
  statValue: {
    fontSize: 24,
    fontWeight: "700",
    color: colors.text,
    marginBottom: 4,
  },
  statChange: {
    fontSize: 11,
    color: colors.success,
    fontWeight: "500",
  },
  // ── Chart Section ──────────────────────────────────────────────────────────
  chartCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.borderLight,
    marginBottom: 16,
  },
  chartHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  chartTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.text,
  },
  chartPeriodBadge: {
    backgroundColor: colors.accentLight,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chartPeriodText: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.accentAlt,
  },
  barTopLabel: {
    color: colors.textSecondary,
    fontSize: 10,
    marginBottom: 4,
  },
  // ── Empty chart ────────────────────────────────────────────────────────────
  emptyChartContainer: {
    alignItems: "center",
    paddingVertical: 16,
  },
  emptyBarsRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "center",
    height: 100,
    gap: 8,
    marginBottom: 16,
  },
  emptyBarWrapper: {
    justifyContent: "flex-end",
  },
  emptyBar: {
    width: 24,
    borderRadius: 6,
  },
  emptyChartText: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  // ── Top Products ───────────────────────────────────────────────────────────
  topProductsHeader: {
    marginBottom: 12,
  },
  topProductsTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.text,
  },
  emptyProductsCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyProductsText: {
    color: colors.textSecondary,
    fontSize: 13,
    marginTop: 10,
  },
  productCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  productRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  productRank: {
    width: 32,
    height: 32,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  productRankText: {
    fontWeight: "700",
    fontSize: 12,
  },
  productInfo: {
    flex: 1,
  },
  productName: {
    color: colors.text,
    fontWeight: "600",
    fontSize: 14,
  },
  productSold: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  productAmount: {
    color: colors.accentAlt,
    fontWeight: "700",
    fontSize: 14,
  },
});
