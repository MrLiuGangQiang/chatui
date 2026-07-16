const { assertRuntimeConfig } = require('../config/runtime-config');

const DEFAULT_MAX_BODY_BYTES = assertRuntimeConfig().maxBodyBytes;
const MAX_BODY_BYTES = DEFAULT_MAX_BODY_BYTES;

function payloadTooLargeError() {
  const err = new Error('请求体过大');
  err.statusCode = 413;
  err.code = 'PAYLOAD_TOO_LARGE';
  return err;
}

function requestAbortedError() {
  const err = new Error('请求已中止');
  err.statusCode = 400;
  err.code = 'REQUEST_ABORTED';
  return err;
}

function normalizeMaxBytes(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_BODY_BYTES;
}

function effectiveMaxBytes(value) {
  return Math.min(normalizeMaxBytes(value), DEFAULT_MAX_BODY_BYTES);
}

function declaredContentLength(req) {
  const value = req?.headers?.['content-length'];
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function drainRequest(req) {
  // Do not retain an oversized payload in memory. Draining also preserves HTTP/1.1
  // keep-alive behavior when the peer has already started sending the request.
  req?.resume?.();
}

function assertContentLength(req, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  const limit = effectiveMaxBytes(maxBytes);
  const length = declaredContentLength(req);
  if (length !== null && length > limit) {
    drainRequest(req);
    throw payloadTooLargeError();
  }
  return limit;
}

function readBody(req, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  let limit;
  try {
    limit = assertContentLength(req, { maxBytes });
  } catch (err) {
    return Promise.reject(err);
  }
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
      if (size > limit) {
        drainRequest(req);
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
    req.on('aborted', () => fail(requestAbortedError()));
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
  normalizeMaxBytes,
  effectiveMaxBytes,
  declaredContentLength,
  drainRequest,
  assertContentLength,
  payloadTooLargeError,
};
