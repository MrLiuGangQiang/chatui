(function initChatUICoreImageRouteContext(root) {
  'use strict';

const imageReferences = root?.ChatUICoreImageReferences || (typeof require === 'function' ? require('./image-references') : {});
const {
  makeImageReferenceId,
  parseImageReferenceId,
  makeImageItemId,
  normalizeSelectedImageIds,
  normalizeImageSelection,
} = imageReferences;

const DEFAULT_ROUTE_CONTEXT_MAX_CHARS = 256 * 1024;

function routeContextSize(value) {
  try { return JSON.stringify(value || {}).length; } catch { return Infinity; }
}

function compactRouteMessage(message = {}, index = 0) {
  return {
    index,
    role: message.role || '',
    content: String(Array.isArray(message.content) ? message.rawText || '[非文本消息]' : message.content || message.rawText || '').slice(0, 600),
  };
}

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

function isImageAttachmentMeta(item = {}) {
  const type = String(item.type || item.mime || '').toLowerCase();
  const name = String(item.name || item.filename || '').toLowerCase();
  const src = String(item.src || item.url || '').toLowerCase();
  return type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i.test(name) || src.startsWith('data:image/');
}

function uploadedAttachmentsFromMessage(message = {}) {
  const imageContext = parseJsonObject(message.imageContext);
  if (imageContext?.attachments?.length && (imageContext.target === 'uploaded' || imageContext.mode === 'edit_image')) {
    return imageContext.attachments.filter(item => item?.src);
  }
  const attachmentContext = parseJsonObject(message.attachmentContext);
  if (attachmentContext?.attachments?.length) return attachmentContext.attachments.filter(isImageAttachmentMeta);
  return [];
}

function messageText(message = {}, fallback = '') {
  return String(Array.isArray(message?.content) ? message.rawText || fallback : message?.rawText || message?.content || fallback || '').trim();
}

function findNextAssistantMessage(messages = [], startIndex = 0) {
  for (let index = startIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === 'assistant') return message;
    if (message?.role === 'user') return null;
  }
  return null;
}

function uploadedReferenceIdForMessageIndex(index = 0) {
  return makeImageReferenceId(`uploaded_${Number(index) + 1}`);
}

function collectRecentUploadedImageReferences({ messages = [], limit = 6 } = {}) {
  const allMessages = Array.isArray(messages) ? messages : [];
  const references = [];
  for (let index = allMessages.length - 1; index >= 0; index -= 1) {
    if (references.length >= limit) break;
    const message = allMessages[index];
    if (message?.role !== 'user') continue;
    const attachments = uploadedAttachmentsFromMessage(message);
    if (!attachments.length) continue;
    const imageContext = parseJsonObject(message.imageContext);
    const referenceId = uploadedReferenceIdForMessageIndex(index);
    const assistant = findNextAssistantMessage(allMessages, index);
    const prompt = messageText(message, '[uploaded image]').slice(0, 300);
    references.push({
      reference_id: referenceId,
      target: 'uploaded',
      source: 'user_message',
      message_index: index + 1,
      prompt,
      user_prompt: prompt,
      assistant_response: messageText(assistant).slice(0, 800),
      updated_at: imageContext?.updatedAt || imageContext?.updated_at || message.updatedAt || null,
      count: attachments.length,
      candidates: attachments.map((item, attachmentIndex) => ({
        index: attachmentIndex + 1,
        image_id: makeImageItemId(referenceId, attachmentIndex + 1),
        filename: item.name || item.filename || '',
        prompt,
        labels: [],
      })),
    });
  }
  return references;
}

function trimRouteContextToSize(context = {}, maxChars = DEFAULT_ROUTE_CONTEXT_MAX_CHARS) {
  const limit = Number(maxChars) || DEFAULT_ROUTE_CONTEXT_MAX_CHARS;
  const next = {
    ...context,
    recent_messages: Array.isArray(context.recent_messages) ? [...context.recent_messages] : [],
    recent_image_references: Array.isArray(context.recent_image_references) ? [...context.recent_image_references] : [],
    recent_uploaded_image_references: Array.isArray(context.recent_uploaded_image_references) ? [...context.recent_uploaded_image_references] : [],
  };
  if (routeContextSize(next) <= limit) return next;
  while (next.recent_messages.length && routeContextSize(next) > limit) next.recent_messages.shift();
  while (next.recent_image_references.length > 1 && routeContextSize(next) > limit) next.recent_image_references.pop();
  while (next.recent_uploaded_image_references.length > 1 && routeContextSize(next) > limit) next.recent_uploaded_image_references.pop();
  const shrinkPrompt = item => {
    if (!item || typeof item !== 'object') return item;
    const copy = { ...item };
    if (copy.prompt) copy.prompt = String(copy.prompt).slice(0, 160);
    if (copy.user_prompt) copy.user_prompt = String(copy.user_prompt).slice(0, 160);
    if (copy.assistant_response) copy.assistant_response = String(copy.assistant_response).slice(0, 300);
    if (Array.isArray(copy.candidates)) copy.candidates = copy.candidates.map(candidate => ({ ...candidate, prompt: String(candidate.prompt || '').slice(0, 80) }));
    return copy;
  };
  if (routeContextSize(next) > limit) {
    next.last_generated_image = shrinkPrompt(next.last_generated_image);
    next.latest_uploaded_image = shrinkPrompt(next.latest_uploaded_image);
    next.latest_image_reference = shrinkPrompt(next.latest_image_reference);
    next.recent_image_references = next.recent_image_references.map(shrinkPrompt);
    next.recent_uploaded_image_references = next.recent_uploaded_image_references.map(shrinkPrompt);
  }
  return next;
}

function buildRouteContext({ messages = [], lastGeneratedImage = null, latestUploadedImage = null, latestImageReference = null, recentImageReferences = [], maxChars = DEFAULT_ROUTE_CONTEXT_MAX_CHARS } = {}) {
  const allMessages = Array.isArray(messages) ? messages : [];
  const uploadedReferences = collectRecentUploadedImageReferences({ messages: allMessages, limit: Number.MAX_SAFE_INTEGER });
  const uploadedLatest = uploadedReferences[0] || null;
  const mergedLatestUploadedImage = latestUploadedImage && uploadedLatest ? {
    ...latestUploadedImage,
    reference_id: latestUploadedImage.reference_id || uploadedLatest.reference_id,
    user_prompt: uploadedLatest.user_prompt || uploadedLatest.prompt || '',
    assistant_response: uploadedLatest.assistant_response || '',
    candidates: uploadedLatest.candidates || [],
  } : latestUploadedImage;
  const mergedReferences = Array.isArray(recentImageReferences) ? [...recentImageReferences] : [];
  for (const reference of uploadedReferences) if (!mergedReferences.some(item => item?.reference_id === reference.reference_id)) mergedReferences.push(reference);
  const context = {
    recent_messages: allMessages.map((message, index) => compactRouteMessage(message, index + 1)),
    last_generated_image: lastGeneratedImage,
    latest_uploaded_image: mergedLatestUploadedImage,
    latest_image_reference: latestImageReference && latestImageReference.target !== 'none' ? latestImageReference : null,
    recent_image_references: mergedReferences,
    recent_uploaded_image_references: uploadedReferences,
  };
  return trimRouteContextToSize(context, maxChars);
}

function imageCandidateLabels(text = '') {
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
  for (const [label, pattern] of patterns) if (pattern.test(value)) labels.push(label);
  return labels;
}

function splitPromptSubjects(text = '', count = 1) {
  const parts = String(text || '').split(/(?:，|,|、|和|与|及|\band\b|\n|；|;)/i).map(item => item.trim()).filter(Boolean);
  const subjects = [];
  for (const part of parts) {
    const labels = imageCandidateLabels(part);
    if (labels.length) subjects.push(labels);
  }
  if (subjects.length >= count) return subjects.slice(0, count);
  const labels = imageCandidateLabels(text);
  while (subjects.length < count) subjects.push(labels);
  return subjects;
}

function normalizeLastGeneratedImage(value) {
  if (!value) return null;
  const normalizeItem = item => ({
    ...item,
    labels: Array.isArray(item.labels) ? item.labels : imageCandidateLabels(`${item.prompt || ''} ${item.filename || ''} ${item.raw || ''} ${item.label || ''} ${item.subject || ''}`),
  });
  if (!Array.isArray(value.images)) {
    return {
      ...value,
      images: value.src ? [normalizeItem({
        src: value.src,
        filename: value.filename || 'generated-image.png',
        prompt: value.prompt || '',
        updatedAt: value.updatedAt || null,
        width: value.width || 0,
        height: value.height || 0,
      })] : [],
    };
  }
  return { ...value, images: (value.images || []).map(normalizeItem) };
}

function extractPersistedImageRefs(html = '') {
  const refs = [];
  const text = String(html || '');
  const pattern = /data-persisted-src="([^"]+)"[^>]*data-filename="([^"]*)"|data-filename="([^"]*)"[^>]*data-persisted-src="([^"]+)"/g;
  let match;
  while ((match = pattern.exec(text))) {
    const src = match[1] || match[4];
    const filename = match[2] || match[3] || 'generated-image.png';
    if (src) refs.push({ src, filename });
  }
  return refs;
}

function latestImageReferenceMeta({ lastGeneratedImage = null, latestUploadedImage = null } = {}) {
  const generated = normalizeLastGeneratedImage(lastGeneratedImage);
  const generatedCount = Array.isArray(generated && generated.images) ? generated.images.length : generated && generated.src ? 1 : 0;
  const uploadCount = latestUploadedImage && latestUploadedImage.attachments ? latestUploadedImage.attachments.length || 0 : 0;
  if (generatedCount && uploadCount) {
    const generatedUpdatedAt = Number(generated.updatedAt || 0);
    const uploadedUpdatedAt = Number(latestUploadedImage.updatedAt || 0);
    return generatedUpdatedAt >= uploadedUpdatedAt
      ? { target: 'previous', usePreviousImage: true, count: generatedCount, selection: 'all', reason: 'latest-generated-image', reference_id: makeImageReferenceId('latest') }
      : { target: 'uploaded', usePreviousImage: false, count: uploadCount, selection: 'all', reason: 'latest-uploaded-image' };
  }
  if (generatedCount) return { target: 'previous', usePreviousImage: true, count: generatedCount, selection: 'all', reason: 'last-generated-image', reference_id: makeImageReferenceId('latest') };
  if (uploadCount) return { target: 'uploaded', usePreviousImage: false, count: uploadCount, selection: 'all', reason: 'latest-uploaded-image' };
  return { target: 'none', usePreviousImage: false, count: 0, selection: 'none', reason: 'no-image-reference' };
}

function collectRecentImageReferences({ display = [], lastGeneratedImage = null, limit = 6 } = {}) {
  const references = [];
  const generated = normalizeLastGeneratedImage(lastGeneratedImage);
  if (generated && generated.images && generated.images.length) {
    const referenceId = makeImageReferenceId('latest');
    references.push({
      reference_id: referenceId,
      target: 'previous',
      prompt: String(generated.prompt || '').slice(0, 300),
      updated_at: generated.updatedAt || null,
      count: generated.images.length,
      candidates: generated.images.map((item, index) => ({
        index: index + 1,
        image_id: makeImageItemId(referenceId, index + 1),
        filename: item.filename || '',
        prompt: String(item.prompt || generated.prompt || '').slice(0, 160),
        labels: item.labels || [],
      })),
    });
  }
  for (const item of [...display].reverse()) {
    if (references.length >= limit) break;
    if (item && item.role !== 'assistant') continue;
    const refs = extractPersistedImageRefs(item && item.html || '');
    if (!refs.length) continue;
    const rawId = item.id || `display-${references.length + 1}`;
    const referenceId = makeImageReferenceId(rawId);
    const prompt = String(item.rawText || '').replace(/^\[图片(生成|编辑|修改)完成\]\s*/, '').slice(0, 300);
    const subjects = splitPromptSubjects(prompt, refs.length);
    if (references.some(ref => ref.reference_id === referenceId)) continue;
    references.push({
      reference_id: referenceId,
      target: 'previous',
      prompt,
      updated_at: item.updatedAt || null,
      count: refs.length,
      candidates: refs.map((ref, index) => ({
        index: index + 1,
        image_id: makeImageItemId(referenceId, index + 1),
        filename: ref.filename || '',
        prompt,
        labels: subjects[index] || imageCandidateLabels(`${prompt} ${ref.filename || ''}`),
      })),
    });
  }
  return references;
}

function findImageReferenceById({ display = [], referenceId = '' } = {}) {
  const rawId = parseImageReferenceId(referenceId);
  if (!rawId || rawId === 'latest') return null;
  const item = (display || []).find(entry => entry && entry.id === rawId);
  if (!item) return null;
  const refs = extractPersistedImageRefs(item.html || '');
  if (!refs.length) return null;
  const resolvedReferenceId = makeImageReferenceId(rawId);
  return {
    images: refs.map((ref, index) => ({
      ...ref,
      prompt: item.rawText || '',
      imageId: makeImageItemId(resolvedReferenceId, index + 1),
      labels: splitPromptSubjects(item.rawText || '', refs.length)[index] || [],
    })),
    prompt: item.rawText || '',
    updatedAt: item.updatedAt || null,
  };
}

const IMAGE_PLAN_INTENTS = new Set(['text_to_image', 'image_edit_single', 'image_edit_batch', 'image_compose', 'image_reference_gen', 'unknown']);
const IMAGE_PLAN_TASK_TYPES = new Set(['generate', 'edit']);
const IMAGE_PLAN_ROLES = new Set(['target', 'reference', 'subject', 'background', 'style_reference']);

function normalizePlanInputImages(inputImages = []) {
  if (!Array.isArray(inputImages)) return [];
  return inputImages.map(item => {
    const imageId = String(item && (item.image_id || item.imageId) || '').trim();
    const referenceId = makeImageReferenceId(item && (item.reference_id || item.referenceId) || '');
    const role = IMAGE_PLAN_ROLES.has(item && item.role) ? item.role : 'reference';
    const next = { image_id: imageId, role };
    if (referenceId) next.reference_id = referenceId;
    return next;
  }).filter(item => item.image_id || item.reference_id);
}

function normalizePlanValue(value, fallback = 'auto') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeImagePlanTask(task = {}) {
  const taskType = IMAGE_PLAN_TASK_TYPES.has(task.task_type || task.taskType) ? (task.task_type || task.taskType) : 'generate';
  return {
    task_type: taskType,
    input_images: normalizePlanInputImages(task.input_images || task.inputImages),
    prompt: String(task.prompt || '').trim(),
    size: normalizePlanValue(task.size),
    quality: normalizePlanValue(task.quality),
    background: normalizePlanValue(task.background),
    format: normalizePlanValue(task.format || task.output_format || task.outputFormat),
  };
}

function normalizeImagePlan(route = {}) {
  const rawIntent = String(route && route.intent || '').trim();
  const intent = IMAGE_PLAN_INTENTS.has(rawIntent) ? rawIntent : 'unknown';
  const needClarification = !!(route && (route.need_clarification || route.needClarification));
  const tasks = needClarification ? [] : (Array.isArray(route && route.tasks) ? route.tasks.map(normalizeImagePlanTask).filter(task => task.input_images.length || task.task_type === 'generate') : []);
  return {
    needClarification,
    clarificationQuestion: String(route && (route.clarification_question || route.clarificationQuestion) || '').trim(),
    intent,
    tasks,
  };
}

function modeFromImageIntent(intent, fallbackMode = 'chat') {
  // OpenAI-compatible image routing: only text_to_image uses /images/generations;
  // everything with an input image goes through /openai/image_edit, independent of model name.
  if (intent === 'text_to_image') return 'image';
  if (intent === 'image_edit_single' || intent === 'image_edit_batch' || intent === 'image_compose' || intent === 'image_reference_gen') return 'edit_image';
  return fallbackMode;
}

function planImageIds(plan = {}) {
  const ids = [];
  for (const task of plan.tasks || []) for (const image of task.input_images || []) if (image.image_id) ids.push(image.image_id);
  return normalizeSelectedImageIds(ids);
}

function referenceIdFromImageId(imageId = '') {
  const match = String(imageId || '').match(/^img_(imgref_.+)_(\d+)$/);
  return match ? makeImageReferenceId(match[1]) : '';
}

function planReferenceId(plan = {}) {
  for (const task of plan.tasks || []) for (const image of task.input_images || []) {
    if (image.reference_id) return makeImageReferenceId(image.reference_id);
    const fromImage = referenceIdFromImageId(image.image_id);
    if (fromImage) return fromImage;
  }
  return '';
}

function planSelectedIndexes(ids = [], referenceId = '') {
  const reference = makeImageReferenceId(referenceId || '');
  const indexes = [];
  for (const id of ids || []) {
    const match = String(id || '').match(/^img_(imgref_.+)_(\d+)$/);
    if (!match || (reference && makeImageReferenceId(match[1]) !== reference)) continue;
    const index = Number(match[2]);
    if (Number.isInteger(index) && index >= 1) indexes.push(index);
  }
  return indexes.filter((item, index, list) => list.indexOf(item) === index);
}

function targetFromPlan(plan = {}, mode = 'chat') {
  const referenceId = planReferenceId(plan);
  if (mode === 'image') return 'new';
  if (mode !== 'edit_image') return 'none';
  if (referenceId && /^imgref_uploaded_/i.test(referenceId)) return 'uploaded';
  if (referenceId || planImageIds(plan).length) return 'previous';
  return 'none';
}

function normalizeRoute(route, fallbackMode = 'chat') {
  const plan = normalizeImagePlan(route || {});
  const plannedMode = plan.intent !== 'unknown' ? modeFromImageIntent(plan.intent, fallbackMode) : '';
  const explicitMode = ['chat', 'image', 'edit_image'].includes(route && route.mode) ? route.mode : '';
  // Prefer intent-derived mode over LLM's explicit mode when they disagree,
  // because the LLM may return mode:"image" while intent says "image_edit_single"
  // (old prompt habits vs new structured intent field).
  const preferredMode = plannedMode || explicitMode || fallbackMode;
  const mode = plannedMode && explicitMode && plannedMode !== explicitMode ? plannedMode : preferredMode;
  const planIds = planImageIds(plan);
  const rawTarget = ['none', 'new', 'uploaded', 'previous'].includes(route && route.target) ? route.target : targetFromPlan(plan, mode);
  const target = rawTarget || (mode === 'image' ? 'new' : 'none');
  const confidence = Number.isFinite(Number(route && route.confidence)) ? Math.max(0, Math.min(1, Number(route.confidence))) : 0;
  const evidence = String(route && route.evidence || '').trim();
  const selectedImageIds = normalizeSelectedImageIds(route && (route.selected_image_ids || route.selectedImageIds) || route);
  const selectedReferenceId = makeImageReferenceId(route && (route.selected_reference_id || route.selectedReferenceId) || planReferenceId(plan) || '');
  const selectedIndexes = normalizeImageSelection(route && (route.selected_indexes || route.selectedIndexes || route.image_indexes || route.imageIndexes)) || planSelectedIndexes(selectedImageIds.length ? selectedImageIds : planIds, selectedReferenceId) || [];
  return {
    mode: plan.needClarification ? 'chat' : mode,
    target: plan.needClarification ? 'none' : target,
    evidence,
    usePreviousImage: mode === 'edit_image' && target === 'previous' && (confidence >= 0.75 || !evidence.length),
    selectedIndexes,
    selectedReferenceId,
    selectedImageIds: selectedImageIds.length ? selectedImageIds : planIds,
    needClarification: plan.needClarification,
    clarificationQuestion: plan.clarificationQuestion,
    contextualImagePrompt: String(route && (route.contextual_image_prompt || route.contextualImagePrompt) || '').trim(),
    intent: plan.intent,
    tasks: plan.tasks,
    confidence,
  };
}

const api = Object.freeze({
  DEFAULT_ROUTE_CONTEXT_MAX_CHARS,
  routeContextSize,
  compactRouteMessage,
  trimRouteContextToSize,
  buildRouteContext,
  imageCandidateLabels,
  splitPromptSubjects,
  normalizeLastGeneratedImage,
  extractPersistedImageRefs,
  latestImageReferenceMeta,
  uploadedReferenceIdForMessageIndex,
  collectRecentUploadedImageReferences,
  collectRecentImageReferences,
  findImageReferenceById,
  normalizePlanInputImages,
  normalizeImagePlanTask,
  normalizeImagePlan,
  normalizeRoute,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUICoreImageRouteContext = api;
if (root?.window) root.window.ChatUICoreImageRouteContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
