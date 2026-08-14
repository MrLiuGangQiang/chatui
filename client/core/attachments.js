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

function isInputFileAvailable(item = {}) {
  if (item.input_file_available === true || item.inputFileAvailable === true) return true;
  const isInputFile = item.inputFile === true || item.input_file === true;
  if (!isInputFile) return false;
  return !!(
    item.file
    || String(item.fileData || item.file_data || '').trim()
    || String(item.persistedSrc || item.persisted_src || '').trim()
    || String(item.src || '').trim()
    || String(item.dataUrl || item.data_url || '').trim()
  );
}

function formatBytes(bytes = 0) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const GENERIC_UPLOAD_IMAGE_STEM_PATTERNS = Object.freeze([
  /^\d[\d\s_.:-]*$/u,
  /^(?:img|image|photo|picture|pic|dsc|pxl)[\s_.-]*\d[\d\s_.:-]*$/iu,
  /^(?:screenshot|screen[\s_-]*shot|screen[\s_-]*capture|截图|截屏|屏幕截图)[\s_.-]*\d[\d\s_.:-]*(?:at[\s_.:-]*\d[\d\s_.:-]*)?$/iu,
  /^(?:img|image|photo|picture|pic|screenshot|screen[\s_-]*shot|screen[\s_-]*capture|截图|截屏|屏幕截图|图片|照片)$/iu,
]);

