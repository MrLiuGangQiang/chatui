const { assertContentLength, effectiveMaxBytes } = require('./body');

const KIB = 1024;
const MIB = 1024 * KIB;

const BODY_LIMITS = Object.freeze({
  usage: 256 * KIB,
  chat: 2 * MIB,
  visualChat: 12 * MIB,
  image: 50 * MIB,
  extract: 50 * MIB,
});

function requestPathname(req) {
  try {
    return new URL(String(req?.url || '/'), 'http://chatui.local').pathname;
  } catch {
    return '';
  }
}

function getRequestBodyLimit(req) {
  if (String(req?.method || 'GET').toUpperCase() !== 'POST') return 0;
  const pathname = requestPathname(req);
  if (pathname.startsWith('/api/usage/')) return BODY_LIMITS.usage;
  if (pathname === '/api/extract-file') return BODY_LIMITS.extract;
  if (pathname === '/api/image-jobs' || pathname === '/api/images/edits' || pathname === '/api/openai/image_edit') return BODY_LIMITS.image;
  if (pathname === '/api/chat-jobs' || pathname === '/api/chat-stream-jobs') return BODY_LIMITS.visualChat;
  if (pathname.startsWith('/api/')) return BODY_LIMITS.visualChat;
  return 0;
}

function assertRequestBodyLimit(req) {
  const configuredLimit = getRequestBodyLimit(req);
  if (!configuredLimit) return 0;
  assertContentLength(req, { maxBytes: configuredLimit });
  return effectiveMaxBytes(configuredLimit);
}

module.exports = { BODY_LIMITS, requestPathname, getRequestBodyLimit, assertRequestBodyLimit };
