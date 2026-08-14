(function initChatUIMessageRenderer(root) {
  'use strict';

function isImageAttachment(item = {}) {
  if (item?.isImage === true) return true;
  const type = String(item?.type || item?.mime || item?.mimeType || '').trim();
  if (/^image\//i.test(type)) return true;
  return /\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i.test(String(item?.name || item?.filename || '').trim());
}

function attachmentsSummaryMarkdown(attachments = []) {
  const visible = (Array.isArray(attachments) ? attachments : []).filter(item => !isImageAttachment(item));
  return visible.length ? '\n\n' + visible.map(item => `📎 ${item.name}`).join('\n') : '';
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

function renderPlainText(text = '') {
  const div = document.createElement('div');
  div.className = 'plain-text';
  div.textContent = String(text || '');
  return div.outerHTML;
}

function renderUserMessageParts({ text = '', markdownHtml = '', imagePreviewHtml = '', attachmentSummaryHtml = '' } = {}) {
  const bodyHtml = text !== '' ? renderPlainText(text) : markdownHtml;
  return `${bodyHtml}${imagePreviewHtml}${attachmentSummaryHtml}`;
}

const api = Object.freeze({ attachmentsSummaryMarkdown, userAttachmentPreviewItems, renderPlainText, renderUserMessageParts });

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIMessageRenderer = api;
if (root?.window) root.window.ChatUIMessageRenderer = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
