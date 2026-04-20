/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./App.{js,jsx,ts,tsx}", "./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        "bg-light": "#F8FAFC",
        "bg-card": "#FFFFFF",
        "bg-hover": "#F1F5F9",
        "border-line": "#E2E8F0",
        "accent-primary": "#4F46E5",
        "accent-alt": "#6366F1",
        "text-primary": "#1E293B",
        "text-secondary": "#64748B",
        "text-muted": "#94A3B8",
        "success-color": "#059669",
        "warning-color": "#D97706",
        "danger-color": "#DC2626",
        "info-color": "#2563EB",
      },
    },
  },
  plugins: [],
};
