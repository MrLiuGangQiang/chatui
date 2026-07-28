(function initChatUIMarkdownLinkPolicy(global) {
  'use strict';

  const SAFE_RASTER_DATA_URI = /^data:image\/(?:png|gif|jpe?g|webp);base64,[a-z0-9+/]+={0,2}$/i;
  const URL_CONTROL_CHARACTERS = /[\u0000-\u0020\u007f-\u009f]/g;
  const EXPLICIT_SCHEME = /^([a-z][a-z0-9+.-]*):/i;

  function normalizedUrlForPolicy(url = '') {
    return String(url || '').trim().replace(URL_CONTROL_CHARACTERS, '');
  }

  function isSafeNavigationUrl(url = '') {
    const href = normalizedUrlForPolicy(url);
    if (!href) return true;
    const scheme = href.match(EXPLICIT_SCHEME)?.[1]?.toLowerCase() || '';
    return !scheme || ['http', 'https', 'mailto', 'tel'].includes(scheme);
  }

  function isSafeRasterImageDataUri(url = '') {
    return SAFE_RASTER_DATA_URI.test(String(url || '').trim());
  }

  function isSafeResourceUrl(url = '', { allowRasterData = false, allowBlob = true } = {}) {
    const src = normalizedUrlForPolicy(url);
    if (!src) return true;
    if (allowRasterData && isSafeRasterImageDataUri(src)) return true;
    const scheme = src.match(EXPLICIT_SCHEME)?.[1]?.toLowerCase() || '';
    if (!scheme) return true;
    return scheme === 'http' || scheme === 'https' || allowBlob && scheme === 'blob';
  }

  function isSafeMarkdownLink(url = '') {
    return isSafeNavigationUrl(url) || isSafeRasterImageDataUri(url);
  }

  function shouldKeepSanitizedUrl(node = {}, attributeName = '', value = '') {
    const attr = String(attributeName || '').toLowerCase();
    const tag = String(node?.nodeName || node?.tagName || '').toLowerCase();
    if (attr === 'srcset') return false;
    if (attr === 'href' || attr === 'xlink:href') return isSafeNavigationUrl(value);
    if (attr === 'src') return isSafeResourceUrl(value, { allowRasterData: tag === 'img' });
    if (['poster', 'background', 'longdesc'].includes(attr)) return isSafeResourceUrl(value);
    if (['action', 'formaction'].includes(attr)) return isSafeNavigationUrl(value);
    return true;
  }

  const api = Object.freeze({
    SAFE_RASTER_DATA_URI,
    normalizedUrlForPolicy,
    isSafeNavigationUrl,
    isSafeRasterImageDataUri,
    isSafeResourceUrl,
    isSafeMarkdownLink,
    shouldKeepSanitizedUrl,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.ChatUIMarkdownLinkPolicy = api;
})(typeof window !== 'undefined' ? window : globalThis);
