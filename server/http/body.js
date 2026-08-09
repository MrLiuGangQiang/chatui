const { TextDecoder } = require('util');

const DEFAULT_MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1024 * 1024);
const MAX_BODY_BYTES = DEFAULT_MAX_BODY_BYTES;

function payloadTooLargeError() {
  const err = new Error('请求体过大');
  err.statusCode = 413;
  err.code = 'PAYLOAD_TOO_LARGE';
  return err;
}

function invalidUtf8Error(cause = null) {
  const err = new Error('请求体不是有效 UTF-8');
  err.statusCode = 400;
  err.code = 'INVALID_UTF8';
  if (cause) err.cause = cause;
  return err;
}

function normalizeMaxBytes(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_BODY_BYTES;
}

function readBody(req, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  const limit = normalizeMaxBytes(maxBytes);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const declaredLength = Number(req.headers?.['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      req.resume?.();
      fail(payloadTooLargeError());
      return;
    }

    req.on('data', chunk => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : ArrayBuffer.isView(chunk)
          ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : Buffer.from(String(chunk || ''), 'utf8');
      size += buffer.length;
      if (size > limit) {
        // Keep the stream flowing so a keep-alive connection is not left with unread bytes.
        fail(payloadTooLargeError());
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const body = decoder.decode(Buffer.concat(chunks, size));
        settled = true;
        resolve(body);
      } catch (error) {
        fail(invalidUtf8Error(error));
      }
    });
    req.on('aborted', () => {
      const err = new Error('请求已中止');
      err.statusCode = 400;
      err.code = 'REQUEST_ABORTED';
      fail(err);
    });
    req.on('error', err => fail(err));
  });
}

function parseJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('请求体不是有效 JSON');
    err.statusCode = 400;
    err.code = 'INVALID_JSON';
    throw err;
  }
}

module.exports = {
  readBody,
  parseJson,
  MAX_BODY_BYTES,
  DEFAULT_MAX_BODY_BYTES,
  payloadTooLargeError,
  invalidUtf8Error,
};
