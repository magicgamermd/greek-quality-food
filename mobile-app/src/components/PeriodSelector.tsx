import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { colors } from "../theme/colors";
import type { SalesPeriod } from "../types";

const PERIODS: { key: SalesPeriod; label: string }[] = [
  { key: "today", label: "Днес" },
  { key: "week", label: "Седмица" },
  { key: "month", label: "Месец" },
  { key: "custom", label: "По избор" },
];

interface PeriodSelectorProps {
  value: SalesPeriod;
  onChange: (p: SalesPeriod) => void;
}

export function PeriodSelector({ value, onChange }: PeriodSelectorProps) {
  return (
    <View style={styles.container}>
      {PERIODS.map((p) => {
        const isActive = value === p.key;
        return (
          <TouchableOpacity
            key={p.key}
            onPress={() => onChange(p.key)}
            style={[styles.tab, isActive && styles.tabActive]}
            activeOpacity={0.7}
          >
            <Text style={[styles.tabText, isActive && styles.tabTextActive]}>
              {p.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    backgroundColor: "#0d0d18",
    borderRadius: 14,
    padding: 4,
    borderWidth: 1,
    borderColor: colors.borderLight,
    marginBottom: 16,
    gap: 6,
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    alignItems: "center",
  },
  tabActive: {
    backgroundColor: colors.surfaceElevated,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 3,
  },
  tabText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: "400",
  },
  tabTextActive: {
    color: colors.text,
    fontWeight: "600",
  },
});
