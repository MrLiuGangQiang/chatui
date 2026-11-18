'use strict';

const feedbackService = require('./feedback.service');
const usageService = require('./usage.service');
const usageValidator = require('../validators/usage.validator');

const DEFAULT_RANGE = 'today';
const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
const EXPORT_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

class McpToolError extends Error {
  constructor(message, code = 'MCP_TOOL_ERROR') {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
  }
}

function toolError(message, code) {
  return new McpToolError(message, code);
}

function normalizeRange(value) {
  return usageValidator.normalizePersonalRange(value || DEFAULT_RANGE);
}

function normalizeDepartmentRange(value) {
  return usageValidator.normalizeDepartmentRange(value || DEFAULT_RANGE);
}

function requireRange(value, department = false) {
  const range = department ? normalizeDepartmentRange(value) : normalizeRange(value);
  if (!range) throw toolError('不支持的统计范围，请使用工具说明中的范围值', 'MCP_RANGE_INVALID');
  return range;
}

function requireUsageStats(usageStats) {
  if (!usageStats) throw toolError('使用统计功能未启用，请先配置 PostgreSQL', 'USAGE_UNAVAILABLE');
  return usageStats;
}

function enforceRateLimit(checkRateLimit, name, context) {
  if (typeof checkRateLimit !== 'function') return;
  const result = checkRateLimit(name, context);
  if (result?.allowed === false) {
    throw toolError('请求过于频繁，请稍后再试', 'MCP_RATE_LIMITED');
  }
}

function availableModels(context = {}) {
  const values = Array.isArray(context.models) ? context.models : [];
  return [...new Set(values.map(model => String(model || '').trim()).filter(Boolean))];
}

function recommendedChatModel(readPublicConfig) {
  if (typeof readPublicConfig !== 'function') return '';
  try {
    return String(readPublicConfig()?.modelRecommendation?.chatModel || '').trim();
  } catch {
    return '';
  }
}

function resolveFeedbackModel(requestedModel, context, readPublicConfig, env) {
  const models = availableModels(context);
  const requested = String(requestedModel || '').trim();
  if (requested) {
    if (models.length && !models.includes(requested)) {
      throw toolError('指定的 chat_model 不在当前 API Key 的可用模型列表中', 'MCP_FEEDBACK_MODEL_INVALID');
    }
    return requested;
  }
  if (!models.length) {
    throw toolError('当前 API Key 没有可用于审核反馈的模型，请在调用参数中指定 chat_model', 'MCP_FEEDBACK_MODEL_UNAVAILABLE');
  }
  const candidates = [
    env?.CHATUI_MCP_FEEDBACK_MODEL,
    recommendedChatModel(readPublicConfig),
  ].map(value => String(value || '').trim()).filter(Boolean);
  for (const candidate of candidates) {
    if (models.includes(candidate)) return candidate;
  }
  return models[0];
}

function feedbackContent(args = {}) {
  return `【问题描述】\n${String(args.problem_description || '').trim()}\n\n【复现描述】\n${String(args.reproduction_description || '').trim()}\n\n【期望结果】\n${String(args.expected_result || '').trim()}`.trim();
}

const SAFE_FEEDBACK_MESSAGES = Object.freeze({
  USAGE_UNAVAILABLE: '统计数据源未配置，无法识别反馈用户名',
  FEEDBACK_REVIEW_UNAVAILABLE: '反馈内容审核暂时不可用，请稍后重试',
  INVALID_API_KEY: '未找到该 API Key 对应的统计用户名，无法提交反馈',
  FEEDBACK_NOT_CONFIGURED: '反馈通道尚未配置',
  FEEDBACK_DELIVERY_FAILED: '反馈发送失败，请稍后重试',
  INVALID_FEEDBACK_REVIEW: '聊天模型未能完成反馈内容审核，请重试或更换聊天模型',
});

function feedbackToolError(error = {}) {
  const code = String(error.code || '');
  if (code === 'INVALID_FEEDBACK') {
    return toolError(String(error.message || '反馈内容未通过审核'), code);
  }
  const message = SAFE_FEEDBACK_MESSAGES[code];
  if (message) return toolError(message, code);
  if (code && error.statusCode) return toolError('反馈提交失败，请稍后重试', 'FEEDBACK_DELIVERY_FAILED');
  return null;
}

function exportTooLargeError() {
  return toolError('部门统计导出文件过大，请缩小统计范围后重试', 'MCP_EXPORT_TOO_LARGE');
}

