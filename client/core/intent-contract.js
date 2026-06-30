(function initChatUIIntentContract(root) {
  'use strict';

  const VALID_INTENTS = new Set(['chat', 'vision_qa', 'image.generate', 'image.edit', 'file.qa', 'clarify', 'refuse']);
  const VALID_TASK_TYPES = new Set(['new_task', 'followup', 'correction', 'continuation']);
  const VALID_APIS = new Set(['chat', 'vision', 'image_generation', 'image_edit', 'clarify', 'refuse']);
  const VALID_OPERATIONS = new Set(['plain_chat', 'file_qa', 'image_qa', 'ocr', 'text_to_image', 'image_reference_gen', 'edit_image', 'clarify', 'refuse']);
  const VALID_TARGET_TYPES = new Set(['none', 'current_image', 'previous_image', 'quoted_image', 'uploaded_file', 'history_file']);
  const VALID_SOURCES = new Set(['none', 'current', 'quoted', 'history']);

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
      ocr: 'vision_qa',
      file_qa: 'file.qa',
      unsafe: 'refuse',
      unknown: '',
    }[raw] || raw;
    return VALID_INTENTS.has(mapped) ? mapped : 'chat';
  }

  function executionForIntent(intent = 'chat', operation = '') {
    const op = String(operation || '').trim();
    if (intent === 'image.generate') return { api: 'image_generation', operation: VALID_OPERATIONS.has(op) && op !== 'image_edit' ? op : 'text_to_image' };
    if (intent === 'image.edit') return { api: 'image_edit', operation: 'edit_image' };
    if (intent === 'vision_qa') return { api: 'vision', operation: op === 'ocr' ? 'ocr' : 'image_qa' };
    if (intent === 'file.qa') return { api: 'chat', operation: 'file_qa' };
    if (intent === 'clarify') return { api: 'clarify', operation: 'clarify' };
    if (intent === 'refuse') return { api: 'refuse', operation: 'refuse' };
    return { api: 'chat', operation: 'plain_chat' };
  }

  function targetTypeForRoute(route = {}) {
    const mode = route.mode || '';
    const target = route.target || 'none';
    const source = route.operation?.scope || route.image_source || route.imageSource || route.target || 'none';
    if (mode === 'edit_image') {
      if (target === 'previous' || target === 'last_generated' || target === 'latest') return 'previous_image';
      if (target === 'uploaded' || source === 'current') return 'current_image';
      if (source === 'quoted') return 'quoted_image';
    }
    if (mode === 'image' && (route.imageRefs?.length || route.image_refs?.length)) {
      if (source === 'quoted') return 'quoted_image';
      if (source === 'history') return 'previous_image';
      return 'current_image';
    }
    if (route.fileRefs?.length || route.file_refs?.length) return source === 'history' ? 'history_file' : 'uploaded_file';
    return 'none';
  }

  function sourceForRoute(route = {}) {
    const source = route.operation?.scope || route.image_source || route.imageSource || '';
    if (VALID_SOURCES.has(source)) return source;
    const target = route.target || '';
    if (target === 'uploaded') return 'current';
    if (target === 'previous' || target === 'latest' || target === 'last_generated') return 'history';
    return 'none';
  }

  function normalizePromptPlan(plan = {}, fallback = {}) {
    return {
      current_user_intent: compactString(plan.current_user_intent || plan.currentUserIntent || fallback.currentUserIntent || fallback.input || '', 1200),
      context_to_preserve: compactString(plan.context_to_preserve || plan.contextToPreserve || fallback.contextToPreserve || '', 1600),
      constraints: list(plan.constraints || fallback.constraints).map(item => compactString(item, 400)).filter(Boolean).slice(0, 12),
      do_not_add: list(plan.do_not_add || plan.doNotAdd || fallback.doNotAdd).map(item => compactString(item, 300)).filter(Boolean).slice(0, 8),
      final_instruction: compactString(plan.final_instruction || plan.finalInstruction || fallback.finalInstruction || '', 2400),
    };
  }

  function normalizeTarget(target = {}, route = {}) {
    const type = VALID_TARGET_TYPES.has(target.type) ? target.type : targetTypeForRoute(route);
    const source = VALID_SOURCES.has(target.source) ? target.source : sourceForRoute(route);
    const selectedIndexes = normalizeIndexes(target.selected_indexes || target.selectedIndexes || route.selectedIndexes || route.selected_indexes);
    return {
      type,
      source,
      selected_indexes: selectedIndexes,
      required: !!target.required,
      missing: !!target.missing,
    };
  }

  function normalizeClarification(value = {}, route = {}) {
    return {
      needed: !!(value.needed || value.need_clarification || route.needClarification || route.need_clarification),
      question: compactString(value.question || value.clarification_question || route.clarificationQuestion || route.clarification_question || '', 600),
    };
  }

  function normalizeTaskContract(input = {}, options = {}) {
    const route = options.route || input.routeInfo || input.route || {};
    const mode = input.mode || route.mode || '';
    let intent = normalizeIntentName(input.intent || route.intent || '');
    if (!input.intent && !route.intent) {
      if (mode === 'image') intent = 'image.generate';
      else if (mode === 'edit_image') intent = 'image.edit';
      else if (route.operation?.type === 'file_qa') intent = 'file.qa';
      else if (['image_qa', 'ocr'].includes(route.operation?.type)) intent = 'vision_qa';
      else intent = 'chat';
    }
    const clarification = normalizeClarification(input.clarification || {}, route);
    if (clarification.needed) intent = 'clarify';
    const taskType = VALID_TASK_TYPES.has(input.task_type || input.taskType) ? (input.task_type || input.taskType) : 'new_task';
    const execution = input.execution && typeof input.execution === 'object'
      ? { api: input.execution.api, operation: input.execution.operation }
      : executionForIntent(intent, route.operation?.type || input.operation);
    if (!VALID_APIS.has(execution.api)) execution.api = executionForIntent(intent).api;
    if (!VALID_OPERATIONS.has(execution.operation)) execution.operation = executionForIntent(intent).operation;
    const promptPlan = normalizePromptPlan(input.prompt_plan || input.promptPlan || {}, {
      input: options.input,
      finalInstruction: route.contextualImagePrompt || route.contextual_image_prompt || route.editInstruction || route.edit_instruction || route.operation?.prompt || route.operation?.edit_instruction || options.input || '',
    });
    return {
      intent,
      task_type: taskType,
      target: normalizeTarget(input.target || {}, route),
      execution,
      prompt_plan: promptPlan,
      clarification,
      confidence: clampConfidence(input.confidence ?? route.confidence),
      reason: compactString(input.reason || route.evidence || route.reason || '', 800),
    };
  }

  function routeToTaskContract(route = {}, options = {}) {
    return normalizeTaskContract({ routeInfo: route, confidence: route.confidence, reason: route.evidence }, { ...options, route });
  }

  function taskContractToRouteInput(task = {}, options = {}) {
    const normalized = normalizeTaskContract(task, options);
    const prompt = normalized.prompt_plan.final_instruction || options.input || '';
    if (normalized.intent === 'clarify') {
      return { mode: 'chat', target: 'none', need_clarification: true, clarification_question: normalized.clarification.question || '请补充必要信息。', confidence: normalized.confidence, evidence: normalized.reason };
    }
    if (normalized.intent === 'refuse') {
      return { mode: 'chat', target: 'none', need_clarification: true, clarification_question: normalized.clarification.question || '抱歉，这个请求我不能帮助处理。', confidence: normalized.confidence || 1, evidence: normalized.reason };
    }
    if (normalized.intent === 'image.generate') {
      return { mode: 'image', target: 'new', operation: { type: normalized.execution.operation || 'text_to_image', scope: normalized.target.source || 'none', prompt, edit_instruction: '' }, contextual_image_prompt: prompt, intent: normalized.execution.operation || 'text_to_image', selected_indexes: normalized.target.selected_indexes, confidence: normalized.confidence, evidence: normalized.reason };
    }
    if (normalized.intent === 'image.edit') {
      return { mode: 'edit_image', target: normalized.target.type === 'previous_image' ? 'previous' : 'uploaded', operation: { type: 'image_edit', scope: normalized.target.source || 'current', prompt: '', edit_instruction: prompt }, edit_instruction: prompt, intent: 'image_edit', selected_indexes: normalized.target.selected_indexes, confidence: normalized.confidence, evidence: normalized.reason };
    }
    if (normalized.intent === 'vision_qa') {
      return { mode: 'chat', target: 'none', operation: { type: normalized.execution.operation === 'ocr' ? 'ocr' : 'image_qa', scope: normalized.target.source || 'current', prompt: options.input || prompt, edit_instruction: '' }, selected_indexes: normalized.target.selected_indexes, confidence: normalized.confidence, evidence: normalized.reason };
    }
    if (normalized.intent === 'file.qa') {
      return { mode: 'chat', target: 'none', operation: { type: 'file_qa', scope: normalized.target.source || 'current', prompt: options.input || prompt, edit_instruction: '' }, confidence: normalized.confidence, evidence: normalized.reason };
    }
    return { mode: 'chat', target: 'none', operation: { type: 'plain_chat', scope: 'none', prompt: options.input || prompt, edit_instruction: '' }, confidence: normalized.confidence, evidence: normalized.reason };
  }

  function needsIntentReview(task = {}, context = {}) {
    const normalized = normalizeTaskContract(task);
    if (normalized.confidence > 0 && normalized.confidence < 0.62) return true;
    if (normalized.intent === 'clarify') return true;
    const hasToolContext = !!(context?.last_generated_image || context?.latest_assistant_image_result || context?.latest_image_reference || (Array.isArray(context?.image_candidates) && context.image_candidates.length) || (Array.isArray(context?.file_candidates) && context.file_candidates.length));
    if (normalized.intent === 'chat' && hasToolContext) return true;
    if (['image.edit', 'vision_qa'].includes(normalized.intent) && normalized.target.required && normalized.target.missing) return true;
    return false;
  }

  const api = Object.freeze({
    VALID_INTENTS,
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
