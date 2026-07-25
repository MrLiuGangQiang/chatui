const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { send } = require('./response');
const {
  BUNDLE_PATHS,
  bundleMetadata,
  bundleCacheKey,
  buildBundleBody,
  contentTypeForBundle,
} = require('../services/static-bundle.service');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const SHORT_CACHE = 'public, max-age=3600';
const NO_CACHE = 'no-cache';
const bundleCache = new Map();
const encodedBodyCache = new Map();
const PUBLIC_ROOT_FILES = new Set(['/index.html', '/route.html', '/favicon.svg', '/styles.css', '/app.js']);
const PUBLIC_PREFIXES = ['/client/', '/shared/', '/styles/', '/vendor/', '/assets/'];

function isPublicStaticPath(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(String(urlPath || '').split('?')[0]);
  } catch {
    return false;
  }
  if (pathname === '/') pathname = '/index.html';
  if (pathname.includes('\\') || pathname.split('/').includes('..')) return false;
  return PUBLIC_ROOT_FILES.has(pathname) || PUBLIC_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

function safeJoin(root, rootWithSep, urlPath) {
  try {
    const cleanPath = decodeURIComponent(urlPath.split('?')[0]);
    const filePath = path.normalize(path.join(root, cleanPath === '/' ? 'index.html' : cleanPath));
    if (filePath !== root && !filePath.startsWith(rootWithSep)) return null;
    return filePath;
  } catch {
    return null;
  }
}

function pickCompressedStaticFile(req, filePath) {
  const encoding = String(req.headers['accept-encoding'] || '');
  const ext = path.extname(filePath);
  if (!['.js', '.css'].includes(ext)) return { filePath, encoding: '' };
  const sourceMtime = fs.statSync(filePath).mtimeMs;
  const freshVariant = (suffix) => {
    const variantPath = `${filePath}${suffix}`;
    try {
      return fs.statSync(variantPath).mtimeMs >= sourceMtime ? variantPath : '';
    } catch {
      return '';
    }
  };
  const brPath = /\bbr\b/.test(encoding) ? freshVariant('.br') : '';
  if (brPath) return { filePath: brPath, encoding: 'br' };
  const gzipPath = /\bgzip\b/.test(encoding) ? freshVariant('.gz') : '';
  if (gzipPath) return { filePath: gzipPath, encoding: 'gzip' };
  return { filePath, encoding: '' };
}

function parseRequestUrl(req) {
  try {
    return new URL(req.url, 'http://chatui.local');
  } catch {
    return null;
  }
}

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function isFresh(req, etag) {
  const header = String(req.headers['if-none-match'] || '');
  if (!header || !etag) return false;
  return header === '*' || header.split(',').map(part => part.trim()).includes(etag);
}

function preferredEncoding(req) {
  const encoding = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(encoding)) return 'br';
  if (/\bgzip\b/.test(encoding)) return 'gzip';
  return '';
}

function shouldCompress(mime, body) {
  if (!body || body.length < 1024) return false;
  return /(?:javascript|json|text\/|svg\+xml)/i.test(mime || '');
}

function trimCache(cache, maxEntries = 96) {
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}

function encodeBody(body, encoding, cacheKey, mime) {
  if (!encoding || !shouldCompress(mime, body)) return { body, encoding: '' };
  const key = `${cacheKey}:${encoding}`;
  const cached = encodedBodyCache.get(key);
  if (cached) return cached;
  const encoded = encoding === 'br'
    ? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
    : zlib.gzipSync(body, { level: 6 });
  const result = { body: encoded, encoding };
  encodedBodyCache.set(key, result);
  trimCache(encodedBodyCache, 160);
  return result;
}

