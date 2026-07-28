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

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>"'`]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[ch]));
  }

  function isFenceLine(line = '') {
    const match = String(line || '').match(/^\s*(`{3,}|~{3,})/);
    return match ? match[1] : '';
  }

  function normalizeDetailsContainers(markdown = '') {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let detailsDepth = 0;
    let fence = '';
    for (const line of lines) {
      const fenceMarker = isFenceLine(line);
      if (fenceMarker) {
        if (!fence) fence = fenceMarker[0];
        else if (fenceMarker[0] === fence) fence = '';
        out.push(line);
        continue;
      }
      if (!fence) {
        const open = line.match(/^\s*:::\s*(?:details|detail|fold|collapse|collapsible)\s*(.*?)\s*$/i);
        if (open) {
          detailsDepth += 1;
          const summary = open[1] || '详情';
          out.push('<details>', `<summary>${escapeHtml(summary)}</summary>`, '');
          continue;
        }
        if (detailsDepth > 0 && /^\s*:::\s*$/.test(line)) {
          if (out.length && out[out.length - 1] !== '') out.push('');
          out.push('</details>');
          detailsDepth -= 1;
          continue;
        }
      }
      out.push(line);
    }
    while (detailsDepth-- > 0) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push('</details>');
    }
    return out.join('\n');
  }

  function normalizeNativeDetailsMarkdown(markdown = '') {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let fence = '';
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const fenceMarker = isFenceLine(line);
      if (fenceMarker) {
        if (!fence) fence = fenceMarker[0];
        else if (fenceMarker[0] === fence) fence = '';
        out.push(line);
        continue;
      }
      if (!fence && /<\/summary>\s*$/i.test(line) && lines[i + 1] != null && String(lines[i + 1]).trim() !== '') {
        out.push(line, '');
        continue;
      }
      if (!fence && /^\s*<\/details>\s*$/i.test(line) && out.length && out[out.length - 1] !== '') out.push('');
      out.push(line);
    }
    return out.join('\n');
  }

  function normalizeMarkdownSource(markdown = '') {
    return normalizeMarkdownImageDataUris(normalizeMultilineMarkdownImageDataUris(normalizeNativeDetailsMarkdown(normalizeDetailsContainers(normalizeEscapedUrlSlashes(markdown)))));
  }

  const api = Object.freeze({
    normalizeEscapedUrlSlashes,
    encodeUtf8Base64,
    normalizeMultilineMarkdownImageDataUris,
    normalizeMarkdownImageDataUris,
    normalizeDetailsContainers,
    normalizeNativeDetailsMarkdown,
    normalizeMarkdownSource,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.ChatUIMarkdownSourceNormalizer = api;
})(typeof window !== 'undefined' ? window : globalThis);
