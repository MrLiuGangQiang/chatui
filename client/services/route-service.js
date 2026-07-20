(function initChatUIRouteService(root) {
  'use strict';

const ROUTE_SYSTEM_PROMPT = `你是 ChatUI 的任务路由器。你不回答用户，只把本轮请求转换成一个严格的 task_contract.v3 JSON 对象。不要输出 Markdown、解释、代码围栏或额外字段。

唯一合法结构：
{"schema_version":"task_contract.v3","operation":"plain_chat|file_qa|multimodal_qa|image_qa|image_compare|ocr|text_to_image|image_reference_gen|edit_image|clarify","relation":"new|followup|correction|continuation","resources":[{"key":"r1","type":"image|file|text|message","source":"current|quoted|history|context","role":"source|target|reference|style_reference|mask|compare_a|compare_b|attachment|context","index":1,"id":"","reference_id":"","missing":false}],"directive":{"mode":"standalone|patch","base_resource_keys":[],"unmentioned_policy":"preserve|allow_change","operations":[{"op":"preserve|add|replace|remove","target":"","value":""}],"constraints":[]},"clarification":{"question":"","missing_resource_keys":[]},"confidence":0,"review_reasons":[],"rationale":""}

判定顺序：
1. 只理解 current_input。attachments 是本轮资源；context 仅用于解析用户明确引用的历史对象，绝不能让历史覆盖一个完整的新请求。
2. 先确定 relation：独立完整请求=new；依赖引用或历史回答=followup；纠正上一结果=correction；仅要求继续原任务=continuation。relation=new 时 resources 只能使用 source=current。
3. 再选唯一 operation。执行 API 和高层意图由程序从 operation 唯一推导，你不要重复输出，以避免字段互相矛盾。
4. 最后确定 resources 和 directive。不要猜图片或文件内容，只使用候选元数据。

operation：
- 普通对话=plain_chat；文件问答=file_qa；文件与图片联合问答=multimodal_qa。
- 看图=image_qa；多图比较=image_compare；OCR=ocr。
- 纯文本生图=text_to_image；基于图片生成=image_reference_gen；修改已有图片=edit_image。
- 只有必需资源缺失、多个候选无法消歧、或操作目标无法确定时才使用 clarify。

资源规则：
- 每个资源必须有唯一 key：r1、r2……；index 使用输入或候选列表中的 1 基编号。
- 编辑对象=target；普通看图=source；生成参考图=reference；风格参考=style_reference；比较图=compare_a/compare_b；文件=attachment。
- 本轮附图在看图、编辑、参考生成任务中默认参与；用户明确排除时才不选。
- image_candidates 的 prompt、description、semantic_text、labels、filename 是候选图片的持久语义元数据。用户按主体、属性、场景或名称指代图片时，先用这些字段逐一匹配，并在 resources 中写入匹配图片的准确 id/reference_id/index。
- 候选很多不等于有歧义。只要用户描述能唯一定位所需图片，就直接执行；只有零个匹配、同一描述匹配多个候选且无法用属性消歧、或操作目标仍不完整时才 clarify。
- 用户说“这张/上一张/那个文件”时必须匹配唯一候选；无法唯一匹配时创建 missing=true 的资源并使用 clarify。

补丁规则：
- standalone 表示当前输入可独立执行：base_resource_keys=[]、operations=[]、unmentioned_policy=allow_change。执行端直接使用 current_input，不接受你重写完整提示词。
- patch 表示任务依赖基线，base_resource_keys 必须引用非 missing 的 resources。
- relation 为 followup/correction/continuation 时必须使用 patch；edit_image 和 image_reference_gen 也必须使用 patch。
- operations 只记录用户明确表达的变化：preserve=保持，add=新增，replace=替换，remove=删除。preserve/remove 的 value 必须为空；add/replace 的 value 必须非空。
- 不得把推测、审美增强词或历史中未被明确引用的内容写入 operations/constraints。
- 精确编辑、纠错、局部修改通常 unmentioned_policy=preserve；“重新设计、自由发挥、做个不同版本”可为 allow_change。
- constraints 只放用户明确的硬约束，不要重复 current_input，也不要重写完整执行提示词。

澄清与复审：
- operation=clarify 时 clarification.question 必须非空；缺失资源的 key 写入 missing_resource_keys。其他 operation 的 clarification 必须为空，且不能存在 missing 资源。
- 意图、关系、资源角色或补丁边界存在歧义时，把简短原因写入 review_reasons；否则返回空数组。
- confidence 是整体判断置信度 0..1。rationale 只写一行可审计依据。

边界示例：
- 历史画过猫，current_input=“画一条鱼”：relation=new，operation=text_to_image，standalone，不引用猫。
- current_input=“人物不变，把红衣服改蓝，去掉右下角文字”：operation=edit_image，patch，target 在 base_resource_keys；operations 为 preserve 人物、replace 衣服颜色、remove 右下角文字；unmentioned_policy=preserve。
- current_input=“参考这张图的构图，生成水彩版本”：operation=image_reference_gen，参考图为 reference 和基线；replace 风格为水彩，preserve 构图。
- current_input=“这张和上一张有什么不同”：operation=image_compare，current 与 history 分别为 compare_a/compare_b，directive=patch。
- 历史有猫、狗、牛、汽车等很多候选，current_input=“把猫和狗合并成一张图”：依据候选语义元数据只选择猫和狗，relation=followup，operation=image_reference_gen，directive=patch；不得仅因候选超过两张而澄清。
- 历史有两张都只描述为“猫”的候选，current_input=“把猫和狗合并”：猫无法唯一定位时才 operation=clarify，并询问具体哪张猫。`;

const INTENT_REVIEW_SYSTEM_PROMPT = `${ROUTE_SYSTEM_PROMPT}

你现在是独立审计器。输入包含 first_task_contract。逐项检查：是否错误继承历史、relation/operation 是否正确、资源是否唯一且角色正确、patch 基线是否完整、operations 是否只含用户明确变化、未提及内容策略是否正确、是否过度澄清。返回审计后的一个完整 task_contract.v3；即使 confidence 降低也应如实修正。`;
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

function cleanQuotedContent(text = '') {
  return String(text || '')
    .replace(/\[base64 image\]/gi, '')
    .replace(/\u8017\u65f6\uff1a[^\n]+/g, '')
    .replace(/RT\s+[^\n]+/gi, '')
    .replace(/TTFT\s+[^\n]+/gi, '')
    .replace(/^\[\u56fe\u7247(?:\u751f\u6210|\u7f16\u8f91|\u4fee\u6539)\u5b8c\u6210\]\s*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripJsonFence(text = '') {
  return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}


function isMultiImageCompositionRequest(input = '') {
  const text = String(input || '').trim();
  if (!text) return false;
  const compose = /(?:合并|融合|组合|拼成|放在一起|combine|merge|blend|compose)/i;
  if (!compose.test(text)) return false;
  const plural = /(?:两张|两个|这两|二者|它们|多张|多个|both|two|multiple)/i;
  const oneImage = /(?:一张图|同一张图|一个画面|single image|same image)/i;
  const namedJoin = /(?:和|与|及|、|\band\b|&)/i;
  return plural.test(text) || oneImage.test(text) || namedJoin.test(text);
}

function compositionCandidates(context = {}) {
  const list = Array.isArray(context.image_candidates) ? context.image_candidates : [];
  const seen = new Set();
  return list.filter(candidate => {
    const id = String(candidate?.image_id || '').trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function selectedCompositionCandidates(taskContract = {}, candidates = []) {
  if (taskContract?.operation !== 'image_reference_gen' || !Array.isArray(taskContract.resources)) return [];
  const result = [];
  for (const resource of taskContract.resources) {
    if (resource?.type !== 'image' || !['reference', 'style_reference'].includes(resource.role) || resource.missing) continue;
    const candidate = candidates.find(item => {
      if (resource.id && item.image_id === resource.id) return true;
      return resource.reference_id
        && item.reference_id === resource.reference_id
        && Number(item.index) === Number(resource.index);
    });
    if (candidate && !result.some(item => item.image_id === candidate.image_id)) result.push(candidate);
  }
  return result;
}

const ENGLISH_SEMANTIC_STOP_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'one', 'two', 'image', 'picture', 'photo', 'illustration',
  'draw', 'paint', 'create', 'generate', 'make', 'show', 'please', 'version', 'with', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for',
]);

const CJK_SEMANTIC_STOP_PHRASES = [
  '请帮我', '帮我', '请', '把', '将', '画一张', '画一个', '画一只', '画一头', '画一条', '绘制', '画', '生成', '制作', '创建',
  '一张图片', '一幅图片', '一张图像', '一张照片', '一张图', '一幅图', '一个画面', '一只', '一头', '一条', '一个', '一张', '一幅', '这张图片',
  '这幅图片', '这张图像', '这张照片', '这张图', '这幅图', '图片', '图像', '照片', '插画', '作品', '版本',
]

function normalizeSemanticValue(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function addSemanticTerm(result, value, weight = 1) {
  const term = normalizeSemanticValue(value).replace(/^[\s._-]+|[\s._-]+$/g, '');
  if (!term) return;
  const previous = result.get(term) || 0;
  if (weight > previous) result.set(term, weight);
}

function semanticTermsFromText(value = '', weight = 1) {
  const normalized = normalizeSemanticValue(value);
  const result = new Map();
  for (const word of normalized.match(/[a-z0-9][a-z0-9_-]*/g) || []) {
    if (word.length < 2 || ENGLISH_SEMANTIC_STOP_WORDS.has(word)) continue;
    addSemanticTerm(result, word, weight + Math.min(word.length, 12) / 20);
  }
  for (const rawChunk of normalized.match(/[\p{Script=Han}]+/gu) || []) {
    let chunk = rawChunk;
    for (const phrase of CJK_SEMANTIC_STOP_PHRASES) chunk = chunk.split(phrase).join(' ');
    for (const part of chunk.split(/\s+/).filter(Boolean)) {
      if (part.length === 1) {
        addSemanticTerm(result, part, weight + 0.25);
        continue;
      }
      if (part.length <= 16) addSemanticTerm(result, part, weight + Math.min(part.length, 8) / 10);
      const maxLength = Math.min(8, part.length);
      for (let length = 2; length <= maxLength; length += 1) {
        for (let index = 0; index + length <= part.length; index += 1) {
          addSemanticTerm(result, part.slice(index, index + length), weight + length / 10);
        }
      }
    }
  }
  return result;
}

function candidateSemanticTerms(candidate = {}) {
  const result = new Map();
  const merge = terms => {
    for (const [term, weight] of terms) addSemanticTerm(result, term, weight);
  };
  for (const label of Array.isArray(candidate.labels) ? candidate.labels : []) merge(semanticTermsFromText(label, 4));
  merge(semanticTermsFromText(candidate.description || candidate.semantic_description || candidate.semanticDescription || '', 3));
  merge(semanticTermsFromText(candidate.semantic_text || candidate.semanticText || '', 2.5));
  merge(semanticTermsFromText(candidate.prompt || '', 2));
  merge(semanticTermsFromText(candidate.filename || candidate.name || '', 1));
  return result;
}

function inputContainsSemanticTerm(input = '', term = '') {
  const normalizedInput = normalizeSemanticValue(input);
  if (!normalizedInput || !term) return false;
  if (/^[a-z0-9_-]+$/.test(term)) {
    const words = new Set(normalizedInput.match(/[a-z0-9][a-z0-9_-]*/g) || []);
    return words.has(term);
  }
  return normalizedInput.replace(/[^\p{Script=Han}a-z0-9_-]+/gu, '').includes(term);
}

function inputExcludesSemanticTerm(input = '', term = '') {
  const normalizedInput = normalizeSemanticValue(input);
  if (!normalizedInput || !term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/^[a-z0-9_-]+$/.test(term)) {
    return new RegExp(`(?:without|exclude|excluding|do not use|don't use|not)\\s+(?:\\w+\\s+){0,2}${escaped}\\b`, 'i').test(normalizedInput);
  }
  return new RegExp(`(?:不要|不用|不含|排除|去掉|移除|别用)[^，。；;,.]{0,10}${escaped}|${escaped}[^，。；;,.]{0,6}(?:不要|不用|排除|去掉|移除)`).test(normalizedInput);
}

function semanticallySelectedCompositionCandidates(input = '', candidates = []) {
  const profiles = candidates.map(candidate => ({ candidate, terms: candidateSemanticTerms(candidate) }));
  const documentFrequency = new Map();
  for (const profile of profiles) {
    for (const term of profile.terms.keys()) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
  }
  return profiles
    .map(profile => {
      const evidence = [];
      let score = 0;
      for (const [term, weight] of profile.terms) {
        if (documentFrequency.get(term) !== 1 || !inputContainsSemanticTerm(input, term) || inputExcludesSemanticTerm(input, term)) continue;
        score += weight * Math.max(1, Math.min(term.length, 8));
        evidence.push(term);
      }
      evidence.sort((a, b) => b.length - a.length || a.localeCompare(b));
      return { ...profile, score, evidence };
    })
    .filter(profile => profile.score > 0)
    .sort((a, b) => Number(a.candidate.index) - Number(b.candidate.index))
    .map(profile => profile.candidate);
}

function imageReferenceCompositionContract(candidates = [], input = '', prior = {}) {
  const resources = candidates.map((candidate, index) => ({
    key: `r${index + 1}`,
    type: 'image',
    source: ['current', 'quoted', 'history', 'context'].includes(candidate.source) ? candidate.source : 'history',
    role: 'reference',
    index: Number(candidate.index) || index + 1,
    id: String(candidate.image_id || ''),
    reference_id: String(candidate.reference_id || ''),
    missing: false,
  }));
  return {
    schema_version: 'task_contract.v3',
    operation: 'image_reference_gen',
    relation: 'followup',
    resources,
    directive: {
      mode: 'patch',
      base_resource_keys: resources.map(resource => resource.key),
      unmentioned_policy: 'allow_change',
      operations: [{ op: 'add', target: 'composition', value: String(input || '').trim() }],
      constraints: [],
    },
    clarification: { question: '', missing_resource_keys: [] },
    confidence: Math.max(0.95, Number(prior?.confidence) || 0),
    review_reasons: [],
    rationale: `用户通过图片语义唯一指定了 ${resources.length} 个合成资源`,
  };
}

function ambiguousImageCompositionContract(prior = {}) {
  return {
    schema_version: 'task_contract.v3',
    operation: 'clarify',
    relation: 'followup',
    resources: [],
    directive: {
      mode: 'standalone',
      base_resource_keys: [],
      unmentioned_policy: 'allow_change',
      operations: [],
      constraints: [],
    },
    clarification: {
      question: '我还不能唯一确定要合并的图片，请补充主体、颜色、场景等特征，或直接引用对应图片。',
      missing_resource_keys: [],
    },
    confidence: Math.max(0.9, Number(prior?.confidence) || 0),
    review_reasons: ['image_candidates_require_semantic_disambiguation'],
    rationale: '图片语义与用户指代无法形成唯一映射',
  };
}

function reconcileMultiImageCompositionContract(taskContract = {}, options = {}) {
  if (!isMultiImageCompositionRequest(options.input)) return taskContract;
  const candidates = compositionCandidates(options.context || {});
  const selected = selectedCompositionCandidates(taskContract, candidates);
  if (selected.length >= 2) return imageReferenceCompositionContract(selected, options.input, taskContract);
  const semanticSelection = semanticallySelectedCompositionCandidates(options.input, candidates);
  if (semanticSelection.length >= 2) return imageReferenceCompositionContract(semanticSelection, options.input, taskContract);
  const explicitAll = /(?:这两张|两张图|两个|它们|二者|both|these two)/i.test(String(options.input || ''));
  if (explicitAll && candidates.length === 2) return imageReferenceCompositionContract(candidates, options.input, taskContract);
  return ambiguousImageCompositionContract(taskContract);
}

function buildQuotedImagePlaceholders(images = []) {
  return (images || [])
    .map((item, index) => `[quoted_image index=${index + 1} id=${item.imageId || item.image_id || ''} name=${item.name || ''}]`)
    .join('\n');
}

function buildQuotedRouteContent({ text = '', images = [] } = {}) {
  return [cleanQuotedContent(text), buildQuotedImagePlaceholders(images)].filter(Boolean).join('\n') || '[quoted_message]';
}

function attachComposedPrompt(route = {}, taskContract = {}, options = {}) {
  const input = String(options.input || '').trim();
  const context = options.context || {};
  let next = { ...route, taskContract };
  if (taskContract.operation === 'text_to_image' || taskContract.operation === 'image_reference_gen') {
    const prompt = promptComposer?.composeImageGeneratePrompt
      ? promptComposer.composeImageGeneratePrompt(taskContract, context, input)
      : input;
    next = { ...next, contextualImagePrompt: prompt };
  } else if (taskContract.operation === 'edit_image') {
    const editInstruction = promptComposer?.composeImageEditPrompt
      ? promptComposer.composeImageEditPrompt(taskContract, context, input)
      : input;
    next = { ...next, editInstruction };
  }
  return next;
}

function isTaskContractResult(value = {}) {
  return typeof intentContract.hasExactContractShape === 'function'
    && intentContract.hasExactContractShape(value);
}

function parseRouteResult(text = '', options = {}) {
  const value = String(text || '').trim();
  if (!value) return null;
  try {
    const parsedContract = JSON.parse(stripJsonFence(value));
    const taskContract = reconcileMultiImageCompositionContract(parsedContract, options);
    if (!isTaskContractResult(taskContract)) return null;
    const executionPlan = intentContract.taskContractToExecutionPlan(taskContract, options);
    return attachComposedPrompt(executionPlan, taskContract, options);
  } catch {
    return null;
  }
}

function needsIntentReview(route = {}, context = {}) {
  if (!route?.taskContract) return false;
  return intentContract?.needsIntentReview ? intentContract.needsIntentReview(route.taskContract, context) : false;
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
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(userPayload) },
    ],
  };
}

function buildIntentReviewPayload({ model, input, attachments = [], context = {}, firstRoute = null, systemPrompt = INTENT_REVIEW_SYSTEM_PROMPT } = {}) {
  const payload = compactRouteUserPayload({ input, attachments, context, currentMode: 'chat', autoMode: true });
  if (firstRoute?.taskContract) payload.first_task_contract = firstRoute.taskContract;
  return {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  };
}

function extractRouteText(response = {}) {
  return response && response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content || response && response.output_text || '';
}

const api = Object.freeze({
  ROUTE_SYSTEM_PROMPT,
  INTENT_REVIEW_SYSTEM_PROMPT,
  cleanQuotedContent,
  buildQuotedImagePlaceholders,
  buildQuotedRouteContent,
  stripJsonFence,
  isMultiImageCompositionRequest,
  candidateSemanticTerms,
  semanticallySelectedCompositionCandidates,
  reconcileMultiImageCompositionContract,
  needsIntentReview,
  isTaskContractResult,
  parseRouteResult,
  buildFileCandidatesFromAttachments,
  compactRoutePayloadContext,
  compactRouteUserPayload,
  buildRoutePayload,
  buildIntentReviewPayload,
  extractRouteText,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIRouteService = api;
if (root?.window) root.window.ChatUIRouteService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
