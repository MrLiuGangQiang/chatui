(function initChatUIClarificationPresentation(root) {
  'use strict';

  const appContext = root?.ChatUIApp?.appContext || (() => {
    try { return typeof require === 'function' ? require('../../app/app-context') : null; } catch { return null; }
  })();
  const imageRouteContext = root?.ChatUICoreImageRouteContext
    || root?.ChatUICore?.imageRouteContext
    || (() => {
      try { return typeof require === 'function' ? require('../../core/image-route-context') : {}; } catch { return {}; }
    })();
  const imageReferences = root?.ChatUICoreImageReferences
    || root?.ChatUICore?.imageReferences
    || (() => {
      try { return typeof require === 'function' ? require('../../core/image-references') : {}; } catch { return {}; }
    })();

  function escapeHtml(value = '') {
    return String(value ?? '').replace(/[&<>"'`]/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;',
    }[character]));
  }

  function parseContext(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      try { return parseContext(JSON.parse(value)); } catch { return null; }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function contextImages(value) {
    const context = parseContext(value);
    const images = Array.isArray(context?.attachments)
      ? context.attachments
      : Array.isArray(context?.images)
        ? context.images
        : [];
    return images.filter(item => item && typeof item === 'object' && (item.src || item.url || item.dataUrl || item.data_url));
  }

  function imageSource(item = {}) {
    const source = String(item.src || item.url || item.persistedSrc || item.persisted_src || item.dataUrl || item.data_url || '').trim();
    if (!source || /^(?:data|blob|javascript):/i.test(source)) return '';
    return source;
  }

  function imageName(item = {}) {
    return String(item.name || item.filename || '').replace(/\s+/g, ' ').trim();
  }

  function createImageLookup({ messages = [], lastGeneratedImage = null, currentImageContext = null, quotedImageContext = null } = {}) {
    const byId = new Map();
    const byReference = new Map();
    const current = [];

    function register(referenceId = '', items = [], options = {}) {
      const reference = String(referenceId || '').trim();
      const normalized = (Array.isArray(items) ? items : []).map((item, index) => ({
        ...item,
        src: imageSource(item),
        name: imageName(item),
        sourceIndex: Number(item.sourceIndex || item.source_index) || index + 1,
      }));
      if (reference && normalized.length) byReference.set(reference, normalized);
      normalized.forEach((item, index) => {
        const ids = [
          item.imageId, item.image_id, item.id, item.attachmentId, item.attachment_id,
          reference && typeof imageReferences.makeImageItemId === 'function'
            ? imageReferences.makeImageItemId(reference, item.sourceIndex || index + 1)
            : '',
        ].map(value => String(value || '').trim()).filter(Boolean);
        ids.forEach(id => byId.set(id, item));
        if (options.current) current[item.sourceIndex - 1] = item;
      });
    }

    const canonicalMessages = Array.isArray(messages) ? messages : [];
    const generatedReferences = typeof imageRouteContext.collectRecentImageReferences === 'function'
      ? imageRouteContext.collectRecentImageReferences({ messages: canonicalMessages, lastGeneratedImage, limit: Number.MAX_SAFE_INTEGER })
      : [];
    generatedReferences.forEach(reference => register(reference.reference_id, reference.images || []));

    const uploadedReferences = typeof imageRouteContext.collectRecentUploadedImageReferences === 'function'
      ? imageRouteContext.collectRecentUploadedImageReferences({ messages: canonicalMessages, limit: Number.MAX_SAFE_INTEGER })
      : [];
    uploadedReferences.forEach(reference => {
      const message = canonicalMessages[Number(reference.message_index) - 1] || {};
      const items = contextImages(message.imageContext).length
        ? contextImages(message.imageContext)
        : contextImages(message.attachmentContext);
      register(reference.reference_id, items, { current: reference.message_index === canonicalMessages.length });
    });

    const latest = lastGeneratedImage?.images || (lastGeneratedImage?.src ? [lastGeneratedImage] : []);
    if (latest.length) register('imgref_latest', latest);
    register('', contextImages(currentImageContext), { current: true });
    register('', contextImages(quotedImageContext));

    return { byId, byReference, current };
  }

  function resolveChoiceImage(choice = {}, lookup = {}) {
    const direct = lookup.byId?.get?.(String(choice.id || '').trim());
    if (direct) return direct;
    const parsed = typeof imageReferences.parseImageItemId === 'function'
      ? imageReferences.parseImageItemId(choice.id)
      : null;
    const referenceId = String(choice.reference_id || parsed?.referenceId || '').trim();
    const reference = lookup.byReference?.get?.(referenceId) || [];
    if (reference.length) {
      if (parsed?.index) return reference[parsed.index - 1] || null;
      if (reference.length === 1) return reference[0];
    }
    if (choice.source === 'current') return lookup.current?.[Number(choice.index) - 1] || null;
    return null;
  }

  function compactLabel(value = '', max = 64) {
    const seen = new Set();
    const parts = String(value || '').split(/\s*(?:\||·)\s*/).map(item => item.replace(/\s+/g, ' ').trim()).filter(item => {
      const fingerprint = item.toLocaleLowerCase();
      if (!item || seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    });
    const filename = parts.find(item => /\.[a-z0-9]{2,8}$/i.test(item));
    const label = filename || parts[0] || '';
    return label.length > max ? `${label.slice(0, max - 1)}…` : label;
  }

  function questionHtml(question = '') {
    return escapeHtml(question).replace(/\r?\n/g, '<br>');
  }

  function buildClarificationPresentation(routeInfo = {}, options = {}) {
    const question = String(routeInfo.clarificationQuestion || '请选择要使用的图片。').trim();
    const slots = (Array.isArray(routeInfo.clarificationSlots) ? routeInfo.clarificationSlots : [])
      .filter(slot => slot?.type === 'image' && Array.isArray(slot.choices) && slot.choices.length);
    if (!slots.length) return { rawText: question, html: '', hasImageChoices: false };

    const lookup = createImageLookup(options);
    const multipleSlots = slots.length > 1;
    const sections = slots.map((slot, slotIndex) => {
      const cards = slot.choices.map((choice, choiceIndex) => {
        const ordinal = choiceIndex + 1;
        const item = resolveChoiceImage(choice, lookup);
        const source = imageSource(item || {});
        const media = source
          ? `<img class="clarification-choice-image" data-persisted-src="${escapeHtml(source)}" data-original-src="${escapeHtml(source)}" alt="候选图片 ${ordinal}" />`
          : `<span class="clarification-choice-placeholder" aria-label="候选图片 ${ordinal} 暂时无法预览">图片暂时无法预览</span>`;
        return `<li class="clarification-choice-card" data-resource-key="${escapeHtml(slot.key || '')}" data-choice-key="${escapeHtml(choice.key || '')}"><span class="clarification-choice-number">${ordinal}</span><div class="clarification-choice-media">${media}</div></li>`;
      }).join('');
      const heading = multipleSlots
        ? `<h4 class="clarification-choice-heading">第 ${slotIndex + 1} 组图片</h4>`
        : '';
      return `<section class="clarification-choice-section" aria-label="图片候选组 ${slotIndex + 1}">${heading}<ol class="clarification-image-list">${cards}</ol></section>`;
    }).join('');

    const html = `<div class="clarification-presentation" data-clarification-image-choices="1"><p class="clarification-question">${questionHtml(question)}</p>${sections}<p class="clarification-choice-hint">请回复一个编号（如“2”或“第 2 张”）。一次只能选择一张图片。</p></div>`;
    return { rawText: question, html, hasImageChoices: true };
  }

  const api = Object.freeze({
    buildClarificationPresentation,
    compactLabel,
    createImageLookup,
    resolveChoiceImage,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (appContext?.registerWorkflowModule) appContext.registerWorkflowModule('clarificationPresentation', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
