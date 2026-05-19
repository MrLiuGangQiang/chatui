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

function normalizeImageContextForStorage(context = {}) {
  return {
    mode: context.mode || '',
    target: context.target || '',
    prompt: context.prompt || '',
    usePreviousImage: !!context.usePreviousImage,
    updatedAt: context.updatedAt || context.updated_at || null,
    attachments: Array.isArray(context.attachments)
      ? context.attachments.map(item => ({
        name: item.name || '',
        type: item.type || '',
        size: Number(item.size) || 0,
        src: item.persistedSrc || item.src || '',
      })).filter(item => item.src || item.name)
      : [],
  };
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
    if (isGeneratedItem(item) && hasGenerated) return { target: 'previous', usePreviousImage: true, reason: 'latest-assistant-image', count: generatedCount, selection: 'all' };
    const uploadCount = item && item.role === 'user' ? uploadCountFromItem(item) : 0;
    if (uploadCount) return { target: 'uploaded', usePreviousImage: false, reason: 'latest-user-upload', count: uploadCount, selection: 'all' };
  }
  for (const item of [...messages].reverse()) {
    if (item && item.role === 'assistant' && isGeneratedItem(item) && hasGenerated) return { target: 'previous', usePreviousImage: true, reason: 'latest-assistant-image', count: generatedCount, selection: 'all' };
    const uploadCount = item && item.role === 'user' ? uploadCountFromItem(item) : 0;
    if (uploadCount) return { target: 'uploaded', usePreviousImage: false, reason: 'latest-user-upload', count: uploadCount, selection: 'all' };
  }
  if (hasGenerated) return { target: 'previous', usePreviousImage: true, reason: 'last-generated-image', count: generatedCount, selection: 'all' };
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

module.exports = {
  isImageFile,
  isCompressibleRasterImage,
  formatBytes,
  normalizeImageContextForStorage,
  parseImageContext,
  getLatestImageReferenceTarget,
  buildRouteAttachmentMetadata,
};
