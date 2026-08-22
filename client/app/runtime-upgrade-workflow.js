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
    // The first rollout that introduces this marker may encounter snapshots
    // written by an older browser bundle. They have no provenance and must not
    // be replayed under a new execution contract. Completed history remains
    // untouched; only the resumable handoff state is retired.
    const legacyTransientState = !previous && (keys.length > 0 || hasPendingDisplay);
    if (!legacyTransientState && !runtimeChanged(previous, current)) {
      writeRuntimeState(storage, current, { key: stateKey, now });
      return Object.freeze({ changed: false, invalidated: 0, reason: previous ? 'same-runtime' : 'initial-runtime-state' });
    }

    for (const key of keys) {
      try { storage?.removeItem?.(key); } catch (error) { logger?.warn?.('failed to remove stale runtime task snapshot', key, error); }
    }

    const affectedSessions = [];
    const restartNotice = '应用已更新，上一项未完成任务未自动恢复。请重新发送原指令。';
    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (!session || !session.id || !Array.isArray(session.display)) continue;
      const retained = session.display.filter(item => !isPendingDisplay(item));
      if (retained.length === session.display.length) continue;
      session.display = retained;
      const messages = Array.isArray(session.messages) ? session.messages : (session.messages = []);
      const noticeId = `runtime-upgrade:${current.sourceRevision}:${session.id}`;
      if (!messages.some(message => message?.id === noticeId)) {
        messages.push({
          id: noticeId,
          role: 'assistant',
          content: restartNotice,
          rawText: restartNotice,
          responseIndex: String(messages.length),
        });
      }
      affectedSessions.push(String(session.id));
    }
    await Promise.allSettled(affectedSessions.flatMap(sessionId => [
      Promise.resolve(persistSessionDisplay(sessionId)),
      Promise.resolve(saveSessionMessages(sessionId)),
    ]));
    writeRuntimeState(storage, current, { key: stateKey, now });

    return Object.freeze({
      changed: true,
      invalidated: keys.length + affectedSessions.length,
      clearedKeys: Object.freeze(keys),
      affectedSessions: Object.freeze(affectedSessions),
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
