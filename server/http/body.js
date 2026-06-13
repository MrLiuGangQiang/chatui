const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 50 * 1024 * 1024);

function payloadTooLargeError() {
  const err = new Error('请求体过大');
  err.statusCode = 413;
  err.code = 'PAYLOAD_TOO_LARGE';
  return err;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (settled) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
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

module.exports = { readBody, parseJson, MAX_BODY_BYTES, payloadTooLargeError };
