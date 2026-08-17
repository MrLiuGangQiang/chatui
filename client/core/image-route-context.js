(function initChatUICoreImageRouteContext(root) {
  'use strict';

const imageReferences = root?.ChatUICoreImageReferences || (typeof require === 'function' ? require('./image-references') : {});
const taskContinuity = root?.[Symbol.for('chatui.module-registry.v1')]?.get('taskContinuity')
  || (typeof require === 'function' ? require('../../shared/task-continuity') : {});
const {
  makeImageReferenceId,
  parseImageReferenceId,
  makeImageItemId,
  normalizeSelectedImageIds,
  normalizeImageSelection,
} = imageReferences;

function coreAttachments() {
  return root?.ChatUICoreAttachments
    || root?.ChatUICore?.attachments
    || (typeof require === 'function' ? require('./attachments') : {});
}

function uploadedImageAttachmentLabel(item = {}, ordinal = 1) {
  const helper = coreAttachments()?.imageAttachmentLabel;
  if (typeof helper === 'function') return helper(item, ordinal);
  const explicit = String(
    item.label || item.description || item.semanticDescription || item.semantic_description || item.subject || '',
  ).replace(/\s+/g, ' ').trim();
  if (explicit) return explicit.slice(0, 240);
  const rawName = String(item.name || item.filename || item.file?.name || '').trim();
  const filename = (rawName.split(/[\\/]/).pop() || '')
    .replace(/\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i, '')
    .trim();
  return (filename || `第 ${Number(ordinal) || 1} 张上传图片`).slice(0, 240);
}

const DEFAULT_ROUTE_CONTEXT_MAX_CHARS = 256 * 1024;
const MAX_RESOLVED_IMAGE_GOAL_LENGTH = Number(taskContinuity.TASK_CONTINUITY_MAX_RENDERED_LENGTH) || 16000;
const ROUTE_CONTEXT_POLICY = Object.freeze({
  schema_version: 'route_context_policy.v1',
  max_serialized_chars: DEFAULT_ROUTE_CONTEXT_MAX_CHARS,
  message_excerpt_chars: 240,
  preferred_image_candidates: 12,
  preferred_reference_groups: 1,
  summarize_omitted: false,
});
const ROUTE_FILE_CANDIDATE_TEXT_LIMITS = Object.freeze({
  name: 240,
  filename: 240,
  type: 120,
  unsupported_reason: 240,
  unsupportedReason: 240,
});
const PROTECTED_ROUTE_SOURCES = new Set(['current', 'quoted', 'user_message']);

function sharedContextBudget() {
  return root?.ChatUISharedContextBudget
    || (typeof require === 'function' ? require('../../shared/config/context-budget') : null);
}

function routeContextSize(value) {
  try { return JSON.stringify(value || {}).length; } catch { return Infinity; }
}

function routeContextTokenSize(value) {
  const budget = sharedContextBudget();
  if (typeof budget?.estimateTextTokens !== 'function') return 0;
  try { return budget.estimateTextTokens(JSON.stringify(value || {})); } catch { return Infinity; }
}

function truncateRouteContextText(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function compactRouteFileCandidate(candidate = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
  const next = { ...candidate };
  for (const [key, maxChars] of Object.entries(ROUTE_FILE_CANDIDATE_TEXT_LIMITS)) {
    if (next[key] !== undefined && next[key] !== null) next[key] = truncateRouteContextText(next[key], maxChars);
  }
  // Route recognition needs file identity and metadata, never an inline body.
  for (const key of [
    'text', 'content', 'raw', 'dataUrl', 'data_url', 'fileData', 'file_data',
    'src', 'url', 'persistedSrc', 'persisted_src', 'file',
  ]) delete next[key];
  return next;
}

function routeSourceIsProtected(value = '') {
  return PROTECTED_ROUTE_SOURCES.has(String(value || '').trim());
}

function routeMessageIdentity(message = {}) {
  return String(
    message?.id
    || message?.displayItemId
    || message?.display_item_id
    || message?.messageId
    || message?.message_id
    || '',
  ).trim();
}

function quotedRouteMessageMatches(message = {}, quoted = null) {
  if (!quoted || typeof quoted !== 'object') return false;
  const messageId = routeMessageIdentity(message);
  const quotedId = routeMessageIdentity(quoted);
  if (messageId && quotedId && messageId === quotedId) return true;
  const messageResourceId = String(message?.resource_id || message?.resourceId || '').trim();
  const quotedResourceId = String(quoted?.resource_id || quoted?.resourceId || '').trim();
  if (messageResourceId && quotedResourceId && messageResourceId === quotedResourceId) return true;
  const messageIndex = Number(message?.index);
  const quotedIndex = Number(quoted?.index);
  return Number.isInteger(messageIndex) && messageIndex >= 1
    && Number.isInteger(quotedIndex) && quotedIndex >= 1
    && messageIndex === quotedIndex;
}

function isProtectedRouteMessage(message = {}, quoted = null) {
  return message?.route_context_protected === true
    || message?.routeContextProtected === true
    || routeSourceIsProtected(message?.source)
    || quotedRouteMessageMatches(message, quoted);
}

function cloneRouteContext(context = {}) {
  const next = {
    ...context,
    recent_messages: Array.isArray(context.recent_messages) ? [...context.recent_messages] : [],
    image_candidates: Array.isArray(context.image_candidates) ? [...context.image_candidates] : [],
    file_candidates: Array.isArray(context.file_candidates)
      ? context.file_candidates
        .filter(candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate))
        .map(compactRouteFileCandidate)
      : [],
    recent_image_references: Array.isArray(context.recent_image_references) ? [...context.recent_image_references] : [],
    recent_uploaded_image_references: Array.isArray(context.recent_uploaded_image_references) ? [...context.recent_uploaded_image_references] : [],
  };
  if (Array.isArray(context.image_memory_cards)) {
    Object.defineProperty(next, 'image_memory_cards', {
      value: context.image_memory_cards,
      enumerable: false,
      configurable: true,
    });
  }
  return next;
}

function routeContextLimits(options = {}) {
  const parsedMaxChars = Number(options.maxChars);
  const maxChars = options.enforceMaxChars === false
    ? Infinity
    : Number.isFinite(parsedMaxChars) && parsedMaxChars > 0
      ? parsedMaxChars
      : ROUTE_CONTEXT_POLICY.max_serialized_chars;
  const budget = sharedContextBudget();
  const contextWindowTokens = options.contextWindowTokens;
  const maxTokens = options.enforceTokenWindow === false
    || typeof budget?.inputBudgetForContextWindow !== 'function'
    ? Infinity
    : budget.inputBudgetForContextWindow(contextWindowTokens);
  return Object.freeze({ maxChars, maxTokens });
}

function routeContextBudgetState(context = {}, limits = {}) {
  const serializedChars = routeContextSize(context);
  const estimatedTokens = Number.isFinite(limits.maxTokens) ? routeContextTokenSize(context) : 0;
  return {
    serializedChars,
    estimatedTokens,
    withinBudget: serializedChars <= limits.maxChars && estimatedTokens <= limits.maxTokens,
  };
}

function createRouteContextRequiredOverflowError(context = {}, limits = {}) {
  const state = routeContextBudgetState(context, limits);
  const error = new RangeError('Protected route context exceeds the configured model context budget');
  error.code = 'ROUTE_CONTEXT_REQUIRED_CONTENT_TOO_LARGE';
  error.statusCode = 400;
  error.serializedChars = state.serializedChars;
  error.maxChars = limits.maxChars;
  error.estimatedTokens = state.estimatedTokens;
  error.maxTokens = limits.maxTokens;
  return error;
}

function routeMessageGroups(messages = []) {
  const groups = [];
  let current = [];
  (Array.isArray(messages) ? messages : []).forEach((message, index) => {
    if (message?.role === 'user' && current.length) {
      groups.push(current);
      current = [];
    }
    current.push({ index, message });
  });
  if (current.length) groups.push(current);
  return groups;
}

function removeOldestOptionalMessageGroup(context = {}) {
  const messages = Array.isArray(context.recent_messages) ? context.recent_messages : [];
  const group = routeMessageGroups(messages)
    .find(items => !items.some(item => isProtectedRouteMessage(item.message, context.quoted_message)));
  if (!group) return false;
  const removed = new Set(group.map(item => item.index));
  context.recent_messages = messages.filter((_message, index) => !removed.has(index));
  return true;
}

function removeOldestOptionalCandidate(list = [], minimumCount = 0) {
  if (!Array.isArray(list) || list.length <= minimumCount) return false;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (routeSourceIsProtected(list[index]?.source)) continue;
    list.splice(index, 1);
    return true;
  }
  return false;
}

function removeOldestOptionalReference(list = [], minimumCount = 0) {
  return removeOldestOptionalCandidate(list, minimumCount);
}

function applyRouteContextPolicy(context = {}, options = {}) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new TypeError('Route context must be an object');
  }
  const next = cloneRouteContext(context);
  const limits = routeContextLimits(options);
  const fits = () => routeContextBudgetState(next, limits).withinBudget;
  if (fits()) return next;

  // History is optional evidence. Evict complete oldest turns first; never invent
  // a summary and never alter quoted/current facts.
  while (!fits() && removeOldestOptionalMessageGroup(next)) {}

  // Keep a useful recent visual catalog when possible, then remove only optional
  // history if the same canonical budget still requires it.
  while (!fits() && removeOldestOptionalCandidate(
    next.image_candidates,
    ROUTE_CONTEXT_POLICY.preferred_image_candidates,
  )) {}
  while (!fits() && removeOldestOptionalReference(
    next.recent_image_references,
    ROUTE_CONTEXT_POLICY.preferred_reference_groups,
  )) {}
  while (!fits() && removeOldestOptionalReference(
    next.recent_uploaded_image_references,
    ROUTE_CONTEXT_POLICY.preferred_reference_groups,
  )) {}

  // These are duplicate display/cache hints; canonical candidates and execution
  // state remain available to the router.
  for (const key of ['latest_assistant_image_result']) {
    if (!fits() && next[key] !== undefined) delete next[key];
  }

  while (!fits() && removeOldestOptionalCandidate(next.file_candidates, 0)) {}
  while (!fits() && removeOldestOptionalCandidate(next.image_candidates, 0)) {}
  while (!fits() && removeOldestOptionalReference(next.recent_image_references, 0)) {}
  while (!fits() && removeOldestOptionalReference(next.recent_uploaded_image_references, 0)) {}

  if (!fits()) throw createRouteContextRequiredOverflowError(next, limits);
  return next;
}

