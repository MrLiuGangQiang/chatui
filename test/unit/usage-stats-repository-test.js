const assert = require('assert');
const { createUsageStatsRepository } = require('../../server/usage/stats-repository');

const calls = [];
const pool = {
  async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('project_usage')) {
      return { rows: [{ project_id: '7', project_name: '项目 A', total_tokens: '300', prompt_tokens: '200', completion_tokens: '100', total_percent: '75' }] };
    }
    if (sql.includes('FROM api_keys WHERE "key" = $1')) {
      return { rows: [{ username: '许龙' }] };
    }
    return { rows: [{ username: '用户 A', total_tokens: '150', prompt_tokens: '120', completion_tokens: '30' }] };
  },
};

(async () => {
  const repo = createUsageStatsRepository(pool, { rankingLimit: '' });

  const userRanking = await repo.getRanking('today', 'user');
  assert.strictEqual(userRanking[0].username, '用户 A');
  assert.strictEqual(userRanking[0].total_tokens, 150);
  assert.match(calls[0].sql, /ul\.created_at >= TIMESTAMPTZ '2026-06-01 00:00:00\+08'/, 'user ranking applies usage start date filter');
  assert.match(calls[0].sql, /GROUP BY ak\.name/, 'user ranking groups by api key user name');
  assert.doesNotMatch(calls[0].sql, /LIMIT \$1/, 'user ranking is unlimited by default');
  assert.deepStrictEqual(calls[0].params, []);

  const projectRanking = await repo.getRanking('total', 'project');
  assert.strictEqual(projectRanking[0].project_id, 7);
  assert.strictEqual(projectRanking[0].project_name, '项目 A');
  assert.strictEqual(projectRanking[0].total_tokens, 300);
  assert.strictEqual(projectRanking[0].total_percent, 75);
  assert.match(calls[1].sql, /ul\.created_at >= TIMESTAMPTZ '2026-06-01 00:00:00\+08'/, 'project ranking applies usage start date filter');
  assert.match(calls[1].sql, /SUM\(total_tokens\) OVER \(\)/, 'project ranking calculates total token share');
  assert.match(calls[1].sql, /LEFT JOIN projects p ON ak\.project_id = p\.id/, 'project ranking joins projects table');
  assert.match(calls[1].sql, /GROUP BY p\.id, p\.name/, 'project ranking groups by project');
  assert.doesNotMatch(calls[1].sql, /LIMIT \$1/, 'project ranking is unlimited by default');
  assert.deepStrictEqual(calls[1].params, []);

  const limitedRepo = createUsageStatsRepository(pool, { rankingLimit: 20 });
  await limitedRepo.getRanking('today', 'user');
  assert.match(calls[2].sql, /LIMIT \$1/, 'explicit ranking limit is still supported');
  assert.deepStrictEqual(calls[2].params, [20]);

  await limitedRepo.getRanking('today', 'user', { projectId: 7 });
  assert.match(calls[3].sql, /AND ak\.project_id = \$1/, 'user ranking can filter by project');
  assert.match(calls[3].sql, /LIMIT \$2/, 'filtered user ranking shifts limit placeholder');
  assert.deepStrictEqual(calls[3].params, [7, 20]);

  const owner = await repo.getApiKeyOwner('sk-allowed');
  assert.strictEqual(owner, '许龙');
  assert.deepStrictEqual(calls[4].params, ['sk-allowed']);

  console.log('usage-stats-repository tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
