import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

// Stable bigint key for pg_advisory_lock — must be the same across all
// callers (this script + the shell `run-migrations.sh` runner) so they
// serialize against each other when multiple workers boot concurrently
// (PM2 cluster mode, Railway >1 replica, parallel deploys).
const MIGRATION_LOCK_KEY = "4242420001";

async function migrate() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
  });

  await client.connect();
  console.log("Connected to PostgreSQL");

  // Acquire a session-scoped advisory lock so concurrent migrate runs
  // (e.g. multiple cluster workers booting at the same time) wait for
  // each other instead of double-applying or partially-applying files.
  // pg_advisory_lock is automatically released when the session ends —
  // i.e. when client.end() runs at the bottom of this function, even
  // if we crash and skip the explicit unlock below.
  console.log("Acquiring migration advisory lock...");
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

  try {
    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Get already applied migrations
    const { rows: applied } = await client.query(
      "SELECT name FROM _migrations ORDER BY id",
    );
    const appliedSet = new Set(applied.map((r) => r.name));

    // Read migration files
    const migrationsDir = path.resolve(__dirname, "../migrations");
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let count = 0;
    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`  ✓ ${file} (already applied)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      console.log(`  → Applying ${file}...`);

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [
          file,
        ]);
        await client.query("COMMIT");
        console.log(`  ✓ ${file} applied`);
        count++;
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  ✗ ${file} FAILED:`, err);
        // Explicit unlock before exit so a stuck lock doesn't outlive
        // the failed boot if Postgres takes its time to GC the session.
        try {
          await client.query("SELECT pg_advisory_unlock($1)", [
            MIGRATION_LOCK_KEY,
          ]);
        } catch {
          /* ignore — session end will release */
        }
        process.exit(1);
      }
    }

    console.log(
      count > 0
        ? `\n${count} migration(s) applied.`
        : "\nDatabase is up to date.",
    );
  } finally {
    // Defensive unlock — pg_advisory_lock is session-scoped so client.end()
    // would also release it, but explicit unlock makes intent obvious.
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    } catch {
      /* swallow — about to end the session anyway */
    }
    await client.end();
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
