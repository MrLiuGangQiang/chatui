const { readBody, parseJson } = require('../http/body');
const { sendJson } = require('../http/response');
const { extractPdfText } = require('./pdf');
const { extractExcelText, extractPowerPointText, extractWordText } = require('./office');
const { isTextExtractable, extractPlainText } = require('./text');

async function extractFileText(req, res) {
  try {
    const body = parseJson(await readBody(req));
    const filename = String(body.filename || 'attachment').trim();
    const type = String(body.type || '').trim();
    const dataUrl = String(body.dataUrl || '');
    if (!dataUrl) return sendJson(res, 400, { error: { message: '缺少文件内容' } });
    if (isTextExtractable(filename, type)) {
      const text = await extractPlainText(filename, dataUrl, type);
      return sendJson(res, 200, { text, parser: 'plain-text' }, { 'Access-Control-Allow-Origin': '*' });
    }
    if (/\.pdf$/i.test(filename)) {
      const text = await extractPdfText(filename, dataUrl);
      return sendJson(res, 200, { text, parser: 'pdf-basic-text-stream' }, { 'Access-Control-Allow-Origin': '*' });
    }
    if (/\.(xlsx|xlsm|xls)$/i.test(filename)) {
      const text = await extractExcelText(filename, dataUrl);
      return sendJson(res, 200, { text, parser: 'xlsx-officeparser' }, { 'Access-Control-Allow-Origin': '*' });
    }
    if (/\.(pptx|ppt)$/i.test(filename)) {
      const text = await extractPowerPointText(filename, dataUrl);
      return sendJson(res, 200, { text, parser: 'pptx-officeparser' }, { 'Access-Control-Allow-Origin': '*' });
    }
    if (/\.(docx|doc)$/i.test(filename)) {
      const text = await extractWordText(filename, dataUrl);
      return sendJson(res, 200, { text, parser: 'docx-mammoth' }, { 'Access-Control-Allow-Origin': '*' });
    }
    return sendJson(res, 415, { error: { message: '暂不支持解析该文件类型' } });
  } catch (err) {
    sendJson(res, err.statusCode || 500, { error: { message: err.message || String(err) } }, { 'Access-Control-Allow-Origin': '*' });
  }
}

module.exports = { extractFileText };
