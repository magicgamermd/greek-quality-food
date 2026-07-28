import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

// PostgreSQL DATE (oid 1082) няма час и часова зона — това е календарен
// ден. Драйверът по подразбиране го превръщаше в JS Date на ЛОКАЛНА
// полунощ; при JSON сериализация към UTC това ставаше 21:00 на ПРЕДНИЯ
// ден (Europe/Sofia = UTC+3), затова фронтендът показваше дата с ден
// по-рано (фактура 24.07 → 23.07; срок 09.09 → 08.09) и при запис
// връщаше изместената стойност обратно в базата.
//
// Връщаме DATE суров, като 'YYYY-MM-DD'. Няма часова зона → няма
// изместване, никъде. TIMESTAMPTZ (oid 1184) НЕ се пипа — там часовата
// зона е смислена.
pg.types.setTypeParser(1082, (value) => value);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err);
});

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  if (duration > 500) {
    console.warn(`Slow query (${duration}ms):`, text.slice(0, 100));
  }
  return result;
}

export async function getClient(): Promise<pg.PoolClient> {
  return pool.connect();
}

export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export default pool;
