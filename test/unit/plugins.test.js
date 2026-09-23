'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { JSDOM } = require('jsdom');
const { createChatJobHandlers } = require('../../server/jobs/chat');
const { JobStore } = require('../../server/jobs/store');
const { createRequestPrincipalService } = require('../../server/security/request-principal');
const { makeDispatchContract } = require('../helpers/dispatch-contract-fixture');

const pluginContract = require('../../shared/plugin-contract');
const { createPluginService } = require('../../server/services/plugin.service');
const pluginService = require('../../client/services/plugin-service');
const pluginWorkflowModule = require('../../client/features/plugins/workflow');

const HTTP_CONFIG = {
  schema_version: 'chatui_plugins.v1',
  plugins: [{
    id: 'weather',
    type: 'http',
    label: '天气',
    enabled: true,
    baseUrl: 'https://api.example.com',
    auth: { type: 'bearer', env: 'CHATUI_TEST_WEATHER_KEY' },
    tools: [{
      name: 'get_weather',
      description: '查询城市天气',
      method: 'GET',
      path: '/v1/weather/{city}',
      risk: 'read',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string', minLength: 1, maxLength: 40 } },
        required: ['city'],
        additionalProperties: false,
      },
    }],
  }],
};

const MCP_CONFIG = {
  schema_version: 'chatui_plugins.v1',
  plugins: [{
    id: 'company',
    type: 'mcp',
    label: '企业工具',
    enabled: true,
    serverUrl: 'https://mcp.example.com/mcp',
    auth: { type: 'none' },
    tools: [{ name: 'search_docs', risk: 'read', requiresApproval: false }],
  }],
};

function jsonResponse(value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function testPluginConfigRequiresHttpsAndFailsClosed() {
  assert.strictEqual(pluginContract.normalizePluginConfig(HTTP_CONFIG).plugins[0].id, 'weather');
  const privateConfig = JSON.parse(JSON.stringify(HTTP_CONFIG));
  privateConfig.plugins[0].baseUrl = 'http://api.example.com';
  assert.strictEqual(pluginContract.normalizePluginConfig(privateConfig), null);
  const duplicateTools = {
    schema_version: 'chatui_plugins.v1',
    plugins: [
      HTTP_CONFIG.plugins[0],
      { ...MCP_CONFIG.plugins[0], id: 'company-two', tools: [{ name: 'get_weather' }] },
    ],
  };
  assert.strictEqual(pluginContract.normalizePluginConfig(duplicateTools), null,
    'function tool names must be globally unique so a model tool call cannot be ambiguous');
}

function testHttpPluginValidatesArgumentsAndReturnsBoundedJson() {
  process.env.CHATUI_TEST_WEATHER_KEY = 'secret-token';
  const requests = [];
  const service = createPluginService({
    initialConfig: HTTP_CONFIG,
    assertUrl: async () => true,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({ city: '上海', temperature: 26 });
    },
  });

  return service.callTool('weather:get_weather', { city: '上海' }).then(result => {
    delete process.env.CHATUI_TEST_WEATHER_KEY;
    assert.deepStrictEqual(result, {
      pluginId: 'weather',
      toolName: 'get_weather',
      content: JSON.stringify({ city: '上海', temperature: 26 }),
    });
    assert.strictEqual(requests[0].url, 'https://api.example.com/v1/weather/%E4%B8%8A%E6%B5%B7');
    assert.ok(!requests[0].url.includes('?'), 'a path parameter must not also be duplicated into the query string');
    assert.strictEqual(requests[0].init.headers.Authorization, 'Bearer secret-token');
    return assert.rejects(
      () => service.callTool('weather:get_weather', { city: '上海', extra: 1 }),
      /unsupported fields/u,
    );
  }).catch(error => {
    delete process.env.CHATUI_TEST_WEATHER_KEY;
    throw error;
  });
}

function testMcpPluginInitializesListsToolsAndCallsOnlyAllowedTool() {
  const calls = [];
  const service = createPluginService({
    initialConfig: MCP_CONFIG,
    assertUrl: async () => true,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body.method);
      if (body.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }, { 'Mcp-Session-Id': 'session-1' });
      if (body.method === 'tools/list') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              { name: 'search_docs', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
              { name: 'delete_everything', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
            ],
          },
        });
      }
      if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
      if (body.method === 'tools/call') {
        assert.strictEqual(body.params.name, 'search_docs');
        assert.deepStrictEqual(body.params.arguments, { query: '架构' });
        return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '架构文档结果' }] } });
      }
      return new Response('', { status: 202 });
    },
  });

  return service.callTool('company:search_docs', { query: '架构' }).then(result => {
    assert.deepStrictEqual(calls, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    assert.strictEqual(result.content, '架构文档结果');
    return assert.rejects(
      () => service.callTool('company:delete_everything', {}),
      /插件工具不存在或未启用/u,
    );
  });
}

