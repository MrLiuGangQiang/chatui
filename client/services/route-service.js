(function initChatUIRouteService(root) {
  'use strict';

const ROUTE_SYSTEM_PROMPT = `你是 ChatUI 的任务路由器。只把请求转换成严格的 task_contract.v3 JSON；不回答用户，不要输出 Markdown、解释、代码围栏或额外字段。

唯一合法结构：
{"schema_version":"task_contract.v3","operation":"plain_chat|file_qa|multimodal_qa|image_qa|image_compare|ocr|text_to_image|image_reference_gen|edit_image|clarify","relation":"new|followup|correction|continuation","resources":[{"key":"r1","type":"image|file|text|message","source":"current|quoted|history|context","role":"source|target|reference|style_reference|mask|compare_a|compare_b|attachment|context","index":1,"id":"","reference_id":"","missing":false}],"directive":{"mode":"standalone|patch","base_resource_keys":[],"unmentioned_policy":"preserve|allow_change","operations":[{"op":"preserve|add|replace|remove","target":"","value":""}],"constraints":[]},"clarification":{"question":"","missing_resource_keys":[]},"confidence":0,"review_reasons":[],"rationale":""}

按以下顺序决策：
1. 边界：只理解 current_input；attachments 是本轮资源。context 仅用于用户明确引用的对象，绝不让历史覆盖一个完整的新请求。context.quoted_message 是用户明确选择的单条历史消息。
2. 关系：relation=new 是完整独立请求，资源只能 source=current；引用历史答案或 quoted_message=followup；纠正上次结果=correction；只要求继续进行=continuation。
3. 操作：plain_chat=普通对话；file_qa=文件问答；multimodal_qa=图文问答；image_qa=看图；image_compare=比较两图；ocr=识字；text_to_image=基于当前输入或引用消息文本生图；image_reference_gen=基于图片生成；edit_image=编辑已有图。仅在必需资源缺失、候选无法消歧或目标不能确定时用 clarify。
4. 资源：每项使用唯一 r1/r2… 和候选的 1 基 index；当前附件使用类型内编号 attachments.media_index。编辑图=target，看图=source，参考生图=reference，风格参考=style_reference，比较图=compare_a/compare_b，文件=attachment。只按候选元数据匹配，不要猜图片或文件内容；“这张/上一张/那个文件”必须唯一匹配，否则声明 missing=true。
5. 指令（审计）：standalone 只用于独立请求，base_resource_keys=[]、operations=[]、unmentioned_policy=allow_change。patch 必须列出非 missing 基线；followup、correction、continuation、edit_image、image_reference_gen 必须用 patch。operations 只记录用户明确变化：preserve/remove 的 value 为空，add/replace 的 value 非空；不要重写完整执行提示词。此字段用于校验和审计，不得生成或改写执行提示词。
6. 澄清与审计：clarify 必须有问题和对应 missing_resource_keys，且 directive 必须 standalone；其他操作不能有 missing 资源或澄清问题。没有不确定性则 review_reasons=[]；rationale 只写一行依据。

明确引用的 plain_chat 必须把 quoted_message 作为 source=history、type=message、role=context 的 patch 基线。明确引用消息用于 text_to_image 时，也必须把该消息作为 source=history 或 quoted、type=message、role=context 或 reference 的 patch 基线；它的正文会作为生图提示词上下文，不能把 message 当成 image。候选多不等于歧义；语义元数据能唯一定位就直接执行。`;

const ROUTE_OUTPUT_CONTRACT_CHECK = `硬约束：逐字段输出，绝不省略。directive 必含 mode、base_resource_keys、unmentioned_policy、operations、constraints；空数组也输出 []。确认资源候选匹配、file.reference_id 为空、patch 基线有效；只输出完整 task_contract.v3。`;
const ROUTE_SYSTEM_PROMPT_WITH_OUTPUT_CHECK = `${ROUTE_SYSTEM_PROMPT}\n\n${ROUTE_OUTPUT_CONTRACT_CHECK}`;
const MAX_EXECUTION_PROMPT_LENGTH = 3200;

const INTENT_REVIEW_SYSTEM_PROMPT = `${ROUTE_SYSTEM_PROMPT_WITH_OUTPUT_CHECK}

你现在是独立审计器。输入包含 first_task_contract。逐项检查：是否错误继承历史、relation/operation 是否正确、资源是否唯一且角色正确、patch 基线是否完整、operations 是否只含用户明确变化、未提及内容策略是否正确、是否过度澄清。返回审计后的一个完整 task_contract.v3；即使 confidence 降低也应如实修正。`;

const INTENT_REPAIR_SYSTEM_PROMPT = `你是 ChatUI 路由契约修复器。上一份输出已经表达了用户意图；不要改判操作、关系或资源语义，不要回答用户。只根据给出的候选资源和校验错误修复为完整、严格的 task_contract.v3 JSON。只能输出 JSON，不能输出 Markdown、解释、代码围栏或额外字段。`;

function strictObject(properties) {
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

const ROUTE_RESPONSE_FORMAT = Object.freeze({
  type: 'json_schema',
  json_schema: {
    name: 'chatui_task_contract_v3',
    strict: true,
    schema: strictObject({
      schema_version: { type: 'string', const: 'task_contract.v3' },
      operation: { type: 'string', enum: ['plain_chat', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr', 'text_to_image', 'image_reference_gen', 'edit_image', 'clarify'] },
      relation: { type: 'string', enum: ['new', 'followup', 'correction', 'continuation'] },
      resources: {
        type: 'array',
        items: strictObject({
          key: { type: 'string', pattern: '^r[1-9][0-9]*$' },
          type: { type: 'string', enum: ['image', 'file', 'text', 'message'] },
          source: { type: 'string', enum: ['current', 'quoted', 'history', 'context'] },
          role: { type: 'string', enum: ['source', 'target', 'reference', 'style_reference', 'mask', 'compare_a', 'compare_b', 'attachment', 'context'] },
          index: { type: 'integer', minimum: 1 },
          id: { type: 'string' },
          reference_id: { type: 'string' },
          missing: { type: 'boolean' },
        }),
      },
      directive: strictObject({
        mode: { type: 'string', enum: ['standalone', 'patch'] },
        base_resource_keys: { type: 'array', items: { type: 'string', pattern: '^r[1-9][0-9]*$' } },
        unmentioned_policy: { type: 'string', enum: ['preserve', 'allow_change'] },
        operations: { type: 'array', items: strictObject({ op: { type: 'string', enum: ['preserve', 'add', 'replace', 'remove'] }, target: { type: 'string' }, value: { type: 'string' } }) },
        constraints: { type: 'array', items: { type: 'string' } },
      }),
      clarification: strictObject({ question: { type: 'string' }, missing_resource_keys: { type: 'array', items: { type: 'string', pattern: '^r[1-9][0-9]*$' } } }),
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      review_reasons: { type: 'array', items: { type: 'string' } },
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

function executionPrompt(input = '') {
  // The contract selects media and validates intent. It must not turn into model-facing patch text.
  const prompt = promptComposer?.composeExecutionPrompt?.(input);
  if (typeof prompt === 'string') {
    return prompt.length > MAX_EXECUTION_PROMPT_LENGTH
      ? `${prompt.slice(0, MAX_EXECUTION_PROMPT_LENGTH - 1)}…`
      : prompt;
  }
  const text = String(input || '').trim();
  return text.length > MAX_EXECUTION_PROMPT_LENGTH
    ? `${text.slice(0, MAX_EXECUTION_PROMPT_LENGTH - 1)}…`
    : text;
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
    next = { ...next, contextualImagePrompt: executionPrompt(input) };
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
  const available = MAX_EXECUTION_PROMPT_LENGTH - currentPrompt.length - separator.length;
  if (available <= 0) return currentPrompt;
  const referencePrompt = messagePrompts.join('\n\n').slice(0, available).trimEnd();
  if (!referencePrompt) return currentPrompt;
  return executionPrompt(`${referencePrompt}${separator}${currentPrompt}`);
}

function isTaskContractResult(value = {}) {
  return typeof intentContract.hasExactContractShape === 'function'
    && intentContract.hasExactContractShape(value);
}

function bindExplicitQuotedMessage(task = {}, context = {}) {
  const quote = context?.quoted_message;
  if (!quote || typeof quote !== 'object') return task;
  // An explicit UI quote is already an unambiguous, user-selected message.
  // It is protocol data rather than a model inference: a plain-chat route
  // cannot legitimately discard it or turn it into an unrelated new task.
  // This does not infer anything from ordinary history and never changes the
  // operation or any media resource selected by the model.
  if (task?.operation !== 'plain_chat' || !Array.isArray(task?.resources)) return task;
  const directive = task?.directive;
  if (!directive || !Array.isArray(directive.base_resource_keys) || !Array.isArray(directive.operations) || !Array.isArray(directive.constraints)) return task;
  const index = Number(quote.index);
  if (!Number.isInteger(index) || index < 1) return task;
  const resources = [...task.resources];
  const bound = resources.find(resource => resource?.type === 'message' && resource?.source === 'history' && Number(resource?.index) === index && resource?.role === 'context' && resource?.missing === false);
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

function inspectRouteResult(text = '', options = {}) {
  const value = String(text || '').trim();
  if (!value) return { route: null, reason: 'empty_response' };
  try {
    const taskContract = bindExplicitQuotedMessage(JSON.parse(stripJsonFence(value)), options.context);
    if (!isTaskContractResult(taskContract)) return { route: null, reason: 'contract_shape' };
    const executionPlan = intentContract.taskContractToExecutionPlan(taskContract, { ...options, requireCandidateMatch: true });
    return { route: attachComposedPrompt(executionPlan, taskContract, options), reason: '' };
  } catch (error) {
    const message = String(error?.message || '');
    return { route: null, reason: /resource/i.test(message) ? 'resource_binding' : 'contract_semantics' };
  }
}

function parseRouteResult(text = '', options = {}) {
  return inspectRouteResult(text, options).route;
}

function needsIntentReview(route = {}, context = {}) {
  if (!route?.taskContract) return false;
  return intentContract?.needsIntentReview ? intentContract.needsIntentReview(route.taskContract, context) : false;
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

function buildRoutePayload({ model, input, attachments = [], context = {}, currentMode = 'chat', autoMode = true, systemPrompt = ROUTE_SYSTEM_PROMPT_WITH_OUTPUT_CHECK, responseFormat = ROUTE_RESPONSE_FORMAT } = {}) {
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

function buildIntentReviewPayload({ model, input, attachments = [], context = {}, firstRoute = null, systemPrompt = INTENT_REVIEW_SYSTEM_PROMPT, responseFormat = ROUTE_RESPONSE_FORMAT } = {}) {
  const payload = compactRouteUserPayload({ input, attachments, context, currentMode: 'chat', autoMode: true });
  if (firstRoute?.taskContract) payload.first_task_contract = firstRoute.taskContract;
  return {
    model,
    temperature: 0,
    ...(responseFormat ? { response_format: responseFormat } : {}),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  };
}

function buildIntentRepairPayload({ model, input, attachments = [], context = {}, previousOutput = '', validationReason = 'contract_shape', responseFormat = ROUTE_RESPONSE_FORMAT } = {}) {
  const payload = compactRouteUserPayload({ input, attachments, context, currentMode: 'chat', autoMode: true });
  payload.previous_route_output = String(previousOutput || '').slice(0, 12000);
  payload.contract_validation_error = String(validationReason || 'contract_shape');
  return {
    model,
    temperature: 0,
    ...(responseFormat ? { response_format: responseFormat } : {}),
    messages: [
      { role: 'system', content: INTENT_REPAIR_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  };
}

function extractRouteText(response = {}) {
  return response && response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content || response && response.output_text || '';
}

const api = Object.freeze({
  ROUTE_SYSTEM_PROMPT,
  ROUTE_OUTPUT_CONTRACT_CHECK,
  INTENT_REVIEW_SYSTEM_PROMPT,
  INTENT_REPAIR_SYSTEM_PROMPT,
  ROUTE_RESPONSE_FORMAT,
  cleanQuotedContent,
  buildQuotedImagePlaceholders,
  buildQuotedRouteContent,
  composeTextToImagePrompt,
  stripJsonFence,
  needsIntentReview,
  isTaskContractResult,
  inspectRouteResult,
  parseRouteResult,
  buildFileCandidatesFromAttachments,
  compactRoutePayloadContext,
  compactRouteUserPayload,
  buildRoutePayload,
  buildIntentReviewPayload,
  buildIntentRepairPayload,
  extractRouteText,
});

if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (root) root.ChatUIRouteService = api;
if (root?.window) root.window.ChatUIRouteService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
