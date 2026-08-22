const fs = require('fs');
const path = require('path');
const { safeJoin, sha1 } = require('../http/static-path-utils');

const ASSET_MANIFEST_ID = 'chatuiAssetManifest';
// Kept as a bundle namespace for compatibility metadata. Browser URLs use the
// content-addressed revision from bundleMetadata(), so source changes never
// depend on manually bumping this value.
const BUNDLE_VERSION = '1.3.160-code-action-motion';
const BUNDLE_PATHS = Object.freeze({
  '/assets/chatui.bundle.css': 'css',
  '/assets/chatui.bundle.js': 'js',
});
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
]);
// These large enhancement runtimes are intentionally not concatenated into the
// primary application bundle. The browser dependency loader fetches the same
// self-hosted files during Markdown bootstrap, so code highlighting and math
// rendering keep their existing behavior without making every browser parse
// them as part of chatui.bundle.js.
const DEFERRED_MARKDOWN_SCRIPT_PATHS = Object.freeze([
  '/vendor/highlight-common.min.js',
  '/vendor/katex.min.js',
]);

const manifestCache = new Map();
const fileFingerprintCache = new Map();
const MAX_MANIFEST_CACHE_ENTRIES = 16;
const MAX_FILE_FINGERPRINT_CACHE_ENTRIES = 512;

function trimCache(cache, maxEntries) {
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}

function statFingerprint(stat = {}) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].map(value => String(value ?? '')).join(':');
}

function readFileFingerprint(filePath, { encoding = '', retainContent = false } = {}) {
  const stat = fs.statSync(filePath);
  const fingerprint = statFingerprint(stat);
  const cached = fileFingerprintCache.get(filePath);
  const hasReusableContent = !retainContent
    || (cached && cached.encoding === encoding && Object.prototype.hasOwnProperty.call(cached, 'content'));
  if (cached?.fingerprint === fingerprint && hasReusableContent) {
    fileFingerprintCache.delete(filePath);
    fileFingerprintCache.set(filePath, cached);
    return { stat, contentHash: cached.contentHash, ...(retainContent ? { content: cached.content } : {}) };
  }

  const content = encoding ? fs.readFileSync(filePath, encoding) : fs.readFileSync(filePath);
  const entry = {
    fingerprint,
    contentHash: sha1(content),
    ...(retainContent ? { content, encoding } : {}),
  };
  fileFingerprintCache.delete(filePath);
  fileFingerprintCache.set(filePath, entry);
  trimCache(fileFingerprintCache, MAX_FILE_FINGERPRINT_CACHE_ENTRIES);
  return { stat, contentHash: entry.contentHash, ...(retainContent ? { content } : {}) };
}

function attrValue(source, name) {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = String(source || '').match(pattern);
  return match ? (match[2] ?? match[3] ?? match[4] ?? '') : '';
}

function resolveBundleEntry(root, rootWithSep, href) {
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
  const observed = readFileFingerprint(indexPath, { encoding: 'utf8', retainContent: true });
  const source = observed.content;
  const cacheKey = `${indexPath}:${observed.contentHash}`;
  const cached = manifestCache.get(cacheKey);
  if (cached) return cached[kind] || [];

  const manifest = manifestSource(source);
  const css = [];
  const js = [];
  manifest.replace(/<link\b([^>]*?)>/gi, (_tag, attrs) => {
    const rel = attrValue(attrs, 'rel').toLowerCase();
    const href = attrValue(attrs, 'href');
    if (!rel.split(/\s+/).includes('stylesheet') || href.includes('/assets/chatui.bundle.')) return '';
    const asset = resolveBundleEntry(root, rootWithSep, href);
    if (asset) css.push(asset);
    return '';
  });
  manifest.replace(/<script\b([^>]*?)>\s*<\/script>/gi, (_tag, attrs) => {
    const src = attrValue(attrs, 'src');
    if (!src || src.includes('/assets/chatui.bundle.')) return '';
    const asset = resolveBundleEntry(root, rootWithSep, src);
    if (asset) js.push(asset);
    return '';
  });
  const parsed = { css, js };
  manifestCache.set(cacheKey, parsed);
  trimCache(manifestCache, MAX_MANIFEST_CACHE_ENTRIES);
  return parsed[kind] || [];
}

