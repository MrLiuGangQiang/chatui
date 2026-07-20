const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ASSET_MANIFEST_ID = 'chatuiAssetManifest';
const BUNDLE_VERSION = '1.3.136-welcome-encoding-refresh';
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
    const asset = resolveBundleEntry(root, rootWithSep, href);
    if (asset) css.push(asset);
    return '';
  });
  source.replace(/<script\b([^>]*?)>\s*<\/script>/gi, (_tag, attrs) => {
    const src = attrValue(attrs, 'src');
    if (!src || src.includes('/assets/chatui.bundle.')) return '';
    const asset = resolveBundleEntry(root, rootWithSep, src);
    if (asset) js.push(asset);
    return '';
  });
  const parsed = { css, js };
  manifestCache.set(cacheKey, parsed);
  return parsed[kind] || [];
}

function bundleCacheKey(kind, signature) {
  return `${kind}:${signature}`;
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
  parseAssetManifest,
  resolveBundleEntry,
  bundleMetadata,
  bundleCacheKey,
  buildBundleBody,
  contentTypeForBundle,
};
