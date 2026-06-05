(function initChatUICoreAttachments(root) {
  'use strict';

const imageReferences = root?.ChatUICoreImageReferences || (typeof require === 'function' ? require('./image-references') : {});

function isImageFile(file = {}) {
  const type = String(file.type || '').toLowerCase();
  const name = String(file.name || '').toLowerCase();
  return type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
}

function isCompressibleRasterImage(file = {}) {
  const type = String(file.type || '').toLowerCase();
  const name = String(file.name || '').toLowerCase();
  return ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(type) || /\.(png|jpe?g|webp)$/i.test(name);
}

function formatBytes(bytes = 0) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const {
  IMAGE_REFERENCE_PREFIX,
  IMAGE_ITEM_PREFIX,
  sanitizeImageReferencePart,
  makeImageReferenceId,
  parseImageReferenceId,
  makeImageItemId,
  normalizeSelectedImageIds,
  resolveImageSelectionFromIds,
  normalizeImageSelection,
} = imageReferences;

function normalizeImageContextForStorage(context = {}) {
  return {
    mode: context.mode || '',
    target: context.target || '',
    prompt: context.prompt || '',
    usePreviousImage: !!context.usePreviousImage,
    updatedAt: context.updatedAt || context.updated_at || null,
    imageCount: Number(context.imageCount || context.image_count) || (Array.isArray(context.attachments) ? context.attachments.length : 0),
    referenceId: context.referenceId || context.reference_id || '',
    selectedReferenceId: context.selectedReferenceId || context.selected_reference_id || '',
    selectedIndexes: normalizeImageSelection(context.selectedIndexes || context.selected_indexes || []) || [],
    selectedImageIds: normalizeSelectedImageIds(context.selectedImageIds || context.selected_image_ids || []),
    attachments: Array.isArray(context.attachments)
      ? context.attachments.map(item => ({
        name: item.name || '',
        type: item.type || '',
        size: Number(item.size) || 0,
        src: item.persistedSrc || item.src || '',
        imageId: item.imageId || item.image_id || '',
        referenceId: item.referenceId || item.reference_id || '',
        sourceIndex: Number(item.sourceIndex || item.source_index) || 0,
      })).filter(item => item.src || item.name)
      : [],
  };
}

function looksLikeImageEditInstruction(text = '') {
  return /(换|替换|改|修改|编辑|调整|优化|重做|修|去掉|加上|放大|缩小|变成|换个|换成|logo|图标|背景|颜色|字体|样式|清晰|高清|edit|change|remove|replace|add)/i.test(String(text || ''));
}

function parseImageContext(value) {
  if (!value) return null;
  if (typeof value === 'object') return normalizeImageContextForStorage(value);
  try {
    return normalizeImageContextForStorage(JSON.parse(value));
  } catch {
    return null;
  }
}

function getLatestImageReferenceTarget({ display = [], messages = [], lastGeneratedImage = null, latestUploadedImage = null } = {}) {
  const generatedCount = Array.isArray(lastGeneratedImage && lastGeneratedImage.images)
    ? lastGeneratedImage.images.length
    : lastGeneratedImage && lastGeneratedImage.src ? 1 : 0;
  const hasGenerated = generatedCount > 0;
  const uploadCountFromItem = item => {
    const context = parseImageContext(item && item.imageContext);
    return context && context.attachments && context.attachments.length && (context.target === 'uploaded' || context.mode === 'edit_image')
      ? context.attachments.length
      : 0;
  };
  const isGeneratedItem = item => !!(item && /generated-thumb|image-result-head|图片(生成|编辑|修改)完成/.test(`${item.html || ''} ${item.rawText || ''} ${item.content || ''}`));
  for (const item of [...display].reverse()) {
    if (isGeneratedItem(item) && hasGenerated) return { target: 'previous', usePreviousImage: true, reason: 'latest-assistant-image', count: generatedCount, selection: 'all', reference_id: makeImageReferenceId('latest') };
    const uploadCount = item && item.role === 'user' ? uploadCountFromItem(item) : 0;
    if (uploadCount) return { target: 'uploaded', usePreviousImage: false, reason: 'latest-user-upload', count: uploadCount, selection: 'all' };
  }
  for (const item of [...messages].reverse()) {
    if (item && item.role === 'assistant' && isGeneratedItem(item) && hasGenerated) return { target: 'previous', usePreviousImage: true, reason: 'latest-assistant-image', count: generatedCount, selection: 'all', reference_id: makeImageReferenceId('latest') };
    const uploadCount = item && item.role === 'user' ? uploadCountFromItem(item) : 0;
    if (uploadCount) return { target: 'uploaded', usePreviousImage: false, reason: 'latest-user-upload', count: uploadCount, selection: 'all' };
  }
  if (hasGenerated) return { target: 'previous', usePreviousImage: true, reason: 'last-generated-image', count: generatedCount, selection: 'all', reference_id: makeImageReferenceId('latest') };
  if (latestUploadedImage) return { target: 'uploaded', usePreviousImage: false, reason: 'latest-uploaded-image', count: latestUploadedImage.attachments && latestUploadedImage.attachments.length || 1, selection: 'all' };
  return { target: 'none', usePreviousImage: false, reason: 'no-image-reference', count: 0, selection: 'none' };
}

function buildRouteAttachmentMetadata(attachments = []) {
  return (attachments || []).map(item => ({
    name: item.name || (item.file && item.file.name) || 'attachment',
    type: item.type || (item.file && item.file.type) || '',
    size: Number(item.size || (item.file && item.file.size)) || 0,
    is_image: isImageFile(item),
  }));
}

const api = Object.freeze({
  isImageFile,
  isCompressibleRasterImage,
  formatBytes,
  looksLikeImageEditInstruction,
  IMAGE_REFERENCE_PREFIX,
  IMAGE_ITEM_PREFIX,
  sanitizeImageReferencePart,
  makeImageReferenceId,
  parseImageReferenceId,
  makeImageItemId,
  normalizeSelectedImageIds,
  resolveImageSelectionFromIds,
  normalizeImageSelection,
  normalizeImageContextForStorage,
  parseImageContext,
  getLatestImageReferenceTarget,
  buildRouteAttachmentMetadata,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUICoreAttachments = api;
if (root?.window) root.window.ChatUICoreAttachments = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
