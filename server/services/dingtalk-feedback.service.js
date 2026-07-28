const crypto = require('crypto');

const DINGTALK_WEBHOOK_HOSTS = new Set(['oapi.dingtalk.com', 'api.dingtalk.com']);

function normalizeAccessToken(value = process.env.DINGTALK_FEEDBACK_ACCESS_TOKEN) {
  const token = String(value || '').trim();
  return /^[A-Za-z0-9_-]{16,256}$/.test(token) ? token : '';
}

function normalizeWebhook(value = process.env.DINGTALK_FEEDBACK_ACCESS_TOKEN) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !DINGTALK_WEBHOOK_HOSTS.has(url.hostname) || !url.pathname.startsWith('/robot/send')) return '';
    return url.toString();
  } catch {
    const token = normalizeAccessToken(raw);
    return token ? `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(token)}` : '';
  }
}

function signedWebhookUrl(webhook, secret = process.env.DINGTALK_FEEDBACK_SECRET, now = Date.now()) {
  const url = new URL(webhook);
  const signingSecret = String(secret || '').trim();
  if (!signingSecret) return url.toString();
  const timestamp = String(now);
  const sign = crypto.createHmac('sha256', signingSecret).update(`${timestamp}\n${signingSecret}`).digest('base64');
  url.searchParams.set('timestamp', timestamp);
  url.searchParams.set('sign', sign);
  return url.toString();
}

function normalizeFeedback(content) {
  return String(content || '').replace(/\r\n?/g, '\n').trim().replace(/\n{3,}/g, '\n\n').slice(0, 4000);
}

function feedbackMessage(content, username = '', now = new Date()) {
  const author = String(username || '').trim() || '未知用户';
  const submittedAt = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).replace(/\//g, '-');
  return {
    msgtype: 'markdown',
    markdown: {
      title: `${author} 的问题反馈`,
      text: `### 🔔 新的问题反馈\n\n---\n\n${content}\n\n---\n\n<font color=#8c8c8c>来自：${author}　·　${submittedAt}</font>`,
    },
  };
}

function createDingTalkFeedbackSender({ accessToken = process.env.DINGTALK_FEEDBACK_ACCESS_TOKEN, secret = process.env.DINGTALK_FEEDBACK_SECRET, fetchImpl = global.fetch, now = () => Date.now() } = {}) {
  const normalizedWebhook = normalizeWebhook(accessToken);
  return {
    configured: Boolean(normalizedWebhook),
    async send(content, { username = '' } = {}) {
      const text = normalizeFeedback(content);
      if (!normalizedWebhook) {
        const err = new Error('反馈通道尚未配置');
        err.code = 'FEEDBACK_NOT_CONFIGURED';
        err.statusCode = 503;
        throw err;
      }
      if (!text) {
        const err = new Error('请填写需要反馈的问题');
        err.code = 'INVALID_FEEDBACK';
        err.statusCode = 400;
        throw err;
      }
      if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持发送反馈');
      let response;
      try {
        response = await fetchImpl(signedWebhookUrl(normalizedWebhook, secret, now()), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(feedbackMessage(text, username, new Date(now()))),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (cause) {
        const err = new Error('反馈发送失败，请稍后重试');
        err.code = 'FEEDBACK_DELIVERY_FAILED';
        err.statusCode = 502;
        err.cause = cause;
        throw err;
      }
      let payload = null;
      try { payload = await response.json(); } catch {}
      if (!response.ok || Number(payload?.errcode || 0) !== 0) {
        const err = new Error('反馈发送失败，请稍后重试');
        err.code = 'FEEDBACK_DELIVERY_FAILED';
        err.statusCode = 502;
        throw err;
      }
      return true;
    },
  };
}

module.exports = { DINGTALK_WEBHOOK_HOSTS, normalizeAccessToken, normalizeWebhook, signedWebhookUrl, normalizeFeedback, feedbackMessage, createDingTalkFeedbackSender };
