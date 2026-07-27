(function initChatUIRouteService(root) {
  'use strict';

const MAX_ROUTE_REPAIR_OUTPUT_CHARS = 12000;

// The model decides semantics only. The application compiles this compact
// decision into the sole executable task_contract.v5; the model never copies
// ids, indexes, sources, directive base keys, or other mechanical fields.
const ROUTE_SYSTEM_PROMPT_V5 = `你是 ChatUI 的语义路由器。只输出严格的 route_decision.v1 JSON；不要回答用户，不要输出分析、Markdown、代码围栏或未定义字段。应用会把你的决策确定性编译为 task_contract.v5，你绝不能手写完整合同或复制资源 id/index/source。

唯一结构：
{"schema_version":"route_decision.v1","readiness":"ready|needs_clarification","operation":"plain_chat|file_qa|multimodal_qa|image_qa|image_compare|ocr|text_to_image|image_reference_gen|edit_image","relation":"new|followup|correction|continuation","bindings":[{"candidate_key":"i1|f1|m1","role":"source|target|reference|style_reference|mask|compare_a|compare_b|attachment|context"}],"changes":[{"op":"preserve|add|replace|remove","target":"","value":""}],"constraints":[],"clarification":{"question":"","unresolved":[{"type":"image|file|text|message","role":"source|target|reference|style_reference|mask|compare_a|compare_b|attachment|context","reason":"missing|ambiguous|unavailable","candidate_keys":[]}]},"confidence":0,"rationale":""}

一、只做语义决策
1. current_input 是本轮指令；resource_candidates 是应用给出的唯一可选资源目录。bindings 只能选择其中的 candidate_key 并赋予语义 role，不能编造 key。current_input 本身是隐式文本，不需要 binding。
2. attachments 只代表本轮上传；context 只提供明确指代证据。完整独立的新请求不得继承历史。只有“这张、那个文件、基于这个描述、继续、还是不对”等明确指代才选择历史/引用候选。
3. context.quoted_message 是用户显式引用。引用文字生成图片时必须选择对应 m key，role=context；不能因 text_to_image 不消费图片就丢弃引用消息。“基于这个描述再生成一张图片”是 text_to_image + followup，不是 resources 为空的新任务。relation=followup 不等于必须绑定历史消息：当前指令已明确生成动作和主体时不得选择历史 m key，例如“再画一只狗，换个品种”必须 bindings=[]，不能与“画一只狗”拼接；只有“再生成一张”“基于这个描述再来一张”等缺少主体或明确指向前文的指令才绑定历史消息。
4. clarification_context.v1 仅是本轮重新判断的证据，不复制 prior_task_contract，不让 continuation classifier 授权执行。

二、operation 与资源槽
5. plain_chat=普通文本任务；file_qa=读取文件；multimodal_qa=同时读取图片和文件；image_qa=描述/分析图片；ocr=提取图片文字；image_compare=比较两图。
6. text_to_image=文字生成新图片，不选择 image；引用文字可选择 message(context)。image_reference_gen=选择已有图片作 reference/style_reference 并生成新图；合并多图属于它，即使传输走编辑接口也不是 edit_image。edit_image=修改明确 target，可有一个 mask。图片反推/逆向/提取提示词属于 image_qa 文本任务，“生成提示词”绝不是“生成图片”。
7. 槽位固定：file 只能 attachment；message 只能 context；image_qa/ocr 图片为 source；image_compare 恰好 compare_a+compare_b；edit_image 图片只用 target/mask，且恰好 1 个 target、至多 1 个 mask，绝不能把“全部”解释为多个 target；image_reference_gen 图片只用 reference/style_reference。plain_chat 的非当前图片只能 reference/style_reference。
8. 不可解析文件不能进入 bindings 或 ambiguous 候选；若任务依赖它，输出 file/attachment/unavailable 且 candidate_keys=[]。附件无指令时按附件类型保留暂定 operation，并增加 text/source/missing。

三、关系、澄清与修改
9. relation 只描述对话关系：new=独立新任务；followup=基于已有内容扩展；correction=修正结果；continuation=继续未完成任务。选择 quoted/history/context 候选时 relation 不能是 new；只选 current 候选也可按真实语义为 followup/correction/continuation。
10. ready 时 clarification.question="" 且 unresolved=[]。缺资源、候选歧义、文件不可用、目标不明、固定模式冲突、附件无指令或跨执行族多任务时 needs_clarification；ambiguous 至少两个 candidate_keys，missing/unavailable 必须 []，不得替用户选择。尤其是 edit_image：若多个图片候选都符合“狗、产品、人物”等同一泛称，用户又未引用、编号或明确描述其中一张，必须澄清，绝不能默认最新图片。
11. auto_mode=true 或缺省时自由选择 operation，不受上轮界面模式影响。auto_mode=false 时 current_mode 固定产品族：chat 允许聊天/理解类，image 允许 text_to_image/image_reference_gen，edit_image 允许 edit_image；冲突时 needs_clarification + text/source/missing，不要求用户理解内部接口。
12. changes 只记录用户明确修改：add/replace 的 target/value 非空；preserve/remove 的 target 非空且 value=""。constraints 只写明确约束。多项要求可由同一 operation 一次完成才合并，否则 needs_clarification，不得部分执行。`;

const ROUTE_OUTPUT_CONTRACT_CHECK_V5 = `输出前自检：恰好 10 个顶层字段，空数组也输出 []；只选 resource_candidates 中的 key；ready 无 unresolved；引用文字生图必须绑定 m key；bindings 的类型/role 满足 operation；只输出 route_decision.v1 JSON。`;
const ROUTE_MISSING_DETAIL_GUIDANCE_V5 = `关键反例：“把猫的颜色换一下”没有给出目标颜色，不能 ready，也不能输出 value=""。必须保持 edit_image 和已明确的 target binding，输出 needs_clarification，changes=[]，clarification.question 询问目标颜色，并声明 text/source/missing、candidate_keys=[]。只有“把猫改成黑色”这类目标值明确的指令才能输出非空 replace.value。`;
const ROUTE_SYSTEM_PROMPT_WITH_OUTPUT_CHECK_V5 = `${ROUTE_SYSTEM_PROMPT_V5}\n\n${ROUTE_MISSING_DETAIL_GUIDANCE_V5}\n\n${ROUTE_OUTPUT_CONTRACT_CHECK_V5}`;

const INTENT_REPAIR_SYSTEM_PROMPT_V5 = `你是 route_decision.v1 格式修复器。repair_invariants 是不可变边界：operation、relation、readiness、bindings、changes、constraints、clarification.question 和 unresolved 语义不可改变；只能补齐非语义结构字段，不能增删候选、改角色、改约束、替用户选择或改变是否执行。只输出严格 JSON。`;

function strictObject(properties) {
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

const ROUTE_CHANGE_SCHEMA = Object.freeze({
  anyOf: [
    strictObject({
      op: { type: 'string', enum: ['add', 'replace'] },
      target: { type: 'string', pattern: '\\S' },
      value: { type: 'string', pattern: '\\S' },
    }),
    strictObject({
      op: { type: 'string', enum: ['preserve', 'remove'] },
      target: { type: 'string', pattern: '\\S' },
      value: { type: 'string', const: '' },
    }),
  ],
});

const ROUTE_RESPONSE_FORMAT = Object.freeze({
  type: 'json_schema',
  json_schema: {
    name: 'chatui_route_decision_v1',
    strict: true,
    schema: strictObject({
      schema_version: { type: 'string', const: 'route_decision.v1' },
      readiness: { type: 'string', enum: ['ready', 'needs_clarification'] },
      operation: { type: 'string', enum: ['plain_chat', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr', 'text_to_image', 'image_reference_gen', 'edit_image'] },
      relation: { type: 'string', enum: ['new', 'followup', 'correction', 'continuation'] },
      bindings: {
        type: 'array',
        items: strictObject({
          candidate_key: { type: 'string', pattern: '^[ifm][1-9][0-9]*$' },
          role: { type: 'string', enum: ['source', 'target', 'reference', 'style_reference', 'mask', 'compare_a', 'compare_b', 'attachment', 'context'] },
        }),
      },
      changes: { type: 'array', items: ROUTE_CHANGE_SCHEMA },
      constraints: { type: 'array', items: { type: 'string' } },
      clarification: strictObject({
        question: { type: 'string' },
        unresolved: {
          type: 'array',
          items: strictObject({
            type: { type: 'string', enum: ['image', 'file', 'text', 'message'] },
            role: { type: 'string', enum: ['source', 'target', 'reference', 'style_reference', 'mask', 'compare_a', 'compare_b', 'attachment', 'context'] },
            reason: { type: 'string', enum: ['missing', 'ambiguous', 'unavailable'] },
            candidate_keys: { type: 'array', items: { type: 'string', pattern: '^[ifm][1-9][0-9]*$' } },
          }),
        },
      }),
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      rationale: { type: 'string' },
    }),
  },
});
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

const preflightGuards = root?.ChatUICorePreflightGuards
  || root?.window?.ChatUICorePreflightGuards
  || (typeof require === 'function' ? require('../core/preflight-guards') : {});

function assertInputWithinUnifiedLimit(input = '') {
  const result = preflightGuards?.validateMessageSize?.(String(input || ''));
  if (!result || result.ok) return;
  const error = new RangeError(result.message || 'Message exceeds the configured input limit');
  error.code = result.code || 'message_too_many_characters';
  error.length = result.length;
  error.maxChars = result.maxChars;
  throw error;
}

function executionPrompt(input = '') {
  // The contract selects media and validates intent. It must not turn into model-facing patch text.
  assertInputWithinUnifiedLimit(input);
  const prompt = promptComposer?.composeExecutionPrompt?.(input);
  return typeof prompt === 'string' ? prompt : String(input || '').trim();
}

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

const ROUTE_DECISION_VERSION = 'route_decision.v1';
const ROUTE_OPERATIONS = new Set(['plain_chat', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr', 'text_to_image', 'image_reference_gen', 'edit_image']);
const ROUTE_RELATIONS = new Set(['new', 'followup', 'correction', 'continuation']);
const ROUTE_ROLES = new Set(['source', 'target', 'reference', 'style_reference', 'mask', 'compare_a', 'compare_b', 'attachment', 'context']);
const ROUTE_RESOURCE_TYPES = new Set(['image', 'file', 'text', 'message']);
const ROUTE_REASONS = new Set(['missing', 'ambiguous', 'unavailable']);
const ROUTE_CHANGES = new Set(['preserve', 'add', 'replace', 'remove']);
const ROUTE_DECISION_FIELDS = ['schema_version', 'readiness', 'operation', 'relation', 'bindings', 'changes', 'constraints', 'clarification', 'confidence', 'rationale'];
const OPERATIONS_BY_FIXED_MODE = Object.freeze({
  chat: new Set(['plain_chat', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr']),
  image: new Set(['text_to_image', 'image_reference_gen']),
  edit_image: new Set(['edit_image']),
});

function hasOnlyExactFields(value = {}, fields = []) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
}

function routeCandidateLabel(candidate = {}, raw = {}) {
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const unique = values => {
    const seen = new Set();
    return values.map(normalize).filter(value => {
      const fingerprint = value.toLocaleLowerCase();
      if (!value || seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    });
  };
  const filename = normalize(raw?.name || raw?.filename || candidate?.name || '');
  const descriptions = unique([
    raw?.description, raw?.semantic_description, raw?.semanticDescription,
    raw?.subject, raw?.label,
  ]);
  const labels = unique(Array.isArray(raw?.labels) ? raw.labels : []);
  const semanticParts = unique(String(raw?.semantic_text || '').split(/\s*\|\s*/));
  const promptParts = unique(String(raw?.prompt || '').split(/\s*\|\s*/));
  const preferred = candidate.type === 'file'
    ? [filename, ...descriptions]
    : [filename, ...descriptions, ...labels];
  const fallback = [...semanticParts, ...promptParts];
  const parts = unique((preferred.some(Boolean) ? preferred : fallback)).slice(0, 2);
  return (parts.join(' · ') || `${candidate.type || 'resource'} ${candidate.index || ''}`).slice(0, 120);
}

function routeCandidateSelectionText(candidate = {}, raw = {}) {
  const specific = [
    raw?.description, raw?.semantic_description, raw?.semanticDescription,
    raw?.subject, raw?.label,
    ...(Array.isArray(raw?.labels) ? raw.labels : []),
    raw?.name, raw?.filename,
  ].map(value => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const fallback = [raw?.semantic_text, raw?.prompt, candidate?.label]
    .map(value => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return (specific.length ? specific : fallback).join(' | ').slice(0, 720);
}

function buildRouteResourceCandidates({ attachments = [], context = {} } = {}) {
  const catalog = [];
  const addMedia = (type, prefix) => {
    const candidates = typeof intentContract?.mediaCandidates === 'function'
      ? intentContract.mediaCandidates(type, context, attachments)
      : [];
    const rawCandidates = Array.isArray(type === 'image' ? context?.image_candidates : context?.file_candidates)
      ? (type === 'image' ? context.image_candidates : context.file_candidates)
      : [];
    const rawAttachments = (Array.isArray(attachments) ? attachments : []).filter(item => {
      const mime = String(item?.type || item?.mime || '').toLowerCase();
      const isImage = item?.is_image === true || item?.isImage === true || mime.startsWith('image/');
      return (type === 'image') === isImage;
    });
    candidates.forEach((candidate, index) => {
      const contextualRaw = rawCandidates.find(item => {
        const id = String(type === 'image' ? item?.image_id || item?.imageId || '' : item?.file_id || item?.fileId || item?.id || '');
        const referenceId = String(item?.reference_id || item?.referenceId || '');
        return candidate.id && id === candidate.id
          || type === 'image' && candidate.referenceId && referenceId === candidate.referenceId && Number(item?.index) === Number(candidate.index)
          || Number(item?.index) === Number(candidate.index) && String(item?.source || '') === String(candidate.source || '');
      });
      const attachmentRaw = candidate.source === 'current' ? rawAttachments.find((item, attachmentIndex) => {
        const id = String(type === 'image'
          ? item?.image_id || item?.imageId || item?.id || item?.attachmentId || item?.attachment_id || ''
          : item?.file_id || item?.fileId || item?.id || item?.attachmentId || item?.attachment_id || '');
        const sourceIndex = Number(type === 'image'
          ? item?.media_index || item?.mediaIndex || item?.source_index || item?.sourceIndex
          : item?.source_index || item?.sourceIndex || item?.media_index || item?.mediaIndex) || attachmentIndex + 1;
        return candidate.id && id === candidate.id || sourceIndex === Number(candidate.sourceIndex);
      }) : null;
      const raw = contextualRaw || attachmentRaw || {};
      const catalogCandidate = {
        candidate_key: `${prefix}${index + 1}`,
        type,
        source: String(candidate.source || 'context'),
        index: Number(candidate.index),
        id: String(candidate.id || ''),
        reference_id: type === 'image' ? String(candidate.referenceId || '') : '',
        label: routeCandidateLabel({ ...candidate, type }, raw),
        filename: String(raw?.name || raw?.filename || candidate?.name || ''),
      };
      catalogCandidate.selection_text = routeCandidateSelectionText(catalogCandidate, raw);
      catalog.push(catalogCandidate);
    });
  };
  addMedia('image', 'i');
  addMedia('file', 'f');

  const quote = context?.quoted_message && typeof context.quoted_message === 'object' ? context.quoted_message : null;
  const quoteIndex = Number(quote?.index);
  const quoteId = messageIdentity(quote);
  const messages = typeof intentContract?.messageCandidates === 'function'
    ? intentContract.messageCandidates(context)
    : [];
  messages.forEach((candidate, index) => {
    const isQuote = Number.isInteger(quoteIndex)
      && quoteIndex >= 1
      && Number(candidate.index) === quoteIndex
      && (!quoteId || !candidate.id || String(candidate.id) === quoteId);
    const recent = (Array.isArray(context?.recent_messages) ? context.recent_messages : []).find(message => Number(message?.index) === Number(candidate.index));
    const raw = isQuote && quote ? { ...recent, ...quote } : recent || {};
    catalog.push({
      candidate_key: `m${index + 1}`,
      type: 'message',
      source: isQuote ? 'quoted' : 'history',
      index: Number(candidate.index),
      id: String(candidate.id || (isQuote ? quoteId : '')),
      reference_id: '',
      label: String(messageBody(raw) || `${candidate.role || 'message'} message ${candidate.index}`).replace(/\s+/g, ' ').slice(0, 240),
    });
  });
  return catalog;
}

function publicRouteResourceCandidates(catalog = []) {
  return catalog.map(candidate => ({
    candidate_key: candidate.candidate_key,
    type: candidate.type,
    source: candidate.source,
    label: candidate.label,
  }));
}

function explicitlyReferencesPriorText(input = '') {
  const text = String(input || '').trim();
  return /(?:这个|这段|上述|上面|前面|前文|刚才|之前|原来|上一(?:个|条|段)|同一)(?:的)?(?:描述|内容|文字|提示词|设定|方案|版本)?|(?:基于|根据|按照|沿用|延续|照着|参考)(?:这个|这段|上述|上面|前面|前文|刚才|之前|原来)|\b(?:this|that|above|earlier|previous|same)\s+(?:description|text|prompt|content|version)|\b(?:based on|according to|continue from|use)\s+(?:this|that|the above|the previous)\b/i.test(text);
}

function hasSelfContainedTextToImageSubject(input = '') {
  const text = String(input || '').trim();
  if (!text || explicitlyReferencesPriorText(text)) return false;
  const chinese = text.match(/(?:^|[，。！？,.!?\s])(?:请|帮我|给我)?(?:再|重新|另外|另)?(?:画|绘制|生成|创作|制作|做|来)\s*(?:一|1|两|2)?(?:张|幅|个|只|条|位|辆|件|座|朵|棵)?\s*([^，。！？,.!?]*)/);
  if (chinese) {
    const subject = chinese[1]
      .replace(/\s+/g, '')
      .replace(/(?:图片|图像|照片|画面|作品|版本|变体)/g, '')
      .replace(/(?:新的?|不同的?|类似的?|同样的?|高清|高质量|好看|漂亮)/g, '')
      .replace(/换(?:个|一种)?品种/g, '')
      .replace(/^(?:一个|一只|一条|一位|一辆|一件)/, '')
      .trim();
    if (subject && !/^[的地得]+$/.test(subject) && !/的$/.test(subject)) return true;
  }
  const english = text.match(/\b(?:draw|generate|create|make|render)\s+(?:another|a|an|one|new)?\s*([^,.!?]*)/i);
  if (!english) return false;
  const subject = english[1]
    .replace(/\b(?:image|picture|photo|artwork|version|variant|another|new|different|similar|same|high[- ]quality|beautiful|of|a|an|the)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return !!subject;
}

function hasRouteDecisionShape(value = {}, { allowIncompleteChanges = false } = {}) {
  if (!hasOnlyExactFields(value, ROUTE_DECISION_FIELDS)
      || value.schema_version !== ROUTE_DECISION_VERSION
      || !['ready', 'needs_clarification'].includes(value.readiness)
      || !ROUTE_OPERATIONS.has(value.operation)
      || !ROUTE_RELATIONS.has(value.relation)
      || !Array.isArray(value.bindings)
      || !Array.isArray(value.changes)
      || !Array.isArray(value.constraints)
      || !hasOnlyExactFields(value.clarification, ['question', 'unresolved'])
      || typeof value.clarification.question !== 'string'
      || !Array.isArray(value.clarification.unresolved)
      || !Number.isFinite(value.confidence)
      || value.confidence < 0
      || value.confidence > 1
      || typeof value.rationale !== 'string') return false;
  if (value.bindings.some(binding => !hasOnlyExactFields(binding, ['candidate_key', 'role'])
      || !/^[ifm][1-9]\d*$/.test(binding.candidate_key)
      || !ROUTE_ROLES.has(binding.role))) return false;
  if (value.changes.some(change => {
    if (!hasOnlyExactFields(change, ['op', 'target', 'value'])
        || !ROUTE_CHANGES.has(change.op)
        || typeof change.target !== 'string'
        || typeof change.value !== 'string') return true;
    if (['add', 'replace'].includes(change.op)) {
      return !allowIncompleteChanges && (!change.target.trim() || !change.value.trim());
    }
    return !change.target.trim() || change.value !== '';
  })) return false;
  if (value.constraints.some(constraint => typeof constraint !== 'string' || !constraint.trim())) return false;
  return !value.clarification.unresolved.some(slot => !hasOnlyExactFields(slot, ['type', 'role', 'reason', 'candidate_keys'])
    || !ROUTE_RESOURCE_TYPES.has(slot.type)
    || !ROUTE_ROLES.has(slot.role)
    || !ROUTE_REASONS.has(slot.reason)
    || !Array.isArray(slot.candidate_keys)
    || slot.candidate_keys.some(key => typeof key !== 'string' || !/^[ifm][1-9]\d*$/.test(key)));
}

function hasExactRouteDecision(value = {}) {
  return hasRouteDecisionShape(value);
}

function roleMatchesCandidate(type = '', role = '') {
  if (type === 'file') return role === 'attachment';
  if (type === 'message') return role === 'context';
  if (type === 'text') return role === 'source';
  return type === 'image' && ['source', 'target', 'reference', 'style_reference', 'mask', 'compare_a', 'compare_b'].includes(role);
}

function operationAllowedByProductMode(operation = '', currentMode = 'chat', autoMode = true) {
  if (autoMode !== false) return true;
  const allowed = OPERATIONS_BY_FIXED_MODE[String(currentMode || 'chat')] || OPERATIONS_BY_FIXED_MODE.chat;
  return allowed.has(operation);
}

const SELECTION_ENGLISH_STOP_WORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'image', 'images', 'picture', 'pictures', 'photo', 'photos',
  'please', 'change', 'modify', 'edit', 'replace', 'make', 'turn', 'into', 'color', 'colour', 'background',
  'with', 'from', 'and', 'all', 'one', 'some', 'again', 'want', 'use', 'using', 'based', 'reference',
]);
const SELECTION_CJK_STOP_CHARS = new Set('把将请帮给让对这那张幅个只一下的了着并和与及图片照片相进行修改编辑改变替换换改成变为颜色色彩背景上中里要想需要使用基于按照参考生成新重新全部所有都处理调整'.split(''));
const SELECTION_SUBJECT_ALIASES = [
  ['subject:dog', /狗|犬|\b(?:dog|dogs|puppy|puppies)\b/i],
  ['subject:cat', /猫|\b(?:cat|cats|kitten|kittens)\b/i],
  ['subject:fish', /鱼|\b(?:fish|fishes)\b/i],
  ['subject:bird', /鸟|\b(?:bird|birds)\b/i],
  ['subject:person', /人物|人像|\b(?:person|people|human|portrait)\b/i],
  ['subject:car', /汽车|车辆|轿车|\b(?:car|cars|vehicle|vehicles)\b/i],
  ['subject:product', /产品|商品|\b(?:product|products|item|items)\b/i],
];

function imageSelectionTokens(text = '') {
  const value = String(text || '').toLowerCase();
  const tokens = new Set();
  for (const word of value.match(/[a-z0-9]+/g) || []) {
    if (word.length >= 2 && !SELECTION_ENGLISH_STOP_WORDS.has(word) && !/^\d+$/.test(word)) tokens.add(word);
  }
  for (const char of value.match(/[\u3400-\u9fff]/g) || []) {
    if (!SELECTION_CJK_STOP_CHARS.has(char)) tokens.add(char);
  }
  for (const [token, pattern] of SELECTION_SUBJECT_ALIASES) if (pattern.test(value)) tokens.add(token);
  return tokens;
}

function chineseOrdinalNumber(value = '') {
  const text = String(value || '');
  if (/^\d+$/.test(text)) return Number(text);
  const digits = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  if (text === '十') return 10;
  if (text.startsWith('十') && digits[text[1]]) return 10 + digits[text[1]];
  if (text.endsWith('十') && digits[text[0]]) return digits[text[0]] * 10;
  if (text.includes('十') && digits[text[0]] && digits[text[2]]) return digits[text[0]] * 10 + digits[text[2]];
  return digits[text] || 0;
}

function explicitImageOrdinal(input = '') {
  const text = String(input || '');
  const chinese = text.match(/第\s*([一二两三四五六七八九十\d]+)\s*(?:张|幅|个)?(?:图片|图像|照片|图)?/);
  if (chinese) return chineseOrdinalNumber(chinese[1]);
  const numbered = text.match(/(?:图片|图像|照片|图)\s*(?:第|编号|号码|no\.?|#)?\s*(\d+)\s*(?:号|张)?/i);
  if (numbered) return Number(numbered[1]);
  const english = text.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:image|picture|photo)\b/i);
  if (english) return ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'].indexOf(english[1].toLowerCase()) + 1;
  return 0;
}

function candidateConfirmedByClarification(candidate = {}, context = {}) {
  const selected = Array.isArray(context?.clarification_context?.selected_choices)
    ? context.clarification_context.selected_choices
    : [];
  return selected.some(choice => {
    const id = String(choice?.id || choice?.image_id || '');
    const referenceId = String(choice?.reference_id || '');
    return candidate.id && id === candidate.id
      || candidate.reference_id && referenceId === candidate.reference_id && (!id || id === candidate.id);
  });
}

function hasExplicitImageSelection(candidate = {}, catalog = [], options = {}) {
  if (candidate.source === 'quoted' || candidateConfirmedByClarification(candidate, options.context || {})) return true;
  const currentImages = catalog.filter(item => item.type === 'image' && item.source === 'current');
  if (candidate.source === 'current' && currentImages.length === 1) return true;
  const ordinal = explicitImageOrdinal(options.input || '');
  if (ordinal > 0 && candidate.candidate_key === `i${ordinal}`) return true;
  if (/上一张|刚才(?:那|这)?张|最新(?:的)?(?:图片|图|照片)/.test(String(options.input || '')) && candidate.candidate_key === 'i1') return true;
  const filename = String(candidate.filename || '').trim().toLowerCase();
  return filename.length >= 3 && String(options.input || '').toLowerCase().includes(filename);
}

function ambiguousReadyEditTarget(decision = {}, catalog = [], options = {}) {
  if (decision.readiness !== 'ready' || decision.operation !== 'edit_image') return null;
  const targetBindings = decision.bindings.filter(binding => binding.role === 'target');
  const images = catalog.filter(candidate => candidate.type === 'image');
  if (targetBindings.length > 1) {
    const selectedTargets = targetBindings
      .map(binding => images.find(candidate => candidate.candidate_key === binding.candidate_key))
      .filter(Boolean);
    return selectedTargets.length > 1
      ? [...new Map(selectedTargets.map(candidate => [candidate.candidate_key, candidate])).values()]
      : null;
  }
  if (targetBindings.length !== 1) return null;
  if (images.length < 2) return null;
  const selected = images.find(candidate => candidate.candidate_key === targetBindings[0].candidate_key);
  if (!selected || hasExplicitImageSelection(selected, catalog, options)) return null;

  const queryTokens = imageSelectionTokens(options.input || '');
  const scored = images.map(candidate => {
    const candidateTokens = imageSelectionTokens(candidate.selection_text || candidate.label || '');
    let score = 0;
    for (const token of queryTokens) if (candidateTokens.has(token)) score += 1;
    return { candidate, score };
  });
  const selectedScore = scored.find(item => item.candidate.candidate_key === selected.candidate_key)?.score || 0;
  let contenders = selectedScore > 0
    ? scored.filter(item => item.score >= selectedScore && item.score > 0).map(item => item.candidate)
    : [];
  const genericDeictic = /(?:这|那|上一|刚才|当前).{0,4}(?:图片|图|照片)|\b(?:this|that|current|previous)\s+(?:image|picture|photo)\b/i.test(String(options.input || ''));
  if (contenders.length < 2 && (selectedScore === 0 || genericDeictic)) contenders = images;
  if (contenders.length < 2) return null;
  if (!contenders.some(candidate => candidate.candidate_key === selected.candidate_key)) contenders.unshift(selected);
  return [...new Map(contenders.map(candidate => [candidate.candidate_key, candidate])).values()];
}

function applyDeterministicRouteSafety(decision = {}, catalog = [], options = {}) {
  const ambiguousTargets = ambiguousReadyEditTarget(decision, catalog, options);
  if (!ambiguousTargets) return { decision, reviewReasons: [] };
  const ambiguousKeys = new Set(ambiguousTargets.map(candidate => candidate.candidate_key));
  return {
    decision: {
      ...decision,
      readiness: 'needs_clarification',
      bindings: decision.bindings.filter(binding => binding.role !== 'target' || !ambiguousKeys.has(binding.candidate_key)),
      clarification: {
        question: '检测到多张可能符合描述的图片。请选择要修改的其中一张。',
        unresolved: [{ type: 'image', role: 'target', reason: 'ambiguous', candidate_keys: ambiguousTargets.map(candidate => candidate.candidate_key) }],
      },
      confidence: Math.min(decision.confidence, 0.7),
      rationale: '应用检测到单一编辑目标缺少可验证的选择依据。',
    },
    reviewReasons: ['ambiguous_target_selection'],
  };
}

function missingChangeDetailQuestion(changes = []) {
  const targets = [...new Set(changes
    .map(change => String(change?.target || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean))];
  if (targets.some(target => /颜色|色彩|\bcolou?r\b/i.test(target))) {
    return '请补充目标颜色（例如黑色、白色），或说明想要的具体效果。';
  }
  if (targets.length === 1) return `请补充“${targets[0].slice(0, 80)}”的具体目标值或效果。`;
  return '请补充要修改的对象以及具体目标值或效果。';
}

function applyMissingChangeDetailSafety(decision = {}) {
  if (!hasRouteDecisionShape(decision, { allowIncompleteChanges: true })) {
    return { decision, reviewReasons: [] };
  }
  const incomplete = decision.changes.filter(change => ['add', 'replace'].includes(change.op)
    && (!change.target.trim() || !change.value.trim()));
  if (!incomplete.length) return { decision, reviewReasons: [] };
  const unresolved = Array.isArray(decision.clarification?.unresolved)
    ? decision.clarification.unresolved.map(slot => ({ ...slot, candidate_keys: [...slot.candidate_keys] }))
    : [];
  if (!unresolved.some(slot => slot.type === 'text' && slot.role === 'source' && slot.reason === 'missing')) {
    unresolved.push({ type: 'text', role: 'source', reason: 'missing', candidate_keys: [] });
  }
  const existingQuestion = String(decision.clarification?.question || '').trim();
  const detailQuestion = missingChangeDetailQuestion(incomplete);
  const questionAlreadyRequestsDetail = /目标颜色|具体目标|具体效果|改成什么/.test(existingQuestion);
  return {
    decision: {
      ...decision,
      readiness: 'needs_clarification',
      changes: decision.changes.filter(change => !incomplete.includes(change)),
      clarification: {
        question: existingQuestion
          ? questionAlreadyRequestsDetail ? existingQuestion : `${existingQuestion}\n${detailQuestion}`
          : detailQuestion,
        unresolved,
      },
      confidence: Math.min(decision.confidence, 0.7),
    },
    reviewReasons: ['missing_change_detail'],
  };
}

function applyTextToImageHistoryBindingSafety(decision = {}, catalog = [], options = {}) {
  if (decision.readiness !== 'ready'
      || decision.operation !== 'text_to_image'
      || !hasSelfContainedTextToImageSubject(options.input || '')) {
    return { decision, reviewReasons: [] };
  }
  const redundantKeys = new Set(catalog
    .filter(candidate => candidate.type === 'message' && candidate.source === 'history')
    .map(candidate => candidate.candidate_key));
  const bindings = decision.bindings.filter(binding => !redundantKeys.has(binding.candidate_key));
  if (bindings.length === decision.bindings.length) return { decision, reviewReasons: [] };
  return {
    decision: { ...decision, bindings },
    reviewReasons: ['redundant_history_text_binding'],
  };
}

function compileRouteDecision(decision = {}, options = {}) {
  if (!hasRouteDecisionShape(decision, { allowIncompleteChanges: true })) throw new TypeError('Invalid route_decision.v1 shape');
  const compilerContext = compactRoutePayloadContext(options.context || {}, options.input || '', options.attachments || []);
  const catalog = buildRouteResourceCandidates({ attachments: options.attachments || [], context: compilerContext });
  const textBindingSafety = applyTextToImageHistoryBindingSafety(decision, catalog, { ...options, context: compilerContext });
  const selectionSafety = applyDeterministicRouteSafety(textBindingSafety.decision, catalog, { ...options, context: compilerContext });
  const detailSafety = applyMissingChangeDetailSafety(selectionSafety.decision);
  const effectiveDecision = detailSafety.decision;
  if (!hasExactRouteDecision(effectiveDecision)) throw new TypeError('Invalid route_decision.v1 shape');
  const candidates = new Map(catalog.map(candidate => [candidate.candidate_key, candidate]));
  const usedCandidateKeys = new Set();
  const resources = effectiveDecision.bindings.map((binding, index) => {
    const candidate = candidates.get(binding.candidate_key);
    if (!candidate || usedCandidateKeys.has(binding.candidate_key) || !roleMatchesCandidate(candidate.type, binding.role)) {
      throw new TypeError(`Invalid route binding: ${binding.candidate_key}`);
    }
    usedCandidateKeys.add(binding.candidate_key);
    return {
      key: `r${index + 1}`,
      type: candidate.type,
      source: candidate.source,
      role: binding.role,
      index: candidate.index,
      id: candidate.id,
      reference_id: candidate.reference_id,
      missing: false,
    };
  });

  let nextResourceNumber = resources.length + 1;
  const unresolvedResources = effectiveDecision.clarification.unresolved.map(slot => {
    const keys = [...new Set(slot.candidate_keys)];
    if (keys.length !== slot.candidate_keys.length
        || slot.reason === 'ambiguous' && keys.length < 2
        || slot.reason !== 'ambiguous' && keys.length !== 0
        || !roleMatchesCandidate(slot.type, slot.role)) throw new TypeError('Invalid unresolved route slot');
    const choices = keys.map((key, index) => {
      const candidate = candidates.get(key);
      if (!candidate || candidate.type !== slot.type || usedCandidateKeys.has(key)) throw new TypeError(`Invalid clarification candidate: ${key}`);
      return {
        key: `c${index + 1}`,
        source: candidate.source,
        index: candidate.index,
        id: candidate.id,
        reference_id: candidate.reference_id,
        label: candidate.label,
      };
    });
    return {
      key: `r${nextResourceNumber++}`,
      type: slot.type,
      role: slot.role,
      reason: slot.reason,
      choices,
    };
  });

  if (effectiveDecision.readiness === 'ready' && (effectiveDecision.clarification.question || unresolvedResources.length)
      || effectiveDecision.readiness === 'needs_clarification' && (!effectiveDecision.clarification.question.trim() || !unresolvedResources.length)) {
    throw new TypeError('Decision readiness and clarification disagree');
  }

  const operationRequiresPatch = ['edit_image', 'image_reference_gen'].includes(effectiveDecision.operation);
  const historicalResources = resources.filter(resource => ['quoted', 'history', 'context'].includes(resource.source));
  const unresolvedNeedsBaseline = effectiveDecision.readiness === 'needs_clarification'
    && effectiveDecision.relation !== 'new'
    && unresolvedResources.some(slot => slot.type !== 'text');
  const mode = operationRequiresPatch || historicalResources.length || unresolvedNeedsBaseline ? 'patch' : 'standalone';
  const baselineKeys = [];
  for (const resource of resources) {
    if (resource.type === 'text') continue;
    if (operationRequiresPatch && resource.type === 'image' || ['quoted', 'history', 'context'].includes(resource.source)) baselineKeys.push(resource.key);
  }
  if (mode === 'patch' && effectiveDecision.readiness === 'needs_clarification') {
    for (const slot of unresolvedResources) if (slot.type !== 'text') baselineKeys.push(slot.key);
  }

  const taskContract = {
    schema_version: 'task_contract.v5',
    readiness: effectiveDecision.readiness,
    operation: effectiveDecision.operation,
    relation: effectiveDecision.relation,
    resources,
    directive: {
      mode,
      base_resource_keys: [...new Set(baselineKeys)],
      unmentioned_policy: mode === 'patch' ? 'preserve' : 'allow_change',
      operations: effectiveDecision.changes.map(change => ({ ...change })),
      constraints: effectiveDecision.constraints.map(constraint => String(constraint)),
    },
    clarification: {
      question: effectiveDecision.clarification.question,
      unresolved_resources: unresolvedResources,
    },
    confidence: effectiveDecision.confidence,
    review_reasons: [...new Set([...textBindingSafety.reviewReasons, ...selectionSafety.reviewReasons, ...detailSafety.reviewReasons])],
    rationale: effectiveDecision.rationale,
  };
  return taskContract;
}

function sortedSignatures(values = []) {
  return values.map(value => JSON.stringify(value)).sort();
}

function repairInvariantSnapshot(value = '') {
  try {
    if (typeof value === 'string' && value.length > MAX_ROUTE_REPAIR_OUTPUT_CHARS) return null;
    const raw = typeof value === 'string' ? JSON.parse(stripJsonFence(value)) : value;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.schema_version === ROUTE_DECISION_VERSION) {
      if (!ROUTE_OPERATIONS.has(raw.operation)
          || !ROUTE_RELATIONS.has(raw.relation)
          || !['ready', 'needs_clarification'].includes(raw.readiness)
          || !Array.isArray(raw.bindings)
          || !Array.isArray(raw.changes)
          || !Array.isArray(raw.constraints)
          || typeof raw.clarification?.question !== 'string'
          || !Array.isArray(raw.clarification?.unresolved)) return null;
      const bindings = raw.bindings.map(binding => {
        const candidateKey = String(binding?.candidate_key || '');
        const role = String(binding?.role || '');
        if (!/^[ifm][1-9]\d*$/.test(candidateKey) || !ROUTE_ROLES.has(role)) throw new TypeError('incomplete binding invariant');
        return { candidate_key: candidateKey, role };
      });
      const unresolved = raw.clarification.unresolved.map(slot => {
        const type = String(slot?.type || '');
        const role = String(slot?.role || '');
        const reason = String(slot?.reason || '');
        if (!ROUTE_RESOURCE_TYPES.has(type) || !ROUTE_ROLES.has(role) || !ROUTE_REASONS.has(reason) || !Array.isArray(slot?.candidate_keys)) {
          throw new TypeError('incomplete unresolved invariant');
        }
        const candidateKeys = slot.candidate_keys.map(key => String(key || '')).sort();
        if (candidateKeys.some(key => !/^[ifm][1-9]\d*$/.test(key))) throw new TypeError('incomplete unresolved candidates');
        return { type, role, reason, candidate_keys: candidateKeys };
      });
      const changes = raw.changes.map(change => {
        const op = String(change?.op || '');
        if (!ROUTE_CHANGES.has(op) || typeof change?.target !== 'string' || typeof change?.value !== 'string') {
          throw new TypeError('incomplete change invariant');
        }
        return { op, target: change.target, value: change.value };
      });
      const constraints = raw.constraints.map(constraint => {
        if (typeof constraint !== 'string') throw new TypeError('incomplete constraint invariant');
        return constraint;
      });
      return Object.freeze({
        protocol: ROUTE_DECISION_VERSION,
        operation: raw.operation,
        relation: raw.relation,
        readiness: raw.readiness,
        resource_count: bindings.length,
        resources: sortedSignatures(bindings),
        changes,
        constraints,
        clarification_question: raw.clarification.question,
        unresolved_count: unresolved.length,
        unresolved: sortedSignatures(unresolved),
      });
    }
    if (raw.schema_version !== 'task_contract.v5'
        || !Object.prototype.hasOwnProperty.call(raw, 'readiness')) return null;
    const task = raw;
    const operation = String(task?.operation || '');
    const relation = String(task?.relation || '');
    const readiness = task?.readiness;
    if (!['plain_chat', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr', 'text_to_image', 'image_reference_gen', 'edit_image'].includes(operation)
        || !['new', 'followup', 'correction', 'continuation'].includes(relation)
        || !['ready', 'needs_clarification'].includes(readiness)
        || !Array.isArray(task.resources)
        || !Array.isArray(task.clarification?.unresolved_resources)) return null;
    const resources = task.resources.map(resource => {
      const type = String(resource?.type || '');
      const source = String(resource?.source || '');
      const role = String(resource?.role || '');
      if (!type || !['current', 'quoted', 'history', 'context'].includes(source) || !role) throw new TypeError('incomplete resource invariant');
      return { type, source, role };
    });
    const unresolved = task.clarification.unresolved_resources.map(slot => {
      const type = String(slot?.type || '');
      const role = String(slot?.role || '');
      const reason = String(slot?.reason || '');
      if (!type || !role || !['missing', 'ambiguous', 'unavailable'].includes(reason) || !Array.isArray(slot?.choices)) throw new TypeError('incomplete unresolved invariant');
      const choiceSources = slot.choices.map(choice => {
        const source = String(choice?.source || '');
        if (!['current', 'quoted', 'history', 'context'].includes(source)) throw new TypeError('incomplete choice invariant');
        return source;
      }).sort();
      return { type, role, reason, choice_count: slot.choices.length, choice_sources: choiceSources };
    });
    return Object.freeze({
      protocol: 'task_contract.v5',
      operation,
      relation,
      readiness,
      resource_count: resources.length,
      resources: sortedSignatures(resources),
      unresolved_count: unresolved.length,
      unresolved: sortedSignatures(unresolved),
    });
  } catch {
    return null;
  }
}

function repairPreservesInvariants(invariants = null, repairedValue = null) {
  if (!invariants || !repairedValue) return false;
  const candidate = invariants.protocol === ROUTE_DECISION_VERSION
    ? repairedValue?.routeDecision || repairedValue
    : repairedValue?.taskContract || repairedValue;
  const repaired = repairInvariantSnapshot(candidate);
  if (!repaired) return false;
  return repaired.protocol === invariants.protocol
    && repaired.operation === invariants.operation
    && repaired.relation === invariants.relation
    && repaired.readiness === invariants.readiness
    && repaired.resource_count === invariants.resource_count
    && repaired.unresolved_count === invariants.unresolved_count
    && JSON.stringify(repaired.resources) === JSON.stringify(invariants.resources)
    && JSON.stringify(repaired.changes || []) === JSON.stringify(invariants.changes || [])
    && JSON.stringify(repaired.constraints || []) === JSON.stringify(invariants.constraints || [])
    && String(repaired.clarification_question || '') === String(invariants.clarification_question || '')
    && JSON.stringify(repaired.unresolved) === JSON.stringify(invariants.unresolved);
}

function routeReadiness(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  if (value.readiness === 'ready' || value.readiness === 'needs_clarification') return value.readiness;
  const clarification = value.clarification;
  const declaresClarification = value.operation === 'clarify'
    || typeof clarification?.question === 'string' && !!clarification.question.trim()
    || typeof clarification?.resume_operation === 'string' && !!clarification.resume_operation.trim()
    || Array.isArray(clarification?.unresolved_resources) && clarification.unresolved_resources.length > 0;
  return declaresClarification ? 'needs_clarification' : 'ready';
}

function decodeTaskContract(value = {}) {
  return typeof intentContract?.normalizeContractVersion === 'function'
    ? intentContract.normalizeContractVersion(value)
    : value;
}

function readRouteReadiness(text = '') {
  try {
    return routeReadiness(JSON.parse(stripJsonFence(text)));
  } catch {
    return '';
  }
}

function mergeRouteReadinessRequirement(...values) {
  const readiness = values.filter(value => value === 'ready' || value === 'needs_clarification');
  if (readiness.includes('needs_clarification')) return 'needs_clarification';
  return readiness.includes('ready') ? 'ready' : '';
}

function routePlanReadiness(route = {}) {
  if (route?.taskContract) {
    const contractReadiness = routeReadiness(decodeTaskContract(route.taskContract));
    if (contractReadiness) return contractReadiness;
  }
  if (route?.needClarification === true || route?.api === 'clarify') return 'needs_clarification';
  return route && typeof route === 'object' ? 'ready' : '';
}

function routeSatisfiesReadiness(route = {}, requiredReadiness = '') {
  if (requiredReadiness !== 'needs_clarification') return !!route;
  return routePlanReadiness(route) === 'needs_clarification';
}

const EXECUTION_RESOURCES_VERSION = 'execution_resources.v1';

function orderedResourceKeys(resources = []) {
  return Array.isArray(resources) ? resources.map(resource => String(resource?.key || '')) : null;
}

function sameOrderedResourceKeys(actual = [], expected = []) {
  const actualKeys = orderedResourceKeys(actual);
  const expectedKeys = orderedResourceKeys(expected);
  return !!actualKeys
    && !!expectedKeys
    && actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key && key === expectedKeys[index]);
}

function projectedResourceMatchesContract(resource = {}, expected = {}, type = '') {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return false;
  if (resource.type !== type || resource.key !== expected.key) return false;
  if (resource.source !== expected.source || (type !== 'message' && resource.role !== expected.role)) return false;
  if (!Number.isInteger(Number(resource.index)) || Number(resource.index) < 1) return false;
  if (String(resource.id || '') !== String(expected.id || '')) return false;
  if (String(resource.reference_id || '') !== String(expected.reference_id || '')) return false;
  if (!Array.isArray(resource.identity_aliases) || resource.identity_aliases.some(value => typeof value !== 'string')) return false;
  if (!Array.isArray(resource.index_aliases) || resource.index_aliases.some(value => !Number.isInteger(Number(value)) || Number(value) < 1)) return false;
  return true;
}

function projectedResourceMatchesRouteRef(resource = {}, routeRef = {}, type = '') {
  if (!resource || !routeRef || resource.key !== routeRef.key || resource.role !== routeRef.role || resource.source !== routeRef.source) return false;
  const routeId = type === 'image' ? routeRef.image_id : type === 'file' ? routeRef.file_id : routeRef.message_id;
  const routeReferenceId = type === 'image' ? routeRef.reference_id : '';
  return String(resource.id || '') === String(routeId || '')
    && String(resource.reference_id || '') === String(routeReferenceId || '')
    && Number(resource.index) === Number(routeRef.index);
}

function hasConsistentExecutionResources(route = {}, task = {}, expectedApi = '') {
  const projection = route.executionResources;
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) return false;
  if (projection.version !== EXECUTION_RESOURCES_VERSION
      || projection.operation !== task.operation
      || projection.api !== expectedApi
      || projection.relation !== task.relation) return false;

  const expectedImages = task.resources.filter(resource => resource.type === 'image');
  const expectedFiles = task.resources.filter(resource => resource.type === 'file');
  const expectedMessages = task.resources.filter(resource => resource.type === 'message');
  const images = projection.images;
  const files = projection.files;
  const messages = projection.messages;
  if (!Array.isArray(images) || !Array.isArray(files) || !Array.isArray(messages)) return false;
  if (!sameOrderedResourceKeys(images, expectedImages)
      || !sameOrderedResourceKeys(files, expectedFiles)
      || !sameOrderedResourceKeys(messages, expectedMessages)) return false;
  if (images.some((resource, index) => !projectedResourceMatchesContract(resource, expectedImages[index], 'image'))) return false;
  if (files.some((resource, index) => !projectedResourceMatchesContract(resource, expectedFiles[index], 'file'))) return false;
  if (messages.some((resource, index) => !projectedResourceMatchesContract(resource, expectedMessages[index], 'message'))) return false;

  const routeImageRefs = Array.isArray(route.imageRefs) ? route.imageRefs : null;
  const routeFileRefs = Array.isArray(route.fileRefs) ? route.fileRefs : null;
  const routeMessageRefs = Array.isArray(route.messageRefs) ? route.messageRefs : null;
  if (!sameOrderedResourceKeys(routeImageRefs, images)
      || !sameOrderedResourceKeys(routeFileRefs, files)
      || !sameOrderedResourceKeys(routeMessageRefs, messages)) return false;
  if (images.some((resource, index) => !projectedResourceMatchesRouteRef(resource, routeImageRefs[index], 'image'))) return false;
  if (files.some((resource, index) => !projectedResourceMatchesRouteRef(resource, routeFileRefs[index], 'file'))) return false;
  if (messages.some((resource, index) => !projectedResourceMatchesRouteRef(resource, routeMessageRefs[index], 'message'))) return false;

  const targets = images.filter(resource => resource.role === 'target');
  const masks = images.filter(resource => resource.role === 'mask');
  const references = images.filter(resource => ['reference', 'style_reference'].includes(resource.role));
  const imageInputs = [...targets, ...references];
  return sameOrderedResourceKeys(projection.targets, targets)
    && sameOrderedResourceKeys(projection.masks, masks)
    && sameOrderedResourceKeys(projection.references, references)
    && sameOrderedResourceKeys(projection.imageInputs, imageInputs)
    && sameOrderedResourceKeys(projection.chatImages, images)
    && sameOrderedResourceKeys(projection.chatFiles, files)
    && sameOrderedResourceKeys(projection.selectedMessageRefs, messages);
}

function isRouteDispatchable(route = {}) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) return false;
  if (route.needClarification === true || route.api === 'clarify' || route.dispatchAuthorized !== true) return false;
  const task = route.taskContract;
  if (!task || task.schema_version !== 'task_contract.v5') return false;
  if (!intentContract?.hasExactContractShape?.(task) || task.readiness !== 'ready' || route.readiness !== 'ready') return false;
  const expectedApi = intentContract?.contractApi?.(task) || '';
  if (!expectedApi || route.api !== expectedApi || route.operationApi !== expectedApi) return false;
  if (route.operationType !== task.operation || route.relation !== task.relation) return false;
  const expectedMode = intentContract?.contractMode?.(task) || '';
  if (!expectedMode || route.operationMode !== expectedMode) return false;
  return route.mode === expectedMode && hasConsistentExecutionResources(route, task, expectedApi);
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
  let next = { ...route, taskContract };
  if (taskContract.operation === 'text_to_image') {
    next = { ...next, contextualImagePrompt: composeTextToImagePrompt(input, taskContract, options.context || {}) };
  } else if (taskContract.operation === 'image_reference_gen') {
    next = { ...next, editInstruction: executionPrompt(input) };
  } else if (taskContract.operation === 'edit_image') {
    next = { ...next, editInstruction: executionPrompt(input) };
  }
  return next;
}

function messageIdentity(message = {}) {
  return String(
    message?.display_item_id
    || message?.displayItemId
    || message?.id
    || message?.message_id
    || message?.messageId
    || ''
  );
}

function messageBody(message = {}) {
  const raw = Array.isArray(message?.content)
    ? message?.rawText || ''
    : message?.content || message?.rawText || '';
  const text = cleanQuotedContent(String(raw || '').trim())
    .replace(/\[quoted_image[^\]]*\]/gi, '')
    .replace(/\[quoted_message\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // This is the compact-context sentinel, not user-authored prompt text.
  return /^\[quoted_message\]$/i.test(text) ? '' : text;
}

function boundMessageBody(resource = {}, context = {}) {
  if (resource?.type !== 'message' || resource?.missing) return '';
  if (typeof intentContract?.resolveMessageResource === 'function'
      && !intentContract.resolveMessageResource(resource, { context })) return '';
  const recent = Array.isArray(context?.recent_messages) ? context.recent_messages : [];
  const index = Number(resource.index);
  const id = String(resource.id || '');
  const quote = context?.quoted_message && typeof context.quoted_message === 'object'
    ? context.quoted_message
    : null;
  const quoteIndex = Number(quote?.index);
  const quoteId = messageIdentity(quote);

  // Prefer the explicitly selected message object whenever the binding points
  // at it. This applies to both source=quoted and the equivalent source=history
  // representation emitted by some route models, and keeps a quote binding
  // independent from whichever compact history slot carries its text.
  if (Number.isInteger(quoteIndex)
      && quoteIndex === index
      && (!id || !quoteId || id === quoteId)) {
    const quotedText = messageBody(quote);
    if (quotedText) return quotedText;
  }

  const matches = recent.filter(message => {
    const candidateIndex = Number(message?.index);
    if (candidateIndex !== index) return false;
    // compact quoted route contexts may carry the quote id in
    // `quoted_message` while omitting it from the corresponding history row;
    // mirror intent-contract.messageCandidates' exact index-scoped fallback.
    const candidateId = messageIdentity(message)
      || (candidateIndex === quoteIndex ? quoteId : '');
    return !id || candidateId === id;
  });
  if (matches.length !== 1) return '';
  return messageBody(matches[0]);
}

/**
 * Compose the execution prompt for a text-to-image contract that explicitly
 * binds one or more historical/quoted messages. The router contract selects
 * the message; this helper only copies the already-bound message text into the
 * image prompt and then appends the user's current instruction.
 */
function composeTextToImagePrompt(input = '', taskContract = {}, context = {}) {
  const currentPrompt = executionPrompt(input);
  if (taskContract?.operation !== 'text_to_image' || !Array.isArray(taskContract?.resources)) return currentPrompt;
  const messageResources = taskContract.resources
    .filter(resource => resource?.type === 'message' && !resource.missing);
  const quote = context?.quoted_message && typeof context.quoted_message === 'object' ? context.quoted_message : null;
  const quoteIndex = Number(quote?.index);
  const quoteId = String(messageIdentity(quote || {}));
  const hasExplicitQuoteBinding = messageResources.some(resource => resource.source === 'quoted'
    || quote && Number(resource.index) === quoteIndex && (!quoteId || String(resource.id || '') === quoteId));
  if (messageResources.length && !hasExplicitQuoteBinding && hasSelfContainedTextToImageSubject(currentPrompt)) {
    return currentPrompt;
  }
  const seen = new Set(currentPrompt ? [currentPrompt] : []);
  const boundBodies = messageResources
    .map(resource => boundMessageBody(resource, context))
    .filter(Boolean);
  if (messageResources.length && !boundBodies.length) {
    throw new TypeError('Bound message resource has no usable text');
  }
  const messagePrompts = boundBodies
    .filter(text => !seen.has(text) && seen.add(text));
  if (!messagePrompts.length) return currentPrompt;
  const separator = currentPrompt ? '\n\n' : '';
  const referencePrompt = messagePrompts.join('\n\n').trimEnd();
  if (!referencePrompt) return currentPrompt;
  return executionPrompt(`${referencePrompt}${separator}${currentPrompt}`);
}

function isTaskContractResult(value = {}) {
  return typeof intentContract.hasExactContractShape === 'function'
    && intentContract.hasExactContractShape(decodeTaskContract(value));
}

function isClarificationCandidate(text = '') {
  return readRouteReadiness(text) === 'needs_clarification';
}

function bindExplicitQuotedMessage(task = {}, context = {}) {
  const quote = context?.quoted_message;
  if (!quote || typeof quote !== 'object') return task;
  // An explicit UI quote is already an unambiguous, user-selected message.
  // It is protocol data rather than a model inference for plain_chat. Image
  // generation must declare its message resource in the first contract and is
  // never repaired by appending quoted prompt context here.
  if (task?.operation !== 'plain_chat' || !Array.isArray(task?.resources)) return task;
  const directive = task?.directive;
  if (!directive || !Array.isArray(directive.base_resource_keys) || !Array.isArray(directive.operations) || !Array.isArray(directive.constraints)) return task;
  const index = Number(quote.index);
  if (!Number.isInteger(index) || index < 1) return task;
  const resources = [...task.resources];
  const allowedRoles = ['context'];
  const bound = resources.find(resource => resource?.type === 'message'
    && ['history', 'quoted'].includes(resource?.source)
    && Number(resource?.index) === index
    && allowedRoles.includes(resource?.role)
    && resource?.missing === false);
  const key = bound?.key || (() => {
    const used = new Set(resources.map(resource => String(resource?.key || '')));
    let number = 1;
    while (used.has(`r${number}`)) number += 1;
    return `r${number}`;
  })();
  if (!bound) resources.push({
    key, type: 'message', source: 'history', role: 'context', index,
    id: String(messageIdentity(quote)), reference_id: '', missing: false,
  });
  const baseKeys = [...directive.base_resource_keys];
  if (!baseKeys.includes(key)) baseKeys.push(key);
  return {
    ...task,
    relation: 'followup',
    resources,
    directive: {
      ...directive,
      mode: 'patch',
      base_resource_keys: baseKeys,
      unmentioned_policy: 'preserve',
    },
  };
}

function hasRequiredTextToImageQuoteBinding(task = {}, context = {}) {
  if (task?.operation !== 'text_to_image') return true;
  const quote = context?.quoted_message;
  if (!quote || typeof quote !== 'object') return true;
  const index = Number(quote.index);
  if (!Number.isInteger(index) || index < 1 || !Array.isArray(task?.resources)) return false;
  const quoteId = String(messageIdentity(quote));
  return task.resources.some(resource => resource?.type === 'message'
    && ['quoted', 'history'].includes(resource?.source)
    && ['context', 'reference'].includes(resource?.role)
    && Number(resource?.index) === index
    && resource?.missing === false
    && (!quoteId || String(resource?.id || '') === quoteId));
}

function inspectTaskContract(taskContract = {}, options = {}) {
  if (!isTaskContractResult(taskContract)) return { route: null, reason: 'contract_shape' };
  if (taskContract.readiness === 'ready'
      && !operationAllowedByProductMode(taskContract.operation, options.currentMode, options.autoMode)) {
    return { route: null, reason: 'mode_conflict' };
  }
  try {
    const executionPlan = intentContract.taskContractToExecutionPlan(taskContract, { ...options, requireCandidateMatch: true });
    return { route: attachComposedPrompt(executionPlan, taskContract, options), reason: '' };
  } catch (error) {
    const message = String(error?.message || '');
    return { route: null, reason: /resource/i.test(message) ? 'resource_binding' : 'contract_semantics' };
  }
}

function inspectRouteDecision(decision = {}, options = {}) {
  if (!hasRouteDecisionShape(decision, { allowIncompleteChanges: true })) return { route: null, reason: 'decision_shape' };
  try {
    const taskContract = compileRouteDecision(decision, options);
    if (routeReadiness(taskContract) === 'needs_clarification') {
      const inspected = inspectDeclaredClarification(taskContract, options);
      return inspected.route ? { ...inspected, route: { ...inspected.route, routeDecision: decision } } : inspected;
    }
    if (!hasRequiredTextToImageQuoteBinding(taskContract, options.context)) return { route: null, reason: 'resource_binding' };
    const inspected = inspectTaskContract(taskContract, options);
    return inspected.route ? { ...inspected, route: { ...inspected.route, routeDecision: decision } } : inspected;
  } catch (error) {
    const message = String(error?.message || '');
    return { route: null, reason: /binding|candidate|resource/i.test(message) ? 'resource_binding' : 'decision_semantics' };
  }
}

function declaredClarificationQuestion(task = {}) {
  const question = typeof task?.clarification?.question === 'string' ? task.clarification.question.trim() : '';
  return question || '请补充完成当前任务所需的信息后继续。';
}

function nonExecutingClarificationRoute(task = {}, validationReason = 'contract_shape') {
  const operation = String(task?.operation || '');
  const operationApi = intentContract?.contractApi?.(task) || '';
  return {
    mode: 'chat',
    api: 'clarify',
    operationApi,
    readiness: 'needs_clarification',
    dispatchAuthorized: false,
    relation: String(task?.relation || ''),
    operationType: operation,
    resumeOperation: operation,
    resumeApi: operationApi,
    target: 'none',
    intent: 'clarify',
    needClarification: true,
    clarificationQuestion: declaredClarificationQuestion(task),
    clarificationSlots: [],
    confidence: Number.isFinite(task?.confidence) ? Math.max(0, Math.min(1, task.confidence)) : 0,
    evidence: typeof task?.rationale === 'string' ? task.rationale : '',
    selectedIndexes: [],
    selectedImageIndexes: [],
    selectedFileIndexes: [],
    selectedImageIds: [],
    selectedReferenceId: '',
    imageRefs: [],
    fileRefs: [],
    messageRefs: [],
    taskContract: null,
    localClarification: false,
    clarificationDegraded: true,
    clarificationValidationReason: String(validationReason || 'contract_shape'),
    requiresRerouteAfterClarification: true,
  };
}

function inspectDeclaredClarification(task = {}, options = {}) {
  const canonical = typeof intentContract?.canonicalizeClarificationContract === 'function'
    ? intentContract.canonicalizeClarificationContract(task, options)
    : task;
  const structured = inspectTaskContract(canonical, options);
  if (structured.route) return { ...structured, clarificationTerminal: true };
  return {
    route: nonExecutingClarificationRoute(decodeTaskContract(task), structured.reason),
    reason: '',
    clarificationTerminal: true,
    clarificationDegraded: true,
    clarificationValidationReason: structured.reason,
  };
}

function terminalClarificationRouteFromResult(text = '', options = {}) {
  try {
    const parsed = JSON.parse(stripJsonFence(text));
    if (parsed?.schema_version === ROUTE_DECISION_VERSION) {
      if (routeReadiness(parsed) !== 'needs_clarification') return null;
      return inspectRouteDecision(parsed, options).route;
    }
    const decoded = bindExplicitQuotedMessage(decodeTaskContract(parsed), options.context);
    if (routeReadiness(decoded) !== 'needs_clarification') return null;
    return inspectDeclaredClarification(decoded, options).route;
  } catch {
    return null;
  }
}

function inspectRouteResult(text = '', options = {}) {
  const value = String(text || '').trim();
  if (!value) return { route: null, reason: 'empty_response' };
  try {
    const parsed = JSON.parse(stripJsonFence(value));
    if (parsed?.schema_version === ROUTE_DECISION_VERSION) return inspectRouteDecision(parsed, options);
    const decoded = bindExplicitQuotedMessage(decodeTaskContract(parsed), options.context);
    if (routeReadiness(decoded) === 'needs_clarification') return inspectDeclaredClarification(decoded, options);
    if (!hasRequiredTextToImageQuoteBinding(decoded, options.context)) return { route: null, reason: 'resource_binding' };
    const taskContract = typeof intentContract?.canonicalizeContractBindings === 'function'
      ? intentContract.canonicalizeContractBindings(decoded, options)
      : decoded;
    return inspectTaskContract(taskContract, options);
  } catch (error) {
    return { route: null, reason: 'contract_semantics' };
  }
}

function parseRouteResult(text = '', options = {}) {
  return inspectRouteResult(text, options).route;
}

function createExplicitTextToImageRoute(input = '') {
  const prompt = String(input || '').trim();
  if (!prompt) return null;
  const taskContract = {
    schema_version: 'task_contract.v5',
    readiness: 'ready',
    operation: 'text_to_image',
    relation: 'new',
    resources: [{
      key: 'r1',
      type: 'text',
      source: 'current',
      role: 'source',
      index: 1,
      id: '',
      reference_id: '',
      missing: false,
    }],
    directive: {
      mode: 'standalone',
      base_resource_keys: [],
      unmentioned_policy: 'allow_change',
      operations: [],
      constraints: [],
    },
    clarification: { question: '', unresolved_resources: [] },
    confidence: 1,
    review_reasons: [],
    rationale: 'explicit force-image UI action',
  };
  const route = inspectTaskContract(taskContract, { input: prompt, attachments: [], context: {} }).route;
  return isRouteDispatchable(route) ? route : null;
}

function buildFileCandidatesFromAttachments(attachments = []) {
  return (attachments || [])
    .filter(item => item && !item.is_image)
    .map((item, index) => ({
      index: Number(item.media_index || item.mediaIndex) || index + 1,
      source_index: Number(item.source_index || item.sourceIndex) || index + 1,
      source: 'current',
      target: 'uploaded',
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
  const current = String(input || '').trim();
  const messages = Array.isArray(next.recent_messages) ? [...next.recent_messages] : [];
  let currentMessageIndex = 0;
  if (current && messages.length) {
    const last = messages[messages.length - 1];
    const content = String(last?.content || '').trim();
    const duplicateCurrent = last?.role === 'user' && (content === current || content.startsWith(`${current}\n\n[image `) || content.startsWith(`${current}\n\n[file `));
    if (duplicateCurrent) {
      currentMessageIndex = Number(last?.index) || messages.length;
      messages.pop();
    }
  }
  const historicalFiles = Array.isArray(next.file_candidates)
    ? next.file_candidates.filter(candidate => Number(candidate?.message_index) !== currentMessageIndex)
    : [];
  next.file_candidates = currentFiles.length ? [...historicalFiles, ...currentFiles] : historicalFiles;
  next.recent_messages = messages;
  return next;
}

function compactRouteUserPayload({ input = '', attachments = [], context = {}, currentMode = 'chat', autoMode = true } = {}) {
  const currentInput = String(input || '');
  assertInputWithinUnifiedLimit(currentInput);
  const routeContext = compactRoutePayloadContext(context, currentInput, attachments);
  const payload = { current_input: currentInput };
  const normalizedMode = ['chat', 'image', 'edit_image'].includes(currentMode) ? currentMode : 'chat';
  if (autoMode === false) {
    payload.current_mode = normalizedMode;
    payload.auto_mode = false;
  }
  if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;
  const resourceCandidates = buildRouteResourceCandidates({ attachments, context: routeContext });
  if (resourceCandidates.length) payload.resource_candidates = publicRouteResourceCandidates(resourceCandidates);
  const compactContext = Object.fromEntries(Object.entries(routeContext || {}).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    if (!value) return false;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  }));
  if (Object.keys(compactContext).length) payload.context = compactContext;
  return payload;
}

function buildRoutePayload({ model, input, attachments = [], context = {}, currentMode = 'chat', autoMode = true, systemPrompt = ROUTE_SYSTEM_PROMPT_WITH_OUTPUT_CHECK_V5, responseFormat = ROUTE_RESPONSE_FORMAT } = {}) {
  const userPayload = compactRouteUserPayload({ input, attachments, context, currentMode, autoMode });
  return {
    model,
    temperature: 0,
    ...(responseFormat ? { response_format: responseFormat } : {}),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(userPayload) },
    ],
  };
}

function buildIntentRepairPayload({ model, input, attachments = [], context = {}, currentMode = 'chat', autoMode = true, previousOutput = '', validationReason = 'contract_shape', expectedReadiness = '', responseFormat = ROUTE_RESPONSE_FORMAT } = {}) {
  const payload = compactRouteUserPayload({ input, attachments, context, currentMode, autoMode });
  const repairInvariants = repairInvariantSnapshot(previousOutput);
  if (!repairInvariants) throw new TypeError('A complete route semantic invariant is required for repair');
  payload.previous_route_output = String(previousOutput || '');
  payload.contract_validation_error = String(validationReason || 'contract_shape');
  payload.required_readiness = expectedReadiness || readRouteReadiness(previousOutput) || '';
  payload.repair_invariants = repairInvariants;
  return {
    model,
    temperature: 0,
    ...(responseFormat ? { response_format: responseFormat } : {}),
    messages: [
      { role: 'system', content: `${INTENT_REPAIR_SYSTEM_PROMPT_V5}\n\n${ROUTE_SYSTEM_PROMPT_WITH_OUTPUT_CHECK_V5}` },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  };
}

function extractRouteText(response = {}) {
  return response && response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content || response && response.output_text || '';
}

const api = Object.freeze({
  ROUTE_SYSTEM_PROMPT: ROUTE_SYSTEM_PROMPT_V5,
  ROUTE_OUTPUT_CONTRACT_CHECK: ROUTE_OUTPUT_CONTRACT_CHECK_V5,
  INTENT_REPAIR_SYSTEM_PROMPT: INTENT_REPAIR_SYSTEM_PROMPT_V5,
  ROUTE_RESPONSE_FORMAT,
  ROUTE_DECISION_VERSION,
  cleanQuotedContent,
  buildQuotedImagePlaceholders,
  buildQuotedRouteContent,
  composeTextToImagePrompt,
  stripJsonFence,
  buildRouteResourceCandidates,
  hasExactRouteDecision,
  compileRouteDecision,
  repairInvariantSnapshot,
  repairPreservesInvariants,
  routeReadiness,
  readRouteReadiness,
  mergeRouteReadinessRequirement,
  routePlanReadiness,
  routeSatisfiesReadiness,
  isRouteDispatchable,
  decodeTaskContract,
  isTaskContractResult,
  isClarificationCandidate,
  terminalClarificationRouteFromResult,
  inspectRouteResult,
  parseRouteResult,
  createExplicitTextToImageRoute,
  buildFileCandidatesFromAttachments,
  compactRoutePayloadContext,
  compactRouteUserPayload,
  buildRoutePayload,
  buildIntentRepairPayload,
  extractRouteText,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIRouteService = api;
if (root?.window) root.window.ChatUIRouteService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
