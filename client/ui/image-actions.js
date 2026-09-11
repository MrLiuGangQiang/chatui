(function initChatUIImageActions(root) {
  'use strict';

function downloadImageButtonHtml(href, filename, escapeAttr = value => String(value)) {
  return `<button class="image-icon-btn" type="button" data-download-image="1" data-persisted-href="${escapeAttr(href)}" data-filename="${escapeAttr(filename)}" title="下载图片" aria-label="下载图片"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg></button>`;
}

function shareImageButtonHtml(href, filename, escapeAttr = value => String(value)) {
  return `<button class="image-icon-btn" type="button" data-share-image="1" data-persisted-href="${escapeAttr(href)}" data-filename="${escapeAttr(filename)}" title="分享图片" aria-label="分享图片"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.6 15.4 6.4"/><path d="M8.6 13.4 15.4 17.6"/></svg></button>`;
}

function copyImageButtonHtml(href, filename, escapeAttr = value => String(value)) {
  return `<button class="image-icon-btn" type="button" data-copy-image="1" data-persisted-href="${escapeAttr(href)}" data-filename="${escapeAttr(filename)}" title="复制图片" aria-label="复制图片"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`;
}

function imageActionButtonsHtml(href, filename, escapeAttr = value => String(value)) {
  return downloadImageButtonHtml(href, filename, escapeAttr) + shareImageButtonHtml(href, filename, escapeAttr);
}

// The toolbar must sit directly above the image, but the image is frequently
// nested inside a wrapper or an actions row. Inserting against a different
// parent throws NotFoundError, so anchor on the image's own parent instead.
// Rendered thumbnails lose data-persisted-src whenever the source is still a
// blob/data URL, so edits must fall back to the live image attributes.
function imageEditSource(image) {
  return String(
    image?.dataset?.persistedSrc
    || image?.dataset?.originalSrc
    || image?.dataset?.persistedUrl
    || image?.dataset?.objectUrl
    || image?.currentSrc
    || image?.src
    || '',
  ).trim();
}

// The toolbar belongs to the message content layer. Inserting it next to the
// <img> puts it inside the thumbnail wrapper (a fixed-size flex cell), where it
// collapses into an invisible sliver. Prepend it to the content container
// instead so it renders above the image.
function insertImageEditToolbar(container, toolbar) {
  if (!container || !toolbar || typeof container.insertBefore !== 'function') return false;
  if (container.firstChild) container.insertBefore(toolbar, container.firstChild);
  else container.appendChild(toolbar);
  return true;
}

const api = Object.freeze({ downloadImageButtonHtml, shareImageButtonHtml, copyImageButtonHtml, imageActionButtonsHtml, insertImageEditToolbar, imageEditSource });

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIImageActions = api;
if (root?.window) root.window.ChatUIImageActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
