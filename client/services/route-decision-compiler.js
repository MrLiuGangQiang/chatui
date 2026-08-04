(function initChatUIRouteDecisionCompiler(root) {
  'use strict';

  function createRouteDecisionCompiler({
    routeProtocol = {},
    buildRouteResourceCandidates = () => [],
    compactRoutePayloadContext = context => context || {},
  } = {}) {
    const {
      ROUTE_DECISION_VERSION,
      ROUTE_OPERATIONS,
      ROUTE_RELATIONS,
      ROUTE_ROLES,
      ROUTE_RESOURCE_TYPES,
      ROUTE_REASONS,
      ROUTE_CHANGES,
      OPERATIONS_BY_FIXED_MODE,
      ROUTE_DECISION_FIELDS,
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
    const selectedChoices = context?.clarification_context?.selected_choices;
    if (!Array.isArray(selectedChoices) || !selectedChoices.length) return;
    for (const selected of selectedChoices) {
      const matches = catalog.filter(candidate => selectedChoiceCandidateMatches(candidate, selected));
      if (matches.length !== 1 || !decision.bindings.some(binding => binding.candidate_key === matches[0].candidate_key && binding.role === selected.role)) {
        throw new TypeError('A selected clarification resource was not preserved in the rerouted task');
      }
    }
  }

  function assertPartialAnswerPreservesEstablishedBindings(decision = {}, catalog = [], context = {}) {
    const clarification = context?.clarification_context;
    if (clarification?.continuation_relation !== 'partial_answer') return;
    const priorResources = Array.isArray(clarification?.prior_task_contract?.resources)
      ? clarification.prior_task_contract.resources
      : [];
    const selectedChoices = Array.isArray(clarification?.selected_choices)
      ? clarification.selected_choices
      : [];
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

    const taskContract = {
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
    return taskContract;
  }

    return Object.freeze({
      hasExactRouteDecision,
      selectedChoiceCandidateMatches,
      roleMatchesCandidate,
      operationAllowedByProductMode,
      compileRouteDecision,
    });
  }

  const api = Object.freeze({ createRouteDecisionCompiler });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('routeDecisionCompiler', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
