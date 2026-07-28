const { dataUrlToBuffer, withAttachmentHeader, writeTempBuffer, cleanupTempDir, optionalRequire, assertOfficeArchiveSafe, raceWithSignal, throwIfAborted } = require('./utils');

const mammothLib = optionalRequire('mammoth');
const officeParserLib = optionalRequire('officeparser');
const WordExtractor = optionalRequire('word-extractor');

async function parseOfficeWithOfficeParser(buffer, filename, options = {}) {
  if (!officeParserLib?.parseOffice) throw new Error('officeparser 未安装');
  const { dir, file } = writeTempBuffer(buffer, filename);
  try {
    const ast = await raceWithSignal(officeParserLib.parseOffice(file, {
      newlineDelimiter: '\n',
      ignoreNotes: false,
      putNotesAtLast: true,
      outputErrorToConsole: false,
      includeBreakNodes: true,
    }), options.signal);
    return typeof ast?.toText === 'function' ? ast.toText() : String(ast || '');
  } finally {
    cleanupTempDir(dir);
  }
}

async function extractDocxWithMammoth(filename, buffer, options = {}) {
  if (!mammothLib) throw new Error('mammoth 未安装');
  const result = await raceWithSignal(mammothLib.extractRawText({ buffer }), options.signal);
  return { text: withAttachmentHeader('Word', filename, 'mammoth', result.value || ''), parser: 'mammoth' };
}

async function extractLegacyDocWithWordExtractor(filename, buffer, options = {}) {
  if (!WordExtractor) throw new Error('word-extractor 未安装');
  const extractor = new WordExtractor();
  const document = await raceWithSignal(extractor.extract(buffer), options.signal);
  const text = [document.getBody?.(), document.getFootnotes?.(), document.getHeaders?.(), document.getAnnotations?.()]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join('\n\n');
  return {
    text: withAttachmentHeader('Word', filename, 'word-extractor', text, '解析说明：以下为使用 word-extractor 从老版 .doc 文件中提取到的正文；格式可能不完整，请基于正文内容回答用户问题。'),
    parser: 'word-extractor',
  };
}

async function extractExcelText(filename, dataUrl, options = {}) {
  const buffer = dataUrlToBuffer(dataUrl);
  throwIfAborted(options.signal);
  await assertOfficeArchiveSafe(buffer, filename);
  return {
    text: withAttachmentHeader('Excel', filename, 'officeparser', await parseOfficeWithOfficeParser(buffer, filename, options), '解析说明：以下为使用 officeparser 提取到的工作簿文本；中文、日期和公式显示值会尽量保留。'),
    parser: 'officeparser',
  };
}

async function extractPowerPointText(filename, dataUrl, options = {}) {
  const buffer = dataUrlToBuffer(dataUrl);
  await assertOfficeArchiveSafe(buffer, filename);
  return {
    text: withAttachmentHeader('PowerPoint', filename, 'officeparser', await parseOfficeWithOfficeParser(buffer, filename, options)),
    parser: 'officeparser',
  };
}

async function extractWordText(filename, dataUrl, options = {}) {
  const buffer = dataUrlToBuffer(dataUrl);
  await assertOfficeArchiveSafe(buffer, filename);
  if (/\.doc$/i.test(filename || '') && !/\.docx$/i.test(filename || '')) {
    try { return await extractLegacyDocWithWordExtractor(filename, buffer, options); }
    catch (err) {
      throwIfAborted(options.signal);
      return {
        text: withAttachmentHeader('Word', filename, 'officeparser', await parseOfficeWithOfficeParser(buffer, filename, options)),
        parser: 'officeparser',
      };
    }
  }
  try { return await extractDocxWithMammoth(filename, buffer, options); }
  catch (err) {
    throwIfAborted(options.signal);
    return {
      text: withAttachmentHeader('Word', filename, 'officeparser', await parseOfficeWithOfficeParser(buffer, filename, options)),
      parser: 'officeparser',
    };
  }
}

module.exports = { parseOfficeWithOfficeParser, extractDocxWithMammoth, extractLegacyDocWithWordExtractor, extractExcelText, extractPowerPointText, extractWordText };
