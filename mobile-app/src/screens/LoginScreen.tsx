import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Switch,
  ActivityIndicator,
  Alert,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useAuth } from "../hooks/useAuth";
import { colors } from "../theme/colors";

export function LoginScreen() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [emailFocused, setEmailFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);

  const handleLogin = async () => {
    if (!email.trim() || !password) {
      Alert.alert("Грешка", "Моля, въведете имейл и парола.");
      return;
    }
    setLoading(true);
    try {
      await login(email.trim().toLowerCase(), password, remember);
    } catch (err: any) {
      const msg =
        err?.response?.data?.message ||
        "Невалидни данни за вход. Проверете имейла и паролата.";
      Alert.alert("Грешка при вход", msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.container}
    >
      {/* Background gradient overlays */}
      <View style={styles.bgGradient1} />
      <View style={styles.bgGradient2} />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Logo */}
        <View style={styles.logoWrap}>
          <LinearGradient
            colors={[colors.accentDark, colors.accent, colors.accentAlt]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.logoCircle}
          >
            <Ionicons name="home-outline" size={40} color="#fff" />
          </LinearGradient>
          <View style={styles.logoText}>
            <Text style={styles.appTitle}>Greek Foods</Text>
            <Text style={styles.appSubtitle}>Warehouse Management</Text>
          </View>
        </View>

        {/* Email field */}
        <View style={styles.formGroup}>
          <Text style={styles.formLabel}>Имейл</Text>
          <View
            style={[styles.formInput, emailFocused && styles.formInputFocused]}
          >
            <Ionicons
              name="mail-outline"
              size={18}
              color={emailFocused ? colors.accent : colors.textMuted}
              style={styles.inputIcon}
            />
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="example@greekfoods.bg"
              placeholderTextColor={colors.textMuted}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              style={styles.inputText}
              onFocus={() => setEmailFocused(true)}
              onBlur={() => setEmailFocused(false)}
            />
          </View>
        </View>

        {/* Password field */}
        <View style={styles.formGroup}>
          <Text style={styles.formLabel}>Парола</Text>
          <View
            style={[
              styles.formInput,
              passwordFocused && styles.formInputFocused,
            ]}
          >
            <Ionicons
              name="lock-closed-outline"
              size={18}
              color={passwordFocused ? colors.accent : colors.textMuted}
              style={styles.inputIcon}
            />
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor={colors.textMuted}
              secureTextEntry={!showPassword}
              autoComplete="password"
              style={styles.inputText}
              onFocus={() => setPasswordFocused(true)}
              onBlur={() => setPasswordFocused(false)}
            />
            <TouchableOpacity
              onPress={() => setShowPassword((v) => !v)}
              style={styles.eyeButton}
            >
              <Ionicons
                name={showPassword ? "eye-outline" : "eye-off-outline"}
                size={18}
                color={colors.textMuted}
              />
            </TouchableOpacity>
          </View>
        </View>

        {/* Remember me + Forgot password */}
        <View style={styles.rememberRow}>
          <View style={styles.rememberLeft}>
            <Switch
              value={remember}
              onValueChange={setRemember}
              trackColor={{
                false: colors.border,
                true: "rgba(99,102,241,0.3)",
              }}
              thumbColor="#fff"
              ios_backgroundColor={colors.border}
            />
            <Text style={styles.rememberText}>Запомни ме</Text>
          </View>
          <TouchableOpacity>
            <Text style={styles.forgotText}>Забравена парола?</Text>
          </TouchableOpacity>
        </View>

        {/* Login Button */}
        <TouchableOpacity
          onPress={handleLogin}
          disabled={loading}
          activeOpacity={0.8}
          style={{ opacity: loading ? 0.6 : 1 }}
        >
          <LinearGradient
            colors={[colors.accentDark, colors.accent]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.loginButton}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.loginButtonText}>Вход</Text>
            )}
          </LinearGradient>
        </TouchableOpacity>

        {/* Footer */}
        <Text style={styles.footerText}>
          С влизането приемате нашите{"\n"}
          <Text style={styles.footerLink}>Условия за ползване</Text> и{" "}
          <Text style={styles.footerLink}>Поверителност</Text>
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },

  // Background gradient overlays
  bgGradient1: {
    position: "absolute",
    top: -60,
    left: -40,
    width: 400,
    height: 400,
    borderRadius: 200,
    backgroundColor: "rgba(99,102,241,0.06)",
  },
  bgGradient2: {
    position: "absolute",
    bottom: 100,
    right: -80,
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: "rgba(139,92,246,0.05)",
  },

  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingVertical: 60,
  },

  // Logo
  logoWrap: {
    alignItems: "center",
    marginBottom: 32,
    gap: 16,
  },
  logoCircle: {
    width: 80,
    height: 80,
    borderRadius: 24,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 32,
    elevation: 8,
  },
  logoText: {
    alignItems: "center",
  },
  appTitle: {
    fontSize: 32,
    fontWeight: "800",
    letterSpacing: -1,
    color: colors.text,
    marginBottom: 6,
  },
  appSubtitle: {
    fontSize: 14,
    color: colors.textSecondary,
    fontWeight: "500",
    letterSpacing: -0.1,
  },

  // Form
  formGroup: {
    marginBottom: 12,
  },
  formLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
    paddingLeft: 2,
  },
  formInput: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  formInputFocused: {
    borderColor: "rgba(99,102,241,0.4)",
    backgroundColor: "#141420",
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 2,
  },
  inputIcon: {
    flexShrink: 0,
  },
  inputText: {
    flex: 1,
    fontSize: 16,
    color: colors.textLight,
    fontWeight: "500",
    letterSpacing: -0.2,
    padding: 0,
  },
  eyeButton: {
    paddingLeft: 8,
  },

  // Remember me row
  rememberRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 6,
    marginBottom: 28,
    paddingHorizontal: 2,
  },
  rememberLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  rememberText: {
    fontSize: 14,
    color: colors.textSecondary,
    fontWeight: "500",
  },
  forgotText: {
    fontSize: 13,
    color: colors.accent,
    fontWeight: "500",
  },

  // Login button
  loginButton: {
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
    elevation: 6,
    marginBottom: 20,
  },
  loginButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: -0.2,
  },

  // Footer
  footerText: {
    fontSize: 12,
    color: colors.textDim,
    textAlign: "center",
    lineHeight: 18,
  },
  footerLink: {
    color: colors.accent,
    fontWeight: "500",
  },
});
