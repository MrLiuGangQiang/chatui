'use strict';

const crypto = require('crypto');

const PRINCIPAL_COOKIE_NAME = 'chatui_principal';
const PRINCIPAL_VERSION = 'v1';
const PRINCIPAL_BYTES = 32;
const MIN_SECRET_BYTES = 32;
const DEFAULT_TENANT_ID = 'default';
const DEFAULT_COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;
const PRINCIPAL_OWNER_KEY = Symbol('chatui.requestPrincipal.ownerKey');

function configurationError(message, code = 'INVALID_PRINCIPAL_CONFIGURATION') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeTenantId(value) {
  const tenantId = String(value || DEFAULT_TENANT_ID).trim();
  if (!tenantId || Buffer.byteLength(tenantId, 'utf8') > 128 || /[\u0000-\u001f\u007f]/.test(tenantId)) {
    throw configurationError('CHATUI_TENANT_ID must be 1-128 bytes and must not contain control characters');
  }
  return tenantId;
}

function normalizeSecret(value, randomBytes = crypto.randomBytes) {
  if (value === undefined || value === null || value === '') return Buffer.from(randomBytes(PRINCIPAL_BYTES));
  const secret = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), 'utf8');
  if (secret.length < MIN_SECRET_BYTES) {
    throw configurationError(`CHATUI_PRINCIPAL_SECRET must contain at least ${MIN_SECRET_BYTES} bytes`, 'PRINCIPAL_SECRET_TOO_SHORT');
  }
  return secret;
}

function normalizeCookieSecureMode(value) {
  const mode = String(value ?? 'auto').trim().toLowerCase();
  if (['1', 'true', 'always'].includes(mode)) return 'always';
  if (['0', 'false', 'never'].includes(mode)) return 'never';
  if (!mode || mode === 'auto') return 'auto';
  throw configurationError('CHATUI_PRINCIPAL_COOKIE_SECURE must be auto, 1, or 0', 'INVALID_PRINCIPAL_COOKIE_SECURE');
}

function normalizeCookieMaxAge(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_COOKIE_MAX_AGE_SECONDS;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 3600 || seconds > 31 * 24 * 60 * 60) {
    throw configurationError('CHATUI_PRINCIPAL_COOKIE_MAX_AGE_SECONDS must be an integer between 3600 and 2678400', 'INVALID_PRINCIPAL_COOKIE_MAX_AGE');
  }
  return seconds;
}

function requestHeader(req, name) {
  const headers = req?.headers || {};
  const direct = headers[String(name).toLowerCase()];
  if (direct !== undefined) return Array.isArray(direct) ? direct.join('; ') : String(direct);
  const key = Object.keys(headers).find(item => String(item).toLowerCase() === String(name).toLowerCase());
  const value = key ? headers[key] : '';
  return Array.isArray(value) ? value.join('; ') : String(value || '');
}

function cookieValues(header, name) {
  const values = [];
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    values.push(part.slice(separator + 1).trim());
  }
  return values;
}

function safeBase64UrlBuffer(value, expectedBytes) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  let decoded;
  try { decoded = Buffer.from(text, 'base64url'); } catch { return null; }
  if (decoded.length !== expectedBytes || decoded.toString('base64url') !== text) return null;
  return decoded;
}

function timingSafeEqual(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function headerObject(value) {
  if (!value) return {};
  if (Array.isArray(value)) {
    const result = {};
    for (let index = 0; index + 1 < value.length; index += 2) result[String(value[index])] = value[index + 1];
    return result;
  }
  if (typeof value.entries === 'function' && value.constructor?.name === 'Headers') return Object.fromEntries(value.entries());
  return { ...value };
}

function findHeaderKey(headers, name) {
  return Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase()) || '';
}

function setHeaderValue(headers, name, value) {
  const existingKey = findHeaderKey(headers, name);
  if (existingKey && existingKey !== name) delete headers[existingKey];
  headers[name] = value;
}

