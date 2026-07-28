const { readBody, parseJson } = require('../http/body');
const { sendJson } = require('../http/response');
const { extractLimiter, withLimiter } = require('../concurrency');
const { extractPdfText } = require('./pdf');
const { extractExcelText, extractPowerPointText, extractWordText } = require('./office');
const { isTextExtractable, extractPlainText } = require('./text');

const DEFAULT_EXTRACT_LIMITS = Object.freeze({
  text: Number(process.env.MAX_EXTRACT_TEXT_BYTES || 5 * 1024 * 1024),
  pdf: Number(process.env.MAX_EXTRACT_PDF_BYTES || 25 * 1024 * 1024),
  office: Number(process.env.MAX_EXTRACT_OFFICE_BYTES || 25 * 1024 * 1024),
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

async function extractByKind(kind, filename, dataUrl, type) {
  if (kind === 'text') return { text: await extractPlainText(filename, dataUrl, type), parser: 'plain-text' };
  if (kind === 'pdf') return { text: await extractPdfText(filename, dataUrl), parser: 'pdf-basic-text-stream' };
  if (/\.(xlsx|xlsm|xls)$/i.test(filename)) return { text: await extractExcelText(filename, dataUrl), parser: 'xlsx-officeparser' };
  if (/\.(pptx|ppt)$/i.test(filename)) return { text: await extractPowerPointText(filename, dataUrl), parser: 'pptx-officeparser' };
  if (/\.(docx|doc)$/i.test(filename)) return { text: await extractWordText(filename, dataUrl), parser: 'docx-mammoth' };
  const err = new Error('暂不支持解析该文件类型');
  err.statusCode = 415;
  throw err;
}

async function extractFileText(req, res) {
  try {
    const body = parseJson(await readBody(req, { maxBytes: 50 * 1024 * 1024 }));
    const filename = String(body.filename || 'attachment').trim();
    const type = String(body.type || '').trim();
    const dataUrl = String(body.dataUrl || '');
    if (!dataUrl) return sendJson(res, 400, { error: { message: '缺少文件内容' } });
    const kind = fileKind(filename, type);
    if (kind === 'unsupported') return sendJson(res, 415, { error: { message: '暂不支持解析该文件类型' } });
    assertExtractSizeAllowed(kind, estimateDataUrlBytes(dataUrl));
    const result = await withLimiter(extractLimiter, () => extractByKind(kind, filename, dataUrl, type));
    return sendJson(res, 200, result, { 'Access-Control-Allow-Origin': '*' });
  } catch (err) {
    sendJson(res, err.statusCode || 500, { error: { message: err.message || String(err), code: err.code || 'EXTRACT_FAILED' } }, { 'Access-Control-Allow-Origin': '*' });
  }
}

module.exports = { extractFileText, estimateDataUrlBytes, fileKind, assertExtractSizeAllowed };
