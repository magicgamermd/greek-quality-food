import React, { useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { useDailyReport, useMonthlyReport } from "../hooks/useQueries";
import { Card } from "../components/Card";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ErrorView } from "../components/ErrorView";
import { formatCurrency, formatDate } from "../utils/format";
import { colors } from "../theme/colors";

type ReportTab = "daily" | "monthly";

const MONTHS = [
  "Яну",
  "Фев",
  "Мар",
  "Апр",
  "Май",
  "Юни",
  "Юли",
  "Авг",
  "Сеп",
  "Окт",
  "Ное",
  "Дек",
];

function DailyReportView() {
  const today = new Date().toISOString().split("T")[0];
  const { data, isLoading, isError, refetch, isFetching } =
    useDailyReport(today);

  if (isLoading)
    return <LoadingSpinner message="Зареждане на дневен отчет..." />;
  if (isError)
    return <ErrorView onRetry={refetch} message="Неуспешно зареждане" />;
  if (!data) return null;

  const r = data;

  return (
    <ScrollView
      contentContainerStyle={{ padding: 16 }}
      refreshControl={
        <RefreshControl
          refreshing={isFetching && !isLoading}
          onRefresh={refetch}
          tintColor="#6c3dff"
          colors={["#6c3dff"]}
        />
      }
    >
      {/* Date header */}
      <View
        style={{
          backgroundColor: "#6c3dff20",
          borderRadius: 14,
          padding: 16,
          marginBottom: 16,
          borderWidth: 1,
          borderColor: "#6c3dff40",
          flexDirection: "row",
          alignItems: "center",
        }}
      >
        <Ionicons
          name="calendar-outline"
          size={24}
          color={colors.accent}
          style={{ marginRight: 12 }}
        />
        <View>
          <Text style={{ color: "#9090b8", fontSize: 12 }}>Дневен отчет</Text>
          <Text style={{ color: "#f0f0ff", fontSize: 18, fontWeight: "700" }}>
            {formatDate(r.date)}
          </Text>
        </View>
      </View>

      {/* Stats */}
      <View style={{ flexDirection: "row", gap: 10, marginBottom: 10 }}>
        <Card style={{ flex: 1 }}>
          <Text style={{ color: "#9090b8", fontSize: 11, marginBottom: 4 }}>
            Поръчки
          </Text>
          <Text style={{ color: "#f0f0ff", fontSize: 22, fontWeight: "700" }}>
            {r.total_orders}
          </Text>
        </Card>
        <Card style={{ flex: 1 }}>
          <Text style={{ color: "#9090b8", fontSize: 11, marginBottom: 4 }}>
            Приход
          </Text>
          <Text style={{ color: "#22c55e", fontSize: 22, fontWeight: "700" }}>
            {formatCurrency(r.total_revenue)}
          </Text>
        </Card>
      </View>

      <View style={{ flexDirection: "row", gap: 10, marginBottom: 10 }}>
        <Card style={{ flex: 1 }}>
          <Text style={{ color: "#9090b8", fontSize: 11, marginBottom: 4 }}>
            Продадени артикули
          </Text>
          <Text style={{ color: "#f0f0ff", fontSize: 22, fontWeight: "700" }}>
            {r.total_items_sold}
          </Text>
        </Card>
        <Card style={{ flex: 1 }}>
          <Text style={{ color: "#9090b8", fontSize: 11, marginBottom: 4 }}>
            Нови доставки
          </Text>
          <Text style={{ color: "#3b82f6", fontSize: 22, fontWeight: "700" }}>
            {r.new_stock_received}
          </Text>
        </Card>
      </View>

      <View style={{ flexDirection: "row", gap: 10 }}>
        <Card style={{ flex: 1 }}>
          <Text style={{ color: "#9090b8", fontSize: 11, marginBottom: 4 }}>
            Събрани плащания
          </Text>
          <Text style={{ color: "#6c3dff", fontSize: 22, fontWeight: "700" }}>
            {formatCurrency(r.payments_collected)}
          </Text>
        </Card>
        <Card style={{ flex: 1 }}>
          <Text style={{ color: "#9090b8", fontSize: 11, marginBottom: 4 }}>
            Сигнали нисък запас
          </Text>
          <Text
            style={{
              color: r.low_stock_alerts > 0 ? "#f59e0b" : "#22c55e",
              fontSize: 22,
              fontWeight: "700",
            }}
          >
            {r.low_stock_alerts}
          </Text>
        </Card>
      </View>
    </ScrollView>
  );
}

