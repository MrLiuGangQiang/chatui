const { Pool } = require('pg');

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function createPostgresConfig(env = process.env) {
  const connectionString = String(env.POSTGRES_URL || env.POSTGRESQL_URL || env.PG_DATABASE_URL || env.DATABASE_URL || '').trim();
  const host = String(env.PGHOST || env.POSTGRES_HOST || '').trim();
  const database = String(env.PGDATABASE || env.POSTGRES_DATABASE || '').trim();
  const user = String(env.PGUSER || env.POSTGRES_USER || '').trim();
  const password = String(env.PGPASSWORD || env.POSTGRES_PASSWORD || '').trim();
  const port = Number(env.PGPORT || env.POSTGRES_PORT || 5432);
  const min = Number(env.PG_POOL_MIN || env.POSTGRES_POOL_MIN || 0);
  const max = Number(env.PG_POOL_MAX || env.POSTGRES_POOL_MAX || 10);
  const idleTimeoutMillis = Number(env.PG_IDLE_TIMEOUT_MS || env.POSTGRES_IDLE_TIMEOUT_MS || 30000);
  const connectionTimeoutMillis = Number(env.PG_CONNECTION_TIMEOUT_MS || env.POSTGRES_CONNECTION_TIMEOUT_MS || 5000);
  const sslMode = String(env.PGSSL || env.POSTGRES_SSL || '').trim().toLowerCase();
  const ssl = sslMode ? normalizeBoolean(sslMode) || sslMode === 'require' ? { rejectUnauthorized: false } : false : undefined;

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
  return new Pool(config.pool);
}

module.exports = { createPostgresConfig, createPostgresPool };
