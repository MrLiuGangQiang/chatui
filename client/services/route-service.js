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
4. clarification_context.v1 仅是本轮重新判断的证据，不让 continuation classifier 授权执行。selected_choices 是用户对外部候选资源的结构化选择：必须按其稳定身份绑定对应 resource_candidate；候选编号、顺序、标签或文件名仅用于确定资源，绝不能解释成图片内部的序号、宫格、图层或空间区域，也不能成为 changes.target。若 continuation_relation=pending_answer 且 prior_task_contract 只剩 ambiguous 外部资源待选，base_task 是不可覆盖的原始执行语义；operation、changes、constraints 必须与 prior_task_contract 完全一致，只更新资源 binding。

上下文边界强制对照（这些是第一次且最终的语义决策，应用不会在本地替你增删 bindings）：
- recent m1="画一只狗"，current_input="再画一只狗，换个品种"：operation=text_to_image，relation=followup，bindings=[]，changes=[]，readiness=ready。当前句已有动作、数量和主体；“再”只表达另生成一张，不授权继承 m1。
- recent m1="画一只狗"，current_input="再生成一张"：operation=text_to_image，relation=followup，bindings=[{"candidate_key":"m1","role":"context"}]，readiness=ready。当前句缺少主体，必须使用 m1。
- quoted m1="银白色小猫坐在木地板上"，current_input="基于这个描述再生成一张图片"：operation=text_to_image，relation=followup，bindings=[{"candidate_key":"m1","role":"context"}]，readiness=ready。显式引用必须保留。
- history i1/i2 都是狗，current_input="把狗改成黑色"：operation=edit_image，relation=followup，bindings=[]，changes=[{"op":"replace","target":"狗的颜色","value":"黑色"}]，readiness=needs_clarification，unresolved 必须包含 image/target/ambiguous 和 ["i1","i2"]；不得默认 i1。

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

const ROUTE_OUTPUT_CONTRACT_CHECK_V5 = `输出前自检：这是第一次且最终的语义决定，不能假设应用会在本地纠错；恰好 10 个顶层字段，空数组也输出 []；只选 resource_candidates 中的 key；ready 无 unresolved；引用文字生图必须绑定 m key；自包含生图追问不得绑定历史 m key；bindings 的类型/role 满足 operation；只输出 route_decision.v1 JSON。`;
const ROUTE_MISSING_DETAIL_GUIDANCE_V5 = `关键反例：“把猫的颜色换一下”没有给出目标颜色，不能 ready，也不能输出 value=""。必须保持 edit_image 和已明确的 target binding，输出 needs_clarification，changes=[]，clarification.question 询问目标颜色，并声明 text/source/missing、candidate_keys=[]。只有“把猫改成黑色”这类目标值明确的指令才能输出非空 replace.value。`;
const ROUTE_NATIVE_INPUT_FILE_GUIDANCE_V5 = `原生 input_file 即使 has_extracted_text=false，也可能由执行模型直接读取；只要文件出现在 resource_candidates 中，就视为可读取并允许绑定。`;
const ROUTE_SYSTEM_PROMPT_WITH_OUTPUT_CHECK_V5 = `${ROUTE_SYSTEM_PROMPT_V5}\n\n${ROUTE_MISSING_DETAIL_GUIDANCE_V5}\n\n${ROUTE_NATIVE_INPUT_FILE_GUIDANCE_V5}\n\n${ROUTE_OUTPUT_CONTRACT_CHECK_V5}`;

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

