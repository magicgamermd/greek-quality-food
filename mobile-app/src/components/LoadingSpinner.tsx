import React, { useEffect, useRef } from "react";
import {
  View,
  ActivityIndicator,
  Text,
  StyleSheet,
  Animated,
  FlatList,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../theme/colors";

interface LoadingSpinnerProps {
  message?: string;
  skeleton?: boolean;
}

function SkeletonCard() {
  const opacity = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.4,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    ).start();
  }, [opacity]);

  return (
    <Animated.View style={[styles.skeletonCard, { opacity }]}>
      <View style={[styles.skeletonLine, styles.skeletonLineWide]} />
      <View style={[styles.skeletonLine, styles.skeletonLineHalf]} />
      <View style={[styles.skeletonLine, styles.skeletonLineWide]} />
      <View style={[styles.skeletonLine, styles.skeletonLineHalf]} />
    </Animated.View>
  );
}

export function LoadingSpinner({
  message,
  skeleton = false,
}: LoadingSpinnerProps) {
  if (skeleton) {
    return (
      <View style={styles.skeletonContainer}>
        <FlatList
          data={[1, 2, 3]}
          renderItem={() => <SkeletonCard />}
          keyExtractor={(_, i) => String(i)}
          scrollEnabled={false}
          contentContainerStyle={{ padding: 16 }}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={colors.accent} />
      {message ? <Text style={styles.message}>{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.background,
    padding: 24,
  },
  message: {
    color: colors.textSecondary,
    marginTop: 16,
    fontSize: 14,
    fontWeight: "500",
  },
  skeletonContainer: {
    flex: 1,
    width: "100%",
    backgroundColor: colors.background,
  },
  skeletonCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  skeletonLine: {
    height: 12,
    backgroundColor: colors.border,
    borderRadius: 6,
    marginBottom: 12,
  },
  skeletonLineWide: {
    width: "100%",
  },
  skeletonLineHalf: {
    width: "60%",
  },
});
