const DEFAULT_MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1024 * 1024);
const MAX_BODY_BYTES = DEFAULT_MAX_BODY_BYTES;

function payloadTooLargeError() {
  const err = new Error('请求体过大');
  err.statusCode = 413;
  err.code = 'PAYLOAD_TOO_LARGE';
  return err;
}

function normalizeMaxBytes(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_BODY_BYTES;
}

function readBody(req, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  const limit = normalizeMaxBytes(maxBytes);
  return new Promise((resolve, reject) => {
    let body = '';
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

    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (settled) return;
      size += Buffer.byteLength(chunk);
      if (size > limit) {
        // Keep the stream flowing so a keep-alive connection is not left with unread bytes.
        fail(payloadTooLargeError());
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(body);
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

module.exports = { readBody, parseJson, MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES, payloadTooLargeError };