function appendSetCookie(headers, cookie) {
  const key = findHeaderKey(headers, 'Set-Cookie');
  const existing = key ? headers[key] : null;
  const values = existing === undefined || existing === null || existing === ''
    ? []
    : Array.isArray(existing) ? existing.map(String) : [String(existing)];
  if (!values.includes(cookie)) values.push(cookie);
  setHeaderValue(headers, 'Set-Cookie', values);
}

function makePrivateNoStore(headers) {
  const key = findHeaderKey(headers, 'Cache-Control');
  const current = key ? String(headers[key] || '') : '';
  const noTransform = /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(current);
  setHeaderValue(headers, 'Cache-Control', `private, no-store${noTransform ? ', no-transform' : ''}`);
}

function decorateResponseForPrincipalCookie(res, cookie) {
  if (!res || typeof res.writeHead !== 'function' || !cookie) return;
  const originalWriteHead = res.writeHead.bind(res);
  let injected = false;
  res.writeHead = function writeHeadWithPrincipal(statusCode, ...args) {
    if (injected) return originalWriteHead(statusCode, ...args);
    injected = true;
    const hasStatusMessage = typeof args[0] === 'string';
    const statusMessage = hasStatusMessage ? args[0] : null;
    const headers = headerObject(hasStatusMessage ? args[1] : args[0]);
    const existingCookies = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : null;
    for (const existingCookie of Array.isArray(existingCookies) ? existingCookies : existingCookies ? [existingCookies] : []) {
      appendSetCookie(headers, String(existingCookie));
    }
    appendSetCookie(headers, cookie);
    makePrivateNoStore(headers);
    return hasStatusMessage
      ? originalWriteHead(statusCode, statusMessage, headers)
      : originalWriteHead(statusCode, headers);
  };
}

function forwardedProtocol(req) {
  return requestHeader(req, 'x-forwarded-proto').split(',')[0].trim().toLowerCase();
}

function shouldUseSecureCookie(req, mode, trustProxy) {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  if (req?.socket?.encrypted === true) return true;
  return trustProxy && forwardedProtocol(req) === 'https';
}

