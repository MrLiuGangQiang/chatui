const assert = require('assert');

const usageRanges = require('../../server/usage/ranges');
const sharedUsageRanges = require('../../shared/usage/ranges');
const usageExportXlsx = require('../../server/usage/export-xlsx');
const usageValidator = require('../../server/validators/usage.validator');
const usageService = require('../../server/services/usage.service');
const usageStatsFormat = require('../../client/ui/usage-stats-format');
const usageStatsAuth = require('../../client/ui/usage-stats-auth');
const usageStatsView = require('../../client/features/usage-stats/view-helpers');
const { createPublicConfigReader } = require('../../server/config/public-config');
const dingTalkFeedback = require('../../server/services/dingtalk-feedback.service');
const feedbackContent = require('../../server/services/feedback-content.service');

function decodeXmlEntities(value = '') {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'");
}

function inlineCellValues(sheetXml = '') {
  return [...String(sheetXml).matchAll(/<c[^>]*(?:t="inlineStr")?[^>]*>(?:<is><t>(.*?)<\/t><\/is>|<v>(.*?)<\/v>)<\/c>/g)]
    .map(match => decodeXmlEntities(match[1] ?? match[2] ?? ''));
}

async function testDepartmentExportWorkbookShape() {
  const workbook = await usageExportXlsx.buildDepartmentExportWorkbook(
    '今日排行',
    [{ department_id: 'dept-1', department_name: '研发部', total_tokens: 100, prompt_tokens: 60, completion_tokens: 40, prompt_cached_tokens: 20, completion_reasoning_tokens: 5 }],
    { 'dept-1': [{ username: '张三', total_tokens: 80, prompt_tokens: 50, completion_tokens: 30, prompt_cached_tokens: 10, completion_reasoning_tokens: 2 }] },
    { start_time: new Date('2026-06-12T00:00:00+08:00'), end_time: new Date('2026-06-12T13:00:05+08:00') }
  );
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(workbook);
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  assert.ok(workbookXml.includes('部门今日排行统计'));
  assert.ok(workbookXml.includes('研发部今日排行统计'));
  const sheet1 = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const values = inlineCellValues(sheet1);
  assert.strictEqual(values.slice(0, 9).join('|'), '序号|部门名称|开始时间|结束时间|总用量|输入|输出|缓存输入|推理输出');
  assert.strictEqual(values[9], '1');
  assert.strictEqual(values[10], '研发部');
  assert.strictEqual(values[11], '2026-06-12 00:00:00');
  assert.strictEqual(values[12], '2026-06-12 13:00:05');
  assert.ok(!values.includes('部门主键'));
  assert.ok(!values.includes('dept-1'));
}

function testUsageRangesAreCentralized() {
  assert.deepStrictEqual(usageRanges.PERSONAL_RANGES, ['today', 'yesterday', 'week', 'last_week', 'month', 'last_month', 'total']);
  assert.deepStrictEqual(usageRanges.DEPARTMENT_RANGES, ['today', 'yesterday', 'week', 'last_week', 'month', 'last_month', 'total']);
  assert.strictEqual(usageRanges.RANGE_DEFINITIONS, sharedUsageRanges.RANGE_DEFINITIONS);
  assert.deepStrictEqual(usageRanges.rangeTabs(usageRanges.DEPARTMENT_RANGES), sharedUsageRanges.rangeTabs(sharedUsageRanges.DEPARTMENT_RANGES));
  assert.strictEqual(usageRanges.isPersonalRange('month'), true);
  assert.strictEqual(usageRanges.isDepartmentRange('month'), true);
  for (const range of usageRanges.DEPARTMENT_RANGES) {
    assert.ok(usageRanges.DEPARTMENT_RANGE_FILTERS[range], `missing department filter for ${range}`);
    assert.ok(usageRanges.DEPARTMENT_RANGE_BOUNDS_SQL[range], `missing department bounds sql for ${range}`);
    assert.ok(usageRanges.DEPARTMENT_RANGE_LABELS[range], `missing department label for ${range}`);
  }
}