function MonthlyReportView() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const { data, isLoading, isError, refetch, isFetching } = useMonthlyReport(
    year,
    month,
  );

  const prevMonth = () => {
    if (month === 1) {
      setMonth(12);
      setYear((y) => y - 1);
    } else {
      setMonth((m) => m - 1);
    }
  };
  const nextMonth = () => {
    const n = new Date();
    if (
      year > n.getFullYear() ||
      (year === n.getFullYear() && month >= n.getMonth() + 1)
    )
      return;
    if (month === 12) {
      setMonth(1);
      setYear((y) => y + 1);
    } else {
      setMonth((m) => m + 1);
    }
  };

  if (isLoading)
    return <LoadingSpinner message="Зареждане на месечен отчет..." />;
  if (isError)
    return <ErrorView onRetry={refetch} message="Неуспешно зареждане" />;
  if (!data) return null;

  const r = data;

  return (
    <ScrollView
      contentContainerStyle={{ padding: 16 }}
      refreshControl={
        <RefreshControl
          refreshing={isFetching && !isLoading}
          onRefresh={refetch}
          tintColor="#6c3dff"
          colors={["#6c3dff"]}
        />
      }
    >
      {/* Month picker */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          backgroundColor: "#1a1a2e",
          borderRadius: 14,
          padding: 16,
          marginBottom: 16,
          borderWidth: 1,
          borderColor: "#2d2d4e",
        }}
      >
        <TouchableOpacity onPress={prevMonth} style={{ padding: 8 }}>
          <Ionicons name="chevron-back" size={20} color={colors.accent} />
        </TouchableOpacity>
        <View style={{ alignItems: "center" }}>
          <Text style={{ color: "#9090b8", fontSize: 12 }}>Месечен отчет</Text>
          <Text style={{ color: "#f0f0ff", fontSize: 18, fontWeight: "700" }}>
            {MONTHS[month - 1]} {year}
          </Text>
        </View>
        <TouchableOpacity onPress={nextMonth} style={{ padding: 8 }}>
          <Ionicons name="chevron-forward" size={20} color={colors.accent} />
        </TouchableOpacity>
      </View>

      {/* Stats */}
      <View style={{ flexDirection: "row", gap: 10, marginBottom: 10 }}>
        <Card style={{ flex: 1 }}>
          <Text style={{ color: "#9090b8", fontSize: 11, marginBottom: 4 }}>
            Поръчки
          </Text>
          <Text style={{ color: "#f0f0ff", fontSize: 22, fontWeight: "700" }}>
            {r.total_orders}
          </Text>
        </Card>
        <Card style={{ flex: 1 }}>
          <Text style={{ color: "#9090b8", fontSize: 11, marginBottom: 4 }}>
            Общ приход
          </Text>
          <Text style={{ color: "#22c55e", fontSize: 22, fontWeight: "700" }}>
            {formatCurrency(r.total_revenue)}
          </Text>
        </Card>
      </View>

      <View style={{ flexDirection: "row", gap: 10, marginBottom: 16 }}>
        <Card style={{ flex: 1 }}>
          <Text style={{ color: "#9090b8", fontSize: 11, marginBottom: 4 }}>
            Средно на ден
          </Text>
          <Text style={{ color: "#6c3dff", fontSize: 22, fontWeight: "700" }}>
            {formatCurrency(r.avg_daily_revenue)}
          </Text>
        </Card>
        <Card style={{ flex: 1 }}>
          <Text style={{ color: "#9090b8", fontSize: 11, marginBottom: 4 }}>
            Плащания събрани
          </Text>
          <Text style={{ color: "#3b82f6", fontSize: 22, fontWeight: "700" }}>
            {formatCurrency(r.payments_collected)}
          </Text>
        </Card>
      </View>

      {/* Top products for month */}
      {(r.top_products || []).length > 0 && (
        <>
          <Text
            style={{
              color: "#6c3dff",
              fontSize: 12,
              fontWeight: "600",
              letterSpacing: 1,
              textTransform: "uppercase",
              marginBottom: 12,
            }}
          >
            Топ продукти за месеца
          </Text>
          {r.top_products.slice(0, 5).map((p, i) => (
            <Card key={p.product_id} style={{ marginBottom: 8 }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                }}
              >
                <Text
                  style={{
                    color: i < 3 ? "#6c3dff" : "#9090b8",
                    fontWeight: "700",
                    fontSize: 18,
                    width: 32,
                  }}
                >
                  #{i + 1}
                </Text>
                <View style={{ flex: 1 }}>
                  <Text
                    style={{
                      color: "#f0f0ff",
                      fontWeight: "600",
                      fontSize: 14,
                    }}
                    numberOfLines={1}
                  >
                    {p.product_name}
                  </Text>
                  <Text style={{ color: "#9090b8", fontSize: 12 }}>
                    {p.total_sold} {p.unit} продадени
                  </Text>
                </View>
                <Text style={{ color: "#22c55e", fontWeight: "700" }}>
                  {formatCurrency(p.total_amount)}
                </Text>
              </View>
            </Card>
          ))}
        </>
      )}
    </ScrollView>
  );
}

