const { readBody, parseJson } = require('../http/body');
const { sendJson } = require('../http/response');
const { extractLimiter, withLimiter } = require('../concurrency');
const { extractPdfText } = require('./pdf');
const { extractExcelText, extractPowerPointText, extractWordText } = require('./office');
const { isTextExtractable, extractPlainText } = require('./text');
const { positiveInteger } = require('../config/numbers');
const { safeAttachmentFilename } = require('./utils');
const { throwIfAborted } = require('./utils');
const { timeoutMilliseconds } = require('../config/numbers');

const EXTRACT_TIMEOUT_MS = timeoutMilliseconds(process.env.EXTRACT_TIMEOUT_MS, 2 * 60 * 1000);

const DEFAULT_EXTRACT_LIMITS = Object.freeze({
  text: positiveInteger(process.env.MAX_EXTRACT_TEXT_BYTES, 5 * 1024 * 1024, { max: 512 * 1024 * 1024 }),
  pdf: positiveInteger(process.env.MAX_EXTRACT_PDF_BYTES, 25 * 1024 * 1024, { max: 512 * 1024 * 1024 }),
  office: positiveInteger(process.env.MAX_EXTRACT_OFFICE_BYTES, 25 * 1024 * 1024, { max: 512 * 1024 * 1024 }),
});

function estimateDataUrlBytes(dataUrl = '') {
  const value = String(dataUrl || '').trim();
  const payload = value.includes(',') ? value.split(/,(.*)/s)[1] || '' : value;
  const compact = payload.replace(/\s/g, '');
  if (!compact) return 0;
  if (/;base64/i.test(value.split(',')[0] || '')) return Math.floor(compact.length * 3 / 4);
  try { return Buffer.byteLength(decodeURIComponent(compact)); }
  catch { return Buffer.byteLength(compact); }
}

function fileKind(filename = '', type = '') {
  if (isTextExtractable(filename, type)) return 'text';
  if (/\.pdf$/i.test(filename)) return 'pdf';
  if (/\.(xlsx|xlsm|xls|pptx|ppt|docx|doc)$/i.test(filename)) return 'office';
  return 'unsupported';
}

function assertExtractSizeAllowed(kind, bytes) {
  const limit = DEFAULT_EXTRACT_LIMITS[kind];
  if (!limit || bytes <= limit) return;
  const err = new Error(`文件过大，${kind} 解析上限为 ${Math.round(limit / 1024 / 1024)}MB`);
  err.statusCode = 413;
  err.code = 'EXTRACT_FILE_TOO_LARGE';
  throw err;
}

async function extractByKind(kind, filename, dataUrl, type, options = {}) {
  throwIfAborted(options.signal);
  if (kind === 'text') return extractPlainText(filename, dataUrl, type, options);
  if (kind === 'pdf') return extractPdfText(filename, dataUrl, options);
  if (/\.(xlsx|xlsm|xls)$/i.test(filename)) return extractExcelText(filename, dataUrl, options);
  if (/\.(pptx|ppt)$/i.test(filename)) return extractPowerPointText(filename, dataUrl, options);
  if (/\.(docx|doc)$/i.test(filename)) return extractWordText(filename, dataUrl, options);
  const err = new Error('暂不支持解析该文件类型');
  err.statusCode = 415;
  throw err;
}

async function extractFileText(req, res) {
  const controller = new AbortController();
  const timeoutError = new Error('附件解析超时，请缩小文件后重试');
  timeoutError.statusCode = 504;
  timeoutError.code = 'EXTRACT_TIMEOUT';
  const timer = setTimeout(() => controller.abort(timeoutError), EXTRACT_TIMEOUT_MS);
  const abortOnClose = () => {
    if (res.writableEnded) return;
    const err = new Error('附件解析连接已关闭');
    err.name = 'AbortError';
    err.statusCode = 499;
    err.code = 'EXTRACT_ABORTED';
    controller.abort(err);
  };
  res.once('close', abortOnClose);
  try {
    const body = parseJson(await readBody(req, { maxBytes: 50 * 1024 * 1024 }));
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(res, 400, { error: { message: '请求体必须是 JSON 对象', code: 'INVALID_REQUEST_BODY' } });
    }
    const filename = safeAttachmentFilename(body.filename);
    const type = String(body.type || '').trim();
    const dataUrl = String(body.dataUrl || '');
    if (!dataUrl) return sendJson(res, 400, { error: { message: '缺少文件内容' } });
    const kind = fileKind(filename, type);
    if (kind === 'unsupported') return sendJson(res, 415, { error: { message: '暂不支持解析该文件类型' } });
    assertExtractSizeAllowed(kind, estimateDataUrlBytes(dataUrl));
    const result = await withLimiter(extractLimiter, () => extractByKind(kind, filename, dataUrl, type, { signal: controller.signal }));
    return sendJson(res, 200, result, { 'Access-Control-Allow-Origin': '*' });
  } catch (err) {
    if (res.destroyed || res.writableEnded) return;
    const expected = (Number.isInteger(err?.statusCode) && err.statusCode >= 400 && err.statusCode < 500)
      || err?.code === 'EXTRACT_TIMEOUT';
    if (!expected) console.error('[extract] attachment parsing failed:', err?.message || err);
    sendJson(res, expected ? err.statusCode : 500, {
      error: {
        message: expected ? (err.message || '附件内容无效') : '附件解析失败，请确认文件未损坏且格式受支持',
        code: expected ? (err.code || 'INVALID_ATTACHMENT') : 'EXTRACT_FAILED',
      },
    }, { 'Access-Control-Allow-Origin': '*' });
  } finally {
    clearTimeout(timer);
    res.removeListener('close', abortOnClose);
  }
}

module.exports = { DEFAULT_EXTRACT_LIMITS, EXTRACT_TIMEOUT_MS, extractByKind, extractFileText, estimateDataUrlBytes, fileKind, assertExtractSizeAllowed };