function compactRouteMessage(message = {}, index = 0) {
  const next = {
    index,
    id: routeMessageIdentity(message),
    role: message.role || '',
    content: String(Array.isArray(message.content) ? message.rawText || '[非文本消息]' : message.content || message.rawText || '')
      .slice(0, ROUTE_CONTEXT_POLICY.message_excerpt_chars),
  };
  const resourceId = String(message.resourceId || message.resource_id || '').trim();
  const identityAliases = message.identity_aliases || message.identityAliases;
  if (resourceId) next.resource_id = resourceId;
  if (Array.isArray(identityAliases) && identityAliases.length) next.identity_aliases = [...identityAliases];
  return next;
}
function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

function isImageAttachmentMeta(item = {}) {
  const type = String(item.type || item.mime || '').toLowerCase();
  const name = String(item.name || item.filename || '').toLowerCase();
  const src = String(item.src || item.url || '').toLowerCase();
  return type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i.test(name) || src.startsWith('data:image/');
}

function uploadedAttachmentsFromMessage(message = {}) {
  const imageContext = parseJsonObject(message.imageContext);
  if (imageContext?.attachments?.length && (imageContext.target === 'uploaded' || imageContext.mode === 'edit_image')) {
    return imageContext.attachments.filter(item => item?.src);
  }
  const attachmentContext = parseJsonObject(message.attachmentContext);
  if (attachmentContext?.attachments?.length) return attachmentContext.attachments.filter(isImageAttachmentMeta);
  return [];
}

function legacyFileAttachmentsFromMessage(message = {}) {
  const content = String(
    Array.isArray(message?.content)
      ? message?.rawText || ''
      : message?.content || message?.rawText || '',
  );
  const files = [];
  const pattern = /\[file\s+id=([^\s\]]+)\s+name=(.*?)\s+type=([^\s\]]+)\s+size=(\d+)\]/gi;
  for (const match of content.matchAll(pattern)) {
    const id = String(match[1] || '').trim();
    if (!id) continue;
    const safeId = id.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 96) || 'attachment';
    const persistedSrc = `indexeddb://attachment-file-${safeId}`;
    files.push({
      id,
      attachmentId: id,
      name: String(match[2] || 'attachment').trim() || 'attachment',
      type: String(match[3] || 'application/octet-stream').trim() || 'application/octet-stream',
      size: Number(match[4]) || 0,
      inputFile: true,
      src: persistedSrc,
      persistedSrc,
    });
  }
  return files;
}

function uploadedFileAttachmentsFromMessage(message = {}) {
  const attachmentContext = parseJsonObject(message.attachmentContext || message.attachment_context);
  const contextual = Array.isArray(attachmentContext?.attachments)
    ? attachmentContext.attachments.filter(item => item && !isImageAttachmentMeta(item))
    : [];
  const presented = message?.presentation?.kind === 'attachment' && Array.isArray(message.presentation.attachments)
    ? message.presentation.attachments.filter(item => item && !isImageAttachmentMeta(item))
    : [];
  const legacy = legacyFileAttachmentsFromMessage(message);
  const merged = new Map();
  for (const item of [...contextual, ...presented, ...legacy]) {
    const id = String(item?.id || item?.attachmentId || item?.attachment_id || item?.fileId || item?.file_id || '').trim();
    const key = id || `${String(item?.name || item?.filename || '')}|${String(item?.type || '')}|${Number(item?.size) || 0}`;
    if (!key) continue;
    const existing = merged.get(key) || {};
    merged.set(key, {
      ...item,
      ...existing,
      id: existing.id || item.id || id,
      attachmentId: existing.attachmentId || existing.attachment_id || item.attachmentId || item.attachment_id || id,
      src: existing.src || existing.persistedSrc || existing.persisted_src || item.src || item.persistedSrc || item.persisted_src || '',
      persistedSrc: existing.persistedSrc || existing.persisted_src || item.persistedSrc || item.persisted_src || item.src || '',
    });
  }
  return [...merged.values()];
}

function isInputFileAvailable(item = {}) {
  const helper = root?.ChatUICoreAttachments?.isInputFileAvailable
    || root?.ChatUICore?.attachments?.isInputFileAvailable;
  if (typeof helper === 'function') return !!helper(item);
  const marked = item.inputFile === true || item.input_file === true;
  if (!marked) return false;
  return !!(
    item.file
    || item.persistedSrc
    || item.persisted_src
    || item.src
    || item.dataUrl
    || item.data_url
    || item.fileData
    || item.file_data
  );
}

function buildFileCandidates(messages = []) {
  const result = [];
  for (let messageIndex = (Array.isArray(messages) ? messages.length : 0) - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message?.role !== 'user') continue;
    const files = uploadedFileAttachmentsFromMessage(message);
    for (const file of files) {
      result.push({
        index: result.length + 1,
        source: 'history',
        file_id: file.id || file.attachmentId || file.attachment_id || '',
        name: file.name || file.filename || 'attachment',
        type: file.type || 'application/octet-stream',
        size: Number(file.size) || 0,
        has_extracted_text: !!String(file.text || '').trim(),
        input_file_available: isInputFileAvailable(file),
        unsupported_reason: file.unsupportedReason || file.unsupported_reason || '',
        message_index: messageIndex + 1,
      });
    }
  }
  return result;
}

function messageText(message = {}, fallback = '') {
  return String(Array.isArray(message?.content) ? message.rawText || fallback : message?.rawText || message?.content || fallback || '').trim();
}

function findNextAssistantMessage(messages = [], startIndex = 0) {
  for (let index = startIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === 'assistant') return message;
    if (message?.role === 'user') return null;
  }
  return null;
}

