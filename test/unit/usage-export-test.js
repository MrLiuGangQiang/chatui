const assert = require('assert');
const { buildRankingExcel, isUsageExportAllowedUser } = require('../../server/api/routes/usage');

const userExcel = buildRankingExcel([
  { username: '许龙', total_tokens: 100, prompt_tokens: 80, completion_tokens: 20, prompt_cached_tokens: 10, completion_reasoning_tokens: 5 },
], { range: 'total', type: 'user' });

assert.match(userExcel, /<Workbook/, 'export is an Excel XML workbook');
assert.match(userExcel, /总计个人排行/, 'user export includes worksheet name');
assert.match(userExcel, /许龙/, 'user export includes username');
assert.match(userExcel, /<Data ss:Type="Number">100<\/Data>/, 'user export writes numeric token values');

const projectExcel = buildRankingExcel([
  { project_name: '项目 A', total_percent: 75, total_tokens: 300, prompt_tokens: 200, completion_tokens: 100, prompt_cached_tokens: 0, completion_reasoning_tokens: 0 },
], { range: 'today', type: 'project' });

assert.match(projectExcel, /今日项目排行/, 'project export includes worksheet name');
assert.match(projectExcel, /项目 A/, 'project export includes project name');
assert.match(projectExcel, /占比/, 'project export includes share column');
assert.match(projectExcel, /75%/, 'project export includes project share');

assert.strictEqual(isUsageExportAllowedUser('许龙'), true);
assert.strictEqual(isUsageExportAllowedUser('金晶'), true);
assert.strictEqual(isUsageExportAllowedUser('黄杰'), true);
assert.strictEqual(isUsageExportAllowedUser('莫振海'), true);
assert.strictEqual(isUsageExportAllowedUser('刘岗强'), true);
assert.strictEqual(isUsageExportAllowedUser('莫镇海'), false);
assert.strictEqual(isUsageExportAllowedUser('其他人'), false);

console.log('usage export tests passed');
