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
    extractWebPreviewCandidates,
    buildPreviewDocument,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUICoreWebPreview = api;
  if (root?.window) root.window.ChatUICoreWebPreview = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
