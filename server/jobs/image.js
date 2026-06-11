const { sendJson } = require('../http/response');
const { makeJobId, getJobIdFromUrl, publicJob, extractProxyRequest, createUpstreamFetch, safeParseJson, respondJobError, findJobOr404 } = require('./common');


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

function shouldSkipMultipartField(key, value) {
  const normalizedKey = String(key || '').toLowerCase();
  if (['files', 'image_files', 'imagefiles'].includes(normalizedKey)) return true;
  if (normalizedKey === 'images' && Array.isArray(value) && value.some(item => item?.data)) return true;
  if (isDataUrlLike(value)) return true;
  if (normalizedKey !== 'prompt' && hasEmbeddedDataUrl(value)) return true;
  const binaryFieldNames = new Set(['image', 'images', 'mask', 'file', 'files', 'input_image', 'input_images']);
  if (binaryFieldNames.has(normalizedKey) && isLikelyBase64Blob(value)) return true;
  return typeof value === 'object' && hasEmbeddedBinaryData(value);
}

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
  return mode === 'edit_image' ? '/openai/image_edit' : '/images/generations';
}

function isTaggedMaskFile(item = {}) {
  return ['field', 'fieldName', 'formName', 'multipartName'].some(key => String(item?.[key] || '').toLowerCase() === 'mask');
}

function normalizeFileList(value) {
  if (Array.isArray(value)) return value.filter(item => item?.data);
  return value?.data ? [value] : [];
}

function hasFilePayloadData(value) {
  if (!value) return false;
  if (Array.isArray(value)) return value.some(hasFilePayloadData);
  return typeof value === 'object' && !!value.data;
}

function imageFileToBlob(file = {}) {
  const rawData = String(file.data || '').trim();
  const base64 = rawData.includes(',') ? rawData.split(',').pop() : rawData;
  return new Blob([Buffer.from(base64, 'base64')], { type: safeMultipartContentType(file.type) });
}

function normalizeImageEditFieldValue(key, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const normalizedKey = String(key || '').toLowerCase();
  if (normalizedKey !== 'prompt') return text;
  const stripped = stripBareBase64Images(stripEmbeddedDataUrls(text));
  return stripped.length > multipartTextFieldLimit('prompt') ? `${stripped.slice(0, multipartTextFieldLimit('prompt'))}\n[prompt-truncated]` : stripped;
}

function buildImageEditMultipartBody(payload = {}, files = [], options = {}) {
  const body = new FormData();
  Object.entries(payload || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (!shouldForwardImageEditField(payload, key, value)) return;
    const fieldValue = normalizeImageEditFieldValue(key, value);
    if (!shouldForwardImageEditField(payload, key, fieldValue)) return;
    body.append(String(key), String(fieldValue));
  });
  (files || []).filter(file => file?.data && !isTaggedMaskFile(file)).forEach((file, index) => {
    body.append('image[]', imageFileToBlob(file || {}), safeMultipartFilename(file, index));
  });
  const mask = normalizeFileList(options.masks)[0];
  if (mask?.data) body.append('mask', imageFileToBlob(mask), safeMultipartFilename(mask, 0));
  return { body, headers: {} };
}

function extractImageEditFiles(body = {}) {
  const candidates = [
    body.files,
    body.image_files,
    body.imageFiles,
    body.payload?.files,
    body.payload?.image_files,
    body.payload?.imageFiles,
    body.image,
    body.images,
    body.payload?.image,
    body.payload?.images,
  ].find(items => Array.isArray(items) && items.some(item => item?.data)) || [];
  return candidates.filter(item => item?.data && !isTaggedMaskFile(item));
}

