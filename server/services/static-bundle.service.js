const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
  '/vendor/highlight-common.min.js',
  '/vendor/katex.min.js',
]);

const manifestCache = new Map();
const assetHashCache = new Map();

function staticPathOutsideRootError(filePath = '') {
  const err = new Error('Static asset resolves outside the configured root');
  err.code = 'STATIC_PATH_OUTSIDE_ROOT';
  err.statusCode = 403;
  err.filePath = filePath;
  return err;
}

function canonicalRootPath(root) {
  const canonical = fs.realpathSync(root);
  if (!fs.statSync(canonical).isDirectory()) throw new Error('Static root is not a directory');
  return canonical;
}

function isPathWithinCanonicalRoot(filePath, canonicalRoot) {
  const relative = path.relative(canonicalRoot, filePath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolvePathWithinRoot(filePath, canonicalRoot) {
  const canonical = fs.realpathSync(filePath);
  if (!isPathWithinCanonicalRoot(canonical, canonicalRoot)) throw staticPathOutsideRootError(filePath);
  return canonical;
}

function trimCache(cache, maxEntries) {
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}

function statSignature(stat = {}) {
  return `${Number(stat.size || 0)}:${Number(stat.mtimeMs || 0)}:${Number(stat.ctimeMs || 0)}:${String(stat.ino || '')}`;
}

function cachedFileHash(filePath, stat = fs.statSync(filePath)) {
  const signature = statSignature(stat);
  const cached = assetHashCache.get(filePath);
  if (cached?.signature === signature) return cached.hash;
  const hash = sha1(fs.readFileSync(filePath));
  assetHashCache.delete(filePath);
  assetHashCache.set(filePath, { signature, hash });
  trimCache(assetHashCache, 512);
  return hash;
}

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
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

function parseAssetManifest(root, rootWithSep, kind, options = {}) {
  const canonicalRoot = options.canonicalRoot || canonicalRootPath(root);
  const indexPath = resolvePathWithinRoot(path.join(root, 'index.html'), canonicalRoot);
  const indexStat = fs.statSync(indexPath);
  const indexSignature = statSignature(indexStat);
  const cached = manifestCache.get(indexPath);
  if (cached?.signature === indexSignature) {
    for (const entries of Object.values(cached.parsed)) {
      for (const entry of entries) resolvePathWithinRoot(entry.filePath, canonicalRoot);
    }
    return cached.parsed[kind] || [];
  }
  const source = fs.readFileSync(indexPath, 'utf8');

  const manifest = manifestSource(source);
  const css = [];
  const js = [];
  manifest.replace(/<link\b([^>]*?)>/gi, (_tag, attrs) => {
    const rel = attrValue(attrs, 'rel').toLowerCase();
    const href = attrValue(attrs, 'href');
    if (!rel.split(/\s+/).includes('stylesheet') || href.includes('/assets/chatui.bundle.')) return '';
    const asset = resolveBundleEntry(root, rootWithSep, href);
    if (asset) {
      resolvePathWithinRoot(asset.filePath, canonicalRoot);
      css.push(asset);
    }
    return '';
  });
  manifest.replace(/<script\b([^>]*?)>\s*<\/script>/gi, (_tag, attrs) => {
    const src = attrValue(attrs, 'src');
    if (!src || src.includes('/assets/chatui.bundle.')) return '';
    const asset = resolveBundleEntry(root, rootWithSep, src);
    if (asset) {
      resolvePathWithinRoot(asset.filePath, canonicalRoot);
      js.push(asset);
    }
    return '';
  });
  const parsed = { css, js };
  manifestCache.delete(indexPath);
  manifestCache.set(indexPath, { signature: indexSignature, parsed });
  trimCache(manifestCache, 32);
  return parsed[kind] || [];
}

function bundleCacheKey(kind, signature) {
  return `${kind}:${signature}`;
}

function bundleMetadata(root, rootWithSep, kind, options = {}) {
  const canonicalRoot = options.canonicalRoot || canonicalRootPath(root);
  const markdownCoreScripts = kind === 'js'
    ? MARKDOWN_CORE_SCRIPT_PATHS
      .map(urlPath => ({ href: urlPath, urlPath, filePath: safeJoin(root, rootWithSep, urlPath) }))
      .filter(asset => asset.filePath && fs.existsSync(asset.filePath))
    : [];
  const assets = markdownCoreScripts.concat(parseAssetManifest(root, rootWithSep, kind, { canonicalRoot }));
  const parts = [`kind:${kind}`, `bundle:${BUNDLE_VERSION}`];
  const entries = assets.map((asset) => {
    const canonicalFilePath = resolvePathWithinRoot(asset.filePath, canonicalRoot);
    const stat = fs.statSync(canonicalFilePath);
    const contentHash = cachedFileHash(canonicalFilePath, stat);
    parts.push(`${asset.urlPath}:${contentHash}`);
    return { ...asset, filePath: canonicalFilePath, stat, contentHash };
  });
  const signature = parts.join('|');
  return { entries, signature, etag: `"${sha1(signature).slice(0, 32)}"` };
}

function clearBundleMetadataCaches() {
  manifestCache.clear();
  assetHashCache.clear();
}

function bundleRevision(root, rootWithSep, kind) {
  const etag = bundleMetadata(root, rootWithSep, kind).etag;
  return String(etag).replace(/^W?"|"$/g, '');
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

function buildBundleBody(entries, kind, options = {}) {
  return Buffer.from((entries || []).map((asset) => {
    const filePath = options.canonicalRoot
      ? resolvePathWithinRoot(asset.filePath, options.canonicalRoot)
      : asset.filePath;
    const content = fs.readFileSync(filePath, 'utf8');
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
  parseAssetManifest,
  resolveBundleEntry,
  bundleMetadata,
  bundleCacheKey,
  buildBundleBody,
  bundleRevision,
  contentTypeForBundle,
  statSignature,
  cachedFileHash,
  clearBundleMetadataCaches,
  staticPathOutsideRootError,
  canonicalRootPath,
  isPathWithinCanonicalRoot,
  resolvePathWithinRoot,
};
