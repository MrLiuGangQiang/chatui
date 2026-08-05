(function initChatUIRouteRepairPolicy(root) {
  'use strict';

  function createRouteRepairPolicy({
    routeProtocol = {},
    stripJsonFence = value => String(value || '').trim(),
    maxOutputChars = 12000,
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
      SEMANTIC_ACTIONS,
      SEMANTIC_DISCOURSES,
      SEMANTIC_PENDING_EFFECTS,
      SEMANTIC_SLOT_PURPOSES,
      SEMANTIC_SLOT_RESOLUTIONS,
    } = routeProtocol;
    const MAX_ROUTE_REPAIR_OUTPUT_CHARS = maxOutputChars;

    function orderedSignatures(values = []) {
      return values.map(value => JSON.stringify(value));
    }

    function semanticSnapshot(raw) {
      if (!raw || raw.schema_version !== SEMANTIC_TASK_VERSION
          || !Array.isArray(raw.actions)
          || raw.actions.length < 1
          || new Set(raw.actions).size !== raw.actions.length
          || raw.actions.some(action => !SEMANTIC_ACTIONS.has(action))
          || !SEMANTIC_DISCOURSES.has(raw.discourse)
          || !SEMANTIC_PENDING_EFFECTS.has(raw.pending_effect)
          || !Array.isArray(raw.slots)
          || !Array.isArray(raw.changes)
          || !Array.isArray(raw.constraints)) return null;
      const slots = raw.slots.map(slot => {
        if (!ROUTE_RESOURCE_TYPES.has(slot?.kind)
            || !SEMANTIC_SLOT_PURPOSES.has(slot?.purpose)
            || !SEMANTIC_SLOT_RESOLUTIONS.has(slot?.resolution)
            || typeof slot?.label !== 'string'
            || !Array.isArray(slot?.candidate_keys)) throw new TypeError('incomplete semantic slot invariant');
        const candidateKeys = slot.candidate_keys.map(key => String(key || ''));
        const uniqueCandidateKeys = new Set(candidateKeys);
        if (candidateKeys.some(key => !/^[ifm][1-9]\d*$/.test(key))
            || uniqueCandidateKeys.size !== candidateKeys.length
            || (slot.resolution === 'bound' && candidateKeys.length !== 1)
            || (slot.resolution === 'ambiguous' && candidateKeys.length < 2)
            || (['missing', 'unavailable'].includes(slot.resolution) && candidateKeys.length > 0)) {
          throw new TypeError('incomplete semantic candidates');
        }
        return {
          kind: slot.kind,
          purpose: slot.purpose,
          label: slot.label,
          resolution: slot.resolution,
          candidate_keys: candidateKeys,
        };
      });
      const changes = raw.changes.map(change => {
        const op = String(change?.op || '');
        if (!ROUTE_CHANGES.has(op) || typeof change?.target !== 'string' || typeof change?.value !== 'string') {
          throw new TypeError('incomplete semantic change invariant');
        }
        return { op, target: change.target, value: change.value };
      });
      const constraints = raw.constraints.map(constraint => {
        if (typeof constraint !== 'string') throw new TypeError('incomplete semantic constraint invariant');
        return constraint;
      });
      return Object.freeze({
        protocol: SEMANTIC_TASK_VERSION,
        actions: orderedSignatures(raw.actions),
        discourse: raw.discourse,
        pending_effect: raw.pending_effect,
        slots: orderedSignatures(slots),
        changes,
        constraints,
      });
    }

    function routeDecisionSnapshot(raw) {
      if (!raw || raw.schema_version !== ROUTE_DECISION_VERSION
          || !ROUTE_OPERATIONS.has(raw.operation)
          || !ROUTE_RELATIONS.has(raw.relation)
          || !['ready', 'needs_clarification'].includes(raw.readiness)
          || !Array.isArray(raw.bindings)
          || !Array.isArray(raw.changes)
          || !Array.isArray(raw.constraints)
          || typeof raw.clarification?.question !== 'string'
          || !Array.isArray(raw.clarification?.unresolved)) return null;
      const bindings = raw.bindings.map(binding => {
        const candidateKey = String(binding?.candidate_key || '');
        const role = String(binding?.role || '');
        if (!/^[ifm][1-9]\d*$/.test(candidateKey) || !ROUTE_ROLES.has(role)) throw new TypeError('incomplete binding invariant');
        return { candidate_key: candidateKey, role };
      });
      const unresolved = raw.clarification.unresolved.map(slot => {
        const type = String(slot?.type || '');
        const role = String(slot?.role || '');
        const reason = String(slot?.reason || '');
        if (!ROUTE_RESOURCE_TYPES.has(type) || !ROUTE_ROLES.has(role) || !ROUTE_REASONS.has(reason) || !Array.isArray(slot?.candidate_keys)) {
          throw new TypeError('incomplete unresolved invariant');
        }
        const candidateKeys = slot.candidate_keys.map(key => String(key || ''));
        if (candidateKeys.some(key => !/^[ifm][1-9]\d*$/.test(key))) throw new TypeError('incomplete unresolved candidates');
        return { type, role, reason, candidate_keys: candidateKeys };
      });
      const changes = raw.changes.map(change => {
        const op = String(change?.op || '');
        if (!ROUTE_CHANGES.has(op) || typeof change?.target !== 'string' || typeof change?.value !== 'string') {
          throw new TypeError('incomplete change invariant');
        }
        return { op, target: change.target, value: change.value };
      });
      const constraints = raw.constraints.map(constraint => {
        if (typeof constraint !== 'string') throw new TypeError('incomplete constraint invariant');
        return constraint;
      });
      return Object.freeze({
        protocol: ROUTE_DECISION_VERSION,
        operation: raw.operation,
        relation: raw.relation,
        readiness: raw.readiness,
        resource_count: bindings.length,
        resources: orderedSignatures(bindings),
        changes,
        constraints,
        clarification_question: raw.clarification.question,
        unresolved_count: unresolved.length,
        unresolved: orderedSignatures(unresolved),
      });
    }

    function repairInvariantSnapshot(value = '', { semanticOnly = false } = {}) {
      try {
        if (typeof value === 'string' && value.length > MAX_ROUTE_REPAIR_OUTPUT_CHARS) return null;
        const raw = typeof value === 'string' ? JSON.parse(stripJsonFence(value)) : value;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        if (semanticOnly && raw.schema_version !== SEMANTIC_TASK_VERSION) return null;
        if (raw.schema_version === SEMANTIC_TASK_VERSION) return semanticSnapshot(raw);
        // Legacy route_decision repair remains readable during migration, but new
        // requests use semantic_task.v2 and never repair a task contract directly.
        return routeDecisionSnapshot(raw);
      } catch {
        return null;
      }
    }

    function repairPreservesInvariants(invariants = null, repairedValue = null) {
      if (!invariants || !repairedValue || typeof repairedValue !== 'object') return false;
      const candidate = repairedValue?.semanticTask
        || repairedValue?.route?.semanticTask
        || repairedValue?.routeDecision
        || repairedValue;
      const repaired = repairInvariantSnapshot(candidate);
      if (!repaired || repaired.protocol !== invariants.protocol) return false;
      if (invariants.protocol === SEMANTIC_TASK_VERSION) {
        return JSON.stringify(repaired.actions) === JSON.stringify(invariants.actions)
          && repaired.discourse === invariants.discourse
          && repaired.pending_effect === invariants.pending_effect
          && JSON.stringify(repaired.slots) === JSON.stringify(invariants.slots)
          && JSON.stringify(repaired.changes || []) === JSON.stringify(invariants.changes || [])
          && JSON.stringify(repaired.constraints || []) === JSON.stringify(invariants.constraints || []);
      }
      return repaired.operation === invariants.operation
        && repaired.relation === invariants.relation
        && repaired.readiness === invariants.readiness
        && repaired.resource_count === invariants.resource_count
        && repaired.unresolved_count === invariants.unresolved_count
        && JSON.stringify(repaired.resources) === JSON.stringify(invariants.resources)
        && JSON.stringify(repaired.changes || []) === JSON.stringify(invariants.changes || [])
        && JSON.stringify(repaired.constraints || []) === JSON.stringify(invariants.constraints || [])
        && String(repaired.clarification_question || '') === String(invariants.clarification_question || '')
        && JSON.stringify(repaired.unresolved) === JSON.stringify(invariants.unresolved);
    }

    return Object.freeze({ repairInvariantSnapshot, repairPreservesInvariants });
  }

  const api = Object.freeze({ createRouteRepairPolicy });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry')?.register('routeRepairPolicy', api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