function extractImageEditMasks(body = {}) {
  const masks = [
    ...normalizeFileList(body.mask),
    ...normalizeFileList(body.masks),
    ...normalizeFileList(body.payload?.mask),
    ...normalizeFileList(body.payload?.masks),
    ...normalizeFileList(body.files).filter(isTaggedMaskFile),
    ...normalizeFileList(body.payload?.files).filter(isTaggedMaskFile),
  ];
  return masks.filter(item => item?.data);
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

function createImageJobHandlers({ imageJobs, notifyJob, upstreamTimeoutMs }) {
async function runImageJob(job) {
const headers = { ...(job.extraHeaders || {}), ...(job.apiKey ? { Authorization: `Bearer ${job.apiKey}` } : {}) };
let body;
if (job.mode === 'edit_image') {
  const editPayload = stripImageEditFileFields(job.payload);
  const multipart = buildImageEditMultipartBody(editPayload, job.files, { masks: job.masks });
  console.log('[image-edit] upstream multipart', JSON.stringify({ model: editPayload.model || '', targetPath: imageJobTargetPath('edit_image'), fields: Object.keys(editPayload), images: job.files?.length || 0, hasMask: !!job.masks?.length }));
  body = multipart.body;
  Object.assign(headers, multipart.headers);
} else {
  headers['Content-Type'] = 'application/json';
  const generationPayload = stripImageEditFileFields(job.payload);
  console.log('[image-generation] upstream json', JSON.stringify({ model: generationPayload.model || '', fields: Object.keys(generationPayload) }));
  body = JSON.stringify(generationPayload || {});
}
const { response: upstreamResponse, controller, timer } = createUpstreamFetch(job.targetUrl, {
  method: 'POST',
  headers,
  body,
  job,
  upstreamTimeoutMs,
});
try {
  job.serverStartAt = Date.now();
  const upstream = await upstreamResponse;
  const text = await upstream.text();
  const data = safeParseJson(text);
  if (!upstream.ok) throw new Error(data?.error?.message || data?.message || data?.raw || text || `上游返回 ${upstream.status}`);
  job.status = 'done';
  job.data = data;
  job.durationMs = Date.now() - Number(job.serverStartAt || job.createdAt || Date.now());
} catch (err) {
  const aborted = err?.name === 'AbortError';
  job.status = 'error';
  job.error = aborted ? '上游请求超时' : `连接上游接口失败：${err.message || String(err)}`;
} finally {
  clearTimeout(timer);
  delete job.controller;
  job.updatedAt = Date.now();
  notifyJob(job);
}
}

async function startImageJob(req, res) {
const extracted = await extractProxyRequest(req, res);
if (!extracted) return;
const { body, baseUrl, apiKey, extraHeaders } = extracted;
try {
  const payload = body.payload || {};
  const jobId = makeJobId(body.jobId);
  if (imageJobs.has(jobId)) return sendJson(res, 200, publicJob(imageJobs.get(jobId)), { 'Access-Control-Allow-Origin': '*' });
  const files = extractImageEditFiles(body);
  const imageFiles = files.filter(item => !isTaggedMaskFile(item));
  const masks = extractImageEditMasks(body);
  const mode = body.mode === 'edit_image' || imageFiles.length ? 'edit_image' : 'image';
  if (mode === 'edit_image' && !imageFiles.length) return sendJson(res, 400, { error: { message: '图片编辑任务缺少图片附件' } });
  const job = {
    id: jobId,
    status: 'running',
    mode,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    targetUrl: `${baseUrl}${imageJobTargetPath(mode, payload)}`,
    apiKey,
    extraHeaders,
    payload,
    files: imageFiles,
    masks,
    data: null,
    error: '',
    durationMs: null,
  };
  imageJobs.set(job.id, job);
  runImageJob(job);
  sendJson(res, 202, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
} catch (err) {
  respondJobError(res, err);
}
}

function getImageJob(req, res) {
const id = getJobIdFromUrl(req);
const job = findJobOr404(imageJobs, id, res);
if (!job) return;
sendJson(res, 200, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
}


  return { startImageJob, getImageJob };
}

module.exports = {
  createImageJobHandlers,
  buildImageEditMultipartBody,
  extractImageEditFiles,
  extractImageEditMasks,
  imageJobTargetPath,
  stripImageEditFileFields,
};
