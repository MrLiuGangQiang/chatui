'use strict';

const assert = require('assert');
const { Readable } = require('stream');
const { createApp } = require('../../server/app');
const { createMcpRoutes } = require('../../server/api/routes/mcp');
const usageValidator = require('../../server/validators/usage.validator');
const { PERSONAL_RANGES } = require('../../shared/usage/ranges');

let clientSequence = 0;

function createMockResponse() {
  return {
    status: null,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    end(body = '') {
      this.body = String(body || '');
      return this;
    },
  };
}

function createRequest(payload, {
  token = 'sk-user',
  headers = {},
  method = 'POST',
  url = '/api/mcp',
} = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.url = url;
  req.pathname = '/api/mcp';
  req.headers = {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...headers,
  };
  req.socket = { remoteAddress: `mcp-test-${clientSequence += 1}` };
  return req;
}

function authOptions({ models = ['gpt-test'] } = {}) {
  return {
    appVersion: '9.9.9',
    usageStats: {
      async getUserByApiKey(apiKey) {
        return apiKey === 'sk-user' ? { username: '测试用户' } : { username: '' };
      },
    },
    usageAccessValidator: {
      async validateKey(apiKey) {
        return apiKey === 'sk-user'
          ? { ok: true, models }
          : { ok: false, statusCode: 403, code: 'INVALID_API_KEY' };
      },
    },
    feedbackReviewer: {
      async review() { return { accepted: true, missingSections: [], message: '' }; },
    },
    feedbackSender: { async send() { return true; } },
    readPublicConfig: () => ({ modelRecommendation: { chatModel: 'gpt-test' } }),
  };
}

async function invokeMcp(payload, options = {}) {
  const { routeMcp } = createMcpRoutes({
    ...authOptions(),
    ...options,
  });
  const req = options.req || createRequest(payload, options.request || {});
  const res = createMockResponse();
  await routeMcp(req, res);
  let json = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch {}
  return { res, json };
}

function toolText(response) {
  return response.json?.result?.content?.find(item => item.type === 'text')?.text || '';
}

