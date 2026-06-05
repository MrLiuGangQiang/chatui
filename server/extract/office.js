const { dataUrlToBuffer, withAttachmentHeader, writeTempBuffer, cleanupTempDir, optionalRequire } = require('./utils');

const mammothLib = optionalRequire('mammoth');
const officeParserLib = optionalRequire('officeparser');

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
  try { return await extractDocxWithMammoth(filename, buffer); }
  catch { return withAttachmentHeader('Word', filename, 'officeparser', await parseOfficeWithOfficeParser(buffer, filename)); }
}

module.exports = { extractExcelText, extractPowerPointText, extractWordText };
