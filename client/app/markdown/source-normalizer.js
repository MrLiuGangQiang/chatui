(function initChatUIMarkdownSourceNormalizer(global) {
  'use strict';

  function normalizeEscapedUrlSlashes(markdown = '') {
    return String(markdown || '').replace(/\b((?:https?:|mailto:|tel:)\\\/\\\/[^\s<>()\[\]{}"']+)/gi, all => all.replace(/\\\//g, '/'));
  }

  function encodeUtf8Base64(value = '') {
    if (typeof Buffer !== 'undefined') return Buffer.from(String(value), 'utf8').toString('base64');
    if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(String(value))));
    return '';
  }

  function normalizeMultilineMarkdownImageDataUris(markdown = '') {
    return String(markdown || '').replace(/!\[([^\]\n]*)\]\s*\n+\s*\(\s*(data:image\/(?:png|gif|jpe?g|webp|svg\+xml);base64,[A-Za-z0-9+/=\s]+)\s*\)/gi, (_all, alt, uri) => {
      const compact = String(uri || '').replace(/\s+/g, '');
      return `![${alt}](${compact})`;
    });
  }

  function normalizeMarkdownImageDataUris(markdown = '') {
    const src = String(markdown || '');
    const pattern = /(!\[[^\]\n]*\]\()data:image\/svg\+xml;(?:charset=)?utf-?8,([\s\S]*?<\/svg>)\)/gi;
    return src.replace(pattern, (all, prefix, svg) => {
      const encoded = encodeUtf8Base64(String(svg || '').trim());
      return encoded ? `${prefix}data:image/svg+xml;base64,${encoded})` : all;
    });
  }

  function normalizeMarkdownSource(markdown = '') {
    return normalizeMarkdownImageDataUris(normalizeMultilineMarkdownImageDataUris(normalizeEscapedUrlSlashes(markdown)));
  }

  const api = Object.freeze({
    normalizeEscapedUrlSlashes,
    encodeUtf8Base64,
    normalizeMultilineMarkdownImageDataUris,
    normalizeMarkdownImageDataUris,
    normalizeMarkdownSource,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.ChatUIMarkdownSourceNormalizer = api;
})(typeof window !== 'undefined' ? window : globalThis);
