(function initChatUIAppRuns(root) {
  'use strict';

  function makeRun(sessionId, now = Date.now, random = Math.random) {
    return {
      sessionId,
      token: `run_${now().toString(36)}_${random().toString(36).slice(2, 8)}`,
      abortController: new AbortController(),
      jobIds: new Set(),
      stopped: false,
    };
  }

  function getActiveRun(appState, sessionId) {
    return appState.activeRuns?.get(sessionId) || null;
  }

  function isLiveRun(run) {
    return !!run && run.stopped !== true && run.abortController?.signal?.aborted !== true;
  }

  function pendingSubmitResumeKey(sessionId) {
    return `submit:${sessionId || ''}`;
  }

  function beginPendingSubmitResume(appState, sessionId) {
    if (!appState || !sessionId || isLiveRun(getActiveRun(appState, sessionId))) return '';
    appState.resumingJobs ||= new Set();
    const key = pendingSubmitResumeKey(sessionId);
    if (appState.resumingJobs.has(key)) return '';
    appState.resumingJobs.add(key);
    return key;
  }

  function finishPendingSubmitResume(appState, sessionId) {
    appState?.resumingJobs?.delete?.(pendingSubmitResumeKey(sessionId));
  }

  function ensureActiveRun(appState, sessionId, make = makeRun) {
    let run = getActiveRun(appState, sessionId);
    if (!run) {
      run = make(sessionId);
      appState.activeRuns.set(sessionId, run);
    }
    return run;
  }

  function addActiveRunJob(appState, sessionId, type, jobId) {
    if (!jobId) return false;
    const run = getActiveRun(appState, sessionId);
    if (!run) return false;
    run.jobIds.add(`${type}:${jobId}`);
    return true;
  }

  function isRunStopped(appState, sessionId) {
    return !!getActiveRun(appState, sessionId)?.stopped;
  }

  function bindFollowingRun(appState, sessionId, jobId, type = 'chat', make = makeRun) {
    if (!jobId) return null;
    const run = ensureActiveRun(appState, sessionId, make);
    run.jobIds.add(`${type}:${jobId}`);
    return run;
  }

  const api = Object.freeze({ makeRun, getActiveRun, isLiveRun, pendingSubmitResumeKey, beginPendingSubmitResume, finishPendingSubmitResume, ensureActiveRun, addActiveRunJob, isRunStopped, bindFollowingRun });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppRuns = api;
  if (root?.window) root.window.ChatUIAppRuns = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
