(function initChatUIImageEditEntry(root) {
  'use strict';

  const IMAGE_EDIT_STYLE_ID = 'chatui-image-edit-style';
  const PENCIL_PATH = 'M16.5 3.5a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4Z';
  const WAVE_PATH = 'M3 21.5c1.4-1.6 2.8-1.6 4.2 0s2.8 1.6 4.2 0 2.8-1.6 4.2 0 2.8 1.6 4.2 0';
  let gradientSeq = 0;

  // Single source of truth for both edit entry surfaces: the transcript image
  // chip and the fullscreen preview action button. Only the shell/icon variants
  // differ, so callers never duplicate markup or styles.
  const IMAGE_EDIT_ENTRY_CSS = '.generated-image-item{position:relative}'
    + '.image-edit-entry{position:absolute;top:6px;right:6px;z-index:2;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:none;border-radius:999px;background:rgba(255,255,255,.24);color:#fff;box-shadow:0 2px 10px rgba(15,23,42,.28);cursor:pointer;backdrop-filter:blur(12px) saturate(170%);-webkit-backdrop-filter:blur(12px) saturate(170%);transition:transform .15s ease,box-shadow .15s ease,background .15s ease}'
    + '.image-edit-entry:hover{transform:translateY(-1px) scale(1.1);background:rgba(255,255,255,.36);box-shadow:0 4px 14px rgba(15,23,42,.36)}'
    + '.image-edit-entry:focus-visible{outline:2px solid #fff;outline-offset:2px}'
    + '.image-edit-entry svg{width:16px;height:16px;flex:none;overflow:visible}'
    + '.image-preview-edit{right:140px}';

  function ensureImageEditStyle(documentRef) {
    if (!documentRef?.head || documentRef.getElementById?.(IMAGE_EDIT_STYLE_ID)) return;
    const style = documentRef.createElement('style');
    style.id = IMAGE_EDIT_STYLE_ID;
    style.textContent = IMAGE_EDIT_ENTRY_CSS;
    documentRef.head.appendChild(style);
  }

  function colorfulEditIcon() {
    const gradientId = `chatui-edit-entry-gradient-${gradientSeq += 1}`;
    return [
      '<svg viewBox="0 0 24 24" aria-hidden="true">',
      `<defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="1">`,
      '<stop offset="0" stop-color="#22d3ee"/><stop offset=".34" stop-color="#3b82f6"/>',
      '<stop offset=".68" stop-color="#8b5cf6"/><stop offset="1" stop-color="#ec4899"/>',
      '</linearGradient></defs>',
      `<path d="${WAVE_PATH}" fill="none" stroke="#ffffff" stroke-width="3.6" stroke-linecap="round" opacity=".85"/>`,
      `<path d="${PENCIL_PATH}" fill="#ffffff" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round" opacity=".85"/>`,
      `<path d="${WAVE_PATH}" fill="none" stroke="url(#${gradientId})" stroke-width="2" stroke-linecap="round"/>`,
      `<path d="${PENCIL_PATH}" fill="url(#${gradientId})" stroke="url(#${gradientId})" stroke-width="1.2" stroke-linejoin="round"/>`,
      '</svg>',
    ].join('');
  }

  function createImageEditEntryButton(documentRef, options = {}) {
    if (!documentRef?.createElement) return null;
    ensureImageEditStyle(documentRef);
    const previewVariant = String(options?.variant || '') === 'preview';
    const entry = documentRef.createElement('button');
    entry.type = 'button';
    entry.className = previewVariant ? 'image-preview-action image-preview-edit' : 'image-edit-entry';
    entry.dataset.imageEditEntry = '1';
    entry.title = '\u7f16\u8f91\u56fe\u7247';
    entry.setAttribute('aria-label', '\u7f16\u8f91\u56fe\u7247');
    entry.innerHTML = previewVariant
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${PENCIL_PATH}"/><path d="${WAVE_PATH}"/></svg>`
      : colorfulEditIcon();
    return entry;
  }

  const api = Object.freeze({
    IMAGE_EDIT_STYLE_ID,
    IMAGE_EDIT_ENTRY_CSS,
    ensureImageEditStyle,
    createImageEditEntryButton,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('imageEditEntry', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));