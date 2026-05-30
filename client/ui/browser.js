(function () {
  function safeFilenamePart(value = '') {
    return String(value || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 32) || 'assistant-answer';
  }

  function answerFilename({ text = '', date = new Date() } = {}) {
    const stamp = date.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const firstLine = String(text || '').split('\n').find(Boolean) || 'assistant-answer';
    return `${stamp}-${safeFilenamePart(firstLine)}.md`;
  }



  function createRealtimeRenderer(render, options = {}) {
    let value = '';
    let cancelled = false;
    return {
      set(next) {
        if (cancelled) return;
        value = String(next || '');
        render(value);
      },
      flush(next) {
        if (cancelled) return;
        value = String(next || '');
        render(value);
      },
      cancel() {
        cancelled = true;
        value = '';
      },
    };
  }




  function composerSafeBottom(value, fallback = 168) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function activeOutputBottomTarget({ composerTop, viewportHeight, margin = 24 }) {
    return Math.max(80, (Number.isFinite(composerTop) ? composerTop : viewportHeight) - margin);
  }

  function isNodeAwayFromOutputFocus({ nodeRect, messagesRect = null, composerTop, viewportHeight, margin = 72 }) {
    if (!nodeRect) return false;
    const focusBottom = (Number.isFinite(composerTop) ? composerTop : viewportHeight) - margin;
    const viewportTop = messagesRect?.top || 0;
    const viewportBottom = messagesRect?.bottom ? Math.min(messagesRect.bottom, focusBottom) : focusBottom;
    const lowerTolerance = Math.max(48, Math.min(140, margin));
    return nodeRect.bottom > viewportBottom + lowerTolerance || nodeRect.bottom < viewportTop + 80 || nodeRect.top > viewportBottom || nodeRect.bottom < viewportTop;
  }



  function attachmentsSummaryMarkdown(attachments = []) {
    return attachments.length ? '\n\n' + attachments.map(item => `📎 ${item.name}`).join('\n') : '';
  }

  function userAttachmentPreviewItems(attachments = [], fitImageThumb = (w, h) => ({ width: w || 180, height: h || 120 })) {
    return attachments
      .filter(item => item && item.isImage && (item.previewSrc || item.dataUrl))
      .map(item => {
        const thumb = fitImageThumb(item.previewWidth, item.previewHeight, 180, 120);
        return {
          ...item,
          src: item.previewSrc || item.dataUrl,
          thumbWidth: item.thumbWidth || thumb.width,
          thumbHeight: item.thumbHeight || thumb.height,
        };
      });
  }

  function renderUserMessageParts({ markdownHtml = '', imagePreviewHtml = '', attachmentSummaryHtml = '' } = {}) {
    return `${markdownHtml}${imagePreviewHtml}${attachmentSummaryHtml}`;
  }



  function copySuccessState(successIconSvg, previousHtml) {
    return { className: 'copied', html: successIconSvg, restoreHtml: previousHtml, timeoutMs: 900 };
  }

  function normalizeRenderedCopyText(text = '') {
    const normalized = String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
    const lines = normalized.split('\n');
    const nonEmpty = lines.filter(line => line.trim()).length;
    const blank = lines.length - nonEmpty;
    const mostlyInterleavedBlanks = nonEmpty >= 2 && blank >= nonEmpty - 1 && lines.every((line, index) => line.trim() || index % 2 === 1);
    return mostlyInterleavedBlanks ? lines.filter(line => line.trim()).join('\n') : normalized.replace(/\n{2,}/g, '\n');
  }

  const BLOCK_TAGS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL']);

  function normalizeVisibleLines(text = '') {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(line => line.replace(/[ \t]+$/g, ''))
      .filter(line => line.trim())
      .join('\n')
      .trim();
  }

  function visibleTextFromNode(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    const tag = node.tagName || '';
    if (tag === 'BR') return '\n';
    if (tag === 'IMG') return node.alt || '';
    if (tag === 'PRE') return normalizeVisibleLines(node.innerText || node.textContent || '');
    const text = Array.from(node.childNodes || []).map(visibleTextFromNode).join('');
    return BLOCK_TAGS.has(tag) ? `\n${text.trim()}\n` : text;
  }

  function visibleCopyTextFromElement(element) {
    return normalizeVisibleLines(visibleTextFromNode(element));
  }

  function messageCopyText(rawText = '', renderedText = '', element = null) {
    const visible = visibleCopyTextFromElement(element);
    const rendered = visible || normalizeRenderedCopyText(renderedText);
    return rendered || String(rawText || '').trim();
  }

  async function copyText(text, clipboard = navigator.clipboard, documentRef = document) {
    if (clipboard?.writeText) return clipboard.writeText(text);
    const textarea = documentRef.createElement('textarea');
    textarea.value = text;
    documentRef.body.appendChild(textarea);
    textarea.select();
    documentRef.execCommand('copy');
    textarea.remove();
  }



  function downloadImageButtonHtml(href, filename, escapeAttr = value => String(value)) {
    return `<button class="image-icon-btn" type="button" data-download-image="1" data-persisted-href="${escapeAttr(href)}" data-filename="${escapeAttr(filename)}" title="下载图片" aria-label="下载图片"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg></button>`;
  }

  function shareImageButtonHtml(href, filename, escapeAttr = value => String(value)) {
    return `<button class="image-icon-btn" type="button" data-share-image="1" data-persisted-href="${escapeAttr(href)}" data-filename="${escapeAttr(filename)}" title="分享图片" aria-label="分享图片"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.6 15.4 6.4"/><path d="M8.6 13.4 15.4 17.6"/></svg></button>`;
  }

  function imageActionButtonsHtml(href, filename, escapeAttr = value => String(value)) {
    return downloadImageButtonHtml(href, filename, escapeAttr) + shareImageButtonHtml(href, filename, escapeAttr);
  }

  window.ChatUI = Object.freeze({
    ...(window.ChatUI || {}),
    fileActions: Object.freeze({ safeFilenamePart, answerFilename }),
    realtime: Object.freeze({ createRealtimeRenderer }),
    scroll: Object.freeze({ composerSafeBottom, activeOutputBottomTarget, isNodeAwayFromOutputFocus }),
    messages: Object.freeze({ attachmentsSummaryMarkdown, userAttachmentPreviewItems, renderUserMessageParts }),
    actions: Object.freeze({ copySuccessState, copyText, normalizeRenderedCopyText, visibleCopyTextFromElement, messageCopyText }),
    imageActions: Object.freeze({ downloadImageButtonHtml, shareImageButtonHtml, imageActionButtonsHtml }),
  });
})();
