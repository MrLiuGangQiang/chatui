(function initChatUIRouteService(root) {
  'use strict';

const ROUTE_SYSTEM_PROMPT = `你是 ChatUI 意图路由器，只返回 JSON，不回答用户。
目标：精准识别 current_input，并输出结构化 task contract；steps 仅描述当前单次执行，不得输出未实现的多阶段执行协议。

核心原则：current_input 是最新用户输入，优先级最高；attachments 是本轮资源，图片/文件都是当前输入的一部分；context 只用于解析明确引用（上一张、刚才、引用消息、继续、那个文件等）和上一轮修正，历史不能覆盖新任务。image_candidates/file_candidates 是候选元数据；不要猜图片或文件内容，只判断任务、资源、角色和执行参数。

必须返回 task contract JSON：
{"schema_version":"task_contract.v2","intent":"chat|vision_qa|image.generate|image.edit|file.qa|clarify|refuse","task_type":"new_task|followup|correction|continuation","execution":{"api":"chat|vision|image_generation|image_edit|clarify|refuse","operation":"plain_chat|file_qa|multimodal_qa|image_qa|image_compare|ocr|text_to_image|image_reference_gen|edit_image|clarify|refuse"},"resources":[{"type":"image|file|text|message","source":"current|quoted|history|context","role":"source|target|reference|style_reference|mask|compare_a|compare_b|attachment|context","index":1,"id":"","reference_id":"","required":true,"missing":false}],"steps":[{"id":"step_1","operation":"plain_chat|file_qa|multimodal_qa|image_qa|image_compare|ocr|text_to_image|image_reference_gen|edit_image","input_roles":[],"output_role":"output","prompt":"","depends_on":[]}],"prompt_plan":{"current_user_intent":"","context_to_preserve":"","constraints":[],"do_not_add":[],"final_instruction":""},"clarification":{"needed":false,"question":"","missing_resources":[]},"confidence":0,"needs_review":false,"reason":""}

needs_review 规则：当意图在两种可能性之间模糊（如生图还是聊天、修图还是看图）、有多个候选图片但不确定用户指哪一张、或当前上下文与用户输入有冲突时设为 true；其他情况设为 false。

意图选择：普通文字聊天/写作/翻译/代码解释=chat/plain_chat；看图回答/按图评价/找问题/提取图片信息=vision_qa/image_qa；图片文字识别=vision_qa/ocr；两张或多张图片比较=vision_qa/image_compare；文件内容问答/总结/提取=file.qa/file_qa；文件+图片综合问答=file.qa/multimodal_qa；纯文本生图=image.generate/text_to_image；参考已有图片生成新图=image.generate/image_reference_gen；修改已有图片=image.edit/edit_image。需要“先分析再生成/编辑”时，按最终要执行的图片操作选择 image.generate 或 image.edit，并把分析要求写入 prompt_plan，不要输出未实现的多阶段执行类型。

资源角色：被编辑图片 role=target；参考图 role=reference；风格参考 role=style_reference；对比双方 role=compare_a/compare_b；看图问答图片 role=source；文件 role=attachment。source=current 表示本轮附件；quoted 表示引用消息；history 表示上一张/刚才/历史候选。

本轮有图片时：除非用户明确纯文本或明确排除当前图，当前图片默认参与任务。若用户同时说上一张/刚才那张/上一个并要求区别/对比/变化，必须输出 current + history 两个 image resources，operation=image_compare。若用户明确“不要看这张/只处理上一张”，只用 history。

澄清：只有资源缺失、多个候选但用户必须指定、或操作目标不清时 intent=clarify；不要把可直接执行的任务澄清掉。

只返回 JSON，不要 Markdown。`;

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
  isImageUnderstandingInput,
  isImageEditInput,
  isImageEditCommand,
  isExplicitTextOnlyInput,
  isExplicitHistoryImageInput,
  isImageComparisonWithHistoryInput,
  isHistoryOnlyImageInput,
  isCurrentImageDeicticInput,
  normalizeSelectedIndexes,
  currentImageCount,
  currentFileCount,
  contextImageCandidates,
  contextFileCandidates,
  inferSourceFromContext,
  defaultIndexesForSource,
  selectedCandidatesForSource,
  candidateExecutionIndexes,
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
  if (route.operation?.type === 'image_qa' && taskContract.intent !== 'vision_qa') {
    next = { ...next, taskContract: taskContractForRoute({ ...route, intent: 'vision_qa' }, options) };
  }
  if (next.taskContract.intent === 'image.generate') {
    const prompt = promptComposer?.composeImageGeneratePrompt
      ? promptComposer.composeImageGeneratePrompt(next.taskContract, context, input)
      : (route.contextualImagePrompt || route.operation?.prompt || input);
    next = { ...next, contextualImagePrompt: prompt, operation: { ...(next.operation || {}), prompt } };
  } else if (next.taskContract.intent === 'image.edit') {
    const editInstruction = promptComposer?.composeImageEditPrompt
      ? promptComposer.composeImageEditPrompt(next.taskContract, context, input)
      : (route.editInstruction || route.operation?.edit_instruction || input);
    next = { ...next, editInstruction, operation: { ...(next.operation || {}), edit_instruction: editInstruction } };
  }
  return next;
}

function enforceCurrentImageIntent(simple = {}, options = {}) {
  const input = String(options.input || '').trim();
  const attachments = options.attachments || [];
  const context = options.context || {};
  if (!currentImageCount(attachments) || isExplicitTextOnlyInput(input)) return simple;
  if (isImageComparisonWithHistoryInput(input)) {
    return {
      ...simple,
      route: 'vision',
      image_source: 'current',
      imageSource: 'current',
      need_image_input: false,
      needImageInput: false,
      need_clarification: false,
      needClarification: false,
      use_previous_image: false,
      usePreviousImage: false,
      image_refs: [
        { source: 'history', role: 'reference', index: 1, target: 'previous' },
        { source: 'current', role: 'target', index: 1, target: 'uploaded' },
      ],
      confidence: Math.max(Number(simple.confidence) || 0, 0.86),
      reason: simple.reason || '本轮图片与历史图片的跨来源对比任务',
    };
  }
  if (isHistoryOnlyImageInput(input)) return simple;
  const route = String(simple.route || simple.api || '').trim();
  const imageSource = String(simple.image_source || simple.imageSource || 'none');
  if (imageSource && imageSource !== 'none' && imageSource !== 'current') return simple;
  const next = { ...simple, image_source: 'current', imageSource: 'current', need_image_input: false, needImageInput: false, need_clarification: false, needClarification: false, use_previous_image: false, usePreviousImage: false };
  if (!normalizeSelectedIndexes(simple.selected_indexes || simple.selectedIndexes).length && currentImageCount(attachments) === 1) next.selected_indexes = [1];
  if (route === 'image_edit' && isImageUnderstandingInput(input) && !isImageEditCommand(input)) return { ...next, route: 'vision', confidence: Math.max(Number(simple.confidence) || 0, 0.88), reason: simple.reason || '当前图片为视觉问答，不执行图片编辑' };
  if ((!route || route === 'chat' || route === 'unclear') && isImageEditCommand(input)) return { ...next, route: 'image_edit', instruction: simple.instruction || input, confidence: Math.max(Number(simple.confidence) || 0, 0.88), reason: simple.reason || '本轮上传图片且输入为图片编辑意图' };
  if ((!route || route === 'chat' || route === 'unclear') && isImageUnderstandingInput(input)) return { ...next, route: 'vision', confidence: Math.max(Number(simple.confidence) || 0, 0.88), reason: simple.reason || '本轮上传图片且输入为图片理解意图' };
  if (!route || route === 'chat' || route === 'unclear') return { ...next, route: 'vision', confidence: Math.max(Number(simple.confidence) || 0, 0.78), reason: simple.reason || '本轮图片是当前输入的一部分，非明确纯文本任务默认按图片理解处理' };
  if (route === 'vision' || route === 'image_edit' || route === 'image_generate') return next;
  return simple;
}

function apiRouteToExecutionRoute(simple = {}, options = {}) {
  const input = String(options.input || '').trim();
  const attachments = options.attachments || [];
  const context = options.context || {};
  let route = API_ROUTES.has(String(simple.route || simple.api || '')) ? String(simple.route || simple.api) : 'unclear';
  if (route === 'image_edit' && (isImageUnderstandingInput(input) || isImagePromptExtractionInput(input) || isImplicitImagePromptExtractionInput(input)) && !isImageEditCommand(input)) route = 'vision';
  const confidence = Number.isFinite(Number(simple.confidence)) ? Math.max(0, Math.min(1, Number(simple.confidence))) : 0;
  const reason = String(simple.reason || '').trim();
  const explicitImageRefs = Array.isArray(simple.image_refs) && simple.image_refs.length ? simple.image_refs : (Array.isArray(simple.imageRefs) ? simple.imageRefs : []);
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
  const blocksForImageInput = (routeUsesImage && !hasResolvableImageInput) || ambiguousImageSelection || unresolvedImageSelection;
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
    if (route === 'vision' && explicitImageRefs.some(ref => ref?.source === 'history') && explicitImageRefs.some(ref => ref?.source === 'current')) {
      const refs = explicitImageRefs.map((ref, index) => ({
        role: ref.role || 'source',
        image_id: ref.image_id || ref.imageId || '',
        reference_id: ref.reference_id || ref.referenceId || referenceIdForSource(ref.source === 'history' ? 'history' : 'current', [], context, ref.source === 'history'),
        index: Number(ref.index) || index + 1,
        target: ref.target || (ref.source === 'history' ? 'previous' : 'uploaded'),
        source: ref.source === 'history' ? 'history' : 'current',
      }));
      const selectedIds = refs.map(ref => ref.image_id).filter(Boolean);
      const effectiveSelectedIndexes = refs.filter(ref => ref.source === 'current').map(ref => Number(ref.index)).filter(index => Number.isInteger(index) && index >= 1);
      return { mode: 'chat', operation: { type: 'image_qa', scope: 'context', prompt: input, edit_instruction: '' }, image_refs: refs, file_refs: [], target: 'none', use_previous_image: false, selected_reference_id: refs.find(ref => ref.reference_id)?.reference_id || '', selected_indexes: effectiveSelectedIndexes, selected_image_ids: selectedIds, need_clarification: false, clarification_question: '', intent: 'unknown', edit_instruction: '', contextual_image_prompt: '', tasks: [], confidence: confidence || 0.9, evidence: reason || '跨来源图片对比' };
    }
    const selected = selectedCandidatesForSource(imageSource, selectedIndexes, attachments, context);
    const first = selected[0] || null;
    const executionIndexes = typeof candidateExecutionIndexes === 'function' ? candidateExecutionIndexes(selected) : [];
    const effectiveSelectedIndexes = executionIndexes.length ? executionIndexes : selectedIndexes;
    const role = route === 'image_edit' ? 'target' : route === 'image_generate' ? 'reference' : 'source';
    const refs = (selected.length ? selected : effectiveSelectedIndexes).map(item => {
      const candidate = selected.length ? item : (selected.find(candidate => Number(candidate.index) === Number(item)) || (effectiveSelectedIndexes.length === 1 ? first : null));
      const index = Number(candidate && (candidate.source_index || candidate.sourceIndex || candidate.index)) || Number(item) || 1;
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
      return { mode: 'image', operation: { type: 'image_reference_gen', scope: imageSource === 'none' ? 'current' : imageSource, prompt, edit_instruction: '' }, image_refs: refs, file_refs: [], target: 'new', use_previous_image: false, selected_reference_id: selectedReferenceId, selected_indexes: effectiveSelectedIndexes, selected_image_ids: selectedIds, need_clarification: false, clarification_question: '', intent: 'image_reference_gen', edit_instruction: '', contextual_image_prompt: prompt, tasks: [], confidence: confidence || 0.9, evidence: reason || '参考图生成新图' };
    }
    if (route === 'image_edit') {
      const target = targetForEditSource(imageSource, first);
      usePreviousImage = usePreviousImage || (imageSource === 'history' && target === 'previous');
      return { mode: 'edit_image', operation: { type: 'image_edit', scope: imageSource === 'none' ? 'current' : imageSource, prompt: '', edit_instruction: instruction || input }, image_refs: refs, file_refs: [], target, use_previous_image: usePreviousImage, selected_reference_id: selectedReferenceId, selected_indexes: effectiveSelectedIndexes, selected_image_ids: selectedIds, need_clarification: false, clarification_question: '', intent: 'image_edit', edit_instruction: instruction || input, contextual_image_prompt: '', tasks: [], confidence: confidence || 0.95, evidence: reason || '修改已有图片' };
    }
    const isOcr = /(?:ocr|OCR|识别文字|文字识别|读文字|读取文字|提取文字)/i.test([input, instruction].filter(Boolean).join('\n'));
    const type = isOcr ? 'ocr' : 'image_qa';
    return { mode: 'chat', operation: { type, scope: imageSource === 'none' ? 'current' : imageSource, prompt: input, edit_instruction: '' }, image_refs: refs, file_refs: [], target: 'none', use_previous_image: false, selected_reference_id: selectedReferenceId, selected_indexes: effectiveSelectedIndexes, selected_image_ids: selectedIds, need_clarification: false, clarification_question: '', intent: 'unknown', edit_instruction: '', contextual_image_prompt: '', tasks: [], confidence: confidence || 0.95, evidence: reason || (isOcr ? '图片文字识别' : '图片理解') };
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
    if (raw?.mode === 'edit_image' && currentImageCount(options.attachments || []) && (isImageUnderstandingInput(options.input) || isImagePromptExtractionInput(options.input) || isImplicitImagePromptExtractionInput(options.input)) && !isImageEditCommand(options.input)) {
      raw.mode = 'chat';
      raw.intent = 'vision_qa';
      raw.operation = { ...(raw.operation || {}), type: 'image_qa', scope: raw.operation?.scope || 'current', prompt: String(options.input || raw.operation?.prompt || '').trim(), edit_instruction: '' };
    }
    const rawTaskContract = raw && typeof raw === 'object' && (raw.schema_version || raw.schemaVersion || raw.execution || raw.resources || raw.steps) && !raw.mode && !isSimpleClassifierResult(raw)
      ? intentContract?.normalizeTaskContract?.(raw, options)
      : null;
    const routeInput = rawTaskContract && intentContract?.taskContractToRouteInput
      ? intentContract.taskContractToRouteInput(rawTaskContract, options)
      : isSimpleClassifierResult(raw) ? apiRouteToExecutionRoute(raw, options) : raw;
    const parsedBase = normalize(routeInput);
    const parsed = rawTaskContract ? { ...applyTaskContract(parsedBase, options), taskContract: rawTaskContract } : applyTaskContract(parsedBase, options);
    return parsed;
  } catch { return null; }
}

function needsIntentReview(route = {}, context = {}) {
  if (intentContract?.needsIntentReview) return intentContract.needsIntentReview(route.taskContract || taskContractForRoute(route), context);
  if (route.needs_review === true || route.needsReview === true) return true;
  if (route.needs_review === false || route.needsReview === false) return false;
  return !!(route?.confidence && route.confidence < 0.25);
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
  isImageUnderstandingInput,
  isImageEditInput,
  isExplicitTextOnlyInput,
  isExplicitHistoryImageInput,
  isImageComparisonWithHistoryInput,
  isHistoryOnlyImageInput,
  isCurrentImageDeicticInput,
  enforceCurrentImageIntent,
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
