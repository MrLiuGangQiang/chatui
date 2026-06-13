const net = require('net');

function isPrivateHostname(hostname = '') {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const version = net.isIP(host);
  if (version === 4) {
    const parts = host.split('.').map(Number);
    const [a, b] = parts;
    return a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254);
  }
  if (version === 6) {
    return host === '::1' || host === '0:0:0:0:0:0:0:1' ||
      host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
  }
  return false;
}

function privateUpstreamAllowed() {
  return process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM === '1' || process.env.ALLOW_PRIVATE_UPSTREAM === '1';
}

function assertAllowedUpstreamUrl(url, { allowPrivate = privateUpstreamAllowed() } = {}) {
  const parsed = url instanceof URL ? url : new URL(String(url || ''));
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (!allowPrivate && isPrivateHostname(parsed.hostname)) return false;
  return true;
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!assertAllowedUpstreamUrl(url)) return '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

module.exports = { isPrivateHostname, assertAllowedUpstreamUrl, normalizeBaseUrl, privateUpstreamAllowed };
