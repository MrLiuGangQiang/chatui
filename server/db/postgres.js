const { Pool } = require('pg');
const { nonNegativeInteger, portNumber, positiveInteger, timeoutMilliseconds } = require('../config/numbers');

function parsePostgresSsl(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  if (!mode) return undefined;
  if (['0', 'false', 'no', 'off', 'disable'].includes(mode)) return false;
  if (['1', 'true', 'yes', 'on', 'require'].includes(mode)) return { rejectUnauthorized: false };
  if (['verify-ca', 'verify-full'].includes(mode)) return { rejectUnauthorized: true };
  throw new TypeError(`Unsupported PostgreSQL SSL mode: ${mode}`);
}

function createPostgresConfig(env = process.env) {
  const connectionString = String(env.POSTGRES_URL || env.POSTGRESQL_URL || env.PG_DATABASE_URL || env.DATABASE_URL || '').trim();
  const host = String(env.PGHOST || env.POSTGRES_HOST || '').trim();
  const database = String(env.PGDATABASE || env.POSTGRES_DATABASE || '').trim();
  const user = String(env.PGUSER || env.POSTGRES_USER || '').trim();
  const password = String(env.PGPASSWORD || env.POSTGRES_PASSWORD || '').trim();
  const port = portNumber(env.PGPORT || env.POSTGRES_PORT, 5432);
  const max = positiveInteger(env.PG_POOL_MAX || env.POSTGRES_POOL_MAX, 10, { max: 10_000 });
  const min = Math.min(nonNegativeInteger(env.PG_POOL_MIN || env.POSTGRES_POOL_MIN, 0, { max: 10_000 }), max);
  const idleTimeoutMillis = timeoutMilliseconds(env.PG_IDLE_TIMEOUT_MS || env.POSTGRES_IDLE_TIMEOUT_MS, 30000);
  const connectionTimeoutMillis = timeoutMilliseconds(env.PG_CONNECTION_TIMEOUT_MS || env.POSTGRES_CONNECTION_TIMEOUT_MS, 5000);
  const ssl = parsePostgresSsl(String(env.PGSSL || '').trim() ? env.PGSSL : env.POSTGRES_SSL);

  const enabled = !!connectionString || !!(host && database && user);
  if (!enabled) return { enabled: false };

  return {
    enabled: true,
    pool: {
      ...(connectionString ? { connectionString } : { host, port, database, user, password }),
      min,
      max,
      idleTimeoutMillis,
      connectionTimeoutMillis,
      ...(ssl !== undefined ? { ssl } : {}),
    },
  };
}

function createPostgresPool(config = createPostgresConfig()) {
  if (!config.enabled) return null;
  const pool = new Pool(config.pool);
  pool.on('error', err => console.error('[postgres] idle client error:', err?.message || 'database connection error'));
  return pool;
}

module.exports = { createPostgresConfig, createPostgresPool, parsePostgresSsl };
