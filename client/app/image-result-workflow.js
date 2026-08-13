(function initChatUIAppImageResultWorkflow(root) {
  'use strict';

  const FALLBACK_TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

  function makeImageResultId(options = {}, deps = {}) {
    const existing = String(options.resultId || options.imageResultId || '').trim();
    if (existing) return existing;
    if (typeof deps.makeImageResultId === 'function') return String(deps.makeImageResultId(options) || '').trim();
    return `imgres_${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 6)}`;
  }

  // This is deliberately the only generated-image HTML constructor. The live
  // result and a restored result receive the same descriptor list and therefore
  // preserve the same stable ordinal rather than inferring a new position.
  function renderImageResultHtml(images = [], { escapeHtml = value => String(value || ''), downloadAllImagesButtonHtml = () => '', transparentPixel = FALLBACK_TRANSPARENT_PIXEL } = {}) {
    const visible = (Array.isArray(images) ? images : []).filter(item => String(item?.src || item?.persistedSrc || '').startsWith('indexeddb://'));
    if (!visible.length) return '';
    const items = visible.map((item, index) => {
      const ordinal = Number(item.ordinal || item.position || item.sourceIndex || item.source_index || index + 1) || index + 1;
      const width = Number(item.width) || 180;
      const height = Number(item.height) || 120;
      const scale = Math.min(180 / width, 120 / height, 1);
      const thumbWidth = Math.max(1, Math.round(width * scale));
      const thumbHeight = Math.max(1, Math.round(height * scale));
      const persistedSrc = String(item.src || item.persistedSrc || '');
      const displaySrc = String(item.displaySrc || '') || transparentPixel;
      const referenceId = String(item.referenceId || item.reference_id || '');
      const imageId = String(item.imageId || item.image_id || item.id || '');
      return `<div class="generated-image-item" data-image-index="${ordinal}" data-image-result-id="${escapeHtml(item.resultId || '')}" aria-label="第 ${ordinal} 张图片"><img class="generated-thumb${displaySrc === transparentPixel ? ' image-restoring' : ''}" width="${thumbWidth}" height="${thumbHeight}" style="--thumb-w:${thumbWidth}px;--thumb-h:${thumbHeight}px;width:${thumbWidth}px;height:${thumbHeight}px;aspect-ratio:${thumbWidth}/${thumbHeight};object-fit:contain" src="${escapeHtml(displaySrc)}" data-persisted-src="${escapeHtml(persistedSrc)}" data-original-src="${escapeHtml(persistedSrc)}" data-filename="${escapeHtml(item.name || item.filename || `image-${ordinal}.png`)}" data-reference-id="${escapeHtml(referenceId)}" data-image-id="${escapeHtml(imageId)}" data-image-index="${ordinal}" data-image-result-id="${escapeHtml(item.resultId || '')}" data-thumb-width="${thumbWidth}" data-thumb-height="${thumbHeight}" data-original-width="${width}" data-original-height="${height}" alt="第 ${ordinal} 张生成图片" /></div>`;
    }).join('');
    const head = visible.length > 1 ? `<div class="image-result-head"><span>（${visible.length} 张）</span></div>` : '';
    const actions = downloadAllImagesButtonHtml();
    return `${head}<div class="generated-image-grid" data-generated-images="1">${items}</div>${actions ? `<div class="image-download-row">${actions}</div>` : ''}`;
  }

  function imageDescriptorsFromContext(imageContext = {}) {
    const attachments = Array.isArray(imageContext?.attachments) ? imageContext.attachments : [];
    return attachments
      .filter(item => String(item?.src || item?.persistedSrc || '').startsWith('indexeddb://'))
      .map((item, index) => ({
        ...item,
        src: String(item.src || item.persistedSrc || ''),
        persistedSrc: String(item.persistedSrc || item.src || ''),
        ordinal: index + 1,
        sourceIndex: index + 1,
        displaySrc: '',
      }));
  }

  function mergeImageResultContexts(current = {}, addition = {}) {
    const currentImages = imageDescriptorsFromContext(current);
    const addedImages = imageDescriptorsFromContext(addition);
    const seen = new Set(currentImages.map(item => String(item.src || item.persistedSrc || '')));
    const attachments = [...currentImages];
    for (const item of addedImages) {
      const key = String(item.src || item.persistedSrc || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      attachments.push(item);
    }
    const resultId = String(current?.resultId || addition?.resultId || '').trim();
    const referenceId = String(current?.referenceId || current?.selectedReferenceId || addition?.referenceId || addition?.selectedReferenceId || '').trim();
    return {
      schema_version: 'image_result.v1',
      ...current,
      ...addition,
      resultId,
      referenceId,
      selectedReferenceId: referenceId,
      usePreviousImage: true,
      updatedAt: Date.now(),
      attachments: attachments.map((item, index) => ({
        ...item,
        ordinal: index + 1,
        sourceIndex: index + 1,
        displaySrc: '',
      })),
    };
  }

  function renderImageResultContext(imageContext = {}, options = {}, deps = {}) {
    return renderImageResultHtml(imageDescriptorsFromContext(imageContext), {
      escapeHtml: deps.escapeHtml,
      downloadAllImagesButtonHtml: deps.downloadAllImagesButtonHtml,
      transparentPixel: root?.ChatUIApp?.imageStore?.TRANSPARENT_PIXEL || FALLBACK_TRANSPARENT_PIXEL,
      ...options,
    });
  }

  async function imageResultToHtml(result, elapsedText = '', options = {}, deps = {}) {
    const extracted = deps.extractImageResult(result);
    const fileNames = root?.ChatUIFileNames || (typeof window !== 'undefined' ? window.ChatUIFileNames : null);
    if (extracted && extracted.kind === 'empty') return { html: '没有返回图片数据', raw: extracted.raw, metaText: elapsedText ? `RT ${elapsedText}` : '' };
    if (extracted && extracted.kind === 'raw') return { html: `<pre>${deps.escapeHtml(extracted.raw)}</pre>`, raw: extracted.raw, metaText: elapsedText ? `RT ${elapsedText}` : '' };
    const images = Array.isArray(extracted?.images) && extracted.images.length ? extracted.images : [];
    if (!images.length) return { html: '没有返回图片数据', raw: JSON.stringify(result, null, 2), metaText: elapsedText ? `RT ${elapsedText}` : '' };

    const config = deps.getConfig();
    const resultId = makeImageResultId(options, deps);
    if (!resultId) throw new Error('图片结果缺少稳定标识，未保存为完成消息。');
    const referenceId = deps.makeImageReferenceId ? deps.makeImageReferenceId(resultId) : `imgref_${resultId}`;
    const storedImages = [];
    for (let index = 0; index < images.length; index += 1) {
      const item = images[index];
      const ordinal = index + 1;
      const filename = fileNames?.timestampedFilename ? fileNames.timestampedFilename({ ext: 'png' }) : `${Date.now()}.png`;
      const persisted = await deps.persistImageSrc(item.src, filename, { ...config, returnDisplayUrl: true });
      const persistedSrc = String(persisted?.persistedSrc || '');
      if (!persistedSrc.startsWith('indexeddb://')) {
        throw new Error('图片已返回，但本地持久化失败；未保存为完成消息以避免刷新后丢失，请检查浏览器存储后重试。');
      }
      const size = await deps.settleWithin(deps.imageSrcSize(persistedSrc, config), 2000, null)
        || await deps.settleWithin(deps.imageSrcSize(item.src, config), 2000, null);
      const labels = Array.isArray(item.labels)
        ? item.labels.map(value => String(value || '').trim()).filter(Boolean).slice(0, 12)
        : [];
      const description = String(item.revisedPrompt || item.prompt || options.routePrompt || options.prompt || '').trim();
      const imageId = deps.makeImageItemId ? deps.makeImageItemId(referenceId, ordinal) : `img_${referenceId}_${ordinal}`;
      storedImages.push({
        id: imageId,
        imageId,
        resultId,
        ordinal,
        sourceIndex: ordinal,
        referenceId,
        src: persistedSrc,
        displaySrc: String(persisted?.displaySrc || ''),
        filename,
        name: filename,
        prompt: description,
        description,
        semantic_text: [description, ...labels].filter(Boolean).join(' | '),
        updatedAt: Date.now(),
        width: size?.width || 0,
        height: size?.height || 0,
        raw: item.raw,
        url: item.url || '',
        labels,
      });
    }

    const first = storedImages[0];
    const latestImage = {
      resultId,
      referenceId,
      src: first.src,
      filename: first.filename,
      prompt: options.prompt || '',
      updatedAt: Date.now(),
      width: first.width || 0,
      height: first.height || 0,
      images: storedImages.map(item => ({ ...item, displaySrc: '' })),
    };
    deps.saveLatestGeneratedImage(options.sessionId, latestImage);

    const attachments = storedImages.map(item => ({ ...item, displaySrc: '' }));
    const html = renderImageResultHtml(storedImages, {
      escapeHtml: deps.escapeHtml,
      downloadAllImagesButtonHtml: deps.downloadAllImagesButtonHtml,
      transparentPixel: root?.ChatUIApp?.imageStore?.TRANSPARENT_PIXEL || FALLBACK_TRANSPARENT_PIXEL,
    });
    return {
      raw: storedImages.map(item => item.raw).join('\n'),
      metaText: elapsedText ? `RT ${elapsedText}` : '',
      imageContext: {
        schema_version: 'image_result.v1',
        resultId,
        prompt: options.prompt || '',
        routePrompt: options.routePrompt || '',
        mode: 'image',
        target: 'previous',
        referenceId,
        selectedReferenceId: referenceId,
        usePreviousImage: true,
        updatedAt: Date.now(),
        attachments,
      },
      html,
    };
  }

  const api = Object.freeze({
    makeImageResultId,
    renderImageResultHtml,
    imageDescriptorsFromContext,
    mergeImageResultContexts,
    renderImageResultContext,
    imageResultToHtml,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppImageResultWorkflow = api;
  if (root?.window) root.window.ChatUIAppImageResultWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
