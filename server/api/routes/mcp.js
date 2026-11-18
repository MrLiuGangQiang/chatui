'use strict';

const { readBody } = require('../../http/body');
const { send, sendJson } = require('../../http/response');
const pluginContract = require('../../../shared/plugin-contract');
const {
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  SERVER_TITLE,
  SUPPORTED_PROTOCOL_VERSIONS,
  TOOLS,
  getToolDefinition,
  jsonRpcError,
  jsonRpcResult,
  negotiateProtocolVersion,
  textContent,
  toolErrorResult,
  toolResult,
} = require('../../mcp/contract');
const { McpToolError, createMcpUsageService } = require('../../services/mcp-usage.service');
const usageValidator = require('../../validators/usage.validator');

const MAX_MCP_BODY_BYTES = 1024 * 1024;
const MAX_API_KEY_LENGTH = 8192;
const MCP_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
});

function extractMcpApiKey(headers = {}) {
  const authorization = String(headers.authorization || headers.Authorization || '').trim();
  const bearer = authorization.match(/^Bearer\s+([^\s]+)$/i);
  if (bearer) return bearer[1].trim();
  return String(headers['x-api-key'] || headers['X-API-Key'] || '').trim();
}

function httpError(res, statusCode, message, code, extraHeaders = {}) {
  return sendJson(res, statusCode, { error: { message, code } }, {
    ...MCP_HEADERS,
    ...extraHeaders,
  });
}

