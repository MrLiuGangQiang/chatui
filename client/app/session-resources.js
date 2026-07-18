(function initChatUISessionResources(root) {
  'use strict';

  function createSessionResourceLifecycle(deps = {}) {
    const getState = deps.getState || (() => ({}));
    const documentRef = deps.document || root.document;
    const localStorageRef = deps.localStorage || root.localStorage;
    const collectSessionImageKeys = deps.collectSessionImageKeys || (() => []);
    const collectAllSessionImageKeys = deps.collectAllSessionImageKeys || (() => new Set());
    const deleteImageDbKeys = deps.deleteImageDbKeys || (async () => {});
    const deleteOrphanImageBlobs = deps.deleteOrphanImageBlobs || (async () => {});
    const deleteSessionSnapshot = deps.deleteSessionSnapshot || (async () => {});
    const disposeManagedJob = deps.disposeManagedJob || (async () => {});
    const invalidateSessionDomCache = deps.invalidateSessionDomCache || (() => {});
    const isImagePendingDisplayItem = deps.isImagePendingDisplayItem || (() => false);
    const sessionStorageKey = deps.sessionStorageKey;
    const sessionChatJobKey = deps.sessionChatJobKey;
    const sessionImageJobKey = deps.sessionImageJobKey;
    const pendingSubmitKey = deps.pendingSubmitKey || (sessionId => `openapi-chat-image-pending-submit-v1:${sessionId || 'default'}`);
    const constants = deps.constants || {};
    const CHAT_KEY = constants.CHAT_KEY || 'openapi-chat-image-chat-v1';
    const UI_KEY = constants.UI_KEY || 'openapi-chat-image-ui-v1';
    const LAST_IMAGE_KEY = constants.LAST_IMAGE_KEY || 'openapi-chat-image-last-image-v1';

    function disposedSet() {
      const state = getState();
      if (!state.disposedSessionIds) state.disposedSessionIds = new Set();
      return state.disposedSessionIds;
    }

    function isSessionDisposed(sessionId) {
      return !!sessionId && disposedSet().has(sessionId);
    }

    function markSessionDisposed(sessionId) {
      if (sessionId) disposedSet().add(sessionId);
    }

    function safeStorageGet(key) {
      try { return key ? localStorageRef?.getItem?.(key) : null; } catch { return null; }
    }

    function parseStoredJson(raw) {
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    }

    function storageKeysForSession(sessionId) {
      return [
        sessionStorageKey?.(CHAT_KEY, sessionId),
        sessionStorageKey?.(UI_KEY, sessionId),
        sessionStorageKey?.(LAST_IMAGE_KEY, sessionId),
        sessionChatJobKey?.(sessionId),
        sessionImageJobKey?.(sessionId),
        pendingSubmitKey?.(sessionId),
      ].filter(Boolean);
    }

    function addManagedJob(target, kind, jobId) {
      const id = String(jobId || '').trim();
      if (id) target.set(`${kind}:${id}`, { kind, jobId: id });
    }

    function buildSessionResourceManifest(session) {
      const state = getState();
      const sessionId = String(session?.id || '');
      const localStorageKeys = storageKeysForSession(sessionId);
      const chatJob = parseStoredJson(safeStorageGet(sessionChatJobKey?.(sessionId)));
      const imageJob = parseStoredJson(safeStorageGet(sessionImageJobKey?.(sessionId)));
      const managedJobs = new Map();
      addManagedJob(managedJobs, 'chat', chatJob?.id);
      addManagedJob(managedJobs, 'image', imageJob?.id);
      for (const item of session?.display || []) {
        if (!item?.jobId) continue;
        addManagedJob(managedJobs, isImagePendingDisplayItem(item) ? 'image' : 'chat', item.jobId);
      }
      const activeRun = state.activeRuns?.get?.(sessionId);
      for (const value of activeRun?.jobIds || []) {
        const [kind, ...parts] = String(value || '').split(':');
        if (kind === 'chat' || kind === 'image') addManagedJob(managedJobs, kind, parts.join(':'));
      }
      const imageKeys = new Set(collectSessionImageKeys(session));
      return Object.freeze({
        sessionId,
        session,
        localStorageKeys,
        imageKeys,
        managedJobs: [...managedJobs.values()],
      });
    }

    function revokeObjectUrlsInNode(node) {
      if (!node?.querySelectorAll) return;
      const urls = new Set();
      const collect = element => {
        const values = [element?.dataset?.objectUrl, element?.getAttribute?.('src'), element?.getAttribute?.('href')];
        values.forEach(value => { if (String(value || '').startsWith('blob:')) urls.add(value); });
      };
      collect(node);
      node.querySelectorAll('[data-object-url], img[src^="blob:"], a[href^="blob:"]').forEach(collect);
      urls.forEach(url => { try { (deps.URL || root.URL)?.revokeObjectURL?.(url); } catch {} });
    }

    function quiesceSession(manifest) {
      const state = getState();
      const sessionId = manifest?.sessionId;
      if (!sessionId) return manifest;
      markSessionDisposed(sessionId);
      const activeRun = state.activeRuns?.get?.(sessionId);
      const liveRun = state.liveRuns?.get?.(sessionId);
      for (const run of [activeRun, liveRun]) {
        if (!run) continue;
        run.stopped = true;
        try { run.abortController?.abort?.(); } catch {}
        try { run.controller?.abort?.(); } catch {}
      }
      const messages = documentRef?.getElementById?.('messages');
      if (messages?.dataset?.sessionId === sessionId) revokeObjectUrlsInNode(messages);
      try { invalidateSessionDomCache(sessionId); } catch {}
      return manifest;
    }

    function cleanupRuntime(manifest) {
      const state = getState();
      const sessionId = manifest.sessionId;
      state.busySessions?.delete?.(sessionId);
      state.activeOutputSessions?.delete?.(sessionId);
      state.activeRuns?.delete?.(sessionId);
      state.taskStates?.delete?.(sessionId);
      state.liveRuns?.delete?.(sessionId);
      state.stoppedSessions?.delete?.(sessionId);
      state.promptDrafts?.delete?.(sessionId);
      state.resumingJobs?.delete?.(`chat:${sessionId}`);
      state.resumingJobs?.delete?.(`image:${sessionId}`);
      for (const job of manifest.managedJobs) {
        state.followingChatJobs?.delete?.(job.jobId);
        state.followingImageJobs?.delete?.(job.jobId);
      }
      if (state.activeOutputNode?.dataset?.sessionId === sessionId) state.activeOutputNode = null;
    }

    async function finalizeDisposal(list, remainingSessions) {
      if (!list.length) return;
      for (const manifest of list) {
        manifest.localStorageKeys.forEach(key => { try { localStorageRef?.removeItem?.(key); } catch {} });
        cleanupRuntime(manifest);
      }

      // Local deletion must never wait for a network abort/dispose request.
      // Snapshot tombstones prevent late queued writes from recreating records.
      const snapshotDeletes = list.map(manifest => deleteSessionSnapshot(manifest.sessionId));
      const jobs = new Map();
      list.flatMap(item => item.managedJobs).forEach(job => jobs.set(`${job.kind}:${job.jobId}`, job));
      [...jobs.values()].forEach(job => {
        Promise.resolve(disposeManagedJob(job.kind, job.jobId)).catch(() => {});
      });
      const retained = new Set(collectAllSessionImageKeys(remainingSessions));
      const candidates = new Set();
      list.forEach(manifest => manifest.imageKeys.forEach(key => { if (!retained.has(key)) candidates.add(key); }));
      const imageCleanup = (async () => {
        await deleteImageDbKeys([...candidates]);
        await deleteOrphanImageBlobs(remainingSessions);
      })();
      await Promise.allSettled([...snapshotDeletes, imageCleanup]);
    }

    function disposeSessions(sessions, remainingSessions = []) {
      const manifests = (sessions || [])
        .filter(session => session?.id)
        .map(buildSessionResourceManifest);
      manifests.forEach(quiesceSession);
      return finalizeDisposal(manifests, remainingSessions);
    }

    return Object.freeze({
      isSessionDisposed,
      disposeSessions,
    });
  }

  const api = Object.freeze({ createSessionResourceLifecycle });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUISessionResources = api;
  if (root?.window) root.window.ChatUISessionResources = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
