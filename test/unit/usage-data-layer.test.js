'use strict';

const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPostgresConfig } = require('../../server/db/postgres');
const { applyMissingEnvironment, loadLocalEnv } = require('../../server/config/local-env');
const { createUsageAccessValidator, modelsFromPayload } = require('../../server/services/usage-access.service');
const { createUsageStatsRepository } = require('../../server/usage/stats-repository');

function testPostgresConfigurationRequiresACompleteConnectionAndNormalizesSsl() {
  assert.deepStrictEqual(createPostgresConfig({}), { enabled: false });
  assert.deepStrictEqual(createPostgresConfig({ PGHOST: 'db', PGDATABASE: 'chatui' }), { enabled: false });
  assert.deepStrictEqual(createPostgresConfig({
    POSTGRES_URL: 'postgres://user:pass@db/chatui',
    PG_POOL_MIN: '2',
    PG_POOL_MAX: '20',
    PG_IDLE_TIMEOUT_MS: '40000',
    PG_CONNECTION_TIMEOUT_MS: '7000',
    PGSSL: 'require',
  }), {
    enabled: true,
    pool: {
      connectionString: 'postgres://user:pass@db/chatui',
      min: 2,
      max: 20,
      idleTimeoutMillis: 40000,
      connectionTimeoutMillis: 7000,
      ssl: { rejectUnauthorized: false },
    },
  });
  assert.deepStrictEqual(createPostgresConfig({
    PGHOST: 'db', PGPORT: '5433', PGDATABASE: 'chatui', PGUSER: 'reader', PGPASSWORD: 'secret', POSTGRES_SSL: 'off',
  }).pool, {
    host: 'db', port: 5433, database: 'chatui', user: 'reader', password: 'secret', min: 0, max: 10,
    idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, ssl: false,
  });
}

function testLocalEnvironmentLoadsIgnoredFileWithoutOverridingProcessValues() {
  const env = { PGHOST: 'inherited-host' };
  assert.deepStrictEqual(applyMissingEnvironment('PGHOST=file-host\nPGPORT=5433\nPGPASSWORD="file secret"\n', env), ['PGPASSWORD', 'PGPORT']);
  assert.deepStrictEqual(env, { PGHOST: 'inherited-host', PGPORT: '5433', PGPASSWORD: 'file secret' });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-local-env-'));
  try {
    fs.writeFileSync(path.join(root, '.env.local'), 'PGDATABASE=chatui_test\nPGUSER=reader\n', 'utf8');
    const target = {};
    const result = loadLocalEnv({ root, env: target });
    assert.deepStrictEqual(result, { loaded: true, applied: ['PGDATABASE', 'PGUSER'] });
    assert.deepStrictEqual(target, { PGDATABASE: 'chatui_test', PGUSER: 'reader' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testUsageAccessPayloadParsingSupportsCompatibleModelShapes() {
  assert.deepStrictEqual([...modelsFromPayload({ data: [{ id: 'gpt-5' }, { name: 'flux-1' }, 'plain-model', {}] })], ['gpt-5', 'flux-1', 'plain-model']);
  assert.deepStrictEqual([...modelsFromPayload({ models: [{ id: 'a' }, 'b'] })], ['a', 'b']);
  assert.deepStrictEqual([...modelsFromPayload(null)], []);
}

async function testUsageAccessValidatorRejectsInvalidInputsAndCachesValidatedPairs() {
  let now = 1000;
  const calls = [];
  const validator = createUsageAccessValidator({
    now: () => now,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ data: [{ id: 'gpt-5' }] }) };
    },
  });
  assert.strictEqual((await validator.validate('', 'gpt-5')).code, 'INVALID_API_KEY');
  assert.strictEqual((await validator.validate('sk-test', '')).code, 'MODEL_NOT_CONFIGURED');
  assert.deepStrictEqual(await validator.validate(' sk-test ', ' gpt-5 '), { ok: true });
  assert.deepStrictEqual(await validator.validate('sk-test', 'gpt-5'), { ok: true });
  assert.strictEqual(calls.length, 1, 'a validated API-key/model pair should be cached');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer sk-test');
  assert.ok(calls[0].url.endsWith('/models'));
  now += 5 * 60 * 1000 + 1;
  await validator.validate('sk-test', 'gpt-5');
  assert.strictEqual(calls.length, 2, 'expired access results must be revalidated');
}