function testUsageStatsFrontendHelpers() {
  assert.strictEqual(usageStatsFormat.formatTokens(1234567), '1.23M');
  assert.strictEqual(usageStatsFormat.formatPercent(12.3), '12.3%');
  assert.strictEqual(usageStatsFormat.cachePercent({ prompt_cached_tokens: 25, prompt_tokens: 100 }), 25);
  assert.strictEqual(usageStatsFormat.escapeHtml('<x>'), '&lt;x&gt;');
  assert.strictEqual(usageStatsAuth.shouldLoadRanking('abc'), true);
  assert.strictEqual(usageStatsAuth.shouldLoadRanking('  '), false);
  const store = new Map();
  const storage = { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
  storage.setItem(usageStatsAuth.API_KEY_SESSION_KEY, 'key-from-storage');
  assert.strictEqual(usageStatsAuth.currentApiKey({ getElement: () => ({ value: '' }), storage }), 'key-from-storage');
  usageStatsAuth.setDepartmentPassword('dep-pass', storage);
  assert.strictEqual(usageStatsAuth.getDepartmentPassword(storage), 'dep-pass');
  usageStatsAuth.clearDepartmentPassword(storage);
  assert.strictEqual(usageStatsAuth.getDepartmentPassword(storage), '');
}

function testFeedbackContentKeepsAuthoritativeModelsWithinLengthLimit() {
  const content = feedbackContent.feedbackWithModelContext('x'.repeat(4000), { routeModel: 'route-model', chatModel: 'chat-model' });
  assert.strictEqual(content.length, feedbackContent.MAX_FEEDBACK_LENGTH);
  assert.ok(content.endsWith('意图模型：route-model\n聊天模型：chat-model'));
}


function testUsageStatsViewHelpersPreserveMarkupAndLabels() {
  assert.deepStrictEqual(usageStatsView.DEFAULT_RANKING_TABS.map(([key]) => key), ['today', 'yesterday', 'week', 'last_week', 'month', 'last_month', 'total']);
  assert.deepStrictEqual(usageStatsView.DEFAULT_DEPARTMENT_TABS.map(([key]) => key), ['today', 'yesterday', 'week', 'last_week', 'month', 'last_month', 'total']);
  assert.deepStrictEqual(usageStatsView.DEFAULT_RANKING_TABS, sharedUsageRanges.rangeTabs(sharedUsageRanges.PERSONAL_RANGES));
  assert.deepStrictEqual(usageStatsView.DEFAULT_DEPARTMENT_TABS, sharedUsageRanges.rangeTabs(sharedUsageRanges.DEPARTMENT_RANGES));
  assert.strictEqual(usageStatsView.rangeLabel('week'), '本周');
  assert.strictEqual(usageStatsView.rangeLabel('last_week'), '上周');
  assert.strictEqual(usageStatsView.rangeLabel('last_month'), '上月');
  assert.strictEqual(usageStatsView.tabLabel('week', 'department'), '本周排行');
  assert.strictEqual(usageStatsView.tabLabel('month', 'department'), '本月排行');
  assert.deepStrictEqual(usageStatsView.rawTokenColumns({ prompt_cached_tokens: 7 })[3], ['缓存输入', 7]);
  const badges = usageStatsView.renderTokenBadges({ total_tokens: 1000, prompt_tokens: 500, completion_tokens: 500, prompt_cached_tokens: 100, completion_reasoning_tokens: 50 });
  assert.ok(badges.includes('usage-token-badge usage-token-badge-0'));
  assert.ok(badges.includes('<em>总用量</em>'));
  assert.ok(badges.includes('<strong>1,000</strong>'));
  assert.ok(usageStatsView.renderRankIndex(0).includes('usage-rank-medal-1'));
  assert.ok(usageStatsView.modeToggleIcon('department').includes('a7.5 7.5'));
}

function testUsageStatsModuleLoadsWithCommonJsFacade() {
  const previousDocument = global.document;
  const usageStatsPath = require.resolve('../../client/ui/usage-stats');
  delete require.cache[usageStatsPath];
  global.document = undefined;
  try {
    const usageStats = require('../../client/ui/usage-stats');
    assert.strictEqual(typeof usageStats.currentApiKey, 'function');
    assert.strictEqual(typeof usageStats.renderPersonal, 'function');
    assert.strictEqual(typeof usageStats.renderRanking, 'function');
    assert.strictEqual(typeof usageStats.renderDepartmentUsers, 'function');
    assert.strictEqual(usageStats.feedbackContentFromFields({ problem: '会话未切换', reproduction: '点击另一会话', expected: '应切换会话' }), '【问题描述】\n会话未切换\n\n【复现描述】\n点击另一会话\n\n【期望结果】\n应切换会话');
    const draft = usageStats.feedbackDraft('', { routeModel: '', chatModel: 'chat-main' });
    assert.strictEqual(draft, '【问题描述】\n\n【复现描述】\n\n【期望结果】\n\n【模型信息（自动填写）】\n意图模型：chat-main（跟随聊天模型）\n聊天模型：chat-main');
    const updated = usageStats.feedbackDraft(draft.replace('【问题描述】', '【问题描述】\n移动端点击会话没有切换'), { routeModel: 'route-new', chatModel: 'chat-new' });
    assert.ok(updated.includes('移动端点击会话没有切换'));
    assert.ok(updated.includes('意图模型：route-new') && updated.includes('聊天模型：chat-new'));
    assert.strictEqual((updated.match(/【模型信息（自动填写）】/g) || []).length, 1, 'refreshing a draft must replace the automatic model block');
  } finally {
    delete require.cache[usageStatsPath];
    global.document = previousDocument;
  }
}

async function testDingTalkFeedbackSenderContracts() {
  const accessToken = 'A'.repeat(32);
  assert.strictEqual(dingTalkFeedback.normalizeAccessToken(accessToken), accessToken);
  assert.strictEqual(dingTalkFeedback.normalizeWebhook(accessToken).includes(`access_token=${accessToken}`), true);
  assert.strictEqual(dingTalkFeedback.normalizeWebhook('https://oapi.dingtalk.com/robot/send?access_token=abc').includes('access_token=abc'), true);
  assert.strictEqual(dingTalkFeedback.normalizeWebhook('http://oapi.dingtalk.com/robot/send?access_token=abc'), '');
  assert.strictEqual(dingTalkFeedback.normalizeWebhook('https://example.com/robot/send?access_token=abc'), '');
  const signed = new URL(dingTalkFeedback.signedWebhookUrl('https://oapi.dingtalk.com/robot/send?access_token=abc', 'secret', 123));
  assert.strictEqual(signed.searchParams.get('timestamp'), '123');
  assert.ok(signed.searchParams.get('sign'));
  const calls = [];
  const sender = dingTalkFeedback.createDingTalkFeedbackSender({
    accessToken,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ errcode: 0 }) }; },
    now: () => 0,
  });
  assert.strictEqual(await sender.send('【问题描述】\n页面打不开\n\n【复现描述】\n打开首页即可复现\n\n【期望结果】\n页面应正常打开\n\n【模型信息（自动填写）】\n意图模型：伪造值  ', {
    routeModel: 'route-model',
    chatModel: 'chat-model',
  }), true);
  assert.strictEqual(calls.length, 1);
  const delivered = JSON.parse(calls[0].init.body).markdown.text;
  assert.ok(delivered.includes('#### 1. 问题描述\n页面打不开'));
  assert.ok(delivered.includes('#### 2. 复现描述\n打开首页即可复现'));
  assert.ok(delivered.includes('#### 3. 期望结果\n页面应正常打开'));
  assert.ok(delivered.includes('#### 模型信息'));
  assert.ok(delivered.includes('意图模型：`route-model`') && delivered.includes('聊天模型：`chat-model`'));
  assert.ok(!delivered.includes('伪造值'), 'server-normalized model context must replace user-edited model text');
  await assert.rejects(sender.send('   '), err => err.code === 'INVALID_FEEDBACK');
  const unavailable = dingTalkFeedback.createDingTalkFeedbackSender({ accessToken: '' });
  await assert.rejects(unavailable.send('问题'), err => err.code === 'FEEDBACK_NOT_CONFIGURED');
}

