#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const ROOT_WITH_SEP = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
const pkg = require('./package.json');
const APP_VERSION = String(pkg.version || '0.0.0');
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 50 * 1024 * 1024);
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || DEFAULT_UPSTREAM_TIMEOUT_MS);
const ALLOWED_PROXY_METHODS = new Set(['GET', 'POST']);
const ALLOWED_PROXY_PATHS = [/^\/models\/?$/, /^\/chat\/completions\/?$/, /^\/images\/(generations|edits)\/?$/];
const imageJobs = new Map();
const chatJobs = new Map();
const jobSubscribers = new Map();
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function optionalRequire(name) {
  try { return require(name); } catch { return null; }
}

const mammothLib = optionalRequire('mammoth');
const officeParserLib = optionalRequire('officeparser');
const pdfParseLib = optionalRequire('pdf-parse');

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('请求体过大'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('请求体不是有效 JSON');
    err.statusCode = 400;
    throw err;
  }
}

function escapeXmlText(text = '') {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function decodeOpenXmlText(xml = '') {
  return escapeXmlText(String(xml || '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ''));
}

function zipEntriesFromBuffer(buffer) {
  const entries = new Map();
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 70000); i--) {
    if (buffer.readUInt32LE(i) === eocdSig) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 Office Open XML 文件');
  const total = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  let offset = centralOffset;
  for (let i = 0; i < total; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLen).toString('utf8');
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    entries.set(name, { method, compressedSize, uncompressedSize, dataStart });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function inflateZipEntry(buffer, entry) {
  const zlib = require('zlib');
  const compressed = buffer.slice(entry.dataStart, entry.dataStart + entry.compressedSize);
  if (entry.method === 0) return compressed.toString('utf8');
  if (entry.method === 8) return zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(entry.uncompressedSize * 2, 1024 * 1024) }).toString('utf8');
  throw new Error(`不支持的压缩方式：${entry.method}`);
}

function getZipText(buffer, entries, name) {
  const entry = entries.get(name);
  if (!entry) return '';
  return inflateZipEntry(buffer, entry);
}

function parseWorkbookSheets(xml = '') {
  const sheets = [];
  const re = /<sheet\b([^>]*?)\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1] || '';
    const name = attrs.match(/name="([^"]*)"/)?.[1] || `Sheet${sheets.length + 1}`;
    const id = attrs.match(/r:id="([^"]*)"/)?.[1] || '';
    sheets.push({ name: escapeXmlText(name), id });
  }
  return sheets;
}

function parseWorkbookRels(xml = '') {
  const rels = new Map();
  const re = /<Relationship\b([^>]*?)\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1] || '';
    const id = attrs.match(/Id="([^"]*)"/)?.[1] || '';
    let target = attrs.match(/Target="([^"]*)"/)?.[1] || '';
    if (id && target) {
      if (!target.startsWith('xl/')) target = `xl/${target.replace(/^\.\//, '')}`;
      rels.set(id, target);
    }
  }
  return rels;
}

function parseSharedStrings(xml = '') {
  const result = [];
  const siRe = /<si\b[\s\S]*?<\/si>/g;
  const textRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let si;
  while ((si = siRe.exec(xml))) {
    const parts = [];
    let t;
    while ((t = textRe.exec(si[0]))) parts.push(escapeXmlText(t[1] || ''));
    result.push(parts.join(''));
  }
  return result;
}

function columnIndexFromCell(ref = '') {
  const letters = String(ref).match(/[A-Z]+/i)?.[0]?.toUpperCase() || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

function cellValue(cellXml, sharedStrings) {
  const type = cellXml.match(/\bt="([^"]+)"/)?.[1] || '';
  if (type === 'inlineStr') return decodeOpenXmlText(cellXml.match(/<is>([\s\S]*?)<\/is>/)?.[1] || '');
  const value = cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] || '';
  if (!value) return '';
  if (type === 's') return sharedStrings[Number(value)] || '';
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE';
  return escapeXmlText(value);
}

function parseWorksheetPreview(xml = '', sharedStrings = [], maxRows = 80, maxCols = 40) {
  const rows = [];
  const rowRe = /<row\b[\s\S]*?<\/row>/g;
  const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
  let row;
  while ((row = rowRe.exec(xml)) && rows.length < maxRows) {
    const values = [];
    let cell;
    while ((cell = cellRe.exec(row[0]))) {
      const ref = cell[1].match(/r="([^"]+)"/)?.[1] || '';
      const col = Math.min(columnIndexFromCell(ref), maxCols);
      const value = cellValue(`<c ${cell[1]}>${cell[2]}</c>`, sharedStrings);
      if (value) values[col - 1] = value;
    }
    const trimmed = values.slice(0, maxCols).map(v => String(v || '').replace(/\s+/g, ' ').trim());
    if (trimmed.some(Boolean)) rows.push(trimmed);
  }
  return rows;
}