async function testUsageAccessValidatorMapsUpstreamDenialModelMismatchAndOutage() {
  const denied = createUsageAccessValidator({ fetchImpl: async () => ({ ok: false }) });
  assert.deepStrictEqual(await denied.validate('sk-bad', 'gpt-5'), {
    ok: false, statusCode: 403, code: 'INVALID_API_KEY', message: 'API Key 无效，统计和反馈暂不可用',
  });
  const mismatch = createUsageAccessValidator({ fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: 'other-model' }] }) }) });
  assert.deepStrictEqual(await mismatch.validate('sk-test', 'gpt-5'), {
    ok: false, statusCode: 400, code: 'MODEL_NOT_CONFIGURED', message: '当前聊天模型未正确配置，统计和反馈暂不可用',
  });
  const outage = createUsageAccessValidator({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepStrictEqual(await outage.validate('sk-test', 'gpt-5'), {
    ok: false, statusCode: 503, code: 'MODEL_VALIDATION_UNAVAILABLE', message: '无法验证 API Key 和模型配置，统计和反馈暂不可用',
  });
}

async function testUsageRepositoryUsesBoundParametersAndNormalizesTokenRows() {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ username: 'Alice', total_tokens: '12', prompt_tokens: '7', completion_tokens: '5', prompt_cached_tokens: '2', completion_reasoning_tokens: '1' }] };
    },
  };
  const repository = createUsageStatsRepository(pool, { rankingLimit: 999 });
  assert.deepStrictEqual(await repository.getRanking('today'), [{
    username: 'Alice', total_tokens: 12, prompt_tokens: 7, completion_tokens: 5, prompt_cached_tokens: 2, completion_reasoning_tokens: 1,
  }]);
  assert.deepStrictEqual(calls[0].params, [100]);
  assert.match(calls[0].sql, /LIMIT \$1/);
  assert.match(calls[0].sql, /CURRENT_DATE/);
  await assert.rejects(repository.getRanking('invalid'), /Unsupported usage range/);
}

async function testUsageRepositoryCoversPersonalDepartmentAndRangeQueries() {
  const calls = [];
  const responses = [
    [{ username: 'Bob', total_tokens: '3' }],
    [{ username: 'Bob' }],
    [{ department_id: 7, department_name: '研发', total_tokens: '9' }],
    [{ username: 'Carol', total_tokens: '4' }],
    [{ department_id: 7, username: 'Carol', total_tokens: '4' }],
    [{ start_time: 'start', end_time: 'end' }],
  ];
  const pool = { async query(sql, params) { calls.push({ sql, params }); return { rows: responses.shift() }; } };
  const repository = createUsageStatsRepository(pool);
  assert.strictEqual((await repository.getPersonalRange('sk-key', 'total')).total_tokens, 3);
  assert.deepStrictEqual(await repository.getUserByApiKey('sk-key'), { username: 'Bob' });
  assert.deepStrictEqual(await repository.getDepartmentRanking('month'), [{
    department_id: '7', department_name: '研发', total_tokens: 9, prompt_tokens: 0, completion_tokens: 0, prompt_cached_tokens: 0, completion_reasoning_tokens: 0,
  }]);
  assert.strictEqual((await repository.getDepartmentUsers('dept-1', 'week'))[0].username, 'Carol');
  assert.strictEqual((await repository.getAllDepartmentUsers('last_week'))[0].department_id, '7');
  assert.deepStrictEqual(await repository.getDepartmentRangeBounds('today'), { start_time: 'start', end_time: 'end' });
  assert.deepStrictEqual(calls[0].params, ['sk-key']);
  assert.deepStrictEqual(calls[1].params, ['sk-key']);
  assert.deepStrictEqual(calls[3].params, ['dept-1']);
  assert.match(calls[3].sql, /project_id::text = \$1/);
  await assert.rejects(repository.getDepartmentUsers('dept-1', 'bad'), /Unsupported department usage range/);
}

module.exports = [
  testPostgresConfigurationRequiresACompleteConnectionAndNormalizesSsl,
  testLocalEnvironmentLoadsIgnoredFileWithoutOverridingProcessValues,
  testUsageAccessPayloadParsingSupportsCompatibleModelShapes,
  testUsageAccessValidatorRejectsInvalidInputsAndCachesValidatedPairs,
  testUsageAccessValidatorMapsUpstreamDenialModelMismatchAndOutage,
  testUsageRepositoryUsesBoundParametersAndNormalizesTokenRows,
  testUsageRepositoryCoversPersonalDepartmentAndRangeQueries,
];
