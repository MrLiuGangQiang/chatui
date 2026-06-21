(function initChatUIClarificationService(root) {
  'use strict';

  function textOfMessage(message = {}) {
    return String(message.rawText || message.content || '').trim();
  }

  function hasImageAttachment(list = [], isImageFile = () => false) {
    return (list || []).some(item => isImageFile(item) || String(item?.type || item?.file?.type || '').startsWith('image/'));
  }

  function hasAnyAttachment(list = []) {
    return Array.isArray(list) && list.length > 0;
  }

  function isUploadImageClarification(text = '') {
    return /(上传|提供|补充|发送).*(图片|图)|没有可编辑的图片|要修改的图片|请.*图片/i.test(String(text || ''));
  }

  function isClarificationResponse(text = '') {
    const value = String(text || '').trim();
    if (!value) return false;
    return /((请|需要|麻烦).*(上传|提供|补充|明确|选择)|请.*说明.*(哪|哪个|哪张|哪个文件|哪个附件|要处理什么|想让我怎么)|哪一张|第几张|哪个文件|哪个附件|要处理什么|想让我怎么|没有可编辑的图片|请先上传|请上传|请明确)/i.test(value);
  }

  function isImageEditIntent(text = '') {
    return /(改|修改|换|变成|改成|替换|去掉|去除|删除|加上|添加|背景|风格|漫画|红色|蓝色|黑白|修复|变清晰|抠图|edit|change|replace|remove|background|style)/i.test(String(text || ''));
  }

  function inferPendingKind({ originalText = '', clarificationText = '' } = {}) {
    const combined = `${originalText}\n${clarificationText}`;
    if (isImageEditIntent(combined) || isUploadImageClarification(combined)) return 'image_edit';
    if (/(文件|文档|附件|file|document|pdf|表格|总结|提取)/i.test(combined)) return 'file_qa';
    if (/(第几张|哪一张|这些图|图片|图)/i.test(combined)) return 'image';
    return 'general';
  }

  function normalizePendingClarification(value = null) {
    if (!value || typeof value !== 'object') return null;
    const originalText = String(value.originalText || value.original_text || '').trim();
    if (!originalText) return null;
    return {
      id: value.id || `clarify-${Date.now().toString(36)}`,
      kind: value.kind || 'general',
      originalText,
      clarificationText: String(value.clarificationText || value.clarification_text || '').trim(),
      supplements: Array.isArray(value.supplements) ? value.supplements : [],
      sourceImageContext: value.sourceImageContext || value.source_image_context || null,
      sourceAttachmentContext: value.sourceAttachmentContext || value.source_attachment_context || null,
      sourceQuoteContext: value.sourceQuoteContext || value.source_quote_context || null,
      createdAt: Number(value.createdAt || value.created_at) || Date.now(),
      updatedAt: Number(value.updatedAt || value.updated_at) || Date.now(),
      rounds: Number(value.rounds || 1) || 1,
    };
  }

  function findLastUserBeforeAssistant(messages = [], assistantIndex = messages.length - 1) {
    for (let i = Math.min(assistantIndex - 1, messages.length - 1); i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role === 'user') {
        const text = textOfMessage(message).replace(/\n\s*\[(image|file) id=.*$/is, '').trim();
        if (text) return { text, index: i, message };
      }
    }
    return null;
  }

  function createPendingClarification({ messages = [], clarificationText = '', routeInfo = null, sourceImageContext = null, sourceAttachmentContext = null, sourceQuoteContext = null } = {}) {
    const latestUser = findLastUserBeforeAssistant(messages, messages.length);
    if (!latestUser?.text) return null;
    const kind = inferPendingKind({ originalText: latestUser.text, clarificationText });
    return normalizePendingClarification({
      kind,
      originalText: latestUser.text,
      clarificationText,
      routeInfo: routeInfo ? { mode: routeInfo.mode, target: routeInfo.target, intent: routeInfo.intent } : null,
      sourceImageContext,
      sourceAttachmentContext,
      sourceQuoteContext,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      rounds: 1,
    });
  }

  function findPendingFromHistory(messages = []) {
    let assistantIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg?.role === 'assistant' && isClarificationResponse(textOfMessage(msg))) {
        assistantIndex = i;
        break;
      }
      if (msg?.role === 'assistant' && !isClarificationResponse(textOfMessage(msg))) break;
    }
    if (assistantIndex < 0) return null;
    const clarificationText = textOfMessage(messages[assistantIndex]);
    const latestUser = findLastUserBeforeAssistant(messages, assistantIndex);
    if (!latestUser?.text) return null;
    return normalizePendingClarification({
      kind: inferPendingKind({ originalText: latestUser.text, clarificationText }),
      originalText: latestUser.text,
      clarificationText,
      sourceImageContext: latestUser.message?.imageContext || latestUser.message?.image_context || null,
      sourceAttachmentContext: latestUser.message?.attachmentContext || latestUser.message?.attachment_context || null,
      sourceQuoteContext: latestUser.message?.quoteContext || latestUser.message?.quote_context || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      rounds: 1,
    });
  }

  function isSelectionAnswer(text = '') {
    const value = String(text || '').trim();
    if (!value) return false;
    return /^(第?[一二三四五六七八九十\d]+[张个份]?|[一二三四五六七八九十\d]+|全部|全都|都要|都处理|这张|那张|这个|那个|前者|后者|第一张|第二张|第三张|last|latest|previous|all)$/i.test(value)
      || /(第\s*\d+\s*张|第[一二三四五六七八九十]+张|图片?\s*\d+|image\s*\d+)/i.test(value);
  }

  function isLikelyClarificationAnswer(pending, { promptText = '', attachments = [], quotedMessage = null, isImageFile = () => false } = {}) {
    const normalized = normalizePendingClarification(pending);
    if (!normalized) return false;
    const text = String(promptText || '').trim();
    const hasAttachments = hasAnyAttachment(attachments);
    const hasImages = hasImageAttachment(attachments, isImageFile);
    if (quotedMessage) return true;
    if (hasAttachments) {
      if (normalized.kind === 'image_edit' || normalized.kind === 'image') return hasImages;
      return true;
    }
    if (!text) return false;
    if (isSelectionAnswer(text)) return true;
    if (normalized.kind === 'image_edit' || normalized.kind === 'image') {
      if (/(这张|那张|上面|刚才|原图|图片|图\d*|背景|主体|颜色|风格|保留|去掉|删除|替换|改成|换成|清晰|抠图)/i.test(text)) return true;
      return false;
    }
    if (normalized.kind === 'file_qa') return /(这个|该|上面|刚才|文件|文档|附件|重点|结论|摘要|页|表|列|行)/i.test(text);
    return /^(是|不是|对|不对|可以|继续|确认|好|就这样|按这个|没错)$/i.test(text);
  }

  function shouldApplyPending(pending, { promptText = '', attachments = [], quotedMessage = null, isImageFile = () => false } = {}) {
    return isLikelyClarificationAnswer(pending, { promptText, attachments, quotedMessage, isImageFile });
  }

  function mergePendingInput(pending, { promptText = '', attachments = [], quotedMessage = null, quoteText = '' } = {}) {
    const normalized = normalizePendingClarification(pending);
    if (!normalized) return { promptText, merged: false, pending: null };
    const supplementText = String(promptText || '').trim();
    const parts = [normalized.originalText];
    if (normalized.supplements?.length) {
      normalized.supplements.forEach((item, index) => {
        const text = String(item?.text || '').trim();
        const notes = [];
        if (item?.attachments) notes.push(`附件 ${item.attachments} 个`);
        if (item?.quoted) notes.push('包含引用消息');
        if (text || notes.length) parts.push(`补充${index + 1}：${[text, notes.join('，')].filter(Boolean).join('；')}`);
      });
    }
    if (supplementText) parts.push(`本轮补充：${supplementText}`);
    if (quotedMessage) parts.push(`本轮引用：${quoteText || textOfMessage(quotedMessage) || '[quoted_message]'}`);
    if (attachments?.length && !supplementText) parts.push(`本轮补充：用户上传了 ${attachments.length} 个附件。`);
    const mergedPrompt = parts.filter(Boolean).join('\n\n');
    return {
      promptText: mergedPrompt,
      originalPromptText: normalized.originalText,
      supplementText,
      merged: true,
      pending: {
        ...normalized,
        supplements: [
          ...(normalized.supplements || []),
          { text: supplementText, attachments: attachments?.length || 0, quoted: !!quotedMessage, at: Date.now() },
        ],
        updatedAt: Date.now(),
        rounds: (normalized.rounds || 1) + 1,
      },
    };
  }

  function clearPendingIfResolved(routeInfo = {}) {
    return !routeInfo?.needClarification;
  }

  const api = Object.freeze({
    isClarificationResponse,
    isUploadImageClarification,
    isImageEditIntent,
    inferPendingKind,
    normalizePendingClarification,
    createPendingClarification,
    findPendingFromHistory,
    isSelectionAnswer,
    isLikelyClarificationAnswer,
    shouldApplyPending,
    mergePendingInput,
    clearPendingIfResolved,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIClarificationService = api;
  if (root?.window) root.window.ChatUIClarificationService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
