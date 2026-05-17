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
    prompt: context.prompt || '',
    usePreviousImage: !!context.usePreviousImage,
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

function looksLikeImageEditInstruction(text = '') {
  return /修改|改成|换成|去掉|删除|加上|添加|替换|修复|调整|编辑|edit|change|remove|replace|add/i.test(String(text || ''));
}

module.exports = {
  isImageFile,
  isCompressibleRasterImage,
  formatBytes,
  normalizeImageContextForStorage,
  parseImageContext,
  looksLikeImageEditInstruction,
};
