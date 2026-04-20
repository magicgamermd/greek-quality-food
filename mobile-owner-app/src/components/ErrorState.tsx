import React from "react";
import { Text, TouchableOpacity, View } from "react-native";

import { colors } from "../theme/colors";

export function ErrorState({
  message = "Възникна грешка при зареждане.",
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.background,
        paddingHorizontal: 20,
      }}
    >
      <Text style={{ color: colors.text, fontSize: 16, fontWeight: "700" }}>
        Неуспешно зареждане
      </Text>
      <Text style={{ color: colors.textMuted, marginTop: 8, textAlign: "center" }}>
        {message}
      </Text>
      {onRetry ? (
        <TouchableOpacity
          onPress={onRetry}
          style={{
            marginTop: 16,
            backgroundColor: colors.primary,
            borderRadius: 10,
            paddingHorizontal: 16,
            paddingVertical: 10,
          }}
        >
          <Text style={{ color: "white", fontWeight: "700" }}>Опитай пак</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
