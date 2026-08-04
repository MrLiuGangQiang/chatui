(function initChatUIMarkdownEnginePrimitives(root) {
  'use strict';

  const MERMAID_LANGS = new Set([
    'mermaid', 'flowchart', 'graph', 'sequencediagram', 'classdiagram',
    'statediagram', 'erdiagram', 'gantt', 'pie', 'journey', 'gitgraph',
    'mindmap', 'timeline', 'quadrantchart', 'xychart-beta', 'xychart',
    'sankey-beta', 'sankey', 'radar-beta', 'architecture-beta',
  ]);

  function applyTaskListFallback(html = '') {
    return String(html || '')
      .replace(/<li>(\[[ xX]\]\s*)([\s\S]*?)<\/li>/g, (_all, marker, body) => {
        const checked = /x/i.test(marker);
        return `<li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox" disabled${checked ? ' checked' : ''}> ${body}</li>`;
      })
      .replace(/<ul>\s*<li class="task-list-item">/g, '<ul class="contains-task-list">\n<li class="task-list-item">');
  }

  function normalizeTableAlignToken(token) {
    const style = token.attrGet('style') || '';
    const match = style.match(/(?:^|;)\s*text-align\s*:\s*(left|center|right)\s*(?:;|$)/i);
    if (match) {
      const nextStyle = style.replace(/(?:^|;)\s*text-align\s*:\s*(?:left|center|right)\s*;?/ig, '').trim();
      if (nextStyle) token.attrSet('style', nextStyle);
      else {
        const styleIndex = token.attrIndex('style');
        if (styleIndex >= 0) token.attrs.splice(styleIndex, 1);
      }
    }
    const cls = `md-align-${match ? match[1].toLowerCase() : 'left'}`;
    const current = token.attrGet('class') || '';
    if (!current.split(/\s+/).some(name => /^md-align-(?:left|center|right)$/.test(name))) {
      token.attrSet('class', [current, cls].filter(Boolean).join(' '));
    }
  }

  function normalizeBlockquoteFencedCodeContent(code = '') {
    const src = String(code || '').replace(/\r\n?/g, '\n');
    const lines = src.split('\n');
    const contentLines = lines.filter(line => line.length > 0);
    if (!contentLines.length) return code;
    const quotePrefixed = contentLines.filter(line => /^\s{0,3}> ?/.test(line));
    if (quotePrefixed.length !== contentLines.length) return code;
    const nonReplQuotePrefixed = quotePrefixed.filter(line => !/^\s{0,3}>>>/.test(line));
    if (!nonReplQuotePrefixed.length) return code;
    return lines.map(line => line.replace(/^(\s{0,3})> ?/, '$1')).join('\n');
  }

  function decodeHtmlEntities(html = '') {
    return String(html || '').replace(/&(?:#x([0-9a-f]+)|#(\d+)|amp|lt|gt|quot|#39|apos|#96);/gi, (all, hex, dec) => {
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      if (dec) return String.fromCodePoint(parseInt(dec, 10));
      return ({
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#39;': "'",
        '&apos;': "'",
        '&#96;': '`',
      })[all.toLowerCase()] || all;
    });
  }

  function highlightedTextMatchesSource(highlighted = '', source = '') {
    return decodeHtmlEntities(String(highlighted || '').replace(/<[^>]*>/g, '')) === String(source || '');
  }

  const api = Object.freeze({
    MERMAID_LANGS,
    applyTaskListFallback,
    normalizeTableAlignToken,
    normalizeBlockquoteFencedCodeContent,
    decodeHtmlEntities,
    highlightedTextMatchesSource,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('markdownEnginePrimitives', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
