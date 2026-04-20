import React from "react";
import { Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { colors } from "../theme/colors";

export function KpiCard({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: string;
  icon: keyof typeof Ionicons.glyphMap;
  tone: "primary" | "warning" | "success";
}) {
  const toneColor =
    tone === "primary"
      ? colors.primary
      : tone === "warning"
        ? colors.warning
        : colors.success;

  return (
    <View
      style={{
        flex: 1,
        minWidth: "47%",
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 14,
        padding: 14,
        gap: 8,
      }}
    >
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: 10,
          backgroundColor: `${toneColor}2A`,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name={icon} size={16} color={toneColor} />
      </View>

      <Text
        numberOfLines={1}
        style={{ color: colors.text, fontSize: 19, fontWeight: "700" }}
      >
        {value}
      </Text>
      <Text style={{ color: colors.textMuted, fontSize: 12 }}>{label}</Text>
    </View>
  );
}
