const { DEFAULT_CONTEXT_WINDOW_TOKENS, normalizeContextWindowTokens } = require('../../shared/config/context-budget');
const { parseAllowedOrigins } = require('../http/cors');
const { parseDeploymentMode, parseStaticAuthTokens } = require('../security/auth');

const DEFAULTS = Object.freeze({
  port: 8765,
  host: '127.0.0.1',
  defaultUpstreamBaseUrl: 'https://ingress.lfans.cn/v1',
  upstreamTimeoutMs: 10 * 60 * 1000,
  maxUpstreamConcurrency: 30,
  maxUpstreamQueue: 100,
  maxExtractConcurrency: 3,
  maxExtractQueue: 20,
  maxBodyBytes: 50 * 1024 * 1024,
  maxExtractTextBytes: 5 * 1024 * 1024,
  maxExtractPdfBytes: 25 * 1024 * 1024,
  maxExtractOfficeBytes: 25 * 1024 * 1024,
  jobTtlMs: 60 * 60 * 1000,
  maxJobsPerStore: 200,
  maxManagedJobsPerPrincipal: 8,
  jobSweepIntervalMs: 5 * 60 * 1000,
  pgPoolMin: 0,
  pgPoolMax: 10,
  pgIdleTimeoutMs: 30 * 1000,
  pgConnectionTimeoutMs: 5 * 1000,
  usageRankingLimit: 10,
});

class RuntimeConfigError extends Error {
  constructor(errors) {
    super(`Invalid runtime configuration:\n${errors.map(item => `- ${item}`).join('\n')}`);
    this.name = 'RuntimeConfigError';
    this.code = 'INVALID_RUNTIME_CONFIG';
    this.errors = errors;
  }
}

function firstDefined(env, keys, fallback = '') {
  for (const key of keys) {
    const value = env?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return fallback;
}

function readString(env, key, fallback, errors, { required = false } = {}) {
  const value = String(env?.[key] ?? fallback ?? '').trim();
  if (required && !value) errors.push(`${key} must not be empty.`);
  return value;
}

function readInteger(env, key, fallback, errors, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  const raw = env?.[key];
  if ((raw === undefined || raw === null || String(raw).trim() === '') && optional) return undefined;
  const value = raw === undefined || raw === null || String(raw).trim() === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    errors.push(`${key} must be an integer between ${min} and ${max}.`);
    return fallback;
  }
  return value;
}

function readBoolean(env, keys, fallback = false, errors = []) {
  const raw = firstDefined(env, keys, '');
  if (raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  errors.push(`${keys[0]} must be a boolean (1/0, true/false, yes/no, on/off).`);
  return fallback;
}

function readHttpUrl(env, key, fallback, errors, { optional = false } = {}) {
  const raw = String(env?.[key] ?? fallback ?? '').trim().replace(/\/+$/, '');
  if (!raw && optional) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('invalid');
    return url.toString().replace(/\/+$/, '');
  } catch {
    errors.push(`${key} must be an absolute HTTP(S) URL without embedded credentials.`);
    return String(fallback || '').replace(/\/+$/, '');
  }
}

function readPostgresUrl(env, errors) {
  const raw = String(firstDefined(env, ['POSTGRES_URL', 'POSTGRESQL_URL', 'PG_DATABASE_URL', 'DATABASE_URL'], '')).trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('invalid');
    return raw;
  } catch {
    errors.push('POSTGRES_URL must use the postgres:// or postgresql:// scheme.');
    return '';
  }
}

function readProxyUrl(env, errors) {
  const raw = String(firstDefined(env, ['CHATUI_UPSTREAM_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'], '')).trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('invalid');
    return url.toString().replace(/\/+$/, '');
  } catch {
    errors.push('CHATUI_UPSTREAM_PROXY must be an absolute HTTP(S) URL.');
    return '';
  }
}

