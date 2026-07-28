const { dataUrlToBuffer, limitExtractedText, withAttachmentHeader } = require('./utils');

function isTextExtractable(filename = '', type = '') {
  return /^(text\/|application\/(json|xml|yaml|javascript|x-javascript|typescript|x-typescript))/i.test(String(type || ''))
    || /\.(txt|md|markdown|json|csv|xml|yaml|yml|js|ts|jsx|tsx|html|css|py|java|go|rs|php|sql|log|conf|ini|env|sh|bash|zsh|toml|lock)$/i.test(String(filename || ''));
}

function looksBinaryBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length > 0.08;
}

async function extractPlainText(filename, dataUrl, type = '') {
  const buffer = dataUrlToBuffer(dataUrl);
  if (looksBinaryBuffer(buffer)) throw Object.assign(new Error('文件看起来是二进制内容，无法按文本解析'), { statusCode: 415 });
  const raw = buffer.toString('utf8');
  return withAttachmentHeader('文本', filename, type || 'plain-text', limitExtractedText(raw), '解析说明：以下为按文本文件读取到的正文；请基于这些内容回答用户问题。');
}

module.exports = { isTextExtractable, extractPlainText, looksBinaryBuffer };