function hasRouteDecisionShape(value = {}) {
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
      return !change.target.trim() || !change.value.trim();
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

function selectedChoiceCandidateMatches(candidate = {}, selected = {}) {
  if (!candidate || !selected || String(candidate.type || '') !== String(selected.type || '')) return false;
  const candidateId = String(candidate.id || '');
  const selectedId = String(selected.id || '');
  const candidateReference = String(candidate.reference_id || '');
  const selectedReference = String(selected.reference_id || '');
  if (selectedId && candidateId) return selectedId === candidateId;
  if (selectedReference && candidateReference) {
    return selectedReference === candidateReference && Number(candidate.index) === Number(selected.index);
  }
  if ((selectedId || selectedReference) && (candidateId || candidateReference)) return false;
  const sameSourceIndex = String(candidate.source || '') === String(selected.source || '')
    && Number(candidate.index) === Number(selected.index);
  return sameSourceIndex;
}

function assertSelectedChoicesAreBound(decision = {}, catalog = [], context = {}) {
  if (decision.readiness !== 'ready') return;
  const selectedChoices = context?.clarification_context?.selected_choices;
  if (!Array.isArray(selectedChoices) || !selectedChoices.length) return;
  for (const selected of selectedChoices) {
    const matches = catalog.filter(candidate => selectedChoiceCandidateMatches(candidate, selected));
    if (matches.length !== 1 || !decision.bindings.some(binding => binding.candidate_key === matches[0].candidate_key && binding.role === selected.role)) {
      throw new TypeError('A selected clarification resource was not preserved in the ready route');
    }
  }
}

function selectionAnswerInvariantContext(context = {}) {
  const clarification = context?.clarification_context;
  if (clarification?.continuation_relation !== 'pending_answer') return null;
  const prior = clarification.prior_task_contract;
  const unresolved = prior?.clarification?.unresolved_resources;
  const selected = clarification.selected_choices;
  if (!prior || !Array.isArray(unresolved) || !unresolved.length
      || unresolved.some(slot => slot?.reason !== 'ambiguous' || slot?.type === 'text')
      || !Array.isArray(selected) || selected.length !== unresolved.length) return null;
  const selectedKeys = new Set(selected.map(item => String(item?.resource_key || '')));
  if (unresolved.some(slot => !selectedKeys.has(String(slot?.key || '')))) return null;
  return { prior, selected };
}

function assertSelectionAnswerPreservesOriginalSemantics(decision = {}, context = {}) {
  const invariant = selectionAnswerInvariantContext(context);
  if (!invariant) return;
  const { prior } = invariant;
  const priorChanges = Array.isArray(prior.directive?.operations) ? prior.directive.operations : [];
  const priorConstraints = Array.isArray(prior.directive?.constraints) ? prior.directive.constraints : [];
  if (decision.operation !== prior.operation
      || JSON.stringify(sortedSignatures(decision.changes)) !== JSON.stringify(sortedSignatures(priorChanges))
      || JSON.stringify([...decision.constraints].sort()) !== JSON.stringify([...priorConstraints].sort())) {
    throw new TypeError('A resource-selection answer cannot replace the original task semantics');
  }
}

function assertSelectionAnswerPreservesOriginalBindings(decision = {}, catalog = [], context = {}) {
  const invariant = selectionAnswerInvariantContext(context);
  if (!invariant || decision.readiness !== 'ready') return;
  const expectedResources = [
    ...(Array.isArray(invariant.prior.resources) ? invariant.prior.resources : []),
    ...invariant.selected,
  ].filter(resource => resource && resource.type !== 'text' && resource.missing !== true);
  const expectedCandidateKeys = new Set();
  for (const expected of expectedResources) {
    const matches = catalog.filter(candidate => selectedChoiceCandidateMatches(candidate, expected));
    if (matches.length !== 1
        || expectedCandidateKeys.has(matches[0].candidate_key)
        || !decision.bindings.some(binding => binding.candidate_key === matches[0].candidate_key && binding.role === expected.role)) {
      throw new TypeError('A resource-selection answer cannot replace an established resource binding');
    }
    expectedCandidateKeys.add(matches[0].candidate_key);
  }
  if (decision.bindings.length !== expectedCandidateKeys.size
      || decision.bindings.some(binding => !expectedCandidateKeys.has(binding.candidate_key))) {
    throw new TypeError('A resource-selection answer cannot add or remove resource bindings');
  }
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

function compileRouteDecision(decision = {}, options = {}) {
  if (!hasExactRouteDecision(decision)) throw new TypeError('Invalid route_decision.v1 shape');
  const compilerContext = compactRoutePayloadContext(options.context || {}, options.input || '', options.attachments || []);
  const catalog = buildRouteResourceCandidates({ attachments: options.attachments || [], context: compilerContext });
  assertSelectedChoicesAreBound(decision, catalog, compilerContext);
  assertSelectionAnswerPreservesOriginalBindings(decision, catalog, compilerContext);
  assertSelectionAnswerPreservesOriginalSemantics(decision, compilerContext);
  const candidates = new Map(catalog.map(candidate => [candidate.candidate_key, candidate]));
  const usedCandidateKeys = new Set();
  const resources = decision.bindings.map((binding, index) => {
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
  const unresolvedResources = decision.clarification.unresolved.map(slot => {
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

  if (decision.readiness === 'ready' && (decision.clarification.question || unresolvedResources.length)
      || decision.readiness === 'needs_clarification' && (!decision.clarification.question.trim() || !unresolvedResources.length)) {
    throw new TypeError('Decision readiness and clarification disagree');
  }

  const operationRequiresPatch = ['edit_image', 'image_reference_gen'].includes(decision.operation);
  const historicalResources = resources.filter(resource => ['quoted', 'history', 'context'].includes(resource.source));
  const unresolvedNeedsBaseline = decision.readiness === 'needs_clarification'
    && decision.relation !== 'new'
    && unresolvedResources.some(slot => slot.type !== 'text');
  const mode = operationRequiresPatch || historicalResources.length || unresolvedNeedsBaseline ? 'patch' : 'standalone';
  const baselineKeys = [];
  for (const resource of resources) {
    if (resource.type === 'text') continue;
    if (operationRequiresPatch && resource.type === 'image' || ['quoted', 'history', 'context'].includes(resource.source)) baselineKeys.push(resource.key);
  }
  if (mode === 'patch' && decision.readiness === 'needs_clarification') {
    for (const slot of unresolvedResources) if (slot.type !== 'text') baselineKeys.push(slot.key);
  }

  const taskContract = {
    schema_version: 'task_contract.v5',
    readiness: decision.readiness,
    operation: decision.operation,
    relation: decision.relation,
    resources,
    directive: {
      mode,
      base_resource_keys: [...new Set(baselineKeys)],
      unmentioned_policy: mode === 'patch' ? 'preserve' : 'allow_change',
      operations: decision.changes.map(change => ({ ...change })),
      constraints: decision.constraints.map(constraint => String(constraint)),
    },
    clarification: {
      question: decision.clarification.question,
      unresolved_resources: unresolvedResources,
    },
    confidence: decision.confidence,
    review_reasons: [],
    rationale: decision.rationale,
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
  if (!hasExactRouteDecision(decision)) return { route: null, reason: 'decision_shape' };
  try {
    const compiledTaskContract = compileRouteDecision(decision, options);
    if (routeReadiness(compiledTaskContract) === 'needs_clarification') {
      const inspected = inspectDeclaredClarification(compiledTaskContract, options);
      return inspected.route ? { ...inspected, route: { ...inspected.route, routeDecision: decision } } : inspected;
    }
    // The compact decision catalog may bind a just-uploaded image by its
    // transient attachment id. The full route context already owns the same
    // image under its durable id, with the attachment id recorded as a
    // validated alias. Canonicalize before creating the execution projection
    // so the task contract and dispatch gate compare one stable identity.
    const taskContract = typeof intentContract?.canonicalizeContractBindings === 'function'
      ? intentContract.canonicalizeContractBindings(compiledTaskContract, options)
      : compiledTaskContract;
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
    .map((item, index) => {
      const extractedText = item.has_extracted_text ?? item.hasExtractedText;
      const inputFileAvailable = item.input_file_available === true || item.inputFileAvailable === true;
      return {
        index: Number(item.media_index || item.mediaIndex) || index + 1,
        source_index: Number(item.source_index || item.sourceIndex) || index + 1,
        source: 'current',
        target: 'uploaded',
        file_id: item.file_id || item.id || item.attachmentId || item.attachment_id || '',
        name: item.name || 'attachment',
        type: item.type || '',
        size: Number(item.size) || 0,
        ...(extractedText !== undefined ? { has_extracted_text: !!extractedText } : {}),
        ...(inputFileAvailable ? { input_file_available: true } : {}),
        unsupported_reason: item.unsupported_reason || item.unsupportedReason || '',
      };
    });
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
  const historicalImages = Array.isArray(next.image_candidates)
    ? next.image_candidates
      .filter(candidate => !currentMessageIndex || Number(candidate?.message_index) !== currentMessageIndex)
      .map(candidate => candidate?.source === 'user_message'
        ? { ...candidate, source: 'history' }
        : candidate)
    : [];
  const historicalFiles = Array.isArray(next.file_candidates)
    ? next.file_candidates.filter(candidate => Number(candidate?.message_index) !== currentMessageIndex)
    : [];
  // Current attachments are catalogued from the authoritative attachment
  // list below. Keeping their already-persisted message candidates as well
  // creates duplicate identities and can shift a model-selected i-key onto a
  // prior image. Every remaining user-message candidate is historical relative
  // to this new input, even after the duplicate current message is removed.
  next.image_candidates = historicalImages;
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
