(function initChatUIAppImageResultWorkflow(root) {
  'use strict';

  const FALLBACK_TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  const imageCaptionModule = root?.ChatUIAppImageCaptionWorkflow
    || (typeof require === 'function' ? require('./image-caption-workflow') : {});
  const applyImageCaptions = imageCaptionModule.applyImageCaptions || ((images = []) => (Array.isArray(images) ? images : []).map(item => ({ ...item })));

  function makeImageResultId(options = {}, deps = {}) {
    const existing = String(options.resultId || options.imageResultId || '').trim();
    if (existing) return existing;
    if (typeof deps.makeImageResultId === 'function') return String(deps.makeImageResultId(options) || '').trim();
    return `imgres_${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 6)}`;
  }

  // Generated-image markup is kept in one place so live, restored, and batch
  // results share the same stable DOM contract.
  function imageItemHtml(item = {}, index = 0, {
    escapeHtml = value => String(value || ''),
    transparentPixel = FALLBACK_TRANSPARENT_PIXEL,
    maxWidth = 180,
    maxHeight = 120,
  } = {}) {
    const ordinal = Number(item.ordinal || item.position || item.sourceIndex || item.source_index || index + 1) || index + 1;
    const width = Number(item.width) || 180;
    const height = Number(item.height) || 120;
    const boundedWidth = Math.max(1, Number(maxWidth) || 180);
    const boundedHeight = Math.max(1, Number(maxHeight) || 120);
    const scale = Math.min(boundedWidth / width, boundedHeight / height, 1);
    const thumbWidth = Math.max(1, Math.round(width * scale));
    const thumbHeight = Math.max(1, Math.round(height * scale));
    const persistedSrc = String(item.src || item.persistedSrc || '');
    const displaySrc = String(item.displaySrc || '') || transparentPixel;
    const referenceId = String(item.referenceId || item.reference_id || '');
    const imageId = String(item.imageId || item.image_id || item.id || '');
    return `<div class="generated-image-item" data-image-index="${ordinal}" data-image-result-id="${escapeHtml(item.resultId || '')}" aria-label="第 ${ordinal} 张图片"><img class="generated-thumb${displaySrc === transparentPixel ? ' image-restoring' : ''}" width="${thumbWidth}" height="${thumbHeight}" style="--thumb-w:${thumbWidth}px;--thumb-h:${thumbHeight}px;width:${thumbWidth}px;height:${thumbHeight}px;aspect-ratio:${thumbWidth}/${thumbHeight};object-fit:contain" src="${escapeHtml(displaySrc)}" data-persisted-src="${escapeHtml(persistedSrc)}" data-original-src="${escapeHtml(persistedSrc)}" data-filename="${escapeHtml(item.name || item.filename || `image-${ordinal}.png`)}" data-reference-id="${escapeHtml(referenceId)}" data-image-id="${escapeHtml(imageId)}" data-image-index="${ordinal}" data-image-result-id="${escapeHtml(item.resultId || '')}" data-thumb-width="${thumbWidth}" data-thumb-height="${thumbHeight}" data-original-width="${width}" data-original-height="${height}" alt="第 ${ordinal} 张生成图片" /></div>`;
  }

  function imageItemsHtml(images = [], options = {}) {
    const visible = (Array.isArray(images) ? images : []).filter(item => String(item?.src || item?.persistedSrc || '').startsWith('indexeddb://'));
    return visible.map((item, index) => imageItemHtml(item, index, options)).join('');
  }

  function renderImageResultHtml(images = [], { escapeHtml = value => String(value || ''), downloadAllImagesButtonHtml = () => '', transparentPixel = FALLBACK_TRANSPARENT_PIXEL } = {}) {
    const visible = (Array.isArray(images) ? images : []).filter(item => String(item?.src || item?.persistedSrc || '').startsWith('indexeddb://'));
    if (!visible.length) return '';
    const actions = downloadAllImagesButtonHtml();
    // A single image uses the same reserved-slot geometry as a multi-image
    // batch, so its pending card and completed thumbnail have identical layout.
    if (visible.length === 1) {
      const grid = renderImageBatchSlotsHtml(1, [{ attachments: visible }], {
        slotStatuses: ['已完成'],
        escapeHtml,
        transparentPixel,
      });
      return `${grid}${actions ? `<div class="image-download-row">${actions}</div>` : ''}`;
    }
    const items = imageItemsHtml(visible, { escapeHtml, transparentPixel });
    return `<div class="generated-image-grid" data-generated-images="1">${items}</div>${actions ? `<div class="image-download-row">${actions}</div>` : ''}`;
  }

  function batchStatusHtml(statusHtml = '', complete = false) {
    const value = String(statusHtml || '');
    if (!value) return '';
    return `<div class="batch-status-container${complete ? ' batch-status-complete' : ''}">${value}</div>`;
  }

  function normalizeImageBatchSlotSize(value = 'auto') {
    const raw = String(value || '').trim().toLowerCase();
    const match = raw.match(/^(\d{2,5})\s*x\s*(\d{2,5})$/);
    const sourceWidth = match ? Number(match[1]) : 3;
    const sourceHeight = match ? Number(match[2]) : 2;
    const width = Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : 3;
    const height = Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : 2;
    const slotWidth = 180;
    const slotHeight = 120;
    return {
      key: match ? `${width}x${height}` : 'auto',
      width,
      height,
      slotWidth,
      slotHeight,
    };
  }

  function batchSlotSizeForIndex(slotIndex, slotSizes, slotSize) {
    const selected = Array.isArray(slotSizes) ? slotSizes[slotIndex] : slotSize;
    return normalizeImageBatchSlotSize(selected || 'auto');
  }

  // Pending slots use one predictable thumbnail box. Once image dimensions are
  // known, only the slot width expands/contracts to preserve the image ratio.
  function batchSlotGeometry(slotIndex, descriptors = [], slotSizes = [], slotSize = 'auto') {
    const preset = batchSlotSizeForIndex(slotIndex, slotSizes, slotSize);
    const first = Array.isArray(descriptors) ? descriptors[0] : null;
    const imageWidth = Number(first?.width) || 0;
    const imageHeight = Number(first?.height) || 0;
    if (imageWidth > 0 && imageHeight > 0) {
      return {
        ...preset,
        slotWidth: Math.max(120, Math.min(360, Math.round(preset.slotHeight * imageWidth / imageHeight))),
        resolved: true,
      };
    }
    return { ...preset, slotWidth: 120, slotHeight: 120, resolved: false };
  }

  function batchSlotPendingHtml(slotIndex, total, status = '', escapeHtml = value => String(value || '')) {
    const statusText = String(status || '等待开始').trim() || '等待开始';
    return `<div class="generated-image-slot-skeleton generated-image-slot-pending" role="status" aria-live="polite"><span class="generated-image-slot-status">${escapeHtml(statusText)}</span><span class="pending-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>`;
  }

  function batchSlotInnerHtml(slotIndex, total, descriptors, {
    statuses = [],
    escapeHtml = value => String(value || ''),
    transparentPixel = FALLBACK_TRANSPARENT_PIXEL,
    slotSizes = [],
    slotSize = 'auto',
  } = {}) {
    const size = batchSlotGeometry(slotIndex, descriptors, slotSizes, slotSize);
    return descriptors.length
      ? imageItemsHtml(descriptors, {
          escapeHtml,
          transparentPixel,
          maxWidth: size.slotWidth,
          maxHeight: size.slotHeight,
        })
      : batchSlotPendingHtml(slotIndex, total, statuses?.[slotIndex], escapeHtml);
  }

  function renderImageBatchSlotsHtml(total = 0, childContexts = [], {
    statuses = [],
    slotStatuses = statuses,
    slotSizes = [],
    slotSize = 'auto',
    escapeHtml = value => String(value || ''),
    transparentPixel = FALLBACK_TRANSPARENT_PIXEL,
  } = {}) {
    const count = Math.max(0, Number(total) || 0);
    const slots = Array.from({ length: count }, (_, slotIndex) => {
      const context = childContexts?.[slotIndex];
      const descriptors = imageDescriptorsFromContext(context || {});
      const state = descriptors.length ? 'done' : 'pending';
      const size = batchSlotGeometry(slotIndex, descriptors, slotSizes, slotSize);
      const status = String(slotStatuses?.[slotIndex] || '等待开始');
      const inner = batchSlotInnerHtml(slotIndex, count, descriptors, {
        statuses: slotStatuses,
        escapeHtml,
        transparentPixel,
        slotSizes,
        slotSize,
      });
      return `<div class="generated-image-batch-slot" data-image-batch-slot="${slotIndex}" data-image-batch-slot-state="${state}" data-image-batch-slot-status="${escapeHtml(status)}" data-image-batch-slot-size="${size.key}" data-image-batch-slot-resolved="${size.resolved ? '1' : '0'}" style="--batch-slot-width:${size.slotWidth}px;--batch-slot-height:${size.slotHeight}px;--batch-slot-aspect:auto;aspect-ratio:auto;width:${size.slotWidth}px" aria-label="第 ${slotIndex + 1} 个图片任务"><div class="generated-image-slot-content">${inner}</div></div>`;
    }).join('');
    return `<div class="generated-image-grid generated-image-batch-grid" data-generated-images="1" data-image-batch-total="${count}">${slots}</div>`;
  }

  function renderImageBatchResultHtml({ total = 0, childContexts = [], imageContext = {}, statuses = [], slotStatuses = statuses, slotSizes = [], slotSize = 'auto', statusHtml = '', complete = false, escapeHtml = value => String(value || ''), downloadAllImagesButtonHtml = () => '', transparentPixel = FALLBACK_TRANSPARENT_PIXEL } = {}) {
    const completedImages = complete ? batchCompletionDescriptors(imageContext, childContexts) : [];
    if (completedImages.length) {
      return renderImageResultHtml(completedImages, { escapeHtml, downloadAllImagesButtonHtml, transparentPixel });
    }
    const grid = renderImageBatchSlotsHtml(total, childContexts, { slotStatuses, slotSizes, slotSize, escapeHtml, transparentPixel });
    if (!grid) return batchStatusHtml(statusHtml, complete);
    const actions = downloadAllImagesButtonHtml();
    // Pending status belongs to its reserved slot. Keeping a separate multiline
    // status block above the grid creates a second visual row and makes one batch
    // look like several duplicated assistant messages.
    return `${grid}${actions ? `<div class="image-download-row">${actions}</div>` : ''}`;
  }

  function patchImageBatchDisplayNode(node, { total = 0, childContexts = [], imageContext = {}, statuses = [], slotStatuses = statuses, slotSizes = [], slotSize = 'auto', statusHtml = '', complete = false, escapeHtml = value => String(value || ''), downloadAllImagesButtonHtml = () => '', transparentPixel = FALLBACK_TRANSPARENT_PIXEL, afterPatch = null } = {}) {
    const content = node?.querySelector?.('.content');
    if (!content) return false;
    const completedImages = complete ? batchCompletionDescriptors(imageContext, childContexts) : [];
    if (completedImages.length) {
      // Pending slots are transient execution UI. Terminal output must switch to
      // the same canonical renderer used by history restoration, otherwise the
      // image wrappers, ordinals, and flow position change after a refresh.
      content.innerHTML = renderImageResultHtml(completedImages, { escapeHtml, downloadAllImagesButtonHtml, transparentPixel });
      afterPatch?.(node);
      return true;
    }
    let grid = content.querySelector('.generated-image-batch-grid');
    if (!grid) {
      content.innerHTML = renderImageBatchResultHtml({ total, childContexts, slotStatuses, slotSizes, slotSize, statusHtml, complete, escapeHtml, downloadAllImagesButtonHtml, transparentPixel });
      afterPatch?.(node);
      return true;
    }
    grid.dataset.imageBatchTotal = String(Math.max(0, Number(total) || 0));
    const expected = Math.max(0, Number(total) || 0);
    for (let slotIndex = 0; slotIndex < expected; slotIndex += 1) {
      let slot = grid.querySelector(`[data-image-batch-slot="${slotIndex}"]`);
      if (!slot) {
        const holder = (node.ownerDocument || root?.document)?.createElement?.('div');
        if (!holder) return false;
        holder.innerHTML = renderImageBatchSlotsHtml(expected, childContexts, { slotStatuses, slotSizes, slotSize, escapeHtml, transparentPixel });
        const fresh = holder.firstElementChild?.querySelector(`[data-image-batch-slot="${slotIndex}"]`);
        if (fresh) grid.appendChild(fresh);
        slot = fresh;
      }
      const context = childContexts?.[slotIndex];
      const descriptors = imageDescriptorsFromContext(context || {});
      const nextState = descriptors.length ? 'done' : 'pending';
      const nextStatus = String(slotStatuses?.[slotIndex] || '等待开始');
      const nextSize = batchSlotGeometry(slotIndex, descriptors, slotSizes, slotSize);
      const slotContent = slot.querySelector('.generated-image-slot-content') || slot;
      if (slot.dataset.imageBatchSlotState !== nextState
          || slot.dataset.imageBatchSlotStatus !== nextStatus
          || slot.dataset.imageBatchSlotSize !== nextSize.key
          || slot.dataset.imageBatchSlotResolved !== (nextSize.resolved ? '1' : '0')) {
        slot.dataset.imageBatchSlotState = nextState;
        slot.dataset.imageBatchSlotStatus = nextStatus;
        slot.dataset.imageBatchSlotSize = nextSize.key;
        slot.dataset.imageBatchSlotResolved = nextSize.resolved ? '1' : '0';
        slot.style.setProperty('--batch-slot-width', `${nextSize.slotWidth}px`);
        slot.style.setProperty('--batch-slot-height', `${nextSize.slotHeight}px`);
        slot.style.setProperty('--batch-slot-aspect', 'auto');
        slot.style.aspectRatio = 'auto';
        slot.style.width = `${nextSize.slotWidth}px`;
        slotContent.innerHTML = batchSlotInnerHtml(slotIndex, expected, descriptors, {
          statuses: slotStatuses,
          escapeHtml,
          transparentPixel,
          slotSizes,
          slotSize,
        });
      }
    }
    // Older DOM snapshots may still contain the former external status block.
    // Remove it once the stable slot grid exists so refresh converges to the new
    // single-card layout without leaving duplicate waiting rows behind.
    content.querySelector('.batch-status-container')?.remove();
    afterPatch?.(node);
    return true;
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
      }));
  }

  function batchCompletionDescriptors(imageContext = {}, childContexts = []) {
    const canonical = imageDescriptorsFromContext(imageContext);
    if (canonical.length) return canonical;
    const seen = new Set();
    const merged = [];
    for (const context of Array.isArray(childContexts) ? childContexts : []) {
      for (const item of imageDescriptorsFromContext(context || {})) {
        const key = String(item.src || item.persistedSrc || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    }
    return merged.map((item, index) => ({ ...item, ordinal: index + 1, sourceIndex: index + 1 }));
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

  function renderImageBatchResult(imageContext = {}, options = {}, deps = {}) {
    return renderImageBatchResultHtml({
      ...options,
      total: options.total,
      childContexts: options.childContexts || [],
      imageContext: options.imageContext || imageContext,
      statusHtml: options.statusHtml || '',
      complete: !!options.complete,
      escapeHtml: deps.escapeHtml,
      downloadAllImagesButtonHtml: deps.downloadAllImagesButtonHtml,
      transparentPixel: root?.ChatUIApp?.imageStore?.TRANSPARENT_PIXEL || FALLBACK_TRANSPARENT_PIXEL,
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
    // Internal tags come from the image_plan.v1 label field (produced by the
    // same planning model call), so no separate model call is made here. The
    // label is applied synchronously to stored records for routing only and is
    // never rendered in the chat UI.
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

    const planLabel = String(options.label || '').trim();
    if (planLabel) {
      const captions = storedImages.map((item, index) => ({ index: index + 1, description: planLabel }));
      const enrichedImages = applyImageCaptions(storedImages, captions);
      storedImages.length = 0;
      storedImages.push(...enrichedImages);
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

    const attachments = storedImages.map(item => ({ ...item }));
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
        resolvedGoal: options.resolvedGoal || options.routePrompt || options.prompt || '',
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
    normalizeImageBatchSlotSize,
    renderImageBatchSlotsHtml,
    renderImageBatchResultHtml,
    renderImageBatchResult,
    patchImageBatchDisplayNode,
    imageResultToHtml,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppImageResultWorkflow = api;
  if (root?.window) root.window.ChatUIAppImageResultWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
