import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useAuth } from "../hooks/useAuth";
import { colors } from "../theme/colors";

export function LoginScreen() {
  const { login } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!email.trim() || !password) {
      Alert.alert("Невалидни данни", "Въведете имейл и парола.");
      return;
    }

    setLoading(true);
    try {
      await login(email.trim().toLowerCase(), password);
    } catch (error: any) {
      const message =
        error?.response?.data?.message || "Неуспешен вход. Проверете данните.";
      Alert.alert("Грешка при вход", message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.container}
    >
      <View style={styles.content}>
        <View style={styles.brandWrap}>
          <View style={styles.brandIcon}>
            <Ionicons
              name="business-outline"
              size={30}
              color={colors.primary}
            />
          </View>
          <Text style={styles.title}>МЕРТ-М Owner</Text>
          <Text style={styles.subtitle}>Отделно приложение за собственик</Text>
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.label}>Имейл</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="owner@mertm.bg"
            placeholderTextColor={colors.textMuted}
            keyboardType="email-address"
            autoCapitalize="none"
            style={styles.input}
          />
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.label}>Парола</Text>
          <View style={styles.passwordWrap}>
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor={colors.textMuted}
              secureTextEntry={!showPassword}
              style={styles.passwordInput}
            />
            <TouchableOpacity
              onPress={() => setShowPassword((v) => !v)}
              hitSlop={8}
            >
              <Ionicons
                name={showPassword ? "eye-outline" : "eye-off-outline"}
                color={colors.textMuted}
                size={18}
              />
            </TouchableOpacity>
          </View>
        </View>

        <TouchableOpacity
          onPress={handleLogin}
          disabled={loading}
          style={[styles.loginButton, loading && { opacity: 0.75 }]}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.loginButtonText}>Вход в owner app</Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  content: {
    gap: 16,
  },
  brandWrap: {
    alignItems: "center",
    marginBottom: 20,
    gap: 8,
  },
  brandIcon: {
    width: 68,
    height: 68,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    color: colors.text,
    fontSize: 27,
    fontWeight: "700",
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 13,
  },
  formGroup: {
    gap: 6,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    color: colors.text,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 15,
  },
  passwordWrap: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
  },
  passwordInput: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    paddingVertical: 13,
  },
  loginButton: {
    marginTop: 6,
    backgroundColor: colors.primary,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 13,
  },
  loginButtonText: {
    color: "white",
    fontSize: 15,
    fontWeight: "700",
  },
});
