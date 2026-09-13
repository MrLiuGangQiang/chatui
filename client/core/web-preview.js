(function initChatUICoreWebPreview(root) {
  'use strict';

  const MAX_PREVIEW_SOURCE_LENGTH = 1_500_000;
  const HTML_FENCE_PATTERN = /(^|\n)\s*```(?:html|htm|xhtml)\s*\n([\s\S]*?)\n\s*```/gi;
  const SVG_FENCE_PATTERN = /(^|\n)\s*```svg\s*\n([\s\S]*?)\n\s*```/gi;
  const DOCUMENT_PATTERN = /<!doctype\s+html\b[\s\S]*?<\/html\s*>|<html\b[^>]*>[\s\S]*?<\/html\s*>/gi;
  const SVG_DOCUMENT_PATTERN = /^(?:<\?xml[^>]*>\s*)?(?:<!doctype\s+svg[^>]*>\s*)?<svg\b[^>]*>[\s\S]*?<\/svg\s*>$/i;
  function normalizeSource(value = '') {
    return String(value || '').replace(/\r\n?/g, '\n').replace(/\0/g, '').trim();
  }

  function looksLikeWebDocument(value = '') {
    const source = normalizeSource(value);
    if (!source || source.length > MAX_PREVIEW_SOURCE_LENGTH) return false;
    return /<!doctype\s+html\b/i.test(source)
      || (/<html\b[^>]*>/i.test(source) && /<\/(?:html|body)\s*>/i.test(source));
  }

  function looksLikeSvgDocument(value = '') {
    const source = normalizeSource(value);
    return !!source
      && source.length <= MAX_PREVIEW_SOURCE_LENGTH
      && SVG_DOCUMENT_PATTERN.test(source);
  }

  function previewTitle(source = '', fallback = '\u7f51\u9875\u9884\u89c8') {
    const match = String(source || '').match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
    const title = match?.[1]
      ? match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
    return title.slice(0, 120) || fallback;
  }

  function longestBacktickRun(value = '') {
    let longest = 0;
    let current = 0;
    for (const char of String(value || '')) {
      if (char === '`') {
        current += 1;
        longest = Math.max(longest, current);
      } else current = 0;
    }
    return longest;
  }

  function webDocumentFence(source = '', language = 'html') {
    const value = normalizeSource(source);
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(value) + 1));
    return `${fence}${String(language || '').toLowerCase()}\n${value}\n${fence}`;
  }

  function markdownFenceLine(line = '') {
    const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(String(line || ''));
    if (!match) return null;
    return { marker: match[1], char: match[1][0], length: match[1].length, rest: match[2] };
  }

  function isClosingFenceLine(line = '', active = {}) {
    const info = markdownFenceLine(line);
    return !!info && info.char === active.char && info.length >= active.length && !String(info.rest || '').trim();
  }

  function escapeWebDocumentsInSegment(segment = '') {
    const text = String(segment || '');
    const parts = [];
    let cursor = 0;
    while (cursor < text.length) {
      const rest = text.slice(cursor);
      const match = /(^|\n)([ \t]*)(?=<!doctype\s+html\b|<html\b[^>]*>|<svg\b[^>]*>)/i.exec(rest);
      if (!match) break;
      const lineStart = cursor + match.index + match[1].length;
      const start = lineStart + match[2].length;
      const head = text.slice(start);
      const startsSvg = /^<svg\b/i.test(head);
      const startsHtml = /^(?:<!doctype\s+html\b|<html\b)/i.test(head);
      if (!startsSvg && !startsHtml) {
        cursor = start + 1;
        continue;
      }
      const closeMatch = startsSvg ? /<\/svg\s*>/i.exec(head) : /<\/html\s*>/i.exec(head);
      if (startsSvg && !closeMatch && head.length < 4096) {
        cursor = start + 1;
        continue;
      }
      const end = closeMatch ? start + closeMatch.index + closeMatch[0].length : text.length;
      const raw = normalizeSource(text.slice(start, end));
      if (!raw) {
        cursor = end;
        continue;
      }
      parts.push(text.slice(cursor, lineStart), webDocumentFence(raw, startsSvg ? 'svg' : 'html'));
      cursor = end;
      if (!closeMatch) break;
    }
    if (!parts.length) return text;
    parts.push(text.slice(cursor));
    return parts.join('');
  }

  // Full documents are preview payloads, not live chat DOM. Rendering a page's
  // internal nodes inside the main document made large outputs dominate layout,
  // scrolling, sanitization, and persistence. Convert every non-fenced document
  // start to a code fence while preserving the original source for extraction.
  function escapeWebDocumentsForMarkdown(markdown = '') {
    const source = normalizeSource(markdown);
    if (!source) return '';
    const parts = [];
    let cursor = 0;
    let segmentStart = 0;
    let activeFence = null;
    let fenceStart = 0;
    while (cursor < source.length) {
      const newline = source.indexOf('\n', cursor);
      const lineEnd = newline >= 0 ? newline : source.length;
      const line = source.slice(cursor, lineEnd);
      if (!activeFence) {
        const info = markdownFenceLine(line);
        if (info) {
          if (segmentStart < cursor) parts.push(escapeWebDocumentsInSegment(source.slice(segmentStart, cursor)));
          activeFence = info;
          fenceStart = cursor;
        }
      } else if (isClosingFenceLine(line, activeFence)) {
        const nextStart = newline >= 0 ? newline + 1 : lineEnd;
        parts.push(source.slice(fenceStart, nextStart));
        activeFence = null;
        segmentStart = nextStart;
      }
      if (newline < 0) break;
      cursor = newline + 1;
    }
    if (activeFence) {
      parts.push(source.slice(fenceStart));
      segmentStart = source.length;
    }
    if (segmentStart < source.length) parts.push(escapeWebDocumentsInSegment(source.slice(segmentStart)));
    return parts.join('');
  }

  function uniqueCandidates(candidates = []) {
    const seen = new Set();
    return candidates.filter(candidate => {
      const source = normalizeSource(candidate?.source);
      if (!source || seen.has(source)) return false;
      seen.add(source);
      candidate.source = source;
      candidate.kind = candidate.kind === 'svg' ? 'svg' : 'html';
      candidate.title = candidate.title || previewTitle(source, candidate.kind === 'svg' ? '\u56fe\u5f62\u9884\u89c8' : '\u7f51\u9875\u9884\u89c8');
      return true;
    });
  }

  function extractWebPreviewCandidates(markdown = '') {
    const source = normalizeSource(markdown);
    if (!source || source.length > MAX_PREVIEW_SOURCE_LENGTH) return [];
    const candidates = [];
    let match;
    HTML_FENCE_PATTERN.lastIndex = 0;
    while ((match = HTML_FENCE_PATTERN.exec(source))) {
      const documentSource = normalizeSource(match[2]);
      if (looksLikeWebDocument(documentSource)) candidates.push({ source: documentSource, origin: 'fence', kind: 'html' });
    }
    SVG_FENCE_PATTERN.lastIndex = 0;
    while ((match = SVG_FENCE_PATTERN.exec(source))) {
      const documentSource = normalizeSource(match[2]);
      if (looksLikeSvgDocument(documentSource)) candidates.push({ source: documentSource, origin: 'fence', kind: 'svg' });
    }
    DOCUMENT_PATTERN.lastIndex = 0;
    while ((match = DOCUMENT_PATTERN.exec(source))) {
      const documentSource = normalizeSource(match[0]);
      if (looksLikeWebDocument(documentSource)) candidates.push({ source: documentSource, origin: 'document', kind: 'html' });
    }
    // A raw SVG response is previewable only when the entire response is one SVG document.
    // This prevents SVG fragments embedded in an HTML page from producing a duplicate card.
    if (looksLikeSvgDocument(source)) candidates.push({ source, origin: 'document', kind: 'svg' });
    return uniqueCandidates(candidates).map((candidate, index) => ({
      ...candidate,
      id: `web-preview-${index + 1}`,
      title: previewTitle(candidate.source, `${candidate.kind === 'svg' ? '\u56fe\u5f62' : '\u7f51\u9875'}\u9884\u89c8 ${index + 1}`),
    }));
  }

  // Candidates are complete documents. Keep their content intact so scripts, forms, and
  // linked resources work inside the isolated preview iframe.
  function buildPreviewDocument(source = '') {
    return normalizeSource(source);
  }


  const api = Object.freeze({
    MAX_PREVIEW_SOURCE_LENGTH,
    normalizeSource,
    looksLikeWebDocument,
    looksLikeSvgDocument,
    previewTitle,
    escapeWebDocumentsForMarkdown,
    extractWebPreviewCandidates,
    buildPreviewDocument,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUICoreWebPreview = api;
  if (root?.window) root.window.ChatUICoreWebPreview = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
