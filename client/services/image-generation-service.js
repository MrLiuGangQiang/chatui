(function initChatUIImageGenerationService(root) {
  'use strict';

function buildPromptWithTextAttachments(prompt = '', attachments = [], isImageFile = () => false) {
  const textAttachments = attachments.filter(item => item && item.text);
  const unsupportedAttachments = attachments.filter(item => item && !item.text && !isImageFile(item));
  const parts = [];
  if (prompt) parts.push(prompt);
  if (textAttachments.length) {
    parts.push(textAttachments.map(item => `[附件：${item.name}]\n${item.text}`).join('\n\n'));
  }
  if (unsupportedAttachments.length) {
    parts.push(`[以下附件已上传到页面，但未能解析正文，因此不会直接发送二进制文件给模型，避免接口报错：\n${unsupportedAttachments.map(item => `- ${item.name} (${item.type})：${item.unsupportedReason || '暂不支持解析，请转换为文本/Markdown/CSV 后再上传'}`).join('\n')}\n]`);
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

function buildImageRequestPayload({ model, prompt, size = 'auto', quality = 'auto', background = 'auto', format = 'auto', output_format } = {}) {
  const normalizedPrompt = String(prompt || '').trim();
  const payload = { model, prompt: normalizedPrompt };
  const resolvedSize = normalizeAutoValue(size);
  const resolvedQuality = normalizeAutoValue(quality);
  const resolvedBackground = normalizeAutoValue(background);
  const resolvedFormat = normalizeOutputFormat(output_format || format);
  if (resolvedSize) payload.size = resolvedSize;
  if (resolvedQuality) payload.quality = resolvedQuality;
  if (resolvedBackground) payload.background = resolvedBackground;
  if (resolvedFormat) payload.output_format = resolvedFormat;
  return payload;
}

function buildGptImage2TaskPayload({ model, task = {}, prompt = '' } = {}) {
  return buildImageRequestPayload({
    model,
    prompt: task.prompt || prompt,
    size: task.size,
    quality: task.quality,
    background: task.background,
    format: task.format || task.output_format || task.outputFormat,
  });
}

function createImageContext({ prompt = '', routePrompt = '', attachments = [], mode = 'image', target = 'new', usePreviousImage = false, selectedReferenceId = '', selectedIndexes = [], selectedImageIds = [], makeImageItemId = null } = {}) {
  const makeId = typeof makeImageItemId === 'function' ? makeImageItemId : ((reference, index) => `img_${reference || 'latest'}_${index || 1}`);
  return {
    prompt,
    routePrompt,
    mode,
    target,
    usePreviousImage: !!usePreviousImage,
    selectedReferenceId: selectedReferenceId || '',
    selectedIndexes: Array.isArray(selectedIndexes) ? selectedIndexes : [],
    selectedImageIds: Array.isArray(selectedImageIds) ? selectedImageIds : [],
    attachments: (attachments || []).map((item, index) => ({
      ...item,
      referenceId: item.referenceId || selectedReferenceId || '',
      imageId: item.imageId || makeId(selectedReferenceId || 'latest', item.sourceIndex || index + 1),
      sourceIndex: item.sourceIndex || index + 1,
    })),
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
