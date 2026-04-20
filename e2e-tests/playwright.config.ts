import { defineConfig } from "@playwright/test";

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: "http://127.0.0.1:3010",
    headless: true,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 3010 --strictPort",
    cwd: "../warehouse-frontend",
    url: "http://127.0.0.1:3010/login",
    timeout: 120_000,
    reuseExistingServer: !isCI,
  },
  reporter: [["html", { outputFolder: "playwright-report" }], ["list"]],
});
