'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expectedNodeMajor, parseNodeMajor, inspectRuntime } = require('../../scripts/check-runtime');
const { assertNoBomBeforeShebang } = require('../../scripts/check-syntax');
const { DEFAULTS, RuntimeConfigError, createRuntimeConfig } = require('../../server/config/runtime-config');

function testRuntimeToolingUsesDeclaredNodeVersion() {
  assert.strictEqual(expectedNodeMajor(), 22);
  assert.strictEqual(parseNodeMajor('v22.16.0'), 22);
  assert.deepStrictEqual(inspectRuntime({ version: 'v22.0.0' }), { expectedMajor: 22, actualMajor: 22, matches: true });
  assert.deepStrictEqual(inspectRuntime({ version: 'v24.0.0' }), { expectedMajor: 22, actualMajor: 24, matches: false });
  assert.throws(() => parseNodeMajor('not-a-node-version'), /invalid Node version/);
}

function testSyntaxToolingRejectsBomBeforeShebang() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-runtime-tooling-'));
  const executable = path.join(directory, 'bad-script.js');
  try {
    fs.writeFileSync(executable, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('#!/usr/bin/env node\nconsole.log(1);\n')]));
    assert.throws(() => assertNoBomBeforeShebang([executable]), /must not contain a UTF-8 BOM before its shebang/);
    fs.writeFileSync(executable, '#!/usr/bin/env node\nconsole.log(1);\n', 'utf8');
    assert.strictEqual(assertNoBomBeforeShebang([executable]), 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}


function testRuntimeConfigNormalizesSupportedValuesAndAliases() {
  const config = createRuntimeConfig({
    HOST: ' 127.0.0.1 ',
    PORT: '9000',
    DEFAULT_UPSTREAM_BASE_URL: 'https://api.example.com/v1/',
    UPSTREAM_TIMEOUT_MS: '6000',
    MAX_CONNECTIONS: '20',
    CHATUI_CONTEXT_WINDOW_TOKENS: '8192',
    CHATUI_ALLOW_PRIVATE_UPSTREAM: 'yes',
    CHATUI_UPSTREAM_PROXY: 'http://proxy.example:8080/',
    MAX_UPSTREAM_CONCURRENCY: '3',
    MAX_UPSTREAM_QUEUE: '4',
    MAX_EXTRACT_CONCURRENCY: '5',
    MAX_EXTRACT_QUEUE: '6',
    MAX_BODY_BYTES: '2048',
    MAX_EXTRACT_TEXT_BYTES: '4096',
    MAX_EXTRACT_PDF_BYTES: '8192',
    MAX_EXTRACT_OFFICE_BYTES: '16384',
    JOB_TTL_MS: '120000',
    RUNNING_JOB_TTL_MS: '300000',
    MAX_JOBS_PER_STORE: '7',
    MAX_MANAGED_JOBS_PER_PRINCIPAL: '9',
    JOB_SWEEP_INTERVAL_MS: '2000',
    POSTGRES_URL: 'postgresql://user:password@db.example/chatui',
    PG_POOL_MIN: '2',
    PG_POOL_MAX: '4',
    PG_IDLE_TIMEOUT_MS: '3000',
    PG_CONNECTION_TIMEOUT_MS: '4000',
    PGSSL: 'on',
    USAGE_RANKING_LIMIT: '12',
    USAGE_STATS_DEPARTMENT_PASSWORD: ' department-password ',
    DINGTALK_FEEDBACK_ACCESS_TOKEN: ' token ',
    DINGTALK_FEEDBACK_SECRET: ' secret ',
    DEBUG_CHATUI: 'true',
  });

  assert.strictEqual(Object.isFrozen(config), true);
  assert.deepStrictEqual(config, {
    port: 9000,
    host: '127.0.0.1',
    defaultUpstreamBaseUrl: 'https://api.example.com/v1',
    upstreamTimeoutMs: 6000,
    maxConnections: 20,
    contextWindowTokens: 8192,
    allowPrivateUpstream: true,
    upstreamProxyUrl: 'http://proxy.example:8080',
    maxUpstreamConcurrency: 3,
    maxUpstreamQueue: 4,
    maxExtractConcurrency: 5,
    maxExtractQueue: 6,
    maxBodyBytes: 2048,
    maxExtractTextBytes: 4096,
    maxExtractPdfBytes: 8192,
    maxExtractOfficeBytes: 16384,
    jobTtlMs: 120000,
    runningJobTtlMs: 360000,
    maxJobsPerStore: 7,
    maxManagedJobsPerPrincipal: 9,
    jobSweepIntervalMs: 2000,
    postgresUrl: 'postgresql://user:password@db.example/chatui',
    pgPoolMin: 2,
    pgPoolMax: 4,
    pgIdleTimeoutMs: 3000,
    pgConnectionTimeoutMs: 4000,
    pgSsl: true,
    usageRankingLimit: 12,
    usageDepartmentPassword: 'department-password',
    dingtalkFeedbackAccessToken: 'token',
    dingtalkFeedbackSecret: 'secret',
    verboseLogs: true,
    corsOrigins: [],
    deploymentMode: 'local',
    authTokens: [],
  });

  const proxyFallback = createRuntimeConfig({ HTTPS_PROXY: 'http://secure-proxy.example:8443/' });
  assert.strictEqual(proxyFallback.upstreamProxyUrl, 'http://secure-proxy.example:8443');
  assert.strictEqual(proxyFallback.port, DEFAULTS.port);
}

