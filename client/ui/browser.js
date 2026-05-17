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



  function createRealtimeRenderer(render) {
    let value = '';
    let scheduled = false;
    let cancelled = false;
    let handle = null;
    return {
      set(next) {
        if (cancelled) return;
        value = String(next || '');
        if (scheduled) return;
        scheduled = true;
        handle = requestAnimationFrame(() => {
          scheduled = false;
          handle = null;
          if (!cancelled) render(value);
        });
      },
      flush(next) {
        if (cancelled) return;
        value = String(next || '');
        if (handle !== null) cancelAnimationFrame(handle);
        handle = null;
        scheduled = false;
        render(value);
      },
      cancel() {
        cancelled = true;
        if (handle !== null) cancelAnimationFrame(handle);
        handle = null;
        scheduled = false;
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
    return nodeRect.bottom > viewportBottom + 40 || nodeRect.bottom < viewportTop + 80 || nodeRect.top > viewportBottom || nodeRect.bottom < viewportTop;
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
    actions: Object.freeze({ copySuccessState, copyText }),
    imageActions: Object.freeze({ downloadImageButtonHtml, shareImageButtonHtml, imageActionButtonsHtml }),
  });
})();