async function testFeedbackSubmissionPreservesReviewRejectionReason() {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const source = fs.readFileSync(path.join(__dirname, '../../client/services/usage-stats.js'), 'utf8');
  const context = {
    window: {},
    fetch: async () => ({
      ok: false,
      text: async () => JSON.stringify({
        review: { accepted: false, reason: '请补充可复现的操作步骤。' },
        error: { message: '审核未通过：请补充可复现的操作步骤。', code: 'INVALID_FEEDBACK' },
      }),
    }),
  };
  vm.runInNewContext(source, context, { filename: 'usage-stats.js' });
  await assert.rejects(
    context.window.ChatUIServices.usageStats.submitFeedback('测试反馈', 'sk-test', 'chat-model'),
    error => error?.reviewReason === '请补充可复现的操作步骤。'
      && error?.message === '审核未通过：请补充可复现的操作步骤。'
      && error?.code === 'INVALID_FEEDBACK',
  );
}

function testUsageStatsScriptsLoadInExpectedOrder() {
  const fs = require('fs');
  const path = require('path');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '../../client/ui/usage-stats.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');
  const serviceIndex = index.indexOf('client/services/usage-stats.js');
  const rangesIndex = index.indexOf('shared/usage/ranges.js');
  const formatIndex = index.indexOf('client/ui/usage-stats-format.js');
  const authIndex = index.indexOf('client/ui/usage-stats-auth.js');
  const viewIndex = index.indexOf('client/features/usage-stats/view-helpers.js');
  const uiIndex = index.indexOf('client/ui/usage-stats.js');
  assert.ok(serviceIndex > -1 && rangesIndex > -1 && rangesIndex < viewIndex && formatIndex > serviceIndex && authIndex > formatIndex && viewIndex > authIndex && uiIndex > viewIndex, 'usage stats scripts should load shared ranges before view helpers, then UI');
  assert.ok(index.includes('client/services/usage-stats.js?v=1.2.79-feedback-reason'), 'feedback rejection reasons should ship with a fresh service cache version');
  assert.ok(index.includes('client/ui/usage-stats.js?v=1.3.2-manual-context'), 'feedback form should ship with a fresh UI cache version');
  assert.ok(ui.includes('问题描述') && ui.includes('复现描述') && ui.includes('期望结果') && ui.includes('正在调用模型审核反馈内容'), 'feedback UI should present the three required sections and the model-review stage');
  assert.ok(ui.includes('【模型信息（自动填写）】') && ui.includes('意图模型：') && ui.includes('聊天模型：'), 'feedback UI should include the automatic model context');
  assert.ok(ui.includes('id="usageStatsIconGradient"') && ui.includes('class="usage-stats-pulse"'), 'the usage launcher must use the neon dashboard icon');
  assert.ok(ui.includes('stop-color="#60a5fa"') && ui.includes('stop-color="#8b5cf6"') && !ui.includes('stop-color="#34d399"'), 'the usage launcher gradient should match the blue-cyan-violet entry palette');
  assert.ok(ui.includes('id="usageFeedbackIconGradient"') && ui.includes('class="usage-feedback-wave"'), 'the feedback launcher must use the neon waveform icon');
  assert.ok(css.includes('.usage-stats-button{border-color:#bfdbfe!important;background:#eff6ff!important;color:#1d4ed8!important') && css.includes('.usage-stats-button:hover{background:#dbeafe!important'), 'the usage launcher surface should match the other light-blue entry buttons');
  assert.ok(css.includes('@keyframes usage-entry-pulse') && css.includes('.usage-feedback-open:hover .usage-feedback-spark'), 'usage entry icons must retain their shared motion treatment');
}

