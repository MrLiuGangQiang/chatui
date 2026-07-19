(function initChatUIPreflightGuards(root) {
  'use strict';

  const MAX_USER_MESSAGE_CHARS = 120000;

  function isImageAttachment(item) {
    return String(item?.type || item?.mime || item?.file?.type || '').startsWith('image/');
  }

  function attachmentCounts(attachments = [], isImageFile = isImageAttachment) {
    const list = Array.isArray(attachments) ? attachments : [];
    const imageCount = list.filter(item => isImageFile(item)).length;
    return { imageCount, fileCount: list.length - imageCount };
  }

  function validateMessageSize(input = '', limits = {}) {
    const length = String(input || '').length;
    const maxChars = Number(limits.maxChars) > 0 ? Number(limits.maxChars) : MAX_USER_MESSAGE_CHARS;
    if (length <= maxChars) return { ok: true, length, maxChars };
    return {
      ok: false,
      code: 'message_too_many_characters',
      length,
      maxChars,
      message: `消息过长（${length.toLocaleString()} 字符），单条消息最多 ${maxChars.toLocaleString()} 字符。请改为上传文本文件或分段发送。`,
    };
  }

  function normalizeSelection(text = '', selectionStart, selectionEnd) {
    const length = String(text || '').length;
    const start = Number.isInteger(Number(selectionStart)) ? Math.max(0, Math.min(length, Number(selectionStart))) : length;
    const end = Number.isInteger(Number(selectionEnd)) ? Math.max(start, Math.min(length, Number(selectionEnd))) : start;
    return { start, end };
  }

  function validateMessageInsertion({ current = '', inserted = '', selectionStart, selectionEnd } = {}, limits = {}) {
    const source = String(current || '');
    const additionLength = String(inserted || '').length;
    const { start, end } = normalizeSelection(source, selectionStart, selectionEnd);
    const maxChars = Number(limits.maxChars) > 0 ? Number(limits.maxChars) : MAX_USER_MESSAGE_CHARS;
    const length = source.length - (end - start) + additionLength;
    if (length <= maxChars) return { ok: true, length, maxChars };
    return {
      ok: false,
      code: 'message_too_many_characters',
      length,
      maxChars,
      message: `粘贴或输入的内容过长，单条消息最多 ${maxChars.toLocaleString()} 字符。请改为上传文本文件或分段发送。`,
    };
  }

  function truncateMessageToLimit(input = '', limits = {}) {
    const maxChars = Number(limits.maxChars) > 0 ? Number(limits.maxChars) : MAX_USER_MESSAGE_CHARS;
    const text = String(input || '');
    if (text.length <= maxChars) return text;
    let truncated = text.slice(0, maxChars);
    if (truncated && /[\uD800-\uDBFF]$/.test(truncated)) truncated = truncated.slice(0, -1);
    return truncated;
  }

  // Preflight 只处理不需要理解用户语义的确定性条件。
  // 意图分类、澄清、工具选择和参数组装全部交给 AI 路由模型。
  function buildPreflightDecision({ input = '', attachments = [], config = {} } = {}) {
    const size = validateMessageSize(input);
    const reply = (message, metaText, code) => ({ action: 'reply', message, metaText, code });
    if (!size.ok) return reply(size.message, '消息过大，未发送', size.code);
    const hasInput = Boolean(String(input || '').trim());
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!hasInput && !hasAttachments) return reply('请输入消息或添加附件。', '缺少输入', 'missing_input');
    if (!String(config.baseUrl || '').trim()) return reply('请先在设置里填写 Endpoint Base URL。', '配置缺失', 'missing_base_url');
    if (!String(config.routeModel || config.chatModel || '').trim()) return reply('请先在设置里选择路由模型或聊天模型。', '配置缺失', 'missing_route_model');
    return null;
  }

  const api = { MAX_USER_MESSAGE_CHARS, validateMessageSize, validateMessageInsertion, truncateMessageToLimit, buildPreflightDecision, attachmentCounts };
  if (root) root.ChatUICorePreflightGuards = api;
  if (root?.window) root.window.ChatUICorePreflightGuards = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
