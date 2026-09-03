(function initChatUIMarkdownEnginePrimitives(root) {
  'use strict';

  const MERMAID_LANGS = new Set([
    'mermaid', 'flowchart', 'graph', 'sequencediagram', 'classdiagram',
    'statediagram', 'erdiagram', 'gantt', 'pie', 'journey', 'gitgraph',
    'mindmap', 'timeline', 'quadrantchart', 'xychart-beta', 'xychart',
    'sankey-beta', 'sankey', 'radar-beta', 'architecture-beta',
  ]);

  // Markdown-it/CommonMark treat Unicode punctuation and symbols as punctuation
  // while only a fixed set of characters counts as whitespace. Keep the same
  // definitions so the compact-emphasis repair below mirrors the parser.
  const MD_WHITESPACE_RE = /[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/u;
  const MD_PUNCT_OR_SYMBOL_RE = /[\p{P}\p{S}]/u;

  function isMarkdownWhitespaceChar(value = '') {
    return MD_WHITESPACE_RE.test(String(value || ''));
  }

  function isMarkdownPunctOrSymbolChar(value = '') {
    return MD_PUNCT_OR_SYMBOL_RE.test(String(value || ''));
  }

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

  function markerRunLength(src = '', start = 0) {
    const marker = src[start];
    let end = start + 1;
    while (end < src.length && src[end] === marker) end += 1;
    return end - start;
  }

  function findClosingMarkerRun(src = '', from = 0, marker = '', length = 0) {
    let index = from;
    while (index < src.length) {
      if (src[index] === '\\') {
        index += 2;
        continue;
      }
      if (src[index] !== marker) {
        index += 1;
        continue;
      }
      if (markerRunLength(src, index) !== length) {
        index += 1;
        continue;
      }
      return index;
    }
    return -1;
  }

  // Markdown-it follows CommonMark flanking rules. A run like **当前天气：**多云
  // stays literal because the closing ** is preceded by punctuation and followed
  // by a non-space word character, so it is left-flanking only and cannot close.
  // Large-language-model output frequently uses this compact Chinese pattern, so
  // after the regular inline parse has left it as a plain text token we repair the
  // exact broken shapes into strong/em tokens without touching parsed code spans.
  function splitUnparsedCompactEmphasisText(text = '') {
    const src = String(text || '');
    const out = [];
    let changed = false;
    let index = 0;

    const pushText = (value) => {
      if (!value) return;
      const previous = out[out.length - 1];
      if (previous && previous.type === 'text') previous.content += value;
      else out.push({ type: 'text', content: String(value) });
    };

    while (index < src.length) {
      if (src[index] === '\\') {
        pushText(src[index]);
        if (index + 1 < src.length) pushText(src[index + 1]);
        index += 2;
        continue;
      }
      if (src[index] !== '*') {
        const start = index;
        while (index < src.length && src[index] !== '*' && src[index] !== '\\') index += 1;
        pushText(src.slice(start, index));
        continue;
      }
      const runLength = markerRunLength(src, index);
      if (runLength === 1 || runLength === 2) {
        const openEnd = index + runLength;
        const closing = findClosingMarkerRun(src, openEnd, '*', runLength);
        if (closing >= 0) {
          const content = src.slice(openEnd, closing);
          const after = closing + runLength;
          const lastContentChar = content.length ? content[content.length - 1] : '';
          const nextChar = after < src.length ? src[after] : '';
          const compactAfterPunctuation = content.length > 0
            && isMarkdownPunctOrSymbolChar(lastContentChar)
            && !!nextChar
            && !isMarkdownWhitespaceChar(nextChar)
            && !isMarkdownPunctOrSymbolChar(nextChar);
          if (compactAfterPunctuation && content.indexOf('*') === -1) {
            changed = true;
            out.push({ type: runLength === 2 ? 'strong' : 'em', content });
            index = after;
            continue;
          }
        }
      }
      pushText(src.slice(index, index + runLength));
      index += runLength;
    }
    return changed ? out : null;
  }

  function registerCompactEmphasisFix(md) {
    if (!md || !md.core || !md.core.ruler || md.__chatuiCompactEmphasisRegistered) return;
    md.__chatuiCompactEmphasisRegistered = true;
    md.core.ruler.after('inline', 'chatui_compact_emphasis', (state) => {
      for (const token of state.tokens) {
        if (token.type !== 'inline' || !Array.isArray(token.children)) continue;
        let changed = false;
        const nextChildren = [];
        for (const child of token.children) {
          if (child.type !== 'text' || !String(child.content || '').includes('*')) {
            nextChildren.push(child);
            continue;
          }
          const parts = splitUnparsedCompactEmphasisText(child.content);
          if (!parts) {
            nextChildren.push(child);
            continue;
          }
          changed = true;
          for (const part of parts) {
            if (part.type === 'text') {
              const textToken = new state.Token('text', '', 0);
              textToken.content = part.content;
              if (textToken.content) nextChildren.push(textToken);
              continue;
            }
            const tag = part.type === 'strong' ? 'strong' : 'em';
            const emptyBefore = new state.Token('text', '', 0);
            emptyBefore.content = '';
            nextChildren.push(emptyBefore);
            const open = new state.Token(`${part.type}_open`, tag, 1);
            open.markup = part.type === 'strong' ? '**' : '*';
            nextChildren.push(open);
            const content = new state.Token('text', '', 0);
            content.content = part.content;
            nextChildren.push(content);
            const close = new state.Token(`${part.type}_close`, tag, -1);
            close.markup = part.type === 'strong' ? '**' : '*';
            nextChildren.push(close);
            const emptyAfter = new state.Token('text', '', 0);
            emptyAfter.content = '';
            nextChildren.push(emptyAfter);
          }
        }
        if (changed) token.children = nextChildren;
      }
      return true;
    });
  }

  const api = Object.freeze({
    MERMAID_LANGS,
    isMarkdownWhitespaceChar,
    isMarkdownPunctOrSymbolChar,
    splitUnparsedCompactEmphasisText,
    registerCompactEmphasisFix,
    applyTaskListFallback,
    normalizeTableAlignToken,
    normalizeBlockquoteFencedCodeContent,
    decodeHtmlEntities,
    highlightedTextMatchesSource,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('markdownEnginePrimitives', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
