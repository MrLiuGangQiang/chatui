(function initChatUIAppImagePreviewWorkflow(root) {
  'use strict';

  function createImagePreviewWorkflow(deps = {}) {
    const {
      getElement,
      getImageBlob,
      canWriteImageClipboard,
      imageClipboardUnsupportedMessage,
      URL,
      document = root?.document,
    } = deps;
    const MIN_PREVIEW_SCALE = 0.5;
    const MAX_PREVIEW_SCALE = 5;
    const PREVIEW_SCALE_STEP = 0.14;
    let previewScale = 1;
    let previewItems = [];
    let previewIndex = -1;

    function updateImagePreviewCopyAvailability() {
      const button = getElement('imagePreviewCopy');
      if (!button) return;
      const available = canWriteImageClipboard();
      button.disabled = !available;
      button.classList.toggle('is-disabled', !available);
      button.title = available ? '复制图片' : imageClipboardUnsupportedMessage();
      button.setAttribute('aria-label', button.title);
    }

    async function resolvePreviewSrc(source) {
      if (!source) return { src: '', owned: false };
      if (String(source).startsWith('indexeddb://')) {
        const blob = await getImageBlob(String(source).replace('indexeddb://', ''));
        return blob ? { src: URL.createObjectURL(blob), owned: true } : { src: '', owned: false };
      }
      if (String(source).startsWith('blob:')) return { src: source, owned: false };
      return { src: source, owned: false };
    }

    function normalizePreviewItems(items, fallbackSource, fallbackFilename) {
      const candidates = Array.isArray(items) ? items : [];
      const normalized = candidates.map(item => ({
        source: String(item?.source || item?.src || ''),
        filename: item?.filename || item?.name || 'image.png',
      })).filter(item => item.source);
      if (normalized.length) return normalized;
      return fallbackSource ? [{ source: String(fallbackSource), filename: fallbackFilename || 'image.png' }] : [];
    }

    function clampPreviewScale(value) {
      const numeric = Number(value);
      return Math.min(MAX_PREVIEW_SCALE, Math.max(MIN_PREVIEW_SCALE, Number.isFinite(numeric) ? numeric : 1));
    }

    function applyPreviewScale(value) {
      const image = getElement('imagePreviewImg');
      previewScale = clampPreviewScale(value);
      if (image) {
        image.style.transform = `scale(${previewScale})`;
        image.dataset.previewScale = previewScale.toFixed(2);
        image.classList.toggle('is-zoomed', previewScale > 1.01);
        image.setAttribute('aria-label', `图片预览，当前缩放 ${Math.round(previewScale * 100)}%，滚轮可放大或缩小`);
      }
      return previewScale;
    }

    function resetPreviewZoom() { return applyPreviewScale(1); }

    function zoomImagePreview(delta) {
      const direction = Number(delta) < 0 ? 1 : -1;
      return applyPreviewScale(previewScale * (1 + direction * PREVIEW_SCALE_STEP));
    }

    function updatePreviewNavigation() {
      const total = previewItems.length;
      const hasMultiple = total > 1;
      const previous = getElement('imagePreviewPrevious');
      const next = getElement('imagePreviewNext');
      const position = getElement('imagePreviewPosition');
      if (previous) {
        previous.hidden = !hasMultiple;
        previous.disabled = previewIndex <= 0;
        previous.setAttribute('aria-label', '上一张图片');
      }
      if (next) {
        next.hidden = !hasMultiple;
        next.disabled = previewIndex < 0 || previewIndex >= total - 1;
        next.setAttribute('aria-label', '下一张图片');
      }
      if (position) {
        position.hidden = !hasMultiple;
        position.textContent = hasMultiple ? `${previewIndex + 1} / ${total}` : '';
      }
    }

    async function showPreviewItem(index) {
      if (index < 0 || index >= previewItems.length) return false;
      const item = previewItems[index];
      const resolved = await resolvePreviewSrc(item.source);
      if (!resolved?.src || previewItems[index] !== item) return false;
      const image = getElement('imagePreviewImg');
      const previousObjectUrl = image?.dataset.previewObjectUrl;
      if (previousObjectUrl?.startsWith('blob:') && previousObjectUrl !== resolved.src) URL.revokeObjectURL(previousObjectUrl);
      if (image) {
        image.dataset.previewObjectUrl = resolved.owned ? resolved.src : '';
        image.dataset.persistedSrc = item.source;
        image.dataset.filename = item.filename || 'image.png';
        image.src = resolved.src;
      }
      previewIndex = index;
      resetPreviewZoom();
      const download = getElement('imagePreviewDownload');
      if (download) {
        download.dataset.persistedHref = item.source || resolved.src;
        download.dataset.filename = item.filename || 'image.png';
        download.hidden = false;
      }
      const copy = getElement('imagePreviewCopy');
      if (copy) {
        copy.dataset.persistedHref = item.source || resolved.src;
        copy.dataset.filename = item.filename || 'image.png';
        copy.hidden = false;
        updateImagePreviewCopyAvailability();
      }
      updatePreviewNavigation();
      return true;
    }

    async function navigateImagePreview(offset) {
      return showPreviewItem(previewIndex + Number(offset || 0));
    }

    function bindPreviewControls() {
      const preview = getElement('imagePreview');
      if (!preview || preview.dataset.previewControlsBound === '1') return;
      preview.dataset.previewControlsBound = '1';
      preview.addEventListener('wheel', event => {
        if (!preview.classList.contains('show')) return;
        event.preventDefault();
        event.stopPropagation();
        zoomImagePreview(event.deltaY);
      }, { passive: false });
      preview.addEventListener('dblclick', event => {
        if (event.target?.closest?.('button')) return;
        event.preventDefault();
        resetPreviewZoom();
      });
      getElement('imagePreviewPrevious')?.addEventListener('click', () => navigateImagePreview(-1));
      getElement('imagePreviewNext')?.addEventListener('click', () => navigateImagePreview(1));
      const keyTarget = document?.documentElement || document;
      if (!keyTarget || keyTarget.dataset?.imagePreviewKeysBound === '1') return;
      if (keyTarget.dataset) keyTarget.dataset.imagePreviewKeysBound = '1';
      document.addEventListener('keydown', event => {
        if (!preview.classList.contains('show') || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          navigateImagePreview(-1);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          navigateImagePreview(1);
        }
      });
    }

    async function openImagePreview(source, filename = 'image.png', options = {}) {
      previewItems = normalizePreviewItems(options?.items, source, filename);
      const selectedIndex = Number(options?.index);
      const requestedIndex = Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < previewItems.length
        ? selectedIndex
        : Math.max(0, previewItems.findIndex(item => item.source === String(source)));
      bindPreviewControls();
      const preview = getElement('imagePreview');
      if (preview && !preview.classList.contains('show')) preview._returnFocus = document?.activeElement;
      if (preview) {
        preview.classList.add('show');
        preview.setAttribute('aria-hidden', 'false');
      }
      if (await showPreviewItem(requestedIndex)) getElement('imagePreviewClose')?.focus?.({ preventScroll: true });
    }

    function closeImagePreview() {
      const preview = getElement('imagePreview');
      const activeElement = document?.activeElement;
      const returnFocus = preview?._returnFocus;
      if (activeElement && preview?.contains?.(activeElement)) {
        if (returnFocus && returnFocus.isConnected && !returnFocus.disabled) returnFocus.focus?.({ preventScroll: true });
        else activeElement.blur?.();
      }
      const image = getElement('imagePreviewImg');
      const objectUrl = image?.dataset.previewObjectUrl;
      if (objectUrl?.startsWith('blob:')) URL.revokeObjectURL(objectUrl);
      if (image) {
        delete image.dataset.previewObjectUrl;
        delete image.dataset.persistedSrc;
        delete image.dataset.filename;
        delete image.dataset.previewScale;
        image.classList.remove('is-zoomed');
        image.style.transform = '';
        image.removeAttribute('aria-label');
        image.removeAttribute("src");
      }
      previewScale = 1;
      previewItems = [];
      previewIndex = -1;
      getElement('imagePreviewCopy') && (getElement('imagePreviewCopy').hidden = true);
      getElement('imagePreviewDownload') && (getElement('imagePreviewDownload').hidden = true);
      updatePreviewNavigation();
      preview?.classList.remove('show');
      preview?.setAttribute('aria-hidden', 'true');
      if (preview) delete preview._returnFocus;
    }

    return Object.freeze({
      updateImagePreviewCopyAvailability,
      resolvePreviewSrc,
      openImagePreview,
      closeImagePreview,
      navigateImagePreview,
      updatePreviewNavigation,
      zoomImagePreview,
      resetPreviewZoom,
      applyPreviewScale,
    });
  }

  const api = Object.freeze({ createImagePreviewWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppImagePreviewWorkflow = api;
  if (root?.window) root.window.ChatUIAppImagePreviewWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
