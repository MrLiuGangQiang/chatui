(function initChatUIRouteService(root) {
  'use strict';

const ROUTE_SYSTEM_PROMPT = `Route ChatUI requests. Return JSON only; do not answer the user.

Input priority: current_input is the newest user message and the primary, highest-priority intent. attachments are resources for current_input. context.recent_messages and other context are background/reference only; use them only to resolve explicit references such as previous/last/this/that/it/继续/上一张/这张/那个文件. Never let older context override, replace, or continue a different task when current_input states a new intent.

Input: current_input, attachments, context.image_candidates, context.file_candidates, context.recent_messages, current_mode, auto_mode. Candidates are metadata/placeholders only; do not infer file/image contents.

Output exactly:
{"route":"chat|vision|image_generate|image_edit|unclear|unsafe","need_image_input":false,"need_file_input":false,"need_clarification":false,"image_source":"none|current|quoted|history","selected_indexes":[],"use_previous_image":false,"instruction":"","reply_to_user":"","confidence":0,"reason":""}

Meanings: chat=text/file answer; vision=image-to-text answer; image_generate=new image; image_edit=modify selected existing image; unclear=missing route/resource/selection; unsafe=refuse.

Requests to optimize/rewrite/translate/expand/write an image prompt are text-writing tasks and must route to chat, not image_generate. Only route to image_generate when the user asks to create/render/draw an actual image.

Select resources by image_source and 1-based selected_indexes. If one needed candidate is implied, select it. If multiple candidates fit and user did not identify one, selected_indexes=[] and need_clarification=true. Set need_image_input/need_file_input only when the chosen route lacks required resource. instruction is only for image_generate/image_edit. reply_to_user is only for clarification/refusal.`

const imageRouteContext = root?.ChatUICoreImageRouteContext
  || root?.ChatUICore?.imageRouteContext
  || root?.window?.ChatUICoreImageRouteContext
  || root?.window?.ChatUICore?.imageRouteContext
  || (typeof require === 'function' ? require('../core/image-route-context') : {});

const UPLOADED_IMAGE_ROUTE_PROMPT = '';

function cleanQuotedContent(text = '') {
  return String(text || '')
    .replace(/\[base64 image\]/gi, '')
    .replace(/耗时：[^\n]+/g, '')
    .replace(/RT\s+[^\n]+/gi, '')
    .replace(/TTFT\s+[^\n]+/gi, '')
    .replace(/^\[图片(?:生成|编辑|修改)完成\]\s*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildQuotedImagePlaceholders(images = []) {
  return (images || [])
    .map((item, index) => `[quoted_image index=${index + 1} id=${item.imageId || item.image_id || ''} name=${item.name || ''}]`)
    .join('\n');
}

function buildQuotedRouteContent({ text = '', images = [] } = {}) {
  return [cleanQuotedContent(text), buildQuotedImagePlaceholders(images)].filter(Boolean).join('\n') || '[quoted_message]';
}

function stripJsonFence(text = '') {
  return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function isPlainTextChatInput(input = '', attachments = []) {
  const text = String(input || '').trim();
  if (!text || (attachments || []).some(item => item && item.is_image)) return false;
  if (/(画|绘制|生成|创建|做一张|出一张|来一张|生图|图片|图像|海报|头像|插画|漫画|logo|图标|配图|封面|\d+\s*张图|[一二两三四五六七八九十]+张图|多张图|几张图|render|draw|generate image|create image)/i.test(text)) return false;
  if (/(换|替换|改|修改|编辑|调整|优化|重做|修|去掉|删除|移除|加上|添加|加个|放大|缩小|变成|换个|换成|边框|水印|背景|颜色|字体|样式|清晰|高清|edit|change|remove|replace|add)/i.test(text)) return false;
  return true;
}

function isImagePromptExtractionInput(input = '') {
  return /(提取|总结|分析|拆解|反推|逆向|还原).*(图片|图|画面).*(提示词|prompt|Prompt)|(?:图片|图|画面).*(提取|总结|分析|拆解|反推|逆向|还原|生成|生图).*(提示词|prompt|Prompt)|(?:图片|图|画面).*(元素|要素).*(提示词|prompt|Prompt)|(?:根据|基于|参考|按照).*(图片|图|画面).*(提示词|prompt|Prompt)|(?:生成|生图).*(提示词|prompt|Prompt)|(?:prompt|Prompt).*(反推|逆向|还原|提取)|(?:generate|write|create|make|infer|extract|reverse[-\s]?engineer|reverse).*(?:prompt).*(?:from|based on|for).*(?:image|picture|photo)|(?:image|picture|photo).*(?:prompt).*(?:generate|write|create|infer|extract|reverse)/i.test(String(input || ''));
}

function isImplicitImagePromptExtractionInput(input = '') {
  return /(?:反推|逆向|还原|提取|拆解|分析|总结|生成|生图|写|整理).*(?:提示词|prompt|Prompt)|(?:提示词|prompt|Prompt).*(?:反推|逆向|还原|提取|拆解|分析|总结|生成|生图|详细|尽量详细)|(?:reverse[-\s]?engineer|reverse|infer|extract|write|generate|create|make).*(?:prompt)|(?:prompt).*(?:reverse|infer|extract|write|generate|create|detailed|detail)/i.test(String(input || ''));
}

function isPromptWritingInput(input = '') {
  const text = String(input || '').trim();
  if (!text) return false;
  const promptWord = '(?:提示词|prompt|Prompt|咒语|关键词)';
  const writingVerb = '(?:优化|润色|改写|重写|扩写|完善|修改|调整|翻译|整理|提炼|生成|写|起草|补全|polish|optimi[sz]e|rewrite|revise|improve|translate|expand|write|draft|create|generate)';
  const actualImageVerb = /(?:用|按|根据|基于|照着|拿|把).{0,12}(?:提示词|prompt|Prompt).{0,12}(?:画|绘制|生成|创建|做|出|渲染|生图|render|draw|generate|create).{0,8}(?:图|图片|image|picture|photo)|(?:画|绘制|生成|创建|做|出|渲染|生图|render|draw|generate|create).{0,8}(?:图|图片|image|picture|photo).{0,12}(?:用|按|根据|基于).{0,12}(?:提示词|prompt|Prompt)/i;
  if (actualImageVerb.test(text)) return false;
  return new RegExp(`${writingVerb}.{0,24}${promptWord}|${promptWord}.{0,24}${writingVerb}`, 'i').test(text);
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

const API_ROUTES = new Set(['chat', 'vision', 'image_generate', 'image_edit', 'unclear', 'unsafe']);
const IMAGE_SOURCES = new Set(['none', 'current', 'quoted', 'history']);

function normalizeSelectedIndexes(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => Number(item)).filter(item => Number.isInteger(item) && item >= 1).filter((item, index, list) => list.indexOf(item) === index);
}

function currentImageCount(attachments = []) {
  return (attachments || []).filter(item => item && item.is_image).length;
}

function currentFileCount(attachments = []) {
  return (attachments || []).filter(item => item && !item.is_image).length;
}

function contextImageCandidates(context = {}, source = '') {
  const list = Array.isArray(context?.image_candidates) ? context.image_candidates : [];
  if (!source || source === 'none') return [];
  if (source === 'history') return list.filter(item => item?.source !== 'quoted');
  return list.filter(item => item?.source === source || (source === 'current' && item?.target === 'uploaded'));
}

function contextFileCandidates(context = {}, source = '') {
  const list = Array.isArray(context?.file_candidates) ? context.file_candidates : [];
  if (!source || source === 'none') return [];
  return list.filter(item => !item?.source || item.source === source);
}

function inferSourceFromContext(route, simpleSource, attachments = [], context = {}) {
  if (IMAGE_SOURCES.has(simpleSource) && simpleSource !== 'none') return simpleSource;
  const needsImage = route === 'vision' || route === 'image_edit';
  if (!needsImage) return 'none';
  if (currentImageCount(attachments)) return 'current';
  const candidates = Array.isArray(context?.image_candidates) ? context.image_candidates : [];
  if (candidates.some(item => item?.source === 'quoted')) return 'quoted';
  if (candidates.length || context?.latest_image_reference || context?.last_generated_image || context?.latest_uploaded_image) return 'history';
  return 'none';
}

function defaultIndexesForSource(source, attachments = [], context = {}) {
  const count = source === 'current' ? currentImageCount(attachments) : contextImageCandidates(context, source).length;
  return count === 1 ? [1] : [];
}

function selectedCandidatesForSource(source, indexes = [], attachments = [], context = {}) {
  if (source === 'current') return [];
  const candidates = contextImageCandidates(context, source);
  if (!indexes.length) return candidates.length === 1 ? [candidates[0]] : [];
  return candidates.filter(item => indexes.includes(Number(item.index)));
}

function targetForEditSource(source, candidate = null) {
  if (source === 'current') return 'uploaded';
  if (candidate?.target === 'uploaded') return 'uploaded';
  return 'previous';
}

function imageRefTargetForSource(source, candidate = null) {
  if (source === 'current') return 'uploaded';
  return candidate?.target === 'uploaded' ? 'uploaded' : 'previous';
}

function referenceIdForSource(source, selected = [], context = {}, usePreviousImage = false) {
  const fromCandidate = selected.find(item => item?.reference_id)?.reference_id;
  if (fromCandidate) return fromCandidate;
  if (source === 'history' && context?.latest_image_reference?.reference_id) return context.latest_image_reference.reference_id;
  if (source === 'history' && usePreviousImage) return 'imgref_latest';
  return '';
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