async function testMcpRequiresHeaderTokenAndDoesNotAcceptBodyCredential() {
  usageValidator.resetUsageRefreshBuckets();
  let lookupCalls = 0;
  const options = authOptions();
  options.usageStats.getUserByApiKey = async () => { lookupCalls += 1; return { username: '测试用户' }; };

  const missing = await invokeMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, {
    ...options,
    request: { token: '' },
  });
  assert.strictEqual(missing.res.status, 401);
  assert.match(missing.res.headers['Cache-Control'] || '', /no-store/);
  assert.strictEqual(missing.res.headers['Access-Control-Allow-Origin'], '*');
  assert.match(missing.res.headers['WWW-Authenticate'] || '', /Bearer/);
  assert.strictEqual(lookupCalls, 0);

  const bodyOnly = await invokeMcp({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { api_key: 'sk-user' },
  }, {
    ...options,
    request: { token: '' },
  });
  assert.strictEqual(bodyOnly.res.status, 401, 'a credential in JSON-RPC params must not authenticate the request');
  assert.strictEqual(lookupCalls, 0);

  const xApiKey = await invokeMcp({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, {
    ...options,
    request: { token: '', headers: { 'x-api-key': 'sk-user' } },
  });
  assert.strictEqual(xApiKey.res.status, 200, 'X-API-Key must be an accepted token header');
  assert.strictEqual(lookupCalls, 1);

  const queryOnly = await invokeMcp({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, {
    ...options,
    request: { token: '', headers: { 'x-api-key': '' }, url: '/api/mcp?token=sk-user' },
  });
  assert.strictEqual(queryOnly.res.status, 401);
}

async function testMcpInitializeAndToolsListExposeCompleteUsageSurface() {
  usageValidator.resetUsageRefreshBuckets();
  const initialized = await invokeMcp({
    jsonrpc: '2.0',
    id: 'init-1',
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  assert.strictEqual(initialized.res.status, 200);
  assert.strictEqual(initialized.json.id, 'init-1');
  assert.strictEqual(initialized.json.result.protocolVersion, '2025-03-26');
  assert.strictEqual(initialized.json.result.serverInfo.name, 'chatui-usage');
  assert.strictEqual(initialized.json.result.serverInfo.version, '9.9.9');
  assert.ok(initialized.json.result.capabilities.tools);

  const listed = await invokeMcp({ jsonrpc: '2.0', id: 'list-1', method: 'tools/list', params: {} });
  const tools = listed.json.result.tools;
  assert.strictEqual(tools.length, 9);
  assert.deepStrictEqual(tools.map(tool => tool.name), [
    'usage_get_overview',
    'usage_get_personal',
    'usage_get_rankings',
    'usage_get_user_by_name',
    'usage_get_department_summary',
    'usage_get_department_ranking',
    'usage_get_department_users',
    'usage_export_department',
    'usage_submit_feedback',
  ]);
  const rankingTool = tools.find(tool => tool.name === 'usage_get_rankings');
  assert.deepStrictEqual(rankingTool.inputSchema.properties.range.enum, PERSONAL_RANGES);
  for (const name of ['usage_get_department_summary', 'usage_get_department_ranking', 'usage_get_department_users', 'usage_export_department']) {
    const tool = tools.find(item => item.name === name);
    assert.ok(tool, `${name} must be exposed`);
    assert.ok(!Object.prototype.hasOwnProperty.call(tool.inputSchema.properties, 'department_password'), `${name} must not accept department_password`);
  }
  assert.ok(!JSON.stringify(listed.json).includes('sk-user'));
}

async function testMcpUsageToolsReusePersonalAndRankingServices() {
  usageValidator.resetUsageRefreshBuckets();
  const calls = [];
  const personal = {
    username: '测试用户',
    total_tokens: 321,
    prompt_tokens: 200,
    completion_tokens: 121,
    prompt_cached_tokens: 40,
    completion_reasoning_tokens: 7,
  };
  const ranking = [{ username: '测试用户', total_tokens: 321 }];
  const namedUser = { ...personal, total_tokens: 654 };
  const usageStats = {
    async getUserByApiKey() { return { username: '测试用户' }; },
    async getRanking(range) { calls.push(['ranking', range]); return ranking; },
    async getUserUsageByName(username, range) {
      calls.push(['user-by-name', username, range]);
      return username === '测试用户' ? namedUser : null;
    },
    async getPersonalRange(apiKey, range) { calls.push(['personal', apiKey, range]); return personal; },
  };
  const options = { ...authOptions(), usageStats };

  const overview = await invokeMcp({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'usage_get_overview', arguments: { ranking_range: 'week', personal_range: 'month' } },
  }, options);
  const overviewData = JSON.parse(toolText(overview));
  assert.strictEqual(overviewData.available, true);
  assert.deepStrictEqual(overviewData.personal, personal);
  assert.deepStrictEqual(overviewData.ranking, ranking);
  assert.deepStrictEqual(calls, [['ranking', 'week'], ['personal', 'sk-user', 'month']]);

  calls.length = 0;
  const personalResult = await invokeMcp({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'usage_get_personal', arguments: { range: 'yesterday' } },
  }, options);
  assert.deepStrictEqual(JSON.parse(toolText(personalResult)).personal, personal);
  assert.deepStrictEqual(calls, [['personal', 'sk-user', 'yesterday']]);

  calls.length = 0;
  const rankingResult = await invokeMcp({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'usage_get_rankings', arguments: { range: 'total' } },
  }, options);
  assert.deepStrictEqual(JSON.parse(toolText(rankingResult)).ranking, ranking);
  assert.deepStrictEqual(calls, [['ranking', 'total']]);

  calls.length = 0;
  const namedResult = await invokeMcp({
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: { name: 'usage_get_user_by_name', arguments: { username: ' 测试用户 ', range: 'week' } },
  }, options);
  const namedData = JSON.parse(toolText(namedResult));
  assert.strictEqual(namedData.found, true);
  assert.deepStrictEqual(namedData.user, namedUser);
  assert.deepStrictEqual(calls, [['user-by-name', '测试用户', 'week']]);

  calls.length = 0;
  const missingNamedUser = await invokeMcp({
    jsonrpc: '2.0',
    id: 14,
    method: 'tools/call',
    params: { name: 'usage_get_user_by_name', arguments: { username: '不存在', range: 'month' } },
  }, options);
  const missingData = JSON.parse(toolText(missingNamedUser));
  assert.strictEqual(missingData.found, false);
  assert.strictEqual(missingData.user, null);
  assert.deepStrictEqual(calls, [['user-by-name', '不存在', 'month']]);
}

