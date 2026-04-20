import React, { useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Platform,
  Alert,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  GestureHandlerRootView,
  Swipeable,
} from "react-native-gesture-handler";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import {
  useNotifications,
  useMarkNotificationRead,
  useReadAllNotifications,
  useDismissNotification,
} from "../hooks/useQueries";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ErrorView } from "../components/ErrorView";
import { colors } from "../theme/colors";
import type { AppNotification, NotificationType } from "../types";

// ─── Push Notifications setup ────────────────────────────────────────────────
try {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
} catch (_) {}

export async function registerForPushNotificationsAsync(): Promise<
  string | null
> {
  if (!Device.isDevice) return null;
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== "granted") return null;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Greek Foods Alerts",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#6c3dff",
    });
  }
  try {
    const token = await Notifications.getExpoPushTokenAsync();
    return token.data;
  } catch {
    return null;
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────
const NOTIF_CONFIG: Record<
  NotificationType,
  { icon: keyof typeof Ionicons.glyphMap; color: string; bg: string }
> = {
  low_stock: {
    icon: "warning-outline",
    color: "#f97316",
    bg: "rgba(249,115,22,0.15)",
  },
  expiring: {
    icon: "time-outline",
    color: "#eab308",
    bg: "rgba(234,179,8,0.15)",
  },
  payment: {
    icon: "card-outline",
    color: "#22c55e",
    bg: "rgba(34,197,94,0.15)",
  },
  order: {
    icon: "cube-outline",
    color: "#3b82f6",
    bg: "rgba(59,130,246,0.15)",
  },
  system: {
    icon: "settings-outline",
    color: "#6b7280",
    bg: "rgba(107,114,128,0.12)",
  },
};

const DELETE_WIDTH = 80;

// ─── Swipeable row ───────────────────────────────────────────────────────────
function SwipeableRow({
  item,
  config,
  onPress,
  onLongPress,
  onDelete,
}: {
  item: AppNotification;
  config: { icon: keyof typeof Ionicons.glyphMap; color: string; bg: string };
  onPress: () => void;
  onLongPress: () => void;
  onDelete: () => void;
}) {
  const swipeableRef = useRef<Swipeable>(null);

  // Close swipe when item read-status changes
  useEffect(() => {
    swipeableRef.current?.close();
  }, [item.read]);

  const renderRightActions = () => (
    <TouchableOpacity
      onPress={() => {
        swipeableRef.current?.close();
        onDelete();
      }}
      activeOpacity={0.7}
      style={s.deleteAction}
    >
      <Ionicons name="trash-outline" size={20} color="#fff" />
      <Text style={s.deleteLabel}>Изтрий</Text>
    </TouchableOpacity>
  );

  return (
    <View style={s.swipeContainer}>
      <Swipeable
        ref={swipeableRef}
        renderRightActions={renderRightActions}
        rightThreshold={DELETE_WIDTH}
        overshootRight={false}
        onSwipeableOpen={(direction) => {
          if (direction === "right") onDelete();
        }}
      >
        <TouchableOpacity
          onPress={onPress}
          onLongPress={onLongPress}
          activeOpacity={0.7}
          delayLongPress={400}
        >
          <View
            style={[
              s.card,
              item.read ? s.cardRead : s.cardUnread,
              !item.read && { borderColor: config.color + "26" },
            ]}
          >
            {/* Dot / Check indicator */}
            {!item.read ? (
              <View
                style={[
                  s.dot,
                  { backgroundColor: config.color, shadowColor: config.color },
                ]}
              />
            ) : (
              <View style={s.checkWrap}>
                <Ionicons name="checkmark" size={8} color="#4b5563" />
              </View>
            )}

            {/* Icon circle */}
            <View
              style={[
                s.iconCircle,
                {
                  backgroundColor: item.read
                    ? "rgba(107,114,128,0.08)"
                    : config.bg,
                },
                item.read && { opacity: 0.5 },
              ]}
            >
              <Ionicons
                name={config.icon}
                size={18}
                color={item.read ? "#6b7280" : config.color}
              />
            </View>

            {/* Content */}
            <View style={s.body}>
              <Text
                style={[s.title, item.read && s.titleRead]}
                numberOfLines={2}
              >
                {item.title === "Ниска наличност"
                  ? `Ниска наличност — ${item.message.split("—")[1]?.trim() || item.message}`
                  : item.title === "Изтичащ срок"
                    ? `Партида изтича — ${item.message.split("—")[1]?.trim() || item.message}`
                    : item.message}
              </Text>
              <Text style={s.sub} numberOfLines={1}>
                {item.title || "Известие"}
              </Text>
            </View>

            {/* Time */}
            <Text style={s.time}>
              {new Date(item.created_at).toLocaleTimeString("bg-BG", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </Text>
          </View>
        </TouchableOpacity>
      </Swipeable>
    </View>
  );
}

// ─── Main Screen ─────────────────────────────────────────────────────────────
export function NotificationsScreen() {
  const navigation = useNavigation();
  const { data, isLoading, isError, refetch, isFetching } = useNotifications();
  const markRead = useMarkNotificationRead();
  const readAll = useReadAllNotifications();
  const dismiss = useDismissNotification();
  const notificationListener = useRef<{ remove: () => void } | undefined>(
    undefined,
  );
  const responseListener = useRef<{ remove: () => void } | undefined>(
    undefined,
  );

  useEffect(() => {
    try {
      registerForPushNotificationsAsync().catch(() => {});
      notificationListener.current =
        Notifications.addNotificationReceivedListener(() => refetch());
      responseListener.current =
        Notifications.addNotificationResponseReceivedListener(() => {});
    } catch (_) {}
    return () => {
      notificationListener.current?.remove();
      responseListener.current?.remove();
    };
  }, []);

  const handlePress = useCallback(
    (item: AppNotification) => {
      if (!item.read) markRead.mutate(item.id);
    },
    [markRead],
  );

  const handleLongPress = useCallback(
    (item: AppNotification) => {
      const options = item.read
        ? [
            {
              text: "Изтрий",
              style: "destructive" as const,
              onPress: () => dismiss.mutate(item.id),
            },
            { text: "Отказ", style: "cancel" as const },
          ]
        : [
            {
              text: "Маркирай прочетено",
              onPress: () => markRead.mutate(item.id),
            },
            {
              text: "Изтрий",
              style: "destructive" as const,
              onPress: () => dismiss.mutate(item.id),
            },
            { text: "Отказ", style: "cancel" as const },
          ];
      Alert.alert(item.title || "Известие", item.message, options);
    },
    [markRead, dismiss],
  );

  const handleMarkAllRead = useCallback(() => {
    if (!data) return;
    const unreadIds = data
      .filter((n: AppNotification) => !n.read)
      .map((n: AppNotification) => n.id);
    if (unreadIds.length > 0) readAll.mutate(unreadIds);
  }, [data, readAll]);

  if (isLoading) return <LoadingSpinner message="Зареждане на известия..." />;
  if (isError) return <ErrorView onRetry={refetch} />;

  const notifications = data || [];
  const unread = notifications.filter((n: AppNotification) => !n.read);
  const read = notifications.filter((n: AppNotification) => n.read);
  const unreadCount = unread.length;

  // Combine into sections
  const sections: (
    | AppNotification
    | { type: "section"; label: string }
    | { type: "hint" }
  )[] = [];
  if (unread.length > 0) {
    sections.push({ type: "section", label: "НЕПРОЧЕТЕНИ" } as any);
    sections.push(...unread);
    sections.push({ type: "hint" } as any);
  }
  if (read.length > 0) {
    sections.push({ type: "section", label: "ПРОЧЕТЕНИ" } as any);
    sections.push(...read);
  }

  const renderItem = ({ item }: { item: any }) => {
    // Section header
    if (item.type === "section") {
      return <Text style={s.sectionLabel}>{item.label}</Text>;
    }
    // Swipe hint
    if (item.type === "hint") {
      return (
        <View style={s.hintRow}>
          <View style={s.hintLine} />
          <Text style={s.hintText}>ПЛЪЗНИ ЗА ОТХВЪРЛЯНЕ</Text>
          <View style={s.hintLine} />
        </View>
      );
    }
    // Notification
    const config =
      NOTIF_CONFIG[item.type as NotificationType] || NOTIF_CONFIG.system;
    return (
      <SwipeableRow
        item={item}
        config={config}
        onPress={() => handlePress(item)}
        onLongPress={() => handleLongPress(item)}
        onDelete={() => dismiss.mutate(item.id)}
      />
    );
  };

  return (
    <GestureHandlerRootView style={s.container}>
      <SafeAreaView style={s.container} edges={["top", "left", "right"]}>
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={s.backBtn}
          >
            <Ionicons name="chevron-back" size={20} color="#6366f1" />
            <Text style={s.backText}>Назад</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>Известия</Text>
          <View style={{ width: 60 }} />
        </View>

        {/* Unread Banner */}
        {unreadCount > 0 && (
          <View style={s.banner}>
            <View style={s.bannerLeft}>
              <View style={s.bannerDot} />
              <Text style={s.bannerText}>
                {unreadCount} непрочетени известия
              </Text>
            </View>
            <TouchableOpacity
              onPress={handleMarkAllRead}
              disabled={readAll.isPending}
              style={s.readAllBtn}
            >
              <Text style={s.readAllText}>
                {readAll.isPending ? "..." : "Прочети всички"}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        <FlatList
          data={sections}
          keyExtractor={(item: any, idx) =>
            item.type === "section"
              ? `section-${item.label}`
              : item.type === "hint"
                ? `hint-${idx}`
                : item.id
          }
          renderItem={renderItem}
          contentContainerStyle={s.list}
          ListEmptyComponent={
            <View style={s.empty}>
              <Ionicons
                name="notifications-off-outline"
                size={48}
                color="#4b5563"
              />
              <Text style={s.emptyTitle}>Няма известия</Text>
              <Text style={s.emptySub}>
                Ще получите известия при нисък запас{"\n"}или изтичащи продукти
              </Text>
            </View>
          }
          refreshControl={
            <RefreshControl
              refreshing={isFetching && !isLoading}
              onRefresh={refetch}
              tintColor="#6366f1"
              colors={["#6366f1"]}
            />
          }
        />
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0a0a14",
  },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 14,
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    width: 60,
  },
  backText: {
    color: "#6366f1",
    fontSize: 16,
    fontWeight: "600",
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#ffffff",
    letterSpacing: -0.4,
  },

  // Banner
  banner: {
    backgroundColor: "rgba(99,102,241,0.1)",
    borderWidth: 1,
    borderColor: "rgba(99,102,241,0.2)",
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginHorizontal: 20,
    marginBottom: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  bannerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  bannerDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#6366f1",
    shadowColor: "#6366f1",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 3,
  },
  bannerText: {
    fontSize: 13.5,
    fontWeight: "600",
    color: "#818cf8",
    letterSpacing: -0.1,
  },
  readAllBtn: {
    backgroundColor: "rgba(99,102,241,0.15)",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 8,
  },
  readAllText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#6366f1",
  },

  // Section label
  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#4b5563",
    textTransform: "uppercase",
    letterSpacing: 0.7,
    marginBottom: 8,
    paddingLeft: 2,
  },

  // Swipe hint
  hintRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 8,
    marginBottom: 4,
  },
  hintLine: {
    width: 40,
    height: 1,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: 1,
  },
  hintText: {
    fontSize: 10,
    color: "#374151",
    fontWeight: "500",
    letterSpacing: 0.5,
  },

  // List
  list: {
    paddingHorizontal: 20,
    paddingBottom: 16,
  },

  // Swipe container
  swipeContainer: {
    marginBottom: 8,
    overflow: "hidden",
    borderRadius: 14,
  },
  deleteAction: {
    width: DELETE_WIDTH,
    backgroundColor: "#ef4444",
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
  },
  deleteLabel: {
    color: "#fff",
    fontSize: 10,
    marginTop: 2,
    fontWeight: "500",
  },

  // Card
  card: {
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  cardUnread: {
    backgroundColor: "#141420",
    borderColor: "rgba(249,115,22,0.15)",
  },
  cardRead: {
    backgroundColor: "#12121e",
    borderColor: "rgba(255,255,255,0.07)",
    opacity: 0.55,
  },

  // Dot / Check
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 4,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 6,
    elevation: 3,
  },
  checkWrap: {
    width: 8,
    height: 8,
    marginTop: 4,
    justifyContent: "center",
    alignItems: "center",
  },

  // Icon circle
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },

  // Body
  body: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 13.5,
    fontWeight: "600",
    color: "#e5e7eb",
    letterSpacing: -0.1,
    lineHeight: 19,
    marginBottom: 3,
  },
  titleRead: {
    fontWeight: "400",
    color: "#6b7280",
  },
  sub: {
    fontSize: 12,
    color: "#6b7280",
    lineHeight: 16,
  },

  // Time
  time: {
    fontSize: 11,
    color: "#4b5563",
    fontWeight: "500",
    marginTop: 2,
  },

  // Empty
  empty: {
    alignItems: "center",
    paddingTop: 80,
  },
  emptyTitle: {
    color: "#e5e7eb",
    fontSize: 16,
    fontWeight: "600",
    marginTop: 16,
  },
  emptySub: {
    color: "#6b7280",
    fontSize: 13,
    marginTop: 8,
    textAlign: "center",
    lineHeight: 18,
  },
});
