import React from "react";
import { ActivityIndicator, Text, View } from "react-native";

import { colors } from "../theme/colors";

export function LoadingState({ message = "Зареждане..." }: { message?: string }) {
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.background,
        gap: 12,
      }}
    >
      <ActivityIndicator size="large" color={colors.primary} />
      <Text style={{ color: colors.textMuted }}>{message}</Text>
    </View>
  );
}
