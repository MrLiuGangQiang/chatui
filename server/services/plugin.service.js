'use strict';

const fs = require('fs');
const { Agent } = require('undici');
const { createPublicLookup, assertResolvedUpstreamUrl, privateUpstreamAllowed } = require('../security/url-policy');
const pluginContract = require('../../shared/plugin-contract');

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const MAX_RESULT_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const dispatcher = new Agent({ connect: { lookup: createPublicLookup({ allowPrivate: false }) } });

function pluginError(message, code = 'PLUGIN_REQUEST_FAILED', statusCode = 502) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function readConfig({ filePath, fsImpl = fs } = {}) {
  if (!filePath) return { schemaVersion: pluginContract.SCHEMA_VERSION, plugins: [] };
  try {
    const stat = fsImpl.statSync(filePath);
    if (!stat.isFile() || stat.size > pluginContract.MAX_CONFIG_BYTES) return { schemaVersion: pluginContract.SCHEMA_VERSION, plugins: [] };
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    return pluginContract.normalizePluginConfig(parsed) || { schemaVersion: pluginContract.SCHEMA_VERSION, plugins: [] };
  } catch {
    return { schemaVersion: pluginContract.SCHEMA_VERSION, plugins: [] };
  }
}

function bearerToken(auth = {}) {
  if (auth?.type !== 'bearer') return '';
  return String(process.env[auth.env] || '').trim();
}

async function safeFetch(url, options = {}, fetchImpl = fetch, assertUrlImpl = assertResolvedUpstreamUrl) {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!await assertUrlImpl(current, { allowPrivate: privateUpstreamAllowed() })) {
      throw pluginError('插件地址不允许访问，请检查插件配置', 'PLUGIN_ADDRESS_BLOCKED', 400);
    }
    const response = await fetchImpl(current, {
      ...options,
      redirect: 'manual',
      dispatcher,
      signal: options.signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    try { response.body?.cancel?.(); } catch {}
    if (!location || hop === MAX_REDIRECTS) throw pluginError('插件地址重定向无效', 'PLUGIN_REDIRECT_INVALID');
    current = new URL(location, current);
  }
  throw pluginError('插件地址重定向次数过多', 'PLUGIN_REDIRECT_INVALID');
}

async function readBoundedText(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_RESULT_BYTES) {
    try { response.body?.cancel?.(); } catch {}
    throw pluginError('插件返回内容过大', 'PLUGIN_RESULT_TOO_LARGE');
  }
  const reader = response.body?.getReader?.();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value?.byteLength || 0;
    if (received > MAX_RESULT_BYTES) {
      try { await reader.cancel(); } catch {}
      throw pluginError('插件返回内容过大', 'PLUGIN_RESULT_TOO_LARGE');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function parsePluginResponse(response) {
  const text = await readBoundedText(response);
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { return { content: text.slice(0, MAX_RESULT_BYTES) }; }
}

function httpPath(tool, args = {}) {
  const pathKeys = new Set();
  const path = String(tool.path || '').replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key) => {
    const value = args[key];
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw pluginError(`路径参数 ${key} 缺失或类型无效`, 'PLUGIN_ARGUMENT_INVALID', 400);
    }
    pathKeys.add(key);
    return encodeURIComponent(String(value));
  });
  return { path, pathKeys };
}