async function testMcpJsonRpcNotificationsErrorsAndCallSemantics() {
  usageValidator.resetUsageRefreshBuckets();
  const notified = await invokeMcp({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  assert.strictEqual(notified.res.status, 202);
  assert.strictEqual(notified.res.body, '');

  const unsupported = await invokeMcp({ jsonrpc: '2.0', id: 20, method: 'prompts/list', params: {} });
  assert.strictEqual(unsupported.json.error.code, -32601);

  const unknownTool = await invokeMcp({
    jsonrpc: '2.0',
    id: 21,
    method: 'tools/call',
    params: { name: 'usage_missing_tool', arguments: {} },
  });
  assert.strictEqual(unknownTool.json.error.code, -32602);

  const invalidArguments = await invokeMcp({
    jsonrpc: '2.0',
    id: 22,
    method: 'tools/call',
    params: { name: 'usage_get_rankings', arguments: { range: 'quarter' } },
  });
  assert.strictEqual(invalidArguments.json.error.code, -32602);

  const missingUsername = await invokeMcp({
    jsonrpc: '2.0',
    id: 25,
    method: 'tools/call',
    params: { name: 'usage_get_user_by_name', arguments: { range: 'today' } },
  });
  assert.strictEqual(missingUsername.json.error.code, -32602);

  const batch = await invokeMcp([
    { jsonrpc: '2.0', id: 23, method: 'ping', params: {} },
    { jsonrpc: '2.0', id: 24, method: 'tools/list', params: {} },
  ]);
  assert.strictEqual(batch.res.status, 200);
  assert.strictEqual(batch.json.length, 2);
  assert.deepStrictEqual(batch.json[0].result, {});

  const wrongMethod = await invokeMcp({ jsonrpc: '2.0', id: 25, method: 'ping' }, {
    request: { method: 'GET' },
  });
  assert.strictEqual(wrongMethod.res.status, 405);
  assert.strictEqual(wrongMethod.res.headers.Allow, 'POST');
}

async function testMcpDepartmentToolsDoNotRequirePasswordAndExportXlsxResource() {
  usageValidator.resetUsageRefreshBuckets();
  const calls = [];
  const usageStats = {
    async getUserByApiKey() { return { username: '测试用户' }; },
    async getDepartmentRanking(range) {
      calls.push(['ranking', range]);
      return [{ department_id: 'dept-1', department_name: '研发部', total_tokens: 100 }];
    },
    async getDepartmentUsers(departmentId, range) {
      calls.push(['users', departmentId, range]);
      return [{ username: '测试用户', total_tokens: 100 }];
    },
    async getAllDepartmentUsers(range) {
      calls.push(['all-users', range]);
      return [{ department_id: 'dept-1', username: '测试用户', total_tokens: 100 }];
    },
    async getDepartmentRangeBounds(range) {
      calls.push(['bounds', range]);
      return { start_time: new Date('2026-11-18T00:00:00Z'), end_time: new Date('2026-11-18T01:00:00Z') };
    },
  };
  const options = { ...authOptions(), usageStats };

  const ranking = await invokeMcp({
    jsonrpc: '2.0', id: 31, method: 'tools/call',
    params: { name: 'usage_get_department_ranking', arguments: { range: 'week' } },
  }, options);
  assert.strictEqual(JSON.parse(toolText(ranking)).ranking[0].department_name, '研发部');

  const summary = await invokeMcp({
    jsonrpc: '2.0', id: 35, method: 'tools/call',
    params: { name: 'usage_get_department_summary', arguments: { range: 'month' } },
  }, options);
  const summaryData = JSON.parse(toolText(summary));
  assert.strictEqual(summaryData.authorized, true);
  assert.strictEqual(summaryData.ranking[0].department_name, '研发部');

  const users = await invokeMcp({
    jsonrpc: '2.0', id: 32, method: 'tools/call',
    params: { name: 'usage_get_department_users', arguments: { department_id: 'dept-1', range: 'month' } },
  }, options);
  assert.strictEqual(JSON.parse(toolText(users)).users[0].username, '测试用户');

  const exported = await invokeMcp({
    jsonrpc: '2.0', id: 33, method: 'tools/call',
    params: { name: 'usage_export_department', arguments: { range: 'today' } },
  }, options);
  const resource = exported.json.result.content.find(item => item.type === 'resource');
  assert.ok(resource, 'department export must return an embedded MCP resource');
  assert.strictEqual(resource.resource.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.strictEqual(Buffer.from(resource.resource.blob, 'base64').length, JSON.parse(toolText(exported)).sizeBytes);
  assert.deepStrictEqual(calls, [
    ['ranking', 'week'],
    ['ranking', 'month'],
    ['users', 'dept-1', 'month'],
    ['ranking', 'today'],
    ['all-users', 'today'],
    ['bounds', 'today'],
  ]);

  const rejectedPassword = await invokeMcp({
    jsonrpc: '2.0', id: 34, method: 'tools/call',
    params: { name: 'usage_get_department_ranking', arguments: { department_password: 'dep-secret', range: 'today' } },
  }, options);
  assert.strictEqual(rejectedPassword.json.error.code, -32602);
}

async function testMcpFeedbackUsesSharedReviewBeforeDelivery() {
  usageValidator.resetUsageRefreshBuckets();
  const calls = [];
  const baseStats = {
    async getUserByApiKey() { return { username: '测试用户' }; },
    async getPersonalRange() { throw new Error('MCP feedback must use the authenticated username'); },
  };
  const acceptedOptions = {
    ...authOptions(),
    usageStats: baseStats,
    feedbackReviewer: {
      async review(content, access) {
        calls.push(['review', content, access]);
        return { accepted: true, missingSections: [], message: '' };
      },
    },
    feedbackSender: {
      async send(content, options) { calls.push(['send', content, options]); return true; },
    },
  };
  const feedback = {
    problem_description: '点击发送后没有出现消息。',
    reproduction_description: '在输入框输入文字后点击发送。',
    expected_result: '消息应该立即出现在会话中。',
    route_model: 'route-test',
  };
  const accepted = await invokeMcp({
    jsonrpc: '2.0', id: 40, method: 'tools/call',
    params: { name: 'usage_submit_feedback', arguments: feedback },
  }, acceptedOptions);
  assert.strictEqual(JSON.parse(toolText(accepted)).ok, true);
  assert.strictEqual(JSON.parse(toolText(accepted)).chat_model, 'gpt-test');
  assert.deepStrictEqual(calls.map(call => call[0]), ['review', 'send']);
  assert.match(calls[0][1], /【问题描述】/);
  assert.match(calls[0][1], /【复现描述】/);
  assert.match(calls[0][1], /【期望结果】/);
  assert.deepStrictEqual(calls[1][2], { username: '测试用户', routeModel: 'route-test', chatModel: 'gpt-test' });

  const manualModelCalls = [];
  const manualModel = await invokeMcp({
    jsonrpc: '2.0', id: 42, method: 'tools/call',
    params: {
      name: 'usage_submit_feedback',
      arguments: { ...feedback, chat_model: 'manual-review-model' },
    },
  }, {
    ...authOptions({ models: [] }),
    usageStats: baseStats,
    feedbackReviewer: {
      async review(content, access) {
        manualModelCalls.push(['review', content, access]);
        return { accepted: true, missingSections: [], message: '' };
      },
    },
    feedbackSender: {
      async send(content, options) { manualModelCalls.push(['send', content, options]); return true; },
    },
  });
  assert.strictEqual(JSON.parse(toolText(manualModel)).chat_model, 'manual-review-model');
  assert.deepStrictEqual(manualModelCalls[0][2], { apiKey: 'sk-user', model: 'manual-review-model' });
  assert.deepStrictEqual(manualModelCalls[1][2], { username: '测试用户', routeModel: 'route-test', chatModel: 'manual-review-model' });

  let rejectedSends = 0;
  const rejected = await invokeMcp({
    jsonrpc: '2.0', id: 41, method: 'tools/call',
    params: {
      name: 'usage_submit_feedback',
      arguments: {
        problem_description: '不好用',
        reproduction_description: '打开页面',
        expected_result: '请优化',
      },
    },
  }, {
    ...authOptions(),
    usageStats: baseStats,
    feedbackReviewer: {
      async review() {
        return { accepted: false, missingSections: ['problem_description'], message: '请补充具体问题现象。' };
      },
    },
    feedbackSender: { async send() { rejectedSends += 1; return true; } },
  });
  assert.strictEqual(rejected.json.result.isError, true);
  assert.match(toolText(rejected), /审核未通过/);
  assert.strictEqual(rejectedSends, 0);
}

async function testMcpInternalErrorsDoNotLogSensitiveDependencyMessages() {
  usageValidator.resetUsageRefreshBuckets();
  const previousPassword = process.env.USAGE_DEPARTMENT_PASSWORD;
  process.env.USAGE_DEPARTMENT_PASSWORD = 'department-log-secret';
  const logged = [];
  const sensitiveFeedback = 'feedback-body-secret';
  const sensitiveBase64 = 'base64-export-secret';
  try {
    const usageStats = {
      async getUserByApiKey(apiKey) {
        assert.strictEqual(apiKey, 'sk-log-secret');
        return { username: '测试用户' };
      },
      async getDepartmentRanking() {
        throw new Error('database query failed: ' + sensitiveFeedback + ' ' + sensitiveBase64);
      },
    };
    const errorLog = { log(error, context) { logged.push({ message: error?.message, context }); } };
    const result = await invokeMcp({
      jsonrpc: '2.0', id: 50, method: 'tools/call',
      params: {
        name: 'usage_get_department_ranking',
        arguments: { range: 'today' },
      },
    }, {
      ...authOptions(),
      usageStats,
      usageAccessValidator: { async validateKey() { return { ok: true, models: ['gpt-test'] }; } },
      errorLog,
      request: { token: 'sk-log-secret' },
    });
    assert.strictEqual(result.json.result.isError, true);
    assert.match(toolText(result), /工具调用失败/);

    const feedbackResult = await invokeMcp({
      jsonrpc: '2.0', id: 51, method: 'tools/call',
      params: {
        name: 'usage_submit_feedback',
        arguments: {
          problem_description: sensitiveFeedback,
          reproduction_description: sensitiveFeedback,
          expected_result: sensitiveFeedback,
        },
      },
    }, {
      ...authOptions(),
      usageStats,
      usageAccessValidator: { async validateKey() { return { ok: true, models: ['gpt-test'] }; } },
      feedbackReviewer: {
        async review() { throw new Error('review failed: ' + sensitiveFeedback + ' ' + sensitiveBase64); },
      },
      feedbackSender: { async send() { return true; } },
      errorLog,
      request: { token: 'sk-log-secret' },
    });
    assert.strictEqual(feedbackResult.json.result.isError, true);

    const deliveryFailure = await invokeMcp({
      jsonrpc: '2.0', id: 53, method: 'tools/call',
      params: {
        name: 'usage_submit_feedback',
        arguments: {
          problem_description: sensitiveFeedback,
          reproduction_description: sensitiveFeedback,
          expected_result: sensitiveFeedback,
        },
      },
    }, {
      ...authOptions(),
      usageStats,
      usageAccessValidator: {
        async validateKey() { return { ok: true, models: ['gpt-test'] }; },
      },
      feedbackReviewer: {
        async review() { return { accepted: true, missingSections: [], message: '' }; },
      },
      feedbackSender: {
        async send() {
          const error = new Error('delivery failed: ' + sensitiveFeedback + ' ' + sensitiveBase64);
          error.code = 'FEEDBACK_DELIVERY_FAILED';
          error.statusCode = 502;
          throw error;
        },
      },
      errorLog,
      request: { token: 'sk-log-secret' },
    });
    assert.strictEqual(deliveryFailure.json.result.isError, true);
    assert.match(toolText(deliveryFailure), /反馈发送失败/);
    assert.doesNotMatch(toolText(deliveryFailure), /feedback-body-secret|base64-export-secret/);

    const authFailure = await invokeMcp({ jsonrpc: '2.0', id: 52, method: 'initialize', params: {} }, {
      ...authOptions(),
      usageStats: {
        async getUserByApiKey() { throw new Error('lookup failed: ' + sensitiveBase64); },
      },
      errorLog,
      request: { token: 'sk-log-secret' },
    });
    assert.strictEqual(authFailure.res.status, 503);

    const serializedLog = JSON.stringify(logged);
    assert.doesNotMatch(serializedLog, /sk-log-secret|department-log-secret|feedback-body-secret|base64-export-secret/);
    assert.match(serializedLog, /MCP tool execution failed/);
    assert.match(serializedLog, /MCP API key lookup failed/);
  } finally {
    if (previousPassword === undefined) delete process.env.USAGE_DEPARTMENT_PASSWORD;
    else process.env.USAGE_DEPARTMENT_PASSWORD = previousPassword;
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function testMcpEndpointIsMountedBeforeGenericApiProxy() {
  const { server } = createApp();
  const baseUrl = await listen(server);
  try {
    const preflight = await fetch(baseUrl + '/api/mcp', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://mcp.example.test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization,Mcp-Protocol-Version',
      },
    });
    assert.strictEqual(preflight.status, 204);
    assert.match(preflight.headers.get('cache-control') || '', /no-store/);
    assert.match(preflight.headers.get('access-control-allow-headers') || '', /Authorization/i);

    const response = await fetch(`${baseUrl}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.strictEqual(response.status, 401);
    assert.match(response.headers.get('cache-control') || '', /no-store/);
    assert.strictEqual(response.headers.get('set-cookie'), null, 'MCP must not issue principal cookies');
    const payload = await response.json();
    assert.strictEqual(payload.error.code, 'MCP_AUTH_REQUIRED');
  } finally {
    await close(server);
  }
}

module.exports = [
  testMcpRequiresHeaderTokenAndDoesNotAcceptBodyCredential,
  testMcpInitializeAndToolsListExposeCompleteUsageSurface,
  testMcpUsageToolsReusePersonalAndRankingServices,
  testMcpJsonRpcNotificationsErrorsAndCallSemantics,
  testMcpDepartmentToolsDoNotRequirePasswordAndExportXlsxResource,
  testMcpFeedbackUsesSharedReviewBeforeDelivery,
  testMcpInternalErrorsDoNotLogSensitiveDependencyMessages,
  testMcpEndpointIsMountedBeforeGenericApiProxy,
];
