(function initChatUIRouteDecisionCompiler(root) {
  'use strict';

  function createRouteDecisionCompiler({
    routeProtocol = {},
    buildRouteResourceCandidates = () => [],
    compactRoutePayloadContext = context => context || {},
  } = {}) {
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
      ROUTE_DECISION_FIELDS,
      SEMANTIC_ACTIONS,
      SEMANTIC_DISCOURSES,
      SEMANTIC_PENDING_EFFECTS,
      SEMANTIC_SLOT_PURPOSES,
      SEMANTIC_SLOT_RESOLUTIONS,
      SEMANTIC_TASK_FIELDS,
      SEMANTIC_SLOT_FIELDS,
    } = routeProtocol;

    function hasOnlyExactFields(value = {}, fields = []) {
      return !!value
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.keys(value).length === fields.length
        && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
    }

    function sortedSignatures(values = []) {
      return values.map(value => JSON.stringify(value)).sort();
    }

    function validChange(change = {}) {
      if (!hasOnlyExactFields(change, ['op', 'target', 'value'])
          || !ROUTE_CHANGES.has(change.op)
          || typeof change.target !== 'string'
          || typeof change.value !== 'string') return false;
      if (['add', 'replace'].includes(change.op)) return !!change.target.trim() && !!change.value.trim();
      return !!change.target.trim() && change.value === '';
    }

    function roleMatchesCandidate(type = '', role = '') {
      if (type === 'file') return role === 'attachment';
      if (type === 'message') return role === 'context';
      if (type === 'text') return role === 'source';
      return type === 'image' && ['source', 'target', 'reference', 'style_reference', 'mask', 'compare_a', 'compare_b'].includes(role);
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
      if (value.changes.some(change => !validChange(change))) return false;
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

    function semanticSlotRole(slot = {}) {
      return slot.purpose === 'change_value' ? 'source' : slot.purpose;
    }

    function hasSemanticTaskShape(value = {}) {
      if (!hasOnlyExactFields(value, SEMANTIC_TASK_FIELDS)
          || value.schema_version !== SEMANTIC_TASK_VERSION
          || !Array.isArray(value.actions)
          || value.actions.length < 1
          || new Set(value.actions).size !== value.actions.length
          || value.actions.some(action => !SEMANTIC_ACTIONS.has(action))
          || !SEMANTIC_DISCOURSES.has(value.discourse)
          || !SEMANTIC_PENDING_EFFECTS.has(value.pending_effect)
          || !Array.isArray(value.slots)
          || !Array.isArray(value.changes)
          || !Array.isArray(value.constraints)
          || value.changes.some(change => !validChange(change))
          || value.constraints.some(constraint => typeof constraint !== 'string' || !constraint.trim())) return false;
      return !value.slots.some(slot => {
        if (!hasOnlyExactFields(slot, SEMANTIC_SLOT_FIELDS)
            || !ROUTE_RESOURCE_TYPES.has(slot.kind)
            || !SEMANTIC_SLOT_PURPOSES.has(slot.purpose)
            || typeof slot.label !== 'string'
            || !SEMANTIC_SLOT_RESOLUTIONS.has(slot.resolution)
            || !Array.isArray(slot.candidate_keys)
            || slot.candidate_keys.some(key => typeof key !== 'string' || !/^[ifm][1-9]\d*$/.test(key))) return true;
        const keys = [...new Set(slot.candidate_keys)];
        if (keys.length !== slot.candidate_keys.length) return true;
        if (slot.resolution === 'bound' && keys.length !== 1) return true;
        if (slot.resolution === 'ambiguous' && keys.length < 2) return true;
        if (['missing', 'unavailable'].includes(slot.resolution) && keys.length) return true;
        if (slot.purpose === 'change_value') {
          return slot.kind !== 'text' || !['missing', 'unavailable'].includes(slot.resolution);
        }
        return !roleMatchesCandidate(slot.kind, semanticSlotRole(slot));
      });
    }

    function hasExactSemanticTask(value = {}) {
      return hasSemanticTaskShape(value);
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
      return String(candidate.source || '') === String(selected.source || '')
        && Number(candidate.index) === Number(selected.index);
    }

    function clarificationState(context = {}) {
      const clarification = context?.clarification_context;
      if (!clarification || typeof clarification !== 'object' || Array.isArray(clarification)) return null;
      const pending = clarification.pending_task && typeof clarification.pending_task === 'object'
        ? clarification.pending_task
        : {};
      return {
        raw: clarification,
        priorTaskContract: pending.prior_task_contract || clarification.prior_task_contract || null,
        priorSemanticTask: pending.prior_semantic_task || clarification.prior_semantic_task || null,
        unresolvedResources: Array.isArray(pending.unresolved_resources)
          ? pending.unresolved_resources
          : Array.isArray(clarification.unresolved_resources) ? clarification.unresolved_resources : [],
        continuationRelation: String(clarification.continuation_relation || ''),
        selectedChoices: Array.isArray(clarification.selected_choices) ? clarification.selected_choices : [],
      };
    }

    function assertSelectedChoicesAreBound(decision = {}, catalog = [], context = {}) {
      const selectedChoices = clarificationState(context)?.selectedChoices;
      if (!Array.isArray(selectedChoices) || !selectedChoices.length) return;
      for (const selected of selectedChoices) {
        const matches = catalog.filter(candidate => selectedChoiceCandidateMatches(candidate, selected));
        if (matches.length !== 1 || !decision.bindings.some(binding => binding.candidate_key === matches[0].candidate_key && binding.role === selected.role)) {
          throw new TypeError('A selected clarification resource was not preserved in the rerouted task');
        }
      }
    }

    function assertPartialAnswerPreservesEstablishedBindings(decision = {}, catalog = [], context = {}) {
      const clarification = clarificationState(context);
      if (clarification?.continuationRelation !== 'partial_answer') return;
      const priorResources = Array.isArray(clarification?.priorTaskContract?.resources)
        ? clarification.priorTaskContract.resources
        : [];
      const selectedChoices = clarification?.selectedChoices || [];
      const expectedResources = [...priorResources, ...selectedChoices]
        .filter(resource => resource && resource.type !== 'text' && resource.missing !== true);
      const expectedCandidateKeys = new Set();
      for (const expected of expectedResources) {
        const matches = catalog.filter(candidate => selectedChoiceCandidateMatches(candidate, expected));
        if (matches.length !== 1
            || expectedCandidateKeys.has(matches[0].candidate_key)
            || !decision.bindings.some(binding => binding.candidate_key === matches[0].candidate_key && binding.role === expected.role)) {
          throw new TypeError('A partial clarification answer cannot drop an established resource binding');
        }
        expectedCandidateKeys.add(matches[0].candidate_key);
      }
    }

    function selectionAnswerInvariantContext(context = {}) {
      const clarification = clarificationState(context);
      if (clarification?.continuationRelation !== 'pending_answer') return null;
      const prior = clarification.priorTaskContract;
      const unresolved = prior?.clarification?.unresolved_resources;
      const selected = clarification.selectedChoices;
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

    function operationAllowedByProductMode(operation = '', currentMode = 'chat', autoMode = true) {
      if (autoMode !== false) return true;
      const allowed = OPERATIONS_BY_FIXED_MODE[String(currentMode || 'chat')] || OPERATIONS_BY_FIXED_MODE.chat;
      return allowed.has(operation);
    }

    function actionFamily(action = '') {
      if (action === 'generate') return 'generate';
      if (action === 'edit') return 'edit';
      return 'understand';
    }

    function operationFamily(operation = '') {
      if (['text_to_image', 'image_reference_gen'].includes(operation)) return 'generate';
      if (operation === 'edit_image') return 'edit';
      return 'understand';
    }

    const OPERATION_SLOT_CAPABILITIES = Object.freeze({
      plain_chat: new Set(['message:context', 'image:reference', 'image:style_reference']),
      file_qa: new Set(['file:attachment']),
      multimodal_qa: new Set(['image:source', 'file:attachment']),
      image_qa: new Set(['image:source']),
      // Image comparison is dispatched through the chat transport, which preserves both
      // selected images and supporting document attachments for one grounded answer.
      image_compare: new Set(['image:compare_a', 'image:compare_b', 'file:attachment']),
      ocr: new Set(['image:source']),
      text_to_image: new Set(['message:context']),
      image_reference_gen: new Set(['image:reference', 'image:style_reference']),
      edit_image: new Set(['image:target', 'image:reference', 'image:style_reference', 'image:mask']),
    });

    function semanticSlotNeedsResource(slot = {}) {
      return slot && slot.purpose !== 'change_value';
    }

    function semanticSlotCapability(slot = {}) {
      return `${String(slot.kind || '')}:${semanticSlotRole(slot)}`;
    }

    function semanticCapabilityIssue(task = {}, operation = '', slots = [], operationOverride = '') {
      const actions = Array.isArray(task.actions) ? task.actions : [];
      const families = [...new Set(actions.map(actionFamily))];
      if (families.length > 1) {
        return {
          code: 'multiple_execution_families',
          question: '本轮包含需要不同执行流程的多个任务，请说明要先执行哪一个。',
        };
      }

      if (operationOverride) {
        const effectiveFamily = operationFamily(operation);
        const incompatibleAction = actions.find(action => action !== 'respond' && actionFamily(action) !== effectiveFamily);
        if (incompatibleAction) {
          return {
            code: 'pending_operation_conflict',
            question: '本轮要求与待完成任务的执行方式不一致，请说明是继续原任务，还是开始新任务。',
          };
        }
      }

      const allowed = OPERATION_SLOT_CAPABILITIES[operation] || new Set();
      const incompatibleSlots = slots.filter(slot => semanticSlotNeedsResource(slot) && !allowed.has(semanticSlotCapability(slot)));
      if (incompatibleSlots.length) {
        return {
          code: 'operation_resource_conflict',
          question: '当前任务和资源用途不能由同一次执行完整处理，请说明要先处理哪一部分。',
          slot_labels: [...new Set(incompatibleSlots.map(slot => String(slot.label || '').trim()).filter(Boolean))],
        };
      }
      return null;
    }

    function semanticOperation(task = {}) {
      const actions = Array.isArray(task.actions) ? task.actions : [];
      const first = actions[0] || 'respond';
      const slots = Array.isArray(task.slots) ? task.slots : [];
      if (first === 'generate') {
        const usesImage = slots.some(slot => slot.kind === 'image'
          && ['reference', 'style_reference'].includes(slot.purpose));
        return usesImage ? 'image_reference_gen' : 'text_to_image';
      }
      if (first === 'edit') return 'edit_image';
      if (actions.includes('compare')) return 'image_compare';
      if (actions.includes('extract_text')) return 'ocr';
      const hasImage = slots.some(slot => semanticSlotNeedsResource(slot)
        && slot.kind === 'image' && slot.purpose === 'source');
      const hasFile = slots.some(slot => semanticSlotNeedsResource(slot)
        && slot.kind === 'file' && slot.purpose === 'attachment');
      if (hasImage && hasFile) return 'multimodal_qa';
      if (hasFile) return 'file_qa';
      if (hasImage) return 'image_qa';
      return 'plain_chat';
    }

    function semanticRelation(task = {}) {
      if (task.pending_effect === 'revision') return 'correction';
      if (['answer', 'partial', 'continuation'].includes(task.pending_effect)) return 'continuation';
      return ({ independent: 'new', followup: 'followup', correction: 'correction', continuation: 'continuation' })[task.discourse] || 'new';
    }

    function uniqueChanges(changes = []) {
      const map = new Map();
      for (const change of changes) map.set(`${change.op}\u0000${change.target}`, { ...change });
      return [...map.values()];
    }

    function uniqueConstraints(constraints = []) {
      return [...new Set(constraints.map(value => String(value).trim()).filter(Boolean))];
    }

    function catalogKeyForResource(resource = {}, catalog = []) {
      const matches = catalog.filter(candidate => selectedChoiceCandidateMatches(candidate, resource));
      return matches.length === 1 ? matches[0].candidate_key : '';
    }

    function priorChoiceCandidateKeys(slot = {}, catalog = []) {
      const keys = [];
      for (const choice of Array.isArray(slot?.choices) ? slot.choices : []) {
        const key = catalogKeyForResource({ ...choice, type: slot.type }, catalog);
        if (key && !keys.includes(key)) keys.push(key);
      }
      return keys;
    }

    function pendingContinuationEffect(effect = '') {
      return ['answer', 'partial', 'revision', 'continuation'].includes(effect);
    }

    function enrichPendingSemanticTask(task = {}, catalog = [], context = {}) {
      const pending = clarificationState(context);
      const prior = pending?.priorTaskContract;
      if (!prior || !pendingContinuationEffect(task.pending_effect)) return {
        slots: task.slots.map(slot => ({ ...slot, candidate_keys: [...slot.candidate_keys] })),
        changes: task.changes.map(change => ({ ...change })),
        constraints: [...task.constraints],
        operationOverride: '',
      };

      const slots = task.slots.map(slot => ({ ...slot, candidate_keys: [...slot.candidate_keys] }));
      const hasSemanticSlot = (kind, purpose) => slots.some(slot => slot.kind === kind && semanticSlotRole(slot) === purpose);
      const addPriorResource = resource => {
        if (!resource || resource.type === 'text' || resource.missing === true) return;
        const purpose = String(resource.role || '');
        const key = catalogKeyForResource(resource, catalog);
        if (key) {
          if (!slots.some(slot => slot.resolution === 'bound' && slot.candidate_keys[0] === key)) {
            slots.push({ kind: resource.type, purpose, label: '', resolution: 'bound', candidate_keys: [key] });
          }
          return;
        }
        if (!hasSemanticSlot(resource.type, purpose)) {
          slots.push({ kind: resource.type, purpose, label: '', resolution: 'unavailable', candidate_keys: [] });
        }
      };
      for (const resource of Array.isArray(prior.resources) ? prior.resources : []) addPriorResource(resource);
      for (const selected of pending?.selectedChoices || []) addPriorResource(selected);

      const unresolved = Array.isArray(prior.clarification?.unresolved_resources)
        ? prior.clarification.unresolved_resources
        : pending?.unresolvedResources || [];
      for (const priorSlot of unresolved) {
        if (priorSlot?.type === 'text') continue;
        const keys = priorChoiceCandidateKeys(priorSlot, catalog);
        const selectedKey = keys.find(key => slots.some(slot => slot.resolution === 'bound'
          && slot.candidate_keys[0] === key
          && semanticSlotRole(slot) === priorSlot.role));
        if (selectedKey) continue;
        const alreadyRepresented = slots.some(slot => slot.kind === priorSlot.type
          && semanticSlotRole(slot) === priorSlot.role
          && (slot.resolution !== 'bound' || slot.candidate_keys.some(key => keys.includes(key))));
        if (alreadyRepresented) continue;
        slots.push({
          kind: priorSlot.type,
          purpose: priorSlot.role,
          label: '',
          resolution: keys.length >= 2 ? 'ambiguous' : priorSlot.reason === 'unavailable' ? 'unavailable' : 'missing',
          candidate_keys: keys.length >= 2 ? keys : [],
        });
      }

      const priorSemanticSlots = Array.isArray(pending?.priorSemanticTask?.slots)
        ? pending.priorSemanticTask.slots
        : [];
      let suppliedChangeValues = task.changes.filter(change => ['add', 'replace'].includes(change.op)).length;
      for (const priorSlot of priorSemanticSlots) {
        if (priorSlot?.kind !== 'text' || priorSlot?.purpose !== 'change_value' || priorSlot?.resolution === 'bound') continue;
        if (slots.some(slot => slot.kind === 'text' && slot.purpose === 'change_value')) continue;
        if (suppliedChangeValues > 0) { suppliedChangeValues -= 1; continue; }
        slots.push({
          kind: 'text',
          purpose: 'change_value',
          label: String(priorSlot.label || ''),
          resolution: priorSlot.resolution === 'unavailable' ? 'unavailable' : 'missing',
          candidate_keys: [],
        });
      }

      const priorChanges = Array.isArray(prior.directive?.operations) ? prior.directive.operations : [];
      const priorConstraints = Array.isArray(prior.directive?.constraints) ? prior.directive.constraints : [];
      const changes = uniqueChanges([...priorChanges, ...task.changes]);
      const constraints = uniqueConstraints([...priorConstraints, ...task.constraints]);
      const preserveOperation = ['answer', 'partial', 'continuation'].includes(task.pending_effect);
      return {
        slots,
        changes,
        constraints,
        operationOverride: preserveOperation ? String(prior.operation || '') : '',
      };
    }

    function collapseExclusiveSlots(slots = [], kind = 'image', purpose = 'target') {
      const indexes = [];
      const candidateKeys = [];
      slots.forEach((slot, index) => {
        if (slot.kind !== kind || slot.purpose !== purpose) return;
        indexes.push(index);
        candidateKeys.push(...slot.candidate_keys);
      });
      const uniqueKeys = [...new Set(candidateKeys)];
      if (indexes.length <= 1 || uniqueKeys.length <= 1) return slots;
      const first = slots[indexes[0]];
      const kept = slots.filter((slot, index) => !indexes.includes(index));
      kept.push({
        kind,
        purpose,
        label: first?.label || '',
        resolution: 'ambiguous',
        candidate_keys: uniqueKeys,
      });
      return kept;
    }

    function canonicalizeEditTargetSlot(task = {}, operation = '', slots = []) {
      const next = slots.map(slot => ({ ...slot, candidate_keys: [...slot.candidate_keys] }));
      if (operation !== 'edit_image' || !Array.isArray(task.actions) || !task.actions.includes('edit')) return next;
      const hasTarget = next.some(slot => slot.kind === 'image' && slot.purpose === 'target');
      const sourceSlots = next.filter(slot => slot.kind === 'image' && slot.purpose === 'source');
      // The semantic schema's `source` is a valid image role, but an edit action
      // with exactly one image and no target unambiguously means that image is the
      // edit target. Canonicalize this model-role alias before capability gating.
      if (hasTarget || sourceSlots.length !== 1) return next;
      return next.map(slot => slot === sourceSlots[0] ? { ...slot, purpose: 'target' } : slot);
    }

    function ensureRequiredSemanticSlots(operation = '', slots = []) {
      let next = slots.map(slot => ({ ...slot, candidate_keys: [...slot.candidate_keys] }));
      const has = (kind, purpose) => next.some(slot => slot.kind === kind && slot.purpose === purpose);
      const addMissing = (kind, purpose, label) => {
        if (!has(kind, purpose)) next.push({ kind, purpose, label, resolution: 'missing', candidate_keys: [] });
      };
      next = collapseExclusiveSlots(next, 'image', 'target');
      next = collapseExclusiveSlots(next, 'image', 'mask');
      next = collapseExclusiveSlots(next, 'image', 'compare_a');
      next = collapseExclusiveSlots(next, 'image', 'compare_b');
      if (operation === 'file_qa') addMissing('file', 'attachment', '要读取的文件');
      if (operation === 'multimodal_qa') {
        addMissing('image', 'source', '要分析的图片');
        addMissing('file', 'attachment', '要读取的文件');
      }
      if (operation === 'image_qa' || operation === 'ocr') addMissing('image', 'source', '要分析的图片');
      if (operation === 'image_compare') {
        addMissing('image', 'compare_a', '第一张比较图片');
        addMissing('image', 'compare_b', '第二张比较图片');
      }
      if (operation === 'edit_image') addMissing('image', 'target', '要修改的图片');
      if (operation === 'image_reference_gen'
          && !next.some(slot => slot.kind === 'image' && ['reference', 'style_reference'].includes(slot.purpose))) {
        next.push({ kind: 'image', purpose: 'reference', label: '参考图片', resolution: 'missing', candidate_keys: [] });
      }
      return next;
    }

    function clarificationQuestion(unresolved = [], catalog = [], { crossFamily = false, modeConflict = false, pendingUnclear = false } = {}) {
      const parts = [];
      if (crossFamily) parts.push('当前请求包含需要不同执行流程的任务，请明确本轮先执行哪一项');
      if (modeConflict) parts.push('当前固定模式无法完成该请求，请切换模式或改为该模式支持的任务');
      if (pendingUnclear) parts.push('请明确这条消息是在补充上一个任务，还是要开始一个新任务');
      const byKey = new Map(catalog.map(candidate => [candidate.candidate_key, candidate]));
      for (const slot of unresolved) {
        if (slot.synthetic) continue;
        const label = String(slot.label || '').trim() || (
          slot.purpose === 'change_value' ? '修改后的值'
          : slot.kind === 'image' ? '所需图片'
          : slot.kind === 'file' ? '所需文件'
          : '所需信息'
        );
        if (slot.reason === 'ambiguous') {
          const labels = slot.candidate_keys.map(key => byKey.get(key)?.label).filter(Boolean);
          parts.push(labels.length ? `请选择${label}` : `请明确${label}`);
        } else if (slot.reason === 'unavailable') {
          parts.push(`${label}当前不可用，请重新提供`);
        } else {
          parts.push(`请补充${label}`);
        }
      }
      return `${[...new Set(parts)].join('；')}。`;
    }

    function prepareSemanticTask(task = {}, options = {}) {
      if (!hasExactSemanticTask(task)) throw new TypeError('Invalid semantic_task.v2 shape');
      const compilerContext = compactRoutePayloadContext(options.context || {}, options.input || '', options.attachments || [], options.currentTurn || null);
      const catalog = buildRouteResourceCandidates({ attachments: options.attachments || [], context: compilerContext });
      const enriched = enrichPendingSemanticTask(task, catalog, compilerContext);
      const operation = enriched.operationOverride || semanticOperation({ ...task, slots: enriched.slots });
      const slots = ensureRequiredSemanticSlots(operation, canonicalizeEditTargetSlot(task, operation, enriched.slots));
      const issue = semanticCapabilityIssue(task, operation, slots, enriched.operationOverride);
      return { compilerContext, catalog, enriched, operation, slots, issue };
    }

    function analyzeSemanticTask(task = {}, options = {}) {
      const prepared = prepareSemanticTask(task, options);
      return {
        operation: prepared.operation,
        relation: semanticRelation(task),
        issue: prepared.issue,
        slots: prepared.slots,
      };
    }

    function semanticTaskToRouteDecision(task = {}, options = {}) {
      const prepared = prepareSemanticTask(task, options);
      const { compilerContext, catalog, enriched, operation } = prepared;
      let slots = prepared.slots;
      if (prepared.issue) {
        const error = new TypeError('Semantic task requires clarification before execution');
        error.code = 'SEMANTIC_TASK_REQUIRES_CLARIFICATION';
        error.semanticIssue = prepared.issue;
        throw error;
      }
      const modeConflict = !operationAllowedByProductMode(operation, options.currentMode, options.autoMode);
      const hasPendingContext = !!clarificationState(compilerContext);
      const pendingContextMismatch = hasPendingContext
        ? task.pending_effect === 'none'
        : task.pending_effect !== 'none';
      const pendingUnclear = task.pending_effect === 'unclear' || pendingContextMismatch;
      if (modeConflict) slots.push({
        kind: 'text', purpose: 'source', label: '与当前固定模式兼容的请求', resolution: 'missing', candidate_keys: [], synthetic: 'mode_conflict',
      });
      if (pendingUnclear) slots.push({
        kind: 'text', purpose: 'source', label: '与上一个任务的关系', resolution: 'missing', candidate_keys: [], synthetic: 'pending_unclear',
      });

      const candidateMap = new Map(catalog.map(candidate => [candidate.candidate_key, candidate]));
      const bindings = [];
      const unresolved = [];
      const used = new Set();
      for (const slot of slots) {
        const role = semanticSlotRole(slot);
        if (slot.resolution === 'bound') {
          const key = slot.candidate_keys[0];
          const candidate = candidateMap.get(key);
          if (!candidate || candidate.type !== slot.kind || !roleMatchesCandidate(candidate.type, role) || used.has(key)) {
            throw new TypeError(`Invalid semantic binding: ${key}`);
          }
          used.add(key);
          bindings.push({ candidate_key: key, role });
          continue;
        }
        unresolved.push({
          type: slot.kind,
          role,
          reason: slot.resolution,
          candidate_keys: [...slot.candidate_keys],
          label: slot.label,
          synthetic: slot.synthetic || '',
        });
      }

      const roleOrder = new Map([
        ['target', 0], ['reference', 1], ['style_reference', 2], ['mask', 3],
        ['compare_a', 0], ['compare_b', 1], ['source', 2], ['attachment', 3], ['context', 4],
      ]);
      bindings.sort((a, b) => (roleOrder.get(a.role) ?? 10) - (roleOrder.get(b.role) ?? 10));
      const readiness = unresolved.length ? 'needs_clarification' : 'ready';
      const question = readiness === 'needs_clarification'
        ? clarificationQuestion(unresolved, catalog, { modeConflict, pendingUnclear })
        : '';
      let relation = semanticRelation(task);
      const usesHistoricalCandidate = slots.some(slot => slot.candidate_keys.some(key => {
        const source = candidateMap.get(key)?.source;
        return ['quoted', 'history', 'context'].includes(source);
      }));
      if (relation === 'new' && usesHistoricalCandidate) relation = 'followup';
      return {
        schema_version: ROUTE_DECISION_VERSION,
        readiness,
        operation,
        relation,
        bindings,
        changes: enriched.changes,
        constraints: enriched.constraints,
        clarification: {
          question,
          unresolved: unresolved.map(({ label, synthetic, ...slot }) => slot),
        },
        confidence: 1,
        rationale: '',
      };
    }

    function compileSemanticTask(task = {}, options = {}) {
      const decision = semanticTaskToRouteDecision(task, options);
      return { decision, taskContract: compileRouteDecision(decision, options) };
    }

    function compileRouteDecision(decision = {}, options = {}) {
      if (!hasExactRouteDecision(decision)) throw new TypeError('Invalid route_decision.v1 shape');
      const compilerContext = compactRoutePayloadContext(options.context || {}, options.input || '', options.attachments || [], options.currentTurn || null);
      const catalog = buildRouteResourceCandidates({ attachments: options.attachments || [], context: compilerContext });
      assertSelectedChoicesAreBound(decision, catalog, compilerContext);
      assertPartialAnswerPreservesEstablishedBindings(decision, catalog, compilerContext);
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
      const referenceResources = resources.filter(resource => resource.type === 'image'
        && ['reference', 'style_reference'].includes(resource.role));
      const referenceGenerationAllowsChange = decision.readiness === 'ready'
        && decision.operation === 'image_reference_gen'
        && (referenceResources.length > 1 || referenceResources.some(resource => resource.role === 'style_reference'));
      const unmentionedPolicy = mode === 'standalone' || referenceGenerationAllowsChange ? 'allow_change' : 'preserve';
      const baselineKeys = [];
      for (const resource of resources) {
        if (resource.type === 'text') continue;
        if (operationRequiresPatch && resource.type === 'image' || ['quoted', 'history', 'context'].includes(resource.source)) baselineKeys.push(resource.key);
      }
      if (mode === 'patch' && decision.readiness === 'needs_clarification') {
        for (const slot of unresolvedResources) if (slot.type !== 'text') baselineKeys.push(slot.key);
      }

      return {
        schema_version: 'task_contract.v5',
        readiness: decision.readiness,
        operation: decision.operation,
        relation: decision.relation,
        resources,
        directive: {
          mode,
          base_resource_keys: [...new Set(baselineKeys)],
          unmentioned_policy: unmentionedPolicy,
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
    }

    return Object.freeze({
      hasExactRouteDecision,
      hasExactSemanticTask,
      analyzeSemanticTask,
      selectedChoiceCandidateMatches,
      roleMatchesCandidate,
      operationAllowedByProductMode,
      semanticTaskToRouteDecision,
      compileSemanticTask,
      compileRouteDecision,
    });
  }

  const api = Object.freeze({ createRouteDecisionCompiler });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('routeDecisionCompiler', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
