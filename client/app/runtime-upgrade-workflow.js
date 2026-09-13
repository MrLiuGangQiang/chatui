(function initChatUIRuntimeUpgradeWorkflow(root) {
  'use strict';

  const RUNTIME_STATE_VERSION = 'runtime_state.v1';
  const RUNTIME_STATE_KEY = 'chatui:runtime-state';
  const TRANSIENT_EXECUTION_PREFIXES = Object.freeze([
    'openapi-chat-image-job-v1:',
    'openapi-chat-image-chat-job-v1:',
    'openapi-chat-image-pending-submit-v1:',
    'openapi-chat-image-batch-v1:',
    'openapi-chat-image-batch-child-v1:',
  ]);

  function stringValue(value = '') { return String(value ?? '').trim(); }

  function normalizeIdentity(value = {}) {
    const sourceRevision = stringValue(value?.sourceRevision || value?.source_revision);
    return sourceRevision
      ? Object.freeze({
          version: stringValue(value?.version),
          gitSha: stringValue(value?.gitSha || value?.git_sha),
          sourceRevision,
        })
      : null;
  }

  function readRuntimeState(storage, key = RUNTIME_STATE_KEY) {
    try {
      const raw = storage?.getItem?.(key);
      const value = raw ? JSON.parse(raw) : null;
      if (value?.schema_version !== RUNTIME_STATE_VERSION) return null;
      return normalizeIdentity(value);
    } catch {
      return null;
    }
  }

  function writeRuntimeState(storage, identity, { key = RUNTIME_STATE_KEY, now = Date.now } = {}) {
    const normalized = normalizeIdentity(identity);
    if (!normalized) return false;
    try {
      storage?.setItem?.(key, JSON.stringify({
        schema_version: RUNTIME_STATE_VERSION,
        version: normalized.version,
        git_sha: normalized.gitSha,
        source_revision: normalized.sourceRevision,
        updated_at: Number(now()) || Date.now(),
      }));
      return true;
    } catch {
      return false;
    }
  }

  function runtimeChanged(previous, current) {
    const before = normalizeIdentity(previous);
    const after = normalizeIdentity(current);
    return !!before && !!after && before.sourceRevision !== after.sourceRevision;
  }

  function transientExecutionKeys(storage, prefixes = TRANSIENT_EXECUTION_PREFIXES) {
    const keys = [];
    try {
      const count = Number(storage?.length || 0);
      for (let index = 0; index < count; index += 1) {
        const key = stringValue(storage?.key?.(index));
        if (key && prefixes.some(prefix => key.startsWith(prefix))) keys.push(key);
      }
    } catch {}
    return keys;
  }

  function isPendingDisplay(item = {}) {
    return String(item?.pending || '') === '1' || item?.pending === true;
  }

  async function reconcileRuntimeUpgrade({
    identity = null,
    storage = root?.localStorage,
    sessions = [],
    persistSessionDisplay = async () => {},
    saveSessionMessages = async () => {},
    now = Date.now,
    stateKey = RUNTIME_STATE_KEY,
    logger = root?.console || console,
  } = {}) {
    const current = normalizeIdentity(identity);
    if (!current) return Object.freeze({ changed: false, invalidated: 0, reason: 'identity-unavailable' });

    const previous = readRuntimeState(storage, stateKey);
    const keys = transientExecutionKeys(storage);
    const hasPendingDisplay = (Array.isArray(sessions) ? sessions : []).some(session => (
      Array.isArray(session?.display) && session.display.some(isPendingDisplay)
    ));
    // A runtime marker change or missing marker is not sufficient evidence that
    // the server-side task is gone. Preserve the handoff snapshot for the normal
    // recovery path, which validates the job and execution contract before use.
    const legacyTransientState = !previous && (keys.length > 0 || hasPendingDisplay);
    const changed = legacyTransientState || runtimeChanged(previous, current);
    if (!changed) {
      writeRuntimeState(storage, current, { key: stateKey, now });
      return Object.freeze({ changed: false, invalidated: 0, reason: previous ? 'same-runtime' : 'initial-runtime-state' });
    }

    // Runtime revisions may change while a server-managed task is still alive
    // (for example during a same-process asset update). Do not blind-delete the
    // handoff snapshot here: resumeSessionJobs must first reconnect and validate
    // the execution contract. A missing or incompatible job is cleared by the
    // recovery path after that check.
    writeRuntimeState(storage, current, { key: stateKey, now });
    return Object.freeze({
      changed: true,
      invalidated: 0,
      clearedKeys: Object.freeze([]),
      affectedSessions: Object.freeze([]),
      previous,
      current,
      reason: previous ? 'runtime-changed' : 'legacy-runtime-state',
    });
  }

  const api = Object.freeze({
    RUNTIME_STATE_VERSION,
    RUNTIME_STATE_KEY,
    TRANSIENT_EXECUTION_PREFIXES,
    normalizeIdentity,
    readRuntimeState,
    writeRuntimeState,
    runtimeChanged,
    transientExecutionKeys,
    reconcileRuntimeUpgrade,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const registry = root?.[Symbol.for('chatui.module-registry.v1')]?.get('moduleRegistry');
  if (registry?.register) registry.register('runtimeUpgrade', api);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