function httpQuery(tool, args = {}, pathKeys = new Set()) {
  if (tool.method !== 'GET') return '';
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(args || {})) {
    if (pathKeys.has(key) || value === undefined || value === null) continue;
    if (Array.isArray(value) || typeof value === 'object') query.set(key, JSON.stringify(value));
    else query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

function normalizeResult(value) {
  if (typeof value === 'string') return value.slice(0, MAX_RESULT_BYTES);
  try {
    return JSON.stringify(value).slice(0, MAX_RESULT_BYTES);
  } catch {
    return String(value || '').slice(0, MAX_RESULT_BYTES);
  }
}

function createPluginService(options = {}) {
  const assertUrl = options.assertUrl || assertResolvedUpstreamUrl;
  const fetchImpl = options.fetchImpl || fetch;
  const configPath = options.configPath || '';
  const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs || DEFAULT_TIMEOUT_MS), 120000));
  const mcpSessions = new Map();
  let currentConfig = pluginContract.normalizePluginConfig(options.initialConfig)
    || readConfig({ filePath: configPath, fsImpl: options.fsImpl });

  function reload() {
    currentConfig = readConfig({ filePath: configPath, fsImpl: options.fsImpl });
    return publicPlugins();
  }

  function publicPlugins() {
    return currentConfig.plugins.filter(plugin => plugin.enabled !== false).map(pluginContract.publicPlugin);
  }

  function findPlugin(pluginId) {
    const id = String(pluginId || '').trim();
    return currentConfig.plugins.find(plugin => plugin.id === id && plugin.enabled !== false) || null;
  }

  function resolveSelectedTools(toolIds = []) {
    const requested = (Array.isArray(toolIds) ? toolIds : []).map(value => String(value || '').trim()).filter(Boolean).slice(0, 32);
    const selected = [];
    const seen = new Set();
    for (const toolId of requested) {
      const separator = toolId.lastIndexOf(':');
      if (separator <= 0) continue;
      const pluginId = toolId.slice(0, separator);
      const toolName = toolId.slice(separator + 1);
      const plugin = findPlugin(pluginId);
      const tool = plugin?.tools?.find(item => item.name === toolName);
      const key = `${pluginId}:${toolName}`;
      if (!plugin || !tool || seen.has(key)) continue;
      if (tool.requiresApproval === true) {
        throw pluginError(`插件 ${plugin.label} 的 ${tool.name} 需要逐次确认，当前版本不能由模型自动调用`, 'PLUGIN_APPROVAL_REQUIRED', 400);
      }
      seen.add(key);
      selected.push({ plugin, tool, toolId: key });
    }
    return selected;
  }

  function chatTools(toolIds = []) {
    return resolveSelectedTools(toolIds).map(({ tool }) => pluginContract.chatCompletionsTool(tool));
  }

  async function executeHttpTool(plugin, tool, args = {}, context = {}) {
    const failure = pluginContract.validateArguments(args, tool.inputSchema);
    if (failure) throw pluginError(failure, 'PLUGIN_ARGUMENT_INVALID', 400);
    const token = bearerToken(plugin.auth);
    const { path, pathKeys } = httpPath(tool, args);
    const url = `${plugin.baseUrl}${path}${httpQuery(tool, args, pathKeys)}`;
    const init = {
      method: tool.method,
      headers: {
        Accept: 'application/json, text/plain;q=0.8, */*;q=0.5',
        ...(tool.method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: context.signal,
    };
    if (tool.method !== 'GET') init.body = JSON.stringify(args);
    const response = await safeFetch(url, init, fetchImpl, assertUrl);
    if (!response.ok) {
      await readBoundedText(response).catch(() => '');
      throw pluginError(`插件 ${plugin.label} 返回 ${response.status}`, 'PLUGIN_HTTP_ERROR', response.status >= 500 ? 502 : 400);
    }
    return normalizeResult(await parsePluginResponse(response));
  }

  function parseMcpMessage(text = '') {
    const trimmed = String(text || '').trim();
    if (!trimmed) return {};
    if (trimmed.startsWith('{')) return JSON.parse(trimmed);
    for (const block of trimmed.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      return JSON.parse(data);
    }
    throw pluginError('MCP 服务返回了无法解析的事件', 'MCP_RESPONSE_INVALID');
  }

  async function mcpRpc(plugin, method, params = {}, context = {}) {
    const token = bearerToken(plugin.auth);
    const sessionId = mcpSessions.get(plugin.id) || '';
    const response = await safeFetch(plugin.serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), method, params }),
      signal: context.signal,
    }, fetchImpl, assertUrl);
    const text = await readBoundedText(response);
    if (!response.ok) throw pluginError(`MCP 插件 ${plugin.label} 返回 ${response.status}`, 'MCP_HTTP_ERROR', response.status >= 500 ? 502 : 400);
    const nextSession = response.headers.get('mcp-session-id');
    if (nextSession) mcpSessions.set(plugin.id, nextSession);
    const message = parseMcpMessage(text);
    if (message.error) throw pluginError(`MCP 插件 ${plugin.label} 调用失败`, 'MCP_TOOL_ERROR', 502);
    return message.result || {};
  }

  async function ensureMcpSession(plugin, context = {}) {
    if (mcpSessions.has(plugin.id)) return;
    await mcpRpc(plugin, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'chatui-plugins', version: '1' },
    }, context);
    // Streamable HTTP servers may return 202 for notifications. The safe fetch
    // contract still resolves it; no response body means the notification is
    // complete. Invalid session IDs fail on the next tools/list call.
    await safeFetch(plugin.serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': mcpSessions.get(plugin.id) || '',
        ...(bearerToken(plugin.auth) ? { Authorization: `Bearer ${bearerToken(plugin.auth)}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: context.signal,
    }, fetchImpl, assertUrl).then(async response => { await readBoundedText(response).catch(() => ''); });
  }

  async function mcpTool(plugin, allowedTool, context = {}) {
    await ensureMcpSession(plugin, context);
    const result = await mcpRpc(plugin, 'tools/list', {}, context);
    const remote = (Array.isArray(result.tools) ? result.tools : []).find(tool => tool?.name === allowedTool.name);
    if (!remote) throw pluginError(`MCP 插件 ${plugin.label} 没有授权工具 ${allowedTool.name}`, 'MCP_TOOL_NOT_FOUND', 400);
    return { ...allowedTool, inputSchema: pluginContract.normalizeJsonSchema(remote.inputSchema) || { type: 'object', properties: {}, additionalProperties: false } };
  }

  function mcpToolResult(result = {}) {
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter(item => item && typeof item === 'object' && String(item.type || 'text') === 'text')
      .map(item => String(item.text || ''))
      .join('\n');
    if (text) return normalizeResult(text);
    if (result.structuredContent && typeof result.structuredContent === 'object') return normalizeResult(result.structuredContent);
    return normalizeResult(result);
  }

  async function callTool(toolId, args = {}, context = {}) {
    const [selected] = resolveSelectedTools([toolId]);
    if (!selected) throw pluginError('插件工具不存在或未启用', 'PLUGIN_TOOL_NOT_FOUND', 404);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const linkedAbort = () => controller.abort();
    context.signal?.addEventListener('abort', linkedAbort, { once: true });
    try {
      if (selected.plugin.type === 'http') {
        return { pluginId: selected.plugin.id, toolName: selected.tool.name, content: await executeHttpTool(selected.plugin, selected.tool, args, { signal: controller.signal }) };
      }
      const tool = await mcpTool(selected.plugin, selected.tool, { signal: controller.signal });
      const failure = pluginContract.validateArguments(args, tool.inputSchema);
      if (failure) throw pluginError(failure, 'PLUGIN_ARGUMENT_INVALID', 400);
      const result = await mcpRpc(selected.plugin, 'tools/call', { name: tool.name, arguments: args }, { signal: controller.signal });
      if (result?.isError === true) throw pluginError(`MCP 插件 ${selected.plugin.label} 工具执行失败`, 'MCP_TOOL_ERROR', 502);
      return { pluginId: selected.plugin.id, toolName: tool.name, content: mcpToolResult(result) };
    } catch (error) {
      if (error?.name === 'AbortError') throw pluginError('插件调用超时或已被停止', 'PLUGIN_TIMEOUT', 504);
      throw error;
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', linkedAbort);
    }
  }

  return Object.freeze({ reload, publicPlugins, chatTools, resolveSelectedTools, callTool });
}

module.exports = { createPluginService, readConfig, normalizeResult };




