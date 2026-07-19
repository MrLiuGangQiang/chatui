function isDataUrlLike(value) {
  return typeof value === 'string' && /^data:[^,]+;base64,/i.test(value.trim());
}

function isLikelyBase64Blob(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (isDataUrlLike(trimmed)) return true;
  if (trimmed.length < 4096) return false;
  if (/^(iVBOR|\/9j\/|UklGR|R0lGOD)/.test(trimmed)) return true;
  return trimmed.length > 8192 && /^[A-Za-z0-9+/=\s]+$/.test(trimmed.slice(0, 8192));
}

function hasEmbeddedBinaryData(value, depth = 0) {
  if (depth > 4 || value === undefined || value === null) return false;
  if (typeof value === 'string') return isDataUrlLike(value) || isLikelyBase64Blob(value);
  if (Array.isArray(value)) return value.some(item => hasEmbeddedBinaryData(item, depth + 1));
  if (typeof value === 'object') return Object.values(value).some(item => hasEmbeddedBinaryData(item, depth + 1));
  return false;
}

function hasEmbeddedDataUrl(value) {
  return typeof value === 'string' && /data:[^\s"'<>`]+;base64,/i.test(value);
}

function stripEmbeddedDataUrls(value = '') {
  return String(value || '').replace(/data:[^\s"'<>`]+;base64,[A-Za-z0-9+/=\r\n]+/g, '[image-data-omitted]');
}

function stripBareBase64Images(value = '') {
  return String(value || '').replace(/(?:iVBOR|\/9j\/|UklGR|R0lGOD)[A-Za-z0-9+/=\r\n]{4096,}/g, '[image-data-omitted]');
}

function multipartTextFieldLimit(key) {
  return String(key || '').toLowerCase() === 'prompt' ? 262144 : 8192;
}

function isOversizedMultipartTextField(key, value) {
  return String(value || '').length > multipartTextFieldLimit(key);
}

function safeImageExtension(type = '', name = '') {
  const fromName = String(name || '').match(/\.([a-z0-9]{2,5})(?:[?#].*)?$/i)?.[1]?.toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(fromName)) return fromName === 'jpg' ? 'jpeg' : fromName;
  const normalizedType = String(type || '').split(';')[0].trim().toLowerCase();
  if (normalizedType === 'image/png') return 'png';
  if (normalizedType === 'image/jpeg' || normalizedType === 'image/jpg') return 'jpeg';
  if (normalizedType === 'image/webp') return 'webp';
  if (normalizedType === 'image/gif') return 'gif';
  return 'png';
}

function safeMultipartContentType(type = '') {
  const normalized = String(type || '').split(';')[0].trim().toLowerCase().replace(/[^a-z0-9.+/-]/g, '');
  if (normalized === 'image/jpg') return 'image/jpeg';
  if (/^image\/(png|jpeg|webp|gif)$/.test(normalized)) return normalized;
  return 'application/octet-stream';
}

function safeMultipartFilename(file = {}, index = 0) {
  const rawName = String(file.name || '').trim();
  const extension = safeImageExtension(file.type, rawName);
  const fallback = `image-${index + 1}.${extension}`;
  if (!rawName || rawName.length > 180 || isDataUrlLike(rawName) || isLikelyBase64Blob(rawName)) return fallback;
  const leafName = rawName.replace(/\\/g, '/').split('/').pop() || rawName;
  const cleaned = leafName
    .replace(/[\r\n"]/g, '_')
    .replace(/[^A-Za-z0-9 ._()[\]-]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/_+/g, '_')
    .trim();
  if (!cleaned || cleaned.length > 120) return fallback;
  if (/\.(png|jpe?g|webp|gif)$/i.test(cleaned)) return cleaned;
  const base = cleaned.replace(/\.[^.]+$/, '').slice(0, 100).replace(/[ ._]+$/, '') || `image-${index + 1}`;
  return `${base}.${extension}`;
}

function multipartFileMetadata(file = {}, index = 0) {
  return {
    filename: safeMultipartFilename(file, index),
    contentType: safeMultipartContentType(file.type),
  };
}

function shouldSkipMultipartField(key, value) {
  const normalizedKey = String(key || '').toLowerCase();
  if (['files', 'image_files', 'imagefiles'].includes(normalizedKey)) return true;
  if (normalizedKey === 'images' && Array.isArray(value) && value.some(item => item?.data)) return true;
  if (isDataUrlLike(value)) return true;
  if (normalizedKey !== 'prompt' && hasEmbeddedDataUrl(value)) return true;
  if (IMAGE_EDIT_BINARY_FIELD_NAMES.has(normalizedKey) && isLikelyBase64Blob(value)) return true;
  return typeof value === 'object' && hasEmbeddedBinaryData(value);
}

const IMAGE_EDIT_BINARY_FIELD_NAMES = new Set(['image', 'images', 'mask', 'file', 'files', 'input_image', 'input_images']);

const IMAGE_EDIT_MULTIPART_FIELDS = new Set([
  'model',
  'prompt',
  'size',
  'quality',
  'background',
  'output_format',
  'output_compression',
  'moderation',
  'stream',
  'partial_images',
  'user',
  'input_fidelity',
  'response_format',
]);

function shouldForwardImageEditField(payload, key, value) {
  const normalizedKey = String(key || '').toLowerCase();
  if (!IMAGE_EDIT_MULTIPART_FIELDS.has(normalizedKey)) return false;
  if (shouldSkipMultipartField(key, value)) return false;
  if (isOversizedMultipartTextField(key, value)) return false;
  return true;
}

function imageJobTargetPath(mode = 'image') {
  return mode === 'edit_image' ? '/images/edits' : '/images/generations';
}

function joinUrl(baseUrl = '', path = '') {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/${String(path || '').replace(/^\/+/, '')}`;
}

function imageJobTargetUrl(baseUrl = '', mode = 'image', payload = {}) {
  return joinUrl(baseUrl, imageJobTargetPath(mode, payload));
}

function isTaggedMaskFile(item = {}) {
  return ['field', 'fieldName', 'formName', 'multipartName'].some(key => String(item?.[key] || '').toLowerCase() === 'mask');
}

function normalizeFileList(value) {
  if (Array.isArray(value)) return value.filter(item => item?.data);
  return value?.data ? [value] : [];
}

function dataFiles(files = []) {
  return normalizeFileList(files);
}

function imageFilesOnly(files = []) {
  return dataFiles(files).filter(file => !isTaggedMaskFile(file));
}

function maskFilesOnly(files = []) {
  return dataFiles(files).filter(isTaggedMaskFile);
}

function hasFilePayloadData(value) {
  if (!value) return false;
  if (Array.isArray(value)) return value.some(hasFilePayloadData);
  return typeof value === 'object' && !!value.data;
}

function invalidImageDataError() {
  const err = new Error('图片附件数据无效，请重新上传图片');
  err.statusCode = 400;
  return err;
}

function normalizeImageBase64Data(file = {}) {
  const rawData = String(file.data || '').trim();
  const base64 = (rawData.includes(',') ? rawData.split(',').pop() : rawData).replace(/\s+/g, '');
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 === 1) throw invalidImageDataError();
  return base64;
}

function imageFileToBuffer(file = {}) {
  const base64 = normalizeImageBase64Data(file);
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw invalidImageDataError();
  return buffer;
}

function validateImageFilePayloads(files = []) {
  dataFiles(files).forEach(file => imageFileToBuffer(file));
}

function imageFileToDataUrl(file = {}) {
  const rawData = String(file.data || '').trim();
  const base64 = normalizeImageBase64Data(file);
  const dataUrlType = isDataUrlLike(rawData) ? rawData.match(/^data:([^;,]+)/i)?.[1] : '';
  const contentType = dataUrlType || safeMultipartContentType(file.type);
  return `data:${contentType};base64,${base64}`;
}

function normalizeImageEditFieldValue(key, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const normalizedKey = String(key || '').toLowerCase();
  if (normalizedKey !== 'prompt') return text;
  const stripped = stripBareBase64Images(stripEmbeddedDataUrls(text));
  return stripped.length > multipartTextFieldLimit('prompt') ? `${stripped.slice(0, multipartTextFieldLimit('prompt'))}\n[prompt-truncated]` : stripped;
}

function multipartBoundary() {
  return `chatui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function multipartHeaderValue(value = '') {
  return String(value || '').replace(/[\r\n"]/g, '_');
}

function buildMultipartTextPart(boundary, key, value) {
  return Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${multipartHeaderValue(key)}"\r\n\r\n${String(value)}\r\n`, 'utf8');
}

function buildMultipartFilePart(boundary, fieldName, file = {}, index = 0) {
  const buffer = imageFileToBuffer(file);
  const name = multipartHeaderValue(fieldName);
  const { filename, contentType } = multipartFileMetadata(file, index);
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${multipartHeaderValue(filename)}"\r\nContent-Type: ${contentType}\r\n\r\n`, 'utf8'),
    buffer,
    Buffer.from('\r\n', 'utf8'),
  ]);
}

function imageEditTextEntry(sourcePayload = {}, key, value) {
  if (value === undefined || value === null || value === '') return null;
  if (!shouldForwardImageEditField(sourcePayload, key, value)) return null;
  const fieldValue = normalizeImageEditFieldValue(key, value);
  if (!shouldForwardImageEditField(sourcePayload, key, fieldValue)) return null;
  return [key, fieldValue];
}

function imageEditTextEntries(payload = {}) {
  const sourcePayload = stripImageEditFileFields(payload || {});
  return Object.entries(sourcePayload)
    .map(([key, value]) => imageEditTextEntry(sourcePayload, key, value))
    .filter(Boolean);
}

function buildImageEditMultipartBody(payload = {}, files = [], options = {}) {
  const boundary = multipartBoundary();
  const parts = [];
  imageEditTextEntries(payload).forEach(([key, fieldValue]) => {
    parts.push(buildMultipartTextPart(boundary, key, fieldValue));
  });
  const imageFiles = imageFilesOnly(files);
  const imageFieldName = imageFiles.length > 1 ? 'image[]' : 'image';
  imageFiles.forEach((file, index) => {
    parts.push(buildMultipartFilePart(boundary, imageFieldName, file || {}, index));
  });
  const mask = dataFiles(options.masks)[0];
  if (mask?.data) parts.push(buildMultipartFilePart(boundary, 'mask', mask, 0));
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  const body = Buffer.concat(parts);
  // Node's fetch/undici determines the byte length for Buffer bodies. Setting an
  // explicit Content-Length alongside it makes undici reject the request before
  // it reaches the upstream endpoint (UND_ERR_INVALID_ARG).
  return { body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}

function buildOpenAiImageEditPayload(payload = {}, files = [], options = {}) {
  const body = {};
  imageEditTextEntries(payload).forEach(([key, fieldValue]) => {
    body[key] = fieldValue;
  });
  body.images = imageFilesOnly(files)
    .map(file => imageFileToDataUrl(file));
  const masks = dataFiles(options.masks).map(mask => imageFileToDataUrl(mask));
  if (masks.length) body.masks = masks;
  return body;
}

function stripImageEditFileFields(payload = {}) {
  const next = { ...(payload || {}) };
  delete next.files;
  delete next.image_files;
  delete next.imageFiles;
  if (Array.isArray(next.images) && next.images.some(item => item?.data)) delete next.images;
  if (hasFilePayloadData(next.image) || hasEmbeddedBinaryData(next.image)) delete next.image;
  if (hasFilePayloadData(next.mask) || hasEmbeddedBinaryData(next.mask)) delete next.mask;
  if (hasFilePayloadData(next.masks) || hasEmbeddedBinaryData(next.masks)) delete next.masks;
  return next;
}

function imageEditPromptCandidates(payload = {}, body = {}) {
  return [
    payload.prompt,
    payload.editInstruction,
    payload.edit_instruction,
    payload.routePrompt,
    payload.route_prompt,
    payload.originalPrompt,
    payload.original_prompt,
    body.prompt,
    body.editInstruction,
    body.edit_instruction,
    body.routePrompt,
    body.route_prompt,
    body.originalPrompt,
    body.original_prompt,
  ];
}

function resolveImageEditPrompt(payload = {}, body = {}) {
  return imageEditPromptCandidates(payload, body)
    .map(candidate => String(candidate || '').trim())
    .find(Boolean) || '';
}

function ensureImageEditPrompt(payload = {}, body = {}) {
  const next = { ...(payload || {}) };
  const prompt = resolveImageEditPrompt(next, body);
  if (prompt) next.prompt = prompt;
  return next;
}

const IMAGE_EDIT_FILE_CANDIDATE_SOURCES = [
  ['body.files', body => body.files],
  ['body.image_files', body => body.image_files],
  ['body.imageFiles', body => body.imageFiles],
  ['payload.files', body => body.payload?.files],
  ['payload.image_files', body => body.payload?.image_files],
  ['payload.imageFiles', body => body.payload?.imageFiles],
  ['payload.images', body => body.payload?.images],
];

const IMAGE_EDIT_MASK_CANDIDATE_SOURCES = [
  ['body.mask', body => body.mask],
  ['body.masks', body => body.masks],
  ['payload.mask', body => body.payload?.mask],
  ['payload.masks', body => body.payload?.masks],
  ['body.files tagged mask', body => maskFilesOnly(body.files)],
  ['payload.files tagged mask', body => maskFilesOnly(body.payload?.files)],
];

function imageEditCandidateValues(body = {}, sources = []) {
  const sourceBody = body || {};
  return sources.map(([, readValue]) => readValue(sourceBody));
}

function imageEditFileCandidates(body = {}) {
  return imageEditCandidateValues(body, IMAGE_EDIT_FILE_CANDIDATE_SOURCES);
}

function imageEditMaskCandidates(body = {}) {
  return imageEditCandidateValues(body, IMAGE_EDIT_MASK_CANDIDATE_SOURCES);
}

function firstFileCandidateList(candidates = []) {
  return candidates.find(items => Array.isArray(items) && items.some(item => item?.data)) || [];
}

function extractImageEditFiles(body = {}) {
  return imageFilesOnly(firstFileCandidateList(imageEditFileCandidates(body)));
}

function extractImageEditMasks(body = {}) {
  const masks = imageEditMaskCandidates(body).flatMap(dataFiles);
  return masks.filter(item => item?.data);
}

module.exports = {
  buildImageEditMultipartBody,
  buildMultipartFilePart,
  buildMultipartTextPart,
  buildOpenAiImageEditPayload,
  ensureImageEditPrompt,
  extractImageEditFiles,
  extractImageEditMasks,
  dataFiles,
  hasEmbeddedBinaryData,
  hasEmbeddedDataUrl,
  hasFilePayloadData,
  imageFileToBuffer,
  imageFileToDataUrl,
  imageFilesOnly,
  imageEditFileCandidates,
  imageEditMaskCandidates,
  imageEditPromptCandidates,
  imageEditTextEntry,
  imageEditTextEntries,
  imageJobTargetPath,
  imageJobTargetUrl,
  isDataUrlLike,
  isLikelyBase64Blob,
  isOversizedMultipartTextField,
  isTaggedMaskFile,
  joinUrl,
  multipartBoundary,
  multipartFileMetadata,
  multipartHeaderValue,
  multipartTextFieldLimit,
  maskFilesOnly,
  normalizeFileList,
  normalizeImageBase64Data,
  normalizeImageEditFieldValue,
  resolveImageEditPrompt,
  safeImageExtension,
  safeMultipartContentType,
  safeMultipartFilename,
  shouldForwardImageEditField,
  shouldSkipMultipartField,
  stripBareBase64Images,
  stripEmbeddedDataUrls,
  stripImageEditFileFields,
  validateImageFilePayloads,
};
