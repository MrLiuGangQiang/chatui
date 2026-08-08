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

  const { parseContext } = root?.[Symbol.for('chatui.module-registry.v1')]?.get('messagePrimitives')
    || (() => { try { return typeof require === 'function' ? require('../../core/message-primitives') : {}; } catch { return {}; } })();

  function escapeHtml(value = '') {
    return String(value ?? '').replace(/[&<>"'`]/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;',
    }[character]));
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

  function routePreviewResource(routeInfo = {}) {
    const direct = Array.isArray(routeInfo?.imageRefs) ? routeInfo.imageRefs : [];
    const target = direct.find(item => item?.role === 'target') || direct.find(item => item?.role === 'reference') || direct[0] || null;
    const execution = routeInfo?.executionResources;
    const resources = Array.isArray(execution?.targets) && execution.targets.length
      ? execution.targets
      : Array.isArray(execution?.references) ? execution.references : [];
    const resource = resources.find(item => String(item?.id || item?.image_id || '') === String(target?.image_id || target?.id || ''))
      || resources[0] || null;
    return { target, resource };
  }

  function buildExecutionPreviewPresentation(routeInfo = {}, options = {}) {
    const operation = String(routeInfo?.operationType || routeInfo?.operation || '').trim();
    if (!['edit_image', 'image_reference_gen'].includes(operation)) return { text: '', html: '' };
    const { target, resource } = routePreviewResource(routeInfo);
    if (!target && !resource) return { text: '', html: '' };
    const lookup = createImageLookup(options);
    const item = resolveChoiceImage({
      id: target?.image_id || target?.id || resource?.id || '',
      reference_id: target?.reference_id || target?.referenceId || resource?.reference_id || '',
      index: target?.index || resource?.index || 1,
      source: target?.source || resource?.source || 'history',
    }, lookup);
    const source = imageSource(item || {});
    const label = compactLabel(
      resource?.label || resource?.description || resource?.semantic_text || resource?.prompt
      || item?.description || item?.semantic_description || item?.prompt || item?.name || item?.filename
      || '已选择的图片',
      96,
    ) || '已选择的图片';
    const instruction = String(
      routeInfo?.editInstruction || routeInfo?.contextualImagePrompt || routeInfo?.executionPlan?.arguments?.prompt || '',
    ).replace(/\s+/g, ' ').trim().slice(0, 140);
    const action = operation === 'edit_image' ? '将修改这张图片' : '将参考这张图片';
    const text = `${action}：${label}${instruction && operation === 'edit_image' ? `；修改内容：${instruction}` : ''}`;
    const media = source
      ? `<img class="route-execution-preview-image" data-route-execution-preview="1" data-persisted-src="${escapeHtml(source)}" data-original-src="${escapeHtml(source)}" alt="本次要使用的图片" />`
      : '<span class="route-execution-preview-placeholder" aria-label="本次要使用的图片暂时无法预览">图片暂时无法预览</span>';
    const detail = instruction && operation === 'edit_image'
      ? `<p class="route-execution-preview-detail">修改内容：${escapeHtml(instruction)}</p>`
      : '';
    return {
      text,
      html: `<section class="route-execution-preview" data-route-execution-preview="1"><div class="route-execution-preview-media">${media}</div><div class="route-execution-preview-copy"><strong>${escapeHtml(action)}</strong><span>${escapeHtml(label)}</span>${detail}</div></section>`,
    };
  }

  function buildClarificationPresentation(routeInfo = {}, options = {}) {
    const question = String(routeInfo.clarificationQuestion || '请选择要使用的图片。').trim();
    const slots = (Array.isArray(routeInfo.clarificationSlots) ? routeInfo.clarificationSlots : [])
      .filter(slot => slot?.type === 'image' && Array.isArray(slot.choices) && slot.choices.length);
    if (slots.length) {
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
          return `<li class="clarification-choice-card" data-resource-key="${escapeHtml(slot.key || '')}" data-choice-key="${escapeHtml(choice.key || '')}"><div class="clarification-choice-media"><span class="clarification-choice-number" aria-hidden="true">${ordinal}</span>${media}</div></li>`;
        }).join('');
        const heading = multipleSlots
          ? `<h4 class="clarification-choice-heading">第 ${slotIndex + 1} 组图片</h4>`
          : '';
        return `<section class="clarification-choice-section" aria-label="图片候选组 ${slotIndex + 1}">${heading}<ol class="clarification-image-list">${cards}</ol></section>`;
      }).join('');

      const html = `<div class="clarification-presentation" data-clarification-image-choices="1"><p class="clarification-question">${questionHtml(question)}</p>${sections}<p class="clarification-choice-hint">请回复一个编号（如“2”或“第 2 张”）。一次只能选择一张图片。</p></div>`;
      return { rawText: question, html, hasImageChoices: true, hasChoices: true };
    }

    const choiceSlots = (Array.isArray(routeInfo.clarificationSlots) ? routeInfo.clarificationSlots : [])
      .filter(slot => Array.isArray(slot.choices) && slot.choices.length);
    if (choiceSlots.length) {
      const multipleChoiceSlots = choiceSlots.length > 1;
      const sections = choiceSlots.map((slot, slotIndex) => {
        const explicitLabel = String(slot.parameter_label || slot.label || '').trim();
        const label = explicitLabel || (multipleChoiceSlots ? `选项 ${slotIndex + 1}` : '');
        const cards = slot.choices.map((choice, choiceIndex) => {
          const ordinal = choiceIndex + 1;
          const labelText = String(choice.label || choice.value || `选项 ${ordinal}`);
          const displayText = compactLabel(labelText, 96);
          return `<li class="clarification-choice-card" data-resource-key="${escapeHtml(slot.key || '')}" data-choice-key="${escapeHtml(choice.key || '')}"><button type="button" class="clarification-choice-button" data-resource-key="${escapeHtml(slot.key || '')}" data-choice-key="${escapeHtml(choice.key || '')}" data-choice-label="${escapeHtml(labelText)}" aria-pressed="false"><span class="clarification-choice-number" aria-hidden="true">${ordinal}</span><span class="clarification-choice-label">${escapeHtml(displayText)}</span></button></li>`;
        }).join('');
        const heading = label ? `<h4 class="clarification-choice-heading">${escapeHtml(label)}</h4>` : '';
        return `<section class="clarification-choice-section" aria-label="${escapeHtml(label || '候选选项')}">${heading}<ol class="clarification-choice-list">${cards}</ol></section>`;
      }).join('');
      const html = `<div class="clarification-presentation" data-clarification-choice-options="1"><p class="clarification-question">${questionHtml(question)}</p>${sections}</div>`;
      return { rawText: question, html, hasImageChoices: false, hasChoices: true };
    }
    return { rawText: question, html: '', hasImageChoices: false, hasChoices: false };
  }

  const api = Object.freeze({
    buildClarificationPresentation,
    buildExecutionPreviewPresentation,
    compactLabel,
    createImageLookup,
    resolveChoiceImage,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (appContext?.registerWorkflowModule) appContext.registerWorkflowModule('clarificationPresentation', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