function testSelectedPluginChatUsesManagedChatJobProtocol() {
  const storage = new Map();
  pluginService.saveSelectedToolIds(['weather:get_weather'], {
    getItem: key => storage.get(key),
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  });
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url) === '/api/chat-jobs' && init.method === 'POST') {
      return jsonResponse({ id: 'chatjob-plugins01', status: 'running' });
    }
    return jsonResponse({
      id: 'chatjob-plugins01',
      status: 'done',
      metrics: { durationMs: 12 },
      pluginTrace: [{ pluginId: 'weather', toolName: 'get_weather', status: 'done' }],
      data: { choices: [{ message: { content: '上海 26 度' } }] },
    });
  };

  return pluginService.runPluginChat({
    fetch: fetchImpl,
    storage: {
      getItem: key => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    config: { baseUrl: 'https://model.example.com/v1', apiKey: 'model-key' },
    model: 'chat-model',
    messages: [{ role: 'user', content: '上海天气' }],
    jobId: 'chatjob-plugins01',
    requestPurpose: 'final_execution',
    dispatchContract: { operation: 'plain_chat' },
    bindingEvidence: [],
    submissionId: 'submission-1',
  }).then(result => {
    assert.strictEqual(result.content, '上海 26 度');
    assert.strictEqual(result.metrics.durationMs, 12);
    const created = JSON.parse(requests[0].init.body);
    assert.strictEqual(created.api, 'chat');
    assert.deepStrictEqual(created.pluginToolIds, ['weather:get_weather']);
    assert.strictEqual(created.payload.stream, false);
    assert.strictEqual(created.requestPurpose, 'final_execution');
    assert.strictEqual(created.submissionId, 'submission-1');
  });
}

function testPluginPanelShowsHttpAndMcpToolsAndLocksApprovalTools() {
  const dom = new JSDOM('<button id="pluginBtn"><span class="plugin-count"></span></button><div id="pluginPanel" aria-hidden="true"><div id="pluginList"></div><button id="pluginPanelClose"></button><button id="pluginPanelSave"></button></div>');
  const button = dom.window.document.getElementById('pluginBtn');
  const panel = dom.window.document.getElementById('pluginPanel');
  const fakeService = {
    selectedToolIds: () => ['http-one:read'],
    saveSelectedToolIds: ids => ids,
    listPlugins: async () => [
      { id: 'http-one', type: 'http', label: 'HTTP', tools: [{ name: 'read', description: 'Read', requiresApproval: false }] },
      { id: 'mcp-one', type: 'mcp', label: 'MCP', tools: [{ name: 'write', description: 'Write', requiresApproval: true }] },
    ],
    runPluginChat: async () => ({}),
  };
  const workflow = pluginWorkflowModule.createPluginWorkflow({
    document: dom.window.document,
    button,
    panel,
    list: dom.window.document.getElementById('pluginList'),
    closeButton: dom.window.document.getElementById('pluginPanelClose'),
    saveButton: dom.window.document.getElementById('pluginPanelSave'),
    pluginService: fakeService,
  });

  workflow.initPanel();
  return workflow.loadPlugins().then(() => {
    button.click();
    assert.strictEqual(panel.getAttribute('aria-hidden'), 'false');
    const inputs = [...panel.querySelectorAll('input')];
    assert.strictEqual(inputs.length, 2);
    assert.strictEqual(inputs[0].checked, true);
    assert.strictEqual(inputs[1].disabled, true);
    inputs[0].checked = true;
    dom.window.document.getElementById('pluginPanelSave').click();
    assert.strictEqual(panel.getAttribute('aria-hidden'), 'true');
    assert.strictEqual(button.title, '插件：已启用 1 个工具');
  });
}

async function testManagedPluginChatRejectsResponsesTransportBeforeJobCreation() {
  const principalService = createRequestPrincipalService({ secret: 'a'.repeat(32) });
  const principal = principalService.attach({}, {});
  const handlers = createChatJobHandlers({
    chatJobs: new JobStore('chat'),
    notifyJob: () => {},
    pluginService: {
      chatTools: () => [{ type: 'function', function: { name: 'get_weather' } }],
      resolveSelectedTools: () => [{ plugin: { id: 'weather' }, tool: { name: 'get_weather' } }],
    },
  });
  const res = {
    status: null,
    headers: {},
    body: '',
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(body = '') { this.body = String(body || ''); },
  };
  const body = {
    jobId: 'chatjob-plugin-responses',
    baseUrl: 'https://model.example.com/v1',
    apiKey: 'model-key',
    api: 'responses',
    payload: { model: 'chat-model', input: [{ role: 'user', content: '上海天气' }], stream: false },
    pluginToolIds: ['weather:get_weather'],
    requestPurpose: 'final_execution',
    dispatchContract: makeDispatchContract({ operation: 'plain_chat', prompt: '上海天气' }),
    bindingEvidence: [],
  };
  const req = Readable.from([JSON.stringify(body)]);
  req.url = '/api/chat-jobs';
  req.method = 'POST';
  req.headers = {};
  req.authPrincipal = principal;

  await handlers.startChatJob(req, res);
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(JSON.parse(res.body), {
    error: {
      message: '当前模型接口不支持插件调用，请使用 Chat Completions 兼容模型',
      code: 'PLUGIN_TRANSPORT_UNSUPPORTED',
    },
  });
}

function testChatWorkflowBundlesPluginModulesAndUsesPluginBranchOnlyAfterSelection() {
  const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const workflow = fs.readFileSync(path.join(__dirname, '../../client/app/chat-workflow.js'), 'utf8');
  assert.ok(html.includes('client/services/plugin-service.js'), 'plugin service must be bundled');
  assert.ok(html.includes('client/features/plugins/workflow.js'), 'plugin panel workflow must be bundled');
  assert.ok(workflow.includes("pluginWorkflow?.selectedToolIds?.().length>0"),
    'chat workflow must only replace the streaming request when plugin tools are explicitly selected');
}

module.exports = [
  testPluginConfigRequiresHttpsAndFailsClosed,
  testHttpPluginValidatesArgumentsAndReturnsBoundedJson,
  testMcpPluginInitializesListsToolsAndCallsOnlyAllowedTool,
  testSelectedPluginChatUsesManagedChatJobProtocol,
  testPluginPanelShowsHttpAndMcpToolsAndLocksApprovalTools,
  testManagedPluginChatRejectsResponsesTransportBeforeJobCreation,
  testChatWorkflowBundlesPluginModulesAndUsesPluginBranchOnlyAfterSelection,
];