function testUsageValidatorNormalizesInputs() {
  assert.strictEqual(usageValidator.normalizeApiKey({ api_key: '  sk-a  ' }), 'sk-a');
  assert.strictEqual(usageValidator.normalizeApiKey({ apiKey: '  sk-b  ' }), 'sk-b');
  assert.strictEqual(usageValidator.normalizePersonalRange('yesterday'), 'yesterday');
  assert.strictEqual(usageValidator.normalizePersonalRange('month'), 'month');
  assert.strictEqual(usageValidator.normalizeDepartmentRange('month'), 'month');
  assert.strictEqual(usageValidator.normalizeDepartmentRange('bad'), null);
  assert.strictEqual(usageValidator.normalizeDepartmentId({ department_id: '  dept-1  ' }), 'dept-1');
  assert.strictEqual(usageValidator.normalizeDepartmentId({ departmentId: '  dept-2  ' }), 'dept-2');
  assert.strictEqual(usageValidator.rangeFromUrl({ url: '/api/usage/rankings?range=total', headers: {}, socket: {} }), 'total');
  assert.strictEqual(usageValidator.rangeFromUrl({ url: '/api/usage/rankings?range=bad', headers: {}, socket: {} }), null);
}

function testUsageValidatorRateLimitPreservesContract() {
  const buckets = new Map();
  const req = { headers: { 'x-forwarded-for': ' 1.2.3.4, 5.6.7.8 ' }, socket: { remoteAddress: 'fallback' } };
  assert.strictEqual(usageValidator.getClientKey(req), 'fallback');
  const first = usageValidator.checkUsageRefreshLimit(req, 'rankings', { buckets, limit: 2, windowMs: 1000, now: 100 });
  assert.deepStrictEqual(first, { allowed: true, remaining: 1, resetMs: 1000 });
  const second = usageValidator.checkUsageRefreshLimit(req, 'rankings', { buckets, limit: 2, windowMs: 1000, now: 101 });
  assert.deepStrictEqual(second, { allowed: true, remaining: 0, resetMs: 999 });
  const third = usageValidator.checkUsageRefreshLimit(req, 'rankings', { buckets, limit: 2, windowMs: 1000, now: 102 });
  assert.deepStrictEqual(third, { allowed: false, resetMs: 998 });
  assert.deepStrictEqual(usageValidator.usageRateLimitHeaders(third), {
    'Access-Control-Allow-Origin': '*',
    'X-RateLimit-Limit': '12',
    'X-RateLimit-Remaining': '0',
    'Retry-After': '1',
  });
}

