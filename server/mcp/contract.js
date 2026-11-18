'use strict';

const { PERSONAL_RANGES, rangeLabel } = require('../../shared/usage/ranges');

const MCP_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
const SERVER_NAME = 'chatui-usage';
const SERVER_TITLE = 'ChatUI 用量统计与问题反馈';
const SERVER_INSTRUCTIONS = '所有工具都使用当前连接的用户 API Key 鉴权。统计范围支持今日、昨日、本周、上周、本月、上月和全部时间；部门统计工具直接使用该 API Key 授权。可按用户名或完整部门名精确查询聚合用量。提交反馈前先收集问题描述、复现描述和期望结果。';

const RANGE_DESCRIPTION = '统计范围，默认 today。可选值：' + PERSONAL_RANGES.map(range => `${range}（${rangeLabel(range).replace('排行', '')}）`).join('、');
const READ_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const RANGE_SCHEMA = Object.freeze({
  type: 'string',
  enum: PERSONAL_RANGES,
  description: RANGE_DESCRIPTION,
});

const TOOLS = Object.freeze([
  Object.freeze({
    name: 'usage_get_overview',
    title: '获取用量概览',
    description: '同时获取当前用户个人用量与指定范围的用户排行榜。适合先回答“我的用量”或“用量排行”。',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        ranking_range: Object.freeze({ ...RANGE_SCHEMA, description: '排行榜统计范围。' + RANGE_DESCRIPTION }),
        personal_range: Object.freeze({ ...RANGE_SCHEMA, description: '个人统计范围。' + RANGE_DESCRIPTION }),
      }),
      additionalProperties: false,
    }),
    annotations: READ_ANNOTATIONS,
  }),
  Object.freeze({
    name: 'usage_get_personal',
    title: '获取个人用量',
    description: '获取当前 API Key 对应用户在指定统计范围内的完整 token 用量。',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ range: RANGE_SCHEMA }),
      additionalProperties: false,
    }),
    annotations: READ_ANNOTATIONS,
  }),
  Object.freeze({
    name: 'usage_get_rankings',
    title: '获取用户排行榜',
    description: '获取指定统计范围内的用户 token 用量排行榜。',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ range: RANGE_SCHEMA }),
      additionalProperties: false,
    }),
    annotations: READ_ANNOTATIONS,
  }),
  Object.freeze({
    name: 'usage_get_user_by_name',
    title: '按姓名查询用户用量',
    description: '按用户名精确查询指定统计范围内该用户的聚合 token 用量。姓名不区分大小写，仅返回与排行榜相同的聚合指标。',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        username: Object.freeze({
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: '要查询的完整用户名。',
        }),
        range: RANGE_SCHEMA,
      }),
      required: Object.freeze(['username']),
      additionalProperties: false,
    }),
    annotations: READ_ANNOTATIONS,
  }),
  Object.freeze({
    name: 'usage_get_department_summary',
    title: '获取部门统计概览',
    description: '按指定统计范围获取部门统计概览与部门排行。',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ range: RANGE_SCHEMA }),
      additionalProperties: false,
    }),
    annotations: READ_ANNOTATIONS,
  }),
  Object.freeze({
    name: 'usage_get_department_ranking',
    title: '获取部门排行',
    description: '按指定统计范围获取部门 token 用量排行。',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ range: RANGE_SCHEMA }),
      additionalProperties: false,
    }),
    annotations: READ_ANNOTATIONS,
  }),
  Object.freeze({
    name: 'usage_get_department_users',
    title: '获取部门用户用量',
    description: '获取指定部门在指定统计范围内的用户 token 用量明细。',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        department_id: Object.freeze({
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: '部门主键，可先通过 usage_get_department_ranking 获取。',
        }),
        range: RANGE_SCHEMA,
      }),
      required: Object.freeze(['department_id']),
      additionalProperties: false,
    }),
    annotations: READ_ANNOTATIONS,
  }),
  Object.freeze({
    name: 'usage_get_department_by_name',
    title: '按部门名查询用量',
    description: '按完整部门名精确查询指定统计范围内该部门的聚合 token 用量及部门用户用量。部门名不区分大小写，不要求部门密码。',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        department_name: Object.freeze({
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: '要查询的完整部门名。',
        }),
        range: RANGE_SCHEMA,
      }),
      required: Object.freeze(['department_name']),
      additionalProperties: false,
    }),
    annotations: READ_ANNOTATIONS,
  }),
  Object.freeze({
    name: 'usage_export_department',
    title: '导出部门统计',
    description: '将指定统计范围内的部门及部门用户用量导出为 XLSX。',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ range: RANGE_SCHEMA }),
      additionalProperties: false,
    }),
    annotations: READ_ANNOTATIONS,
  }),
  Object.freeze({
    name: 'usage_submit_feedback',
    title: '提交问题反馈',
    description: '提交包含问题描述、复现描述和期望结果的问题反馈。服务端会先审核内容，再投递到反馈通道。',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        problem_description: Object.freeze({ type: 'string', minLength: 1, maxLength: 1400, description: '实际发生了什么问题。' }),
        reproduction_description: Object.freeze({ type: 'string', minLength: 1, maxLength: 1400, description: '如何再次触发该问题。' }),
        expected_result: Object.freeze({ type: 'string', minLength: 1, maxLength: 900, description: '正确行为应该是什么。' }),
        chat_model: Object.freeze({ type: 'string', minLength: 1, maxLength: 160, description: '可选。审核反馈使用的聊天模型；省略时由服务端选择可用模型。' }),
        route_model: Object.freeze({ type: 'string', minLength: 1, maxLength: 160, description: '可选。用于随反馈记录的意图模型名称。' }),
      }),
      required: Object.freeze(['problem_description', 'reproduction_description', 'expected_result']),
      additionalProperties: false,
    }),
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    }),
  }),
]);

const TOOL_BY_NAME = new Map(TOOLS.map(tool => [tool.name, tool]));

function getToolDefinition(name = '') {
  return TOOL_BY_NAME.get(String(name || '').trim()) || null;
}

function negotiateProtocolVersion(requested = '') {
  const value = String(requested || '').trim();
  return SUPPORTED_PROTOCOL_VERSIONS.includes(value) ? value : MCP_PROTOCOL_VERSION;
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data = undefined) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: Number(code),
      message: String(message || 'JSON-RPC error'),
      ...(data === undefined ? {} : { data }),
    },
  };
}

function textContent(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { type: 'text', text };
}

function toolResult(value) {
  return { content: [textContent(value)] };
}

function toolErrorResult(message, code = 'MCP_TOOL_ERROR') {
  return {
    content: [textContent(String(message || '工具调用失败，请稍后重试'))],
    isError: true,
    _meta: { 'chatui/errorCode': String(code || 'MCP_TOOL_ERROR') },
  };
}

module.exports = {
  MCP_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  SERVER_NAME,
  SERVER_TITLE,
  SERVER_INSTRUCTIONS,
  TOOLS,
  getToolDefinition,
  jsonRpcError,
  jsonRpcResult,
  negotiateProtocolVersion,
  textContent,
  toolErrorResult,
  toolResult,
};
