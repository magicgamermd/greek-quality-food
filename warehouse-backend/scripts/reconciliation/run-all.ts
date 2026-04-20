import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const checks = [
  "accepted-invoices-vs-stock.ts",
  "batch-expiry-consistency.ts",
  "product-price-surface-drift.ts",
];

const extraArgs = process.argv.slice(2);
let highestExitCode = 0;

for (const check of checks) {
  const scriptPath = path.join(__dirname, check);
  const result = spawnSync("npx", ["tsx", scriptPath, ...extraArgs], {
    stdio: "inherit",
    env: process.env,
  });

  const exitCode = result.status ?? 1;
  if (exitCode > highestExitCode) {
    highestExitCode = exitCode;
  }
}

process.exitCode = highestExitCode;
