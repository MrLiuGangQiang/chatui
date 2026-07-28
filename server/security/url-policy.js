const net = require('net');
const dnsModule = require('dns');
const dns = dnsModule.promises;

function normalizeIpAddress(value = '') {
  const address = String(value || '').trim().toLowerCase().split('%')[0];
  const mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return mapped ? mapped[1] : address;
}

function expandIpv6Address(value = '') {
  const address = normalizeIpAddress(value);
  if (net.isIP(address) !== 6) return null;
  const [left = '', right = ''] = address.split('::');
  if (address.split('::').length > 2) return null;
  const leftParts = left ? left.split(':') : [];
  const rightParts = right ? right.split(':') : [];
  const hasIpv4Tail = /\./.test(rightParts.at(-1) || leftParts.at(-1) || '');
  const ipv4Part = hasIpv4Tail ? (rightParts.at(-1) || leftParts.at(-1)) : '';
  const ipv4Groups = ipv4Part ? ipv4Part.split('.').map(Number) : [];
  if (ipv4Part && (ipv4Groups.length !== 4 || ipv4Groups.some(part => !Number.isInteger(part) || part < 0 || part > 255))) return null;
  if (hasIpv4Tail) (rightParts.length ? rightParts : leftParts).pop();
  const explicit = leftParts.length + rightParts.length + (ipv4Part ? 2 : 0);
  const missing = address.includes('::') ? 8 - explicit : 0;
  if (explicit > 8 || (!address.includes('::') && explicit !== 8) || missing < 0) return null;
  const groups = [...leftParts, ...Array(missing).fill('0'), ...rightParts];
  if (ipv4Part) groups.push(((ipv4Groups[0] << 8) | ipv4Groups[1]).toString(16), ((ipv4Groups[2] << 8) | ipv4Groups[3]).toString(16));
  if (groups.length !== 8 || groups.some(part => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  return groups.map(part => parseInt(part, 16));
}

function isPrivateHostname(hostname = '') {
  const host = normalizeIpAddress(String(hostname || '').trim().replace(/^\[|\]$/g, ''));
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const version = net.isIP(host);
  if (version === 4) {
    const parts = host.split('.').map(Number);
    const [a, b] = parts;
    return a === 10 || a === 127 || a === 0 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (version === 6) {
    const groups = expandIpv6Address(host);
    if (!groups) return true;
    const isUnspecified = groups.every(part => part === 0);
    const isLoopback = groups.slice(0, 7).every(part => part === 0) && groups[7] === 1;
    const isIpv4Compatible = groups.slice(0, 6).every(part => part === 0);
    const isIpv4Mapped = groups.slice(0, 5).every(part => part === 0) && groups[5] === 0xffff;
    const embeddedIpv4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    const isPrivateEmbeddedIpv4 = (isIpv4Compatible || isIpv4Mapped) && isPrivateHostname(embeddedIpv4);
    const first = groups[0];
    return isUnspecified || isLoopback || isPrivateEmbeddedIpv4 ||
      (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
      (first & 0xffc0) === 0xfe80 || // fe80::/10 link local
      (first & 0xff00) === 0xff00; // ff00::/8 multicast
  }
  return false;
}

function createPublicLookup({ allowPrivate = privateUpstreamAllowed(), lookup = dnsModule.lookup } = {}) {
  return (hostname, options, callback) => {
    const requested = options && typeof options === 'object' ? options : {};
    lookup(hostname, { ...requested, all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      const resolved = Array.isArray(addresses) ? addresses : addresses ? [addresses] : [];
      const usable = resolved.filter(item => item?.address && (!requested.family || Number(item.family) === Number(requested.family)));
      if (!usable.length || (!allowPrivate && usable.some(item => isPrivateHostname(item.address)))) {
        const blocked = new Error('上游地址解析到非公网网络或无法解析');
        blocked.code = 'INVALID_UPSTREAM_ADDRESS';
        return callback(blocked);
      }
      if (requested.all) return callback(null, usable);
      return callback(null, usable[0].address, usable[0].family);
    });
  };
}

async function assertPublicHostname(hostname, { allowPrivate = privateUpstreamAllowed(), lookup = dns.lookup } = {}) {
  const host = String(hostname || '').trim().replace(/^\[|\]$/g, '');
  if (!host || (!allowPrivate && isPrivateHostname(host))) return false;
  if (allowPrivate || net.isIP(normalizeIpAddress(host))) return true;
  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    return false;
  }
  return Array.isArray(addresses) && addresses.length > 0 && addresses.every(item => !isPrivateHostname(item?.address));
}

async function assertResolvedUpstreamUrl(url, options = {}) {
  let parsed;
  try { parsed = url instanceof URL ? url : new URL(String(url || '')); } catch { return false; }
  return assertAllowedUpstreamUrl(parsed, options) && assertPublicHostname(parsed.hostname, options);
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

function normalizeBaseUrl(value, options = {}) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!assertAllowedUpstreamUrl(url, options)) return '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

module.exports = { normalizeIpAddress, expandIpv6Address, isPrivateHostname, createPublicLookup, assertPublicHostname, assertAllowedUpstreamUrl, assertResolvedUpstreamUrl, normalizeBaseUrl, privateUpstreamAllowed };
