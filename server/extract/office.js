const { dataUrlToBuffer, withAttachmentHeader, writeTempBuffer, cleanupTempDir, optionalRequire } = require('./utils');

const mammothLib = optionalRequire('mammoth');
const officeParserLib = optionalRequire('officeparser');
const WordExtractor = optionalRequire('word-extractor');

async function parseOfficeWithOfficeParser(buffer, filename) {
  if (!officeParserLib?.parseOffice) throw new Error('officeparser 未安装');
  const { dir, file } = writeTempBuffer(buffer, filename);
  try {
    const ast = await officeParserLib.parseOffice(file, {
      newlineDelimiter: '\n',
      ignoreNotes: false,
      putNotesAtLast: true,
      outputErrorToConsole: false,
      includeBreakNodes: true,
    });
    return typeof ast?.toText === 'function' ? ast.toText() : String(ast || '');
  } finally {
    cleanupTempDir(dir);
  }
}

async function extractDocxWithMammoth(filename, buffer) {
  if (!mammothLib) throw new Error('mammoth 未安装');
  const result = await mammothLib.extractRawText({ buffer });
  return withAttachmentHeader('Word', filename, 'mammoth', result.value || '');
}

async function extractLegacyDocWithWordExtractor(filename, buffer) {
  if (!WordExtractor) throw new Error('word-extractor 未安装');
  const extractor = new WordExtractor();
  const document = await extractor.extract(buffer);
  const text = [document.getBody?.(), document.getFootnotes?.(), document.getHeaders?.(), document.getAnnotations?.()]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join('\n\n');
  return withAttachmentHeader('Word', filename, 'word-extractor', text, '解析说明：以下为使用 word-extractor 从老版 .doc 文件中提取到的正文；格式可能不完整，请基于正文内容回答用户问题。');
}

async function extractExcelText(filename, dataUrl) {
  const buffer = dataUrlToBuffer(dataUrl);
  return withAttachmentHeader('Excel', filename, 'officeparser', await parseOfficeWithOfficeParser(buffer, filename), '解析说明：以下为使用 officeparser 提取到的工作簿文本；中文、日期和公式显示值会尽量保留。');
}

async function extractPowerPointText(filename, dataUrl) {
  const buffer = dataUrlToBuffer(dataUrl);
  return withAttachmentHeader('PowerPoint', filename, 'officeparser', await parseOfficeWithOfficeParser(buffer, filename));
}

async function extractWordText(filename, dataUrl) {
  const buffer = dataUrlToBuffer(dataUrl);
  if (/\.doc$/i.test(filename || '') && !/\.docx$/i.test(filename || '')) {
    try { return await extractLegacyDocWithWordExtractor(filename, buffer); }
    catch { return withAttachmentHeader('Word', filename, 'officeparser', await parseOfficeWithOfficeParser(buffer, filename)); }
  }
  try { return await extractDocxWithMammoth(filename, buffer); }
  catch { return withAttachmentHeader('Word', filename, 'officeparser', await parseOfficeWithOfficeParser(buffer, filename)); }
}

module.exports = { parseOfficeWithOfficeParser, extractDocxWithMammoth, extractLegacyDocWithWordExtractor, extractExcelText, extractPowerPointText, extractWordText };