function rpcHttpResponse(res, statusCode, payload) {
  return sendJson(res, statusCode, payload, MCP_HEADERS);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function discardUnreadBody(req) {
  try { req.resume?.(); } catch {}
}

function logMcpInternalError(errorLog, message, code, context = {}) {
  if (typeof errorLog?.log !== 'function') return;
  const safeError = new Error(message);
  safeError.name = 'McpInternalError';
  safeError.code = code;
  try { errorLog.log(safeError, context); } catch {}
}

function isNotification(message) {
  return !Object.prototype.hasOwnProperty.call(message || {}, 'id');
}

function validRequestId(id) {
  return id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

function resourceToolResult(value = {}) {
  return {
    content: [
      textContent({
        filename: value.filename,
        mimeType: value.mimeType,
        range: value.range,
        sizeBytes: value.sizeBytes,
      }),
      {
        type: 'resource',
        resource: {
          uri: `chatui://usage/department-export/${encodeURIComponent(value.range || 'total')}.xlsx`,
          mimeType: value.mimeType,
          blob: value.base64,
        },
      },
    ],
  };
}

function resultToMcpContent(value) {
  return value?.kind === 'resource' ? resourceToolResult(value) : toolResult(value);
}

function createMcpRoutes({
  appVersion = 'unknown',
  usageStats = null,
  usageAccessValidator = null,
  feedbackReviewer = null,
  feedbackSender = null,
  readPublicConfig = null,
  errorLog = null,
} = {}) {
  const mcpUsageService = createMcpUsageService({
    usageStats,
    feedbackReviewer,
    feedbackSender,
    checkRateLimit: (name, context) => checkRateLimit(name, context?.req),
    readPublicConfig,
  });

  function checkRateLimit(name, req) {
    const options = name === 'feedback'
      ? { limit: 5, windowMs: 60 * 1000 }
      : name === 'department'
        ? { limit: 20, windowMs: 60 * 1000 }
        : undefined;
    return usageValidator.checkUsageRefreshLimit(req, `mcp:${name}`, options);
  }

  async function authenticate(req) {
    const apiKey = extractMcpApiKey(req.headers || {});
    if (!apiKey || apiKey.length > MAX_API_KEY_LENGTH) {
      return { statusCode: 401, code: 'MCP_AUTH_REQUIRED', message: '缺少 MCP 访问令牌，请通过 Authorization: Bearer <API Key> 提供用户密钥' };
    }
    if (!usageStats) {
      return { statusCode: 503, code: 'MCP_USAGE_UNAVAILABLE', message: '使用统计功能未启用，MCP 服务暂不可用' };
    }
    let user;
    try {
      user = await usageStats.getUserByApiKey(apiKey);
    } catch {
      logMcpInternalError(errorLog, 'MCP API key lookup failed', 'MCP_AUTH_LOOKUP_FAILED', { source: 'mcp-auth', stage: 'api_key_lookup' });
      return { statusCode: 503, code: 'MCP_AUTH_UNAVAILABLE', message: '暂时无法验证 MCP 访问令牌，请稍后重试' };
    }
    const username = String(user?.username || '').trim();
    if (!username) {
      return { statusCode: 401, code: 'MCP_INVALID_TOKEN', message: 'MCP 访问令牌无效或已失效' };
    }
    if (typeof usageAccessValidator?.validateKey !== 'function') {
      return { statusCode: 503, code: 'MCP_AUTH_UNAVAILABLE', message: '暂时无法验证 MCP 访问令牌，请稍后重试' };
    }
    let validation;
    try {
      validation = await usageAccessValidator.validateKey(apiKey);
    } catch {
      validation = { ok: false, code: 'MODEL_VALIDATION_UNAVAILABLE' };
    }
    if (!validation?.ok) {
      if (validation?.code === 'INVALID_API_KEY') {
        return { statusCode: 401, code: 'MCP_INVALID_TOKEN', message: 'MCP 访问令牌无效或已失效' };
      }
      return { statusCode: 503, code: 'MCP_AUTH_UNAVAILABLE', message: '暂时无法验证 MCP 访问令牌，请稍后重试' };
    }
    return {
      apiKey,
      username,
      models: Array.isArray(validation.models) ? validation.models : [],
    };
  }

  async function handleToolCall(message, authContext, req) {
    const id = message.id;
    const params = isPlainObject(message.params) ? message.params : null;
    if (!params || typeof params.name !== 'string' || !params.name.trim()) {
      return jsonRpcError(id, -32602, 'tools/call 需要 name 和 arguments 参数');
    }
    const tool = getToolDefinition(params.name);
    if (!tool) return jsonRpcError(id, -32602, '未找到该工具');
    const args = params.arguments === undefined ? {} : params.arguments;
    const validationFailure = pluginContract.validateArguments(args, tool.inputSchema);
    if (validationFailure) return jsonRpcError(id, -32602, '工具参数不正确，请按 tools/list 中的 Schema 调用');
    try {
      const result = await mcpUsageService.callTool(tool.name, args, { ...authContext, req });
      return jsonRpcResult(id, resultToMcpContent(result));
    } catch (error) {
      if (error instanceof McpToolError) {
        return jsonRpcResult(id, toolErrorResult(error.message, error.code));
      }
      logMcpInternalError(errorLog, 'MCP tool execution failed', 'MCP_TOOL_EXECUTION_FAILED', { source: 'mcp-tool', toolName: tool.name });
      return jsonRpcResult(id, toolErrorResult('工具调用失败，请稍后重试', 'MCP_TOOL_ERROR'));
    }
  }

  async function handleMessage(message, authContext, req) {
    if (!isPlainObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !message.method.trim()) {
      return jsonRpcError(null, -32600, '无效的 JSON-RPC 请求');
    }
    if (isNotification(message)) return null;
    if (!validRequestId(message.id)) return jsonRpcError(null, -32600, '无效的 JSON-RPC 请求 ID');

    switch (message.method) {
      case 'initialize':
        return jsonRpcResult(message.id, {
          protocolVersion: negotiateProtocolVersion(message.params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: SERVER_TITLE, version: String(appVersion || 'unknown') },
          instructions: SERVER_INSTRUCTIONS,
        });
      case 'ping':
        return jsonRpcResult(message.id, {});
      case 'tools/list':
        return jsonRpcResult(message.id, { tools: TOOLS });
      case 'tools/call':
        return handleToolCall(message, authContext, req);
      default:
        return jsonRpcError(message.id, -32601, '不支持该方法');
    }
  }

  async function routeMcp(req, res) {
    if (req.method !== 'POST') {
      return send(res, 405, '', { ...MCP_HEADERS, Allow: 'POST' });
    }

    const headerVersion = String(req.headers?.['mcp-protocol-version'] || '').trim();
    if (headerVersion && !SUPPORTED_PROTOCOL_VERSIONS.includes(headerVersion)) {
      discardUnreadBody(req);
      return rpcHttpResponse(res, 400, jsonRpcError(null, -32600, '不支持的 MCP 协议版本'));
    }

    const auth = await authenticate(req);
    if (!auth?.apiKey) {
      discardUnreadBody(req);
      const headers = auth.statusCode === 401 ? { 'WWW-Authenticate': 'Bearer realm=chatui-mcp' } : {};
      return httpError(res, auth.statusCode, auth.message, auth.code, headers);
    }

    let text;
    try {
      text = await readBody(req, { maxBytes: MAX_MCP_BODY_BYTES });
    } catch (error) {
      return httpError(res, error.statusCode || 400, error.message || '无法读取 MCP 请求', error.code || 'MCP_BODY_INVALID');
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return rpcHttpResponse(res, 400, jsonRpcError(null, -32700, '无法解析 JSON-RPC 请求'));
    }

    const batch = Array.isArray(payload);
    if (batch && payload.length === 0) {
      return rpcHttpResponse(res, 400, jsonRpcError(null, -32600, 'JSON-RPC 批量请求不能为空'));
    }
    const messages = batch ? payload : [payload];
    const responses = [];
    for (const message of messages) {
      const response = await handleMessage(message, auth, req);
      if (response) responses.push(response);
    }

    if (!responses.length) {
      return send(res, 202, '', MCP_HEADERS);
    }
    return rpcHttpResponse(res, 200, batch ? responses : responses[0]);
  }

  return { routeMcp };
}

module.exports = {
  MAX_API_KEY_LENGTH,
  MAX_MCP_BODY_BYTES,
  createMcpRoutes,
  extractMcpApiKey,
};
