(function initChatUIAppSessionPersistence(root) {
  'use strict';

  const { messageIdentity, isDurableImageCompletionMessage } = root?.[Symbol.for('chatui.module-registry.v1')]?.get('messagePrimitives')
    || (typeof require === 'function' ? require('../core/message-primitives') : {});

  function parseMessageOrderIndex(value) {
    if (value === null || value === undefined) return NaN;
    if (typeof value === 'string' && !value.trim()) return NaN;
    const index = Number(value);
    return Number.isFinite(index) && index >= 0 ? index : NaN;
  }

  function normalizeMessageOrderFields(messages = []) {
    let next = 0;
    return (Array.isArray(messages) ? messages : []).map(message => {
      if (!message || !message.role) return message;
      const copy = { ...message };
      const raw = message.role === 'user' ? message.messageIndex : message.responseIndex;
      const parsed = parseMessageOrderIndex(raw);
      const index = Number.isFinite(parsed) ? parsed : next;
      if (message.role === 'user') copy.messageIndex = String(index);
      if (message.role === 'assistant') copy.responseIndex = String(index);
      next = Math.max(next, index + 1);
      return copy;
    });
  }

  function messageSortIndex(message, fallback) {
    const value = message?.role === 'user' ? message.messageIndex : message?.role === 'assistant' ? message.responseIndex : undefined;
    const parsed = parseMessageOrderIndex(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  function roleSortWeight(role) { return role === 'system' ? 0 : role === 'user' ? 1 : role === 'assistant' ? 2 : 3; }

  function resolveUserMessageTurn(messages = [], requestedIndex, { rawText = '', messageId = '', turnId = '' } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const requestedMessageId = stableIdentityValue(messageId);
    const requestedTurnId = stableIdentityValue(turnId);
    const requested = parseMessageOrderIndex(requestedIndex);
    let userIndex = requestedMessageId
      ? list.findIndex(message => message?.role === 'user' && stableIdentityValue(message.id || message.messageId) === requestedMessageId)
      : requestedTurnId
        ? list.findIndex(message => message?.role === 'user' && stableIdentityValue(message.turnId || message.turn_id) === requestedTurnId)
        : Number.isFinite(requested)
          ? list.findIndex(message => message?.role === 'user' && parseMessageOrderIndex(message.messageIndex) === requested)
          : -1;
    if (userIndex < 0 && Number.isInteger(requested) && list[requested]?.role === 'user') userIndex = requested;
    const expectedText = String(rawText || '').trim();
    if (userIndex < 0 && expectedText) {
      userIndex = list.findIndex(message => message?.role === 'user' && String(message.rawText || (typeof message.content === 'string' ? message.content : '') || '').trim() === expectedText);
    }
    if (userIndex < 0) return null;

    const expectedResponseIndexes = new Set([userIndex + 1]);
    if (Number.isFinite(requested)) expectedResponseIndexes.add(requested + 1);
    let assistantIndex = list.findIndex((message, index) => index > userIndex && message?.role === 'assistant' && expectedResponseIndexes.has(parseMessageOrderIndex(message.responseIndex)));
    if (assistantIndex < 0) {
      for (let index = userIndex + 1; index < list.length; index += 1) {
        if (list[index]?.role === 'user') break;
        if (list[index]?.role === 'assistant') { assistantIndex = index; break; }
      }
    }
    return {
      userIndex,
      assistantIndex: assistantIndex >= 0 ? assistantIndex : userIndex + 1,
      hasAssistant: assistantIndex >= 0,
    };
  }

  function reindexCanonicalMessagePositions(messages = []) {
    if (!Array.isArray(messages)) return messages;
    messages.forEach((message, index) => {
      if (message?.role === 'user') message.messageIndex = String(index);
      if (message?.role === 'assistant') message.responseIndex = String(index);
    });
    return messages;
  }

  const STABLE_ID_RE = /^[A-Za-z0-9:_-]+$/;

  function stableIdentityValue(value = '') {
    const id = String(value || '').trim();
    return id && STABLE_ID_RE.test(id) ? id : '';
  }

  function stableIdentityPart(value = '', fallback = 'message') {
    const normalized = String(value || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return normalized.slice(0, 96) || fallback;
  }

  function createMessageTurnIdentity({ sessionId = 'session', submissionId = '', role = 'user', sequence = 0 } = {}) {
    const session = stableIdentityPart(sessionId, 'session');
    const turnPart = stableIdentityPart(submissionId, `legacy-${Number(sequence) || 0}`);
    const turnId = `turn:${session}:${turnPart}`;
    const canonicalRole = role === 'assistant' ? 'assistant' : 'user';
    return Object.freeze({
      id: `message:${session}:${turnPart}:${canonicalRole}`,
      turnId,
    });
  }

  function ensureCanonicalMessageIdentity(messages = [], { sessionId = 'session' } = {}) {
    const session = stableIdentityPart(sessionId, 'session');
    const list = (Array.isArray(messages) ? messages : []).map(message => message && typeof message === 'object'
      ? { ...message }
      : message);
    let latestUser = null;
    list.forEach((message, sequence) => {
      if (!message || !['user', 'assistant'].includes(message.role)) return;
      const legacyMessageId = stableIdentityValue(message.id || message.messageId);
      if (message.role === 'user') {
        const turnId = stableIdentityValue(message.turnId || message.turn_id)
          || `turn:${session}:${stableIdentityPart(legacyMessageId || `legacy-${sequence}`, `legacy-${sequence}`)}`;
        const id = legacyMessageId || `message:${session}:${stableIdentityPart(turnId, `turn-${sequence}`)}:user`;
        Object.assign(message, { id, turnId });
        delete message.turn_id;
        latestUser = message;
        return;
      }
      const replyToMessageId = stableIdentityValue(message.replyToMessageId || message.reply_to_message_id)
        || stableIdentityValue(latestUser?.id);
      const turnId = stableIdentityValue(message.turnId || message.turn_id || message.replyToTurnId || message.reply_to_turn_id)
        || stableIdentityValue(latestUser?.turnId)
        || `turn:${session}:orphan-${sequence}`;
      const id = legacyMessageId || `message:${session}:${stableIdentityPart(turnId, `orphan-${sequence}`)}:assistant`;
      Object.assign(message, { id, turnId, replyToMessageId });
      delete message.turn_id;
      delete message.reply_to_message_id;
      delete message.replyToTurnId;
      delete message.reply_to_turn_id;
    });
    return list;
  }

  function hasCanonicalMessagePositions(messages = []) {
    return (Array.isArray(messages) ? messages : []).every((message, index) => {
      if (!message || !['user', 'assistant'].includes(message.role)) return true;
      return messageSortIndex(message, index) === index;
    });
  }

  function repairCanonicalMessageSequence(messages = [], options = {}) {
    let list = (Array.isArray(messages) ? messages : []).map(message => message && typeof message === 'object'
      ? { ...message }
      : message);
    // A previous persistence race produced a highly recognizable corrupted
    // shape: every user message was followed by every assistant message. A
    // normal busy-session flow cannot create that layout, and equal role blocks
    // retain enough information to deterministically restore q1/a1/q2/a2.
    const firstAssistant = list.findIndex(message => message?.role === 'assistant');
    if (firstAssistant > 1) {
      const users = list.slice(0, firstAssistant);
      const assistants = list.slice(firstAssistant);
      if (users.every(message => message?.role === 'user')
        && assistants.length === users.length
        && assistants.every(message => message?.role === 'assistant')) {
        list = users.flatMap((user, index) => [user, assistants[index]]);
      }
    }
    // Array order is the durable conversation sequence. Role-specific index
    // fields are derived placement metadata, so stale legacy values must never
    // reshuffle alternating turns into a block of questions followed by replies.
    if (!hasCanonicalMessagePositions(list)) reindexCanonicalMessagePositions(list);
    return ensureCanonicalMessageIdentity(list, options);
  }

  function truncateConversationForRegeneration(messages = [], turn = null, { preserveAssistant = false } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    if (!turn || !Number.isInteger(turn.userIndex) || turn.userIndex < 0 || turn.userIndex >= list.length) return null;
    const assistantIndex = Number.isInteger(turn.assistantIndex) && turn.assistantIndex > turn.userIndex
      ? turn.assistantIndex
      : turn.userIndex + 1;
    const hasAssistant = list[assistantIndex]?.role === 'assistant';
    // Regenerating an old answer replaces one branch node; it must not truncate
    // the conversation that was written after that node. The previous
    // implementation spliced from the replacement slot to the end, silently
    // deleting every later user/assistant turn from both memory and storage.
    const removedMessages = hasAssistant && !preserveAssistant
      ? list.splice(assistantIndex, 1)
      : [];
    reindexCanonicalMessagePositions(list);
    return {
      userIndex: turn.userIndex,
      assistantIndex,
      hasAssistant: preserveAssistant && hasAssistant,
      removedMessages,
    };
  }

  function ensureAssistantReplacementSlot(messages = [], turn = null, placeholder = {}) {
    if (!Array.isArray(messages) || !turn || !Number.isInteger(turn.userIndex) || turn.userIndex < 0) return null;
    const user = messages[turn.userIndex];
    const replyIdentity = {
      ...(user?.turnId ? { turnId: user.turnId } : {}),
      ...(user?.id ? { replyToMessageId: user.id } : {}),
    };
    if (turn.hasAssistant && messages[turn.assistantIndex]?.role === 'assistant') {
      if (placeholder?.replacing) {
        const existing = messages[turn.assistantIndex];
        messages[turn.assistantIndex] = {
          role: 'assistant',
          content: '',
          rawText: '',
          html: '',
          responseIndex: String(turn.assistantIndex),
          replacing: true,
          ...(existing?.id ? { id: existing.id } : {}),
          ...(existing?.turnId ? { turnId: existing.turnId } : replyIdentity),
          ...(existing?.replyToMessageId ? { replyToMessageId: existing.replyToMessageId } : replyIdentity),
          ...(existing?.displayItemId ? { displayItemId: existing.displayItemId } : {}),
          ...placeholder,
        };
      }
      reindexCanonicalMessagePositions(messages);
      return { ...turn, assistantIndex: turn.assistantIndex, hasAssistant: true };
    }
    const assistantIndex = Math.min(messages.length, Math.max(turn.userIndex + 1, Number(turn.assistantIndex) || 0));
    messages.splice(assistantIndex, 0, { role: 'assistant', content: '', rawText: '', replacing: true, ...replyIdentity, ...placeholder });
    reindexCanonicalMessagePositions(messages);
    return { ...turn, assistantIndex, hasAssistant: true, inserted: true };
  }
  function sortCanonicalMessages(messages = []) {
    return normalizeMessageOrderFields(messages).map((msg, fallback) => ({ msg, fallback })).sort((a, b) => {
      const byIndex = messageSortIndex(a.msg, a.fallback) - messageSortIndex(b.msg, b.fallback);
      if (byIndex) return byIndex;
      const byRole = roleSortWeight(a.msg?.role) - roleSortWeight(b.msg?.role);
      return byRole || a.fallback - b.fallback;
    }).map(item => item.msg);
  }

  function cloneMessageList(messages = [], normalizeMessageForStorage = value => value) {
    return messages.map(item => normalizeMessageForStorage(item)).filter(Boolean);
  }
  function mergeMessageMeta(current, next) {
    return current && next && current.role === next.role && current.content === next.content ? {
      ...current,
      ...(!current.metaText && next.metaText ? { metaText: next.metaText } : {}),
      ...(!current.rawText && next.rawText ? { rawText: next.rawText } : {}),
      ...(!current.html && next.html ? { html: next.html } : {}),
      ...(!current.displayItemId && next.displayItemId ? { displayItemId: next.displayItemId } : {}),
      ...(!current.imageJobId && next.imageJobId ? { imageJobId: next.imageJobId } : {}),
      ...(!current.quoteContext && next.quoteContext ? { quoteContext: next.quoteContext } : {}),
      ...(!current.imageContext && next.imageContext ? { imageContext: next.imageContext } : {}),
      ...(!current.attachmentContext && next.attachmentContext ? { attachmentContext: next.attachmentContext } : {}),
      ...(!current.reasoning_content && next.reasoning_content ? { reasoning_content: next.reasoning_content } : {}),
    } : current;
  }
  function isDurableImageMessage(message) {
    return typeof isDurableImageCompletionMessage === 'function'
      && isDurableImageCompletionMessage(message);
  }
  function imageResultRevision(message = {}) {
    const context = message?.imageContext;
    let parsed = context;
    if (typeof context === 'string') {
      try { parsed = JSON.parse(context); } catch { parsed = null; }
    }
    const revision = Number(parsed?.updatedAt || parsed?.updated_at || message?.updatedAt || 0);
    return Number.isFinite(revision) && revision > 0 ? revision : 0;
  }
  function preferStoredMessage(current, next) {
    const currentIsImageResult = isDurableImageMessage(current);
    const nextIsImageResult = isDurableImageMessage(next);
    // A completed image is the only durable record that can restore the generated
    // result. It must win if a stale clarification/pending reply reused its index.
    if (currentIsImageResult !== nextIsImageResult) return nextIsImageResult ? next : current;
    if (currentIsImageResult && nextIsImageResult) {
      const currentRevision = imageResultRevision(current);
      const nextRevision = imageResultRevision(next);
      if (currentRevision !== nextRevision) return nextRevision > currentRevision ? next : current;
      // Matching or legacy-missing revisions retain the later canonical result.
      return next;
    }
    const currentText = String(current?.content || current?.rawText || '');
    const nextText = String(next?.content || next?.rawText || '');
    const currentIsStatus = /^(正在处理中|正在生成图片|正在修改图片|正在恢复图片)/.test(currentText);
    const nextIsStatus = /^(正在处理中|正在生成图片|正在修改图片|正在恢复图片)/.test(nextText);
    if (currentIsStatus !== nextIsStatus) return currentIsStatus ? next : current;
    return nextText.length > currentText.length ? next : mergeMessageMeta(current, next);
  }
  function compactAdjacentDuplicateMessages(messages = [], normalizeMessageForStorage = value => value) {
    const result = [];
    const byIdentity = new Map();
    for (const message of sortCanonicalMessages(messages).map(normalizeMessageForStorage).filter(Boolean)) {
      const identity = messageIdentity(message);
      const existingIndex = identity ? byIdentity.get(identity) : undefined;
      if (existingIndex !== undefined) {
        result[existingIndex] = preferStoredMessage(result[existingIndex], message);
        continue;
      }
      const previous = result[result.length - 1];
      if (previous && previous.role === message.role && previous.content === message.content) result[result.length - 1] = mergeMessageMeta(previous, message);
      else {
        result.push(message);
        if (identity) byIdentity.set(identity, result.length - 1);
      }
    }
    return result;
  }
  function displayItemIdentity(item) {
    if (!item || !['user', 'assistant'].includes(item.role)) return '';
    const value = item.role === 'user' ? item.messageIndex : item.responseIndex;
    return value !== undefined && value !== null && value !== '' ? `${item.role}:${value}` : '';
  }
  function isDurableImageDisplayItem(item) {
    const html = String(item?.html || '');
    return (/class=(['"])[^'"]*generated-thumb/i.test(html) && /data-persisted-src=(['"])indexeddb:\/\//i.test(html))
      || /data-persisted-src=(['"])indexeddb:\/\//i.test(html)
      || /indexeddb:\/\//i.test(String(item?.imageContext || ''));
  }
  function preferDisplayItem(current, next) {
    const currentIsImageResult = isDurableImageDisplayItem(current);
    const nextIsImageResult = isDurableImageDisplayItem(next);
    // Plain assistant HTML is not rich media. Preserve the IndexedDB-backed image
    // card rather than whichever colliding response happens to have more text.
    if (currentIsImageResult !== nextIsImageResult) return nextIsImageResult ? next : current;
    const currentRich = !!(current?.html || current?.imageContext || current?.attachmentContext);
    const nextRich = !!(next?.html || next?.imageContext || next?.attachmentContext);
    if (currentRich !== nextRich) return nextRich ? next : current;
    if (!!current?.pending !== !!next?.pending) return current?.pending ? next : current;
    return String(next?.rawText || '').length > String(current?.rawText || '').length ? next : current;
  }
  function compactDisplayItems(items = []) {
    const result = [];
    const byIdentity = new Map();
    for (const item of items || []) {
      if (!item) continue;
      const identity = displayItemIdentity(item);
      const existingIndex = identity ? byIdentity.get(identity) : undefined;
      if (existingIndex !== undefined) {
        result[existingIndex] = preferDisplayItem(result[existingIndex], item);
        continue;
      }
      const previous = result[result.length - 1];
      const key = [item.role || '', item.rawText || '', item.html || '', item.pending || '', item.jobId || '', item.responseIndex || '', item.messageIndex || '', item.quoteContext || ''].join('');
      const prevKey = previous ? [previous.role || '', previous.rawText || '', previous.html || '', previous.pending || '', previous.jobId || '', previous.responseIndex || '', previous.messageIndex || '', previous.quoteContext || ''].join('') : '';
      if (previous && key === prevKey) {
        if (item.metaText && !previous.metaText) previous.metaText = item.metaText;
        if (item.reasoningText && !previous.reasoningText) previous.reasoningText = item.reasoningText;
        if (item.keepReasoning && !previous.keepReasoning) previous.keepReasoning = item.keepReasoning;
        if (item.quoteContext && !previous.quoteContext) previous.quoteContext = item.quoteContext;
        if (item.imageContext && !previous.imageContext) previous.imageContext = item.imageContext;
        if (item.attachmentContext && !previous.attachmentContext) previous.attachmentContext = item.attachmentContext;
      } else {
        result.push(item);
        if (identity) byIdentity.set(identity, result.length - 1);
      }
    }
    return result;
  }

  function stripGeneratedImageActionMarkup(html = '', documentRef = root.document) {
    const text = String(html || '');
    if (!/(data-(?:download|copy|share)-image|image-download-row|generated-image-actions|image-icon-btn)/i.test(text)) return text;
    try {
      const template = documentRef.createElement('template');
      template.innerHTML = text;
      template.content.querySelectorAll('.image-download-row,.generated-image-actions,button[data-download-image],button[data-copy-image],button[data-share-image],a[data-download-image],a[data-copy-image],a[data-share-image],.generated-image-item > .image-icon-btn').forEach(node => node.remove());
      return template.innerHTML;
    } catch { return text; }
  }
  function stripTransientBlobUrlsFromHtml(html = '', documentRef = root.document) {
    const stripped = stripGeneratedImageActionMarkup(String(html || '').replace(/\s(?:src|href)=(['"])blob:[^'"]*\1/gi, '').replace(/\sdata-object-url=(['"])blob:[^'"]*\1/gi, '').replace(/\sdata-preview-object-url=(['"])blob:[^'"]*\1/gi, ''), documentRef);
    try {
      const template = documentRef.createElement('template');
      template.innerHTML = stripped;
      template.content.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src') || '';
        const persisted = img.getAttribute('data-persisted-src') || '';
        const srcOmitted = src.includes('attachment-data-omitted') || src.includes('image-data-omitted');
        const persistedOmitted = persisted.includes('attachment-data-omitted') || persisted.includes('image-data-omitted');
        if (!srcOmitted && !persistedOmitted) return;
        if (srcOmitted) img.removeAttribute('src');
        if (persistedOmitted) img.removeAttribute('data-persisted-src');
        const remainingPersisted = img.getAttribute('data-persisted-src') || '';
        if (!remainingPersisted) {
          img.classList.add('image-missing');
          if (!img.getAttribute('alt')) img.setAttribute('alt', '图片数据已省略');
        }
      });
      template.content.querySelectorAll('img[data-persisted-src], img[src^="indexeddb://"]').forEach(img => {
        const persisted = img.getAttribute('data-persisted-src') || img.getAttribute('src') || '';
        const currentSrc = img.getAttribute('src') || '';
        if (persisted && !img.getAttribute('data-persisted-src')) img.setAttribute('data-persisted-src', persisted);
        if (persisted && !img.getAttribute('data-original-src')) img.setAttribute('data-original-src', persisted);
        const shouldRemoveSrc = persisted.startsWith('indexeddb://') && (!currentSrc || currentSrc.startsWith('indexeddb://') || /^undefined|null$/i.test(currentSrc) || currentSrc.includes('[attachment-data-omitted]'));
        if (shouldRemoveSrc) img.removeAttribute('src');
      });
      return template.innerHTML;
    } catch {
      return stripped
        .replace(/(<img\b[^>]*?)\ssrc=(['"])[^'"]*(?:attachment-data-omitted|image-data-omitted)[^'"]*\2/gi, '$1')
        .replace(/(<img\b[^>]*?)\sdata-persisted-src=(['"])[^'"]*(?:attachment-data-omitted|image-data-omitted)[^'"]*\2/gi, '$1')
        .replace(/(<img\b[^>]*?)\ssrc=(['"])(indexeddb:\/\/[^'"]*)\2/gi, (_all, before, quote, src) => `${before} data-persisted-src=${quote}${src}${quote}`);
    }
  }
  const TRANSIENT_MEDIA_FIELD_RE = /^(?:url|src|image|image_url|dataUrl|data_url|previewSrc|preview_src|objectUrl|object_url)$/i;
  const TRANSIENT_MEDIA_ARRAY_RE = /^(?:images?|attachments?)$/i;

  function sanitizeStorageValue(value, stripLargeDataUrlsFromText = text => String(text || ''), parentKey = '') {
    if (typeof value === 'string') {
      if ((TRANSIENT_MEDIA_FIELD_RE.test(parentKey) || TRANSIENT_MEDIA_ARRAY_RE.test(parentKey)) && /^(?:data:|blob:)/i.test(value)) return '';
      return stripLargeDataUrlsFromText(value);
    }
    if (Array.isArray(value)) {
      return value.map(item => sanitizeStorageValue(item, stripLargeDataUrlsFromText, parentKey)).filter(item => item !== '');
    }
    if (value && typeof value === 'object') {
      const copy = { ...value };
      Object.keys(copy).forEach(key => { copy[key] = sanitizeStorageValue(copy[key], stripLargeDataUrlsFromText, key); });
      return copy;
    }
    return value;
  }

  function sanitizeAttachmentContextForStorage(value, stripLargeDataUrlsFromText = text => String(text || '')) {
    if (!value) return '';
    try {
      const context = typeof value === 'string' ? JSON.parse(value) : value;
      if (!context || typeof context !== 'object' || Array.isArray(context)) return '';
      const clean = sanitizeStorageValue(context, stripLargeDataUrlsFromText);
      if (Array.isArray(clean.attachments)) {
        clean.attachments = clean.attachments.filter(item => item && typeof item === 'object' && (
          item.name || item.filename || item.src || item.url || item.text || item.id || item.attachmentId || item.attachment_id || item.imageId || item.image_id
        ));
      }
      return JSON.stringify(clean);
    } catch { return ''; }
  }

  function escapeRegExp(value = '') {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function stripLeadingMessageMeta(text = '', metaText = '') {
    let result = String(text || '');
    const meta = String(metaText || '').trim();
    if (meta) result = result.replace(new RegExp(`^\\s*${escapeRegExp(meta)}\\s*(?:\\n+|$)`, 'i'), '');
    return result.replace(/^\s*(?:TTFT|RT)\s+\d+(?:\.\d+)?\s*(?:ms|s)(?:\s*·\s*(?:TTFT|RT)\s+\d+(?:\.\d+)?\s*(?:ms|s))*\s*(?:\n+|$)/i, '');
  }
  function displayHtmlHasRichMedia(html = '') {
    return /data-persisted-src=|data-persisted-href=|user-attachment-preview-grid|class=["'][^"']*(?:generated-thumb|user-attachment-image)|image-download-row/i.test(String(html || ''));
  }
  function sanitizeStoredDisplayItem(item = {}, deps = {}) {
    const stripLargeDataUrlsFromText = deps.stripLargeDataUrlsFromText || (text => String(text || ''));
    const clean = { ...item };
    const rawText = stripLargeDataUrlsFromText(clean.rawText || '');
    clean.rawText = stripLeadingMessageMeta(rawText, clean.metaText);
    clean.html = stripTransientBlobUrlsFromHtml(stripLargeDataUrlsFromText(clean.html || ''), deps.document);
    if (clean.rawText !== rawText && clean.html && !displayHtmlHasRichMedia(clean.html)) clean.html = '';
    clean.imageContext = sanitizeAttachmentContextForStorage(clean.imageContext, stripLargeDataUrlsFromText);
    clean.attachmentContext = sanitizeAttachmentContextForStorage(clean.attachmentContext, stripLargeDataUrlsFromText);
    if (clean.presentation && typeof clean.presentation === 'object' && !Array.isArray(clean.presentation)) {
      clean.presentation = sanitizeStorageValue(clean.presentation, stripLargeDataUrlsFromText);
      clean.presentation.html = stripTransientBlobUrlsFromHtml(stripLargeDataUrlsFromText(clean.presentation.html || ''), deps.document);
    }
    return clean;
  }
  function sanitizeStoredMessage(message = {}, deps = {}) {
    const stripLargeDataUrlsFromText = deps.stripLargeDataUrlsFromText || (text => String(text || ''));
    const clean = { ...message };
    clean.content = sanitizeStorageValue(clean.content ?? '', stripLargeDataUrlsFromText);
    if (typeof clean.content === 'string') clean.content = stripLeadingMessageMeta(clean.content, clean.metaText);
    const rawText = stripLargeDataUrlsFromText(clean.rawText || '');
    clean.rawText = stripLeadingMessageMeta(rawText, clean.metaText);
    clean.html = stripTransientBlobUrlsFromHtml(stripLargeDataUrlsFromText(clean.html || ''), deps.document);
    if ((clean.rawText !== rawText || (typeof message.content === 'string' && clean.content !== message.content)) && clean.html && !displayHtmlHasRichMedia(clean.html)) clean.html = '';
    clean.imageContext = sanitizeAttachmentContextForStorage(clean.imageContext, stripLargeDataUrlsFromText);
    clean.attachmentContext = sanitizeAttachmentContextForStorage(clean.attachmentContext, stripLargeDataUrlsFromText);
    if (clean.presentation && typeof clean.presentation === 'object' && !Array.isArray(clean.presentation)) {
      clean.presentation = sanitizeStorageValue(clean.presentation, stripLargeDataUrlsFromText);
      clean.presentation.html = stripTransientBlobUrlsFromHtml(stripLargeDataUrlsFromText(clean.presentation.html || ''), deps.document);
    }
    return clean;
  }

  function safeSetJsonStorage(key, value, maxItems = 80, storage = root.localStorage) {
    // Never turn a storage quota failure into data deletion. IndexedDB session
    // snapshots are authoritative; localStorage is only a compatibility backup.
    // Keep the previous backup intact and always return the complete in-memory value.
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch (err) {
      if (!/quota|exceed/i.test(String(err?.name || err?.message || err))) throw err;
      try { root?.console?.warn?.('localStorage backup quota exceeded; full session history retained in memory/IndexedDB', key); } catch {}
    }
    return value;
  }
  function stripLargePayloadData(value, stripLargeDataUrlsFromText = text => String(text || '')) {
    if (typeof value === 'string') return stripLargeDataUrlsFromText(value);
    if (Array.isArray(value)) return value.map(item => stripLargePayloadData(item, stripLargeDataUrlsFromText));
    if (value && typeof value === 'object') {
      const copy = { ...value };
      if (Array.isArray(copy.messages)) copy.messages = copy.messages.slice(-20);
      Object.keys(copy).forEach(key => { copy[key] = stripLargePayloadData(copy[key], stripLargeDataUrlsFromText); });
      return copy;
    }
    return value;
  }
  function compactJobForStorage(job, keepPayload = true, stripLargeDataUrlsFromText = text => String(text || '')) {
    if (!job || typeof job !== 'object') return job;
    const copy = { ...job };
    if (copy.payload) copy.payload = keepPayload ? stripLargePayloadData(copy.payload, stripLargeDataUrlsFromText) : null;
    return copy;
  }
  function safeSetJobStorage(key, job, { storage = root.localStorage, stripLargeDataUrlsFromText = text => String(text || '') } = {}) {
    if (!job?.id) return null;
    // A job snapshot participates in final_execution recovery only when its
    // request payload, dispatch contract, and binding evidence are all present.
    // Never overwrite a valid prior owner with a payload-less display fallback:
    // resume correctly rejects such a record, which used to strand quoted-image
    // edits after a localStorage quota fallback.
    const candidate = compactJobForStorage(job, true, stripLargeDataUrlsFromText);
    try {
      storage.setItem(key, JSON.stringify(candidate));
      return candidate;
    } catch (err) {
      if (!/quota|exceed/i.test(String(err?.name || err?.message || err))) throw err;
    }
    // A failed best-effort update must not erase the last resumable job. Keeping
    // an older record is safer than converting an in-flight task into an
    // unrecoverable one during a reload. Callers receive null and must keep the
    // pending-submit owner instead of claiming that handoff succeeded.
    try { root?.console?.warn?.('localStorage job backup quota exceeded; retaining previous resumable job', key); } catch {}
    return null;
  }

  const api = Object.freeze({ parseMessageOrderIndex, normalizeMessageOrderFields, messageSortIndex, roleSortWeight, stableIdentityValue, createMessageTurnIdentity, ensureCanonicalMessageIdentity, resolveUserMessageTurn, reindexCanonicalMessagePositions, hasCanonicalMessagePositions, repairCanonicalMessageSequence, truncateConversationForRegeneration, ensureAssistantReplacementSlot, sortCanonicalMessages, cloneMessageList, mergeMessageMeta, compactAdjacentDuplicateMessages, compactDisplayItems, stripGeneratedImageActionMarkup, stripTransientBlobUrlsFromHtml, sanitizeAttachmentContextForStorage, sanitizeStoredDisplayItem, sanitizeStoredMessage, safeSetJsonStorage, stripLargePayloadData, compactJobForStorage, safeSetJobStorage });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppSessionPersistence = api;
  if (root?.window) root.window.ChatUIAppSessionPersistence = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
