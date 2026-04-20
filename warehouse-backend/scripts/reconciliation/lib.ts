import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config();

const DEFAULT_DOCKER_CONTAINER =
  process.env.RECON_POSTGRES_CONTAINER || "warehouse-backend-postgres-1";
const DEFAULT_DATABASE_CANDIDATES = [
  process.env.RECON_DATABASE_URL,
  process.env.DATABASE_URL,
  "postgres://greekfoods:greekfoods_secret@127.0.0.1:5432/greekfoods_warehouse",
  "postgres://greekfoods:greekfoods_secret@localhost:5432/greekfoods_warehouse",
].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);

export type Severity = "ok" | "warning" | "critical";

export interface ReconciliationSection<T = Record<string, unknown>> {
  key: string;
  title: string;
  severity_on_mismatch: Exclude<Severity, "ok">;
  rows_checked: number;
  mismatches_found: number;
  recommended_next_action: string;
  sample_mismatches: T[];
}

export interface ReconciliationReport {
  check: string;
  connection_mode: string;
  severity: Severity;
  total_rows_checked: number;
  total_mismatches_found: number;
  recommended_next_action: string;
  sections: ReconciliationSection[];
  generated_at: string;
}

let poolPromise: Promise<pg.Pool | null> | null = null;
let connectionModePromise: Promise<string> | null = null;

async function tryConnect(connectionString: string): Promise<pg.Pool | null> {
  const pool = new pg.Pool({
    connectionString,
    max: 2,
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 1500,
  });

  try {
    await pool.query("SELECT 1");
    return pool;
  } catch {
    await pool.end().catch(() => undefined);
    return null;
  }
}

async function getPool(): Promise<pg.Pool | null> {
  if (!poolPromise) {
    poolPromise = (async () => {
      for (const connectionString of DEFAULT_DATABASE_CANDIDATES) {
        const pool = await tryConnect(connectionString);
        if (pool) return pool;
      }
      return null;
    })();
  }

  return poolPromise;
}

function runDockerJsonQuery<T>(sql: string): T[] {
  const wrappedSql = `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)::text FROM (${sql}) t;`;
  const result = spawnSync(
    "docker",
    [
      "exec",
      DEFAULT_DOCKER_CONTAINER,
      "psql",
      "-U",
      process.env.RECON_POSTGRES_USER || "greekfoods",
      "-d",
      process.env.RECON_POSTGRES_DB || "greekfoods_warehouse",
      "-Atqc",
      wrappedSql,
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(
      `Docker psql query failed: ${result.stderr || result.stdout || "unknown error"}`,
    );
  }

  const raw = result.stdout.trim() || "[]";
  return JSON.parse(raw) as T[];
}

export async function queryRows<T = Record<string, unknown>>(
  sql: string,
): Promise<T[]> {
  const pool = await getPool();
  if (pool) {
    const result = await pool.query<T>(sql);
    return result.rows;
  }

  return runDockerJsonQuery<T>(sql);
}

export async function queryValue<T extends string | number>(
  sql: string,
  fallback: T,
): Promise<T> {
  const rows = await queryRows<Record<string, T>>(sql);
  const firstRow = rows[0];
  if (!firstRow) return fallback;
  const firstValue = Object.values(firstRow)[0];
  return (firstValue ?? fallback) as T;
}

export async function getConnectionMode(): Promise<string> {
  if (!connectionModePromise) {
    connectionModePromise = (async () => {
      const pool = await getPool();
      return pool ? "pg" : `docker:${DEFAULT_DOCKER_CONTAINER}`;
    })();
  }

  return connectionModePromise;
}

export function computeSeverity(sections: ReconciliationSection[]): Severity {
  const hasCritical = sections.some(
    (section) =>
      section.mismatches_found > 0 && section.severity_on_mismatch === "critical",
  );
  if (hasCritical) return "critical";

  const hasWarning = sections.some((section) => section.mismatches_found > 0);
  return hasWarning ? "warning" : "ok";
}

export function buildReport(
  check: string,
  connectionMode: string,
  sections: ReconciliationSection[],
): ReconciliationReport {
  const total_rows_checked = sections.reduce(
    (sum, section) => sum + section.rows_checked,
    0,
  );
  const total_mismatches_found = sections.reduce(
    (sum, section) => sum + section.mismatches_found,
    0,
  );
  const severity = computeSeverity(sections);
  const recommended_next_action =
    sections.find((section) => section.mismatches_found > 0)
      ?.recommended_next_action || "No action required.";

  return {
    check,
    connection_mode: connectionMode,
    severity,
    total_rows_checked,
    total_mismatches_found,
    recommended_next_action,
    sections,
    generated_at: new Date().toISOString(),
  };
}

export function printReport(report: ReconciliationReport, json = false): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n=== ${report.check} ===`);
  console.log(`Connection: ${report.connection_mode}`);
  console.log(`Generated: ${report.generated_at}`);
  console.log(
    `Summary: checked=${report.total_rows_checked} mismatches=${report.total_mismatches_found} severity=${report.severity}`,
  );
  console.log(`Next action: ${report.recommended_next_action}`);

  for (const section of report.sections) {
    console.log(`\n- ${section.title}`);
    console.log(
      `  checked=${section.rows_checked} mismatches=${section.mismatches_found} severity_on_mismatch=${section.severity_on_mismatch}`,
    );
    console.log(`  next=${section.recommended_next_action}`);
    if (section.sample_mismatches.length > 0) {
      console.log("  samples=");
      for (const sample of section.sample_mismatches) {
        console.log(`    ${JSON.stringify(sample)}`);
      }
    }
  }
}

export function argFlag(name: string): boolean {
  return process.argv.includes(name);
}

export function argValue(name: string): string | null {
  const raw = process.argv.find((value) => value.startsWith(`${name}=`));
  return raw ? raw.slice(name.length + 1) : null;
}

export function sampleLimit(): number {
  const parsed = Number(argValue("--sample-limit") || 5);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5;
}

export async function closeConnections(): Promise<void> {
  const pool = await getPool();
  if (pool) {
    await pool.end().catch(() => undefined);
  }
}
