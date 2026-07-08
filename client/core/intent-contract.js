(function initChatUIIntentContract(root) {
  'use strict';

  const VALID_INTENTS = new Set(['chat', 'vision_qa', 'image.generate', 'image.edit', 'file.qa', 'multi_step', 'clarify', 'refuse']);
  const VALID_TASK_TYPES = new Set(['new_task', 'followup', 'correction', 'continuation']);
  const VALID_APIS = new Set(['chat', 'vision', 'image_generation', 'image_edit', 'clarify', 'refuse', 'multi_step']);
  const VALID_OPERATIONS = new Set(['plain_chat', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr', 'text_to_image', 'image_reference_gen', 'edit_image', 'analyze_then_generate', 'analyze_then_edit', 'clarify', 'refuse']);
  const VALID_RESOURCE_TYPES = new Set(['image', 'file', 'text', 'message']);
  const VALID_RESOURCE_SOURCES = new Set(['current', 'quoted', 'history', 'none', 'context']);
  const VALID_RESOURCE_ROLES = new Set(['source', 'target', 'reference', 'style_reference', 'mask', 'compare_a', 'compare_b', 'attachment', 'context', 'output']);
  const VALID_STEP_DEPENDS = new Set(['previous', 'all']);
  const LEGACY_TARGET_TYPES = new Set(['none', 'current_image', 'previous_image', 'quoted_image', 'uploaded_file', 'history_file']);
  const LEGACY_SOURCES = new Set(['none', 'current', 'quoted', 'history']);

  function clampConfidence(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 0;
  }

  function compactString(value = '', max = 2000) {
    const text = String(value || '').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
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

  function normalizeIntentName(value = '') {
    const raw = String(value || '').trim();
    const mapped = {
      image_generate: 'image.generate',
      image_generation: 'image.generate',
      text_to_image: 'image.generate',
      image_reference_gen: 'image.generate',
      image_edit: 'image.edit',
      edit_image: 'image.edit',
      vision: 'vision_qa',
      image_qa: 'vision_qa',
      image_compare: 'vision_qa',
      ocr: 'vision_qa',
      file_qa: 'file.qa',
      unsafe: 'refuse',
      unknown: '',
    }[raw] || raw;
    return VALID_INTENTS.has(mapped) ? mapped : 'chat';
  }

  function operationForIntent(intent = 'chat', operation = '') {
    const op = String(operation || '').trim();
    if (VALID_OPERATIONS.has(op)) return op;
    if (intent === 'image.generate') return 'text_to_image';
    if (intent === 'image.edit') return 'edit_image';
    if (intent === 'vision_qa') return 'image_qa';
    if (intent === 'file.qa') return 'file_qa';
    if (intent === 'multi_step') return 'analyze_then_generate';
    if (intent === 'clarify') return 'clarify';
    if (intent === 'refuse') return 'refuse';
    return 'plain_chat';
  }

  function executionForIntent(intent = 'chat', operation = '') {
    const op = operationForIntent(intent, operation);
    if (intent === 'image.generate') return { api: 'image_generation', operation: op === 'edit_image' ? 'text_to_image' : op };
    if (intent === 'image.edit') return { api: 'image_edit', operation: 'edit_image' };
    if (intent === 'vision_qa') return { api: 'vision', operation: ['ocr', 'image_compare'].includes(op) ? op : 'image_qa' };
    if (intent === 'file.qa') return { api: 'chat', operation: op === 'multimodal_qa' ? 'multimodal_qa' : 'file_qa' };
    if (intent === 'multi_step') return { api: 'multi_step', operation: op };
    if (intent === 'clarify') return { api: 'clarify', operation: 'clarify' };
    if (intent === 'refuse') return { api: 'refuse', operation: 'refuse' };
    return { api: 'chat', operation: 'plain_chat' };
  }

  function normalizePromptPlan(plan = {}, fallback = {}) {
    return {
      current_user_intent: compactString(plan.current_user_intent || plan.currentUserIntent || fallback.currentUserIntent || fallback.input || '', 1200),
      context_to_preserve: compactString(plan.context_to_preserve || plan.contextToPreserve || fallback.contextToPreserve || '', 1600),
      constraints: list(plan.constraints || fallback.constraints).map(item => compactString(item, 400)).filter(Boolean).slice(0, 16),
      do_not_add: list(plan.do_not_add || plan.doNotAdd || fallback.doNotAdd).map(item => compactString(item, 300)).filter(Boolean).slice(0, 12),
      final_instruction: compactString(plan.final_instruction || plan.finalInstruction || fallback.finalInstruction || '', 3200),
    };
  }

  function normalizeResource(resource = {}, index = 0) {
    const type = VALID_RESOURCE_TYPES.has(resource.type) ? resource.type : (resource.file_id || resource.fileId || resource.name ? 'file' : 'image');
    const source = VALID_RESOURCE_SOURCES.has(resource.source) ? resource.source : 'current';
    const role = VALID_RESOURCE_ROLES.has(resource.role) ? resource.role : (type === 'image' ? 'source' : 'attachment');
    const selectedIndex = Number(resource.index || resource.selected_index || resource.selectedIndex) || index + 1;
    return {
      id: compactString(resource.id || resource.image_id || resource.imageId || resource.file_id || resource.fileId || '', 240),
      type,
      source,
      role,
      index: Number.isInteger(selectedIndex) && selectedIndex >= 1 ? selectedIndex : index + 1,
      reference_id: compactString(resource.reference_id || resource.referenceId || '', 240),
      target: compactString(resource.target || '', 80),
      name: compactString(resource.name || resource.filename || '', 240),
      required: resource.required !== false,
      missing: !!resource.missing,
    };
  }

  function normalizeResources(value = [], route = {}) {
    const raw = list(value);
    const result = raw.map(normalizeResource);
    if (result.length) return result;
    const imageRefs = list(route.image_refs || route.imageRefs);
    if (imageRefs.length) return imageRefs.map((ref, index) => normalizeResource({ ...ref, type: 'image', role: ref.role || 'source' }, index));
    const fileRefs = list(route.file_refs || route.fileRefs);
    if (fileRefs.length) return fileRefs.map((ref, index) => normalizeResource({ ...ref, type: 'file', role: ref.role || 'attachment' }, index));
    const source = route.operation?.scope || route.image_source || route.imageSource || '';
    const selected = normalizeIndexes(route.selectedIndexes || route.selected_indexes);
    if (['image', 'edit_image'].includes(route.mode) || ['image_qa', 'ocr', 'image_compare', 'image_reference_gen', 'image_edit'].includes(route.operation?.type)) {
      const role = route.mode === 'edit_image' || route.operation?.type === 'image_edit' ? 'target' : route.operation?.type === 'image_reference_gen' ? 'reference' : 'source';
      return (selected.length ? selected : [1]).map((item, index) => normalizeResource({ type: 'image', source: LEGACY_SOURCES.has(source) && source !== 'none' ? source : 'current', role, index: item }, index));
    }
    return [];
  }

  function normalizeStep(step = {}, index = 0, fallbackOperation = '') {
    const operation = operationForIntent('', step.operation || fallbackOperation || 'plain_chat');
    const dependsOn = list(step.depends_on || step.dependsOn).map(item => compactString(item, 80)).filter(Boolean).slice(0, 8);
    return {
      id: compactString(step.id || `step_${index + 1}`, 80),
      operation,
      input_roles: list(step.input_roles || step.inputRoles).map(item => compactString(item, 80)).filter(Boolean).slice(0, 12),
      output_role: compactString(step.output_role || step.outputRole || 'output', 80),
      prompt: compactString(step.prompt || step.instruction || '', 1600),
      depends_on: dependsOn.filter(item => VALID_STEP_DEPENDS.has(item) || /^step_\d+$/.test(item)),
    };
  }

  function normalizeSteps(value = [], execution = {}, resources = [], promptPlan = {}) {
    const raw = list(value);
    if (raw.length) return raw.map((step, index) => normalizeStep(step, index, execution.operation));
    if (execution.api === 'multi_step') {
      const firstOp = execution.operation === 'analyze_then_edit' ? 'image_qa' : 'image_qa';
      const secondOp = execution.operation === 'analyze_then_edit' ? 'edit_image' : 'text_to_image';
      return [
        normalizeStep({ id: 'step_1', operation: firstOp, input_roles: resources.map(item => item.role), output_role: 'analysis', prompt: promptPlan.current_user_intent }, 0),
        normalizeStep({ id: 'step_2', operation: secondOp, input_roles: ['analysis'], output_role: 'output', prompt: promptPlan.final_instruction, depends_on: ['step_1'] }, 1),
      ];
    }
    return [normalizeStep({ id: 'step_1', operation: execution.operation, input_roles: resources.map(item => item.role), output_role: 'output', prompt: promptPlan.final_instruction }, 0)];
  }

  function normalizeClarification(value = {}, route = {}) {
    return {
      needed: !!(value.needed || value.need_clarification || route.needClarification || route.need_clarification),
      question: compactString(value.question || value.clarification_question || route.clarificationQuestion || route.clarification_question || '', 600),
      missing_resources: list(value.missing_resources || value.missingResources).map(item => compactString(item, 80)).filter(Boolean).slice(0, 8),
    };
  }

  function legacyTargetFromResources(resources = []) {
    const first = resources.find(item => item.type === 'image' || item.type === 'file');
    if (!first) return { type: 'none', source: 'none', selected_indexes: [], required: false, missing: false };
    let type = 'none';
    if (first.type === 'file') type = first.source === 'history' ? 'history_file' : 'uploaded_file';
    else if (first.source === 'quoted') type = 'quoted_image';
    else if (first.source === 'history') type = 'previous_image';
    else if (first.source === 'current') type = 'current_image';
    return {
      type: LEGACY_TARGET_TYPES.has(type) ? type : 'none',
      source: LEGACY_SOURCES.has(first.source) ? first.source : 'none',
      selected_indexes: normalizeIndexes(resources.map(item => item.index)),
      required: resources.some(item => item.required),
      missing: resources.some(item => item.missing),
    };
  }

  function normalizeLegacyTarget(target = {}, resources = []) {
    const fallback = legacyTargetFromResources(resources);
    const type = LEGACY_TARGET_TYPES.has(target.type) ? target.type : fallback.type;
    const source = LEGACY_SOURCES.has(target.source) ? target.source : fallback.source;
    const selectedIndexes = normalizeIndexes(target.selected_indexes || target.selectedIndexes || fallback.selected_indexes);
    return { type, source, selected_indexes: selectedIndexes, required: !!target.required || fallback.required, missing: !!target.missing || fallback.missing };
  }

  function normalizeTaskContract(input = {}, options = {}) {
    const route = options.route || input.routeInfo || input.route || {};
    const mode = input.mode || route.mode || '';
    let intent = normalizeIntentName(input.intent || route.intent || '');
    const resources = normalizeResources(input.resources || route.resources, route);
    const operationInput = input.operation || input.execution?.operation || route.operation?.type || route.intent || '';
    if (!input.intent && !route.intent) {
      if (mode === 'image') intent = 'image.generate';
      else if (mode === 'edit_image') intent = 'image.edit';
      else if (route.operation?.type === 'file_qa') intent = 'file.qa';
      else if (['image_qa', 'ocr', 'image_compare'].includes(route.operation?.type)) intent = 'vision_qa';
      else intent = 'chat';
    }
    const clarification = normalizeClarification(input.clarification || {}, route);
    if (clarification.needed) intent = 'clarify';
    const taskType = VALID_TASK_TYPES.has(input.task_type || input.taskType) ? (input.task_type || input.taskType) : 'new_task';
    let execution = input.execution && typeof input.execution === 'object'
      ? { api: input.execution.api, operation: input.execution.operation }
      : executionForIntent(intent, operationInput);
    if (!VALID_APIS.has(execution.api)) execution.api = executionForIntent(intent).api;
    if (!VALID_OPERATIONS.has(execution.operation)) execution.operation = executionForIntent(intent).operation;
    const promptPlan = normalizePromptPlan(input.prompt_plan || input.promptPlan || {}, {
      input: options.input,
      finalInstruction: route.contextualImagePrompt || route.contextual_image_prompt || route.editInstruction || route.edit_instruction || route.operation?.prompt || route.operation?.edit_instruction || options.input || '',
    });
    const steps = normalizeSteps(input.steps, execution, resources, promptPlan);
    return {
      schema_version: 'task_contract.v2',
      intent,
      task_type: taskType,
      execution,
      operation: execution.operation,
      resources,
      steps,
      target: normalizeLegacyTarget(input.target || {}, resources),
      prompt_plan: promptPlan,
      clarification,
      confidence: clampConfidence(input.confidence ?? route.confidence),
      reason: compactString(input.reason || route.evidence || route.reason || '', 800),
    };
  }

  function routeToTaskContract(route = {}, options = {}) {
    return normalizeTaskContract({ routeInfo: route, confidence: route.confidence, reason: route.evidence }, { ...options, route });
  }

  function resourceRefs(task = {}, type = 'image') {
    return list(task.resources).filter(item => item.type === type).map(item => ({
      role: item.role,
      image_id: type === 'image' ? item.id : '',
      file_id: type === 'file' ? item.id : '',
      reference_id: item.reference_id,
      index: item.index,
      target: item.target || (item.source === 'history' ? 'previous' : item.source === 'current' ? 'uploaded' : ''),
      source: item.source,
      name: item.name,
    }));
  }

  function taskContractToRouteInput(task = {}, options = {}) {
    const normalized = normalizeTaskContract(task, options);
    const prompt = normalized.prompt_plan.final_instruction || options.input || '';
    const imageRefs = resourceRefs(normalized, 'image');
    const fileRefs = resourceRefs(normalized, 'file');
    const firstImage = normalized.resources.find(item => item.type === 'image');
    if (normalized.intent === 'clarify') {
      return { mode: 'chat', target: 'none', operation: { type: 'clarify', scope: 'none', prompt, edit_instruction: '' }, need_clarification: true, clarification_question: normalized.clarification.question || '请补充必要信息。', resources: normalized.resources, image_refs: imageRefs, file_refs: fileRefs, confidence: normalized.confidence, evidence: normalized.reason };
    }
    if (normalized.intent === 'refuse') {
      return { mode: 'chat', target: 'none', operation: { type: 'refuse', scope: 'none', prompt, edit_instruction: '' }, need_clarification: true, clarification_question: normalized.clarification.question || '抱歉，这个请求我不能帮助处理。', resources: normalized.resources, image_refs: imageRefs, file_refs: fileRefs, confidence: normalized.confidence || 1, evidence: normalized.reason };
    }
    if (normalized.intent === 'image.generate') {
      return { mode: 'image', target: 'new', operation: { type: normalized.execution.operation || 'text_to_image', scope: firstImage?.source || 'none', prompt, edit_instruction: '' }, contextual_image_prompt: prompt, intent: normalized.execution.operation || 'text_to_image', resources: normalized.resources, image_refs: imageRefs, selected_indexes: normalized.target.selected_indexes, confidence: normalized.confidence, evidence: normalized.reason };
    }
    if (normalized.intent === 'image.edit') {
      const target = firstImage?.source === 'history' ? 'previous' : firstImage?.source === 'quoted' ? 'previous' : 'uploaded';
      return { mode: 'edit_image', target, operation: { type: 'image_edit', scope: firstImage?.source || 'current', prompt: '', edit_instruction: prompt }, edit_instruction: prompt, intent: 'image_edit', resources: normalized.resources, image_refs: imageRefs, selected_indexes: normalized.target.selected_indexes, selected_reference_id: firstImage?.reference_id || '', selected_image_ids: imageRefs.map(ref => ref.image_id).filter(Boolean), use_previous_image: firstImage?.source === 'history', confidence: normalized.confidence, evidence: normalized.reason };
    }
    if (normalized.intent === 'vision_qa') {
      return { mode: 'chat', target: 'none', operation: { type: normalized.execution.operation === 'ocr' ? 'ocr' : normalized.execution.operation === 'image_compare' ? 'image_compare' : 'image_qa', scope: firstImage?.source || normalized.target.source || 'current', prompt: options.input || prompt, edit_instruction: '' }, resources: normalized.resources, image_refs: imageRefs, selected_indexes: normalized.target.selected_indexes, selected_image_ids: imageRefs.map(ref => ref.image_id).filter(Boolean), confidence: normalized.confidence, evidence: normalized.reason };
    }
    if (normalized.intent === 'file.qa') {
      const firstFile = normalized.resources.find(item => item.type === 'file');
      return { mode: 'chat', target: 'none', operation: { type: normalized.execution.operation === 'multimodal_qa' ? 'multimodal_qa' : 'file_qa', scope: firstFile?.source || normalized.target.source || 'current', prompt: options.input || prompt, edit_instruction: '' }, resources: normalized.resources, image_refs: imageRefs, file_refs: fileRefs, confidence: normalized.confidence, evidence: normalized.reason };
    }
    if (normalized.intent === 'multi_step') {
      return { mode: 'chat', target: 'none', operation: { type: normalized.execution.operation, scope: firstImage?.source || 'context', prompt: options.input || prompt, edit_instruction: '' }, resources: normalized.resources, image_refs: imageRefs, file_refs: fileRefs, tasks: normalized.steps, confidence: normalized.confidence, evidence: normalized.reason };
    }
    return { mode: 'chat', target: 'none', operation: { type: 'plain_chat', scope: 'none', prompt: options.input || prompt, edit_instruction: '' }, resources: normalized.resources, confidence: normalized.confidence, evidence: normalized.reason };
  }

  function needsIntentReview(task = {}, context = {}) {
    const normalized = normalizeTaskContract(task);
    if (normalized.confidence > 0 && normalized.confidence < 0.62) return true;
    if (normalized.intent === 'clarify') return true;
    if (normalized.resources.some(item => item.required && item.missing)) return true;
    const hasToolContext = !!(context?.last_generated_image || context?.latest_assistant_image_result || context?.latest_image_reference || (Array.isArray(context?.image_candidates) && context.image_candidates.length) || (Array.isArray(context?.file_candidates) && context.file_candidates.length));
    if (normalized.intent === 'chat' && hasToolContext) return true;
    return false;
  }

  const api = Object.freeze({
    VALID_INTENTS,
    VALID_OPERATIONS,
    VALID_RESOURCE_TYPES,
    VALID_RESOURCE_SOURCES,
    VALID_RESOURCE_ROLES,
    normalizeResource,
    normalizeTaskContract,
    routeToTaskContract,
    taskContractToRouteInput,
    needsIntentReview,
    executionForIntent,
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUICoreIntentContract = api;
  if (root?.window) root.window.ChatUICoreIntentContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