function cacheControlFor(filePath, url, options = {}) {
  // Query-string versions in index.html are manually maintained, not content
  // hashes. Marking them immutable lets a new index load alongside stale
  // workflow code after a deployment, which breaks cross-module contracts at
  // runtime. Keep executable assets revalidatable until they use hashed URLs.
  if (options.bundle) return NO_CACHE;
  if (filePath.endsWith('.html')) return NO_CACHE;
  const ext = path.extname(filePath);
  if (['.html', '.js', '.css', '.json'].includes(ext)) return NO_CACHE;
  return SHORT_CACHE;
}

function buildBundle(root, rootWithSep, kind) {
  const meta = bundleMetadata(root, rootWithSep, kind);
  const cacheKey = bundleCacheKey(kind, meta.signature);
  const cached = bundleCache.get(cacheKey);
  if (cached) return cached;
  const body = buildBundleBody(meta.entries, kind);
  const result = { body, etag: meta.etag, cacheKey };
  bundleCache.set(cacheKey, result);
  trimCache(bundleCache, 12);
  return result;
}

function serveBundle(req, res, context, kind) {
  const mime = contentTypeForBundle(kind);
  let bundle;
  try {
    bundle = buildBundle(context.root, context.rootWithSep, kind);
  } catch (err) {
    console.error('[static] failed to build asset bundle:', err);
    return send(res, 500, 'Failed to build asset bundle');
  }
  const headers = {
    'Content-Type': mime,
    'Cache-Control': cacheControlFor('', null, { bundle: true }),
    ETag: bundle.etag,
    Vary: 'Accept-Encoding',
  };
  if (isFresh(req, bundle.etag)) return send(res, 304, '', headers);
  const encoded = encodeBody(bundle.body, preferredEncoding(req), bundle.cacheKey, mime);
  if (encoded.encoding) headers['Content-Encoding'] = encoded.encoding;
  if (req.method === 'HEAD') return send(res, 200, '', headers);
  return send(res, 200, encoded.body, headers);
}

function staticEtag(filePath, stat, encoding = '') {
  return `W/"${sha1(`${filePath}:${stat.size}:${Math.floor(stat.mtimeMs)}:${encoding}`).slice(0, 24)}"`;
}

function serveStatic(req, res, { root, rootWithSep }) {
  const url = parseRequestUrl(req);
  if (!url) return send(res, 400, 'Bad Request');
  const bundleKind = BUNDLE_PATHS[url.pathname];
  if (bundleKind) return serveBundle(req, res, { root, rootWithSep }, bundleKind);
  if (!isPublicStaticPath(url.pathname)) return send(res, 404, 'Not Found');

  const filePath = safeJoin(root, rootWithSep, url.pathname);
  if (!filePath) return send(res, 403, 'Forbidden');

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) return send(res, 404, 'Not Found');
    let picked;
    try {
      picked = pickCompressedStaticFile(req, filePath);
    } catch {
      picked = { filePath, encoding: '' };
    }
    const mime = MIME[path.extname(filePath)] || 'application/octet-stream';
    const etag = staticEtag(filePath, stat, picked.encoding || preferredEncoding(req));
    const headers = {
      'Content-Type': mime,
      'Cache-Control': cacheControlFor(filePath, url),
      ETag: etag,
      Vary: 'Accept-Encoding',
    };
    if (picked.encoding) headers['Content-Encoding'] = picked.encoding;
    if (isFresh(req, etag)) return send(res, 304, '', headers);
    if (req.method === 'HEAD') return send(res, 200, '', headers);

    fs.readFile(picked.filePath, (err, data) => {
      if (err) return send(res, 404, 'Not Found');
      const cacheKey = `${filePath}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
      const encoded = picked.encoding ? { body: data, encoding: picked.encoding } : encodeBody(data, preferredEncoding(req), cacheKey, mime);
      if (encoded.encoding) headers['Content-Encoding'] = encoded.encoding;
      send(res, 200, encoded.body, headers);
    });
  });
}

module.exports = { MIME, SHORT_CACHE, NO_CACHE, cacheControlFor, safeJoin, isPublicStaticPath, pickCompressedStaticFile, serveStatic };