function testManagedRuntimeConfigRequiresStaticAuthTokens() {
  assert.throws(() => createRuntimeConfig({ CHATUI_DEPLOYMENT_MODE: 'managed' }), error => {
    assert(error instanceof RuntimeConfigError);
    assert.deepStrictEqual(error.errors, ['CHATUI_AUTH_TOKENS must configure at least one principal:token entry when CHATUI_DEPLOYMENT_MODE=managed.']);
    return true;
  });

  const config = createRuntimeConfig({ CHATUI_DEPLOYMENT_MODE: 'managed', CHATUI_AUTH_TOKENS: 'alice:token-a,bob:token-b' });
  assert.strictEqual(config.deploymentMode, 'managed');
  assert.deepStrictEqual(config.authTokens.map(item => item.id), ['alice', 'bob']);
  assert.ok(config.authTokens.every(item => Buffer.isBuffer(item.tokenHash)));
  assert.ok(!JSON.stringify(config).includes('token-a'));
}

function testRuntimeConfigReportsAllInvalidValuesTogether() {
  assert.throws(() => createRuntimeConfig({
    PORT: '0',
    DEFAULT_UPSTREAM_BASE_URL: 'ftp://api.example.com',
    CHATUI_ALLOW_PRIVATE_UPSTREAM: 'sometimes',
    MAX_UPSTREAM_CONCURRENCY: 'invalid',
    POSTGRES_URL: 'mysql://db.example/chatui',
    PG_POOL_MIN: '5',
    PG_POOL_MAX: '2',
    PGSSL: 'perhaps',
    CHATUI_UPSTREAM_PROXY: 'file:///tmp/proxy',
  }), error => {
    assert(error instanceof RuntimeConfigError);
    assert.strictEqual(error.code, 'INVALID_RUNTIME_CONFIG');
    assert.deepStrictEqual(error.errors, [
      'CHATUI_ALLOW_PRIVATE_UPSTREAM must be a boolean (1/0, true/false, yes/no, on/off).',
      'PORT must be an integer between 1 and 65535.',
      'DEFAULT_UPSTREAM_BASE_URL must be an absolute HTTP(S) URL without embedded credentials.',
      'CHATUI_UPSTREAM_PROXY must be an absolute HTTP(S) URL.',
      'MAX_UPSTREAM_CONCURRENCY must be an integer between 1 and 1000.',
      'POSTGRES_URL must use the postgres:// or postgresql:// scheme.',
      'PGSSL must be a boolean (1/0, true/false, yes/no, on/off).',
      'PG_POOL_MIN must not exceed PG_POOL_MAX.',
    ]);
    return true;
  });
}

module.exports = [
  testRuntimeToolingUsesDeclaredNodeVersion,
  testSyntaxToolingRejectsBomBeforeShebang,
  testRuntimeConfigNormalizesSupportedValuesAndAliases,
  testManagedRuntimeConfigRequiresStaticAuthTokens,
  testRuntimeConfigReportsAllInvalidValuesTogether,
];
