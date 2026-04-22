import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, "..", "logs");

let filePath: string | null = null;

export function initFileLog(runId: string): void {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  filePath = join(LOGS_DIR, `${runId}.log`);
}

type Level = "info" | "warn" | "error" | "debug";

function write(
  level: Level,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  const ts = new Date().toISOString();
  const line =
    meta !== undefined
      ? `${ts} [${level}] ${msg} ${JSON.stringify(meta)}`
      : `${ts} [${level}] ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  if (filePath) {
    try {
      appendFileSync(filePath, line + "\n", "utf-8");
    } catch {
      // best effort
    }
  }
}

export const log = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    write("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    write("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) =>
    write("error", msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) =>
    write("debug", msg, meta),
};