export function ReportsScreen() {
  const navigation = useNavigation();
  const [tab, setTab] = useState<ReportTab>("daily");

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background }}
      edges={["top", "left", "right"]}
    >
      {/* Header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: 12,
          borderBottomWidth: 1,
          borderBottomColor: "#252540",
        }}
      >
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={{
            minHeight: 44,
            minWidth: 44,
            justifyContent: "center",
            alignItems: "center",
            marginRight: 12,
          }}
          activeOpacity={0.7}
        >
          <Ionicons name="chevron-back" size={24} color="#f0f0ff" />
        </TouchableOpacity>
        <Text style={{ color: "#f0f0ff", fontSize: 18, fontWeight: "700" }}>
          Отчети
        </Text>
      </View>

      {/* Tab selector */}
      <View
        style={{
          flexDirection: "row",
          backgroundColor: colors.surfaceElevated,
          margin: 16,
          marginBottom: 0,
          borderRadius: 14,
          padding: 4,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      >
        <TouchableOpacity
          onPress={() => setTab("daily")}
          style={{
            flex: 1,
            paddingVertical: 10,
            borderRadius: 10,
            alignItems: "center",
            flexDirection: "row",
            justifyContent: "center",
            gap: 6,
            backgroundColor: tab === "daily" ? colors.accent : "transparent",
          }}
        >
          <Ionicons
            name="today-outline"
            size={16}
            color={tab === "daily" ? "#fff" : colors.textSecondary}
          />
          <Text
            style={{
              color: tab === "daily" ? "#fff" : colors.textSecondary,
              fontWeight: tab === "daily" ? "700" : "400",
              fontSize: 14,
            }}
          >
            Дневен
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setTab("monthly")}
          style={{
            flex: 1,
            paddingVertical: 10,
            borderRadius: 10,
            alignItems: "center",
            flexDirection: "row",
            justifyContent: "center",
            gap: 6,
            backgroundColor: tab === "monthly" ? colors.accent : "transparent",
          }}
        >
          <Ionicons
            name="calendar-outline"
            size={16}
            color={tab === "monthly" ? "#fff" : colors.textSecondary}
          />
          <Text
            style={{
              color: tab === "monthly" ? "#fff" : colors.textSecondary,
              fontWeight: tab === "monthly" ? "700" : "400",
              fontSize: 14,
            }}
          >
            Месечен
          </Text>
        </TouchableOpacity>
      </View>

      {tab === "daily" ? <DailyReportView /> : <MonthlyReportView />}
    </SafeAreaView>
  );
}