function createMcpUsageService({
  usageStats = null,
  feedbackReviewer = null,
  feedbackSender = null,
  checkRateLimit = null,
  readPublicConfig = null,
  env = process.env,
} = {}) {
  async function callTool(name, args = {}, context = {}) {
    switch (name) {
      case 'usage_get_overview': {
        enforceRateLimit(checkRateLimit, 'overview', context);
        const stats = requireUsageStats(usageStats);
        const rankingRange = requireRange(args.ranking_range);
        const personalRange = requireRange(args.personal_range);
        const overview = await usageService.getOverview(stats, context.apiKey, rankingRange, personalRange);
        return {
          available: true,
          ranking_range: rankingRange,
          personal_range: personalRange,
          ranking: overview.ranking || [],
          personal: overview.personal || null,
        };
      }
      case 'usage_get_personal': {
        enforceRateLimit(checkRateLimit, 'personal', context);
        const stats = requireUsageStats(usageStats);
        const range = requireRange(args.range);
        const personal = await usageService.getPersonalRange(stats, context.apiKey, range);
        return { available: true, range, personal };
      }
      case 'usage_get_rankings': {
        enforceRateLimit(checkRateLimit, 'rankings', context);
        const stats = requireUsageStats(usageStats);
        const range = requireRange(args.range);
        const ranking = await usageService.getRanking(stats, range);
        return { available: true, range, ranking };
      }
      case 'usage_get_department_summary': {
        enforceRateLimit(checkRateLimit, 'department', context);
        const stats = requireUsageStats(usageStats);
        const range = requireRange(args.range, true);
        const summary = await usageService.getDepartmentSummary(stats, range);
        return { available: true, authorized: true, range, ...summary };
      }
      case 'usage_get_department_ranking': {
        enforceRateLimit(checkRateLimit, 'department', context);
        const stats = requireUsageStats(usageStats);
        const range = requireRange(args.range, true);
        const ranking = await usageService.getDepartmentRanking(stats, range);
        return { available: true, range, ranking };
      }
      case 'usage_get_department_users': {
        enforceRateLimit(checkRateLimit, 'department', context);
        const stats = requireUsageStats(usageStats);
        const range = requireRange(args.range, true);
        const departmentId = String(args.department_id || '').trim();
        if (!departmentId) throw toolError('缺少 department_id，请先查询部门排行获取部门主键', 'MCP_DEPARTMENT_ID_REQUIRED');
        const users = await usageService.getDepartmentUsers(stats, departmentId, range);
        return { available: true, range, department_id: departmentId, users };
      }
      case 'usage_export_department': {
        enforceRateLimit(checkRateLimit, 'department', context);
        const stats = requireUsageStats(usageStats);
        const range = requireRange(args.range, true);
        const workbook = await usageService.getDepartmentExportWorkbook(stats, range);
        const buffer = Buffer.isBuffer(workbook) ? workbook : Buffer.from(workbook);
        if (buffer.length > MAX_EXPORT_BYTES) throw exportTooLargeError();
        return {
          kind: 'resource',
          filename: `department-usage-${range}.xlsx`,
          mimeType: EXPORT_MIME_TYPE,
          range,
          sizeBytes: buffer.length,
          base64: buffer.toString('base64'),
        };
      }
      case 'usage_submit_feedback': {
        enforceRateLimit(checkRateLimit, 'feedback', context);
        const model = resolveFeedbackModel(args.chat_model, context, readPublicConfig, env);
        const routeModel = String(args.route_model || model || '').trim();
        let result;
        try {
          result = await feedbackService.submitFeedback({
            content: feedbackContent(args),
            apiKey: context.apiKey,
            model,
            routeModel,
            username: context.username,
            usageStats,
            feedbackReviewer,
            feedbackSender,
          });
        } catch (error) {
          const toolFailure = feedbackToolError(error);
          if (toolFailure) throw toolFailure;
          throw error;
        }
        return { ...result, chat_model: model };
      }
      default:
        throw toolError('未找到该工具', 'MCP_TOOL_NOT_FOUND');
    }
  }

  return Object.freeze({ callTool });
}

module.exports = {
  DEFAULT_RANGE,
  EXPORT_MIME_TYPE,
  MAX_EXPORT_BYTES,
  McpToolError,
  createMcpUsageService,
  feedbackContent,
  resolveFeedbackModel,
};
