(function initChatUIRouteRepairPolicy(root) {
  'use strict';

  function createRouteRepairPolicy({
    routeProtocol = {},
    stripJsonFence = value => String(value || '').trim(),
    maxOutputChars = 12000,
  } = {}) {
    const {
      ROUTE_DECISION_VERSION,
      ROUTE_OPERATIONS,
      ROUTE_RELATIONS,
      ROUTE_ROLES,
      ROUTE_RESOURCE_TYPES,
      ROUTE_REASONS,
      ROUTE_CHANGES,
    } = routeProtocol;
    const MAX_ROUTE_REPAIR_OUTPUT_CHARS = maxOutputChars;

  function orderedSignatures(values = []) {
    return values.map(value => JSON.stringify(value));
  }

  function repairInvariantSnapshot(value = '') {
    try {
      if (typeof value === 'string' && value.length > MAX_ROUTE_REPAIR_OUTPUT_CHARS) return null;
      const raw = typeof value === 'string' ? JSON.parse(stripJsonFence(value)) : value;
      // Network repair is intentionally limited to the compact semantic protocol.
      // A model-authored task_contract can contain mechanical resource identities;
      // repairing it would let a second model response swap those identities while
      // appearing semantically equivalent. Exact legacy contracts may still be
      // read by the compatibility parser, but malformed ones fail closed here.
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema_version !== ROUTE_DECISION_VERSION) return null;
      if (!ROUTE_OPERATIONS.has(raw.operation)
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
        // Order is semantic: it determines canonical r-keys and same-role media
        // projections. Candidate order also determines clarification c-keys.
        resources: orderedSignatures(bindings),
        changes,
        constraints,
        clarification_question: raw.clarification.question,
        unresolved_count: unresolved.length,
        unresolved: orderedSignatures(unresolved),
      });
    } catch {
      return null;
    }
  }

  function repairPreservesInvariants(invariants = null, repairedValue = null) {
    if (!invariants || invariants.protocol !== ROUTE_DECISION_VERSION || !repairedValue) return false;
    const candidate = repairedValue?.routeDecision || repairedValue;
    const repaired = repairInvariantSnapshot(candidate);
    if (!repaired) return false;
    return repaired.protocol === invariants.protocol
      && repaired.operation === invariants.operation
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
