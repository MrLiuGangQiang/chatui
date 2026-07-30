'use strict';

const FEEDBACK_MODEL_CONTEXT_HEADING = '【模型信息（自动填写）】';
const MAX_FEEDBACK_LENGTH = 4000;

function normalizeFeedback(content) {
  return String(content || '').replace(/\r\n?/g, '\n').trim().replace(/\n{3,}/g, '\n\n').slice(0, MAX_FEEDBACK_LENGTH);
}

function feedbackUserContent(content) {
  const normalized = normalizeFeedback(content);
  const markerIndex = normalized.lastIndexOf(FEEDBACK_MODEL_CONTEXT_HEADING);
  return normalizeFeedback(markerIndex >= 0 ? normalized.slice(0, markerIndex) : normalized);
}

function normalizeModelName(value = '') {
  return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/`/g, '').trim().slice(0, 160);
}

function feedbackModelContext({ routeModel = '', chatModel = '' } = {}) {
  const chat = normalizeModelName(chatModel) || '未配置';
  const configuredRoute = normalizeModelName(routeModel);
  const route = configuredRoute || `${chat}（跟随聊天模型）`;
  return `${FEEDBACK_MODEL_CONTEXT_HEADING}\n意图模型：${route}\n聊天模型：${chat}`;
}

function feedbackWithModelContext(content, models = {}) {
  const context = feedbackModelContext(models);
  const maxUserLength = Math.max(0, MAX_FEEDBACK_LENGTH - context.length - 2);
  const userContent = feedbackUserContent(content).slice(0, maxUserLength).trim();
  return normalizeFeedback([userContent, context].filter(Boolean).join('\n\n'));
}

module.exports = {
  FEEDBACK_MODEL_CONTEXT_HEADING,
  MAX_FEEDBACK_LENGTH,
  normalizeFeedback,
  feedbackUserContent,
  normalizeModelName,
  feedbackModelContext,
  feedbackWithModelContext,
};
