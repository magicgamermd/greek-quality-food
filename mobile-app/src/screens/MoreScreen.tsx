import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { useAuth } from "../hooks/useAuth";
import { useNotifications } from "../hooks/useQueries";
import { colors } from "../theme/colors";

interface MenuItem {
  label: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  iconBg: string;
  screen?: string;
  action?: () => void;
  badge?: number;
}

function MenuRow({
  item,
  onPress,
  isLast,
}: {
  item: MenuItem;
  onPress: () => void;
  isLast: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={styles.menuRow}
      activeOpacity={0.6}
    >
      <View style={[styles.menuIcon, { backgroundColor: item.iconBg }]}>
        <Ionicons name={item.icon} size={18} color={item.iconColor} />
      </View>
      <View style={styles.menuContent}>
        <View style={[styles.menuTextRow, !isLast && styles.menuSeparator]}>
          <View style={styles.menuTextGroup}>
            <Text style={styles.menuLabel}>{item.label}</Text>
            <Text style={styles.menuSubtitle}>{item.subtitle}</Text>
          </View>
          <View style={styles.menuRight}>
            {item.badge != null && item.badge > 0 ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>
                  {item.badge > 99 ? "99+" : item.badge}
                </Text>
              </View>
            ) : null}
            <Ionicons
              name="chevron-forward"
              size={16}
              color={colors.textMuted}
            />
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

export function MoreScreen() {
  const { user, logout } = useAuth();
  const navigation = useNavigation<any>();
  const { data: notifications } = useNotifications();
  const unreadCount = (notifications || []).filter((n: any) => !n.read).length;

  const handleLogout = () => {
    Alert.alert("Изход", "Сигурни ли сте, че искате да излезете?", [
      { text: "Отказ", style: "cancel" },
      { text: "Изход", style: "destructive", onPress: logout },
    ]);
  };

  const userInitial = (user?.name || "П").charAt(0).toUpperCase();

  const roleLabelBg =
    user?.role === "admin"
      ? "Администратор"
      : user?.role === "warehouse"
        ? "Складов работник"
        : user?.role === "accountant"
          ? "Счетоводител"
          : "Потребител";

  const roleBadge =
    user?.role === "admin"
      ? "ADMIN"
      : user?.role === "warehouse"
        ? "WAREHOUSE"
        : user?.role === "accountant"
          ? "ACCOUNTANT"
          : "USER";

  const menuItems: MenuItem[] = [
    {
      label: "Инвентар",
      subtitle: "Наличности и партиди",
      icon: "cube-outline",
      iconColor: colors.success,
      iconBg: colors.successLight,
      screen: "Inventory",
    },
    {
      label: "Поръчки",
      subtitle: "Управление на поръчки",
      icon: "document-text-outline",
      iconColor: colors.accent,
      iconBg: colors.accentLight,
      screen: "Orders",
    },
    {
      label: "Входящи доставки",
      subtitle: "Приемане на стока",
      icon: "car-outline",
      iconColor: colors.info,
      iconBg: colors.infoLight,
      screen: "IncomingGoods",
    },
    {
      label: "Отчети",
      subtitle: "Статистика и анализи",
      icon: "bar-chart-outline",
      iconColor: colors.purple,
      iconBg: colors.purpleLight,
      screen: "Reports",
    },
    {
      label: "Известия",
      subtitle: "Нотификации и известия",
      icon: "notifications-outline",
      iconColor: colors.warning,
      iconBg: colors.warningLight,
      screen: "Notifications",
      badge: unreadCount,
    },
  ];

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Header */}
        <Text style={styles.pageTitle}>Още</Text>

        {/* User Card */}
        <View style={styles.userCard}>
          <View style={styles.userCardRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{userInitial}</Text>
            </View>
            <View style={styles.userInfo}>
              <Text style={styles.userName}>{user?.name || "Потребител"}</Text>
              <Text style={styles.userMeta}>
                {roleLabelBg} {user?.email ? `\u00B7 ${user.email}` : ""}
              </Text>
            </View>
            <View style={styles.roleBadge}>
              <Text style={styles.roleBadgeText}>{roleBadge}</Text>
            </View>
          </View>
        </View>

        {/* Menu Section */}
        <Text style={styles.sectionTitle}>УПРАВЛЕНИЕ</Text>
        <View style={styles.menuSection}>
          {menuItems.map((item, index) => (
            <MenuRow
              key={item.label}
              item={item}
              isLast={index === menuItems.length - 1}
              onPress={() => {
                if (item.screen) {
                  navigation.navigate(item.screen);
                } else if (item.action) {
                  item.action();
                }
              }}
            />
          ))}
        </View>

        {/* Logout */}
        <TouchableOpacity
          onPress={handleLogout}
          style={styles.logoutButton}
          activeOpacity={0.6}
        >
          <Ionicons name="log-out-outline" size={20} color={colors.danger} />
          <Text style={styles.logoutText}>Изход от профила</Text>
        </TouchableOpacity>

        <Text style={styles.versionText}>Greek Foods v1.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  pageTitle: {
    fontSize: 26,
    fontWeight: "700",
    color: colors.text,
    paddingTop: 16,
    paddingBottom: 18,
  },
  // ── User Card ──────────────────────────────────────────────────────────────
  userCard: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: 18,
    padding: 18,
    paddingHorizontal: 16,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: "rgba(99,102,241,0.2)",
  },
  userCardRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 14,
  },
  avatarText: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "700",
  },
  userInfo: {
    flex: 1,
  },
  userName: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  userMeta: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  roleBadge: {
    backgroundColor: "rgba(99,102,241,0.15)",
    borderWidth: 1,
    borderColor: "rgba(99,102,241,0.25)",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  roleBadgeText: {
    color: colors.accentAlt,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  // ── Menu Section ───────────────────────────────────────────────────────────
  sectionTitle: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textMuted,
    letterSpacing: 0.8,
    marginBottom: 10,
    marginLeft: 4,
  },
  menuSection: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.borderLight,
    overflow: "hidden",
    marginBottom: 24,
  },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 16,
  },
  menuIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 14,
  },
  menuContent: {
    flex: 1,
  },
  menuTextRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingRight: 16,
  },
  menuSeparator: {
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.05)",
  },
  menuTextGroup: {
    flex: 1,
  },
  menuLabel: {
    color: colors.textLight,
    fontSize: 14.5,
    fontWeight: "600",
  },
  menuSubtitle: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 1,
  },
  menuRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  badge: {
    backgroundColor: colors.danger,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 6,
  },
  badgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700",
  },
  // ── Logout ─────────────────────────────────────────────────────────────────
  logoutButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(239,68,68,0.1)",
    borderRadius: 14,
    paddingVertical: 14,
    gap: 10,
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.2)",
  },
  logoutText: {
    color: colors.danger,
    fontSize: 15,
    fontWeight: "600",
  },
  versionText: {
    color: colors.textDim,
    fontSize: 12,
    textAlign: "center",
    marginTop: 24,
  },
});
