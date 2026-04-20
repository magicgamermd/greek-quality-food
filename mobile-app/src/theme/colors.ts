/**
 * Dark Theme for Greek Foods Warehouse App
 * Matches approved mockup designs — #0a0a14 base, #6366f1 accent
 */

export const colors = {
  // Base backgrounds
  background: "#0a0a14",
  surface: "#12121e",
  surfaceElevated: "#1a1a2e",
  surfaceHover: "#222238",

  // Borders & dividers
  border: "#252540",
  borderLight: "rgba(255,255,255,0.06)",
  borderSubtle: "rgba(255,255,255,0.08)",

  // Primary brand colors
  accent: "#6366f1",
  accentAlt: "#818cf8",
  accentLight: "rgba(99,102,241,0.15)",
  accentDark: "#4f46e5",

  // Semantic colors
  success: "#22c55e",
  successLight: "rgba(34,197,94,0.15)",
  warning: "#fbbf24",
  warningLight: "rgba(251,191,36,0.12)",
  danger: "#ef4444",
  dangerLight: "rgba(239,68,68,0.1)",
  orange: "#f97316",
  orangeLight: "rgba(249,115,22,0.15)",

  // Text hierarchy (from mockups)
  text: "#ffffff",
  textLight: "#e5e7eb",
  textSecondary: "#6b7280",
  textMuted: "#4b5563",
  textDim: "#374151",
  textInverse: "#0a0a14",

  // Additional semantic
  info: "#3b82f6",
  infoLight: "rgba(59,130,246,0.15)",
  purple: "#8b5cf6",
  purpleLight: "rgba(139,92,246,0.15)",
  yellow: "#eab308",
  yellowLight: "rgba(234,179,8,0.15)",

  // Tab bar
  tabBarBg: "rgba(18, 18, 30, 0.85)",
  tabBarBorder: "rgba(255,255,255,0.08)",
  tabActive: "#6366f1",
  tabInactive: "#4b5563",
} as const;

export type ColorKey = keyof typeof colors;
