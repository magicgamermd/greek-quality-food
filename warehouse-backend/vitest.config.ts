import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    environment: "node",
    // Ensures JWT_SECRET and other required env vars exist before the app
    // module is imported - see src/index.ts which throws if JWT_SECRET is
    // missing regardless of NODE_ENV.
    setupFiles: ["src/__tests__/setup.ts"],
  },
});