function uploadedReferenceIdForMessageIndex(index = 0) {
  return makeImageReferenceId(`uploaded_${Number(index) + 1}`);
}

function collectRecentUploadedImageReferences({ messages = [], limit = 6 } = {}) {
  const allMessages = Array.isArray(messages) ? messages : [];
  const references = [];
  for (let index = allMessages.length - 1; index >= 0; index -= 1) {
    if (references.length >= limit) break;
    const message = allMessages[index];
    if (message?.role !== 'user') continue;
    const attachments = uploadedAttachmentsFromMessage(message);
    if (!attachments.length) continue;
    const imageContext = parseJsonObject(message.imageContext);
    const referenceId = uploadedReferenceIdForMessageIndex(index);
    const assistant = findNextAssistantMessage(allMessages, index);
    const prompt = messageText(message, '[uploaded image]').slice(0, 300);
    references.push({
      reference_id: referenceId,
      target: 'uploaded',
      source: 'user_message',
      message_index: index + 1,
      prompt,
      user_prompt: prompt,
      assistant_response: messageText(assistant).slice(0, 800),
      updated_at: imageContext?.updatedAt || imageContext?.updated_at || message.updatedAt || null,
      count: attachments.length,
      candidates: attachments.map((item, attachmentIndex) => {
        const description = String(
          item.semantic_description || item.semanticDescription || item.description || item.subject || '',
        ).replace(/\s+/g, ' ').trim();
        const label = uploadedImageAttachmentLabel(item, attachmentIndex + 1);
        const labels = Array.isArray(item.labels) ? item.labels.slice(0, 12) : [];
        return {
          index: attachmentIndex + 1,
          image_id: makeImageItemId(referenceId, attachmentIndex + 1),
          filename: item.name || item.filename || '',
          label,
          prompt,
          description: description.slice(0, 240),
          semantic_text: compactCandidateSemanticText([
            item.semantic_text || item.semanticText,
            description,
            label,
            item.name || item.filename || '',
            ...labels,
            prompt,
            assistant ? messageText(assistant) : '',
          ]),
          labels,
        };
      }),
    });
  }
  return references;
}

function trimRouteContextToTokenWindow(context = {}, contextWindowTokens) {
  return applyRouteContextPolicy(context, {
    contextWindowTokens,
    enforceMaxChars: false,
  });
}

function trimRouteContextToSize(context = {}, maxChars = DEFAULT_ROUTE_CONTEXT_MAX_CHARS) {
  return applyRouteContextPolicy(context, {
    maxChars,
    enforceTokenWindow: false,
  });
}

function compactCandidateSemanticText(values = [], max = 720) {
  const seen = new Set();
  const parts = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
  }
  return parts.join(' | ').slice(0, max);
}



function compactLatestUploadedImage(value = null, uploadedLatest = null) {
  if (!value && !uploadedLatest) return null;
  const source = uploadedLatest || value || {};
  return {
    reference_id: value?.reference_id || source.reference_id || '',
    target: value?.target || source.target || 'uploaded',
    count: Number(value?.count) || Number(source.count) || 0,
    updated_at: value?.updated_at || value?.updatedAt || source.updated_at || null,
  };
}

function compactLastGeneratedImage(value = null, messages = []) {
  if (!value) return null;
  const allMessages = Array.isArray(messages) ? messages : [];
  const messageIndex = allMessages.findIndex(message => isImageResultMessage(message) && String(parsedImageContext(message)?.referenceId || parsedImageContext(message)?.reference_id || '') === String(value.reference_id || ''));
  const ageTurns = messageIndex >= 0
    ? allMessages.filter((item, itemIndex) => item?.role === 'user' && itemIndex > messageIndex).length
    : 0;
  return {
    reference_id: value.reference_id || makeImageReferenceId('latest'),
    target: 'previous',
    count: Number(value.count) || (Array.isArray(value.candidates) ? value.candidates.length : 0) || (Array.isArray(value.images) ? value.images.length : 0) || (value.src ? 1 : 0),
    prompt: String(value.prompt || value.user_prompt || '').slice(0, 300),
    updated_at: value.updated_at || value.updatedAt || null,
    priority_coefficient: ageTurns === 0 ? 1 : Math.max(0.4, Number((1 - ageTurns * 0.28).toFixed(2))),
    priority_age_turns: ageTurns,
  };
}

function buildImageCandidates(references = []) {
  const result = [];
  const seen = new Set();
  for (const reference of references || []) {
    if (!reference || typeof reference !== 'object') continue;
    const referenceId = reference.reference_id || '';
    const target = reference.target || '';
    const source = reference.source || '';
    const candidates = Array.isArray(reference.candidates) ? reference.candidates : [];
    for (const candidate of candidates) {
      const imageId = candidate?.image_id || '';
      const sourceIndex = Number(candidate?.index) || 0;
      const index = result.length + 1;
      const key = imageId || `${referenceId}:${sourceIndex}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const isUploaded = target === 'uploaded' || ['current', 'uploaded', 'user_message'].includes(source);
      const description = candidate?.description
        || candidate?.semantic_description
        || candidate?.semanticDescription
        || candidate?.subject
        || (!isUploaded ? candidate?.label : '');
      result.push({
        index,
        source_index: sourceIndex || index,
        message_index: Number(reference.message_index) || 0,
        image_id: imageId,
        reference_id: referenceId,
        target,
        source,
        filename: candidate?.filename || '',
        label: String(candidate?.label || '').slice(0, 240),
        labels: Array.isArray(candidate?.labels) ? candidate.labels.slice(0, 12) : [],
        description: String(description || '').slice(0, 240),
        prompt: String(candidate?.prompt || reference.prompt || reference.user_prompt || '').slice(0, 240),
        semantic_text: compactCandidateSemanticText([
          candidate?.semantic_text,
          candidate?.description || candidate?.semantic_description || candidate?.semanticDescription,
          candidate?.subject || candidate?.label,
          ...(Array.isArray(candidate?.labels) ? candidate.labels : []),
          candidate?.prompt,
          candidate?.filename,
          reference.prompt || reference.user_prompt,
          reference.assistant_response,
        ]),
        operation: String(candidate?.operation || reference?.operation || '').trim(),
        parent_reference_id: String(candidate?.parent_reference_id || candidate?.parentReferenceId || reference?.parent_reference_id || reference?.parentReferenceId || '').trim(),
        parent_image_ids: Array.isArray(candidate?.parent_image_ids || candidate?.parentImageIds || reference?.parent_image_ids || reference?.parentImageIds)
          ? (candidate.parent_image_ids || candidate.parentImageIds || reference.parent_image_ids || reference.parentImageIds).map(value => String(value || '').trim()).filter(Boolean).slice(0, 12)
          : [],
      });
    }
  }
  return result;
}

function latestAssistantImageResult(messages = []) {
  const allMessages = Array.isArray(messages) ? messages : [];
  for (let index = allMessages.length - 1; index >= 0; index -= 1) {
    const message = allMessages[index];
    if (message?.role !== 'assistant') continue;
    const text = messageText(message).trim();
    if (/^\[图片(生成|编辑|修改)完成\]/.test(text)) return { index: index + 1, content: text.replace(/^\[图片(生成|编辑|修改)完成\]\s*/, '').slice(0, 800) };
  }
  return null;
}

function parsedImageContext(message = {}) {
  const raw = message?.imageContext;
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return null;
}

function isImageResultMessage(message = {}) {
  return /^\[图片(生成|编辑|修改)完成\]/.test(messageText(message));
}

function executionFromImageMessage(message = {}, index = 0) {
  const imageContext = parsedImageContext(message);
  const fallbackMode = String(imageContext?.mode || '');
  const operation = String(
    imageContext?.operation
    || (fallbackMode === 'edit_image' ? 'edit_image' : fallbackMode === 'image' ? 'text_to_image' : ''),
  );
  const rawInput = String(
    imageContext?.executionInput
    || imageContext?.execution_input
    || imageContext?.prompt
    || imageContext?.routePrompt
    || messageText(message).replace(/^\[图片(生成|编辑|修改)完成\]\s*/, ''),
  ).trim();
  const declaredTaskLineage = imageContext?.taskLineage ?? imageContext?.task_lineage;
  let taskState = null;
  if (declaredTaskLineage !== null && declaredTaskLineage !== undefined) {
    if (typeof taskContinuity.taskContinuityFromImageTaskLineage !== 'function') {
      throw new TypeError('Image task lineage protocol is unavailable');
    }
    taskState = taskContinuity.taskContinuityFromImageTaskLineage(declaredTaskLineage);
    // A multi-result batch has several independent task states and therefore no
    // implicit single previous_execution. Its images remain resource candidates.
    if (!taskState) return null;
  } else {
    taskState = typeof taskContinuity.taskContinuityFromExecution === 'function'
      ? taskContinuity.taskContinuityFromExecution({
          task_state: imageContext?.taskState || imageContext?.task_state,
          resolved_goal: imageContext?.resolvedGoal || imageContext?.resolved_goal,
          input: rawInput,
        })
      : null;
  }
  const resolvedGoal = taskState && typeof taskContinuity.renderTaskContinuity === 'function'
    ? taskContinuity.renderTaskContinuity(taskState)
    : String(imageContext?.resolvedGoal || imageContext?.resolved_goal || rawInput).trim();
  const referenceId = makeImageReferenceId(imageContext?.referenceId || imageContext?.reference_id || '');
  if (!operation || !referenceId || !rawInput || !resolvedGoal) return null;
  return {
    schema_version: 'execution_continuity.v1',
    operation,
    family: operation === 'edit_image' ? 'edit' : 'generate',
    // Preserve the original execution text verbatim. It is durable evidence
    // for a later continuation; truncating it here caused long image requests
    // to lose explicit constraints after their first completed result.
    input: rawInput,
    resolved_goal: resolvedGoal.slice(0, MAX_RESOLVED_IMAGE_GOAL_LENGTH),
    ...(taskState ? { task_state: taskState } : {}),
    result_kind: 'image',
    result_reference_id: referenceId,
    source_message_index: index + 1,
    source_user_message_index: index,
    context_role: 'execution_state',
    instruction_authority: 'application_state',
  };
}

function detectTextFormat(text = '') {
  const value = String(text || '');
  if (/^(#{1,6}\s+|```|\|.*\|.*\|)/m.test(value) || /\*\*|__|^[-*] \[?\s?\]?/m.test(value)) return 'markdown';
  return '';
}

