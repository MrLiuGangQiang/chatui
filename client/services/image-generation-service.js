(function initChatUIImageGenerationService(root) {
  'use strict';

const taskContinuity = root?.[Symbol.for('chatui.module-registry.v1')]?.get('taskContinuity')
  || (typeof require === 'function' ? require('../../shared/task-continuity') : {});

function buildPromptWithTextAttachments(prompt = '', attachments = [], isImageFile = () => false) {
  const textAttachments = attachments.filter(item => item && item.text);
  const unsupportedAttachments = attachments.filter(item => item && !item.text && !isImageFile(item));
  const parts = [];
  if (prompt) parts.push(prompt);
  if (textAttachments.length) {
    parts.push(textAttachments.map(item => `[附件：${item.name}]\n${item.text}`).join('\n\n'));
  }
  if (unsupportedAttachments.length) {
    const error = new Error(`附件内容不可用，已停止发送：${unsupportedAttachments.map(item => item.name || 'attachment').join('、')}`);
    error.code = 'ATTACHMENT_CONTENT_UNAVAILABLE';
    error.attachments = unsupportedAttachments.map(item => ({
      name: String(item.name || 'attachment'),
      type: String(item.type || 'application/octet-stream'),
      reason: String(item.unsupportedReason || ''),
    }));
    throw error;
  }
  return parts.filter(Boolean).join('\n\n') || prompt;
}

function buildImagePromptWithStylePrompt(prompt = '', stylePrompt = '') {
  const style = String(stylePrompt || '').trim();
  const text = String(prompt || '').trim();
  return style && text ? `${text}\n\n图片样式要求：\n${style}` : text || style;
}

function normalizeAutoValue(value) {
  const text = String(value || '').trim();
  return text && text !== 'auto' ? text : '';
}

function normalizeOutputFormat(value) {
  const text = normalizeAutoValue(value).toLowerCase();
  if (text === 'jpg') return 'jpeg';
  return ['png', 'jpeg', 'webp'].includes(text) ? text : '';
}

function buildImageRequestPayload({ model, prompt, quality = 'auto', background = 'auto', format = 'auto', output_format } = {}) {
  const normalizedPrompt = String(prompt || '').trim();
  // Size is deliberately not an exposed generation control. Keeping the wire
  // value explicit makes every supported image endpoint use provider auto mode.
  const payload = { model, prompt: normalizedPrompt, size: 'auto' };
  const resolvedQuality = normalizeAutoValue(quality);
  const resolvedBackground = normalizeAutoValue(background);
  const resolvedFormat = normalizeOutputFormat(output_format || format);
  if (resolvedQuality) payload.quality = resolvedQuality;
  if (resolvedBackground) payload.background = resolvedBackground;
  if (resolvedFormat) payload.output_format = resolvedFormat;
  return payload;
}

function buildGptImage2TaskPayload({ model, task = {}, prompt = '' } = {}) {
  return buildImageRequestPayload({
    model,
    prompt: task.prompt || prompt,
    quality: task.quality,
    background: task.background,
    format: task.format || task.output_format || task.outputFormat,
  });
}

function createImageContext({ prompt = '', routePrompt = '', resolvedGoal = '', taskState = null, attachments = [], masks = [], maskAttachments = [], mode = 'image', target = 'new', usePreviousImage = false, selectedReferenceId = '', selectedIndexes = [], selectedImageIds = [], makeImageItemId = null } = {}) {
  if (typeof taskContinuity.normalizeOptionalTaskContinuity !== 'function') {
    throw new TypeError('Task continuity protocol is unavailable');
  }
  const exactTaskState = taskContinuity.normalizeOptionalTaskContinuity(taskState);
  const makeId = typeof makeImageItemId === 'function' ? makeImageItemId : ((reference, index) => `img_${reference || 'latest'}_${index || 1}`);
  const targetImages = Array.isArray(attachments) ? attachments : [];
  const maskImages = Array.isArray(masks) && masks.length
    ? masks
    : Array.isArray(maskAttachments)
      ? maskAttachments
      : [];
  const normalizeImage = (item, index, role = '') => ({
    ...item,
    routeRole: item.routeRole || item.route_role || item.role || role,
    referenceId: item.referenceId || selectedReferenceId || '',
    imageId: item.imageId || makeId(selectedReferenceId || 'latest', item.sourceIndex || index + 1),
    sourceIndex: item.sourceIndex || index + 1,
  });
  return {
    prompt,
    routePrompt,
    resolvedGoal: String(resolvedGoal || routePrompt || prompt || '').trim(),
    ...(exactTaskState ? { taskState: exactTaskState } : {}),
    mode,
    target,
    usePreviousImage: !!usePreviousImage,
    selectedReferenceId: selectedReferenceId || '',
    selectedIndexes: Array.isArray(selectedIndexes) ? selectedIndexes : [],
    selectedImageIds: Array.isArray(selectedImageIds) ? selectedImageIds : [],
    attachments: targetImages.map((item, index) => normalizeImage(item, index)),
    masks: maskImages.map((item, index) => normalizeImage(item, index, 'mask')),
  };
}

const api = Object.freeze({
  buildPromptWithTextAttachments,
  buildImagePromptWithStylePrompt,
  buildImageRequestPayload,
  buildGptImage2TaskPayload,
  createImageContext,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIImageGenerationService = api;
if (root?.window) root.window.ChatUIImageGenerationService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