function compactImageAttachmentLabel(value = '', max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function meaningfulImageFilenameLabel(item = {}) {
  const rawName = String(item.name || item.filename || item.file?.name || '').trim();
  if (!rawName) return '';
  const basename = rawName.replace(/[?#].*$/, '').split(/[\\/]/).pop() || '';
  const stem = compactImageAttachmentLabel(
    basename.replace(/\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i, ''),
  ).replace(/^[\s._-]+|[\s._-]+$/g, '');
  if (!stem || GENERIC_UPLOAD_IMAGE_STEM_PATTERNS.some(pattern => pattern.test(stem))) return '';
  return stem;
}

function imageAttachmentLabel(item = {}, ordinal = 1) {
  const explicit = [
    item.label,
    item.description,
    item.semanticDescription,
    item.semantic_description,
    item.subject,
  ].map(value => compactImageAttachmentLabel(value)).find(Boolean);
  if (explicit) return explicit;
  const filename = meaningfulImageFilenameLabel(item);
  if (filename) return filename;
  const index = Number(ordinal);
  return `第 ${Number.isInteger(index) && index >= 1 ? index : 1} 张上传图片`;
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

function normalizeStoredImageAttachment(item = {}, fallbackRole = '') {
  const sourceIndex = Number(item.sourceIndex || item.source_index) || 0;
  const ordinal = Number(item.ordinal || item.position) || sourceIndex || 0;
  const labels = Array.isArray(item.labels)
    ? item.labels.map(value => String(value || '').trim()).filter(Boolean).slice(0, 12)
    : [];
  return {
    id: item.id || item.attachmentId || item.attachment_id || '',
    name: item.name || item.filename || '',
    filename: item.filename || item.name || '',
    type: item.type || '',
    size: Number(item.size) || 0,
    src: item.persistedSrc || item.src || '',
    text: item.text || '',
    unsupportedReason: item.unsupportedReason || item.unsupported_reason || '',
    compressionNote: item.compressionNote || item.compression_note || '',
    fromPrevious: !!(item.fromPrevious || item.from_previous),
    imageId: item.imageId || item.image_id || '',
    referenceId: item.referenceId || item.reference_id || '',
    resultId: item.resultId || item.result_id || '',
    sourceIndex,
    ordinal,
    width: Number(item.width || item.originalWidth || item.original_width) || 0,
    height: Number(item.height || item.originalHeight || item.original_height) || 0,
    prompt: item.prompt || '',
    description: item.description || item.semanticDescription || item.semantic_description || '',
    semantic_text: item.semantic_text || item.semanticText || '',
    labels,
    label: item.label || '',
    subject: item.subject || '',
    updatedAt: item.updatedAt || item.updated_at || null,
    routeResourceKey: item.routeResourceKey || item.route_resource_key || '',
    routeResourceType: item.routeResourceType || item.route_resource_type || '',
    routeRole: item.routeRole || item.route_role || item.role || fallbackRole,
    routeResourceId: item.routeResourceId || item.route_resource_id || item.resource_id || item.resourceId || '',
    routeSource: item.routeSource || item.route_source || item.source || '',
  };
}

function normalizeStoredImageAttachments(items, fallbackRole = '') {
  return (Array.isArray(items) ? items : [])
    .map(item => normalizeStoredImageAttachment(item, fallbackRole))
    .filter(item => item.src || item.name || item.text);
}

function normalizeImageContextForStorage(context = {}) {
  const attachments = normalizeStoredImageAttachments(context.attachments);
  const masks = normalizeStoredImageAttachments(
    context.masks || context.maskAttachments || context.mask_attachments,
    'mask',
  );
  return {
    ...(context.schema_version || context.schemaVersion ? { schema_version: context.schema_version || context.schemaVersion } : {}),
    ...(context.resultId || context.result_id ? { resultId: context.resultId || context.result_id } : {}),
    mode: context.mode || '',
    target: context.target || '',
    prompt: context.prompt || '',
    routePrompt: context.routePrompt || context.route_prompt || '',
    content: context.content || '',
    usePreviousImage: !!context.usePreviousImage,
    updatedAt: context.updatedAt || context.updated_at || null,
    imageCount: Number(context.imageCount || context.image_count) || attachments.length,
    maskCount: Number(context.maskCount || context.mask_count) || masks.length,
    referenceId: context.referenceId || context.reference_id || '',
    selectedReferenceId: context.selectedReferenceId || context.selected_reference_id || '',
    selectedIndexes: normalizeImageSelection(context.selectedIndexes || context.selected_indexes || []) || [],
    selectedImageIds: normalizeSelectedImageIds(context.selectedImageIds || context.selected_image_ids || []),
    attachments,
    masks,
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
  let imageIndex = 0;
  let fileIndex = 0;
  const validSources = new Set(['current', 'quoted', 'history', 'context']);
  return (attachments || []).map((item, index) => {
    const isImage = isImageFile(item);
    const mediaIndex = isImage ? ++imageIndex : ++fileIndex;
    const id = item.imageId || item.image_id || item.attachmentId || item.attachment_id || item.id || '';
    const referenceId = item.referenceId || item.reference_id || '';
    const declaredSource = String(item.routeSource || item.route_source || item.source || '').trim();
    const source = validSources.has(declaredSource) ? declaredSource : 'current';
    const sourceIndex = Number(
      item.sourceIndex || item.source_index || item.routeIndex || item.route_index,
    ) || index + 1;
    const description = compactImageAttachmentLabel(
      item.description || item.semanticDescription || item.semantic_description || '',
    );
    const semanticText = compactImageAttachmentLabel(item.semantic_text || item.semanticText || '', 720);
    const labels = Array.isArray(item.labels)
      ? item.labels.map(value => compactImageAttachmentLabel(value, 120)).filter(Boolean).slice(0, 12)
      : [];
    return {
      index: index + 1,
      source_index: sourceIndex,
      media_index: mediaIndex,
      source,
      route_source: source,
      id,
      ...(isImage ? {
        image_id: id,
        ...(referenceId ? { reference_id: referenceId } : {}),
        label: imageAttachmentLabel(item, mediaIndex),
        ...(description ? { description } : {}),
        ...(semanticText ? { semantic_text: semanticText } : {}),
        ...(labels.length ? { labels } : {}),
      } : { file_id: id }),
      name: item.name || (item.file && item.file.name) || 'attachment',
      type: item.type || (item.file && item.file.type) || '',
      size: Number(item.size || (item.file && item.file.size)) || 0,
      is_image: isImage,
      ...(!isImage ? {
        has_extracted_text: !!String(item.text || '').trim(),
        input_file_available: isInputFileAvailable(item),
      } : {}),
      ...(!isImage && item.unsupportedReason ? { unsupported_reason: item.unsupportedReason } : {}),
    };
  });
}

const api = Object.freeze({
  isImageFile,
  isCompressibleRasterImage,
  isInputFileAvailable,
  formatBytes,
  imageAttachmentLabel,
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
  normalizeStoredImageAttachment,
  normalizeStoredImageAttachments,
  normalizeImageContextForStorage,
  parseImageContext,
  getLatestImageReferenceTarget,
  buildRouteAttachmentMetadata,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUICoreAttachments = api;
if (root?.window) root.window.ChatUICoreAttachments = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