function rowsToMarkdown(rows) {
  if (!rows.length) return '_空表或未读取到可见文本_';
  const width = Math.min(Math.max(...rows.map(r => r.length)), 12);
  const norm = rows.map(r => Array.from({ length: width }, (_, i) => String(r[i] || '').replace(/\|/g, '\\|')));
  const header = norm[0];
  const body = norm.slice(1);
  return ['| ' + header.join(' | ') + ' |', '| ' + header.map(() => '---').join(' | ') + ' |', ...body.map(r => '| ' + r.join(' | ') + ' |')].join('\n');
}

function dataUrlToBuffer(dataUrl = '') {
  const base64 = String(dataUrl || '').includes(',') ? String(dataUrl).split(',')[1] : String(dataUrl || '');
  return Buffer.from(base64, 'base64');
}

function limitExtractedText(text = '', limit = 120000) {
  const clean = String(text || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}\n\n[内容过长，已截断到前 ${limit} 字符]` : clean;
}

function withAttachmentHeader(kind, filename, parser, text, note = '') {
  const intro = note || `解析说明：以下为使用 ${parser} 提取到的正文；请基于这些内容回答用户问题。`;
  return [`# ${kind} 附件：${filename}`, intro, limitExtractedText(text)].join('\n\n').slice(0, 125000);
}

function writeTempBuffer(buffer, filename) {
  const ext = path.extname(filename || '') || '.bin';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-extract-'));
  const file = path.join(dir, `attachment${ext}`);
  fs.writeFileSync(file, buffer);
  return { dir, file };
}

