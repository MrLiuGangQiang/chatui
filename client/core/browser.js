(function () {
  function normalizeError(error, payload) {
    return payload && payload.error && payload.error.message
      ? payload.error.message
      : payload && payload.error && payload.error.code
        ? payload.error.code
        : payload && payload.message
          ? payload.message
          : payload && payload.raw
            ? payload.raw
            : error && error.message || '请求失败';
  }

  function toProxyUrl(url, baseUrl) {
    return String(url || '').startsWith(baseUrl) ? `/api${String(url).slice(String(baseUrl).length)}` : url;
  }

  async function parseResponseJson(response) {
    const text = await response.text();
    try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
  }

  function normalizeReasoningText(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(item => normalizeReasoningText(item && (item.text || item.content || item.summary || item.reasoning || item.thinking) || item)).filter(Boolean).join('\n');
    if (typeof value === 'object') return normalizeReasoningText(value.text || value.content || value.summary || value.reasoning || value.thinking || value.reasoning_content || value.thinking_content || value.reasoning_details || value.output_text || '');
    return String(value || '');
  }

  function extractStreamDelta(event) {
    const choice = event && event.choices && event.choices[0];
    const delta = choice && choice.delta || {};
    const message = choice && choice.message || {};
    const reasoning = normalizeReasoningText(delta.reasoning_content || delta.reasoning || delta.thinking || delta.reasoning_details || delta.thinking_content || message.reasoning_content || message.reasoning || message.thinking || message.reasoning_details || message.thinking_content || event && (event.reasoning_content || event.reasoning || event.thinking || event.reasoning_details || event.thinking_content) || '');
    let content = delta.content || message.content || (typeof (event && event.delta) === 'string' ? event.delta : '') || (typeof (event && event.content) === 'string' ? event.content : '') || '';
    if (!content && Array.isArray(event && event.output)) content = event.output.map(item => item && item.content && item.content.map(part => part && part.text || '').join('') || '').join('');
    const outputReasoning = !reasoning && Array.isArray(event && event.output) ? normalizeReasoningText(event.output.filter(item => /reason/i.test(String(item && (item.type || item.role) || '')) || item && (item.summary || item.reasoning || item.thinking))) : '';
    return { content, reasoning: reasoning || outputReasoning };
  }

  function reasoningBudgetTokens(level) {
    return { low: 1024, medium: 4096, high: 8192, xhigh: 16384 }[level || 'medium'] || 4096;
  }



  function normalizeModelType(type) {
    const value = String(type || '').trim().toLowerCase();
    if (!value) return '';
    if (/image|image_generation|image-generation|imagegeneration|vision|picture|img|dall|gpt-image|flux|sd|stable|midjourney|wan|kling/.test(value)) return 'image';
    if (/chat|text|llm|language|completion|reason|assistant|gpt|claude|gemini|qwen|deepseek|llama|mistral/.test(value)) return 'chat';
    if (/embedding|embed/.test(value)) return 'embedding';
    return value;
  }

  function inferModelType(model) {
    const explicit = model && typeof model !== 'string' ? normalizeModelType(model.type || model.model_type || model.modelType || model.mode || model.category || model.task || model.capability || (Array.isArray(model.capabilities) ? model.capabilities.join(',') : '')) : '';
    if (explicit) return explicit;
    const id = String(typeof model === 'string' ? model : model && (model.id || model.name) || '').toLowerCase();
    if (/embedding|embed/.test(id)) return 'embedding';
    if (/image|dall-e|gpt-image|imagen|flux|sdxl|midjourney|wan2\.?[0-9]?/.test(id)) return 'image';
    return '';
  }

  function extractModels(payload) {
    const data = Array.isArray(payload && payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
    const meta = {};
    const models = [];
    data.forEach(item => {
      const id = typeof item === 'string' ? item : item && (item.id || item.name);
      if (!id) return;
      const modelId = String(id);
      const explicit = !!(item && typeof item !== 'string' && [item.type, item.model_type, item.modelType, item.mode, item.category, item.task, item.capability, Array.isArray(item.capabilities) ? item.capabilities.join(',') : ''].some(value => String(value || '').trim()));
      const type = inferModelType(item);
      meta[modelId] = { id: modelId, type, unrecognized: !explicit || !type, inferred: !explicit && !!type };
      models.push(modelId);
    });
    return { models: Array.from(new Set(models)).sort(), meta };
  }

  function isModelAllowedFor(modelId, targetType, meta) {
    const type = meta && meta[modelId] && meta[modelId].type || '';
    if (!type) return true;
    return targetType === 'image' ? type === 'image' : targetType !== 'chat' || type !== 'image';
  }



  function isImageFile(file) {
    const type = String(file && file.type || '').toLowerCase();
    const name = String(file && file.name || '').toLowerCase();
    return type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
  }

  function isCompressibleRasterImage(file) {
    const type = String(file && file.type || '').toLowerCase();
    const name = String(file && file.name || '').toLowerCase();
    return /image\/(png|jpe?g|webp)/i.test(type) || /\.(png|jpe?g|webp)$/i.test(name);
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1048576) return `${(value / 1024 / 1024).toFixed(1)}MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)}KB`;
    return `${value}B`;
  }

  function looksLikeImageEditInstruction(text) {
    return /(换|替换|改|修改|编辑|调整|优化|重做|修|去掉|加上|放大|缩小|变成|换个|换成|logo|图标|背景|颜色|字体|样式|清晰|高清|edit|change|remove|replace|add)/i.test(String(text || ''));
  }

  function parseImageContext(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return null; }
  }

  const IMAGE_REFERENCE_PREFIX = 'imgref_';
  const IMAGE_ITEM_PREFIX = 'img_';

  function sanitizeImageReferencePart(value) {
    return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || 'latest';
  }

  function makeImageReferenceId(value) {
    const text = String(value || 'latest');
    return text.startsWith(IMAGE_REFERENCE_PREFIX) ? text : `${IMAGE_REFERENCE_PREFIX}${sanitizeImageReferencePart(text)}`;
  }

  function parseImageReferenceId(value) {
    const text = String(value || '');
    if (!text || text === 'latest' || text === `${IMAGE_REFERENCE_PREFIX}latest`) return 'latest';
    return text.startsWith(IMAGE_REFERENCE_PREFIX) ? text.slice(IMAGE_REFERENCE_PREFIX.length) : text;
  }

  function makeImageItemId(reference, index) {
    return `${IMAGE_ITEM_PREFIX}${makeImageReferenceId(reference || 'latest')}_${Number(index) || 1}`;
  }

  function normalizeSelectedImageIds(value) {
    const ids = Array.isArray(value)
      ? value
      : Array.isArray(value && value.image_ids)
        ? value.image_ids
        : Array.isArray(value && value.imageIds)
          ? value.imageIds
          : [];
    return ids.map(item => String(item || '').trim()).filter(item => item.startsWith(IMAGE_ITEM_PREFIX)).filter((item, index, list) => list.indexOf(item) === index);
  }

  function resolveImageSelectionFromIds(ids, reference, maxCount) {
    const referenceId = makeImageReferenceId(reference || 'latest');
    const indexes = [];
    for (const id of ids || []) {
      const match = String(id || '').match(/^img_(.+)_(\d+)$/);
      if (!match || match[1] !== referenceId) continue;
      const index = Number(match[2]);
      if (Number.isInteger(index) && index >= 1 && (!maxCount || index <= maxCount)) indexes.push(index);
    }
    return indexes.filter((item, index, list) => list.indexOf(item) === index);
  }

  function normalizeImageSelection(value, maxCount) {
    if (!value) return null;
    let indexes = [];
    if (Array.isArray(value)) indexes = value;
    else if (Array.isArray(value.indexes)) indexes = value.indexes;
    else if (Array.isArray(value.indices)) indexes = value.indices;
    else if (Number.isFinite(Number(value.index))) indexes = [value.index];
    else if (Number.isFinite(Number(value.image_index))) indexes = [value.image_index];
    else if (Number.isFinite(Number(value.imageIndex))) indexes = [value.imageIndex];
    return indexes.map(Number).filter(item => Number.isInteger(item) && item >= 1 && (!maxCount || item <= maxCount)).filter((item, index, list) => list.indexOf(item) === index);
  }



  const DEFAULT_ROUTE_CONTEXT_MAX_CHARS = 256 * 1024;
  function routeContextSize(value) { try { return JSON.stringify(value || {}).length; } catch { return Infinity; } }
  function compactRouteMessage(message = {}, index = 0) { return { index, role: message.role || '', content: String(Array.isArray(message.content) ? message.rawText || '[非文本消息]' : message.content || message.rawText || '').slice(0, 600) }; }
  function trimRouteContextToSize(context = {}, maxChars = DEFAULT_ROUTE_CONTEXT_MAX_CHARS) {
    const limit = Number(maxChars) || DEFAULT_ROUTE_CONTEXT_MAX_CHARS;
    const next = { ...context, recent_messages: Array.isArray(context.recent_messages) ? [...context.recent_messages] : [], recent_image_references: Array.isArray(context.recent_image_references) ? [...context.recent_image_references] : [] };
    if (routeContextSize(next) <= limit) return next;
    while (next.recent_messages.length && routeContextSize(next) > limit) next.recent_messages.shift();
    while (next.recent_image_references.length > 1 && routeContextSize(next) > limit) next.recent_image_references.pop();
    const shrinkPrompt = item => {
      if (!item || typeof item !== 'object') return item;
      const copy = { ...item };
      if (copy.prompt) copy.prompt = String(copy.prompt).slice(0, 160);
      if (Array.isArray(copy.candidates)) copy.candidates = copy.candidates.map(candidate => ({ ...candidate, prompt: String(candidate.prompt || '').slice(0, 80) }));
      return copy;
    };
    if (routeContextSize(next) > limit) {
      next.last_generated_image = shrinkPrompt(next.last_generated_image);
      next.latest_uploaded_image = shrinkPrompt(next.latest_uploaded_image);
      next.latest_image_reference = shrinkPrompt(next.latest_image_reference);
      next.recent_image_references = next.recent_image_references.map(shrinkPrompt);
    }
    return next;
  }
  function buildRouteContext({ messages = [], lastGeneratedImage = null, latestUploadedImage = null, latestImageReference = null, recentImageReferences = [], maxChars = DEFAULT_ROUTE_CONTEXT_MAX_CHARS } = {}) {
    const context = { recent_messages: (Array.isArray(messages) ? messages : []).map((message, index) => compactRouteMessage(message, index + 1)), last_generated_image: lastGeneratedImage, latest_uploaded_image: latestUploadedImage, latest_image_reference: latestImageReference && latestImageReference.target !== 'none' ? latestImageReference : null, recent_image_references: Array.isArray(recentImageReferences) ? recentImageReferences : [] };
    return trimRouteContextToSize(context, maxChars);
  }

  function routeImageCandidateLabels(text) {
    const value = String(text || '').toLowerCase();
    const patterns = [
      ['dog', /狗|犬|dog|puppy/],
      ['cat', /猫|cat|kitten/],
      ['cow', /牛|cow|bull|calf/],
      ['chicken', /鸡|chicken|hen|rooster/],
      ['duck', /鸭|duck|duckling/],
      ['bird', /鸟|bird/],
      ['person', /人|人物|person|human/],
    ];
    const labels = [];
    patterns.forEach(([label, pattern]) => { if (pattern.test(value)) labels.push(label); });
    return labels;
  }

  function routeSplitPromptSubjects(text, count) {
    const parts = String(text || '').split(/(?:，|,|、|和|与|及|\band\b|\n|；|;)/i).map(item => item.trim()).filter(Boolean);
    const subjects = [];
    parts.forEach(part => {
      const labels = routeImageCandidateLabels(part);
      if (labels.length) subjects.push(labels);
    });
    if (subjects.length >= count) return subjects.slice(0, count);
    const labels = routeImageCandidateLabels(text);
    while (subjects.length < count) subjects.push(labels);
    return subjects;
  }

  function routeNormalizeLastGeneratedImage(value) {
    if (!value) return null;
    const normalizeItem = item => ({ ...item, labels: Array.isArray(item.labels) ? item.labels : routeImageCandidateLabels(`${item.prompt || ''} ${item.filename || ''} ${item.raw || ''} ${item.label || ''} ${item.subject || ''}`) });
    return Array.isArray(value.images) ? { ...value, images: (value.images || []).map(normalizeItem) } : { ...value, images: value.src ? [normalizeItem({ src: value.src, filename: value.filename || 'generated-image.png', prompt: value.prompt || '', updatedAt: value.updatedAt || null, width: value.width || 0, height: value.height || 0 })] : [] };
  }

  function routeExtractPersistedImageRefs(html) {
    const refs = [];
    const pattern = /data-persisted-src="([^"]+)"[^>]*data-filename="([^"]*)"|data-filename="([^"]*)"[^>]*data-persisted-src="([^"]+)"/g;
    let match;
    while ((match = pattern.exec(String(html || '')))) {
      const src = match[1] || match[4];
      const filename = match[2] || match[3] || 'generated-image.png';
      if (src) refs.push({ src, filename });
    }
    return refs;
  }

  function routeLatestImageReferenceMeta({ lastGeneratedImage = null, latestUploadedImage = null } = {}) {
    const generated = routeNormalizeLastGeneratedImage(lastGeneratedImage);
    const generatedCount = Array.isArray(generated && generated.images) ? generated.images.length : generated && generated.src ? 1 : 0;
    const uploadCount = latestUploadedImage && latestUploadedImage.attachments ? latestUploadedImage.attachments.length || 0 : 0;
    if (generatedCount && uploadCount) return Number(generated.updatedAt || 0) >= Number(latestUploadedImage.updatedAt || 0) ? { target: 'previous', usePreviousImage: true, count: generatedCount, selection: 'all', reason: 'latest-generated-image', reference_id: makeImageReferenceId('latest') } : { target: 'uploaded', usePreviousImage: false, count: uploadCount, selection: 'all', reason: 'latest-uploaded-image' };
    if (generatedCount) return { target: 'previous', usePreviousImage: true, count: generatedCount, selection: 'all', reason: 'last-generated-image', reference_id: makeImageReferenceId('latest') };
    if (uploadCount) return { target: 'uploaded', usePreviousImage: false, count: uploadCount, selection: 'all', reason: 'latest-uploaded-image' };
    return { target: 'none', usePreviousImage: false, count: 0, selection: 'none', reason: 'no-image-reference' };
  }

  function routeCollectRecentImageReferences({ display = [], lastGeneratedImage = null, limit = 6 } = {}) {
    const references = [];
    const generated = routeNormalizeLastGeneratedImage(lastGeneratedImage);
    if (generated && generated.images && generated.images.length) {
      const referenceId = makeImageReferenceId('latest');
      references.push({ reference_id: referenceId, target: 'previous', prompt: String(generated.prompt || '').slice(0, 300), updated_at: generated.updatedAt || null, count: generated.images.length, candidates: generated.images.map((item, index) => ({ index: index + 1, image_id: makeImageItemId(referenceId, index + 1), filename: item.filename || '', prompt: String(item.prompt || generated.prompt || '').slice(0, 160), labels: item.labels || [] })) });
    }
    for (const item of [...display].reverse()) {
      if (references.length >= limit) break;
      if (item && item.role !== 'assistant') continue;
      const refs = routeExtractPersistedImageRefs(item && item.html || '');
      if (!refs.length) continue;
      const rawId = item.id || `display-${references.length + 1}`;
      const referenceId = makeImageReferenceId(rawId);
      if (references.some(ref => ref.reference_id === referenceId)) continue;
      const prompt = String(item.rawText || '').replace(/^\[图片(生成|编辑|修改)完成\]\s*/, '').slice(0, 300);
      const subjects = routeSplitPromptSubjects(prompt, refs.length);
      references.push({ reference_id: referenceId, target: 'previous', prompt, updated_at: item.updatedAt || null, count: refs.length, candidates: refs.map((ref, index) => ({ index: index + 1, image_id: makeImageItemId(referenceId, index + 1), filename: ref.filename || '', prompt, labels: subjects[index] || routeImageCandidateLabels(`${prompt} ${ref.filename || ''}`) })) });
    }
    return references;
  }

  function routeFindImageReferenceById({ display = [], referenceId = '' } = {}) {
    const rawId = parseImageReferenceId(referenceId);
    if (!rawId || rawId === 'latest') return null;
    const item = (display || []).find(entry => entry && entry.id === rawId);
    if (!item) return null;
    const refs = routeExtractPersistedImageRefs(item.html || '');
    if (!refs.length) return null;
    const resolvedReferenceId = makeImageReferenceId(rawId);
    return { images: refs.map((ref, index) => ({ ...ref, prompt: item.rawText || '', imageId: makeImageItemId(resolvedReferenceId, index + 1), labels: routeSplitPromptSubjects(item.rawText || '', refs.length)[index] || [] })), prompt: item.rawText || '', updatedAt: item.updatedAt || null };
  }

  function routeNormalizeRoute(route, fallbackMode) {
    const mode = ['chat', 'image', 'edit_image'].includes(route && route.mode) ? route.mode : fallbackMode || 'chat';
    const target = ['none', 'new', 'uploaded', 'previous'].includes(route && route.target) ? route.target : mode === 'image' ? 'new' : 'none';
    const confidence = Number.isFinite(Number(route && route.confidence)) ? Math.max(0, Math.min(1, Number(route.confidence))) : 0;
    const evidence = String(route && route.evidence || '').trim();
    return { mode, target, evidence, usePreviousImage: mode === 'edit_image' && target === 'previous' && !!(route && (route.use_previous_image || route.usePreviousImage)) && confidence >= 0.75 && evidence.length > 0, selectedIndexes: normalizeImageSelection(route && (route.selected_indexes || route.selectedIndexes || route.image_indexes || route.imageIndexes)) || [], selectedReferenceId: makeImageReferenceId(route && (route.selected_reference_id || route.selectedReferenceId) || ''), selectedImageIds: normalizeSelectedImageIds(route && (route.selected_image_ids || route.selectedImageIds) || route), confidence };
  }


  const imageReferences = Object.freeze({
    IMAGE_REFERENCE_PREFIX,
    IMAGE_ITEM_PREFIX,
    sanitizeImageReferencePart,
    makeImageReferenceId,
    parseImageReferenceId,
    makeImageItemId,
    normalizeSelectedImageIds,
    resolveImageSelectionFromIds,
    normalizeImageSelection,
  });

  const imageRouteContext = Object.freeze({
    DEFAULT_ROUTE_CONTEXT_MAX_CHARS,
    routeContextSize,
    compactRouteMessage,
    trimRouteContextToSize,
    buildRouteContext,
    imageCandidateLabels: routeImageCandidateLabels,
    splitPromptSubjects: routeSplitPromptSubjects,
    normalizeLastGeneratedImage: routeNormalizeLastGeneratedImage,
    extractPersistedImageRefs: routeExtractPersistedImageRefs,
    latestImageReferenceMeta: routeLatestImageReferenceMeta,
    collectRecentImageReferences: routeCollectRecentImageReferences,
    findImageReferenceById: routeFindImageReferenceById,
    normalizeRoute: routeNormalizeRoute,
  });

  window.ChatUICore = Object.freeze({
    http: Object.freeze({ normalizeError, toProxyUrl, parseResponseJson }),
    reasoning: Object.freeze({ normalizeReasoningText, extractStreamDelta, reasoningBudgetTokens }),
    models: Object.freeze({ normalizeModelType, inferModelType, extractModels, isModelAllowedFor }),
    imageReferences,
    imageRouteContext,
    attachments: Object.freeze({ isImageFile, isCompressibleRasterImage, formatBytes, looksLikeImageEditInstruction, parseImageContext, IMAGE_REFERENCE_PREFIX, IMAGE_ITEM_PREFIX, sanitizeImageReferencePart, makeImageReferenceId, parseImageReferenceId, makeImageItemId, normalizeSelectedImageIds, resolveImageSelectionFromIds, normalizeImageSelection }),
  });
})();
