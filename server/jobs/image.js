const { sendJson } = require('../http/response');
const { readBody, parseJson } = require('../http/body');
const { normalizeExtraHeaders } = require('../proxy/headers');
const { normalizeBaseUrl } = require('../security/url-policy');
const { makeJobId, getJobIdFromUrl, publicJob } = require('./common');


function multipartEscape(value = '') {
  return String(value || '').replace(/[\r\n"]/g, '_');
}

function appendMultipartField(parts, boundary, name, value) {
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${multipartEscape(name)}"\r\n\r\n${String(value)}\r\n`));
}

function appendMultipartFile(parts, boundary, name, file, index = 0) {
  const filename = multipartEscape(file.name || `image-${index + 1}.png`);
  const contentType = String(file.type || 'application/octet-stream').replace(/[\r\n]/g, '') || 'application/octet-stream';
  const rawData = String(file.data || '');
  const base64 = rawData.includes(',') ? rawData.split(',').pop() : rawData;
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${multipartEscape(name)}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`));
  parts.push(Buffer.from(base64, 'base64'));
  parts.push(Buffer.from('\r\n'));
}

function buildImageEditMultipartBody(payload = {}, files = []) {
  const boundary = `----chatui-image-edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const parts = [];
  Object.entries(payload || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    appendMultipartField(parts, boundary, key, typeof value === 'string' ? value : JSON.stringify(value));
  });
  (files || []).forEach((file, index) => appendMultipartFile(parts, boundary, 'image', file || {}, index));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  return {
    body,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
  };
}

function extractImageEditFiles(body = {}) {
  const candidates = [
    body.files,
    body.image_files,
    body.imageFiles,
    body.payload?.files,
    body.payload?.image_files,
    body.payload?.imageFiles,
    body.payload?.images,
  ].find(items => Array.isArray(items) && items.some(item => item?.data)) || [];
  return candidates.filter(item => item?.data);
}

function stripImageEditFileFields(payload = {}) {
  const next = { ...(payload || {}) };
  delete next.files;
  delete next.image_files;
  delete next.imageFiles;
  if (Array.isArray(next.images) && next.images.some(item => item?.data)) delete next.images;
  return next;
}

function createImageJobHandlers({ imageJobs, notifyJob, upstreamTimeoutMs }) {
async function runImageJob(job) {
const controller = new AbortController();
job.controller = controller;
const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
try {
  job.serverStartAt = Date.now();
  const headers = { ...(job.extraHeaders || {}), ...(job.apiKey ? { Authorization: `Bearer ${job.apiKey}` } : {}) };
  let body;
  if (job.mode === 'edit_image') {
    const multipart = buildImageEditMultipartBody(stripImageEditFileFields(job.payload), job.files);
    body = multipart.body;
    Object.assign(headers, multipart.headers);
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(job.payload || {});
  }
  const upstream = await fetch(job.targetUrl, {
    method: 'POST',
    signal: controller.signal,
    headers,
    body,
  });
  const text = await upstream.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
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
try {
  const body = parseJson(await readBody(req));
  const baseUrl = normalizeBaseUrl(body.baseUrl);
  const apiKey = String(body.apiKey || '').trim();
  const payload = body.payload || {};
    if (!baseUrl) return sendJson(res, 400, { error: { message: '缺少或非法 baseUrl' } });
  const jobId = makeJobId(body.jobId);
  if (imageJobs.has(jobId)) return sendJson(res, 200, publicJob(imageJobs.get(jobId)), { 'Access-Control-Allow-Origin': '*' });
  const mode = body.mode === 'edit_image' ? 'edit_image' : 'image';
  const files = Array.isArray(body.files) ? body.files.filter(item => item?.data) : [];
  if (mode === 'edit_image' && !files.length) return sendJson(res, 400, { error: { message: '图片编辑任务缺少图片附件' } });
  const job = {
    id: jobId,
    status: 'running',
    mode,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    targetUrl: `${baseUrl}/images/${mode === 'edit_image' ? 'edits' : 'generations'}`,
    apiKey,
    extraHeaders: normalizeExtraHeaders(body.headers || body.extraHeaders),
    payload,
    files,
    data: null,
    error: '',
    durationMs: null,
  };
  imageJobs.set(job.id, job);
  runImageJob(job);
  sendJson(res, 202, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
} catch (err) {
  sendJson(res, err.statusCode || 500, { error: { message: err.message || String(err) } });
}
}

function getImageJob(req, res) {
const id = getJobIdFromUrl(req);
const job = imageJobs.get(id);
if (!job) return sendJson(res, 404, { error: { message: '任务不存在或服务已重启' } });
sendJson(res, 200, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
}


  return { startImageJob, getImageJob };
}

module.exports = {
  createImageJobHandlers,
  buildImageEditMultipartBody,
  extractImageEditFiles,
  stripImageEditFileFields,
};
