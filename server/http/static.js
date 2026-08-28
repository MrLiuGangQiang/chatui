const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { send } = require('./response');
const { safeJoin, sha1 } = require('./static-path-utils');
const {
  BUNDLE_PATHS,
  bundleMetadata,
  bundleMetadataCached,
  bundleCacheKey,
  buildBundleBody,
  bundleRevision,
  contentTypeForBundle,
  readFileFingerprint,
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
const NO_STORE = 'no-store, no-cache, max-age=0, must-revalidate, proxy-revalidate';
const BUNDLE_IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const bundleCache = new Map();
const encodedBodyCache = new Map();
const PUBLIC_ROOT_FILES = new Set(['/index.html', '/favicon.svg', '/styles.css', '/app.js']);
const PUBLIC_PREFIXES = ['/client/', '/shared/', '/styles/', '/vendor/', '/assets/', '/pages/'];

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

function pickCompressedStaticFile(req, filePath, sourceStat = null) {
  const encoding = String(req.headers['accept-encoding'] || '');
  const ext = path.extname(filePath);
  const resolvedSourceStat = sourceStat || fs.statSync(filePath);
  if (!['.js', '.css'].includes(ext)) return { filePath, encoding: '', stat: resolvedSourceStat };
  const freshVariant = (suffix) => {
    const variantPath = `${filePath}${suffix}`;
    try {
      const stat = fs.statSync(variantPath);
      return stat.mtimeMs >= resolvedSourceStat.mtimeMs ? { filePath: variantPath, stat } : null;
    } catch {
      return null;
    }
  };
  const br = /\bbr\b/.test(encoding) ? freshVariant('.br') : null;
  if (br) return { ...br, encoding: 'br' };
  const gzip = /\bgzip\b/.test(encoding) ? freshVariant('.gz') : null;
  if (gzip) return { ...gzip, encoding: 'gzip' };
  return { filePath, encoding: '', stat: resolvedSourceStat };
}

function parseRequestUrl(req) {
  try {
    return new URL(req.url, 'http://chatui.local');
  } catch {
    return null;
  }
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
  // Executable assets and the generated entrypoint must always revalidate. The
  // entrypoint receives content-addressed bundle URLs at request time, while
  // direct module URLs retain their manually documented revisions for tooling.
  // Bundles are the exception once the request names the exact content hash:
  // index.html rewrites bundle URLs to ?v=<content etag> on every request, so
  // a matching revision pins immutable content and may be cached for a year.
  // Bare bundle URLs and mismatched revisions keep no-store so shared caches
  // can never pin stale content across deployments.
  if (options.bundle) return options.bundleRevisionMatched ? BUNDLE_IMMUTABLE_CACHE : NO_STORE;
  if (filePath.endsWith('.html')) return NO_STORE;
  const ext = path.extname(filePath);
  if (['.html', '.js', '.css', '.json'].includes(ext)) return NO_STORE;
  return SHORT_CACHE;
}

function buildBundle(root, rootWithSep, kind) {
  const meta = bundleMetadataCached(root, rootWithSep, kind);
  const cacheKey = bundleCacheKey(kind, meta.signature);
  const cached = bundleCache.get(cacheKey);
  if (cached) return cached;
  const body = buildBundleBody(meta.entries, kind);
  const result = { body, etag: meta.etag, cacheKey };
  bundleCache.set(cacheKey, result);
  trimCache(bundleCache, 12);
  return result;
}

function rewriteBundleUrls(html, root, rootWithSep) {
  const revisions = {
    css: bundleRevision(root, rootWithSep, 'css'),
    js: bundleRevision(root, rootWithSep, 'js'),
  };
  const source = String(html || '');
  return source
    .replace(/(\.\/assets\/chatui\.bundle\.css)(?:\?[^"']*)?/g, `$1?v=${revisions.css}`)
    .replace(/(\.\/assets\/chatui\.bundle\.js)(?:\?[^"']*)?/g, `$1?v=${revisions.js}`);
}

function revisionFromMetadata(meta) {
  return String(meta?.etag || '').replace(/^W?"|"$/g, '');
}

// Rendered index pages are cached by (index content hash, css revision, js
// revision). Previously every index request re-read index.html and re-statted
// every manifest asset twice (once per bundle kind) to rebuild identical
// output. The bundle metadata TTL cache bounds revision freshness to ~1s,
// which is safe because index.html and bundles are served with no-cache and
// revalidated on every load anyway.
const renderedIndexCache = new Map();
const MAX_RENDERED_INDEX_ENTRIES = 8;

function renderIndexPage(context) {
  const filePath = path.join(context.root, 'index.html');
  const observed = readFileFingerprint(filePath, { encoding: 'utf8', retainContent: true });
  const revisions = {
    css: revisionFromMetadata(bundleMetadataCached(context.root, context.rootWithSep, 'css')),
    js: revisionFromMetadata(bundleMetadataCached(context.root, context.rootWithSep, 'js')),
  };
  const identity = context.buildIdentity && typeof context.buildIdentity === 'object'
    ? {
        version: String(context.buildIdentity.version || ''),
        gitSha: String(context.buildIdentity.gitSha || ''),
        sourceRevision: String(context.buildIdentity.sourceRevision || ''),
      }
    : null;
  const identityKey = identity ? JSON.stringify(identity) : '';
  const cacheKey = `${observed.contentHash}:${revisions.css}:${revisions.js}:${identityKey}`;
  const cached = renderedIndexCache.get(cacheKey);
  if (cached) return cached;
  const source = String(observed.content || '');
  let body = source
    .replace(/(\.\/assets\/chatui\.bundle\.css)(?:\?[^"']*)?/g, `$1?v=${revisions.css}`)
    .replace(/(\.\/assets\/chatui\.bundle\.js)(?:\?[^"']*)?/g, `$1?v=${revisions.js}`);
  // The page itself is the only piece that can tell an already-cached old
  // bundle which server build it belongs to. The browser runtime compares this
  // marker with /api/version before restoring sessions or resuming jobs.
  if (identity?.sourceRevision) {
    const marker = `<script>window.__CHATUI_ENTRY_IDENTITY=${JSON.stringify(identity)};</script>`;
    body = body.includes('</head>') ? body.replace('</head>', `${marker}</head>`) : `${marker}${body}`;
  }
  const rendered = { body, etag: `"${sha1(body).slice(0, 32)}"` };
  renderedIndexCache.set(cacheKey, rendered);
  trimCache(renderedIndexCache, MAX_RENDERED_INDEX_ENTRIES);
  return rendered;
}

function serveIndex(req, res, context) {
  let rendered;
  try {
    rendered = renderIndexPage(context);
  } catch (err) {
    console.error('[static] failed to render index bundle URLs:', err);
    return send(res, 500, 'Failed to render index');
  }
  const headers = {
    'Content-Type': MIME['.html'],
    'Cache-Control': NO_STORE,
    'Surrogate-Control': 'no-store',
    ETag: rendered.etag,
  };
  if (isFresh(req, rendered.etag)) return send(res, 304, '', headers);
  if (req.method === 'HEAD') return send(res, 200, '', headers);
  return send(res, 200, rendered.body, headers);
}

function requestedBundleRevision(url) {
  try {
    return String(new URL(url, 'http://chatui.local').searchParams.get('v') || '').trim();
  } catch {
    return '';
  }
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
  // The ETag is the exact content revision that index.html hands out as ?v=.
  // Only a request naming that same revision may be cached immutably; bare
  // or mismatched revisions keep no-store.
  const bundleRevisionMatched = requestedBundleRevision(req.url) === bundle.etag.replace(/^W?"|"$/g, '');
  const headers = {
    'Content-Type': mime,
    'Cache-Control': cacheControlFor('', null, { bundle: true, bundleRevisionMatched }),
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
  return `W/"${sha1(`${filePath}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${encoding}`).slice(0, 24)}"`;
}

function serveStatic(req, res, { root, rootWithSep, buildIdentity = null }) {
  const url = parseRequestUrl(req);
  if (!url) return send(res, 400, 'Bad Request');
  const bundleKind = BUNDLE_PATHS[url.pathname];
  if (bundleKind) return serveBundle(req, res, { root, rootWithSep }, bundleKind);
  // A unique, build-addressed entry URL bypasses stale intermediary cache
  // keys. It is intentionally routed to the same canonical index renderer;
  // only the browser navigation URL changes, never static file resolution.
  if (/^\/__chatui\/[a-z0-9:%_-]{8,160}\/?$/i.test(url.pathname)) {
    return serveIndex(req, res, { root, rootWithSep, buildIdentity });
  }
  if (url.pathname === '/' || url.pathname === '/index.html') return serveIndex(req, res, { root, rootWithSep, buildIdentity });
  if (!isPublicStaticPath(url.pathname)) return send(res, 404, 'Not Found');

  const filePath = safeJoin(root, rootWithSep, url.pathname);
  if (!filePath) return send(res, 403, 'Forbidden');

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) return send(res, 404, 'Not Found');
    let picked;
    try {
      picked = pickCompressedStaticFile(req, filePath, stat);
    } catch {
      picked = { filePath, encoding: '', stat };
    }
    const servedFilePath = picked.filePath || filePath;
    const servedStat = picked.stat || stat;
    const mime = MIME[path.extname(filePath)] || 'application/octet-stream';
    const etag = staticEtag(servedFilePath, servedStat, picked.encoding || preferredEncoding(req));
    const headers = {
      'Content-Type': mime,
      'Cache-Control': cacheControlFor(filePath, url),
      ETag: etag,
      Vary: 'Accept-Encoding',
    };
    if (picked.encoding) headers['Content-Encoding'] = picked.encoding;
    if (isFresh(req, etag)) return send(res, 304, '', headers);
    if (req.method === 'HEAD') return send(res, 200, '', headers);

    fs.readFile(servedFilePath, (err, data) => {
      if (err) return send(res, 404, 'Not Found');
      const cacheKey = `${servedFilePath}:${servedStat.size}:${servedStat.mtimeMs}:${servedStat.ctimeMs}`;
      const encoded = picked.encoding ? { body: data, encoding: picked.encoding } : encodeBody(data, preferredEncoding(req), cacheKey, mime);
      if (encoded.encoding) headers['Content-Encoding'] = encoded.encoding;
      send(res, 200, encoded.body, headers);
    });
  });
}

module.exports = { MIME, SHORT_CACHE, NO_CACHE, NO_STORE, cacheControlFor, safeJoin, isPublicStaticPath, pickCompressedStaticFile, rewriteBundleUrls, serveIndex, serveStatic };