function previousExecutionFor(messages = []) {
  const allMessages = Array.isArray(messages) ? messages : [];
  let latestImage = null;
  for (let index = allMessages.length - 1; index >= 0; index -= 1) {
    const message = allMessages[index];
    if (message?.role !== 'assistant') continue;
    if (isImageResultMessage(message)) {
      latestImage = executionFromImageMessage(message, index);
      break;
    }
    if (String(message.clarificationId || message.clarification_id || '').trim()) continue;
    // A completed ordinary assistant response shadows older visual execution state.
    if (messageText(message)) { latestImage = null; break; }
  }
  if (!latestImage) return null;
  const ageTurns = allMessages
    .filter((item, itemIndex) => item?.role === 'user' && itemIndex + 1 > latestImage.source_message_index)
    .length;
  return {
    ...latestImage,
    priority_coefficient: ageTurns === 0 ? 1 : Math.max(0.4, Number((1 - ageTurns * 0.28).toFixed(2))),
    priority_age_turns: ageTurns,
  };
}

const READ_ONLY_RESOURCE_OPERATIONS = new Set([
  'image_qa', 'image_compare', 'ocr', 'file_qa', 'multimodal_qa',
]);

function routeExecutionAnchorFromMessage(message = {}) {
  const value = parseJsonObject(message?.routeExecutionAnchor || message?.route_execution_anchor);
  if (!value || value.schema_version !== 'route_execution_anchor.v1') return null;
  const operation = String(value.operation || '').trim();
  if (!READ_ONLY_RESOURCE_OPERATIONS.has(operation)) return null;

  const rawImages = Array.isArray(value.image_bindings) ? value.image_bindings : [];
  const rawFiles = Array.isArray(value.file_bindings) ? value.file_bindings : [];
  const images = rawImages.map(binding => ({
    source: String(binding?.source || '').trim(),
    resource_id: String(binding?.resource_id || binding?.resourceId || '').trim(),
    image_id: String(binding?.image_id || binding?.imageId || binding?.id || '').trim(),
    reference_id: String(binding?.reference_id || binding?.referenceId || '').trim(),
    index: Number(binding?.index) || 0,
  })).filter(binding => binding.source && (binding.resource_id || binding.image_id || binding.reference_id || binding.index));
  const files = rawFiles.map(binding => ({
    source: String(binding?.source || '').trim(),
    resource_id: String(binding?.resource_id || binding?.resourceId || '').trim(),
    file_id: String(binding?.file_id || binding?.fileId || binding?.id || '').trim(),
    index: Number(binding?.index) || 0,
  })).filter(binding => binding.source && (binding.resource_id || binding.file_id || binding.index));
  if (images.length !== rawImages.length || files.length !== rawFiles.length || (!images.length && !files.length)) return null;
  return { operation, images, files, inferred: false };
}

function inferredResourceAnchorFromMessage(message = {}) {
  const imageAttachments = uploadedAttachmentsFromMessage(message);
  const fileAttachments = uploadedFileAttachmentsFromMessage(message);
  if (!imageAttachments.length && !fileAttachments.length) return null;
  const operation = imageAttachments.length && fileAttachments.length
    ? 'multimodal_qa'
    : imageAttachments.length ? 'image_qa' : 'file_qa';
  return {
    operation,
    inferred: true,
    images: imageAttachments.map((item, index) => ({
      source: 'current',
      resource_id: String(item?.resource_id || item?.resourceId || '').trim(),
      image_id: String(item?.image_id || item?.imageId || item?.id || item?.attachmentId || item?.attachment_id || '').trim(),
      reference_id: String(item?.reference_id || item?.referenceId || '').trim(),
      index: index + 1,
    })),
    files: fileAttachments.map((item, index) => ({
      source: 'current',
      resource_id: String(item?.resource_id || item?.resourceId || '').trim(),
      file_id: String(item?.file_id || item?.fileId || item?.id || item?.attachmentId || item?.attachment_id || '').trim(),
      index: index + 1,
    })),
  };
}

// The resource focus of a follow-up is the exact input set that produced the
// immediately preceding answer. New messages persist this as an execution
// anchor; adjacent persisted attachments provide a migration path for older
// sessions created before resource anchors included files.
function previousResourceExecutionFor(messages = []) {
  const allMessages = Array.isArray(messages) ? messages : [];
  for (let assistantIndex = allMessages.length - 1; assistantIndex >= 0; assistantIndex -= 1) {
    const assistant = allMessages[assistantIndex];
    if (assistant?.role !== 'assistant') continue;
    if (String(assistant.clarificationId || assistant.clarification_id || '').trim()) return null;
    const userIndex = assistantIndex - 1;
    const user = allMessages[userIndex];
    if (user?.role !== 'user') return null;

    const anchor = routeExecutionAnchorFromMessage(user) || inferredResourceAnchorFromMessage(user);
    if (!anchor) return null;
    const uploadedFiles = uploadedFileAttachmentsFromMessage(user);
    const images = anchor.images.map(binding => ({
      resource_id: binding.resource_id,
      image_id: binding.image_id,
      reference_id: binding.reference_id || (binding.source === 'current'
        ? uploadedReferenceIdForMessageIndex(userIndex)
        : ''),
      index: binding.index,
    })).filter(binding => binding.resource_id || binding.image_id || binding.reference_id);
    const files = anchor.files.map(binding => {
      const uploaded = binding.source === 'current' && binding.index > 0
        ? uploadedFiles[binding.index - 1] || null
        : null;
      return {
        resource_id: binding.resource_id || String(uploaded?.resource_id || uploaded?.resourceId || '').trim(),
        file_id: binding.file_id || String(uploaded?.file_id || uploaded?.fileId || uploaded?.id || uploaded?.attachmentId || uploaded?.attachment_id || '').trim(),
        index: binding.index,
      };
    }).filter(binding => binding.resource_id || binding.file_id);
    if (images.length !== anchor.images.length || files.length !== anchor.files.length || (!images.length && !files.length)) return null;

    return {
      schema_version: 'previous_resource_execution.v1',
      operation: anchor.operation,
      source_message_index: userIndex + 1,
      response_message_index: assistantIndex + 1,
      image_count: images.length,
      file_count: files.length,
      images,
      files,
      inferred_from_adjacent_attachments: anchor.inferred === true,
      context_role: 'execution_state',
      instruction_authority: 'application_state',
    };
  }
  return null;
}

