(function initChatUIIntentContract(root) {
  'use strict';

  const VALID_INTENTS = new Set(['chat', 'vision_qa', 'image.generate', 'image.edit', 'file.qa', 'clarify', 'refuse']);
  const VALID_TASK_TYPES = new Set(['new_task', 'followup', 'correction', 'continuation']);
  const VALID_APIS = new Set(['chat', 'vision', 'image_generation', 'image_edit', 'clarify', 'refuse']);
  const VALID_OPERATIONS = new Set(['plain_chat', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr', 'text_to_image', 'image_reference_gen', 'edit_image', 'clarify', 'refuse']);
  const VALID_RESOURCE_TYPES = new Set(['image', 'file', 'text', 'message']);
  const VALID_RESOURCE_SOURCES = new Set(['current', 'quoted', 'history', 'context']);
  const VALID_RESOURCE_ROLES = new Set(['source', 'target', 'reference', 'style_reference', 'mask', 'compare_a', 'compare_b', 'attachment', 'context']);
  const VALID_STEP_DEPENDS = new Set(['previous', 'all']);
  const CANONICAL_TOP_LEVEL_FIELDS = new Set(['schema_version', 'intent', 'task_type', 'execution', 'resources', 'steps', 'prompt_plan', 'clarification', 'confidence', 'needs_review', 'reason']);
  const CANONICAL_EXECUTION_FIELDS = new Set(['api', 'operation']);
  const CANONICAL_RESOURCE_FIELDS = new Set(['id', 'type', 'source', 'role', 'index', 'reference_id', 'name', 'required', 'missing']);
  const CANONICAL_STEP_FIELDS = new Set(['id', 'operation', 'input_roles', 'output_role', 'prompt', 'depends_on']);
  const CANONICAL_PROMPT_PLAN_FIELDS = new Set(['current_user_intent', 'context_to_preserve', 'constraints', 'do_not_add', 'final_instruction']);
  const CANONICAL_CLARIFICATION_FIELDS = new Set(['needed', 'question', 'missing_resources']);

  const OPERATIONS_BY_INTENT = Object.freeze({
    chat: new Set(['plain_chat']),
    vision_qa: new Set(['image_qa', 'image_compare', 'ocr']),
    'image.generate': new Set(['text_to_image', 'image_reference_gen']),
    'image.edit': new Set(['edit_image']),
    'file.qa': new Set(['file_qa', 'multimodal_qa']),
    clarify: new Set(['clarify']),
    refuse: new Set(['refuse']),
  });

  const API_BY_INTENT = Object.freeze({
    chat: 'chat',
    vision_qa: 'vision',
    'image.generate': 'image_generation',
    'image.edit': 'image_edit',
    'file.qa': 'chat',
    clarify: 'clarify',
    refuse: 'refuse',
  });

  const DEFAULT_OPERATION_BY_INTENT = Object.freeze({
    chat: 'plain_chat',
    vision_qa: 'image_qa',
    'image.generate': 'text_to_image',
    'image.edit': 'edit_image',
    'file.qa': 'file_qa',
    clarify: 'clarify',
    refuse: 'refuse',
  });

  function clampConfidence(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 0;
  }

  function compactString(value = '', max = 2000) {
    const text = String(value || '').trim();
    return text.length > max ? `${text.slice(0, max)}?` : text;
  }

  function list(value) {
    return Array.isArray(value) ? value.filter(item => item !== undefined && item !== null) : [];
  }

  function normalizeIndexes(value = []) {
    const indexes = [];
    for (const item of list(value)) {
      const index = Number(item);
      if (Number.isInteger(index) && index >= 1 && !indexes.includes(index)) indexes.push(index);
    }
    return indexes;
  }

  function operationForIntent(intent = 'chat', operation = '') {
    const canonicalIntent = VALID_INTENTS.has(intent) ? intent : 'chat';
    const requested = String(operation || '').trim();
    return OPERATIONS_BY_INTENT[canonicalIntent].has(requested)
      ? requested
      : DEFAULT_OPERATION_BY_INTENT[canonicalIntent];
  }

  function executionForIntent(intent = 'chat', operation = '') {
    const canonicalIntent = VALID_INTENTS.has(intent) ? intent : 'chat';
    return {
      api: API_BY_INTENT[canonicalIntent],
      operation: operationForIntent(canonicalIntent, operation),
    };
  }

  function normalizePromptPlan(plan = {}, fallbackInput = '', taskType = 'new_task') {
    return {
      current_user_intent: compactString(plan.current_user_intent || fallbackInput, 1200),
      context_to_preserve: taskType === 'new_task' ? '' : compactString(plan.context_to_preserve, 1600),
      constraints: list(plan.constraints).map(item => compactString(item, 400)).filter(Boolean).slice(0, 16),
      do_not_add: list(plan.do_not_add).map(item => compactString(item, 300)).filter(Boolean).slice(0, 12),
      final_instruction: compactString(plan.final_instruction || plan.current_user_intent || fallbackInput, 3200),
    };
  }

  function normalizeResource(resource = {}, index = 0) {
    const type = VALID_RESOURCE_TYPES.has(resource.type) ? resource.type : 'text';
    const source = VALID_RESOURCE_SOURCES.has(resource.source) ? resource.source : 'current';
    const role = VALID_RESOURCE_ROLES.has(resource.role) ? resource.role : (type === 'file' ? 'attachment' : 'source');
    const selectedIndex = Number(resource.index);
    return {
      id: compactString(resource.id, 240),
      type,
      source,
      role,
      index: Number.isInteger(selectedIndex) && selectedIndex >= 1 ? selectedIndex : index + 1,
      reference_id: compactString(resource.reference_id, 240),
      name: compactString(resource.name, 240),
      required: resource.required !== false,
      missing: resource.missing === true,
    };
  }

  function normalizeStep(step = {}, index = 0, fallbackOperation = 'plain_chat') {
    const operation = VALID_OPERATIONS.has(step.operation) ? step.operation : fallbackOperation;
    const dependsOn = list(step.depends_on).map(item => compactString(item, 80)).filter(Boolean).slice(0, 8);
    return {
      id: compactString(step.id || `step_${index + 1}`, 80),
      operation,
      input_roles: list(step.input_roles).map(item => compactString(item, 80)).filter(Boolean).slice(0, 12),
      output_role: compactString(step.output_role || 'output', 80),
      prompt: compactString(step.prompt, 1600),
      depends_on: dependsOn.filter(item => VALID_STEP_DEPENDS.has(item) || /^step_\d+$/.test(item)),
    };
  }

  function normalizeClarification(value = {}) {
    return {
      needed: value.needed === true,
      question: compactString(value.question, 600),
      missing_resources: list(value.missing_resources).map(item => compactString(item, 80)).filter(Boolean).slice(0, 8),
    };
  }

  function normalizeTaskContract(input = {}, options = {}) {
    const intent = VALID_INTENTS.has(input.intent) ? input.intent : 'chat';
    const taskType = VALID_TASK_TYPES.has(input.task_type) ? input.task_type : 'new_task';
    const execution = executionForIntent(intent, input.execution?.operation);
    const resources = list(input.resources)
      .map(normalizeResource)
      .filter(resource => taskType !== 'new_task' || resource.source === 'current');
    const promptPlan = normalizePromptPlan(input.prompt_plan || {}, options.input || '', taskType);
    const clarification = normalizeClarification(input.clarification || {});
    return {
      schema_version: 'task_contract.v2',
      intent: clarification.needed ? 'clarify' : intent,
      task_type: taskType,
      execution: clarification.needed ? executionForIntent('clarify', 'clarify') : execution,
      resources,
      steps: list(input.steps).map((step, index) => normalizeStep(step, index, execution.operation)),
      prompt_plan: promptPlan,
      clarification,
      confidence: clampConfidence(input.confidence),
      needs_review: input.needs_review === true,
      reason: compactString(input.reason, 800),
    };
  }

  function hasExactContractShape(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (!Object.keys(value).every(field => CANONICAL_TOP_LEVEL_FIELDS.has(field))) return false;
    if (value.schema_version !== 'task_contract.v2') return false;
    if (!VALID_INTENTS.has(value.intent) || !VALID_TASK_TYPES.has(value.task_type)) return false;
    if (!value.execution || typeof value.execution !== 'object' || Array.isArray(value.execution)) return false;
    if (!Object.keys(value.execution).every(field => CANONICAL_EXECUTION_FIELDS.has(field))) return false;
    if (!VALID_APIS.has(value.execution.api) || !VALID_OPERATIONS.has(value.execution.operation)) return false;
    const expectedExecution = executionForIntent(value.intent, value.execution.operation);
    if (value.execution.api !== expectedExecution.api || value.execution.operation !== expectedExecution.operation) return false;
    if (!Array.isArray(value.resources) || !Array.isArray(value.steps)) return false;
    if (!value.prompt_plan || typeof value.prompt_plan !== 'object' || Array.isArray(value.prompt_plan)) return false;
    if (!value.clarification || typeof value.clarification !== 'object' || Array.isArray(value.clarification)) return false;
    if (!Number.isFinite(Number(value.confidence)) || typeof value.needs_review !== 'boolean' || typeof value.reason !== 'string') return false;
    const plan = value.prompt_plan;
    if (!Object.keys(plan).every(field => CANONICAL_PROMPT_PLAN_FIELDS.has(field))) return false;
    if (typeof plan.current_user_intent !== 'string' || typeof plan.context_to_preserve !== 'string' || !Array.isArray(plan.constraints) || !Array.isArray(plan.do_not_add) || typeof plan.final_instruction !== 'string') return false;
    const clarification = value.clarification;
    if (!Object.keys(clarification).every(field => CANONICAL_CLARIFICATION_FIELDS.has(field))) return false;
    if (typeof clarification.needed !== 'boolean' || typeof clarification.question !== 'string' || !Array.isArray(clarification.missing_resources)) return false;
    if (value.intent === 'clarify' !== clarification.needed) return false;
    for (const resource of value.resources) {
      if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return false;
      if (!Object.keys(resource).every(field => CANONICAL_RESOURCE_FIELDS.has(field))) return false;
      if (!VALID_RESOURCE_TYPES.has(resource.type) || !VALID_RESOURCE_SOURCES.has(resource.source) || !VALID_RESOURCE_ROLES.has(resource.role)) return false;
      if (!Number.isInteger(Number(resource.index)) || Number(resource.index) < 1) return false;
      if (typeof resource.required !== 'boolean' || typeof resource.missing !== 'boolean') return false;
      if (resource.id !== undefined && typeof resource.id !== 'string') return false;
      if (resource.reference_id !== undefined && typeof resource.reference_id !== 'string') return false;
      if (resource.name !== undefined && typeof resource.name !== 'string') return false;
    }
    for (const step of value.steps) {
      if (!step || typeof step !== 'object' || Array.isArray(step)) return false;
      if (!Object.keys(step).every(field => CANONICAL_STEP_FIELDS.has(field))) return false;
      if (typeof step.id !== 'string' || !VALID_OPERATIONS.has(step.operation) || !Array.isArray(step.input_roles) || typeof step.output_role !== 'string' || typeof step.prompt !== 'string' || !Array.isArray(step.depends_on)) return false;
    }
    return true;
  }

  function resourceRefs(task = {}, type = 'image', context = {}) {
    const candidates = type === 'image' ? list(context.image_candidates) : list(context.file_candidates);
    return list(task.resources).filter(item => item.type === type).map(item => {
      const candidate = candidates.find(entry => {
        const entryId = type === 'image' ? entry.image_id : entry.file_id;
        if (item.id && entryId === item.id) return true;
        if (type === 'image' && item.reference_id && entry.reference_id === item.reference_id && Number(entry.index) === Number(item.index)) return true;
        return Number(entry.index) === Number(item.index) && entry.source === item.source;
      }) || {};
      return {
        role: item.role,
        image_id: type === 'image' ? item.id || candidate.image_id || '' : '',
        file_id: type === 'file' ? item.id || candidate.file_id || '' : '',
        reference_id: item.reference_id || candidate.reference_id || '',
        index: Number(candidate.source_index) || Number(candidate.index) || item.index,
        target: item.source === 'history' || item.source === 'quoted' ? 'previous' : 'uploaded',
        source: item.source,
        name: item.name || candidate.name || '',
      };
    });
  }

  function taskContractToExecutionRoute(task = {}, options = {}) {
    const normalized = normalizeTaskContract(task, options);
    const prompt = normalized.prompt_plan.final_instruction || options.input || '';
    const imageRefs = resourceRefs(normalized, 'image', options.context || {});
    const fileRefs = resourceRefs(normalized, 'file', options.context || {});
    const firstImage = normalized.resources.find(item => item.type === 'image');
    const selectedIndexes = normalizeIndexes([...imageRefs, ...fileRefs].map(item => item.index));
    if (normalized.intent === 'clarify') {
      return { task_type: normalized.task_type, mode: 'chat', target: 'none', operation: { type: 'clarify', scope: 'none', prompt: '', edit_instruction: '' }, need_clarification: true, clarification_question: normalized.clarification.question || '?????????????', resources: normalized.resources, image_refs: imageRefs, file_refs: fileRefs, confidence: normalized.confidence, evidence: normalized.reason };
    }
    if (normalized.intent === 'refuse') {
      return { task_type: normalized.task_type, mode: 'chat', target: 'none', operation: { type: 'refuse', scope: 'none', prompt, edit_instruction: '' }, need_clarification: true, clarification_question: normalized.clarification.question || '???????????????', resources: normalized.resources, image_refs: imageRefs, file_refs: fileRefs, confidence: normalized.confidence || 1, evidence: normalized.reason };
    }
    if (normalized.intent === 'image.generate') {
      return { task_type: normalized.task_type, mode: 'image', target: 'new', operation: { type: normalized.execution.operation, scope: firstImage?.source || 'none', prompt, edit_instruction: '' }, contextual_image_prompt: prompt, intent: normalized.execution.operation, resources: normalized.resources, image_refs: imageRefs, selected_indexes: selectedIndexes, confidence: normalized.confidence, evidence: normalized.reason };
    }
    if (normalized.intent === 'image.edit') {
      const target = ['history', 'quoted'].includes(firstImage?.source) ? 'previous' : 'uploaded';
      return { task_type: normalized.task_type, mode: 'edit_image', target, operation: { type: 'image_edit', scope: firstImage?.source || 'current', prompt: '', edit_instruction: prompt }, edit_instruction: prompt, intent: 'image_edit', resources: normalized.resources, image_refs: imageRefs, selected_indexes: selectedIndexes, selected_reference_id: firstImage?.reference_id || '', selected_image_ids: imageRefs.map(ref => ref.image_id).filter(Boolean), use_previous_image: ['history', 'quoted'].includes(firstImage?.source), confidence: normalized.confidence, evidence: normalized.reason };
    }
    if (normalized.intent === 'vision_qa') {
      return { task_type: normalized.task_type, mode: 'chat', target: 'none', operation: { type: normalized.execution.operation, scope: firstImage?.source || 'current', prompt: options.input || prompt, edit_instruction: '' }, resources: normalized.resources, image_refs: imageRefs, selected_indexes: selectedIndexes, selected_image_ids: imageRefs.map(ref => ref.image_id).filter(Boolean), confidence: normalized.confidence, evidence: normalized.reason };
    }
    if (normalized.intent === 'file.qa') {
      const firstFile = normalized.resources.find(item => item.type === 'file');
      return { task_type: normalized.task_type, mode: 'chat', target: 'none', operation: { type: normalized.execution.operation, scope: firstFile?.source || 'current', prompt: options.input || prompt, edit_instruction: '' }, resources: normalized.resources, image_refs: imageRefs, file_refs: fileRefs, confidence: normalized.confidence, evidence: normalized.reason };
    }
    return { task_type: normalized.task_type, mode: 'chat', target: 'none', operation: { type: 'plain_chat', scope: 'none', prompt: options.input || prompt, edit_instruction: '' }, resources: normalized.resources, confidence: normalized.confidence, evidence: normalized.reason };
  }

  function needsIntentReview(task = {}, context = {}) {
    const normalized = normalizeTaskContract(task);
    if (normalized.needs_review) return true;
    if (normalized.confidence > 0 && normalized.confidence < 0.62) return true;
    if (normalized.intent === 'clarify') return true;
    if (normalized.resources.some(item => item.required && item.missing)) return true;
    const hasToolContext = !!(context?.last_generated_image || context?.latest_assistant_image_result || context?.latest_image_reference || (Array.isArray(context?.image_candidates) && context.image_candidates.length) || (Array.isArray(context?.file_candidates) && context.file_candidates.length));
    return normalized.intent === 'chat' && hasToolContext;
  }

  const api = Object.freeze({
    VALID_INTENTS,
    VALID_TASK_TYPES,
    VALID_APIS,
    VALID_OPERATIONS,
    VALID_RESOURCE_TYPES,
    VALID_RESOURCE_SOURCES,
    VALID_RESOURCE_ROLES,
    hasExactContractShape,
    normalizeResource,
    normalizeTaskContract,
    taskContractToExecutionRoute,
    needsIntentReview,
    executionForIntent,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUICoreIntentContract = api;
  if (root?.window) root.window.ChatUICoreIntentContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