function createRuntimeConfig(env = process.env) {
  const errors = [];
  const allowPrivateUpstream = readBoolean(env, ['CHATUI_ALLOW_PRIVATE_UPSTREAM', 'ALLOW_PRIVATE_UPSTREAM'], false, errors);
  const deploymentMode = parseDeploymentMode(env?.CHATUI_DEPLOYMENT_MODE, errors);
  const authTokens = parseStaticAuthTokens(env?.CHATUI_AUTH_TOKENS, errors);
  const upstreamTimeoutMs = readInteger(env, 'UPSTREAM_TIMEOUT_MS', DEFAULTS.upstreamTimeoutMs, errors, { min: 1000, max: 60 * 60 * 1000 });
  const pgPoolMin = readInteger(env, 'PG_POOL_MIN', DEFAULTS.pgPoolMin, errors, { min: 0, max: 100 });
  const pgPoolMax = readInteger(env, 'PG_POOL_MAX', DEFAULTS.pgPoolMax, errors, { min: 1, max: 100 });
  const contextWindowTokens = normalizeContextWindowTokens(env?.CHATUI_CONTEXT_WINDOW_TOKENS, DEFAULT_CONTEXT_WINDOW_TOKENS);
  const runningJobTtlMs = readInteger(env, 'RUNNING_JOB_TTL_MS', upstreamTimeoutMs, errors, { min: 1000, max: 24 * 60 * 60 * 1000 }) + 60 * 1000;
  const config = {
    port: readInteger(env, 'PORT', DEFAULTS.port, errors, { min: 1, max: 65535 }),
    host: readString(env, 'HOST', DEFAULTS.host, errors, { required: true }),
    defaultUpstreamBaseUrl: readHttpUrl(env, 'DEFAULT_UPSTREAM_BASE_URL', DEFAULTS.defaultUpstreamBaseUrl, errors),
    upstreamTimeoutMs,
    maxConnections: readInteger(env, 'MAX_CONNECTIONS', undefined, errors, { min: 1, max: 1000000, optional: true }),
    contextWindowTokens,
    allowPrivateUpstream,
    upstreamProxyUrl: readProxyUrl(env, errors),
    maxUpstreamConcurrency: readInteger(env, 'MAX_UPSTREAM_CONCURRENCY', DEFAULTS.maxUpstreamConcurrency, errors, { min: 1, max: 1000 }),
    maxUpstreamQueue: readInteger(env, 'MAX_UPSTREAM_QUEUE', DEFAULTS.maxUpstreamQueue, errors, { min: 0, max: 100000 }),
    maxExtractConcurrency: readInteger(env, 'MAX_EXTRACT_CONCURRENCY', DEFAULTS.maxExtractConcurrency, errors, { min: 1, max: 1000 }),
    maxExtractQueue: readInteger(env, 'MAX_EXTRACT_QUEUE', DEFAULTS.maxExtractQueue, errors, { min: 0, max: 100000 }),
    maxBodyBytes: readInteger(env, 'MAX_BODY_BYTES', DEFAULTS.maxBodyBytes, errors, { min: 1024, max: 100 * 1024 * 1024 }),
    maxExtractTextBytes: readInteger(env, 'MAX_EXTRACT_TEXT_BYTES', DEFAULTS.maxExtractTextBytes, errors, { min: 1024, max: 100 * 1024 * 1024 }),
    maxExtractPdfBytes: readInteger(env, 'MAX_EXTRACT_PDF_BYTES', DEFAULTS.maxExtractPdfBytes, errors, { min: 1024, max: 100 * 1024 * 1024 }),
    maxExtractOfficeBytes: readInteger(env, 'MAX_EXTRACT_OFFICE_BYTES', DEFAULTS.maxExtractOfficeBytes, errors, { min: 1024, max: 100 * 1024 * 1024 }),
    jobTtlMs: readInteger(env, 'JOB_TTL_MS', DEFAULTS.jobTtlMs, errors, { min: 60 * 1000, max: 7 * 24 * 60 * 60 * 1000 }),
    runningJobTtlMs,
    maxJobsPerStore: readInteger(env, 'MAX_JOBS_PER_STORE', DEFAULTS.maxJobsPerStore, errors, { min: 1, max: 100000 }),
    maxManagedJobsPerPrincipal: readInteger(env, 'MAX_MANAGED_JOBS_PER_PRINCIPAL', DEFAULTS.maxManagedJobsPerPrincipal, errors, { min: 1, max: 100000 }),
    jobSweepIntervalMs: readInteger(env, 'JOB_SWEEP_INTERVAL_MS', DEFAULTS.jobSweepIntervalMs, errors, { min: 1000, max: 24 * 60 * 60 * 1000 }),
    postgresUrl: readPostgresUrl(env, errors),
    pgPoolMin,
    pgPoolMax,
    pgIdleTimeoutMs: readInteger(env, 'PG_IDLE_TIMEOUT_MS', DEFAULTS.pgIdleTimeoutMs, errors, { min: 1000, max: 24 * 60 * 60 * 1000 }),
    pgConnectionTimeoutMs: readInteger(env, 'PG_CONNECTION_TIMEOUT_MS', DEFAULTS.pgConnectionTimeoutMs, errors, { min: 1000, max: 10 * 60 * 1000 }),
    pgSsl: readBoolean(env, ['PGSSL', 'POSTGRES_SSL'], false, errors),
    usageRankingLimit: readInteger(env, 'USAGE_RANKING_LIMIT', DEFAULTS.usageRankingLimit, errors, { min: 1, max: 1000 }),
    usageDepartmentPassword: String(firstDefined(env, ['USAGE_DEPARTMENT_PASSWORD', 'USAGE_STATS_DEPARTMENT_PASSWORD'], '')).trim(),
    dingtalkFeedbackAccessToken: String(env?.DINGTALK_FEEDBACK_ACCESS_TOKEN || '').trim(),
    dingtalkFeedbackSecret: String(env?.DINGTALK_FEEDBACK_SECRET || '').trim(),
    verboseLogs: readBoolean(env, ['CHATUI_VERBOSE_LOGS', 'DEBUG_CHATUI'], false, errors),
    corsOrigins: parseAllowedOrigins(env?.CHATUI_CORS_ORIGINS, errors),
    deploymentMode,
    authTokens,
  };
  if (pgPoolMin > pgPoolMax) errors.push('PG_POOL_MIN must not exceed PG_POOL_MAX.');
  if (deploymentMode === 'managed' && !authTokens.length) errors.push('CHATUI_AUTH_TOKENS must configure at least one principal:token entry when CHATUI_DEPLOYMENT_MODE=managed.');
  if (errors.length) throw new RuntimeConfigError(errors);
  return Object.freeze(config);
}

function assertRuntimeConfig(env = process.env) {
  return createRuntimeConfig(env);
}

module.exports = {
  DEFAULTS,
  RuntimeConfigError,
  firstDefined,
  readBoolean,
  createRuntimeConfig,
  assertRuntimeConfig,
};
