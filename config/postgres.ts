import { Pool, type PoolClient, type PoolConfig } from "pg";

let pool: Pool | null = null;

const enabled = () => process.env.POSTGRES_FOUNDATION_ENABLED === "true";

const config = (): PoolConfig => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error("POSTGRES_URL is required when PostgreSQL foundation is enabled");
  return {
    connectionString,
    max: Number(process.env.POSTGRES_POOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.POSTGRES_IDLE_TIMEOUT_MS || 10_000),
    connectionTimeoutMillis: Number(process.env.POSTGRES_CONNECT_TIMEOUT_MS || 5_000),
    statement_timeout: Number(process.env.POSTGRES_STATEMENT_TIMEOUT_MS || 15_000),
    application_name: "rfpilot-api",
    ssl: process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  };
};

export const postgresEnabled = enabled;
export const postgresPool = (): Pool => {
  if (!enabled()) throw new Error("PostgreSQL foundation is disabled");
  pool ??= new Pool(config());
  return pool;
};

export const withPostgresTransaction = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await postgresPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const checkPostgres = async () => {
  if (!enabled()) return { enabled: false, ready: false, migrationVersion: null };
  const result = await postgresPool().query<{ version: string | null }>(
    "SELECT max(version) AS version FROM public.rfpilot_schema_migrations",
  );
  return { enabled: true, ready: true, migrationVersion: result.rows[0]?.version ?? null };
};

export const closePostgres = async () => {
  if (pool) await pool.end();
  pool = null;
};