function cleanupTempDir(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function execFileText(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30000, maxBuffer: 20 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

async function commandExists(command) {
  try {
    await execFileText('sh', ['-c', `command -v ${command}`], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

function meaningfulExtractedText(text = '') {
  const clean = String(text || '')
    .replace(/^# .*附件：.*$/gm, '')
    .replace(/^解析说明：.*$/gm, '')
    .replace(/\[[^\]]*截断[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cjk = (clean.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (clean.match(/[A-Za-z0-9]/g) || []).length;
  return { clean, score: cjk * 2 + latin, cjk, latin };
}

function hasUsefulText(text = '', minScore = 80) {
  return meaningfulExtractedText(text).score >= minScore;
}

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

function extractXlsxText(filename, dataUrl, inputBuffer = null) {
  const buffer = inputBuffer || dataUrlToBuffer(dataUrl);
  const entries = zipEntriesFromBuffer(buffer);
  const workbook = getZipText(buffer, entries, 'xl/workbook.xml');
  const relXml = getZipText(buffer, entries, 'xl/_rels/workbook.xml.rels');
  const shared = parseSharedStrings(getZipText(buffer, entries, 'xl/sharedStrings.xml'));
  const rels = parseWorkbookRels(relXml);
  const sheets = parseWorkbookSheets(workbook).slice(0, 8);
  const chunks = [`# Excel 附件：${filename}`, `解析说明：以下为每个工作表前 80 行、前 40 列的文本预览；请基于这些内容回答用户问题。`];
  for (const sheet of sheets) {
    const target = rels.get(sheet.id) || `xl/worksheets/sheet${chunks.length - 1}.xml`;
    const xml = getZipText(buffer, entries, target);
    if (!xml) continue;
    const rows = parseWorksheetPreview(xml, shared);
    chunks.push(`\n## 工作表：${sheet.name}\n${rowsToMarkdown(rows)}`);
  }
  return chunks.join('\n\n').slice(0, 120000);
}

async function extractExcelText(filename, dataUrl) {
  const buffer = dataUrlToBuffer(dataUrl);
  try { return withAttachmentHeader('Excel', filename, 'officeparser', await parseOfficeWithOfficeParser(buffer, filename), '解析说明：以下为使用 officeparser 提取到的工作簿文本；中文、日期和公式显示值会尽量保留。'); }
  catch (primaryErr) {
    try { return extractXlsxText(filename, dataUrl, buffer); }
    catch { throw primaryErr; }
  }
}

function slideNumberFromName(name = '') {
  return Number(String(name).match(/slide(\d+)\.xml$/)?.[1] || 0);
}

function extractPptxText(filename, dataUrl, inputBuffer = null) {
  const buffer = inputBuffer || dataUrlToBuffer(dataUrl);
  const entries = zipEntriesFromBuffer(buffer);
  const slideNames = [...entries.keys()]
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => slideNumberFromName(a) - slideNumberFromName(b))
    .slice(0, 80);
  const chunks = [`# PowerPoint 附件：${filename}`, '解析说明：以下为每页幻灯片提取到的文本；请基于这些内容回答用户问题。'];
  for (const name of slideNames) {
    const xml = getZipText(buffer, entries, name);
    const texts = [];
    const re = /<a:t>([\s\S]*?)<\/a:t>/g;
    let m;
    while ((m = re.exec(xml))) texts.push(escapeXmlText(m[1] || '').trim());
    const content = texts.filter(Boolean).join('\n').trim();
    if (content) chunks.push(`\n## 幻灯片 ${slideNumberFromName(name)}\n${content}`);
  }
  return chunks.join('\n\n').slice(0, 120000);
}

async function extractPowerPointText(filename, dataUrl) {
  const buffer = dataUrlToBuffer(dataUrl);
  try { return withAttachmentHeader('PowerPoint', filename, 'officeparser', await parseOfficeWithOfficeParser(buffer, filename)); }
  catch {
    return extractPptxText(filename, dataUrl, buffer);
  }
}

function extractDocxText(filename, dataUrl, inputBuffer = null) {
  const buffer = inputBuffer || dataUrlToBuffer(dataUrl);
  const entries = zipEntriesFromBuffer(buffer);
  const xml = getZipText(buffer, entries, 'word/document.xml');
  const paragraphs = [];
  const pRe = /<w:p\b[\s\S]*?<\/w:p>/g;
  const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let p;
  while ((p = pRe.exec(xml)) && paragraphs.length < 2000) {
    const parts = [];
    let t;
    while ((t = tRe.exec(p[0]))) parts.push(escapeXmlText(t[1] || ''));
    const text = parts.join('').trim();
    if (text) paragraphs.push(text);
  }
  return [`# Word 附件：${filename}`, '解析说明：以下为文档正文提取文本；请基于这些内容回答用户问题。', paragraphs.join('\n')].join('\n\n').slice(0, 120000);
}

async function extractWordText(filename, dataUrl) {
  const buffer = dataUrlToBuffer(dataUrl);
  try { return await extractDocxWithMammoth(filename, buffer); }
  catch {
    try { return withAttachmentHeader('Word', filename, 'officeparser', await parseOfficeWithOfficeParser(buffer, filename)); }
    catch { return extractDocxText(filename, dataUrl, buffer); }
  }
}

function decodePdfLiteralString(value = '') {
  return String(value || '')
    .replace(/\\([nrtbf()\\])/g, (_, ch) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[ch] || ch))
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodePdfHexString(hex = '') {
  const clean = String(hex || '').replace(/\s+/g, '');
  const bytes = [];
  for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2).padEnd(2, '0'), 16));
  const buf = Buffer.from(bytes.filter(n => Number.isFinite(n)));
  if (buf.length >= 2 && ((buf[0] === 0xfe && buf[1] === 0xff) || (buf[0] === 0xff && buf[1] === 0xfe))) {
    const be = buf[0] === 0xfe;
    const chars = [];
    for (let i = 2; i + 1 < buf.length; i += 2) chars.push(String.fromCharCode(be ? (buf[i] << 8) + buf[i + 1] : (buf[i + 1] << 8) + buf[i]));
    return chars.join('').replace(/\s+/g, ' ').trim();
  }
  return buf.toString('utf8').replace(/\s+/g, ' ').trim();
}

function decodePdfUnicodeHex(hex = '') {
  const clean = String(hex || '').replace(/\s+/g, '');
  const bytes = [];
  for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2).padEnd(2, '0'), 16));
  const buf = Buffer.from(bytes.filter(n => Number.isFinite(n)));
  const start = buf.length >= 2 && ((buf[0] === 0xfe && buf[1] === 0xff) || (buf[0] === 0xff && buf[1] === 0xfe)) ? 2 : 0;
  const be = !(buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe);
  if (buf.length - start >= 2 && (buf.length - start) % 2 === 0) {
    const chars = [];
    for (let i = start; i + 1 < buf.length; i += 2) chars.push(String.fromCharCode(be ? (buf[i] << 8) + buf[i + 1] : (buf[i + 1] << 8) + buf[i]));
    return chars.join('').replace(/\s+/g, ' ').trim();
  }
  return buf.toString('utf8').replace(/\s+/g, ' ').trim();
}

function parsePdfObjects(latin = '') {
  const objects = new Map();
  const re = /(\d+)\s+\d+\s+obj\b([\s\S]*?)endobj/g;
  let m;
  while ((m = re.exec(latin))) objects.set(m[1], m[2]);
  return objects;
}

function parsePdfToUnicodeMap(cmap = '') {
  const map = new Map();
  const oneRe = /beginbfchar([\s\S]*?)endbfchar/g;
  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  let block;
  while ((block = oneRe.exec(cmap))) {
    const pairRe = /<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g;
    let p;
    while ((p = pairRe.exec(block[1]))) map.set(p[1].toUpperCase(), decodePdfUnicodeHex(p[2]));
  }
  while ((block = rangeRe.exec(cmap))) {
    const lineRe = /<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+(?:<([0-9A-Fa-f]+)>|\[([^\]]+)\])/g;
    let r;
    while ((r = lineRe.exec(block[1]))) {
      const start = parseInt(r[1], 16);
      const end = parseInt(r[2], 16);
      if (r[3]) {
        const base = parseInt(r[3], 16);
        const width = r[3].length;
        for (let code = start; code <= end && code - start < 512; code++) {
          const key = code.toString(16).toUpperCase().padStart(r[1].length, '0');
          const val = (base + code - start).toString(16).toUpperCase().padStart(width, '0');
          map.set(key, decodePdfUnicodeHex(val));
        }
      } else if (r[4]) {
        const vals = [...r[4].matchAll(/<([0-9A-Fa-f]+)>/g)].map(m => m[1]);
        vals.forEach((val, i) => map.set((start + i).toString(16).toUpperCase().padStart(r[1].length, '0'), decodePdfUnicodeHex(val)));
      }
    }
  }
  return map;
}

function buildPdfUnicodeMaps(latin = '') {
  const objects = parsePdfObjects(latin);
  const maps = [];
  for (const [id, obj] of objects.entries()) {
    const stream = obj.match(/stream\r?\n([\s\S]*?)\r?\nendstream/)?.[1] || obj;
    let text = stream;
    if (/FlateDecode/.test(obj)) {
      try { text = require('zlib').inflateSync(Buffer.from(stream, 'latin1')).toString('latin1'); } catch {}
    }
    if (!/beginbfchar|beginbfrange/.test(text)) continue;
    const map = parsePdfToUnicodeMap(text);
    if (map.size) maps.push({ id, map });
  }
  return maps;
}

function decodePdfHexWithMaps(hex = '', maps = []) {
  const clean = String(hex || '').replace(/\s+/g, '').toUpperCase();
  for (const { map } of maps) {
    let out = '';
    let ok = 0;
    for (let i = 0; i < clean.length;) {
      let hit = '';
      let hitLen = 0;
      for (const len of [8, 6, 4, 2]) {
        const key = clean.slice(i, i + len);
        if (key && map.has(key)) { hit = map.get(key); hitLen = len; break; }
      }
      if (hitLen) { out += hit; ok++; i += hitLen; }
      else { i += 2; }
    }
    if (ok && out.trim()) return out.replace(/\s+/g, ' ').trim();
  }
  return decodePdfHexString(clean);
}

function extractPdfTextFromStream(stream = '', unicodeMaps = []) {
  const chunks = [];
  const literalRe = /\((?:\\.|[^\\()])*\)\s*Tj/g;
  const arrayRe = /\[((?:\s*(?:\((?:\\.|[^\\()])*\)|<[^>]+>|-?\d+(?:\.\d+)?))+\s*)\]\s*TJ/g;
  const hexRe = /<([0-9a-fA-F\s]+)>\s*Tj/g;
  let m;
  while ((m = literalRe.exec(stream))) chunks.push(decodePdfLiteralString(m[0].replace(/\s*Tj$/, '').slice(1, -1)));
  while ((m = hexRe.exec(stream))) chunks.push(decodePdfHexWithMaps(m[1], unicodeMaps));
  while ((m = arrayRe.exec(stream))) {
    const arr = m[1] || '';
    const parts = [];
    const tokenRe = /\((?:\\.|[^\\()])*\)|<([0-9a-fA-F\s]+)>/g;
    let t;
    while ((t = tokenRe.exec(arr))) {
      if (t[0].startsWith('(')) parts.push(decodePdfLiteralString(t[0].slice(1, -1)));
      else parts.push(decodePdfHexWithMaps(t[1] || '', unicodeMaps));
    }
    if (parts.length) chunks.push(parts.join(''));
  }
  return chunks.filter(Boolean).join('\n');
}

async function extractPdfWithPdftotext(filename, buffer) {
  const { dir, file } = writeTempBuffer(buffer, filename);
  try {
    const text = await execFileText('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-']);
    if (!text.trim()) throw new Error('pdftotext 未提取到文本');
    return withAttachmentHeader('PDF', filename, 'Poppler/pdftotext', text, '解析说明：以下为使用 Poppler/pdftotext 提取到的 PDF 正文；对中文字体映射支持更稳定。');
  } finally {
    cleanupTempDir(dir);
  }
}