function bundleCacheKey(kind, signature) {
  return `${kind}:${signature}`;
}

function bundleMetadata(root, rootWithSep, kind) {
  const markdownCoreScripts = kind === 'js'
    ? MARKDOWN_CORE_SCRIPT_PATHS
      .map(urlPath => ({ href: urlPath, urlPath, filePath: safeJoin(root, rootWithSep, urlPath) }))
      .filter(asset => asset.filePath && fs.existsSync(asset.filePath))
    : [];
  const assets = markdownCoreScripts.concat(parseAssetManifest(root, rootWithSep, kind));
  const parts = [`kind:${kind}`, `bundle:${BUNDLE_VERSION}`];
  const entries = assets.map((asset) => {
    const { stat, contentHash } = readFileFingerprint(asset.filePath);
    parts.push(`${asset.urlPath}:${contentHash}`);
    return { ...asset, stat, contentHash };
  });
  const signature = parts.join('|');
  return { entries, signature, etag: `"${sha1(signature).slice(0, 32)}"` };
}

function bundleRevision(root, rootWithSep, kind) {
  const etag = bundleMetadata(root, rootWithSep, kind).etag;
  return String(etag).replace(/^W?"|"$/g, '');
}

// Request-path metadata cache. bundleMetadata stats every manifest asset to
// detect changes; the index page and both bundle URLs would each pay that
// full scan per request (~160 statSync calls per page load). A short TTL
// keeps deploys fresh within a second while collapsing a page load (and any
// burst of index/bundle requests) into a single scan. ttlMs 0 disables
// caching; tests can inject `now` for deterministic expiry.
const BUNDLE_METADATA_TTL_MS = Math.max(0, Number(process.env.STATIC_BUNDLE_METADATA_TTL_MS || 1000));
const metadataRequestCache = new Map(); // `${root}|${kind}` -> { at, value }
const MAX_METADATA_REQUEST_CACHE_ENTRIES = 8;

function bundleMetadataCached(root, rootWithSep, kind, { ttlMs = BUNDLE_METADATA_TTL_MS, now = Date.now() } = {}) {
  if (!(ttlMs > 0)) return bundleMetadata(root, rootWithSep, kind);
  const key = `${root}|${kind}`;
  const cached = metadataRequestCache.get(key);
  if (cached && now - cached.at < ttlMs) return cached.value;
  const value = bundleMetadata(root, rootWithSep, kind);
  metadataRequestCache.delete(key);
  metadataRequestCache.set(key, { at: now, value });
  trimCache(metadataRequestCache, MAX_METADATA_REQUEST_CACHE_ENTRIES);
  return value;
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

function buildBundleBody(entries, kind) {
  return Buffer.from((entries || []).map((asset) => {
    const content = fs.readFileSync(asset.filePath, 'utf8');
    if (kind === 'css') return `\n/* ${asset.urlPath} */\n${rewriteCssUrls(content, asset.urlPath)}\n`;
    return `\n;\n/* ${asset.urlPath} */\n${content}\n`;
  }).join(''), 'utf8');
}

function contentTypeForBundle(kind) {
  return kind === 'css' ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8';
}

module.exports = {
  BUNDLE_PATHS,
  BUNDLE_VERSION,
  MARKDOWN_CORE_SCRIPT_PATHS,
  DEFERRED_MARKDOWN_SCRIPT_PATHS,
  parseAssetManifest,
  resolveBundleEntry,
  bundleMetadata,
  bundleMetadataCached,
  BUNDLE_METADATA_TTL_MS,
  bundleCacheKey,
  buildBundleBody,
  bundleRevision,
  contentTypeForBundle,
  readFileFingerprint,
};
