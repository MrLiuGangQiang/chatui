const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { send } = require('./response');

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

const ASSET_MANIFEST_ID = 'chatuiAssetManifest';
const BUNDLE_VERSION = '1.3.28-arch37';
const BUNDLE_PATHS = {
  '/assets/chatui.bundle.css': 'css',
  '/assets/chatui.bundle.js': 'js',
};
const MARKDOWN_CORE_SCRIPT_PATHS = Object.freeze([
  '/vendor/purify.min.js',
  '/vendor/markdown-it.min.js',
  '/vendor/markdown-it-plugins/markdown-it-texmath.min.js',
  '/vendor/markdown-it-plugins/markdown-it-multimd-table.min.js',
  '/vendor/markdown-it-plugins/markdown-it-task-lists.min.js',
  '/vendor/markdown-it-plugins/markdown-it-emoji.min.js',
  '/vendor/markdown-it-plugins/markdown-it-footnote.min.js',
  '/vendor/markdown-it-plugins/markdown-it-deflist.min.js',
  '/vendor/markdown-it-plugins/markdown-it-abbr.min.js',
  '/vendor/markdown-it-plugins/markdown-it-mark.min.js',
  '/vendor/markdown-it-plugins/markdown-it-sub.min.js',
  '/vendor/markdown-it-plugins/markdown-it-sup.min.js',
  '/vendor/highlight-common.min.js',
  '/vendor/katex.min.js',
]);
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const SHORT_CACHE = 'public, max-age=3600';
const NO_CACHE = 'no-cache';
const manifestCache = new Map();
const bundleCache = new Map();
const encodedBodyCache = new Map();

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

function attrValue(source, name) {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = String(source || '').match(pattern);
  return match ? (match[2] ?? match[3] ?? match[4] ?? '') : '';
}

function normalizeLocalAsset(root, rootWithSep, href) {
  const raw = String(href || '').trim();
  if (!raw || /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(raw) || /^(?:data|blob):/i.test(raw)) return null;
  const withoutQuery = raw.split(/[?#]/)[0];
  if (!withoutQuery || withoutQuery.includes('..')) return null;
  const normalizedUrlPath = path.posix.normalize(`/${withoutQuery.replace(/^\.\//, '').replace(/^\//, '')}`);
  if (normalizedUrlPath === '/' || normalizedUrlPath.includes('/../')) return null;
  const filePath = safeJoin(root, rootWithSep, normalizedUrlPath);
  return filePath ? { href: raw, urlPath: normalizedUrlPath, filePath } : null;
}

function manifestSource(html) {
  const pattern = new RegExp(`<template\\b[^>]*\\bid=["']${ASSET_MANIFEST_ID}["'][^>]*>([\\s\\S]*?)<\\/template>`, 'i');
  const match = String(html || '').match(pattern);
  return match ? match[1] : html;
}

function parseAssetManifest(root, rootWithSep, kind) {
  const indexPath = path.join(root, 'index.html');
  const stat = fs.statSync(indexPath);
  const cacheKey = `${indexPath}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
  const cached = manifestCache.get(cacheKey);
  if (cached) return cached[kind] || [];
  manifestCache.clear();

  const source = manifestSource(fs.readFileSync(indexPath, 'utf8'));
  const css = [];
  const js = [];
  source.replace(/<link\b([^>]*?)>/gi, (_tag, attrs) => {
    const rel = attrValue(attrs, 'rel').toLowerCase();
    const href = attrValue(attrs, 'href');
    if (!rel.split(/\s+/).includes('stylesheet') || href.includes('/assets/chatui.bundle.')) return '';
    const asset = normalizeLocalAsset(root, rootWithSep, href);
    if (asset) css.push(asset);
    return '';
  });
  source.replace(/<script\b([^>]*?)>\s*<\/script>/gi, (_tag, attrs) => {
    const src = attrValue(attrs, 'src');
    if (!src || src.includes('/assets/chatui.bundle.')) return '';
    const asset = normalizeLocalAsset(root, rootWithSep, src);
    if (asset) js.push(asset);
    return '';
  });
  const parsed = { css, js };
  manifestCache.set(cacheKey, parsed);
  return parsed[kind] || [];
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
  if (options.bundle || url.searchParams.has('v')) return IMMUTABLE_CACHE;
  if (filePath.endsWith('index.html')) return NO_CACHE;
  const ext = path.extname(filePath);
  if (['.html', '.js', '.css', '.json'].includes(ext)) return NO_CACHE;
  return SHORT_CACHE;
}

function rewriteCssUrls(css, assetUrlPath) {
  const assetDir = path.posix.dirname(assetUrlPath);
  return String(css || '').replace(/url\(\s*(['"]?)([^'"()]+)\1\s*\)/gi, (full, quote, rawUrl) => {
    const value = String(rawUrl || '').trim();
    if (!value || /^(?:data|blob|http|https):/i.test(value) || value.startsWith('//') || value.startsWith('/') || value.startsWith('#')) return full;
    const splitIndex = value.search(/[?#]/);
    const pathname = splitIndex >= 0 ? value.slice(0, splitIndex) : value;
    const suffix = splitIndex >= 0 ? value.slice(splitIndex) : '';
    const rewritten = path.posix.normalize(`${assetDir}/${pathname}`);
    return `url(${quote || ''}${rewritten.startsWith('/') ? rewritten : `/${rewritten}`}${suffix}${quote || ''})`;
  });
}

function bundleMetadata(root, rootWithSep, kind) {
  const markdownCoreScripts = kind === 'js'
    ? MARKDOWN_CORE_SCRIPT_PATHS.map(urlPath => ({ href: urlPath, urlPath, filePath: safeJoin(root, rootWithSep, urlPath) })).filter(asset => asset.filePath)
    : [];
  const assets = markdownCoreScripts.concat(parseAssetManifest(root, rootWithSep, kind));
  const parts = [`kind:${kind}`, `bundle:${BUNDLE_VERSION}`];
  const entries = assets.map((asset) => {
    const stat = fs.statSync(asset.filePath);
    parts.push(`${asset.urlPath}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
    return { ...asset, stat };
  });
  const signature = parts.join('|');
  return { entries, signature, etag: `"${sha1(signature).slice(0, 32)}"` };
}

function buildBundle(root, rootWithSep, kind) {
  const meta = bundleMetadata(root, rootWithSep, kind);
  const cacheKey = `${kind}:${meta.signature}`;
  const cached = bundleCache.get(cacheKey);
  if (cached) return cached;
  const body = Buffer.from(meta.entries.map((asset) => {
    const content = fs.readFileSync(asset.filePath, 'utf8');
    if (kind === 'css') return `\n/* ${asset.urlPath} */\n${rewriteCssUrls(content, asset.urlPath)}\n`;
    return `\n;\n/* ${asset.urlPath} */\n${content}\n`;
  }).join(''), 'utf8');
  const result = { body, etag: meta.etag, cacheKey };
  bundleCache.set(cacheKey, result);
  trimCache(bundleCache, 12);
  return result;
}

function serveBundle(req, res, context, kind) {
  const mime = kind === 'css' ? MIME['.css'] : MIME['.js'];
  let bundle;
  try {
    bundle = buildBundle(context.root, context.rootWithSep, kind);
  } catch (err) {
    console.error('[static] failed to build asset bundle:', err);
    return send(res, 500, 'Failed to build asset bundle');
  }
  const headers = {
    'Content-Type': mime,
    'Cache-Control': IMMUTABLE_CACHE,
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

module.exports = { MIME, safeJoin, pickCompressedStaticFile, serveStatic };
