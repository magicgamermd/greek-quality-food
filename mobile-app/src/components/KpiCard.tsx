import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../theme/colors";

interface KpiCardProps {
  label: string;
  value: string | number;
  subtitle?: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  iconBg: string;
  valueColor?: string;
}

export function KpiCard({
  label,
  value,
  subtitle,
  icon,
  iconColor,
  iconBg,
  valueColor,
}: KpiCardProps) {
  return (
    <View style={styles.card}>
      {/* Icon row */}
      <View style={styles.iconRow}>
        <View style={[styles.iconWrap, { backgroundColor: iconBg }]}>
          <Ionicons name={icon} size={18} color={iconColor} />
        </View>
      </View>

      {/* Value */}
      <Text
        style={[styles.value, valueColor ? { color: valueColor } : undefined]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {value}
      </Text>

      {/* Label */}
      <Text style={styles.label}>{label}</Text>

      {/* Subtitle (optional) */}
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  iconRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 10,
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  value: {
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: -0.8,
    color: colors.text,
    marginBottom: 3,
  },
  label: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: "500",
    letterSpacing: 0.1,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 4,
  },
});
