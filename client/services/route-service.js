(function initChatUIRouteService(root) {
  'use strict';

const routeCandidateModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('routeCandidates')
  || (typeof require === 'function' ? require('./route-candidates') : {});

const routeDispatchGateModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('routeDispatchGate')
  || (typeof require === 'function' ? require('./route-dispatch-gate') : {});

const routeRepairPolicyModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('routeRepairPolicy')
  || (typeof require === 'function' ? require('./route-repair-policy') : {});

const routePayloadModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('routePayload')
  || (typeof require === 'function' ? require('./route-payload') : {});

const routeDecisionCompilerModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('routeDecisionCompiler')
  || (typeof require === 'function' ? require('./route-decision-compiler') : {});

const routeLegacyAdapterModule = root?.[Symbol.for('chatui.module-registry.v1')]?.get('routeLegacyAdapter')
  || (typeof require === 'function' ? require('./route-legacy-adapter') : {});

const routeProtocol = root?.[Symbol.for('chatui.module-registry.v1')]?.get('routeProtocol')
  || root?.ChatUICore?.routeProtocol
  || (typeof require === 'function' ? require('../core/route-protocol') : {});
const {
  ROUTE_DECISION_VERSION,
  ROUTE_OPERATIONS,
  ROUTE_RELATIONS,
  ROUTE_ROLES,
  ROUTE_RESOURCE_TYPES,
  ROUTE_REASONS,
  ROUTE_CHANGES,
  OPERATIONS_BY_FIXED_MODE,
} = routeProtocol;

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
3. context.quoted_message 是用户显式引用。引用文字生成图片时必须选择对应 m key，role=context；不能因 text_to_image 不消费图片就丢弃引用消息。“基于这个描述再生成一张图片”是 text_to_image + followup，不是 resources 为空的新任务。relation=followup 不等于必须绑定历史消息：当前指令已明确生成动作和主体时不得选择历史 m key，例如“再画一只狗，换个品种”必须 bindings=[]，不能与“画一只狗”拼接；只有“再生成一张”“基于这个描述再来一张”等缺少主体或明确指向前文的指令才绑定历史消息。若 current_input 是在询问显式引用文本本身（例如数量、列举、含义、理由、改写或核对），必须按 plain_chat 问答处理并绑定该 m key；即使被引用文本是一条图片编辑澄清建议或包含“请选择/改成”等措辞，也不得把引用文本当成本轮执行指令。只有 current_input 自己明确选择、回答或要求执行时，才进入相应图片任务。
4. clarification_context.v1 只是本轮重判证据，continuation classifier 不授权执行。selected_choices 是外部候选的结构化选择：按稳定身份绑定 resource_candidate，并原样保留 selected_choices.role；reference 不得改为 style_reference、target 或其他角色。候选编号等只用于定位资源，绝不能解释成图片内部的序号、宫格、图层或空间区域，也不能成为 changes.target。continuation_relation=pending_answer 且 prior_task_contract 仅余 ambiguous 资源待选时，base_task 不可覆盖；operation、changes、constraints 必须完全一致，只补资源 binding。prior_task_contract 为空而 unresolved_resources 存在时，仅保留候选身份；必须从 base_task 决定执行语义，不得把降级槽视为执行授权。

上下文边界强制对照（这些是第一次且最终的语义决策，应用不会在本地替你增删 bindings）：
- recent m1="画一只狗"，current_input="再画一只狗，换个品种"：operation=text_to_image，relation=followup，bindings=[]，changes=[]，readiness=ready。当前句已有动作、数量和主体；“再”只表达另生成一张，不授权继承 m1。
- recent m1="画一只狗"，current_input="再生成一张"：operation=text_to_image，relation=followup，bindings=[{"candidate_key":"m1","role":"context"}]，readiness=ready。当前句缺少主体，必须使用 m1。
- quoted m1="银白色小猫坐在木地板上"，current_input="基于这个描述再生成一张图片"：operation=text_to_image，relation=followup，bindings=[{"candidate_key":"m1","role":"context"}]，readiness=ready。显式引用必须保留。
- quoted m1="请选择狸花色、橘色、白色、黑色、三花色、玳瑁色、灰色或奶牛色"，current_input="有几个颜色"：operation=plain_chat，relation=followup，bindings=[{"candidate_key":"m1","role":"context"}]，changes=[]，readiness=ready。用户是在询问引用文本，共有 8 种；不得返回 edit_image 或再次澄清颜色选择。
- history i1/i2 都是狗，current_input="把狗改成黑色"：operation=edit_image，relation=followup，bindings=[]，changes=[{"op":"replace","target":"狗的颜色","value":"黑色"}]，readiness=needs_clarification，unresolved 必须包含 image/target/ambiguous 和 ["i1","i2"]；不得默认 i1。
- history i1=最近合成图、i2/i3=候选猫图，current_input="不是这只猫，替换成你生成的猫"：operation=edit_image，bindings=[{"candidate_key":"i1","role":"target"}]，changes=[{"op":"replace","target":"目标图中的猫","value":"用户选择的参考猫"}]，readiness=needs_clarification，unresolved=image/reference/ambiguous:["i2","i3"]。选择后仍为 edit_image，保留 i1=target，选中图=reference。

二、operation 与资源槽
5. plain_chat=普通文本任务；file_qa=读取文件；multimodal_qa=同时读取图片和文件；image_qa=描述/分析图片；ocr=提取图片文字；image_compare=比较两图。
6. text_to_image=文字生成新图片，不选择 image；引用文字可选择 message(context)。image_reference_gen=选择已有图片作 reference/style_reference 并生成一张没有编辑 target 的新图；合并多图属于它，即使传输走编辑接口也不是 edit_image。edit_image=修改一个明确 target，可同时使用 reference/style_reference 提供要替换的内容、主体身份、外观或风格，也可有一个 mask。只要用户要求保留某张底图并替换其中内容，就必须是 edit_image，而不是 image_reference_gen。图片反推/逆向/提取提示词属于 image_qa 文本任务，“生成提示词”绝不是“生成图片”。
7. 槽位固定：file 只能 attachment；message 只能 context；image_qa/ocr 图片为 source；image_compare 恰好 compare_a+compare_b；edit_image 恰好 1 个 target、至多 1 个 mask，并可有 reference/style_reference；bindings 中 target 必须排在所有 reference/style_reference 之前，以便上传时目标图始终是图片1。target 必须是要被修改并保留为底图的图片，reference/style_reference 不是编辑目标，绝不能把“全部”解释为多个 target。image_reference_gen 图片只用 reference/style_reference，绝不能包含 target。plain_chat 的非当前图片只能 reference/style_reference。
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

const INTENT_REPAIR_SYSTEM_PROMPT_V5 = `你是 route_decision.v1 格式修复器。repair_invariants 是不可变边界：operation、relation、readiness、bindings、changes、constraints、clarification.question 和 unresolved 语义不可改变；bindings、unresolved 及 candidate_keys 的数组顺序也不可改变。只能补齐非语义结构字段，不能增删候选、改角色、改约束、替用户选择或改变是否执行。只输出严格 JSON。`;

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

const ROUTE_DECISION_FIELDS = routeProtocol.ROUTE_DECISION_FIELDS;

const routeCandidateDirectory = routeCandidateModule.createRouteCandidateDirectory({
  intentContract,
  cleanQuotedContent,
});
const {
  buildRouteResourceCandidates,
  publicRouteResourceCandidates,
  messageIdentity,
  messageBody,
} = routeCandidateDirectory;

const routeRepairPolicy = routeRepairPolicyModule.createRouteRepairPolicy({
  routeProtocol,
  stripJsonFence,
  maxOutputChars: MAX_ROUTE_REPAIR_OUTPUT_CHARS,
});
const { repairInvariantSnapshot, repairPreservesInvariants } = routeRepairPolicy;

const routePayloadBuilder = routePayloadModule.createRoutePayloadBuilder({
  assertInputWithinUnifiedLimit,
  buildRouteResourceCandidates,
  publicRouteResourceCandidates,
  messageIdentity,
  repairInvariantSnapshot,
  readRouteReadiness,
  routeSystemPrompt: ROUTE_SYSTEM_PROMPT_WITH_OUTPUT_CHECK_V5,
  intentRepairSystemPrompt: INTENT_REPAIR_SYSTEM_PROMPT_V5,
  routeResponseFormat: ROUTE_RESPONSE_FORMAT,
});
const {
  buildFileCandidatesFromAttachments,
  compactRoutePayloadContext,
  compactRouteUserPayload,
  buildRoutePayload,
  buildIntentRepairPayload,
  extractRouteText,
} = routePayloadBuilder;

const routeDecisionCompiler = routeDecisionCompilerModule.createRouteDecisionCompiler({
  routeProtocol,
  buildRouteResourceCandidates,
  compactRoutePayloadContext,
});
const {
  hasExactRouteDecision,
  selectedChoiceCandidateMatches,
  roleMatchesCandidate,
  operationAllowedByProductMode,
  compileRouteDecision,
} = routeDecisionCompiler;

const routeLegacyAdapter = routeLegacyAdapterModule.createRouteLegacyAdapter({
  intentContract,
  routeDecisionVersion: ROUTE_DECISION_VERSION,
  roleMatchesCandidate,
  selectedChoiceCandidateMatches,
  compactRoutePayloadContext,
  buildRouteResourceCandidates,
  hasExactRouteDecision,
  compileRouteDecision,
  messageIdentity,
});
const {
  convertLegacyTaskContractToDecision,
  preserveLegacyClarificationLabels,
  safeLegacyExplicitQuoteRoute,
} = routeLegacyAdapter;

function inspectLegacyTaskContract(value = {}, options = {}) {
  const decision = convertLegacyTaskContractToDecision(value, options);
  const decoded = decodeTaskContract(value);
  if (decision) {
    const inspected = inspectRouteDecision(decision, options);
    if (!inspected.route) return inspected;

    // A successful compile proves that every legacy identity maps to one local
    // candidate and that execution semantics survive the compact protocol. For
    // ready routes, retain harmless legacy aliases (notably message
    // history/reference versus quoted/context) so older callers do not observe
    // a behavioral regression. The retained contract is independently
    // re-inspected with strict candidate resolution and must pass the dispatch
    // gate; model-authored identities still cannot bypass the compiler.
    if (routeReadiness(decoded) === 'ready') {
      const canonical = typeof intentContract?.canonicalizeContractBindings === 'function'
        ? intentContract.canonicalizeContractBindings(decoded, options)
        : decoded;
      const compatible = hasRequiredTextToImageQuoteBinding(canonical, options.context)
        ? inspectTaskContract(canonical, options)
        : { route: null, reason: 'resource_binding' };
      if (!compatible.route || !isRouteDispatchable(compatible.route)) {
        return { route: null, reason: compatible.reason || 'legacy_contract_conversion' };
      }
      return {
        ...compatible,
        route: {
          ...compatible.route,
          routeDecision: decision,
          legacyModelOutputConverted: true,
        },
      };
    }

    const route = preserveLegacyClarificationLabels(inspected.route, decoded);
    return {
      ...inspected,
      route: {
        ...route,
        legacyModelOutputConverted: true,
      },
    };
  }

  if (routeReadiness(decoded) === 'needs_clarification') {
    // Invalid or incomplete clarification contracts remain non-executing. This
    // compatibility path may preserve a useful question, but can never dispatch.
    return inspectDeclaredClarification(decoded, options);
  }
  const canonical = typeof intentContract?.canonicalizeContractBindings === 'function'
    ? intentContract.canonicalizeContractBindings(decoded, options)
    : decoded;
  const legacyInspection = inspectTaskContract(canonical, options);
  if (legacyInspection.route) {
    const explicitQuoteRoute = safeLegacyExplicitQuoteRoute(canonical, options, legacyInspection.route);
    return explicitQuoteRoute
      ? { ...legacyInspection, route: explicitQuoteRoute }
      : { route: null, reason: 'legacy_contract_conversion' };
  }
  return legacyInspection;
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

const routeDispatchGate = routeDispatchGateModule.createRouteDispatchGate({ intentContract });
const { isRouteDispatchable } = routeDispatchGate;


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
      const inspected = inspectDeclaredClarification(compiledTaskContract, options, { preserveCompiledSlots: true });
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

function trustedClarificationSlots(task = {}) {
  const slots = Array.isArray(task?.clarification?.unresolved_resources)
    ? task.clarification.unresolved_resources
    : [];
  return slots.map(slot => ({
    key: String(slot?.key || ''),
    type: String(slot?.type || ''),
    role: String(slot?.role || ''),
    reason: String(slot?.reason || ''),
    choices: (Array.isArray(slot?.choices) ? slot.choices : []).map(choice => ({
      key: String(choice?.key || ''),
      source: String(choice?.source || ''),
      index: Number(choice?.index) || 0,
      id: String(choice?.id || ''),
      reference_id: String(choice?.reference_id || ''),
      label: String(choice?.label || ''),
    })),
  })).filter(slot => slot.key && slot.type && slot.role && slot.reason);
}

function nonExecutingClarificationRoute(task = {}, validationReason = 'contract_shape', clarificationSlots = []) {
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
    // These slots are only a display/selection snapshot. They were produced by
    // the candidate-key compiler before semantic execution validation failed;
    // keeping them must never authorize dispatch or create a task contract.
    clarificationSlots: Array.isArray(clarificationSlots) ? clarificationSlots : [],
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

function inspectDeclaredClarification(task = {}, options = {}, { preserveCompiledSlots = false } = {}) {
  const canonical = typeof intentContract?.canonicalizeClarificationContract === 'function'
    ? intentContract.canonicalizeClarificationContract(task, options)
    : task;
  const structured = inspectTaskContract(canonical, options);
  if (structured.route) return { ...structured, clarificationTerminal: true };
  const displaySlots = preserveCompiledSlots ? trustedClarificationSlots(canonical) : [];
  return {
    route: nonExecutingClarificationRoute(decodeTaskContract(task), structured.reason, displaySlots),
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
    return inspectLegacyTaskContract(decoded, options).route;
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
    return inspectLegacyTaskContract(decoded, options);
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
  convertLegacyTaskContractToDecision,
  inspectLegacyTaskContract,
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
