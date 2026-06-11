(function initChatUIAppImageResultWorkflow(root) {
  'use strict';

  async function imageResultToHtml(result, elapsedText = '', options = {}, deps = {}) {
    const extracted = deps.extractImageResult(result);
    if (extracted && extracted.kind === 'empty') return { html: '没有返回图片数据', raw: extracted.raw, metaText: elapsedText ? `RT ${elapsedText}` : '' };
    if (extracted && extracted.kind === 'raw') return { html: `<pre>${deps.escapeHtml(extracted.raw)}</pre>`, raw: extracted.raw, metaText: elapsedText ? `RT ${elapsedText}` : '' };
    const images = Array.isArray(extracted?.images) && extracted.images.length ? extracted.images : [];
    if (!images.length) return { html: '没有返回图片数据', raw: JSON.stringify(result, null, 2), metaText: elapsedText ? `RT ${elapsedText}` : '' };

    const config = deps.getConfig();
    const storedImages = [];
    const itemsHtml = [];
    const referenceId = deps.makeImageReferenceId ? deps.makeImageReferenceId('latest') : 'imgref_latest';
    for (let index = 0; index < images.length; index += 1) {
      const item = images[index];
      const filename = `generated-${Date.now()}-${index + 1}.png`;
      const persisted = await deps.settleWithin(deps.persistImageSrc(item.src, filename, { ...config, returnDisplayUrl: true }), 8000, { persistedSrc: item.src, displaySrc: item.src });
      const persistedSrc = persisted?.persistedSrc || item.src;
      // Use the blob URL from persistImageSrc for immediate display (avoids
      // IndexedDB write-then-read timing issues), falling back to transparent
      // pixel only when the blob URL is unavailable. The data-persisted-src
      // attribute still holds the durable indexeddb:// ref for page reloads.
      const displaySrc = persisted?.displaySrc || (String(persistedSrc || '').startsWith('indexeddb://') ? window.ChatUIApp?.imageStore?.TRANSPARENT_PIXEL || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==' : persistedSrc);
      const size = await deps.settleWithin(deps.imageSrcSize(persistedSrc, config), 2000, null) || await deps.settleWithin(deps.imageSrcSize(item.src, config), 2000, null);
      const thumb = deps.fitImageThumb(size?.width, size?.height, 180, 120);
      const subjectLabels = deps.splitPromptSubjects(options.routePrompt || options.prompt || '', images.length)[index] || [];
      const labels = [...new Set([...subjectLabels, ...deps.imageCandidateLabels(`${item.raw || ''} ${filename}`)])];
      storedImages.push({
        src: persistedSrc,
        displaySrc,
        filename,
        prompt: '',
        updatedAt: Date.now(),
        width: size?.width || 0,
        height: size?.height || 0,
        raw: item.raw,
        url: item.url || '',
        labels,
        thumb,
      });
      itemsHtml.push(`<div class="generated-image-item" data-image-index="${index + 1}" aria-label="第 ${index + 1} 张图片"><img class="generated-thumb" width="${thumb.width}" height="${thumb.height}" style="--thumb-w:${thumb.width}px;--thumb-h:${thumb.height}px;width:${thumb.width}px;height:${thumb.height}px;aspect-ratio:${thumb.width}/${thumb.height};object-fit:contain" src="${deps.escapeHtml(displaySrc)}" data-persisted-src="${deps.escapeHtml(persistedSrc)}" data-original-src="${deps.escapeHtml(persistedSrc)}" data-filename="${deps.escapeHtml(filename)}" data-reference-id="${deps.escapeHtml(referenceId)}" data-image-id="${deps.escapeHtml(deps.makeImageItemId('latest', index + 1))}" data-image-index="${index + 1}" data-thumb-width="${thumb.width}" data-thumb-height="${thumb.height}" data-original-width="${size?.width || thumb.width}" data-original-height="${size?.height || thumb.height}" alt="第 ${index + 1} 张生成图片" /></div>`);
    }

    const first = storedImages[0];
    const latestImage = {
      src: first.src,
      filename: first.filename,
      prompt: options.prompt || '',
      updatedAt: Date.now(),
      width: first.width || 0,
      height: first.height || 0,
      images: storedImages.map(item => ({ src: item.src, filename: item.filename, prompt: options.prompt || '', updatedAt: item.updatedAt, width: item.width || 0, height: item.height || 0, labels: item.labels || [] })),
    };
    deps.saveLatestGeneratedImage(options.sessionId, latestImage);

    const countText = storedImages.length > 1 ? `（${storedImages.length} 张）` : '';
    const raw = storedImages.map(item => item.raw).join('\n');
    const downloadAllButton = deps.downloadAllImagesButtonHtml();
    return {
      raw,
      metaText: elapsedText ? `RT ${elapsedText}` : '',
      html: `${countText ? `<div class="image-result-head"><span>${countText}</span></div>` : ''}<div class="generated-image-grid" data-generated-images="1">${itemsHtml.join('')}</div><div class="image-download-row">${downloadAllButton}</div>`,
    };
  }

  const api = Object.freeze({ imageResultToHtml });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppImageResultWorkflow = api;
  if (root?.window) root.window.ChatUIAppImageResultWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
