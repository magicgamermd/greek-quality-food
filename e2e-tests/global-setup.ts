import type { FullConfig } from "@playwright/test";

const DEFAULT_HEALTH_URLS = [
  "http://127.0.0.1:3003/health",
  "http://localhost:3003/health",
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBackendHealth(urls: string[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown error";

  while (Date.now() < deadline) {
    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (res.ok) return;
        lastError = `${url} returned HTTP ${res.status}`;
      } catch (err) {
        lastError = `${url} unreachable (${(err as Error).message})`;
      }
    }
    await sleep(1_000);
  }

  throw new Error(
    `Backend health check failed after ${timeoutMs / 1000}s. Tried: ${urls.join(", ")}. Last error: ${lastError}. ` +
      "Start backend stack first (example: cd warehouse-backend && docker compose up -d postgres redis backend), " +
      "or set E2E_BACKEND_HEALTH_URL to your active backend health endpoint.",
  );
}

export default async function globalSetup(_config: FullConfig) {
  if (process.env.E2E_SKIP_BACKEND_HEALTHCHECK === "1") return;

  const healthUrls = (
    process.env.E2E_BACKEND_HEALTH_URL
      ? process.env.E2E_BACKEND_HEALTH_URL.split(",")
      : DEFAULT_HEALTH_URLS
  )
    .map((url) => url.trim())
    .filter(Boolean);

  await waitForBackendHealth(healthUrls, 30_000);
}
