import path from "node:path";
import { defineConfig } from "vitest/config";

// Тестове на чистата логика (src/lib). Без vite.config — PWA плъгинът не
// трябва на тестовете.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
