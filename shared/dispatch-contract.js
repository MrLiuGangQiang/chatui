(function initChatUIDispatchContract(root, factory) {
  'use strict';

  const capabilityRegistry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('capabilityRegistry')
    || root?.ChatUICapabilityRegistry
    || (typeof require === 'function' ? require('./capability-registry') : {});
  const api = factory(capabilityRegistry);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('dispatchContract', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createChatUIDispatchContract(capabilityRegistry) {
  'use strict';

  const DISPATCH_CONTRACT_VERSION = 'dispatch_contract.v1';
  const VALID_RELATIONS = new Set(['new', 'followup', 'continuation']);
  const VALID_RESOURCE_TYPES = new Set(['image', 'file', 'text', 'message']);
  const VALID_SOURCES = new Set(['current', 'quoted', 'history', 'context']);
  const VALID_BINDING_ROLES = new Set([
    'target', 'reference', 'style_reference', 'mask',
    'source', 'attachment', 'context', 'compare_a', 'compare_b',
  ]);
  const VALID_HISTORY_POLICIES = new Set(['none', 'conversation', 'bound_only']);
  const PLAN_FIELDS = Object.freeze([
    'schema_version', 'operation', 'api', 'relation', 'arguments', 'bindings',
    'constraints', 'context_policy', 'idempotency_key',
  ]);
  const BINDING_FIELDS = Object.freeze(['key', 'type', 'role', 'resource_id', 'source']);
  const CONTEXT_POLICY_FIELDS = Object.freeze(['history', 'quoted', 'unbound_resources', 'message_resource_ids']);

  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

  function hasOnlyFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === fields.length && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
  }

  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }

  function stableStringify(value) {
    return JSON.stringify(stableValue(value));
  }

  function fnv1a32(value = '') {
    let hash = 0x811c9dc5;
    const input = String(value);
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  }

  function planWithoutIdempotency(plan = {}) {
    const clone = { ...plan };
    delete clone.idempotency_key;
    return clone;
  }

  function idempotencyKeyFor(plan = {}) {
    return `ep1-${fnv1a32(stableStringify(planWithoutIdempotency(plan)))}`;
  }

  function bindingTypeFromResourceId(resource = {}) {
    const resourceId = stringValue(
      resource.routeResourceId
      || resource.route_resource_id
      || resource.resource_id
      || resource.resourceId,
    ).toLowerCase();
    const match = resourceId.match(/^res:(image|file|message|text):/);
    return match ? match[1] : '';
  }

  function normalizedBindingType(resource = {}) {
    const explicit = stringValue(
      resource.routeResourceType
      || resource.route_resource_type
      || resource.resource_type
      || resource.resourceType
      || resource.binding_type
      || resource.bindingType,
    ).toLowerCase();
    if (VALID_RESOURCE_TYPES.has(explicit)) return explicit;

    const resourceIdType = bindingTypeFromResourceId(resource);
    if (VALID_RESOURCE_TYPES.has(resourceIdType)) return resourceIdType;

    const declared = stringValue(resource.type).toLowerCase();
    if (VALID_RESOURCE_TYPES.has(declared)) return declared;
    if (declared.startsWith('image/') || resource.is_image === true || resource.isImage === true) return 'image';
    if (declared.includes('/')
        || resource.file_data !== undefined
        || resource.fileData !== undefined
        || resource.filename
        || resource.fileName
        || resource.file_id
        || resource.fileId
        || resource.inputFile === true
        || resource.input_file === true) return 'file';
    if (resource.message_id || resource.messageId || resource.message_resource_id || resource.messageResourceId) return 'message';
    return declared;
  }

  function normalizedBinding(resource = {}) {
    return {
      key: stringValue(resource.routeResourceKey || resource.route_resource_key || resource.key),
      type: normalizedBindingType(resource),
      role: stringValue(resource.routeRole || resource.route_role || resource.bindingRole || resource.binding_role || resource.role),
      resource_id: stringValue(resource.routeResourceId || resource.route_resource_id || resource.resource_id || resource.resourceId),
      source: stringValue(resource.routeSource || resource.route_source || resource.source),
    };
  }

  // Resource bindings cross the browser upload boundary as one atomic contract.
  // Do not allow individual callers to pick a subset of these fields: the
  // execution plan validates all five values together on both sides.
  function hasRouteBindingMetadata(resource = {}) {
    return [
      'routeResourceKey', 'route_resource_key',
      'routeResourceType', 'route_resource_type',
      'routeRole', 'route_role', 'bindingRole', 'binding_role',
      'routeResourceId', 'route_resource_id',
      'routeSource', 'route_source',
    ].some(key => stringValue(resource?.[key]));
  }

  function routeBindingTransportFields(resource = {}) {
    if (!hasRouteBindingMetadata(resource)) return Object.freeze({});
    const binding = normalizedBinding(resource);
    if (!validateBinding(binding)) {
      throw validationError('Execution resource binding is incomplete', 'EXECUTION_RESOURCE_BINDING_INVALID');
    }
    return Object.freeze({
      routeResourceKey: binding.key,
      routeResourceType: binding.type,
      routeRole: binding.role,
      routeResourceId: binding.resource_id,
      routeSource: binding.source,
    });
  }

  function contextPolicyFor(relation = 'new', bindings = []) {
    const sources = new Set(bindings.map(binding => binding.source));
    const messageResourceIds = bindings
      .filter(binding => binding.type === 'message' && binding.resource_id)
      .map(binding => binding.resource_id);
    let history = 'none';
    if (messageResourceIds.length || sources.has('history') || sources.has('context')) history = 'bound_only';
    else if (relation !== 'new') history = 'conversation';
    return {
      history,
      quoted: sources.has('quoted'),
      unbound_resources: 'deny',
      message_resource_ids: [...new Set(messageResourceIds)],
    };
  }

  function validateBinding(binding = {}) {
    if (!hasOnlyFields(binding, BINDING_FIELDS)
        || !/^r[1-9]\d*$/.test(binding.key)
        || !VALID_RESOURCE_TYPES.has(binding.type)
        || !VALID_BINDING_ROLES.has(stringValue(binding.role))
        || !VALID_SOURCES.has(binding.source)) return false;
    if (binding.type !== 'text' && !stringValue(binding.resource_id)) return false;
    return binding.type === 'text' || /^res:[a-z]+:/.test(binding.resource_id);
  }

  function hasExactDispatchContract(plan = {}) {
    if (!hasOnlyFields(plan, PLAN_FIELDS)
        || plan.schema_version !== DISPATCH_CONTRACT_VERSION
        || !VALID_RELATIONS.has(plan.relation)
        || !Array.isArray(plan.bindings)
        || !Array.isArray(plan.constraints)
        || !hasOnlyFields(plan.context_policy, CONTEXT_POLICY_FIELDS)
        || !VALID_HISTORY_POLICIES.has(plan.context_policy.history)
        || typeof plan.context_policy.quoted !== 'boolean'
        || plan.context_policy.unbound_resources !== 'deny'
        || !Array.isArray(plan.context_policy.message_resource_ids)
        || new Set(plan.context_policy.message_resource_ids).size !== plan.context_policy.message_resource_ids.length
        || plan.context_policy.message_resource_ids.some(value => !stringValue(value))
        || plan.bindings.some(binding => !validateBinding(binding))
        || new Set(plan.bindings.map(binding => binding.key)).size !== plan.bindings.length
        || plan.constraints.some(value => !stringValue(value))) return false;
    const registered = capabilityRegistry.capabilityFor?.(plan.operation);
    if (!registered
        || plan.api !== registered.api
        || !capabilityRegistry.validateArguments?.(plan.operation, plan.arguments)
        || !capabilityRegistry.validateExecutionBindings?.(plan.operation, plan.bindings)) return false;
    return stringValue(plan.idempotency_key) === idempotencyKeyFor(plan);
  }

  function compileDispatchContract({
    operation = '', relation = 'new', input = '', prompt = input, parameterInput = input, defaults = {}, overrides = {},
    bindings = [], constraints = [],
  } = {}) {
    const normalizedOperation = stringValue(operation);
    const normalizedRelation = stringValue(relation) || 'new';
    if (!VALID_RELATIONS.has(normalizedRelation)) {
      const error = new TypeError(`Unsupported execution relation: ${normalizedRelation || '<missing>'}`);
      error.code = 'DISPATCH_CONTRACT_RELATION_INVALID';
      throw error;
    }
    const registered = capabilityRegistry.capabilityFor?.(normalizedOperation);
    if (!registered) {
      const error = new TypeError(`Unsupported execution operation: ${normalizedOperation}`);
      error.code = 'DISPATCH_CONTRACT_OPERATION_UNSUPPORTED';
      throw error;
    }
    // A dispatch plan can carry a richer routing envelope while preserving a
    // canonical provider prompt. Parameter authority remains separate so model
    // summaries and envelopes cannot reinterpret explicit user controls.
    const argumentResult = capabilityRegistry.resolveExecutionArguments?.({
      operation: normalizedOperation,
      input: parameterInput,
      prompt,
      defaults,
      overrides,
    });
    if (!argumentResult?.arguments) {
      const error = new TypeError(capabilityRegistry.clarificationQuestion?.(argumentResult) || 'Execution arguments are ambiguous or invalid');
      error.code = argumentResult?.conflicts?.length ? 'EXECUTION_ARGUMENT_AMBIGUOUS' : 'EXECUTION_ARGUMENT_INVALID';
      error.argumentResult = argumentResult;
      throw error;
    }
    const normalizedBindings = (Array.isArray(bindings) ? bindings : []).map(normalizedBinding);
    capabilityRegistry.assertExecutionBindings?.(normalizedOperation, normalizedBindings);
    const normalizedConstraints = (Array.isArray(constraints) ? constraints : [])
      .map(stringValue)
      .filter(Boolean);
    const plan = {
      schema_version: DISPATCH_CONTRACT_VERSION,
      operation: normalizedOperation,
      api: registered.api,
      relation: normalizedRelation,
      arguments: { ...argumentResult.arguments },
      bindings: normalizedBindings,
      constraints: normalizedConstraints,
      context_policy: contextPolicyFor(normalizedRelation, normalizedBindings),
      idempotency_key: '',
    };
    plan.idempotency_key = idempotencyKeyFor(plan);
    if (!hasExactDispatchContract(plan)) {
      const error = new TypeError('Compiled execution plan failed local validation');
      error.code = 'DISPATCH_CONTRACT_INVALID';
      throw error;
    }
    return deepFreeze(plan);
  }

  function withArguments(plan = {}, overrides = {}) {
    if (!hasExactDispatchContract(plan)) throw validationError('Invalid dispatch_contract.v1', 'DISPATCH_CONTRACT_INVALID');
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      throw validationError('Execution plan argument overrides must be an object', 'DISPATCH_CONTRACT_ARGUMENTS_INVALID');
    }
    const next = {
      ...plan,
      arguments: { ...plan.arguments, ...overrides },
      bindings: plan.bindings.map(binding => ({ ...binding })),
      constraints: [...plan.constraints],
      context_policy: { ...plan.context_policy, message_resource_ids: [...plan.context_policy.message_resource_ids] },
      idempotency_key: '',
    };
    next.idempotency_key = idempotencyKeyFor(next);
    if (!hasExactDispatchContract(next)) throw validationError('Materialized execution plan failed validation', 'DISPATCH_CONTRACT_ARGUMENTS_INVALID');
    return deepFreeze(next);
  }

  function bindingEvidenceFromMedia(executionMedia = {}) {
    const evidence = [];
    for (const group of ['images', 'files', 'messages']) {
      for (const item of Array.isArray(executionMedia?.[group]) ? executionMedia[group] : []) evidence.push(normalizedBinding(item));
    }
    return deepFreeze(evidence);
  }

  function normalizedEvidenceBinding(binding = {}) {
    return normalizedBinding(binding);
  }

  function sortedBindings(bindings = []) {
    return bindings.map(normalizedEvidenceBinding).sort((left, right) => left.key.localeCompare(right.key));
  }

  function assertExactBindingEvidence(expectedBindings = [], evidence = [], message = 'Execution binding evidence disagrees with the execution plan') {
    if (!Array.isArray(evidence)) throw validationError(message);
    const expected = sortedBindings(expectedBindings);
    const actual = sortedBindings(evidence);
    if (actual.some(binding => !validateBinding(binding))
        || new Set(actual.map(binding => binding.key)).size !== actual.length
        || stableStringify(actual) !== stableStringify(expected)) {
      throw validationError(message);
    }
    return true;
  }

  function assertBindingEvidence(plan = {}, evidence = [], { includeText = false } = {}) {
    return assertExactBindingEvidence(
      plan.bindings.filter(binding => includeText || binding.type !== 'text'),
      evidence,
    );
  }

  function textFromContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map(part => stringValue(part?.text || part?.input_text || part?.content || '')).filter(Boolean).join('\n');
  }

  function chatPayloadText(payload = {}, transportApi = 'chat') {
    const items = transportApi === 'responses' ? payload.input : payload.messages;
    return (Array.isArray(items) ? items : [])
      .filter(item => item?.role === 'user')
      .map(item => textFromContent(item.content))
      .filter(Boolean)
      .join('\n');
  }

  function instructionTextFromContent(content) {
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    const instructionPart = content.find(part => stringValue(
      part?.text || part?.input_text || part?.content || '',
    ));
    return stringValue(instructionPart?.text || instructionPart?.input_text || instructionPart?.content || '');
  }

  function lastUserPayloadText(payload = {}, transportApi = 'chat') {
    const items = transportApi === 'responses' ? payload.input : payload.messages;
    for (let index = (Array.isArray(items) ? items.length : 0) - 1; index >= 0; index -= 1) {
      if (items[index]?.role === 'user') return instructionTextFromContent(items[index].content);
    }
    return '';
  }

  function hasInlineAttachmentPrefix(value = '') {
    return /^\[\u9644\u4ef6(?:\uFF1A|:)[^\]]+\]/.test(String(value || '').trim());
  }

  function chatPromptMatchesPlan(expected = '', actual = '') {
    const planned = String(expected || '').trim();
    const wire = String(actual || '').trim();
    if (wire === planned) return true;
    if (!planned) return hasInlineAttachmentPrefix(wire);
    return wire.startsWith(`${planned}\n\n[\u9644\u4ef6\uFF1A`)
      || wire.startsWith(`${planned}\n\n[\u9644\u4ef6:`);
  }

  function chatPayloadItems(payload = {}, transportApi = 'chat') {
    const items = transportApi === 'responses' ? payload.input : payload.messages;
    return Array.isArray(items) ? items : [];
  }

  function isQuotedContextItem(item = {}) {
    return /<quoted_message(?:\s|>)/i.test(textFromContent(item?.content));
  }

  function hasAuthorizedWebSearchTool(plan = {}, payload = {}) {
    if (String(plan?.operation || '') !== 'web_search') return false;
    const tools = payload?.tools;
    return Array.isArray(tools)
      && tools.length === 1
      && tools[0]
      && typeof tools[0] === 'object'
      && !Array.isArray(tools[0])
      && Object.keys(tools[0]).length === 1
      && tools[0].type === 'web_search';
  }

  function assertChatContextMatchesPlan(plan = {}, payload = {}, transportApi = 'chat') {
    if (!hasExactDispatchContract(plan) || plan.api !== 'chat') {
      throw validationError('Invalid chat dispatch_contract.v1', 'DISPATCH_CONTRACT_INVALID');
    }
    const items = chatPayloadItems(payload, transportApi);
    if (!items.length) throw validationError('Chat payload is empty', 'EXECUTION_CONTEXT_INVALID');
    if (stringValue(payload.instructions)) {
      throw validationError('Top-level instructions are not authorized by the execution plan', 'EXECUTION_CONTEXT_CONTROL_FORBIDDEN');
    }
    const webSearchAuthorized = hasAuthorizedWebSearchTool(plan, payload);
    if (String(plan.operation || '') === 'web_search' && !webSearchAuthorized) {
      throw validationError('Web search execution plan requires the web_search tool', 'EXECUTION_CONTEXT_TOOL_MISMATCH');
    }
    for (const field of ['tools', 'tool_choice', 'functions', 'function_call']) {
      const value = payload[field];
      if (field === 'tools' && webSearchAuthorized) continue;
      if (value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0)) {
        throw validationError(`Chat payload ${field} is not authorized by the execution plan`, 'EXECUTION_CONTEXT_CONTROL_FORBIDDEN');
      }
    }
    if (items.some(item => !['system', 'user', 'assistant'].includes(String(item?.role || '')))) {
      throw validationError('Chat payload contains an unauthorized message role', 'EXECUTION_CONTEXT_ROLE_FORBIDDEN');
    }

    let currentUserIndex = -1;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index]?.role === 'user') { currentUserIndex = index; break; }
    }
    if (currentUserIndex < 0 || items.length !== currentUserIndex + 1) {
      throw validationError('Chat payload current user message is not the final conversational item', 'EXECUTION_CONTEXT_CURRENT_TURN_INVALID');
    }
    const history = items.slice(0, currentUserIndex).filter(item => ['user', 'assistant'].includes(item?.role));
    const quotedItems = history.filter(isQuotedContextItem);
    const policy = plan.context_policy || {};
    const expectedQuotedCount = policy.quoted === true ? 1 : 0;
    if (quotedItems.length !== expectedQuotedCount) {
      throw validationError('Quoted context disagrees with the execution plan', 'EXECUTION_CONTEXT_QUOTE_MISMATCH');
    }

    const messageBindings = plan.bindings.filter(binding => binding.type === 'message');
    const quotedMessageBindings = messageBindings.filter(binding => binding.source === 'quoted').length;
    const expectedBoundHistory = policy.message_resource_ids.length
      + (policy.quoted === true && quotedMessageBindings === 0 ? 1 : 0);
    if (policy.history === 'none' && history.length !== expectedQuotedCount) {
      throw validationError('Execution plan forbids conversation history', 'EXECUTION_CONTEXT_HISTORY_FORBIDDEN');
    }
    if (policy.history === 'bound_only' && history.length !== expectedBoundHistory) {
      throw validationError('Bound-only history count disagrees with the execution plan', 'EXECUTION_CONTEXT_BOUND_HISTORY_MISMATCH');
    }
    return true;
  }

  function chatPayloadMediaCounts(payload = {}, transportApi = 'chat') {
    const items = transportApi === 'responses' ? payload.input : payload.messages;
    // Resource bindings describe the current execution turn. Conversation history
    // may contain provider media from earlier turns, but those historical parts
    // are not evidence for the current plan and must not affect its media count.
    const currentUser = [...(Array.isArray(items) ? items : [])]
      .reverse()
      .find(item => item?.role === 'user');
    let images = 0;
    let files = 0;
    for (const part of Array.isArray(currentUser?.content) ? currentUser.content : []) {
      if (part?.type === 'image_url' || part?.type === 'input_image') images += 1;
      if (part?.type === 'input_file') files += 1;
    }
    return { images, files };
  }

  function normalizedComparableText(value = '') {
    return stringValue(value).replace(/\s+/g, ' ');
  }

  function validationError(message, code = 'DISPATCH_CONTRACT_PAYLOAD_MISMATCH') {
    const error = new TypeError(message);
    error.code = code;
    error.statusCode = 400;
    return error;
  }

  function assertPayloadMatchesDispatchContract(plan = {}, {
    payload = {}, transportApi = '', mode = '', files = [], masks = [], bindingEvidence = [], enforceContextPolicy = false,
  } = {}) {
    if (!hasExactDispatchContract(plan)) throw validationError('Invalid dispatch_contract.v1', 'DISPATCH_CONTRACT_INVALID');
    const expectedPrompt = String(plan.arguments.prompt || '').trim();
    if (plan.api === 'chat') {
      if (!['chat', 'responses'].includes(transportApi)) throw validationError('Chat execution plan cannot use this transport');
      const actualText = lastUserPayloadText(payload, transportApi);
      if (!chatPromptMatchesPlan(expectedPrompt, actualText)) throw validationError('Chat payload user instruction disagrees with the execution plan');
      const mediaCounts = chatPayloadMediaCounts(payload, transportApi);
      const imageBindings = plan.bindings.filter(binding => binding.type === 'image').length;
      const fileBindings = plan.bindings.filter(binding => binding.type === 'file').length;
      if (mediaCounts.images !== imageBindings || mediaCounts.files !== fileBindings) {
        throw validationError('Chat payload attachment count disagrees with planned bindings');
      }
      assertBindingEvidence(plan, bindingEvidence);
      if (enforceContextPolicy) assertChatContextMatchesPlan(plan, payload, transportApi);
      return true;
    }

    const expectedMode = plan.api === 'image_edit' ? 'edit_image' : 'image';
    if (mode !== expectedMode) throw validationError('Image job mode disagrees with the execution plan');
    const actualPrompt = normalizedComparableText(payload.prompt);
    if (normalizedComparableText(expectedPrompt) !== actualPrompt) throw validationError('Image payload prompt disagrees with the execution plan');
    const optionalFields = [
      ['size', 'size'], ['quality', 'quality'], ['background', 'background'], ['output_format', 'output_format'], ['count', 'n'],
    ];
    for (const [argumentName, payloadName] of optionalFields) {
      const expected = plan.arguments[argumentName];
      const actual = payload[payloadName];
      const omittedDefault = expected === 'auto' && (actual === undefined || actual === null || actual === '' || actual === 'auto')
        || argumentName === 'count' && expected === 1 && (actual === undefined || actual === null || actual === 1);
      if (!omittedDefault && actual !== expected) throw validationError(`Image payload ${payloadName} disagrees with the execution plan`);
    }
    const supplied = bindingEvidenceFromMedia({
      images: [
        ...(Array.isArray(files) ? files : []),
        ...(Array.isArray(masks) ? masks : []).map(file => ({ ...file, routeRole: file.routeRole || file.role || 'mask' })),
      ],
    });
    assertBindingEvidence(plan, bindingEvidence);
    assertExactBindingEvidence(
      plan.bindings.filter(binding => binding.type === 'image'),
      supplied,
      'Image files disagree with the execution plan bindings',
    );
    return true;
  }

  return Object.freeze({
    DISPATCH_CONTRACT_VERSION,
    PLAN_FIELDS,
    BINDING_FIELDS,
    CONTEXT_POLICY_FIELDS,
    stableStringify,
    idempotencyKeyFor,
    hasExactDispatchContract,
    compileDispatchContract,
    withArguments,
    bindingEvidenceFromMedia,
    routeBindingTransportFields,
    assertBindingEvidence,
    assertPayloadMatchesDispatchContract,
    chatPayloadText,
    lastUserPayloadText,
    chatPromptMatchesPlan,
    chatPayloadMediaCounts,
    chatPayloadItems,
    isQuotedContextItem,
    assertChatContextMatchesPlan,
  });
});

