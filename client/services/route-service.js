(function initChatUIRouteService(root) {
  'use strict';

const ROUTE_SYSTEM_PROMPT = `你是 ChatUI 意图路由器，只返回 JSON，不回答用户。

判断原则：
- current_input 是最新用户输入，优先级最高。
- attachments 是本轮资源。
- context 只用于解析明确引用：上一张、这张、刚才、继续、那个文件等；历史不能覆盖新任务。
- image_candidates/file_candidates 只是候选元数据，不要猜图片或文件内容。
- 写/改写/翻译/优化图片提示词属于 chat；只有用户明确要生成真实图片才是 image_generate。

必须返回：
{"route":"chat|vision|image_generate|image_edit|unclear|unsafe","need_image_input":false,"need_file_input":false,"need_clarification":false,"image_source":"none|current|quoted|history","selected_indexes":[],"use_previous_image":false,"instruction":"","reply_to_user":"","confidence":0,"reason":""}

route 含义：
- chat：文字聊天、写作、翻译、总结、文件问答、提示词写作
- vision：看图回答、识图、OCR
- image_generate：生成新图片
- image_edit：修改已有图片
- unclear：缺资源、缺选择或意图不清
- unsafe：拒绝

资源规则：
- image_source 只能是 none/current/quoted/history。
- selected_indexes 用 1-based 编号。
- 需要图片或文件但没有时，设置 need_image_input/need_file_input 和 need_clarification。
- 多个候选都可能符合但用户没指定时，selected_indexes=[]，need_clarification=true。
- instruction 只给 image_generate/image_edit 用。
- reply_to_user 只给追问或拒绝用。`

const imageRouteContext = root?.ChatUICoreImageRouteContext
  || root?.ChatUICore?.imageRouteContext
  || root?.window?.ChatUICoreImageRouteContext
  || root?.window?.ChatUICore?.imageRouteContext
  || (typeof require === 'function' ? require('../core/image-route-context') : {});

const routeDecision = root?.ChatUICoreRouteDecision
  || root?.ChatUICore?.routeDecision
  || root?.window?.ChatUICoreRouteDecision
  || root?.window?.ChatUICore?.routeDecision
  || (typeof require === 'function' ? require('../core/route-decision') : {});

const {
  API_ROUTES,
  IMAGE_SOURCES,
  cleanQuotedContent,
  stripJsonFence,
  isPlainTextChatInput,
  isImagePromptExtractionInput,
  isImplicitImagePromptExtractionInput,
  isPromptWritingInput,
  normalizeSelectedIndexes,
  currentImageCount,
  currentFileCount,
  contextImageCandidates,
  contextFileCandidates,
  inferSourceFromContext,
  defaultIndexesForSource,
  selectedCandidatesForSource,
  targetForEditSource,
  imageRefTargetForSource,
  referenceIdForSource,
} = routeDecision;

const UPLOADED_IMAGE_ROUTE_PROMPT = '';

function buildQuotedImagePlaceholders(images = []) {
  return (images || [])
    .map((item, index) => `[quoted_image index=${index + 1} id=${item.imageId || item.image_id || ''} name=${item.name || ''}]`)
    .join('\n');
}

function buildQuotedRouteContent({ text = '', images = [] } = {}) {
  return [cleanQuotedContent(text), buildQuotedImagePlaceholders(images)].filter(Boolean).join('\n') || '[quoted_message]';
}

function imagePromptExtractionRef({ imageCandidates = [], attachments = [], parsed = {} } = {}) {
  const normalizedRefs = Array.isArray(parsed.imageRefs) && parsed.imageRefs.length ? parsed.imageRefs : (Array.isArray(parsed.image_refs) ? parsed.image_refs : []);
  if (normalizedRefs.length) return normalizedRefs;
  const first = imageCandidates.length === 1 ? imageCandidates[0] : null;
  if (first) return [{ role: 'source', image_id: first.image_id || '', reference_id: first.reference_id || '', index: first.index || 1, target: first.target || 'previous', source: first.source || 'quoted' }];
  const currentImageIndex = (attachments || []).findIndex(item => item && item.is_image);
  if (currentImageIndex >= 0) return [{ role: 'source', image_id: '', reference_id: '', index: currentImageIndex + 1, target: 'uploaded', source: 'current' }];
  return [];
}

function isSimpleClassifierResult(value = {}) {
  return value && typeof value === 'object' && API_ROUTES.has(String(value.route || value.api || ''));
}

function apiRouteToExecutionRoute(simple = {}, options = {}) {
  const input = String(options.input || '').trim();
  const attachments = options.attachments || [];
  const context = options.context || {};
  const route = API_ROUTES.has(String(simple.route || simple.api || '')) ? String(simple.route || simple.api) : 'unclear';
  const confidence = Number.isFinite(Number(simple.confidence)) ? Math.max(0, Math.min(1, Number(simple.confidence))) : 0;
  const reason = String(simple.reason || '').trim();
  let needClarification = !!(simple.need_clarification || simple.needClarification);
  const needImageInput = !!(simple.need_image_input || simple.needImageInput);
  const needFileInput = !!(simple.need_file_input || simple.needFileInput);
  let imageSource = inferSourceFromContext(route, String(simple.image_source || simple.imageSource || 'none'), attachments, context);
  let selectedIndexes = normalizeSelectedIndexes(simple.selected_indexes || simple.selectedIndexes);
  let usePreviousImage = !!(simple.use_previous_image || simple.usePreviousImage);
  const reply = String(simple.reply_to_user || simple.replyToUser || '').trim();
  const instruction = String(simple.instruction || '').trim();

  if (route === 'unsafe') {
    return { mode: 'chat', operation: { type: 'plain_chat', scope: 'none', prompt: input, edit_instruction: '' }, image_refs: [], file_refs: [], target: 'none', use_previous_image: false, selected_reference_id: '', selected_indexes: [], selected_image_ids: [], need_clarification: true, clarification_question: reply || '抱歉，这个请求我不能帮助处理。', intent: 'unknown', edit_instruction: '', contextual_image_prompt: '', tasks: [], confidence: confidence || 1, evidence: reason || '不安全请求' };
  }

  const routeUsesImage = route === 'vision' || route === 'image_edit' || (route === 'image_generate' && imageSource !== 'none');
  const hasResolvableImageInput = routeUsesImage && inferSourceFromContext(route, imageSource, attachments, context) !== 'none' && (currentImageCount(attachments) || contextImageCandidates(context, imageSource).length || imageSource === 'current');
  const hasResolvableFileInput = route === 'chat' && (currentFileCount(attachments) || contextFileCandidates(context, 'current').length || contextFileCandidates(context, 'quoted').length || contextFileCandidates(context, 'history').length);
  const blocksForImageInput = needImageInput && !hasResolvableImageInput;
  const blocksForFileInput = needFileInput && !hasResolvableFileInput;

  if (route === 'unclear' || needClarification || blocksForImageInput || blocksForFileInput) {
    return { mode: 'chat', operation: { type: 'plain_chat', scope: 'none', prompt: input, edit_instruction: '' }, image_refs: [], file_refs: [], target: 'none', use_previous_image: false, selected_reference_id: '', selected_indexes: [], selected_image_ids: [], need_clarification: true, clarification_question: reply || (blocksForFileInput ? '请先上传文件，或说明要处理哪个文件。' : blocksForImageInput ? '请先上传图片，或说明要处理哪一张历史图片。' : '请说明你想让我做什么。'), intent: route === 'image_edit' ? 'image_edit' : 'unknown', edit_instruction: instruction, contextual_image_prompt: '', tasks: [], confidence: confidence || 0.6, evidence: reason || '意图或目标资源不明确' };
  }

  if (routeUsesImage) {
    if (!selectedIndexes.length) selectedIndexes = defaultIndexesForSource(imageSource, attachments, context);
    const sourceCount = imageSource === 'current' ? currentImageCount(attachments) : contextImageCandidates(context, imageSource).length;
    if (!selectedIndexes.length && sourceCount > 1) {
      return { mode: 'chat', operation: { type: 'plain_chat', scope: 'none', prompt: input, edit_instruction: '' }, image_refs: [], file_refs: [], target: 'none', use_previous_image: false, selected_reference_id: '', selected_indexes: [], selected_image_ids: [], need_clarification: true, clarification_question: '请明确要处理第几张图片。', intent: route === 'image_edit' ? 'image_edit' : 'unknown', edit_instruction: instruction, contextual_image_prompt: '', tasks: [], confidence: confidence || 0.6, evidence: reason || '存在多张候选图片但未指定序号' };
    }
  }

  if (route === 'chat' && !hasResolvableFileInput) {
    return { mode: 'chat', operation: { type: 'plain_chat', scope: 'none', prompt: input, edit_instruction: '' }, image_refs: [], file_refs: [], target: 'none', use_previous_image: false, selected_reference_id: '', selected_indexes: [], selected_image_ids: [], need_clarification: false, clarification_question: '', intent: 'unknown', edit_instruction: '', contextual_image_prompt: '', tasks: [], confidence: confidence || 0.9, evidence: reason || '文字任务' };
  }

  if (route === 'chat' && hasResolvableFileInput) {
    const source = String(simple.file_source || simple.fileSource || '') || (currentFileCount(attachments) ? 'current' : (contextFileCandidates(context, 'quoted').length ? 'quoted' : (contextFileCandidates(context, 'history').length ? 'history' : 'current')));
    const files = contextFileCandidates(context, source);
    const fileIndexes = normalizeSelectedIndexes(simple.selected_indexes || simple.selectedIndexes);
    const selectedFiles = fileIndexes.length ? files.filter(item => fileIndexes.includes(Number(item.index))) : files.length === 1 ? [files[0]] : files;
    const fileRefs = selectedFiles.map((item, idx) => ({ role: 'source', file_id: item.file_id || item.id || '', index: Number(item.index) || idx + 1, name: item.name || '', source: source === 'quoted' ? 'quoted' : source === 'history' ? 'history' : 'current' }));
    return { mode: 'chat', operation: { type: 'file_qa', scope: source === 'quoted' ? 'quoted' : source === 'history' ? 'history' : 'current', prompt: input, edit_instruction: '' }, image_refs: [], file_refs: fileRefs, target: 'none', use_previous_image: false, selected_reference_id: '', selected_indexes: [], selected_image_ids: [], need_clarification: false, clarification_question: '', intent: 'unknown', edit_instruction: '', contextual_image_prompt: '', tasks: [], confidence: confidence || 0.9, evidence: reason || '文件问答' };
  }

  if (route === 'image_generate' && imageSource === 'none') {
    return { mode: 'image', operation: { type: 'text_to_image', scope: 'none', prompt: instruction || input, edit_instruction: '' }, image_refs: [], file_refs: [], target: 'new', use_previous_image: false, selected_reference_id: '', selected_indexes: [], selected_image_ids: [], need_clarification: false, clarification_question: '', intent: 'text_to_image', edit_instruction: '', contextual_image_prompt: instruction || '', tasks: [], confidence: confidence || 0.95, evidence: reason || '纯文本生图' };
  }

  if (route === 'image_generate' || route === 'image_edit' || route === 'vision') {
    const selected = selectedCandidatesForSource(imageSource, selectedIndexes, attachments, context);
    const first = selected[0] || null;
    const role = route === 'image_edit' ? 'target' : route === 'image_generate' ? 'reference' : 'source';
    const refs = selectedIndexes.map(index => {
      const candidate = selected.find(item => Number(item.index) === Number(index)) || (selectedIndexes.length === 1 ? first : null);
      return {
        role,
        image_id: candidate?.image_id || '',
        reference_id: candidate?.reference_id || referenceIdForSource(imageSource, selected, context, usePreviousImage),
        index,
        target: imageRefTargetForSource(imageSource, candidate),
        source: imageSource === 'history' ? 'history' : imageSource,
      };
    });
    const selectedIds = refs.map(ref => ref.image_id).filter(Boolean);
    const selectedReferenceId = referenceIdForSource(imageSource, selected, context, usePreviousImage) || refs.find(ref => ref.reference_id)?.reference_id || '';
    if (route === 'image_generate') {
      return { mode: 'image', operation: { type: 'image_reference_gen', scope: imageSource === 'none' ? 'current' : imageSource, prompt: instruction || input, edit_instruction: '' }, image_refs: refs, file_refs: [], target: 'new', use_previous_image: false, selected_reference_id: selectedReferenceId, selected_indexes: selectedIndexes, selected_image_ids: selectedIds, need_clarification: false, clarification_question: '', intent: 'image_reference_gen', edit_instruction: '', contextual_image_prompt: instruction || input, tasks: [], confidence: confidence || 0.9, evidence: reason || '参考图生成新图' };
    }
    if (route === 'image_edit') {
      const target = targetForEditSource(imageSource, first);
      usePreviousImage = usePreviousImage || (imageSource === 'history' && target === 'previous');
      return { mode: 'edit_image', operation: { type: 'image_edit', scope: imageSource === 'none' ? 'current' : imageSource, prompt: '', edit_instruction: instruction || input }, image_refs: refs, file_refs: [], target, use_previous_image: usePreviousImage, selected_reference_id: selectedReferenceId, selected_indexes: selectedIndexes, selected_image_ids: selectedIds, need_clarification: false, clarification_question: '', intent: 'image_edit', edit_instruction: instruction || input, contextual_image_prompt: '', tasks: [], confidence: confidence || 0.95, evidence: reason || '修改已有图片' };
    }
    const isOcr = /(?:ocr|OCR|识别文字|文字识别|读文字|读取文字|提取文字)/i.test([input, instruction].filter(Boolean).join('\n'));
    const type = isOcr ? 'ocr' : 'image_qa';
    return { mode: 'chat', operation: { type, scope: imageSource === 'none' ? 'current' : imageSource, prompt: input, edit_instruction: '' }, image_refs: refs, file_refs: [], target: 'none', use_previous_image: false, selected_reference_id: selectedReferenceId, selected_indexes: selectedIndexes, selected_image_ids: selectedIds, need_clarification: false, clarification_question: '', intent: 'unknown', edit_instruction: '', contextual_image_prompt: '', tasks: [], confidence: confidence || 0.95, evidence: reason || (isOcr ? '图片文字识别' : '图片理解') };
  }

  return { mode: 'chat', operation: { type: 'plain_chat', scope: 'none', prompt: input, edit_instruction: '' }, image_refs: [], file_refs: [], target: 'none', use_previous_image: false, selected_reference_id: '', selected_indexes: [], selected_image_ids: [], need_clarification: true, clarification_question: reply || '请说明你想让我做什么。', intent: 'unknown', edit_instruction: '', contextual_image_prompt: '', tasks: [], confidence: confidence || 0.5, evidence: reason || '无法识别意图' };
}

function parseRouteResult(text = '', normalizeRoute, options = {}) {
  const value = String(text || '').trim();
  if (!value) return null;
  const normalize = normalizeRoute || imageRouteContext.normalizeRoute;
  if (typeof normalize !== 'function') throw new TypeError('normalizeRoute is required');
  try {
    const raw = JSON.parse(stripJsonFence(value));
    const legacyInput = isSimpleClassifierResult(raw) ? apiRouteToExecutionRoute(raw, options) : raw;
    const parsed = normalize(legacyInput);
    const imageCandidates = Array.isArray(options.context?.image_candidates) ? options.context.image_candidates : [];
    const attachments = options.attachments || [];
    const hasImageContext = imageCandidates.length > 0 || attachments.some(item => item && item.is_image);
    if (hasImageContext && (isImagePromptExtractionInput(options.input) || isImplicitImagePromptExtractionInput(options.input)) && parsed.mode !== 'chat') {
      const first = imageCandidates.length === 1 ? imageCandidates[0] : null;
      const refs = imagePromptExtractionRef({ imageCandidates, attachments, parsed });
      const selectedIndexes = refs.map(ref => Number(ref.index)).filter(index => Number.isInteger(index) && index >= 1);
      const selectedImageIds = refs.map(ref => ref.image_id || ref.imageId).filter(Boolean);
      return normalize({
        ...parsed,
        mode: 'chat',
        operation: { ...(parsed.operation || {}), type: 'image_qa', scope: first?.source || refs[0]?.source || parsed.operation?.scope || 'current' },
        target: 'none',
        use_previous_image: false,
        image_refs: refs,
        selected_indexes: parsed.selectedIndexes?.length ? parsed.selectedIndexes : parsed.selected_indexes || selectedIndexes,
        selected_image_ids: parsed.selectedImageIds?.length ? parsed.selectedImageIds : parsed.selected_image_ids || selectedImageIds,
        intent: 'unknown',
        contextual_image_prompt: '',
        evidence: '根据图片提取/反推生成提示词属于图片理解，不是直接生图',
      }, 'chat');
    }
    if (isPromptWritingInput(options.input) && parsed.mode !== 'chat') {
      return normalize({ mode: 'chat', target: 'none', use_previous_image: false, intent: 'unknown', confidence: 1, evidence: '优化/改写/生成提示词属于文本写作任务，不直接生图' }, 'chat');
    }
    if (isPlainTextChatInput(options.input, options.attachments)) {
      const selectedReferenceId = String(parsed.selectedReferenceId || '');
      const hasExplicitReference = !!selectedReferenceId && selectedReferenceId !== 'imgref_latest';
      const hasSelectedImage = !!(parsed.selectedImageIds?.length || parsed.selectedIndexes?.length || hasExplicitReference);
      if (parsed.mode === 'image' || (parsed.mode === 'edit_image' && !hasSelectedImage)) {
        return normalize({ mode: 'chat', target: 'none', use_previous_image: false, intent: 'unknown', confidence: 1, evidence: '普通文本输入，没有明确生图或可定位修图意图，强制走聊天' }, 'chat');
      }
    }
    return parsed;
  } catch { return null; }
}

function buildFileCandidatesFromAttachments(attachments = []) {
  return (attachments || [])
    .filter(item => item && !item.is_image)
    .map((item, index) => ({
      index: index + 1,
      file_id: item.file_id || item.id || item.attachmentId || item.attachment_id || '',
      name: item.name || 'attachment',
      type: item.type || '',
      size: Number(item.size) || 0,
      has_extracted_text: !!(item.has_extracted_text || item.hasExtractedText),
      unsupported_reason: item.unsupported_reason || item.unsupportedReason || '',
    }));
}

function compactRoutePayloadContext(context = {}, input = '', attachments = []) {
  const next = context && typeof context === 'object' ? { ...context } : {};
  const currentFiles = buildFileCandidatesFromAttachments(attachments);
  if (currentFiles.length) next.file_candidates = currentFiles;
  else if (!Array.isArray(next.file_candidates)) next.file_candidates = [];
  const current = String(input || '').trim();
  const messages = Array.isArray(next.recent_messages) ? [...next.recent_messages] : [];
  if (current && messages.length) {
    const last = messages[messages.length - 1];
    const content = String(last?.content || '').trim();
    const duplicateCurrent = last?.role === 'user' && (content === current || content.startsWith(`${current}\n\n[image `) || content.startsWith(`${current}\n\n[file `));
    if (duplicateCurrent) messages.pop();
  }
  next.recent_messages = messages;
  return next;
}

function compactRouteUserPayload({ input = '', attachments = [], context = {}, currentMode = 'chat', autoMode = true } = {}) {
  const routeContext = compactRoutePayloadContext(context, input, attachments);
  const payload = { current_input: input };
  if (currentMode && currentMode !== 'chat') payload.current_mode = currentMode;
  if (autoMode === false) payload.auto_mode = false;
  if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;
  const compactContext = Object.fromEntries(Object.entries(routeContext || {}).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    if (!value) return false;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  }));
  if (Object.keys(compactContext).length) payload.context = compactContext;
  return payload;
}

function buildRoutePayload({ model, input, attachments = [], context = {}, currentMode = 'chat', autoMode = true, systemPrompt = ROUTE_SYSTEM_PROMPT } = {}) {
  const userPayload = compactRouteUserPayload({ input, attachments, context, currentMode, autoMode });
  return {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt + UPLOADED_IMAGE_ROUTE_PROMPT },
      { role: 'user', content: JSON.stringify(userPayload) },
    ],
  };
}

function extractRouteText(response = {}) {
  return response && response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content || response && response.output_text || '';
}

const api = Object.freeze({
  ROUTE_SYSTEM_PROMPT,
  UPLOADED_IMAGE_ROUTE_PROMPT,
  cleanQuotedContent,
  buildQuotedImagePlaceholders,
  buildQuotedRouteContent,
  stripJsonFence,
  isPlainTextChatInput,
  isImagePromptExtractionInput,
  isImplicitImagePromptExtractionInput,
  isPromptWritingInput,
  apiRouteToExecutionRoute,
  parseRouteResult,
  buildFileCandidatesFromAttachments,
  compactRoutePayloadContext,
  compactRouteUserPayload,
  buildRoutePayload,
  extractRouteText,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIRouteService = api;
if (root?.window) root.window.ChatUIRouteService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