function attachPrincipalToRequest(req, principal) {
  Object.defineProperty(req, 'authPrincipal', {
    value: principal,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return principal;
}

function principalOwnerKey(principal) {
  const key = principal?.[PRINCIPAL_OWNER_KEY];
  return Buffer.isBuffer(key) && key.length === PRINCIPAL_BYTES ? key : null;
}

function createRequestPrincipalService({
  env = process.env,
  secret = env.CHATUI_PRINCIPAL_SECRET,
  tenantId = env.CHATUI_TENANT_ID || DEFAULT_TENANT_ID,
  cookieName = PRINCIPAL_COOKIE_NAME,
  cookieSecure = env.CHATUI_PRINCIPAL_COOKIE_SECURE,
  trustProxy = env.CHATUI_TRUST_PROXY === '1',
  cookieMaxAgeSeconds = env.CHATUI_PRINCIPAL_COOKIE_MAX_AGE_SECONDS,
  randomBytes = crypto.randomBytes,
  now = Date.now,
} = {}) {
  const normalizedSecret = normalizeSecret(secret, randomBytes);
  const normalizedTenantId = normalizeTenantId(tenantId);
  const secureMode = normalizeCookieSecureMode(cookieSecure);
  const maxAgeSeconds = normalizeCookieMaxAge(cookieMaxAgeSeconds);
  const normalizedCookieName = String(cookieName || '').trim();
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(normalizedCookieName)) {
    throw configurationError('Principal cookie name is invalid', 'INVALID_PRINCIPAL_COOKIE_NAME');
  }

  function sign(payload) {
    return crypto.createHmac('sha256', normalizedSecret)
      .update('chatui.principal.cookie\0', 'utf8')
      .update(normalizedTenantId, 'utf8')
      .update('\0', 'utf8')
      .update(payload, 'utf8')
      .digest();
  }

  function makePrincipal(subject) {
    const ownerKey = crypto.createHmac('sha256', normalizedSecret)
      .update('chatui.job.owner\0', 'utf8')
      .update(normalizedTenantId, 'utf8')
      .update('\0', 'utf8')
      .update(subject, 'utf8')
      .digest();
    const principal = {};
    Object.defineProperties(principal, {
      kind: { value: 'anonymous', enumerable: false },
      tenantId: { value: normalizedTenantId, enumerable: false },
      [PRINCIPAL_OWNER_KEY]: { value: ownerKey, enumerable: false },
    });
    return Object.freeze(principal);
  }

  function tokenForSubject(subject) {
    const expiresAt = Math.floor(Number(now()) / 1000) + maxAgeSeconds;
    const payload = `${PRINCIPAL_VERSION}.${subject}.${expiresAt}`;
    return `${payload}.${sign(payload).toString('base64url')}`;
  }

  function principalFromToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 4 || parts[0] !== PRINCIPAL_VERSION || !/^[0-9]{1,12}$/.test(parts[2])) return null;
    const subjectBuffer = safeBase64UrlBuffer(parts[1], PRINCIPAL_BYTES);
    const suppliedSignature = safeBase64UrlBuffer(parts[3], PRINCIPAL_BYTES);
    const expiresAt = Number(parts[2]);
    if (!subjectBuffer || !suppliedSignature || !Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Number(now()) / 1000)) return null;
    const payload = `${parts[0]}.${parts[1]}.${parts[2]}`;
    if (!timingSafeEqual(suppliedSignature, sign(payload))) return null;
    return { principal: makePrincipal(parts[1]), subject: parts[1], expiresAt };
  }

  function issuePrincipal() {
    const subject = Buffer.from(randomBytes(PRINCIPAL_BYTES)).toString('base64url');
    return { principal: makePrincipal(subject), token: tokenForSubject(subject) };
  }

  function serializeCookie(token, req) {
    return [
      `${normalizedCookieName}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAgeSeconds}`,
      ...(shouldUseSecureCookie(req, secureMode, trustProxy) ? ['Secure'] : []),
    ].join('; ');
  }

  function resolveRequest(req) {
    const values = [...new Set(cookieValues(requestHeader(req, 'cookie'), normalizedCookieName))];
    const valid = values.map(token => principalFromToken(token)).filter(Boolean);
    if (valid.length === 1) {
      const authenticated = valid[0];
      const remainingSeconds = authenticated.expiresAt - Math.floor(Number(now()) / 1000);
      if (remainingSeconds > Math.max(60, Math.floor(maxAgeSeconds / 4))) {
        return { principal: authenticated.principal, issued: false, cookie: '' };
      }
      return {
        principal: authenticated.principal,
        issued: true,
        cookie: serializeCookie(tokenForSubject(authenticated.subject), req),
      };
    }
    const issued = issuePrincipal();
    return {
      principal: issued.principal,
      issued: true,
      cookie: serializeCookie(issued.token, req),
    };
  }

  function attach(req, res) {
    if (principalOwnerKey(req?.authPrincipal)) return req.authPrincipal;
    const resolved = resolveRequest(req);
    attachPrincipalToRequest(req, resolved.principal);
    if (resolved.issued) decorateResponseForPrincipalCookie(res, resolved.cookie);
    return resolved.principal;
  }

  return Object.freeze({
    attach,
    resolveRequest,
    cookieName: normalizedCookieName,
    tenantId: normalizedTenantId,
  });
}

module.exports = {
  DEFAULT_COOKIE_MAX_AGE_SECONDS,
  DEFAULT_TENANT_ID,
  MIN_SECRET_BYTES,
  PRINCIPAL_COOKIE_NAME,
  attachPrincipalToRequest,
  createRequestPrincipalService,
  decorateResponseForPrincipalCookie,
  normalizeCookieMaxAge,
  normalizeCookieSecureMode,
  normalizeSecret,
  normalizeTenantId,
  principalOwnerKey,
  shouldUseSecureCookie,
};