async function extractPdfWithPdfParse(filename, buffer) {
  if (!pdfParseLib?.PDFParse) throw new Error('pdf-parse 未安装');
  const parser = new pdfParseLib.PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    if (!String(result?.text || '').trim()) throw new Error('pdf-parse 未提取到文本');
    return withAttachmentHeader('PDF', filename, 'pdf-parse/pdf.js', result.text, '解析说明：以下为使用 pdf.js 提取到的 PDF 正文；对部分中文字体映射有支持。');
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractPdfWithOcr(filename, buffer) {
  const hasPdftoppm = await commandExists('pdftoppm');
  const hasTesseract = await commandExists('tesseract');
  if (!hasPdftoppm || !hasTesseract) {
    throw new Error('OCR 依赖不可用：需要 pdftoppm 和 tesseract');
  }
  const { dir, file } = writeTempBuffer(buffer, filename);
  try {
    const prefix = path.join(dir, 'page');
    await execFileText('pdftoppm', ['-r', '220', '-png', '-f', '1', '-l', '20', file, prefix], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
    const pages = fs.readdirSync(dir)
      .filter(name => /^page-\d+\.png$/i.test(name))
      .sort((a, b) => Number(a.match(/\d+/)?.[0] || 0) - Number(b.match(/\d+/)?.[0] || 0));
    if (!pages.length) throw new Error('PDF 未能转换为页面图片');
    const chunks = [];
    for (const page of pages) {
      const imagePath = path.join(dir, page);
      const pageNo = Number(page.match(/\d+/)?.[0] || chunks.length + 1);
      try {
        const text = await execFileText('tesseract', [imagePath, 'stdout', '-l', 'chi_sim+eng', '--psm', '6'], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
        const clean = limitExtractedText(text, 20000);
        if (clean) chunks.push(`## 第 ${pageNo} 页\n${clean}`);
      } catch (err) {
        chunks.push(`## 第 ${pageNo} 页\n[OCR 失败：${err.message || String(err)}]`);
      }
    }
    const text = chunks.join('\n\n').trim();
    if (!text || !hasUsefulText(text, 20)) throw new Error('OCR 未提取到可用文本');
    return withAttachmentHeader('PDF', filename, 'Tesseract OCR chi_sim+eng', text, '解析说明：该 PDF 可能是扫描件/图片型 PDF，以下为先将页面转图片后使用 Tesseract OCR（简体中文+英文）识别到的文本。');
  } finally {
    cleanupTempDir(dir);
  }
}

function extractPdfTextBasic(filename, dataUrl, inputBuffer = null) {
  const zlib = require('zlib');
  const buffer = inputBuffer || dataUrlToBuffer(dataUrl);
  const latin = buffer.toString('latin1');
  const unicodeMaps = buildPdfUnicodeMaps(latin);
  const chunks = [`# PDF 附件：${filename}`, '解析说明：以下为从 PDF 文本流中提取到的正文；扫描件或复杂编码 PDF 可能只能提取部分内容。'];
  let extracted = '';
  const streamRe = /<<(.*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = streamRe.exec(latin))) {
    let data = Buffer.from(m[2], 'latin1');
    const dict = m[1] || '';
    try {
      if (/FlateDecode/.test(dict)) data = zlib.inflateSync(data);
      const text = extractPdfTextFromStream(data.toString('latin1'), unicodeMaps) || extractPdfTextFromStream(data.toString('utf8'), unicodeMaps);
      if (text) extracted += `\n${text}`;
    } catch {}
    if (extracted.length > 120000) break;
  }
  if (!extracted.trim()) {
    extracted = '未能从该 PDF 中提取到可用文本。它可能是扫描件、图片型 PDF，或使用了复杂字体编码；请使用 OCR 或导出为文本后再上传。';
  }
  chunks.push(extracted.trim());
  return chunks.join('\n\n').slice(0, 120000);
}

async function extractPdfText(filename, dataUrl) {
  const buffer = dataUrlToBuffer(dataUrl);
  const attempts = [];
  try {
    const text = await extractPdfWithPdftotext(filename, buffer);
    if (hasUsefulText(text)) return text;
    attempts.push(text);
  } catch {}
  try {
    const text = await extractPdfWithPdfParse(filename, buffer);
    if (hasUsefulText(text)) return text;
    attempts.push(text);
  } catch {}
  const basic = extractPdfTextBasic(filename, dataUrl, buffer);
  if (hasUsefulText(basic)) return basic;
  attempts.push(basic);
  try { return await extractPdfWithOcr(filename, buffer); }
  catch (err) {
    const fallback = attempts.find(Boolean) || basic;
    if (fallback && meaningfulExtractedText(fallback).clean) {
      return `${fallback}\n\n[OCR 未执行成功：${err.message || String(err)}]`;
    }
    return withAttachmentHeader('PDF', filename, 'PDF/OCR fallback', `未能从该 PDF 中提取到可用文本。它可能是扫描件/图片型 PDF；OCR 未执行成功：${err.message || String(err)}。请确认 Docker 镜像已安装 poppler-utils、tesseract-ocr、tesseract-ocr-data-chi_sim 和 tesseract-ocr-data-eng。`);
  }
}

async function extractFileText(req, res) {
  try {
    const body = parseJson(await readBody(req));
    const filename = String(body.filename || 'attachment').trim();
    const dataUrl = String(body.dataUrl || '');
    if (!dataUrl) return sendJson(res, 400, { error: { message: '缺少文件内容' } });
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

function normalizeReasoningText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(item => normalizeReasoningText(item?.text || item?.content || item?.summary || item?.reasoning || item?.thinking || item)).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    return normalizeReasoningText(value.text || value.content || value.summary || value.reasoning || value.thinking || value.reasoning_content || value.thinking_content || value.reasoning_details || value.output_text || '');
  }
  return String(value || '');
}

function safeJoin(root, urlPath) {
  try {
    const cleanPath = decodeURIComponent(urlPath.split('?')[0]);
    const filePath = path.normalize(path.join(root, cleanPath === '/' ? 'index.html' : cleanPath));
    if (filePath !== root && !filePath.startsWith(ROOT_WITH_SEP)) return null;
    return filePath;
  } catch {
    return null;
  }
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.pathname = url.pathname.replace(/\/$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

async function proxy(req, res) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let proxyChatJob = null;
  try {
    const targetPath = req.url.replace(/^\/api/, '').split('?')[0];
    if (!ALLOWED_PROXY_PATHS.some(re => re.test(targetPath))) {
      return sendJson(res, 403, { error: { message: '不允许代理该路径' } });
    }

    const body = parseJson(await readBody(req));
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const apiKey = String(body.apiKey || '').trim();
    const payload = body.payload || {};
    const method = String(body.method || 'POST').toUpperCase();
    const proxyJobId = String(body.jobId || '').trim();

    if (!baseUrl) return sendJson(res, 400, { error: { message: '缺少或非法 baseUrl' } });
    if (!ALLOWED_PROXY_METHODS.has(method)) return sendJson(res, 405, { error: { message: '不支持的代理方法' } });

    const targetUrl = `${baseUrl}${targetPath}`;
    const wantsStream = method !== 'GET' && payload && payload.stream === true;
    if (targetPath === '/chat/completions' && proxyJobId && wantsStream) {
      proxyChatJob = chatJobs.get(proxyJobId) || makeChatJob(proxyJobId, baseUrl, apiKey, payload, { stream: true });
      if (proxyChatJob.streamStarted) proxyChatJob = null;
      else {
        proxyChatJob.updatedAt = Date.now();
        proxyChatJob.streamStarted = true;
        chatJobs.set(proxyJobId, proxyChatJob);
        notifyJob(proxyChatJob);
      }
    }
    const upstream = await fetch(targetUrl, {
      method,
      signal: controller.signal,
      headers: {
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
        ...(wantsStream ? { Accept: 'text/event-stream' } : {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(payload) }),
    });

    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    const isEventStream = contentType.toLowerCase().includes('text/event-stream');

    if (wantsStream || isEventStream) {
      const chatJob = proxyChatJob;
      if (!chatJob && targetPath === '/chat/completions' && proxyJobId) {
        // 已有后台流式 job 接管时，当前页面直接通过 SSE 恢复，避免重复请求/重复输出。
        return sendJson(res, 409, { error: { message: '任务已在后台继续，请等待恢复连接' } }, { 'Access-Control-Allow-Origin': '*' });
      }
      res.writeHead(upstream.status, {
        ...SECURITY_HEADERS,
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      if (!upstream.body) return res.end();
      let clientOpen = true;
      res.on('close', () => { clientOpen = false; });
      for await (const chunk of upstream.body) {
        const buf = Buffer.from(chunk);
        if (chatJob) updateChatJobFromStreamChunk(chatJob, buf.toString('utf8'));
        if (clientOpen && !res.destroyed) {
          try { res.write(buf); } catch { clientOpen = false; }
        }
      }
      if (chatJob) {
        chatJob.status = 'done';
        chatJob.updatedAt = Date.now();
        delete chatJob.buffer;
        notifyJob(chatJob);
      }
      if (clientOpen && !res.destroyed) res.end();
      return;
    }

    const text = await upstream.text();
    send(res, upstream.status, text, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    const message = aborted ? '上游请求超时' : `连接上游接口失败：${err.message || String(err)}`;
    if (proxyChatJob) {
      proxyChatJob.status = 'error';
      proxyChatJob.error = message;
      proxyChatJob.updatedAt = Date.now();
      notifyJob(proxyChatJob);
    }
    if (!res.headersSent && !res.destroyed) {
      sendJson(res, err.statusCode || (aborted ? 504 : 502), { error: { message } });
    } else if (!res.destroyed) {
      res.end();
    }
  } finally {
    clearTimeout(timer);
  }
}

async function proxyImage(req, res) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const body = parseJson(await readBody(req));
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const apiKey = String(body.apiKey || '').trim();
    const imageUrl = new URL(String(body.url || '').trim());
    const base = new URL(baseUrl);

    if (!baseUrl) return sendJson(res, 400, { error: { message: '缺少或非法 baseUrl' } });
    if (!['http:', 'https:'].includes(imageUrl.protocol)) return sendJson(res, 400, { error: { message: '非法图片地址' } });
    if (imageUrl.origin !== base.origin) return sendJson(res, 403, { error: { message: '只允许代理同源图片地址' } });

    const upstream = await fetch(imageUrl.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok) {
      const text = await upstream.text();
      return sendJson(res, upstream.status, { error: { message: text || '图片下载失败' } });
    }
    if (!contentType.startsWith('image/')) {
      return sendJson(res, 415, { error: { message: '上游返回的不是图片' } });
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    send(res, 200, buffer, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    sendJson(res, err.statusCode || (aborted ? 504 : 500), {
      error: { message: aborted ? '图片下载超时' : (err.message || String(err)) },
    });
  } finally {
    clearTimeout(timer);
  }
}

function makeJobId(value = '') {
  const supplied = String(value || '').trim();
  if (/^(imgjob|chatjob)-[a-z0-9-]{8,80}$/i.test(supplied)) return supplied;
  return `imgjob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}


function makeChatJob(jobId, baseUrl, apiKey, payload, { stream = true } = {}) {
  return {
    id: jobId,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    targetUrl: `${baseUrl}/chat/completions`,
    apiKey,
    payload: stream ? { ...payload, stream: true } : { ...payload, stream: false },
    data: { choices: [{ message: { content: '', reasoning_content: '' } }] },
    error: '',
    buffer: '',
    streamStarted: false,
  };
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    data: job.data || null,
    error: job.error ? { message: job.error } : null,
  };
}

function notifyJob(job) {
  const subscribers = jobSubscribers.get(job.id);
  if (!subscribers) return;
  const data = `event: update\ndata: ${JSON.stringify(publicJob(job))}\n\n`;
  for (const res of subscribers) res.write(data);
  if (job.status === 'done' || job.status === 'error') {
    for (const res of subscribers) res.end();
    jobSubscribers.delete(job.id);
  }
}

function subscribeJob(req, res, store) {
  const id = getJobIdFromUrl(req);
  const job = store.get(id);
  if (!job) return sendJson(res, 404, { error: { message: '任务不存在或服务已重启' } });
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`event: update\ndata: ${JSON.stringify(publicJob(job))}\n\n`);
  if (job.status === 'done' || job.status === 'error') return res.end();
  if (!jobSubscribers.has(id)) jobSubscribers.set(id, new Set());
  jobSubscribers.get(id).add(res);
  req.on('close', () => {
    const set = jobSubscribers.get(id);
    if (!set) return;
    set.delete(res);
    if (!set.size) jobSubscribers.delete(id);
  });
}

async function runImageJob(job) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(job.targetUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(job.apiKey ? { Authorization: `Bearer ${job.apiKey}` } : {}),
      },
      body: JSON.stringify(job.payload),
    });
    const text = await upstream.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!upstream.ok) throw new Error(data?.error?.message || data?.message || data?.raw || text || `上游返回 ${upstream.status}`);
    job.status = 'done';
    job.data = data;
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    job.status = 'error';
    job.error = aborted ? '上游请求超时' : `连接上游接口失败：${err.message || String(err)}`;
  } finally {
    clearTimeout(timer);
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
    const job = {
      id: jobId,
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      targetUrl: `${baseUrl}/images/generations`,
      apiKey,
      payload,
      data: null,
      error: '',
    };
    imageJobs.set(job.id, job);
    runImageJob(job);
    sendJson(res, 202, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
  } catch (err) {
    sendJson(res, err.statusCode || 500, { error: { message: err.message || String(err) } });
  }
}

function getJobIdFromUrl(req) {
  return decodeURIComponent(req.url.split('?')[0].split('/').filter(Boolean).at(-1) === 'events'
    ? req.url.split('?')[0].split('/').filter(Boolean).at(-2) || ''
    : req.url.split('?')[0].split('/').filter(Boolean).at(-1) || '');
}

function getImageJob(req, res) {
  const id = getJobIdFromUrl(req);
  const job = imageJobs.get(id);
  if (!job) return sendJson(res, 404, { error: { message: '任务不存在或服务已重启' } });
  sendJson(res, 200, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
}

async function runChatJob(job) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(job.targetUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(job.apiKey ? { Authorization: `Bearer ${job.apiKey}` } : {}),
      },
      body: JSON.stringify(job.payload),
    });
    const text = await upstream.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!upstream.ok) throw new Error(data?.error?.message || data?.message || data?.raw || text || `上游返回 ${upstream.status}`);
    job.status = 'done';
    job.data = data;
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    job.status = 'error';
    job.error = aborted ? '上游请求超时' : `连接上游接口失败：${err.message || String(err)}`;
  } finally {
    clearTimeout(timer);
    job.updatedAt = Date.now();
    notifyJob(job);
  }
}

async function runChatStreamJob(job) {
  if (job.streamStarted) return;
  job.streamStarted = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(job.targetUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(job.apiKey ? { Authorization: `Bearer ${job.apiKey}` } : {}),
      },
      body: JSON.stringify({ ...job.payload, stream: true }),
    });
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok) {
      const text = await upstream.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      throw new Error(data?.error?.message || data?.message || data?.raw || text || `上游返回 ${upstream.status}`);
    }
    if (!upstream.body) throw new Error('上游没有返回流式响应体');
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      const text = await upstream.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      const content = data?.choices?.[0]?.message?.content || data?.output_text || data?.raw || '';
      const msg = data?.choices?.[0]?.message || {};
      const outputReasoning = Array.isArray(data?.output) ? data.output.filter(item => /reason/i.test(String(item?.type || item?.role || '')) || item?.summary || item?.reasoning || item?.thinking) : '';
      const reasoning = normalizeReasoningText(msg.reasoning_content || msg.reasoning || msg.thinking || msg.reasoning_details || msg.thinking_content || data?.reasoning_content || data?.reasoning || data?.thinking || data?.reasoning_details || data?.thinking_content || outputReasoning || '');
      job.data = { choices: [{ message: { content, reasoning_content: reasoning } }] };
    } else {
      for await (const chunk of upstream.body) {
        updateChatJobFromStreamChunk(job, Buffer.from(chunk).toString('utf8'));
      }
    }
    job.status = 'done';
    delete job.buffer;
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    job.status = 'error';
    job.error = aborted ? '上游请求超时' : `连接上游接口失败：${err.message || String(err)}`;
  } finally {
    clearTimeout(timer);
    job.updatedAt = Date.now();
    notifyJob(job);
  }
}

async function registerChatStreamJob(req, res) {
  try {
    const body = parseJson(await readBody(req));
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const apiKey = String(body.apiKey || '').trim();
    const payload = body.payload || {};
    if (!baseUrl) return sendJson(res, 400, { error: { message: '缺少或非法 baseUrl' } });
    const jobId = makeJobId(body.jobId).replace(/^imgjob-/, 'chatjob-');
    let job = chatJobs.get(jobId);
    if (!job) {
      job = makeChatJob(jobId, baseUrl, apiKey, payload, { stream: true });
      chatJobs.set(jobId, job);
    }
    if (body.start === true && !job.streamStarted && job.status === 'running') runChatStreamJob(job);
    sendJson(res, 202, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
  } catch (err) {
    sendJson(res, err.statusCode || 500, { error: { message: err.message || String(err) } });
  }
}

async function startChatJob(req, res) {
  try {
    const body = parseJson(await readBody(req));
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    const apiKey = String(body.apiKey || '').trim();
    const payload = body.payload || {};
    if (!baseUrl) return sendJson(res, 400, { error: { message: '缺少或非法 baseUrl' } });
    const jobId = makeJobId(body.jobId).replace(/^imgjob-/, 'chatjob-');
    if (chatJobs.has(jobId)) return sendJson(res, 200, publicJob(chatJobs.get(jobId)), { 'Access-Control-Allow-Origin': '*' });
    const job = {
      id: jobId,
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      targetUrl: `${baseUrl}/chat/completions`,
      apiKey,
      payload: { ...payload, stream: false },
      data: null,
      error: '',
    };
    chatJobs.set(job.id, job);
    runChatJob(job);
    sendJson(res, 202, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
  } catch (err) {
    sendJson(res, err.statusCode || 500, { error: { message: err.message || String(err) } });
  }
}

function getChatJob(req, res) {
  const id = getJobIdFromUrl(req);
  const job = chatJobs.get(id);
  if (!job) return sendJson(res, 404, { error: { message: '任务不存在或服务已重启' } });
  sendJson(res, 200, publicJob(job), { 'Access-Control-Allow-Origin': '*' });
}

function updateChatJobFromStreamChunk(job, text) {
  job.buffer = (job.buffer || '') + text;
  const lines = job.buffer.split(/\r?\n/);
  job.buffer = lines.pop() || '';
  const message = job.data.choices[0].message;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const dataText = trimmed.slice(5).trim();
    if (!dataText || dataText === '[DONE]') continue;
    try {
      const data = JSON.parse(dataText);
      const delta = data?.choices?.[0]?.delta || data?.choices?.[0]?.message || {};
      const content = delta.content || (typeof data?.content === 'string' ? data.content : '');
      const reasoning = normalizeReasoningText(delta.reasoning_content || delta.reasoning || delta.thinking || delta.reasoning_details || delta.thinking_content || data?.reasoning_content || data?.reasoning || data?.thinking || data?.reasoning_details || data?.thinking_content || '');
      if (content) message.content += content;
      if (reasoning) message.reasoning_content += reasoning;
      job.updatedAt = Date.now();
      if (content || reasoning) notifyJob(job);
    } catch {}
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return send(res, 204, '', {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    });
  }

  if (req.url === '/api/version') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return sendJson(res, 200, { version: APP_VERSION }, { 'Access-Control-Allow-Origin': '*' });
  }

  if (req.url === '/api/image') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return proxyImage(req, res);
  }

  if (req.url === '/api/image-jobs') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return startImageJob(req, res);
  }

  if (req.url === '/api/chat-stream-jobs') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return registerChatStreamJob(req, res);
  }

  if (req.url === '/api/extract-file') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return extractFileText(req, res);
  }

  if (req.url === '/api/chat-jobs') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return startChatJob(req, res);
  }

  if (req.url.startsWith('/api/chat-jobs/')) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    if (req.url.endsWith('/events')) return subscribeJob(req, res, chatJobs);
    return getChatJob(req, res);
  }

  if (req.url.startsWith('/api/image-jobs/')) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    if (req.url.endsWith('/events')) return subscribeJob(req, res, imageJobs);
    return getImageJob(req, res);
  }

  if (req.url.startsWith('/api/')) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return proxy(req, res);
  }

  if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, 'Method Not Allowed');

  const filePath = safeJoin(ROOT, req.url);
  if (!filePath) return send(res, 403, 'Forbidden');

  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not Found');
    const headers = {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': filePath.endsWith('index.html') || filePath.endsWith('.js') || filePath.endsWith('.css') ? 'no-cache' : 'public, max-age=3600',
    };
    if (req.method === 'HEAD') return send(res, 200, '', headers);
    send(res, 200, data, headers);
  });
});

server.on('clientError', (_err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  console.log(`OpenAPI Chat Image is running locally: http://127.0.0.1:${PORT}`);
  console.log(`LAN access: http://<this-machine-ip>:${PORT}`);
  console.log(`Listening on: ${HOST}:${PORT}`);
});
