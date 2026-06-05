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

function buildImageRequestPayload({ model, prompt, size = 'auto' } = {}) {
  const payload = { model, prompt };
  if (size && size !== 'auto') payload.size = size;
  return payload;
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
  createImageContext,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIImageGenerationService = api;
if (root?.window) root.window.ChatUIImageGenerationService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
