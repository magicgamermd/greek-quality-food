import React, { useMemo, useState } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BarChart } from "react-native-gifted-charts";

import { useAuth } from "../hooks/useAuth";
import { useDashboardKpi, useSalesAnalytics } from "../hooks/useOwnerQueries";
import { KpiCard } from "../components/KpiCard";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { colors } from "../theme/colors";
import { formatCurrency } from "../utils/format";
import type { SalesPeriod } from "../types";

const PERIODS: SalesPeriod[] = ["today", "week", "month"];
const PERIOD_LABELS: Record<SalesPeriod, string> = {
  today: "Днес",
  week: "Седмица",
  month: "Месец",
};

export function OwnerDashboardScreen() {
  const { user, logout } = useAuth();
  const [period, setPeriod] = useState<SalesPeriod>("week");

  const kpiQuery = useDashboardKpi();
  const salesQuery = useSalesAnalytics(period);

  const isLoading = kpiQuery.isLoading || salesQuery.isLoading;
  const hasError = kpiQuery.isError || salesQuery.isError;

  const chartData = useMemo(() => {
    return (salesQuery.data?.series || []).map((point) => ({
      value: Number(point.total_amount || 0),
      label: point.period,
      frontColor: colors.primary,
    }));
  }, [salesQuery.data?.series]);

  if (isLoading) {
    return <LoadingState message="Зареждане на owner analytics..." />;
  }

  if (hasError || !kpiQuery.data || !salesQuery.data) {
    return (
      <ErrorState
        onRetry={() => {
          kpiQuery.refetch();
          salesQuery.refetch();
        }}
      />
    );
  }

  const kpi = kpiQuery.data;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={kpiQuery.isFetching || salesQuery.isFetching}
            onRefresh={() => {
              kpiQuery.refetch();
              salesQuery.refetch();
            }}
            tintColor={colors.primary}
          />
        }
      >
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.title}>Owner Analytics</Text>
            <Text style={styles.subtitle}>
              Здравей, {user?.name || "Собственик"}
            </Text>
          </View>

          <TouchableOpacity onPress={logout} style={styles.logoutButton}>
            <Text style={styles.logoutText}>Изход</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.kpiGrid}>
          <KpiCard
            label="Приход днес"
            value={formatCurrency(kpi.today_revenue)}
            icon="cash-outline"
            tone="primary"
          />
          <KpiCard
            label="Поръчки днес"
            value={String(kpi.today_orders)}
            icon="receipt-outline"
            tone="primary"
          />
          <KpiCard
            label="Нисък запас"
            value={String(kpi.low_stock_count)}
            icon="warning-outline"
            tone="warning"
          />
          <KpiCard
            label="Неплатени фактури"
            value={String(kpi.pending_payments)}
            icon="checkmark-done-outline"
            tone="success"
          />
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Приходи по период</Text>

          <View style={styles.periodSwitchRow}>
            {PERIODS.map((option) => {
              const active = option === period;
              return (
                <TouchableOpacity
                  key={option}
                  onPress={() => setPeriod(option)}
                  style={[
                    styles.periodButton,
                    active && { backgroundColor: colors.primarySoft },
                  ]}
                >
                  <Text
                    style={[
                      styles.periodButtonText,
                      active && { color: colors.primary },
                    ]}
                  >
                    {PERIOD_LABELS[option]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {chartData.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <BarChart
                data={chartData}
                barWidth={28}
                spacing={20}
                roundedTop
                roundedBottom
                hideRules
                noOfSections={4}
                xAxisThickness={0}
                yAxisThickness={0}
                yAxisTextStyle={{ color: colors.textMuted, fontSize: 11 }}
                xAxisLabelTextStyle={{ color: colors.textMuted, fontSize: 10 }}
                maxValue={Math.max(...chartData.map((item) => item.value), 100) * 1.2}
              />
            </ScrollView>
          ) : (
            <Text style={styles.emptyText}>Няма продажби за избрания период.</Text>
          )}

          <View style={styles.summaryRow}>
            <View>
              <Text style={styles.summaryLabel}>Общ приход</Text>
              <Text style={styles.summaryValue}>
                {formatCurrency(salesQuery.data.total_revenue)}
              </Text>
            </View>
            <View>
              <Text style={styles.summaryLabel}>Общо поръчки</Text>
              <Text style={styles.summaryValue}>{salesQuery.data.total_orders}</Text>
            </View>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Топ продукти</Text>
          {salesQuery.data.top_products.length === 0 ? (
            <Text style={styles.emptyText}>Няма налични данни.</Text>
          ) : (
            salesQuery.data.top_products.slice(0, 5).map((product, index) => (
              <View key={product.product_id} style={styles.productRow}>
                <Text style={styles.productRank}>#{index + 1}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.productName} numberOfLines={1}>
                    {product.product_name}
                  </Text>
                  <Text style={styles.productSubtext}>
                    {product.total_sold} {product.unit}
                  </Text>
                </View>
                <Text style={styles.productAmount}>
                  {formatCurrency(product.total_amount)}
                </Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 16,
    paddingBottom: 24,
    gap: 14,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "700",
  },
  subtitle: {
    color: colors.textMuted,
    marginTop: 2,
  },
  logoutButton: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.surface,
  },
  logoutText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "700",
  },
  kpiGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 14,
    gap: 12,
  },
  cardTitle: {
    color: colors.text,
    fontWeight: "700",
    fontSize: 16,
  },
  periodSwitchRow: {
    flexDirection: "row",
    gap: 8,
  },
  periodButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 8,
    alignItems: "center",
  },
  periodButtonText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  summaryLabel: {
    color: colors.textMuted,
    fontSize: 12,
  },
  summaryValue: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
    marginTop: 2,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 13,
  },
  productRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 10,
  },
  productRank: {
    color: colors.primary,
    width: 32,
    fontWeight: "700",
  },
  productName: {
    color: colors.text,
    fontWeight: "600",
  },
  productSubtext: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  productAmount: {
    color: colors.text,
    fontWeight: "700",
  },
});