async function testUsageServiceBuildsDepartmentExportWorkbookFromRepository() {
  const calls = [];
  const usageStats = {
    async getDepartmentRanking(range) {
      calls.push(['ranking', range]);
      return [{ department_id: 'dept-1', department_name: '研发部', total_tokens: 100, prompt_tokens: 60, completion_tokens: 40, prompt_cached_tokens: 20, completion_reasoning_tokens: 5 }];
    },
    async getDepartmentUsers(departmentId, range) {
      calls.push(['users', departmentId, range]);
      return [{ username: '张三', total_tokens: 80, prompt_tokens: 50, completion_tokens: 30, prompt_cached_tokens: 10, completion_reasoning_tokens: 2 }];
    },
    async getDepartmentRangeBounds(range) {
      calls.push(['bounds', range]);
      return { start_time: new Date('2026-06-12T00:00:00+08:00'), end_time: new Date('2026-06-12T13:00:05+08:00') };
    },
  };
  const workbook = await usageService.getDepartmentExportWorkbook(usageStats, 'last_week');
  assert.ok(Buffer.isBuffer(workbook));
  assert.deepStrictEqual(calls, [['ranking', 'last_week'], ['users', 'dept-1', 'last_week'], ['bounds', 'last_week']]);
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(workbook);
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  assert.ok(workbookXml.includes('部门上周排行统计'));
  assert.ok(workbookXml.includes('研发部上周排行统计'));
}

