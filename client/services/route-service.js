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
  SEMANTIC_TASK_VERSION,
  ROUTE_OPERATIONS,
  ROUTE_RELATIONS,
  ROUTE_ROLES,
  ROUTE_RESOURCE_TYPES,
  ROUTE_REASONS,
  ROUTE_CHANGES,
  OPERATIONS_BY_FIXED_MODE,
} = routeProtocol;

const MAX_ROUTE_REPAIR_OUTPUT_CHARS = 12000;

// The model extracts semantic facts only. Product operations, readiness,
// clarification wording and task_contract fields are compiled locally.
const ROUTE_SYSTEM_PROMPT_V6 = `把 current_input 解析为 semantic_task.v2。只输出 schema 规定的 JSON，不回答用户，不输出分析或 Markdown。

语义原则：
1. current_input 决定本轮行为；引用和历史只是证据，不能自动成为执行指令。
2. 仅在当前表达存在明确指代、省略或延续依赖时使用历史；语义完整的当前请求不继承历史任务。
3. 用 slots 表达任务所需的外部资源及其用途和解析状态。current_input 自身是隐式文本源；改写、总结、优化或翻译当前输入时必须 slots=[]，不得创建 text/source 槽位。candidate_keys 只能引用 resource_candidates 中已有的 candidate_key，绝不编造或改写 key。
4. resolution 必须与 candidate_keys 数量一致：bound 恰好 1 个，ambiguous 至少 2 个，missing/unavailable 必须为空；存在歧义时不替用户选择。
5. quoted_message、pending_task 和 confirmed selections 是上下文事实。询问这些内容时仍是 respond；只有 current_input 明确要求执行时才生成或编辑。
6. 只记录用户明确表达的 changes 和 constraints；执行必需信息未提供时增加 missing slot，不虚构值。
7. action 表示用户意图：respond=回答/理解，extract_text=提取图片文字，compare=比较图片，generate=生成新图，edit=修改现有图。
8. 有 pending_task 时，pending_effect=answer/partial/continuation 表示补充原任务，revision 表示修正原任务，assistance 只回答本轮问题，new_task 表示独立新任务，无法判断用 unclear；没有 pending_task 时必须为 none。
9. 同一执行流程可完成的多个要求合并为一个 action；需要不同执行流程时按出现顺序列出多个 actions，由应用请求用户选择。

应用会确定性计算 operation、readiness、bindings、澄清文案、产品模式和 task_contract.v5。`;

const INTENT_REPAIR_SYSTEM_PROMPT_V6 = `你只修复 semantic_task.v2 的 JSON 结构。previous_semantic_output 中已经明确的 actions、discourse、pending_effect、slots、changes 和 constraints 都是不可变语义；不得重新判断任务、增删资源、改变角色或替用户选择。只返回符合 response schema 的 JSON。`;

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

const ROUTE_CANDIDATE_KEY_SCHEMA = Object.freeze({ type: 'string', pattern: '^[ifm][1-9][0-9]*$' });
const ROUTE_SLOT_COMMON_PROPERTIES = Object.freeze({
  kind: { type: 'string', enum: ['image', 'file', 'text', 'message'] },
  purpose: {
    type: 'string',
    description: '资源在任务中的语义用途；change_value 表示修改值，不是可上传资源。',
    enum: ['source', 'target', 'reference', 'style_reference', 'mask', 'compare_a', 'compare_b', 'attachment', 'context', 'change_value'],
  },
  label: { type: 'string' },
});

function routeSlotSchema(resolution, candidateKeys) {
  return strictObject({
    ...ROUTE_SLOT_COMMON_PROPERTIES,
    resolution,
    candidate_keys: candidateKeys,
  });
}

const ROUTE_SLOT_SCHEMA = Object.freeze({
  ...strictObject({
    ...ROUTE_SLOT_COMMON_PROPERTIES,
    resolution: {
      type: 'string',
      description: 'bound=唯一匹配，ambiguous=多个候选，missing=尚未提供，unavailable=已知资源无法恢复。',
      enum: ['bound', 'ambiguous', 'missing', 'unavailable'],
    },
    candidate_keys: { type: 'array', items: ROUTE_CANDIDATE_KEY_SCHEMA },
  }),
  anyOf: [
    routeSlotSchema(
      { type: 'string', const: 'bound', description: '唯一匹配，candidate_keys 必须恰好包含一个候选。' },
      { type: 'array', minItems: 1, maxItems: 1, items: ROUTE_CANDIDATE_KEY_SCHEMA },
    ),
    routeSlotSchema(
      { type: 'string', const: 'ambiguous', description: '多个候选，candidate_keys 必须至少包含两个候选。' },
      { type: 'array', minItems: 2, items: ROUTE_CANDIDATE_KEY_SCHEMA },
    ),
    routeSlotSchema(
      { type: 'string', enum: ['missing', 'unavailable'], description: '未提供或无法恢复，candidate_keys 必须为空。' },
      { type: 'array', maxItems: 0, items: ROUTE_CANDIDATE_KEY_SCHEMA },
    ),
  ],
});

