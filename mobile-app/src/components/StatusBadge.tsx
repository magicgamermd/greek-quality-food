import React from "react";
import { View, Text, StyleSheet } from "react-native";
import type { OrderStatus } from "../types";

const STATUS_CONFIG: Record<
  OrderStatus,
  { label: string; bg: string; text: string }
> = {
  pending: { label: "Изчаква", bg: "#F59E0B20", text: "#F59E0B" },
  processing: { label: "Обработва се", bg: "#3B82F620", text: "#3B82F6" },
  fulfilled: { label: "Изпълнена", bg: "#10B98120", text: "#10B981" },
  cancelled: { label: "Отказана", bg: "#EF444420", text: "#EF4444" },
  invoiced: { label: "Фактурирана", bg: "#6366F120", text: "#6366F1" },
};

interface StatusBadgeProps {
  status: OrderStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] || {
    label: status,
    bg: "#9090B820",
    text: "#9090B8",
  };
  return (
    <View style={[styles.badge, { backgroundColor: config.bg }]}>
      <Text style={[styles.badgeText, { color: config.text }]}>
        {config.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 7,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "600",
  },
});
