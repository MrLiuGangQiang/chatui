(function initChatUIRouteService(root) {
  'use strict';

const ROUTE_SYSTEM_PROMPT = `你是 ChatUI 意图路由器，只返回 JSON，不回答用户。
目标：精准识别 current_input，并给出要调用的接口和最小参数；不要关键词硬套。

优先级：current_input 是最新用户输入，优先级最高；attachments 是本轮资源；context 只用于解析明确引用（上一张、这张、刚才、继续、那个文件等）和上一轮修正，历史不能覆盖新任务；image_candidates/file_candidates 是候选元数据，不要猜图片或文件内容。

必须返回：{"route":"chat|vision|image_generate|image_edit|unclear|unsafe","need_image_input":false,"need_file_input":false,"need_clarification":false,"image_source":"none|current|quoted|history","selected_indexes":[],"use_previous_image":false,"instruction":"","reply_to_user":"","confidence":0,"reason":""}

接口：chat：文字聊天/写作/翻译/总结/文件问答/提示词写作；vision=看图回答/OCR/按图反推提示词；image_generate=生成新图片或参考图生成新图；image_edit=修改可定位的已有图片；unclear=缺资源/缺选择/意图不清；unsafe=拒绝。

识别规则：判断用户要文本还是视觉产物。做/生成/设计/制作图片、海报、卡片、模板、示意图、展开图、线稿、可打印成品等可视化产物，通常是 image_generate；写/改写/优化文案、报告、提示词通常是 chat；用提示词生成真实图片才是 image_generate。带图问内容是 vision，改这张图是 image_edit，参考这张图生成新图是 image_generate。

上一轮有图片生成/编辑结果时，用户指出错误或继续调整：能定位且要改原图用 image_edit；要求重做/重新生成或只是指出结果不符合原需求用 image_generate；instruction 保留原始图片目标+当前纠错；不要把“已重新生成/已修改”作为 chat 文本回答。

参数：instruction 只做意图和显式约束摘要，不要写成完整生图/修图 prompt；不要新增 current_input 和 context 中没有的对象、风格、构图、材质、背景、装饰或制作细节。缺图片/文件或多候选未指定才 need_clarification；selected_indexes 用 1-based；reply_to_user 只给追问或拒绝。`

const INTENT_REVIEW_SYSTEM_PROMPT = `你是 ChatUI 意图复判器，只返回 JSON，不回答用户。
场景：首轮意图识别低置信、参数冲突，或最近一轮是工具结果而 current_input 可能是在评价/修正/延续该结果。
目标：判断 current_input 是新任务、普通聊天，还是在延续/修正上一轮工具结果；给出最小可执行参数。
优先级：current_input 最高；attachments 是本轮资源；context 只补明确引用的上一轮目标和约束；instruction 只抽取显式约束，不要新增用户没要求的风格/内容/制作细节；不要用文字假装已生成/已修改。
返回同一 JSON 协议：{"route":"chat|vision|image_generate|image_edit|unclear|unsafe","need_image_input":false,"need_file_input":false,"need_clarification":false,"image_source":"none|current|quoted|history","selected_indexes":[],"use_previous_image":false,"instruction":"","reply_to_user":"","confidence":0,"reason":""}`

const IMAGE_FOLLOWUP_ROUTE_PROMPT = INTENT_REVIEW_SYSTEM_PROMPT;

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

const intentContract = root?.ChatUICoreIntentContract
  || root?.ChatUICore?.intentContract
  || root?.window?.ChatUICoreIntentContract
  || root?.window?.ChatUICore?.intentContract
  || (typeof require === 'function' ? require('../core/intent-contract') : {});

const promptComposer = root?.ChatUIPromptComposerService
  || root?.ChatUIServices?.promptComposer
  || root?.window?.ChatUIPromptComposerService
  || root?.window?.ChatUIServices?.promptComposer
  || (typeof require === 'function' ? require('./prompt-composer-service') : {});

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

function latestImagePromptFromContext(context = {}) {
  return String(context?.last_generated_image?.prompt || context?.latest_assistant_image_result?.content || context?.suggested_contextual_image_prompt || context?.latest_user_image_request?.content || '').trim();
}

function buildContextualImageInstruction(input = '', context = {}, instruction = '') {
  const current = String(input || '').trim();
  const base = latestImagePromptFromContext(context);
  if (!base || !current || base === current) return current || base;
  return `${base}

用户最新要求：${current}`;
}

function taskContractForRoute(route = {}, options = {}) {
  return intentContract?.routeToTaskContract
    ? intentContract.routeToTaskContract(route, options)
    : { intent: route.mode === 'image' ? 'image.generate' : route.mode === 'edit_image' ? 'image.edit' : 'chat', execution: { api: route.mode === 'image' ? 'image_generation' : route.mode === 'edit_image' ? 'image_edit' : 'chat', operation: route.operation?.type || 'plain_chat' } };
}

function applyTaskContract(route = {}, options = {}) {
  const taskContract = taskContractForRoute(route, options);
  const input = String(options.input || '').trim();
  const context = options.context || {};
  let next = { ...route, taskContract };
  if (taskContract.intent === 'image.generate') {
    const prompt = promptComposer?.composeImageGeneratePrompt
      ? promptComposer.composeImageGeneratePrompt(taskContract, context, input)
      : (route.contextualImagePrompt || route.operation?.prompt || input);
    next = { ...next, contextualImagePrompt: prompt, operation: { ...(next.operation || {}), prompt } };
  } else if (taskContract.intent === 'image.edit') {
    const editInstruction = promptComposer?.composeImageEditPrompt
      ? promptComposer.composeImageEditPrompt(taskContract, context, input)
      : (route.editInstruction || route.operation?.edit_instruction || input);
    next = { ...next, editInstruction, operation: { ...(next.operation || {}), edit_instruction: editInstruction } };
  }
  return next;
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
  const imageSelectionCandidateCount = imageSource === 'current' ? currentImageCount(attachments) : contextImageCandidates(context, imageSource).length;
  const ambiguousImageSelection = routeUsesImage && imageSource !== 'none' && !selectedIndexes.length && imageSelectionCandidateCount > 1;
  const unresolvedImageSelection = routeUsesImage && imageSource === 'none' && contextImageCandidates(context, 'history').length > 1;
  const blocksForImageInput = (needImageInput && !hasResolvableImageInput) || ambiguousImageSelection || unresolvedImageSelection;
  const blocksForFileInput = needFileInput && !hasResolvableFileInput;

  if (blocksForImageInput || blocksForFileInput) {
    return { mode: 'chat', operation: { type: 'plain_chat', scope: 'none', prompt: input, edit_instruction: '' }, image_refs: [], file_refs: [], target: 'none', use_previous_image: false, selected_reference_id: '', selected_indexes: [], selected_image_ids: [], need_clarification: true, clarification_question: reply || (blocksForFileInput ? '请先上传文件，或说明要处理哪个文件。' : ambiguousImageSelection ? '请明确要处理第几张图片。' : blocksForImageInput ? '请先上传图片，或说明要处理哪一张历史图片。' : '请说明你想让我做什么。'), intent: (ambiguousImageSelection || unresolvedImageSelection) ? 'unknown' : route === 'image_edit' ? 'image_edit' : 'unknown', edit_instruction: instruction, contextual_image_prompt: '', tasks: [], confidence: confidence || 0.6, evidence: reason || '意图或目标资源不明确' };
  }

  if (route === 'unclear' || needClarification) {
    const modelAskedClarificationForResource = needClarification && !!reply && (
      needImageInput || needFileInput || imageSource !== 'none' || selectedIndexes.length > 0 || usePreviousImage
    );
    if (modelAskedClarificationForResource) {
      return { mode: 'chat', operation: { type: 'plain_chat', scope: 'none', prompt: input, edit_instruction: '' }, image_refs: [], file_refs: [], target: 'none', use_previous_image: false, selected_reference_id: '', selected_indexes: [], selected_image_ids: [], need_clarification: true, clarification_question: reply, intent: route === 'image_edit' || imageSource !== 'none' || usePreviousImage ? 'image_edit' : 'unknown', edit_instruction: instruction, contextual_image_prompt: '', tasks: [], confidence: confidence || 0.65, evidence: reason || '模型要求澄清资源或操作目标' };
    }
    return { mode: 'chat', operation: { type: 'plain_chat', scope: 'context', prompt: input, edit_instruction: '' }, image_refs: [], file_refs: [], target: 'none', use_previous_image: false, selected_reference_id: '', selected_indexes: [], selected_image_ids: [], need_clarification: false, clarification_question: '', intent: 'unknown', edit_instruction: '', contextual_image_prompt: '', tasks: [], confidence: confidence || 0.65, evidence: reason || '非资源阻塞的模糊输入交给聊天模型结合上下文处理' };
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
    const prompt = buildContextualImageInstruction(input, context, instruction);
    return { mode: 'image', operation: { type: 'text_to_image', scope: 'none', prompt, edit_instruction: '' }, image_refs: [], file_refs: [], target: 'new', use_previous_image: false, selected_reference_id: '', selected_indexes: [], selected_image_ids: [], need_clarification: false, clarification_question: '', intent: 'text_to_image', edit_instruction: '', contextual_image_prompt: prompt, tasks: [], confidence: confidence || 0.95, evidence: reason || '纯文本生图' };
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
      const prompt = buildContextualImageInstruction(input, context, instruction);
      return { mode: 'image', operation: { type: 'image_reference_gen', scope: imageSource === 'none' ? 'current' : imageSource, prompt, edit_instruction: '' }, image_refs: refs, file_refs: [], target: 'new', use_previous_image: false, selected_reference_id: selectedReferenceId, selected_indexes: selectedIndexes, selected_image_ids: selectedIds, need_clarification: false, clarification_question: '', intent: 'image_reference_gen', edit_instruction: '', contextual_image_prompt: prompt, tasks: [], confidence: confidence || 0.9, evidence: reason || '参考图生成新图' };
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
    const parsed = applyTaskContract(normalize(legacyInput), options);
    const imageCandidates = Array.isArray(options.context?.image_candidates) ? options.context.image_candidates : [];
    const attachments = options.attachments || [];
    const hasImageContext = imageCandidates.length > 0 || attachments.some(item => item && item.is_image);
    if (hasImageContext && (isImagePromptExtractionInput(options.input) || isImplicitImagePromptExtractionInput(options.input)) && parsed.mode !== 'chat') {
      const first = imageCandidates.length === 1 ? imageCandidates[0] : null;
      const refs = imagePromptExtractionRef({ imageCandidates, attachments, parsed });
      const selectedIndexes = refs.map(ref => Number(ref.index)).filter(index => Number.isInteger(index) && index >= 1);
      const selectedImageIds = refs.map(ref => ref.image_id || ref.imageId).filter(Boolean);
      return applyTaskContract(normalize({
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
      }, 'chat'), options);
    }
    if (isPromptWritingInput(options.input) && parsed.mode !== 'chat') {
      return applyTaskContract(normalize({ mode: 'chat', target: 'none', use_previous_image: false, intent: 'unknown', confidence: 1, evidence: '优化/改写/生成提示词属于文本写作任务，不直接生图' }, 'chat'), options);
    }
    return parsed;
  } catch { return null; }
}

function needsIntentReview(route = {}, context = {}) {
  if (intentContract?.needsIntentReview) return intentContract.needsIntentReview(route.taskContract || taskContractForRoute(route), context);
  return !!(route?.confidence && route.confidence < 0.62);
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

function buildIntentReviewPayload({ model, input, attachments = [], context = {}, firstRoute = null, systemPrompt = INTENT_REVIEW_SYSTEM_PROMPT } = {}) {
  const payload = compactRouteUserPayload({ input, attachments, context, currentMode: 'chat', autoMode: true });
  if (firstRoute) payload.first_route = {
    mode: firstRoute.mode,
    intent: firstRoute.intent,
    operation: firstRoute.operation,
    confidence: firstRoute.confidence,
    evidence: firstRoute.evidence,
    task_contract: firstRoute.taskContract || null,
  };
  return {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  };
}

function buildImageFollowupRoutePayload(options = {}) {
  return buildIntentReviewPayload({ ...options, attachments: [] });
}

function extractRouteText(response = {}) {
  return response && response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content || response && response.output_text || '';
}

const api = Object.freeze({
  ROUTE_SYSTEM_PROMPT,
  INTENT_REVIEW_SYSTEM_PROMPT,
  IMAGE_FOLLOWUP_ROUTE_PROMPT,
  UPLOADED_IMAGE_ROUTE_PROMPT,
  cleanQuotedContent,
  buildQuotedImagePlaceholders,
  buildQuotedRouteContent,
  stripJsonFence,
  isPlainTextChatInput,
  isImagePromptExtractionInput,
  isImplicitImagePromptExtractionInput,
  isPromptWritingInput,
  latestImagePromptFromContext,
  buildContextualImageInstruction,
  taskContractForRoute,
  applyTaskContract,
  needsIntentReview,
  apiRouteToExecutionRoute,
  parseRouteResult,
  buildFileCandidatesFromAttachments,
  compactRoutePayloadContext,
  compactRouteUserPayload,
  buildRoutePayload,
  buildIntentReviewPayload,
  buildImageFollowupRoutePayload,
  extractRouteText,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIRouteService = api;
if (root?.window) root.window.ChatUIRouteService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
