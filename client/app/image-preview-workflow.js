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
      prompt = root?.prompt,
      Image = root?.Image,
      fetch = root?.fetch,
      alert = root?.alert,
      setTimeout = root?.setTimeout,
    } = deps;
    const MIN_PREVIEW_SCALE = 0.5;
    const MAX_PREVIEW_SCALE = 5;
    const PREVIEW_SCALE_STEP = 0.14;
    let previewScale = 1;
    let previewItems = [];
    let previewIndex = -1;
    let compressionBusy = false;

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
      const compressed = getElement('imagePreviewCompressDownload');
      if (compressed) compressed.hidden = false;
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

    async function compressDownloadImage() {
      if (compressionBusy) return;
      const image = getElement('imagePreviewImg');
      const source = image?.dataset?.persistedSrc || image?.src;
      const filename = image?.dataset?.filename || 'image.png';
      if (!source) return;
      const answer = prompt?.('目标文件大小（宽高、格式不变）：\n输入 75% 或 0.75，表示目标为原图大小的 75%。\nPNG 仅无损重编码，可能无法达到目标大小。', '75%');
      if (answer === null || answer === undefined) return;
      const value = String(answer).trim();
      const ratio = Number(value.replace(/%$/, '')) / (value.endsWith('%') ? 100 : 1);
      if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
        alert?.('请输入大于 0、且不超过 100% 的比例，例如 75% 或 0.75。');
        return;
      }
      compressionBusy = true;
      const button = getElement('imagePreviewCompressDownload');
      if (button) button.disabled = true;
      let inputUrl = '';
      try {
        let blob;
        if (String(source).startsWith('indexeddb://')) {
          blob = await getImageBlob(String(source).replace('indexeddb://', ''));
        } else {
          const response = await fetch(source);
          if (!response.ok) throw new Error('图片读取失败');
          blob = await response.blob();
        }
        if (!blob?.size) throw new Error('图片读取失败');
        if (ratio === 1) return downloadCompressedBlob(blob, filename);
        const mime = String(blob.type || '').split(';', 1)[0].toLowerCase();
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/avif'].includes(mime)) {
          throw new Error('当前图片格式不支持压缩');
        }
        inputUrl = URL.createObjectURL(blob);
        const loaded = await new Promise((resolve, reject) => {
          const item = new Image();
          item.onload = () => resolve(item);
          item.onerror = () => reject(new Error('图片读取失败'));
          item.src = inputUrl;
        });
        const canvas = document.createElement('canvas');
        canvas.width = loaded.naturalWidth || loaded.width;
        canvas.height = loaded.naturalHeight || loaded.height;
        const context = canvas.getContext('2d');
        if (!context || !canvas.width || !canvas.height) throw new Error('图片读取失败');
        context.drawImage(loaded, 0, 0, canvas.width, canvas.height);
        const encode = quality => new Promise((resolve, reject) => {
          canvas.toBlob(result => {
            // Unsupported encoders can silently return PNG. Never rename that output as another format.
            if (!result?.size || result.type !== mime) reject(new Error('浏览器不支持原格式编码'));
            else resolve(result);
          }, mime, quality);
        });
        const target = Math.max(1, Math.round(blob.size * ratio));
        let compressed = await encode(1);
        if (mime !== 'image/png' && compressed.size > target) {
          let low = 0;
          let high = 1;
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const mid = (low + high) / 2;
            const candidate = await encode(mid);
            if (Math.abs(candidate.size - target) < Math.abs(compressed.size - target)) compressed = candidate;
            if (candidate.size > target) high = mid;
            else low = mid;
          }
        }
        if (compressed.size >= blob.size) {
          alert?.('在保持原格式和宽高的条件下，无法进一步减小这张图片，已为你下载原图。');
          return downloadCompressedBlob(blob, filename);
        }
        if (Math.abs(compressed.size - target) > target * 0.05) {
          alert?.('已保持原格式和宽高，但无法精确达到目标大小，将下载可生成的压缩结果。');
        }
        const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
        const stem = filename.replace(/\.[^.]+$/, '');
        downloadCompressedBlob(compressed, `${stem}-compressed-${Math.round(ratio * 100)}%.${extension}`);
      } catch {
        alert?.('图片压缩失败，或浏览器不支持原格式编码。请重试，也可以使用原图下载。');
      } finally {
        if (inputUrl) URL.revokeObjectURL(inputUrl);
        compressionBusy = false;
        if (button) button.disabled = false;
      }
    }

    function downloadCompressedBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      try {
        link.href = url;
        link.download = filename;
        link.rel = 'noreferrer';
        document.body.appendChild(link);
        link.click();
      } finally {
        link.remove();
        // Keep the download source alive while the browser begins consuming it.
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
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
      getElement('imagePreviewCompressDownload')?.addEventListener('click', compressDownloadImage);
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
      if (await showPreviewItem(requestedIndex)) document?.activeElement?.blur?.();
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
      getElement('imagePreviewCompressDownload') && (getElement('imagePreviewCompressDownload').hidden = true);
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
      compressDownloadImage,
    });
  }

  const api = Object.freeze({ createImagePreviewWorkflow });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppImagePreviewWorkflow = api;
  if (root?.window) root.window.ChatUIAppImagePreviewWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
