'use strict';

const usageService = require('./usage.service');

function feedbackError(message, code, statusCode, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

function reviewReason(review = {}) {
  return String(review?.message || '反馈内容不够完整，请补充问题描述、复现描述和期望结果').trim();
}

async function resolveUsername({ apiKey, username, usageStats }) {
  const provided = String(username || '').trim();
  if (provided) return provided;
  if (!usageStats) {
    throw feedbackError('统计数据源未配置，无法识别反馈用户名', 'USAGE_UNAVAILABLE', 503);
  }
  const personal = await usageService.getPersonalRange(usageStats, apiKey, 'total');
  return String(personal?.username || '').trim();
}

async function submitFeedback({
  content = '',
  apiKey = '',
  model = '',
  routeModel = '',
  username = '',
  usageStats = null,
  feedbackReviewer = null,
  feedbackSender = null,
} = {}) {
  if (typeof feedbackReviewer?.review !== 'function') {
    throw feedbackError('反馈内容审核服务暂时不可用，请稍后重试', 'FEEDBACK_REVIEW_UNAVAILABLE', 503);
  }
  const review = await feedbackReviewer.review(content, { apiKey, model });
  if (!review?.accepted) {
    const reason = reviewReason(review);
    throw feedbackError(`审核未通过：${reason}`, 'INVALID_FEEDBACK', 422, {
      reviewReason: reason,
      review: {
        accepted: false,
        missing_sections: Array.isArray(review?.missingSections) ? review.missingSections : [],
        reason,
      },
    });
  }

  const resolvedUsername = await resolveUsername({ apiKey, username, usageStats });
  if (!resolvedUsername) {
    throw feedbackError('未找到该 API Key 对应的统计用户名，无法提交反馈', 'INVALID_API_KEY', 403);
  }
  if (typeof feedbackSender?.send !== 'function') {
    throw feedbackError('反馈通道尚未配置', 'FEEDBACK_NOT_CONFIGURED', 503);
  }
  await feedbackSender.send(content, { username: resolvedUsername, routeModel, chatModel: model });
  return { ok: true, message: '反馈已发送' };
}

module.exports = {
  submitFeedback,
};
