import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = join(__dirname, "..", "..", "session");
const SESSION_FILE = join(SESSION_DIR, "tester.session");

export function readSession(): string {
  if (!existsSync(SESSION_FILE)) return "";
  return readFileSync(SESSION_FILE, "utf-8").trim();
}

export function writeSession(s: string): void {
  if (!existsSync(SESSION_DIR))
    mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SESSION_FILE, s, { encoding: "utf-8", mode: 0o600 });
  chmodSync(SESSION_FILE, 0o600);
}

export function sessionExists(): boolean {
  return existsSync(SESSION_FILE) && readSession().length > 0;
}