async function testUsageServiceOptimizesDepartmentExportWithBulkUsers() {
  const calls = [];
  const usageStats = {
    async getDepartmentRanking(range) {
      calls.push(['ranking', range]);
      return [{ department_id: 'dept-1', department_name: '研发部', total_tokens: 100, prompt_tokens: 60, completion_tokens: 40, prompt_cached_tokens: 20, completion_reasoning_tokens: 5 }];
    },
    async getAllDepartmentUsers(range) {
      calls.push(['all-users', range]);
      return [{ department_id: 'dept-1', username: '张三', total_tokens: 80, prompt_tokens: 50, completion_tokens: 30, prompt_cached_tokens: 10, completion_reasoning_tokens: 2 }];
    },
    async getDepartmentUsers() {
      calls.push(['users-fallback']);
      return [];
    },
    async getDepartmentRangeBounds(range) {
      calls.push(['bounds', range]);
      return { start_time: new Date('2026-06-12T00:00:00+08:00'), end_time: new Date('2026-06-12T13:00:05+08:00') };
    },
  };
  const workbook = await usageService.getDepartmentExportWorkbook(usageStats, 'today');
  assert.ok(Buffer.isBuffer(workbook));
  assert.deepStrictEqual(calls, [['ranking', 'today'], ['all-users', 'today'], ['bounds', 'today']]);
}

async function testUsageServiceOverviewCombinesPersonalAndRanking() {
  const calls = [];
  const usageStats = {
    async getRanking(range) { calls.push(['ranking', range]); return [{ username: 'A', total_tokens: 1 }]; },
    async getPersonalRange(apiKey, range) { calls.push(['personal', apiKey, range]); return { username: 'Me', total_tokens: 2 }; },
  };
  const overview = await usageService.getOverview(usageStats, 'sk-test', 'today', 'yesterday');
  assert.deepStrictEqual(calls, [['ranking', 'today'], ['personal', 'sk-test', 'yesterday']]);
  assert.deepStrictEqual(overview, { ranking: [{ username: 'A', total_tokens: 1 }], personal: { username: 'Me', total_tokens: 2 } });
}

function testConfigPublicConfigReader() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-public-config-'));
  fs.mkdirSync(path.join(root, 'config'));
  const readPublicConfig = createPublicConfigReader({ root, contextWindowTokens: 123456 });
  assert.deepStrictEqual(readPublicConfig(), { ui: {}, features: {}, context: { windowTokens: 123456 } });
  fs.writeFileSync(path.join(root, 'config', 'public.json'), JSON.stringify({ ui: { theme: 'flat' }, features: { usage: true }, context: { other: 'keep' }, ignored: true }));
  assert.deepStrictEqual(readPublicConfig(), { ui: { theme: 'flat' }, features: { usage: true }, context: { other: 'keep', windowTokens: 123456 } });
  fs.writeFileSync(path.join(root, 'config', 'public.json'), '[]');
  assert.deepStrictEqual(readPublicConfig(), { ui: {}, features: {}, context: { windowTokens: 123456 } });
}

module.exports = [
  testDepartmentExportWorkbookShape,
  testUsageRangesAreCentralized,
  testUsageStatsFrontendHelpers,
  testFeedbackContentKeepsAuthoritativeModelsWithinLengthLimit,
  testUsageStatsViewHelpersPreserveMarkupAndLabels,
  testUsageStatsModuleLoadsWithCommonJsFacade,
  testDingTalkFeedbackSenderContracts,
  testFeedbackSubmissionPreservesReviewRejectionReason,
  testUsageStatsScriptsLoadInExpectedOrder,
  testUsageValidatorNormalizesInputs,
  testUsageValidatorRateLimitPreservesContract,
  testUsageServiceBuildsDepartmentExportWorkbookFromRepository,
  testUsageServiceOptimizesDepartmentExportWithBulkUsers,
  testUsageServiceOverviewCombinesPersonalAndRanking,
  testConfigPublicConfigReader,
];
