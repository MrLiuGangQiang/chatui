(function initChatUIClarificationAnswer(root, factory) {
  'use strict';

  const clarificationRelation = root?.[Symbol.for('chatui.module-registry.v1')]?.get('clarificationRelation')
    || root?.ChatUIClarificationRelation
    || (typeof require === 'function' ? require('./clarification-relation') : {});
  const api = factory(clarificationRelation, root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('clarificationAnswer', api);
  // Browser service alias used by the application workflows.
  if (root) root.ChatUIClarificationService = api;
  if (root?.window) root.window.ChatUIClarificationService = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function createChatUIClarificationAnswer(clarificationRelation, root) {
  'use strict';

  const CLARIFICATION_ANSWER_VERSION = 'clarification_answer.v1';
  const ANSWER_FIELDS = Object.freeze(['schema_version', 'clarification_id', 'answers', 'free_text']);
  const SELECTION_FIELDS = Object.freeze(['resource_key', 'choice_key']);
  const RESOURCE_KEY_PATTERN = /^[rp][1-9]\d*$/;
  const CHOICE_KEY_PATTERN = /^[cv][1-9]\d*$/;

  function stringValue(value = '') {
    return String(value ?? '').trim();
  }

  function hasOnlyFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === fields.length && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  }

  function normalizeSelection(value = {}) {
    return {
      resource_key: stringValue(value.resource_key || value.resourceKey),
      choice_key: stringValue(value.choice_key || value.choiceKey),
    };
  }

  function hasExactClarificationAnswer(value = {}) {
    if (!hasOnlyFields(value, ANSWER_FIELDS)
        || value.schema_version !== CLARIFICATION_ANSWER_VERSION
        || !stringValue(value.clarification_id)
        || !Array.isArray(value.answers)
        || typeof value.free_text !== 'string') return false;
    const resourceKeys = new Set();
    for (const selection of value.answers) {
      if (!hasOnlyFields(selection, SELECTION_FIELDS)
          || !RESOURCE_KEY_PATTERN.test(selection.resource_key)
          || !CHOICE_KEY_PATTERN.test(selection.choice_key)
          || resourceKeys.has(selection.resource_key)) return false;
      resourceKeys.add(selection.resource_key);
    }
    return true;
  }

  function createClarificationAnswer({ clarificationId = '', answers = [], freeText = '' } = {}) {
    const answer = {
      schema_version: CLARIFICATION_ANSWER_VERSION,
      clarification_id: stringValue(clarificationId),
      answers: (Array.isArray(answers) ? answers : []).map(normalizeSelection),
      free_text: String(freeText ?? ''),
    };
    if (!hasExactClarificationAnswer(answer)) {
      const error = new TypeError('Invalid clarification_answer.v1');
      error.code = 'CLARIFICATION_ANSWER_INVALID';
      throw error;
    }
    return deepFreeze(answer);
  }

  function assertClarificationId(answer = {}, clarificationId = '') {
    const expected = stringValue(clarificationId);
    if (!hasExactClarificationAnswer(answer) || expected && answer.clarification_id !== expected) {
      const error = new TypeError(expected && answer?.clarification_id !== expected
        ? 'Clarification answer does not belong to the active clarification'
        : 'Invalid clarification_answer.v1');
      error.code = expected && answer?.clarification_id !== expected
        ? 'CLARIFICATION_ANSWER_ID_MISMATCH'
        : 'CLARIFICATION_ANSWER_INVALID';
      throw error;
    }
    return true;
  }

  function mergeClarificationAnswers(base = null, addition = null, { clarificationId = '' } = {}) {
    const expectedId = stringValue(clarificationId || addition?.clarification_id || base?.clarification_id);
    if (base) assertClarificationId(base, expectedId);
    if (addition) assertClarificationId(addition, expectedId);
    const selections = new Map();
    for (const selection of base?.answers || []) selections.set(selection.resource_key, normalizeSelection(selection));
    for (const selection of addition?.answers || []) selections.set(selection.resource_key, normalizeSelection(selection));
    return createClarificationAnswer({
      clarificationId: expectedId,
      answers: [...selections.values()],
      freeText: String(addition?.free_text || base?.free_text || ''),
    });
  }

  function slotChoices(slots = []) {
    return (Array.isArray(slots) ? slots : []).filter(slot => slot && typeof slot === 'object' && Array.isArray(slot.choices));
  }

  function choiceForOrdinal(slot = {}, ordinal = 0) {
    const index = Number(ordinal) - 1;
    return Number.isInteger(index) && index >= 0 ? slot.choices?.[index] || null : null;
  }

  function choiceForToken(slot = {}, token = '') {
    const normalized = stringValue(token).toLowerCase();
    if (!normalized) return null;
    const byKey = (slot.choices || []).find(choice => stringValue(choice?.key).toLowerCase() === normalized);
    if (byKey) return byKey;
    if (/^[a-z]$/.test(normalized)) return choiceForOrdinal(slot, normalized.charCodeAt(0) - 96);
    const ordinal = normalized.match(/^(?:第\s*)?(\d+)(?:\s*(?:个|项|张|号))?$/);
    return ordinal ? choiceForOrdinal(slot, Number(ordinal[1])) : null;
  }

  function choiceForRelativePosition(slot = {}, token = '') {
    const normalized = stringValue(token)
      .trim()
      .toLowerCase()
      .replace(/[。．、,，!?！？]+$/g, '')
      .replace(/[呢啊呀吧嘛]+$/g, '')
      .trim();
    if (!normalized) return null;
    const isLast = /^(?:最后|最末|末尾)(?:\s*(?:第?\s*一\s*)?(?:(?:个|项|张|幅|份|条)\s*)?(?:图片|图像|照片|图|文件|附件|文档|选项)?)?$/.test(normalized)
      || /^倒数\s*(?:第?\s*)?一(?:\s*(?:(?:个|项|张|幅|份|条)\s*)?(?:图片|图像|照片|图|文件|附件|文档|选项)?)?$/.test(normalized)
      || /^(?:the\s+)?(?:last|final)(?:\s+(?:one|item|option|image|picture|photo|file|document))?$/.test(normalized);
    if (!isLast) return null;
    const choices = Array.isArray(slot?.choices) ? slot.choices : [];
    return choices[choices.length - 1] || null;
  }

  function parseJsonAnswer(text = '') {
    const value = stringValue(text);
    if (!value.startsWith('{') || !value.endsWith('}')) return null;
    try {
      const parsed = JSON.parse(value);
      return hasExactClarificationAnswer(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

    function parseInlineMultiSlot(text, slots) {
    var available = slotChoices(slots || []);
    if (available.length < 1) return null;

    var byLabel = new Map();
    var byPurpose = new Map();
    for (var i = 0; i < available.length; i++) {
      var slot = available[i];
      var l = stringValue(slot.label).toLowerCase();
      if (l) byLabel.set(l, slot);
      var keywords = { target: ['编辑','修改','目标','被修改','改','修'], reference: ['参考','参照','依据','来源','照着','模仿'], style_reference: ['风格','样式','配色','风格化'], source: ['来源','输入','原图','素材'], attachment: ['文件','附件','文档'] };
      var kw = keywords[slot.role] || [];
      for (var k = 0; k < kw.length; k++) byPurpose.set(kw[k], slot);
    }

    var segments = text.split(/[,，;；\s]+/).filter(function(s) { return s.trim(); });
    if (segments.length < 1) return null;

    var selections = [];
    var seen = new Set();

    for (var s = 0; s < segments.length; s++) {
      var seg = segments[s].trim().toLowerCase();
      if (!seg) continue;

      var matchedSlot = null;
      var matchLen = 0;

      byLabel.forEach(function(slot, label) {
        if (label && seg.indexOf(label) >= 0 && label.length > matchLen) {
          matchedSlot = slot;
          matchLen = label.length;
        }
      });

      if (!matchedSlot) {
        byPurpose.forEach(function(slot, keyword) {
          if (seg.indexOf(keyword) >= 0 && keyword.length > matchLen) {
            matchedSlot = slot;
            matchLen = keyword.length;
          }
        });
      }

      if (!matchedSlot) continue;

      var choicePattern = /(?:选|选择|为|[:=])\s*(?:第\s*)?([a-z]|\d+|[一二三四五六七八九十])\s*(?:个|张|项|号)?/i;
      var choiceMatch = seg.match(choicePattern);
      if (!choiceMatch) continue;

      var cnNum = { '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '十': '10' };
      var choiceToken = cnNum[choiceMatch[1]] || choiceMatch[1];
      var choice = choiceForToken(matchedSlot, choiceToken);
      var resourceKey = stringValue(matchedSlot.key);
      if (!choice || seen.has(resourceKey)) continue;
      seen.add(resourceKey);
      selections.push({ resource_key: resourceKey, choice_key: stringValue(choice.key) });
    }

    return selections.length ? selections : null;
  }

  function parseExplicitPairs(text = '', slots = []) {
    const byKey = new Map(slotChoices(slots).map(slot => [stringValue(slot.key), slot]));
    const selections = [];
    const seen = new Set();
    const pattern = /\b([rp][1-9]\d*)\s*(?:=|:|：|->|→)\s*([cv][1-9]\d*|[a-z]|\d+)\b/gi;
    let match;
    while ((match = pattern.exec(text))) {
      const resourceKey = stringValue(match[1]).toLowerCase();
      const slot = byKey.get(resourceKey);
      const choice = slot ? choiceForToken(slot, match[2]) : null;
      if (!slot || !choice || seen.has(resourceKey)) return null;
      seen.add(resourceKey);
      selections.push({ resource_key: resourceKey, choice_key: stringValue(choice.key) });
    }
    return selections;
  }

  function parseGroupedOrdinals(text = '', slots = []) {
    const available = slotChoices(slots);
    const selections = [];
    const seen = new Set();
    const pattern = /(?:第\s*)?(\d+)\s*(?:组|项)\s*(?:选|选择|为|是|[:：=])\s*(?:第\s*)?([a-z]|\d+)\s*(?:个|项|张|号)?/gi;
    let match;
    while ((match = pattern.exec(text))) {
      const slot = available[Number(match[1]) - 1];
      const choice = slot ? choiceForToken(slot, match[2]) : null;
      const resourceKey = stringValue(slot?.key);
      if (!slot || !choice || seen.has(resourceKey)) return null;
      seen.add(resourceKey);
      selections.push({ resource_key: resourceKey, choice_key: stringValue(choice.key) });
    }
    return selections;
  }

  function clarificationAnswerInputKind(input, { slots = [] } = {}) {
    if (input && typeof input === 'object' && !Array.isArray(input)) return 'structured_object';
    const text = stringValue(input);
    if (!text) return '';
    if (text.startsWith('{') || text.endsWith('}')) return 'structured_json';
    if (/\b[rlp][1-9]\d*\s*(?:=|:|：|->|→)/i.test(text)) return 'keyed_selection';
    if (/(?:第\s*)?\d+\s*(?:组|项)\s*(?:选|选择|为|是|[:：=])/i.test(text)) return 'grouped_selection';
    const available = slotChoices(slots).filter(slot => slot.choices.length > 0);
    if (available.length === 1 && (
      /^(?:第\s*)?(?:[a-z]|\d+)(?:\s*(?:个|项|张|号))?$/i.test(text)
      || !!choiceForRelativePosition(available[0], text)
    )) return 'single_selection';
    if (/(?:编辑|修改|目标|参考|参照|风格|样式|来源|输入|附件|文件).*(?:选|选择|为|[:：=])\s*(?:第\s*)?(?:[a-z]|\d+|[一二三四五六七八九十])/i.test(text)) {
      return 'labelled_selection';
    }
    return '';
  }

  function looksLikeClarificationAnswerInput(input, options = {}) {
    return !!clarificationAnswerInputKind(input, options);
  }

  function parseClarificationAnswer(input, { clarificationId = '', slots = [], existingAnswer = null } = {}) {
    const expectedId = stringValue(clarificationId || existingAnswer?.clarification_id);
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      assertClarificationId(input, expectedId);
      return existingAnswer
        ? mergeClarificationAnswers(existingAnswer, input, { clarificationId: expectedId })
        : deepFreeze(input);
    }
    const text = stringValue(input);
    if (!text || !expectedId) return null;
    const jsonAnswer = parseJsonAnswer(text);
    if (jsonAnswer) {
      assertClarificationId(jsonAnswer, expectedId);
      return existingAnswer
        ? mergeClarificationAnswers(existingAnswer, jsonAnswer, { clarificationId: expectedId })
        : deepFreeze(jsonAnswer);
    }

    const available = slotChoices(slots).filter(slot => slot.choices.length > 0);
    if (!available.length) return null;
    let selections = parseExplicitPairs(text, available);
    if (!selections?.length) selections = parseGroupedOrdinals(text, available);
    if (!selections?.length) selections = parseInlineMultiSlot(text, slots);
    if (!selections?.length && available.length === 1) {
      const choice = choiceForToken(available[0], text) || choiceForRelativePosition(available[0], text);
      if (choice) selections = [{ resource_key: stringValue(available[0].key), choice_key: stringValue(choice.key) }];
    }
    if (!selections?.length) return null;
    const parsed = createClarificationAnswer({ clarificationId: expectedId, answers: selections, freeText: text });
    return existingAnswer
      ? mergeClarificationAnswers(existingAnswer, parsed, { clarificationId: expectedId })
      : parsed;
  }

  function applyClarificationAnswer(answer = {}, slots = [], { clarificationId = '' } = {}) {
    assertClarificationId(answer, clarificationId);
    const normalizedSlots = slotChoices(slots);
    const byKey = new Map(normalizedSlots.map(slot => [stringValue(slot.key), slot]));
    const selections = [];
    for (const selected of answer.answers) {
      const slot = byKey.get(selected.resource_key);
      const choice = slot?.choices?.find(item => stringValue(item?.key) === selected.choice_key);
      if (!slot || !choice) {
        const error = new TypeError(`Unknown clarification selection ${selected.resource_key}=${selected.choice_key}`);
        error.code = 'CLARIFICATION_ANSWER_UNKNOWN_CHOICE';
        throw error;
      }
      selections.push({ resource_key: selected.resource_key, choice_key: selected.choice_key, slot, choice });
    }
    const selectedKeys = new Set(selections.map(item => item.resource_key));
    const remainingSlots = normalizedSlots.filter(slot => !selectedKeys.has(stringValue(slot.key)));
    const selectedParameters = {};
    const selectedResources = [];
    for (const selection of selections) {
      const { slot, choice } = selection;
      if (slot.type === 'parameter') {
        const parameterName = stringValue(slot.parameter_name || slot.parameterName);
        if (!parameterName || !Object.prototype.hasOwnProperty.call(choice, 'value')) {
          const error = new TypeError(`Parameter clarification slot ${slot.key || ''} is incomplete`);
          error.code = 'CLARIFICATION_PARAMETER_SLOT_INVALID';
          throw error;
        }
        selectedParameters[parameterName] = choice.value;
      } else {
        selectedResources.push({
          resource_key: selection.resource_key,
          choice_key: selection.choice_key,
          type: stringValue(slot.type),
          role: stringValue(slot.role),
          source: stringValue(choice.source),
          index: Number(choice.index) || 0,
          id: stringValue(choice.id),
          resource_id: stringValue(choice.resource_id || choice.resourceId),
          reference_id: stringValue(choice.reference_id || choice.referenceId),
          label: stringValue(choice.label),
        });
      }
    }
    return deepFreeze({
      answer,
      selections,
      selectedParameters,
      selectedResources,
      remainingSlots,
      complete: normalizedSlots.length > 0 && remainingSlots.length === 0,
    });
  }

  // ── Pending clarification lifecycle ──────────────────────────────────────
  function randomId(prefix = 'clarify') {
    const uuid = root?.crypto?.randomUUID?.();
    if (uuid) return `${prefix}_${uuid}`;
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function fnv1a(text = '') {
    let hash = 0x811c9dc5;
    const input = String(text || '');
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  function latestUserText(messages = []) {
    const list = Array.isArray(messages) ? messages : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index];
      if (String(message?.role || '') !== 'user') continue;
      const text = stringValue(message?.rawText || message?.content || message?.text);
      if (text) return text;
    }
    return '';
  }

  function clarificationSlotsFor(pending = {}) {
    const direct = pending?.routeInfo?.clarificationSlots;
    return Array.isArray(direct) ? direct : [];
  }

  // Early route compilers emitted semantic argument keys such as
  // r_arg_size / v_1024x1024. Those are domain values masquerading as
  // protocol identifiers, so they cannot cross the strict answer boundary.
  // Migrate only that historical shape to opaque pN/vN identifiers while
  // retaining the argument metadata that gives the selection its meaning.
  function normalizeClarificationSlots(slots = []) {
    const input = Array.isArray(slots) ? slots : [];
    const usedParameterKeys = new Set(input
      .map(slot => stringValue(slot?.key))
      .filter(key => /^p[1-9]\d*$/.test(key)));
    let nextParameterKey = 1;
    const nextKey = () => {
      while (usedParameterKeys.has(`p${nextParameterKey}`)) nextParameterKey += 1;
      const key = `p${nextParameterKey}`;
      usedParameterKeys.add(key);
      nextParameterKey += 1;
      return key;
    };
    return input.map(slot => {
      if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return slot;
      const legacyKey = stringValue(slot.key);
      const legacyParameter = legacyKey.match(/^r_arg_([A-Za-z][A-Za-z0-9_]*)$/);
      if (!legacyParameter) return slot;
      const choices = Array.isArray(slot.choices) ? slot.choices : [];
      return {
        ...slot,
        key: nextKey(),
        type: 'parameter',
        role: 'argument',
        parameter_name: stringValue(slot.parameter_name || slot.parameterName || legacyParameter[1]),
        parameter_label: stringValue(slot.parameter_label || slot.parameterLabel || legacyParameter[1]),
        legacy_key: legacyKey,
        choices: choices.map((choice, index) => {
          const rawChoice = choice && typeof choice === 'object' && !Array.isArray(choice) ? choice : {};
          const legacyChoiceKey = stringValue(rawChoice.key);
          const inferredValue = legacyChoiceKey.startsWith('v_') ? legacyChoiceKey.slice(2) : '';
          return {
            ...rawChoice,
            key: `v${index + 1}`,
            value: Object.prototype.hasOwnProperty.call(rawChoice, 'value') ? rawChoice.value : inferredValue,
            legacy_key: legacyChoiceKey,
          };
        }),
      };
    });
  }

  function canonicalClarificationSelection({ resourceKey = '', choiceKey = '' } = {}, slots = []) {
    const rawResourceKey = stringValue(resourceKey);
    const rawChoiceKey = stringValue(choiceKey);
    if (!rawResourceKey || !rawChoiceKey) return null;
    const slot = slotChoices(slots).find(candidate => {
      const key = stringValue(candidate.key);
      return key === rawResourceKey || stringValue(candidate.legacy_key) === rawResourceKey;
    });
    if (!slot) return null;
    const choice = (slot.choices || []).find(candidate => {
      const key = stringValue(candidate?.key);
      return key === rawChoiceKey || stringValue(candidate?.legacy_key) === rawChoiceKey;
    });
    if (!choice) return null;
    return Object.freeze({
      resource_key: stringValue(slot.key),
      choice_key: stringValue(choice.key),
    });
  }

  function migrateClarificationAnswer(value = null, { clarificationId = '', slots = [] } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const expectedId = stringValue(clarificationId || value.clarification_id || value.clarificationId);
    if (hasExactClarificationAnswer(value)) {
      try {
        assertClarificationId(value, expectedId);
        return value;
      } catch {
        return null;
      }
    }
    const selections = [];
    for (const selection of Array.isArray(value.answers) ? value.answers : []) {
      const canonical = canonicalClarificationSelection({
        resourceKey: selection?.resource_key || selection?.resourceKey,
        choiceKey: selection?.choice_key || selection?.choiceKey,
      }, slots);
      if (!canonical || selections.some(item => item.resource_key === canonical.resource_key)) return null;
      selections.push(canonical);
    }
    if (!expectedId || !selections.length) return null;
    try {
      return createClarificationAnswer({
        clarificationId: expectedId,
        answers: selections,
        freeText: value.free_text ?? value.freeText ?? '',
      });
    } catch {
      return null;
    }
  }

  function normalizePendingClarification(value = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = stringValue(value.id || value.clarificationId || value.clarification_id);
    if (!id) return null;
    const rawRouteInfo = value.routeInfo && typeof value.routeInfo === 'object' && !Array.isArray(value.routeInfo)
      ? value.routeInfo
      : null;
    const routeInfo = rawRouteInfo
      ? { ...rawRouteInfo, clarificationSlots: normalizeClarificationSlots(rawRouteInfo.clarificationSlots) }
      : null;
    const rawAnswer = value.clarificationAnswer
      || (Array.isArray(value.answers) && value.answers.length
        ? { schema_version: CLARIFICATION_ANSWER_VERSION, clarification_id: id, answers: value.answers, free_text: String(value.free_text || '') }
        : null);
    const answer = migrateClarificationAnswer(rawAnswer, {
      clarificationId: id,
      slots: clarificationSlotsFor({ routeInfo }),
    });
    const now = Date.now();
    const originalText = stringValue(value.originalText || value.original_text || value.promptText || value.originalPrompt);
    const baseTaskText = stringValue(value.baseTaskText || value.base_task_text) || originalText;
    return {
      ...value,
      id,
      originalText,
      baseTaskText,
      supplements: Array.isArray(value.supplements) ? value.supplements.map(stringValue).filter(Boolean) : [],
      clarificationText: stringValue(value.clarificationText || value.clarification_text),
      routeInfo,
      sourceAttachmentContexts: Array.isArray(value.sourceAttachmentContexts)
        ? value.sourceAttachmentContexts
        : [],
      clarificationAnswer: answer,
      relationClarification: value.relationClarification && typeof value.relationClarification === 'object' && !Array.isArray(value.relationClarification)
        ? value.relationClarification
        : null,
      createdAt: Number(value.createdAt || value.created_at || now),
      updatedAt: Number(value.updatedAt || value.updated_at || value.createdAt || value.created_at || now),
    };
  }

  function createPendingClarification({
    messages = [], clarificationText = '', routeInfo = null,
    sourceImageContext = null, sourceAttachmentContext = null, sourceQuoteContext = null, id = '',
  } = {}) {
    const originalText = latestUserText(messages);
    const now = Date.now();
    return {
      id: stringValue(id) || randomId('clarify'),
      originalText,
      baseTaskText: originalText,
      supplements: [],
      clarificationText: stringValue(clarificationText),
      routeInfo: routeInfo && typeof routeInfo === 'object' && !Array.isArray(routeInfo) ? routeInfo : null,
      clarificationAnswer: null,
      relationClarification: null,
      sourceImageContext: sourceImageContext || null,
      sourceAttachmentContext: sourceAttachmentContext || null,
      sourceQuoteContext: sourceQuoteContext || null,
      createdAt: now,
      updatedAt: now,
    };
  }

  function mergePendingInput(pending = null, { promptText = '' } = {}) {
    const normalized = normalizePendingClarification(pending);
    if (!normalized) return { pending: null, merged: false, promptText: stringValue(promptText) };
    const text = stringValue(promptText);
    const base = normalized.baseTaskText || normalized.originalText;
    const supplements = [...normalized.supplements];
    const merged = !!text;
    if (merged && text !== base && !supplements.includes(text)) supplements.push(text);
    return {
      pending: { ...normalized, supplements, updatedAt: Date.now() },
      merged,
      // The current user turn is what the router re-parses; the pending base
      // task and any supplements travel inside the clarification context.
      promptText: text,
      originalPromptText: base,
      supplementText: text,
      resolvedInput: text,
    };
  }

  function findPendingFromHistory(messages = [], { id = '', clarificationText = '' } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const expectedId = stringValue(id);
    const expectedText = stringValue(clarificationText);
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index];
      if (!message || typeof message !== 'object') continue;
      const messageId = stringValue(message.clarificationId || message.clarification_id);
      const matches = expectedId
        ? messageId === expectedId
        : expectedText && stringValue(message.rawText || message.content) === expectedText;
      if (!matches) continue;
      return createPendingClarification({
        messages: [message],
        clarificationText: stringValue(message.rawText || message.content),
        routeInfo: message.routeInfo && typeof message.routeInfo === 'object' ? message.routeInfo : null,
        id: messageId || undefined,
      });
    }
    return null;
  }

  function isClarificationResponse(input = '', options = {}) {
    return looksLikeClarificationAnswerInput(input, options);
  }

  function shouldApplyPending(pending = null, input = '', options = {}) {
    return !!normalizePendingClarification(pending) && isClarificationResponse(input, options);
  }

  function buildClarificationRouteContext({ baseContext = {}, quotedContext = null, pending = null } = {}) {
    const normalized = normalizePendingClarification(pending);
    if (!normalized) return null;
    const context = baseContext && typeof baseContext === 'object' && !Array.isArray(baseContext) ? { ...baseContext } : {};
    const resources = Array.isArray(normalized.routeInfo?.resources)
      ? normalized.routeInfo.resources
      : [];
    // A clarification route may already contain valid media bindings while a
    // different slot remains unresolved. Keep those established facts separate
    // from resources selected by the current answer so rerouting never asks the
    // model to rediscover or silently replace an already resolved binding.
    const establishedResources = resources
      .filter(resource => resource && ['image', 'file'].includes(stringValue(resource.type)))
      .map(resource => ({ ...resource }));
    const slots = clarificationSlotsFor(normalized);
    const application = normalized.clarificationAnswer
      ? applyClarificationAnswer(normalized.clarificationAnswer, slots, { clarificationId: normalized.id })
      : null;
    const image_candidates = Array.isArray(context.image_candidates) ? [...context.image_candidates] : [];
    const file_candidates = Array.isArray(context.file_candidates) ? [...context.file_candidates] : [];
    let imageIndex = image_candidates.length;
    let fileIndex = file_candidates.length;
    const addCandidate = resource => {
      if (!resource || typeof resource !== 'object') return;
      const type = stringValue(resource.type);
      if (type !== 'image' && type !== 'file') return;
      const id = stringValue(resource.id);
      const resourceId = stringValue(resource.resource_id || resource.resourceId);
      const source = stringValue(resource.source) || 'history';
      const targetList = type === 'image' ? image_candidates : file_candidates;
      // A resolved choice is an authoritative resource binding. Preserve it in
      // the reroute catalog even when the original ambiguous route carried no
      // bound resources and the caller supplied no historical base context.
      if (targetList.some(candidate => {
        const candidateId = stringValue(candidate?.resource_id || candidate?.resourceId);
        return source === stringValue(candidate?.source)
          && ((resourceId && candidateId === resourceId)
            || (!resourceId && id && id === stringValue(candidate?.image_id || candidate?.file_id || candidate?.id)));
      })) return;
      const index = Number(resource.index) || 0;
      const position = index || (type === 'image' ? imageIndex + 1 : fileIndex + 1);
      const candidate = {
        index: position,
        source_index: position,
        source,
        target: source === 'current' ? 'uploaded' : 'previous',
        image_id: type === 'image' ? id : '',
        file_id: type === 'file' ? id : '',
        resource_id: resourceId,
        reference_id: stringValue(resource.reference_id || resource.referenceId),
        identity_aliases: Array.isArray(resource.identity_aliases) ? resource.identity_aliases : [],
        index_aliases: Array.isArray(resource.index_aliases) ? resource.index_aliases : [],
        role: stringValue(resource.role),
        label: stringValue(resource.label),
      };
      targetList.push(candidate);
      if (type === 'image') imageIndex += 1;
      else fileIndex += 1;
    };
    // Selected resources must be materialized before the original route
    // resources. The latter describe only the pre-answer plan and can be
    // empty precisely when a clarification was required.
    for (const resource of application?.selectedResources || []) addCandidate(resource);
    for (const resource of establishedResources) addCandidate(resource);
    context.image_candidates = image_candidates;
    context.file_candidates = file_candidates;
    context.pending_task = {
      schema_version: 'clarification_pending.v1',
      id: normalized.id,
      original_text: normalized.originalText,
      clarification_text: normalized.clarificationText,
      supplements: [...normalized.supplements],
    };
    context.clarification_context = {
      schema_version: 'clarification_context.v4',
      base_task: normalized.originalText,
      clarification_question: normalized.clarificationText,
      operation: stringValue(normalized.routeInfo?.operationType),
      relation: stringValue(normalized.routeInfo?.relation),
      unresolved_resources: slots,
      pending_task: {
        base_input: normalized.originalText,
        id: normalized.id,
        supplements: [...normalized.supplements],
      },
      selected_choices: clarificationAnswerLabels(normalized),
      selected_parameters: application?.selectedParameters || {},
      established_resources: establishedResources,
      selected_resources: application?.selectedResources || [],
      answer_complete: application?.complete === true,
    };
    if (quotedContext && typeof quotedContext === 'object' && !Array.isArray(quotedContext)) {
      if (quotedContext.quoted_message !== undefined) context.quoted_message = quotedContext.quoted_message;
      for (const key of ['image_candidates', 'file_candidates']) {
        const quoted = Array.isArray(quotedContext[key])
          ? quotedContext[key].filter(item => stringValue(item?.source) === 'quoted')
          : [];
        if (quoted.length) context[key] = [...quoted, ...(Array.isArray(context[key]) ? context[key] : [])];
      }
      if (quotedContext.recent_messages !== undefined) context.recent_messages = quotedContext.recent_messages;
    }
    return context;
  }

  function expectedAnswerTypes() { return ['resource', 'parameter']; }

  function clarificationAnswerLabels(pending = null) {
    const normalized = normalizePendingClarification(pending);
    if (!normalized?.clarificationAnswer) return [];
    const slots = clarificationSlotsFor(normalized);
    const byKey = new Map(slotChoices(slots).map(slot => [stringValue(slot.key), slot]));
    const labels = [];
    for (const selection of normalized.clarificationAnswer.answers) {
      const slot = byKey.get(stringValue(selection.resource_key));
      const choice = slot?.choices?.find(item => stringValue(item?.key) === stringValue(selection.choice_key));
      if (choice?.label) labels.push(stringValue(choice.label));
    }
    return labels;
  }

  function applyPendingClarificationAnswer(pending = null, incremental = null) {
    const normalized = normalizePendingClarification(pending);
    if (!normalized) return null;
    if (!hasExactClarificationAnswer(incremental)) {
      const error = new TypeError('Invalid clarification_answer.v1');
      error.code = 'CLARIFICATION_ANSWER_INVALID';
      throw error;
    }
    assertClarificationId(incremental, normalized.id);
    const merged = normalized.clarificationAnswer
      ? mergeClarificationAnswers(normalized.clarificationAnswer, incremental, { clarificationId: normalized.id })
      : incremental;
    const application = applyClarificationAnswer(merged, clarificationSlotsFor(normalized), { clarificationId: normalized.id });
    const next = { ...normalized, clarificationAnswer: merged, updatedAt: Date.now() };
    return {
      pending: next,
      answer: merged,
      application,
      complete: application.complete === true,
    };
  }

  function createPendingRelationClarification(pending = null, { input = '', sourceMessageIndex = 0 } = {}) {
    const normalized = normalizePendingClarification(pending);
    if (!normalized || typeof clarificationRelation?.createRelationClarification !== 'function') return null;
    const relation = clarificationRelation.createRelationClarification({
      clarificationId: randomId('clarify_rel'),
      pendingId: normalized.id,
      input: stringValue(input),
      sourceMessageIndex: Number(sourceMessageIndex) || 0,
    });
    return { ...normalized, relationClarification: relation, updatedAt: Date.now() };
  }

  function applyPendingRelationAnswer(pending = null, answer = null) {
    const normalized = normalizePendingClarification(pending);
    if (!normalized || !normalized.relationClarification
        || typeof clarificationRelation?.resolveRelationAnswer !== 'function') return null;
    const resolved = clarificationRelation.resolveRelationAnswer(normalized.relationClarification, answer);
    return {
      decision: resolved.decision,
      input: resolved.input,
      source_message_index: resolved.source_message_index,
      pending: { ...normalized, relationClarification: null, updatedAt: Date.now() },
    };
  }

  function normalizeClarificationReplay(value = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const resolvedInput = stringValue(value.resolved_input || value.resolvedInput);
    const hasAnswers = Array.isArray(value.answers) && value.answers.length > 0;
    const hasRounds = Array.isArray(value.rounds) && value.rounds.length > 0;
    if (!resolvedInput && !hasAnswers && !hasRounds) return null;
    return {
      schema_version: stringValue(value.schema_version) || 'clarification_replay.v1',
      resolved_input: resolvedInput,
      resolvedInput,
      answers: Array.isArray(value.answers) ? value.answers : [],
      rounds: Array.isArray(value.rounds) ? value.rounds : [],
    };
  }

  function reviseClarificationReplay(replay = null, nextText = '') {
    const normalized = normalizeClarificationReplay(replay);
    if (!normalized) return null;
    const resolvedInput = stringValue(nextText);
    return {
      ...normalized,
      resolved_input: resolvedInput,
      resolvedInput,
      updated_at: Date.now(),
    };
  }

  function pendingAttachmentContexts(pending = null) {
    const normalized = normalizePendingClarification(pending);
    return Array.isArray(normalized?.sourceAttachmentContexts) ? normalized.sourceAttachmentContexts : [];
  }

  function parsePendingAttachmentContext(value = null) {
    if (!value) return null;
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function collectPendingAttachmentContexts({ messages = [], routeInfo = null, sourceAttachmentContext = null } = {}) {
    const contexts = [];
    const seen = new Set();
    const push = context => {
      const parsed = parsePendingAttachmentContext(context);
      if (!parsed || !Array.isArray(parsed.attachments) || !parsed.attachments.length) return;
      const key = JSON.stringify(parsed);
      if (seen.has(key)) return;
      seen.add(key);
      contexts.push(parsed);
    };
    push(sourceAttachmentContext);
    if (routeInfo && typeof routeInfo === 'object') {
      push(routeInfo.sourceAttachmentContext);
      push(routeInfo.source_attachment_context);
    }
    for (const message of Array.isArray(messages) ? messages : []) {
      if (String(message?.role || '') !== 'user') continue;
      push(message?.attachmentContext || message?.attachment_context);
    }
    return contexts;
  }

  function textOfPendingMessage(message = {}) {
    return stringValue(message?.rawText || message?.content || message?.text);
  }

  function routeClarificationSlots(routeInfo = null) {
    if (!routeInfo || typeof routeInfo !== 'object' || Array.isArray(routeInfo)) return [];
    return Array.isArray(routeInfo.clarificationSlots) ? routeInfo.clarificationSlots : [];
  }

  function matchesPendingClarificationMessage(value = null, { message = null, userText = '' } = {}) {
    const pending = normalizePendingClarification(value);
    if (!pending || !message || String(message.role || '') !== 'assistant') return false;
    const messageClarificationId = stringValue(message.clarificationId || message.clarification_id);
    if (messageClarificationId) return messageClarificationId === pending.id;
    const messageText = textOfPendingMessage(message);
    return !!messageText
      && messageText === pending.clarificationText
      && stringValue(userText) === pending.originalText;
  }

  function pendingClarificationRouteInfo(value = null) {
    const pending = normalizePendingClarification(value);
    if (!pending) return null;
    const routeInfo = pending.routeInfo || {};
    return {
      ...routeInfo,
      needClarification: true,
      clarificationQuestion: pending.clarificationText
        || routeInfo.clarificationQuestion
        || '',
      clarificationSlots: routeClarificationSlots(routeInfo),
    };
  }

  function pendingResourceOrigins(pending = null) {
    const normalized = normalizePendingClarification(pending);
    if (!normalized) return [];
    const resources = Array.isArray(normalized.routeInfo?.resources)
      ? normalized.routeInfo.resources
      : [];
    return resources
      .filter(resource => resource && (resource.type === 'image' || resource.type === 'file'))
      .map(resource => ({
        type: stringValue(resource.type),
        id: stringValue(resource.id),
        resource_id: stringValue(resource.resource_id || resource.resourceId),
        reference_id: stringValue(resource.reference_id || resource.referenceId),
        source: stringValue(resource.source),
        index: Number(resource.index) || 0,
      }));
  }

  return Object.freeze({
    CLARIFICATION_ANSWER_VERSION,
    ANSWER_FIELDS,
    SELECTION_FIELDS,
    hasExactClarificationAnswer,
    createClarificationAnswer,
    assertClarificationId,
    mergeClarificationAnswers,
    clarificationAnswerInputKind,
    looksLikeClarificationAnswerInput,
    parseClarificationAnswer,
    applyClarificationAnswer,
    createPendingClarification,
    mergePendingInput,
    findPendingFromHistory,
    isClarificationResponse,
    shouldApplyPending,
    buildClarificationRouteContext,
    normalizePendingClarification,
    normalizeClarificationSlots,
    canonicalClarificationSelection,
    expectedAnswerTypes,
    clarificationAnswerLabels,
    applyPendingClarificationAnswer,
    createPendingRelationClarification,
    applyPendingRelationAnswer,
    normalizeClarificationReplay,
    reviseClarificationReplay,
    pendingAttachmentContexts,
    collectPendingAttachmentContexts,
    pendingResourceOrigins,
    matchesPendingClarificationMessage,
    pendingClarificationRouteInfo,
  });
});
