const crypto = require('crypto');
const { send, sendJson } = require('./response');
const { createCorsPolicy, applyCorsPolicy } = require('./cors');
const { safeLog } = require('../logging/safe-log');
const { createAuthPolicy, authenticationError } = require('../security/auth');
const { assertRequestBodyLimit } = require('./request-body-limits');

function createRequestId() {
  return crypto.randomUUID();
}

function publicError(err) {
  const statusCode = Number(err?.statusCode || err?.status || 500);
  const clientStatus = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
  if (clientStatus === 500) {
    return { statusCode: 500, message: 'Internal Server Error', code: 'INTERNAL_SERVER_ERROR' };
  }
  return {
    statusCode: clientStatus,
    message: String(err?.message || 'Request failed'),
    code: String(err?.code || 'REQUEST_FAILED'),
  };
}

function createRequestHandler(route, { corsPolicy = createCorsPolicy(), authPolicy = createAuthPolicy(), onError = safeLog } = {}) {
  if (typeof route !== 'function') throw new TypeError('route must be a function');

  return async function requestHandler(req, res) {
    const requestId = createRequestId();
    req.requestId = requestId;
    res.setHeader?.('X-Request-Id', requestId);
    const cors = applyCorsPolicy(req, res, corsPolicy);

    if (req.method === 'OPTIONS') {
      if (!cors.allowed) {
        return sendJson(res, 403, { error: { message: 'CORS origin is not allowed', code: 'CORS_ORIGIN_DENIED' } });
      }
      return send(res, 204, '');
    }

    try {
      assertRequestBodyLimit(req);
      const authentication = authPolicy.authenticate(req);
      if (!authentication.authenticated) {
        const error = authenticationError();
        return sendJson(res, error.statusCode, { error: { message: error.message, code: error.code } }, { 'WWW-Authenticate': 'Bearer' });
      }
      return await route(req, res);
    } catch (err) {
      const error = publicError(err);
      onError('[http] request failed', {
        requestId,
        method: String(req.method || 'GET').toUpperCase(),
        path: String(req.url || '').split('?')[0],
        statusCode: error.statusCode,
        code: String(err?.code || error.code),
        message: String(err?.message || err || 'Unknown error'),
      }, { always: true });
      if (res.headersSent || res.writableEnded) {
        res.destroy?.(err);
        return undefined;
      }
      return sendJson(res, error.statusCode, { error: { message: error.message, code: error.code } });
    }
  };
}

module.exports = { createRequestId, publicError, createRequestHandler };
