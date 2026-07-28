const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const JSZip = require('jszip');

const MAX_OFFICE_ARCHIVE_ENTRIES = 5000;
const MAX_OFFICE_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

function optionalRequire(name) {
  try { return require(name); } catch { return null; }
}

function dataUrlToBuffer(dataUrl = '') {
  const value = String(dataUrl || '').trim();
  const invalid = () => {
    const err = new Error('附件编码无效，请重新上传文件');
    err.statusCode = 400;
    err.code = 'INVALID_ATTACHMENT_ENCODING';
    throw err;
  };
  const decodeBase64 = input => {
    const compact = String(input || '').replace(/\s+/g, '');
    if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 === 1) invalid();
    const buffer = Buffer.from(compact, 'base64');
    if (!buffer.length) invalid();
    return buffer;
  };
  if (!value.includes(',')) return decodeBase64(value);
  const [meta, payload = ''] = value.split(/,(.*)/s);
  if (/;base64/i.test(meta)) return decodeBase64(payload);
  try { return Buffer.from(decodeURIComponent(payload), 'utf8'); }
  catch { return invalid(); }
}

function safeAttachmentFilename(value = '') {
  const leaf = String(value || '').replace(/\\/g, '/').split('/').pop() || '';
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  return clean || 'attachment';
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
  const candidate = path.extname(safeAttachmentFilename(filename)).toLowerCase();
  const ext = /^\.[a-z0-9]{1,12}$/.test(candidate) ? candidate : '.bin';
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

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const err = new Error('附件解析已取消');
  err.name = 'AbortError';
  err.statusCode = 499;
  err.code = 'EXTRACT_ABORTED';
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function raceWithSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); reject(abortReason(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      value => { cleanup(); resolve(value); },
      err => { cleanup(); reject(err); }
    );
  });
}

async function commandExists(command, options = {}) {
  throwIfAborted(options.signal);
  const name = String(command || '').trim();
  // This helper only answers whether a fixed executable is available. Do not
  // pass caller-controlled text through a shell just to perform the lookup.
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) return false;
  const directories = String(process.env.PATH || '').split(path.delimiter)
    .map(directory => directory.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const extensions = process.platform === 'win32'
    ? [...new Set(['', ...String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)])]
    : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      throwIfAborted(options.signal);
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.F_OK | (process.platform === 'win32' ? 0 : fs.constants.X_OK));
        return true;
      } catch {}
    }
  }
  return false;
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

async function assertOfficeArchiveSafe(buffer, filename = '') {
  if (!/\.(?:docx|xlsx|xlsm|pptx)$/i.test(String(filename || ''))) return;
  let archive;
  try {
    archive = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false });
  } catch {
    const err = new Error('Office 文件结构无效或已损坏');
    err.statusCode = 400;
    err.code = 'INVALID_OFFICE_ARCHIVE';
    throw err;
  }
  const entries = Object.values(archive.files || {});
  let totalBytes = 0;
  for (const entry of entries) {
    const size = Number(entry?._data?.uncompressedSize || 0);
    if (Number.isFinite(size) && size > 0) totalBytes += size;
    if (entries.length > MAX_OFFICE_ARCHIVE_ENTRIES || totalBytes > MAX_OFFICE_UNCOMPRESSED_BYTES) {
      const err = new Error('Office 文件展开后过大，已拒绝解析');
      err.statusCode = 413;
      err.code = 'OFFICE_ARCHIVE_TOO_LARGE';
      throw err;
    }
  }
}

module.exports = {
  optionalRequire,
  dataUrlToBuffer,
  limitExtractedText,
  withAttachmentHeader,
  writeTempBuffer,
  cleanupTempDir,
  execFileText,
  commandExists,
  meaningfulExtractedText,
  hasUsefulText,
  safeAttachmentFilename,
  assertOfficeArchiveSafe,
  MAX_OFFICE_ARCHIVE_ENTRIES,
  MAX_OFFICE_UNCOMPRESSED_BYTES,
  abortReason,
  throwIfAborted,
  raceWithSignal,
};
