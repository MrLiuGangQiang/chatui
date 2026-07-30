const crypto = require('crypto');
const { normalizeFeedback, feedbackUserContent, feedbackWithModelContext } = require('./feedback-content.service');

const DINGTALK_WEBHOOK_HOSTS = new Set(['oapi.dingtalk.com', 'api.dingtalk.com']);
const FEEDBACK_SECTION_LABELS = Object.freeze(['问题描述', '复现描述', '期望结果']);

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

function displayText(value = '') {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}

function feedbackSections(content) {
  const normalized = feedbackUserContent(content);
  const markers = [...normalized.matchAll(/【(问题描述|复现描述|期望结果)】/g)];
  if (!markers.length) return [{ label: '反馈详情', content: normalized }];
  const sections = new Map();
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const end = markers[index + 1]?.index ?? normalized.length;
    sections.set(marker[1], displayText(normalized.slice(marker.index + marker[0].length, end)));
  }
  return FEEDBACK_SECTION_LABELS.map(label => ({ label, content: sections.get(label) || '（未填写）' }));
}

function feedbackModelDetails(content) {
  const normalized = normalizeFeedback(content);
  const marker = '【模型信息（自动填写）】';
  const context = normalized.includes(marker) ? normalized.slice(normalized.lastIndexOf(marker) + marker.length) : '';
  const read = label => context.match(new RegExp(`^${label}：(.+)$`, 'm'))?.[1]?.trim() || '';
  return { routeModel: read('意图模型') || read('意图识别模型') || '未配置', chatModel: read('聊天模型') || '未配置' };
}

function feedbackDetailsMarkdown(content) {
  const sections = feedbackSections(content);
  return sections.map((section, index) => `#### ${sections.length === 3 ? `${index + 1}. ` : ''}${section.label}\n${section.content}`).join('\n\n');
}

function feedbackMessage(content, username = '', now = new Date()) {
  const author = displayText(username).replace(/\n+/g, ' ') || '未知用户';
  const submittedAt = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).replace(/\//g, '-');
  const models = feedbackModelDetails(content);
  return {
    msgtype: 'markdown',
    markdown: {
      title: `问题反馈 · ${author}`,
      text: `### 🐞 新问题反馈\n\n> 提交人：${author}  \n> 提交时间：${submittedAt}\n\n---\n\n${feedbackDetailsMarkdown(content)}\n\n---\n\n#### 模型信息\n- 意图模型：\`${models.routeModel}\`\n- 聊天模型：\`${models.chatModel}\``,
    },
  };
}

function createDingTalkFeedbackSender({ accessToken = process.env.DINGTALK_FEEDBACK_ACCESS_TOKEN, secret = process.env.DINGTALK_FEEDBACK_SECRET, fetchImpl = global.fetch, now = () => Date.now() } = {}) {
  const normalizedWebhook = normalizeWebhook(accessToken);
  return {
    configured: Boolean(normalizedWebhook),
    async send(content, { username = '', routeModel = '', chatModel = '' } = {}) {
      const userContent = feedbackUserContent(content);
      if (!userContent) {
        const err = new Error('请填写需要反馈的问题');
        err.code = 'INVALID_FEEDBACK';
        err.statusCode = 400;
        throw err;
      }
      const text = feedbackWithModelContext(content, { routeModel, chatModel });
      if (!normalizedWebhook) {
        const err = new Error('反馈通道尚未配置');
        err.code = 'FEEDBACK_NOT_CONFIGURED';
        err.statusCode = 503;
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

module.exports = { DINGTALK_WEBHOOK_HOSTS, FEEDBACK_SECTION_LABELS, normalizeAccessToken, normalizeWebhook, signedWebhookUrl, normalizeFeedback, feedbackSections, feedbackModelDetails, feedbackDetailsMarkdown, feedbackMessage, createDingTalkFeedbackSender };