// Visual continuity is a projection of the unified resource execution anchor.
// Image QA/OCR emits text, so output modality alone cannot identify its subject.
function previousVisualExecutionFor(messages = [], resourceExecution = null) {
  const execution = resourceExecution || previousResourceExecutionFor(messages);
  if (!execution || !Array.isArray(execution.images) || !execution.images.length) return null;
  return {
    schema_version: 'previous_visual_execution.v1',
    operation: execution.operation,
    source_message_index: execution.source_message_index,
    response_message_index: execution.response_message_index,
    image_count: execution.images.length,
    images: execution.images.map(binding => ({
      reference_id: binding.reference_id,
      index: binding.index,
    })),
    context_role: 'execution_state',
    instruction_authority: 'application_state',
  };
}

function conversationFocusFor(messages = [], resourceExecution = null) {
  const allMessages = Array.isArray(messages) ? messages : [];
  let latestTextIndex = 0;
  let latestImageIndex = 0;
  for (let index = allMessages.length - 1; index >= 0; index -= 1) {
    const message = allMessages[index];
    if (message?.role !== 'assistant') continue;
    if (String(message.clarificationId || message.clarification_id || '').trim()) continue;
    if (isImageResultMessage(message)) {
      if (!latestImageIndex) latestImageIndex = index + 1;
      continue;
    }
    if (messageText(message) && !latestTextIndex) latestTextIndex = index + 1;
  }

  if (resourceExecution) {
    const kind = resourceExecution.file_count > 0 && resourceExecution.image_count > 0
      ? 'multimodal'
      : resourceExecution.file_count > 0 ? 'file' : resourceExecution.image_count > 0 ? 'image' : '';
    if (kind) {
      return {
        schema_version: 'conversation_focus.v1',
        kind,
        text_format: kind === 'file' || kind === 'multimodal'
          ? detectTextFormat(messageText(allMessages[resourceExecution.response_message_index - 1]))
          : '',
        source_message_index: resourceExecution.response_message_index,
        text_message_index: latestTextIndex,
        image_message_index: latestImageIndex,
        priority_coefficient: 1,
        priority_age_turns: 0,
        context_role: 'conversation_focus',
        instruction_authority: 'application_state',
      };
    }
  }

  let focus = null;
  for (let index = allMessages.length - 1; index >= 0; index -= 1) {
    const message = allMessages[index];
    if (message?.role !== 'assistant') continue;
    if (String(message.clarificationId || message.clarification_id || '').trim()) continue;
    if (isImageResultMessage(message)) {
      focus = {
        schema_version: 'conversation_focus.v1',
        kind: 'image',
        text_format: '',
        source_message_index: index + 1,
        text_message_index: latestTextIndex,
        image_message_index: latestImageIndex || index + 1,
        priority_coefficient: 1,
        priority_age_turns: 0,
        context_role: 'conversation_focus',
        instruction_authority: 'application_state',
      };
      break;
    }
    if (messageText(message)) {
      focus = {
        schema_version: 'conversation_focus.v1',
        kind: 'text',
        text_format: detectTextFormat(messageText(message)),
        source_message_index: index + 1,
        text_message_index: latestTextIndex || index + 1,
        image_message_index: latestImageIndex,
        priority_coefficient: 1,
        priority_age_turns: 0,
        context_role: 'conversation_focus',
        instruction_authority: 'application_state',
      };
      break;
    }
  }
  return focus;
}

function buildRouteContext({ messages = [], lastGeneratedImage = null, latestUploadedImage = null, latestImageReference = null, recentImageReferences = [], maxChars = DEFAULT_ROUTE_CONTEXT_MAX_CHARS, contextWindowTokens } = {}) {
  const allMessages = Array.isArray(messages) ? messages : [];
  const uploadedReferences = collectRecentUploadedImageReferences({ messages: allMessages, limit: Number.MAX_SAFE_INTEGER });
  const uploadedLatest = uploadedReferences[0] || null;
  // Rebuild generated-image lineage from canonical messages at the core boundary.
  // Callers may omit the derived recent-reference cache after a refresh; that
  // omission must not turn durable IndexedDB-backed results into a "no image".
  const cachedReferences = Array.isArray(recentImageReferences) ? recentImageReferences : [];
  const derivedImageReferences = cachedReferences.length
    ? []
    : collectRecentImageReferences({
      messages: allMessages,
      lastGeneratedImage,
      limit: 6,
    });
  const mergedReferences = [...cachedReferences];
  for (const reference of [...derivedImageReferences, ...uploadedReferences]) {
    if (!reference?.reference_id) continue;
    if (!mergedReferences.some(item => item?.reference_id === reference.reference_id)) mergedReferences.push(reference);
  }
  const resourceExecution = previousResourceExecutionFor(allMessages);
  const focus = conversationFocusFor(allMessages, resourceExecution);
  const execution = previousExecutionFor(allMessages);
  const visualExecution = previousVisualExecutionFor(allMessages, resourceExecution);
  const context = {
    recent_messages: allMessages.map((message, index) => compactRouteMessage(message, index + 1)),
    latest_assistant_image_result: latestAssistantImageResult(allMessages),
    image_candidates: buildImageCandidates(mergedReferences),
    file_candidates: buildFileCandidates(allMessages),
    last_generated_image: compactLastGeneratedImage(lastGeneratedImage, allMessages),
    latest_uploaded_image: compactLatestUploadedImage(latestUploadedImage, uploadedLatest),
    latest_image_reference: latestImageReference && latestImageReference.target !== 'none' ? latestImageReference : null,
    recent_image_references: [],
    recent_uploaded_image_references: [],
    previous_execution: execution,
    previous_resource_execution: resourceExecution,
    previous_visual_execution: visualExecution,
    conversation_focus: focus,
  };
  return applyRouteContextPolicy(context, { maxChars, contextWindowTokens });
}

function normalizeLastGeneratedImage(value) {
  if (!value) return null;
  const normalizeItem = item => {
    const source = item && typeof item === 'object' ? item : {};
    const description = String(source.description || source.semantic_description || source.semanticDescription || source.subject || source.label || source.prompt || '').trim();
    return {
      ...source,
      // Route context is intentionally compacted before it reaches this core
      // module. The compact form calls these entries `candidates` and uses
      // image_id; normalize both representations so a refresh/cache boundary
      // cannot turn a durable generated image into an empty image pool.
      imageId: source.imageId || source.image_id || '',
      image_id: source.image_id || source.imageId || '',
      description,
      semantic_text: compactCandidateSemanticText([source.semantic_text, description, source.prompt, source.filename, source.raw, ...(Array.isArray(source.labels) ? source.labels : [])]),
      labels: Array.isArray(source.labels) ? source.labels.slice(0, 12) : [],
    };
  };
  const sourceImages = Array.isArray(value.images)
    ? value.images
    : Array.isArray(value.candidates)
      ? value.candidates
      : value.src
        ? [{
          src: value.src,
          filename: value.filename || 'generated-image.png',
          prompt: value.prompt || '',
          updatedAt: value.updatedAt || null,
          width: value.width || 0,
          height: value.height || 0,
        }]
        : [];
  return { ...value, images: sourceImages.map(normalizeItem) };
}

