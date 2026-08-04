(function initChatUIRouteLegacyAdapter(root) {
  'use strict';

  function createRouteLegacyAdapter({
    intentContract = {},
    routeDecisionVersion = 'route_decision.v1',
    roleMatchesCandidate = () => false,
    selectedChoiceCandidateMatches = () => false,
    compactRoutePayloadContext = context => context || {},
    buildRouteResourceCandidates = () => [],
    hasExactRouteDecision = () => false,
    compileRouteDecision = () => { throw new TypeError('route decision compiler unavailable'); },
    messageIdentity = () => '',
  } = {}) {
    const ROUTE_DECISION_VERSION = routeDecisionVersion;

  function implicitCurrentTextResource(resource = {}) {
    return resource?.type === 'text'
      && resource?.source === 'current'
      && resource?.role === 'source'
      && !String(resource?.id || '')
      && !String(resource?.reference_id || '');
  }

  function legacyDecisionBindingRole(resource = {}, operation = '') {
    // task_contract.v4/v5 historically allowed a quoted message to use
    // role=reference for text-to-image. The compact decision protocol models all
    // message bindings as context, so preserve the behavior through an explicit
    // compatibility alias instead of widening the native decision grammar.
    if (resource?.type === 'message' && resource?.role === 'reference' && operation === 'text_to_image') return 'context';
    return String(resource?.role || '');
  }

  function legacyResourceCandidate(resource = {}, catalog = [], usedKeys = new Set(), operation = '') {
    const decisionRole = legacyDecisionBindingRole(resource, operation);
    const matches = catalog.filter(candidate => !usedKeys.has(candidate.candidate_key)
      && roleMatchesCandidate(candidate.type, decisionRole)
      && selectedChoiceCandidateMatches(candidate, resource));
    return matches.length === 1 ? matches[0] : null;
  }

  function contractSemanticSnapshot(task = {}) {
    const resources = (Array.isArray(task.resources) ? task.resources : [])
      .filter(resource => !implicitCurrentTextResource(resource))
      .map(resource => ({
        type: resource.type,
        source: resource.source,
        role: resource.role,
        index: Number(resource.index),
        id: String(resource.id || ''),
        reference_id: String(resource.reference_id || ''),
      }));
    const unresolved = (Array.isArray(task.clarification?.unresolved_resources) ? task.clarification.unresolved_resources : [])
      .map(slot => ({
        type: slot.type,
        role: slot.role,
        reason: slot.reason,
        choices: (Array.isArray(slot.choices) ? slot.choices : []).map(choice => ({
          source: choice.source,
          index: Number(choice.index),
          id: String(choice.id || ''),
          reference_id: String(choice.reference_id || ''),
        })),
      }));
    return {
      readiness: task.readiness,
      operation: task.operation,
      relation: task.relation,
      resources,
      directive: {
        // mode, base_resource_keys, and unmentioned_policy are mechanical fields
        // that route_decision.v1 deliberately leaves to the compiler. Legacy
        // contracts may retain a valid historical policy after their identities
        // and decision-expressible semantics have been proven equivalent.
        operations: Array.isArray(task.directive?.operations) ? task.directive.operations.map(operation => ({ ...operation })) : [],
        constraints: Array.isArray(task.directive?.constraints) ? task.directive.constraints.map(constraint => String(constraint)) : [],
      },
      clarification: {
        question: String(task.clarification?.question || ''),
        unresolved,
      },
    };
  }

  function convertLegacyTaskContractToDecision(value = {}, options = {}) {
    try {
      const normalized = typeof intentContract?.normalizeContractVersion === 'function'
        ? intentContract.normalizeContractVersion(value)
        : value;
      const canonical = typeof intentContract?.canonicalizeContractBindings === 'function'
        ? intentContract.canonicalizeContractBindings(normalized, options)
        : normalized;
      if (!intentContract?.hasExactContractShape?.(canonical)) return null;

      const compilerContext = compactRoutePayloadContext(options.context || {}, options.input || '', options.attachments || [], options.currentTurn || null);
      const catalog = buildRouteResourceCandidates({ attachments: options.attachments || [], context: compilerContext });
      const usedCandidateKeys = new Set();
      const bindings = [];
      const comparisonResources = [];
      for (const resource of canonical.resources) {
        if (implicitCurrentTextResource(resource)) {
          comparisonResources.push({ ...resource });
          continue;
        }
        const decisionRole = legacyDecisionBindingRole(resource, canonical.operation);
        const candidate = legacyResourceCandidate(resource, catalog, usedCandidateKeys, canonical.operation);
        if (!candidate) return null;
        usedCandidateKeys.add(candidate.candidate_key);
        bindings.push({ candidate_key: candidate.candidate_key, role: decisionRole });
        comparisonResources.push({
          ...resource,
          source: candidate.source,
          role: decisionRole,
          index: candidate.index,
          id: candidate.id,
          reference_id: candidate.reference_id,
        });
      }

      const comparisonUnresolved = [];
      const unresolved = canonical.clarification.unresolved_resources.map(slot => {
        const decisionRole = legacyDecisionBindingRole({ type: slot.type, role: slot.role }, canonical.operation);
        const candidateKeys = [];
        const comparisonChoices = [];
        for (const choice of slot.choices) {
          const candidate = legacyResourceCandidate({ ...choice, type: slot.type, role: slot.role }, catalog, usedCandidateKeys, canonical.operation);
          if (!candidate || candidateKeys.includes(candidate.candidate_key)) return null;
          candidateKeys.push(candidate.candidate_key);
          comparisonChoices.push({
            ...choice,
            source: candidate.source,
            index: candidate.index,
            id: candidate.id,
            reference_id: candidate.reference_id,
          });
        }
        comparisonUnresolved.push({ ...slot, role: decisionRole, choices: comparisonChoices });
        return {
          type: slot.type,
          role: decisionRole,
          reason: slot.reason,
          candidate_keys: candidateKeys,
        };
      });

      const decision = {
        schema_version: ROUTE_DECISION_VERSION,
        readiness: canonical.readiness,
        operation: canonical.operation,
        relation: canonical.relation,
        bindings,
        changes: canonical.directive.operations.map(operation => ({ ...operation })),
        constraints: canonical.directive.constraints.map(constraint => String(constraint)),
        clarification: {
          question: canonical.clarification.question,
          unresolved,
        },
        confidence: canonical.confidence,
        rationale: canonical.rationale,
      };
      if (!hasExactRouteDecision(decision)) return null;
      const compiled = compileRouteDecision(decision, options);
      const compiledCanonical = typeof intentContract?.canonicalizeContractBindings === 'function'
        ? intentContract.canonicalizeContractBindings(compiled, options)
        : compiled;
      const comparisonCanonical = {
        ...canonical,
        resources: comparisonResources,
        clarification: {
          ...canonical.clarification,
          unresolved_resources: comparisonUnresolved,
        },
      };
      const comparisonResolved = typeof intentContract?.canonicalizeContractBindings === 'function'
        ? intentContract.canonicalizeContractBindings(comparisonCanonical, options)
        : comparisonCanonical;
      if (JSON.stringify(contractSemanticSnapshot(comparisonResolved)) !== JSON.stringify(contractSemanticSnapshot(compiledCanonical))) return null;
      return decision;
    } catch {
      return null;
    }
  }

  function preserveLegacyClarificationLabels(route = null, legacyTask = {}) {
    if (!route?.needClarification || !route.taskContract) return route;
    const legacySlots = Array.isArray(legacyTask?.clarification?.unresolved_resources)
      ? legacyTask.clarification.unresolved_resources
      : [];
    const compiledSlots = Array.isArray(route.taskContract?.clarification?.unresolved_resources)
      ? route.taskContract.clarification.unresolved_resources
      : [];
    if (legacySlots.length !== compiledSlots.length) return route;
    const unresolvedResources = compiledSlots.map((slot, slotIndex) => {
      const legacyChoices = Array.isArray(legacySlots[slotIndex]?.choices) ? legacySlots[slotIndex].choices : [];
      if (legacyChoices.length !== slot.choices.length) return slot;
      return {
        ...slot,
        choices: slot.choices.map((choice, choiceIndex) => ({
          ...choice,
          label: String(legacyChoices[choiceIndex]?.label || choice.label || '').trim() || choice.label,
        })),
      };
    });
    const taskContract = {
      ...route.taskContract,
      clarification: {
        ...route.taskContract.clarification,
        unresolved_resources: unresolvedResources,
      },
    };
    return {
      ...route,
      taskContract,
      clarificationSlots: unresolvedResources,
    };
  }

  function safeLegacyExplicitQuoteRoute(task = {}, options = {}, route = null) {
    const quote = options.context?.quoted_message;
    const resources = Array.isArray(task?.resources) ? task.resources : [];
    const operations = Array.isArray(task?.directive?.operations) ? task.directive.operations : [];
    const constraints = Array.isArray(task?.directive?.constraints) ? task.directive.constraints : [];
    if (!route || !quote || task.operation !== 'plain_chat' || task.relation !== 'followup'
        || resources.length !== 1 || operations.length || constraints.length) return null;
    const resource = resources[0];
    const quoteId = messageIdentity(quote);
    if (resource?.type !== 'message' || resource?.role !== 'context'
        || !['history', 'quoted'].includes(resource?.source)
        || Number(resource?.index) !== Number(quote.index)
        || quoteId && String(resource?.id || '') !== quoteId) return null;
    return { ...route, legacyExplicitQuoteBound: true };
  }

    return Object.freeze({
      convertLegacyTaskContractToDecision,
      preserveLegacyClarificationLabels,
      safeLegacyExplicitQuoteRoute,
    });
  }

  const api = Object.freeze({ createRouteLegacyAdapter });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('routeLegacyAdapter', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