const ROUTE_RESPONSE_FORMAT = Object.freeze({
  type: 'json_schema',
  json_schema: {
    name: 'chatui_semantic_task_v2',
    strict: true,
    schema: strictObject({
      schema_version: { type: 'string', const: 'semantic_task.v2' },
      actions: {
        type: 'array', minItems: 1,
        description: '用户本轮要完成的语义动作；respond=回答，extract_text=图片文字，compare=图片比较，generate=新图，edit=改图。',
        items: { type: 'string', enum: ['respond', 'extract_text', 'compare', 'generate', 'edit'] },
      },
      discourse: {
        type: 'string',
        description: '本轮相对既有内容的关系；独立请求用 independent，依赖既有内容才用 followup/correction/continuation。',
        enum: ['independent', 'followup', 'correction', 'continuation'],
      },
      pending_effect: {
        type: 'string',
        description: '仅在上下文存在 pending_task 时使用；answer/partial/continuation 补充，revision 修正，assistance 只回答当前问题，new_task 开新任务，unclear 保留原任务。',
        enum: ['none', 'answer', 'partial', 'revision', 'continuation', 'assistance', 'new_task', 'unclear'],
      },
      slots: {
        type: 'array',
        items: ROUTE_SLOT_SCHEMA,
      },
      changes: { type: 'array', items: ROUTE_CHANGE_SCHEMA },
      constraints: { type: 'array', items: { type: 'string', pattern: '\\S' } },
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
  routeSystemPrompt: ROUTE_SYSTEM_PROMPT_V6,
  intentRepairSystemPrompt: INTENT_REPAIR_SYSTEM_PROMPT_V6,
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
  hasExactSemanticTask,
  analyzeSemanticTask,
  semanticTaskToRouteDecision,
  compileSemanticTask,
  selectedChoiceCandidateMatches,
  roleMatchesCandidate,
  operationAllowedByProductMode,
  compileRouteDecision,
} = routeDecisionCompiler;

function isImplicitCurrentInputTextSlot(slot = {}) {
  return !!slot
    && typeof slot === 'object'
    && !Array.isArray(slot)
    && Object.keys(slot).length === 5
    && slot.kind === 'text'
    && slot.purpose === 'source'
    && typeof slot.label === 'string'
    && slot.resolution === 'bound'
    && Array.isArray(slot.candidate_keys)
    && slot.candidate_keys.length === 0;
}

function normalizeModelSemanticTask(task = {}, options = {}) {
  if (!task || typeof task !== 'object' || Array.isArray(task)
      || task.schema_version !== SEMANTIC_TASK_VERSION
      || !String(options.input || '').trim()
      || !Array.isArray(task.actions)
      || task.actions.length !== 1
      || task.actions[0] !== 'respond'
      || !Array.isArray(task.slots)
      || !task.slots.some(isImplicitCurrentInputTextSlot)) return task;
  const normalized = {
    ...task,
    slots: task.slots.filter(slot => !isImplicitCurrentInputTextSlot(slot)),
  };
  return hasExactSemanticTask(normalized) ? normalized : task;
}

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
  if (value.schema_version === SEMANTIC_TASK_VERSION) {
    if (!hasExactSemanticTask(value)) return '';
    const unresolved = Array.isArray(value.slots)
      && value.slots.some(slot => slot.resolution !== 'bound');
    const actions = Array.isArray(value.actions) ? value.actions : [];
    const families = new Set(actions.map(action => ['generate', 'edit'].includes(action) ? action : 'understand'));
    return unresolved || families.size > 1 || value.pending_effect === 'unclear'
      ? 'needs_clarification'
      : 'ready';
  }
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

const SEMANTIC_OPERATION_API = Object.freeze({
  plain_chat: 'chat',
  file_qa: 'chat',
  multimodal_qa: 'chat',
  image_qa: 'vision',
  image_compare: 'vision',
  ocr: 'vision',
  text_to_image: 'image_generation',
  image_reference_gen: 'image_edit',
  edit_image: 'image_edit',
});

const SEMANTIC_OPERATION_MODE = Object.freeze({
  plain_chat: 'chat',
  file_qa: 'chat',
  multimodal_qa: 'chat',
  image_qa: 'chat',
  image_compare: 'chat',
  ocr: 'chat',
  text_to_image: 'image',
  image_reference_gen: 'image',
  edit_image: 'edit_image',
});

function semanticTaskClarificationRoute(task = {}, analysis = {}) {
  const operation = String(analysis.operation || '');
  const relation = ROUTE_RELATIONS.has(analysis.relation) ? analysis.relation : 'new';
  const question = String(analysis.issue?.question || '请明确本轮要先完成的任务。').trim();
  const clarificationSlots = [{
    key: 'r1', type: 'text', role: 'source', reason: 'missing', choices: [],
  }];
  return {
    api: 'clarify',
    operationApi: SEMANTIC_OPERATION_API[operation] || '',
    operationMode: SEMANTIC_OPERATION_MODE[operation] || 'chat',
    readiness: 'needs_clarification',
    dispatchAuthorized: false,
    relation,
    resources: [],
    imageRefs: [],
    fileRefs: [],
    messageRefs: [],
    executionResources: null,
    directiveAudit: null,
    operationType: operation,
    confidence: 1,
    evidence: '',
    needClarification: true,
    clarificationQuestion: question,
    clarificationSlots,
    selectedIndexes: [],
    selectedImageIndexes: [],
    selectedFileIndexes: [],
    selectedReferenceId: '',
    selectedImageIds: [],
    usePreviousImage: false,
    contextualImagePrompt: '',
    editInstruction: '',
    mode: 'chat',
    target: 'none',
    intent: 'clarify',
    resumeOperation: operation,
    resumeApi: SEMANTIC_OPERATION_API[operation] || '',
    taskContract: null,
    routeDecision: null,
    semanticTask: task,
    semanticClarification: true,
    requiresRerouteAfterClarification: true,
    localClarification: false,
  };
}

function inspectSemanticTask(task = {}, options = {}) {
  if (!hasExactSemanticTask(task)) return { route: null, reason: 'semantic_task_shape' };
  try {
    const analysis = typeof analyzeSemanticTask === 'function' ? analyzeSemanticTask(task, options) : null;
    if (analysis?.issue) return { route: semanticTaskClarificationRoute(task, analysis), reason: '' };
    const decision = semanticTaskToRouteDecision(task, options);
    const inspected = inspectRouteDecision(decision, options);
    if (!inspected.route) return inspected;
    return {
      ...inspected,
      route: {
        ...inspected.route,
        semanticTask: task,
        routeDecision: decision,
      },
    };
  } catch (error) {
    const message = String(error?.message || '');
    return { route: null, reason: /binding|candidate|resource/i.test(message) ? 'resource_binding' : 'semantic_task_semantics' };
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
    if (parsed?.schema_version === SEMANTIC_TASK_VERSION) {
      if (routeReadiness(parsed) !== 'needs_clarification') return null;
      return inspectSemanticTask(parsed, options).route;
    }
    if (options.modelBoundary === true) return null;
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
    if (parsed?.schema_version === SEMANTIC_TASK_VERSION) {
      const semanticTask = options.modelBoundary === true ? normalizeModelSemanticTask(parsed, options) : parsed;
      return inspectSemanticTask(semanticTask, options);
    }
    if (options.modelBoundary === true) return { route: null, reason: 'semantic_task_required' };
    if (parsed?.schema_version === ROUTE_DECISION_VERSION) return inspectRouteDecision(parsed, options);
    const decoded = bindExplicitQuotedMessage(decodeTaskContract(parsed), options.context);
    return inspectLegacyTaskContract(decoded, options);
  } catch (error) {
    return { route: null, reason: 'contract_semantics' };
  }
}

function inspectModelRouteResult(text = '', options = {}) {
  return inspectRouteResult(text, { ...options, modelBoundary: true });
}

function parseRouteResult(text = '', options = {}) {
  return inspectRouteResult(text, options).route;
}

function parseModelRouteResult(text = '', options = {}) {
  return inspectModelRouteResult(text, options).route;
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
  ROUTE_SYSTEM_PROMPT: ROUTE_SYSTEM_PROMPT_V6,
  INTENT_REPAIR_SYSTEM_PROMPT: INTENT_REPAIR_SYSTEM_PROMPT_V6,
  ROUTE_RESPONSE_FORMAT,
  ROUTE_DECISION_VERSION,
  SEMANTIC_TASK_VERSION,
  cleanQuotedContent,
  buildQuotedImagePlaceholders,
  buildQuotedRouteContent,
  composeTextToImagePrompt,
  stripJsonFence,
  buildRouteResourceCandidates,
  hasExactRouteDecision,
  hasExactSemanticTask,
  analyzeSemanticTask,
  semanticTaskToRouteDecision,
  compileSemanticTask,
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
  inspectModelRouteResult,
  parseRouteResult,
  parseModelRouteResult,
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