function extractPersistedImageRefs(html = '') {
  const refs = [];
  const text = String(html || '');
  const pattern = /data-persisted-src="([^"]+)"[^>]*data-filename="([^"]*)"|data-filename="([^"]*)"[^>]*data-persisted-src="([^"]+)"/g;
  let match;
  while ((match = pattern.exec(text))) {
    const src = match[1] || match[4];
    const filename = match[2] || match[3] || 'generated-image.png';
    if (src) refs.push({ src, filename });
  }
  return refs;
}

function latestImageReferenceMeta({ lastGeneratedImage = null, latestUploadedImage = null } = {}) {
  const generated = normalizeLastGeneratedImage(lastGeneratedImage);
  const generatedCount = Array.isArray(generated && generated.images) ? generated.images.length : generated && generated.src ? 1 : 0;
  const uploadCount = latestUploadedImage && latestUploadedImage.attachments ? latestUploadedImage.attachments.length || 0 : 0;
  if (generatedCount && uploadCount) {
    const generatedUpdatedAt = Number(generated.updatedAt || 0);
    const uploadedUpdatedAt = Number(latestUploadedImage.updatedAt || 0);
    return generatedUpdatedAt >= uploadedUpdatedAt
      ? { target: 'previous', usePreviousImage: true, count: generatedCount, selection: 'all', reason: 'latest-generated-image', reference_id: makeImageReferenceId('latest') }
      : { target: 'uploaded', usePreviousImage: false, count: uploadCount, selection: 'all', reason: 'latest-uploaded-image' };
  }
  if (generatedCount) return { target: 'previous', usePreviousImage: true, count: generatedCount, selection: 'all', reason: 'last-generated-image', reference_id: makeImageReferenceId('latest') };
  if (uploadCount) return { target: 'uploaded', usePreviousImage: false, count: uploadCount, selection: 'all', reason: 'latest-uploaded-image' };
  return { target: 'none', usePreviousImage: false, count: 0, selection: 'none', reason: 'no-image-reference' };
}

function completedImagePrompt(message = {}, imageContext = null) {
  return String(
    imageContext?.prompt
    || imageContext?.routePrompt
    || message.content
    || message.rawText
    || ''
  ).replace(/^\[\u56fe\u7247(?:\u751f\u6210|\u7f16\u8f91|\u4fee\u6539)\u5b8c\u6210\]\s*/, '').trim();
}

function canonicalImageReferenceId(message = {}, messageIndex = 0) {
  const stableId = message.displayItemId
    || message.imageJobId
    || message.id
    || `message_${Number(message.responseIndex) || messageIndex + 1}`;
  return makeImageReferenceId(stableId);
}

function imageReferenceFromMessage(message = {}, messageIndex = 0, messages = []) {
  if (message?.role !== 'assistant') return null;
  // Clarification thumbnails preview existing candidates; they are not a new
  // assistant image result and must never be re-added to the route catalog.
  if (/data-clarification-image-choices=["']1["']/i.test(String(message.html || ''))) return null;
  const imageContext = parseJsonObject(message.imageContext);
  const contextAttachments = Array.isArray(imageContext?.attachments)
    ? imageContext.attachments.filter(item => item?.src)
    : [];
  const htmlAttachments = extractPersistedImageRefs(message.html || '');
  const attachments = htmlAttachments.length
    ? htmlAttachments.map((item, index) => ({ ...(contextAttachments[index] || {}), ...item }))
    : contextAttachments;
  if (!attachments.length) return null;

  // Result persistence assigns the durable reference ID before the display
  // item receives its own UI ID. Continuity must use that result ID; otherwise
  // the execution record and the recoverable candidate describe the same image
  // with different identities and follow-ups fall back to concatenating text.
  const referenceId = makeImageReferenceId(
    imageContext?.referenceId || imageContext?.reference_id || canonicalImageReferenceId(message, messageIndex),
  );
  const prompt = completedImagePrompt(message, imageContext);
  const previousUser = Array.isArray(messages) && messageIndex > 0 && messages[messageIndex - 1]?.role === 'user'
    ? messageText(messages[messageIndex - 1])
    : '';
  const routePrompt = String(imageContext?.routePrompt || previousUser || '').trim();
  const parentReferenceId = makeImageReferenceId(
    imageContext?.selectedReferenceId || imageContext?.selected_reference_id || '',
  );
  const parentImageIds = Array.isArray(imageContext?.selectedImageIds || imageContext?.selected_image_ids)
    ? (imageContext.selectedImageIds || imageContext.selected_image_ids).map(value => String(value || '').trim()).filter(Boolean).slice(0, 12)
    : [];
  const operation = String(imageContext?.mode || imageContext?.operation || '').trim();
  const candidates = attachments.map((item, index) => {
    const description = String(item.description || item.semantic_description || item.semanticDescription || item.subject || item.label || item.prompt || routePrompt || prompt).trim();
    const labels = Array.isArray(item.labels) && item.labels.length
      ? item.labels.slice(0, 12)
      : [];
    return {
      index: index + 1,
      image_id: makeImageItemId(referenceId, index + 1),
      filename: item.name || item.filename || '',
      prompt: String(item.prompt || prompt).slice(0, 240),
      description: description.slice(0, 240),
      semantic_text: compactCandidateSemanticText([item.semantic_text, description, item.prompt, routePrompt, prompt, item.name || item.filename || '', ...labels]),
      labels,
      ...(operation ? { operation } : {}),
      ...(parentReferenceId ? { parent_reference_id: parentReferenceId } : {}),
      ...(parentImageIds.length ? { parent_image_ids: parentImageIds } : {}),
    };
  });

  return {
    reference_id: referenceId,
    target: 'previous',
    source: 'history',
    message_index: messageIndex + 1,
    prompt: prompt.slice(0, 300),
    user_prompt: routePrompt.slice(0, 300),
    updated_at: imageContext?.updatedAt || message.updatedAt || null,
    count: candidates.length,
    operation,
    ...(parentReferenceId ? { parent_reference_id: parentReferenceId } : {}),
    ...(parentImageIds.length ? { parent_image_ids: parentImageIds } : {}),
    candidates,
    images: attachments.map((item, index) => ({
      src: item.src,
      filename: item.name || item.filename || `previous-image-${index + 1}.png`,
      prompt: item.prompt || prompt,
      description: candidates[index].description,
      semantic_text: candidates[index].semantic_text,
      labels: candidates[index].labels,
      imageId: candidates[index].image_id,
      referenceId,
    })),
  };
}

function collectRecentImageReferences({ messages = [], lastGeneratedImage = null, limit = 6 } = {}) {
  const allMessages = Array.isArray(messages) ? messages : [];
  const references = [];
  for (let index = allMessages.length - 1; index >= 0 && references.length < limit; index -= 1) {
    const reference = imageReferenceFromMessage(allMessages[index], index, allMessages);
    if (reference) references.push(reference);
  }
  if (references.length) return references;

  const generated = normalizeLastGeneratedImage(lastGeneratedImage);
  if (!generated?.images?.length) return references;
  const referenceId = makeImageReferenceId('latest');
  references.push({
    reference_id: referenceId,
    target: 'previous',
    source: 'history',
    prompt: String(generated.prompt || '').slice(0, 300),
    updated_at: generated.updatedAt || null,
    count: generated.images.length,
    candidates: generated.images.map((item, index) => ({
      index: index + 1,
      image_id: item.imageId || item.image_id || makeImageItemId(referenceId, index + 1),
      filename: item.filename || '',
      prompt: String(item.prompt || generated.prompt || '').slice(0, 240),
      description: String(item.description || item.semantic_description || item.semanticDescription || item.subject || item.label || item.prompt || generated.prompt || '').slice(0, 240),
      semantic_text: compactCandidateSemanticText([item.semantic_text, item.description || item.semantic_description || item.semanticDescription, item.subject || item.label, item.prompt, generated.prompt, item.filename, ...(Array.isArray(item.labels) ? item.labels : [])]),
      labels: item.labels || [],
    })),
  });
  return references;
}

function buildImageMemoryCards({ messages = [], lastGeneratedImage = null, recentImageReferences = [] } = {}) {
  const allReferences = collectRecentImageReferences({
    messages,
    lastGeneratedImage,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const merged = Array.isArray(recentImageReferences) ? [...recentImageReferences] : [];
  for (const reference of allReferences) {
    if (!merged.some(item => item?.reference_id === reference?.reference_id)) merged.push(reference);
  }

  // Image memory is ordered newest-first for retrieval, while users can name
  // either an absolute generation ("the eighth generated image") or a reverse
  // ordinal ("the second-to-last generation"). Preserve both coordinates on
  // every flattened image card so the route catalog can publish an exact match
  // without treating user wording as a semantic keyword search.
  const generationByReference = new Map();
  let chronologicalImageOffset = 0;
  for (let referenceIndex = merged.length - 1; referenceIndex >= 0; referenceIndex -= 1) {
    const reference = merged[referenceIndex] || {};
    const referenceId = String(reference.reference_id || '').trim();
    const imageCount = Array.isArray(reference.candidates) ? reference.candidates.length : 0;
    generationByReference.set(referenceId, {
      generation_index: merged.length - referenceIndex,
      generation_recency_index: referenceIndex + 1,
      generation_image_count: imageCount,
      chronological_image_offset: chronologicalImageOffset,
    });
    chronologicalImageOffset += imageCount;
  }

  return buildImageCandidates(merged).map((candidate, index) => {
    const generation = generationByReference.get(String(candidate.reference_id || '').trim()) || {};
    const generationImageIndex = Number(candidate.source_index) || 1;
    return {
      ...candidate,
      type: 'image',
      memory_index: index + 1,
      chronological_index: Number(generation.chronological_image_offset) + generationImageIndex,
      generation_index: Number(generation.generation_index) || 0,
      generation_recency_index: Number(generation.generation_recency_index) || 0,
      generation_image_index: generationImageIndex,
      generation_image_count: Number(generation.generation_image_count) || 0,
    };
  });
}

function findImageReferenceById({ messages = [], referenceId = '' } = {}) {
  const expectedId = makeImageReferenceId(referenceId);
  if (!expectedId || parseImageReferenceId(expectedId) === 'latest') return null;
  const allMessages = Array.isArray(messages) ? messages : [];
  for (let index = allMessages.length - 1; index >= 0; index -= 1) {
    const reference = imageReferenceFromMessage(allMessages[index], index, allMessages);
    if (reference?.reference_id !== expectedId) continue;
    return {
      images: reference.images,
      prompt: reference.prompt,
      updatedAt: reference.updated_at,
      referenceId: reference.reference_id,
    };
  }
  return null;
}

const IMAGE_PLAN_INTENTS = new Set(['text_to_image', 'image_edit', 'image_edit_single', 'image_edit_batch', 'image_compose', 'image_reference_gen', 'unknown']);
const IMAGE_PLAN_TASK_TYPES = new Set(['generate', 'edit']);
const IMAGE_PLAN_ROLES = new Set(['target', 'reference', 'subject', 'background', 'style_reference']);

function normalizePlanInputImages(inputImages = []) {
  if (!Array.isArray(inputImages)) return [];
  return inputImages.map(item => {
    const imageId = String(item && (item.image_id || item.imageId) || '').trim();
    const referenceId = makeImageReferenceId(item && (item.reference_id || item.referenceId) || '');
    const role = IMAGE_PLAN_ROLES.has(item && item.role) ? item.role : 'reference';
    const next = { image_id: imageId, role };
    if (referenceId) next.reference_id = referenceId;
    return next;
  }).filter(item => item.image_id || item.reference_id);
}

function normalizePlanValue(value, fallback = 'auto') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeImagePlanTask(task = {}) {
  const taskType = IMAGE_PLAN_TASK_TYPES.has(task.task_type || task.taskType) ? (task.task_type || task.taskType) : 'generate';
  return {
    task_type: taskType,
    input_images: normalizePlanInputImages(task.input_images || task.inputImages),
    prompt: String(task.prompt || '').trim(),
    label: String(task.label || '').trim(),
    size: normalizePlanValue(task.size),
    quality: normalizePlanValue(task.quality),
    background: normalizePlanValue(task.background),
    format: normalizePlanValue(task.format || task.output_format || task.outputFormat),
  };
}

function normalizeImagePlan(route = {}) {
  const rawIntent = String(route && route.intent || '').trim();
  const intent = IMAGE_PLAN_INTENTS.has(rawIntent) ? rawIntent : 'unknown';
  const needClarification = !!(route && (route.need_clarification || route.needClarification));
  const tasks = needClarification ? [] : (Array.isArray(route && route.tasks) ? route.tasks.map(normalizeImagePlanTask).filter(task => task.input_images.length || task.task_type === 'generate') : []);
  return {
    needClarification,
    clarificationQuestion: String(route && (route.clarification_question || route.clarificationQuestion) || '').trim(),
    intent,
    tasks,
  };
}

function modeFromImageIntent(intent, fallbackMode = 'chat') {
  // Only text-only generation uses /images/generations. Every operation that
  // consumes image inputs uses the multipart /images/edits transport.
  if (intent === 'text_to_image') return 'image';
  if (intent === 'image_reference_gen') return 'image';
  if (intent === 'image_edit' || intent === 'image_edit_single' || intent === 'image_edit_batch' || intent === 'image_compose') return 'edit_image';
  return fallbackMode;
}

function canonicalRouteAction(route = {}) {
  const explicitMode = ['chat', 'image', 'edit_image'].includes(route && route.mode) ? route.mode : '';
  const operationType = String(route?.dispatchContract?.operation || route?.operationType || route?.operation?.type || '').trim();
  if (['plain_chat', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr', 'clarify', 'refuse'].includes(operationType)) return { mode: 'chat', intent: 'unknown', type: operationType, source: 'operation' };
  if (operationType === 'text_to_image') return { mode: 'image', intent: 'text_to_image', type: operationType, source: 'operation' };
  if (operationType === 'image_edit' || operationType === 'edit_image') return { mode: 'edit_image', intent: 'image_edit', type: operationType, source: 'operation' };
  if (operationType === 'image_reference_gen') return { mode: 'image', intent: 'image_reference_gen', type: operationType, source: 'operation' };
  if (explicitMode === 'chat') return { mode: 'chat', intent: 'unknown', type: 'plain_chat', source: 'mode' };
  if (explicitMode === 'image') return { mode: 'image', intent: 'text_to_image', type: 'text_to_image', source: 'mode' };
  if (explicitMode === 'edit_image') return { mode: 'edit_image', intent: 'image_edit', type: 'image_edit', source: 'mode' };
  return null;
}

function planImageIds(plan = {}) {
  const ids = [];
  for (const task of plan.tasks || []) for (const image of task.input_images || []) if (image.image_id) ids.push(image.image_id);
  return normalizeSelectedImageIds(ids);
}

function referenceIdFromImageId(imageId = '') {
  const match = String(imageId || '').match(/^img_(imgref_.+)_(\d+)$/);
  return match ? makeImageReferenceId(match[1]) : '';
}

function planReferenceId(plan = {}) {
  for (const task of plan.tasks || []) for (const image of task.input_images || []) {
    if (image.reference_id) return makeImageReferenceId(image.reference_id);
    const fromImage = referenceIdFromImageId(image.image_id);
    if (fromImage) return fromImage;
  }
  return '';
}

function planSelectedIndexes(ids = [], referenceId = '') {
  const reference = makeImageReferenceId(referenceId || '');
  const indexes = [];
  for (const id of ids || []) {
    const match = String(id || '').match(/^img_(imgref_.+)_(\d+)$/);
    if (!match || (reference && makeImageReferenceId(match[1]) !== reference)) continue;
    const index = Number(match[2]);
    if (Number.isInteger(index) && index >= 1) indexes.push(index);
  }
  return indexes.filter((item, index, list) => list.indexOf(item) === index);
}

function targetFromPlan(plan = {}, mode = 'chat') {
  const referenceId = planReferenceId(plan);
  if (mode === 'image') return 'new';
  if (mode !== 'edit_image') return 'none';
  if (referenceId && /^imgref_uploaded_/i.test(referenceId)) return 'uploaded';
  if (referenceId || planImageIds(plan).length) return 'previous';
  return 'none';
}

function normalizeRouteOperation(route = {}, mode = 'chat') {
  const raw = route && typeof route.operation === 'object' ? route.operation : {};
  const validTypes = new Set(['plain_chat', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr', 'text_to_image', 'image_reference_gen', 'image_edit', 'clarify', 'refuse']);
  const validScopes = new Set(['current', 'quoted', 'history', 'none', 'context']);
  const fallbackType = mode === 'image' ? 'text_to_image' : mode === 'edit_image' ? 'image_edit' : 'plain_chat';
  return {
    type: validTypes.has(raw.type) ? raw.type : fallbackType,
    scope: validScopes.has(raw.scope) ? raw.scope : 'current',
    prompt: String(raw.prompt || route.contextualImagePrompt || '').trim(),
    edit_instruction: String(raw.editInstruction || route.editInstruction || '').trim(),
  };
}

function normalizeRouteImageRefs(route = {}) {
  const list = Array.isArray(route.imageRefs) ? route.imageRefs : [];
  return list.map((item, idx) => {
    const imageId = String(item?.image_id || item?.imageId || '').trim();
    const referenceId = makeImageReferenceId(item?.reference_id || item?.referenceId || referenceIdFromImageId(imageId) || '');
    const index = Number(item?.index || item?.image_index || item?.imageIndex) || (imageId ? planSelectedIndexes([imageId], referenceId)[0] : 0) || idx + 1;
    const role = ['target', 'reference', 'style_reference', 'mask', 'source', 'compare_a', 'compare_b'].includes(item?.role) ? item.role : 'target';
    const target = ['uploaded', 'previous'].includes(item?.target) ? item.target : (/^imgref_uploaded_/i.test(referenceId) ? 'uploaded' : 'previous');
    const source = ['current', 'quoted', 'history'].includes(item?.source) ? item.source : 'current';
    return { role, image_id: imageId, reference_id: referenceId, index, target, source };
  }).filter(item => item.image_id || item.reference_id || item.index);
}

function normalizeRouteFileRefs(route = {}) {
  const list = Array.isArray(route.fileRefs) ? route.fileRefs : [];
  return list.map((item, idx) => ({
    role: item?.role || 'source',
    file_id: String(item?.file_id || item?.fileId || item?.id || '').trim(),
    index: Number(item?.index) || idx + 1,
    name: String(item?.name || '').trim(),
    source: ['current', 'quoted', 'history'].includes(item?.source) ? item.source : 'current',
  })).filter(item => item.file_id || item.index || item.name);
}

function imageRefsToTasks(imageRefs = [], mode = 'chat', route = {}) {
  if (!imageRefs.length || !['image', 'edit_image'].includes(mode)) return [];
  return [{
    task_type: mode === 'edit_image' ? 'edit' : 'generate',
    input_images: imageRefs.map(ref => ({ image_id: ref.image_id, reference_id: ref.reference_id, role: ref.role || 'target' })).filter(item => item.image_id || item.reference_id),
    prompt: String(route.contextualImagePrompt || route.editInstruction || '').trim(),
    size: 'auto',
    quality: 'auto',
    background: 'auto',
    format: 'auto',
  }];
}

function normalizeRoute(route, fallbackMode = 'chat') {
  const imageRefs = normalizeRouteImageRefs(route || {});
  const fileRefs = normalizeRouteFileRefs(route || {});
  const plan = normalizeImagePlan({ ...(route || {}), tasks: Array.isArray(route?.tasks) && route.tasks.length ? route.tasks : imageRefsToTasks(imageRefs, route?.mode || fallbackMode, route || {}) });
  const plannedMode = plan.intent !== 'unknown' ? modeFromImageIntent(plan.intent, fallbackMode) : '';
  const explicitMode = ['chat', 'image', 'edit_image'].includes(route && route.mode) ? route.mode : '';
  const action = canonicalRouteAction(route || {});
  // operation.type is the most specific action. mode and intent are derived from it
  // when present, so conflicting fields cannot route to a different pipeline.
  const preferredMode = action?.mode || plannedMode || explicitMode || fallbackMode;
  const mode = preferredMode;
  const planIds = planImageIds(plan);
  const rawTarget = action?.source === 'operation' && action.mode === 'chat' ? 'none' : ['none', 'new', 'uploaded', 'previous'].includes(route && route.target) ? route.target : targetFromPlan(plan, mode);
  const target = rawTarget || (mode === 'image' ? 'new' : 'none');
  const confidence = Number.isFinite(Number(route && route.confidence)) ? Math.max(0, Math.min(1, Number(route.confidence))) : 0;
  const evidence = String(route && route.evidence || '').trim();
  const selectedImageIdsRaw = normalizeSelectedImageIds(route?.selectedImageIds);
  const selectedImageIds = selectedImageIdsRaw.length ? selectedImageIdsRaw : normalizeSelectedImageIds(imageRefs.map(ref => ref.image_id).filter(Boolean));
  const selectedReferenceId = makeImageReferenceId(route?.selectedReferenceId || imageRefs.find(ref => ref.reference_id)?.reference_id || planReferenceId(plan) || '');
  const selectedIndexesRaw = normalizeImageSelection(route?.selectedIndexes) || [];
  const indexesFromRefs = imageRefs.map(ref => Number(ref.index)).filter(index => Number.isInteger(index) && index >= 1);
  const selectedIndexes = selectedIndexesRaw.length ? selectedIndexesRaw : indexesFromRefs.length ? indexesFromRefs : planSelectedIndexes(selectedImageIds.length ? selectedImageIds : planIds, selectedReferenceId) || [];
  const operation = normalizeRouteOperation(route || {}, mode);
  return {
    mode: plan.needClarification ? 'chat' : mode,
    target: plan.needClarification ? 'none' : target,
    evidence,
    usePreviousImage: plan.needClarification ? false : mode === 'edit_image' && target === 'previous' && (confidence >= 0.75 || !evidence.length),
    selectedIndexes: plan.needClarification ? [] : selectedIndexes,
    selectedReferenceId: plan.needClarification ? makeImageReferenceId('') : selectedReferenceId,
    selectedImageIds: plan.needClarification ? [] : (selectedImageIds.length ? selectedImageIds : planIds),
    needClarification: plan.needClarification,
    clarificationQuestion: plan.clarificationQuestion,
    contextualImagePrompt: String(route?.contextualImagePrompt || '').trim(),
    editInstruction: String(route?.editInstruction || '').trim(),
    intent: action?.intent || plan.intent,
    tasks: plan.tasks,
    operation,
    imageRefs: plan.needClarification ? [] : imageRefs,
    fileRefs: plan.needClarification ? [] : fileRefs,
    confidence,
    ...(route?.operationType || route?.dispatchContract ? {
      api: String(route.api || ''),
      operationType: String(route.operationType || route.dispatchContract?.operation || ''),
      operationApi: String(route.operationApi || route.dispatchContract?.api || ''),
      relation: String(route.relation || route.dispatchContract?.relation || ''),
      readiness: String(route.readiness || ''),
      dispatchAuthorized: route.dispatchAuthorized === true,
      resumeApi: String(route.resumeApi || ''),
      dispatchContract: route.dispatchContract || null,
      executionResources: route.executionResources || null,
      messageRefs: Array.isArray(route.messageRefs) ? route.messageRefs : [],
    } : {}),
  };
}

const api = Object.freeze({
  DEFAULT_ROUTE_CONTEXT_MAX_CHARS,
  ROUTE_CONTEXT_POLICY,
  routeContextSize,
  routeContextTokenSize,
  applyRouteContextPolicy,
  compactRouteMessage,
  uploadedFileAttachmentsFromMessage,
  trimRouteContextToTokenWindow,
  trimRouteContextToSize,
  buildRouteContext,
  buildImageMemoryCards,
  compactCandidateSemanticText,
  normalizeLastGeneratedImage,
  extractPersistedImageRefs,
  latestImageReferenceMeta,
  uploadedReferenceIdForMessageIndex,
  collectRecentUploadedImageReferences,
  collectRecentImageReferences,
  latestAssistantImageResult,
  previousResourceExecutionFor,
  previousVisualExecutionFor,
  findImageReferenceById,
  normalizePlanInputImages,
  normalizeImagePlanTask,
  normalizeImagePlan,
  canonicalRouteAction,
  normalizeRouteOperation,
  normalizeRouteImageRefs,
  normalizeRouteFileRefs,
  normalizeRoute,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUICoreImageRouteContext = api;
if (root?.window) root.window.ChatUICoreImageRouteContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
