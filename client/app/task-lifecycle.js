(function initChatUIAppTaskLifecycle(root) {
  'use strict';

  function createTaskLifecycle(deps = {}) {
    if (!deps.state) throw new Error('state is required');
    const state = deps.state;
    const logger = deps.logger || console;
    const taskStateApi = deps.taskState || root?.ChatUICore?.taskState || null;
    state.taskStates ||= new Map();

    function getTaskState(sessionId) {
      return state.taskStates?.get?.(sessionId) || null;
    }

    function getTaskControls(sessionId) {
      const task = getTaskState(sessionId);
      return task && typeof taskStateApi?.deriveTaskControls === 'function'
        ? taskStateApi.deriveTaskControls(task)
        : null;
    }

    function dispatchTaskEvent(sessionId, event = {}) {
      if (!sessionId || typeof taskStateApi?.reduceTaskState !== 'function') return null;
      const current = getTaskState(sessionId) || taskStateApi.createTaskState?.({ sessionId });
      if (!current) return null;
      const next = taskStateApi.reduceTaskState(current, { ...event, sessionId });
      if (next !== current) {
        state.taskStates.set(sessionId, next);
        const controls = getTaskControls(sessionId);
        deps.setSessionBusy?.(sessionId, controls?.isBusy === true, { canonical: true });
        deps.onTaskStateChange?.(sessionId, next, current, event);
      }
      return next;
    }

    function runCleanup(label, callback) {
      if (typeof callback !== 'function') return;
      try {
        callback();
      } catch (error) {
        logger.warn?.(`session task cleanup failed: ${label}`, error);
      }
    }

    function hasActiveTaskOwner(sessionId) {
      const run = state.activeRuns?.get?.(sessionId);
      if (run && run.stopped !== true && run.abortController?.signal?.aborted !== true) return true;
      return [`submit:${sessionId}`, `chat:${sessionId}`, `image:${sessionId}`]
        .some(key => state.resumingJobs?.has?.(key));
    }

    function finishSessionTask(sessionId, options = {}) {
      if (!sessionId) return false;
      const {
        run = null,
        resumeKey = '',
        followingKind = '',
        jobId = '',
        timer = null,
        stopSlowNotice = null,
        focusPrompt = false,
      } = options;

      runCleanup('slow notice', stopSlowNotice);
      if (timer !== null && timer !== undefined) {
        runCleanup('timer', () => (deps.clearInterval || clearInterval)(timer));
      }
      if (resumeKey) runCleanup('resume marker', () => state.resumingJobs?.delete?.(resumeKey));
      if (jobId && followingKind === 'chat') runCleanup('chat follower', () => state.followingChatJobs?.delete?.(jobId));
      if (jobId && followingKind === 'image') runCleanup('image follower', () => state.followingImageJobs?.delete?.(jobId));
      if (run) {
        runCleanup('active run', () => {
          if (typeof deps.clearActiveRun === 'function') deps.clearActiveRun(sessionId, run);
          else if (state.activeRuns?.get?.(sessionId) === run) state.activeRuns.delete(sessionId);
        });
      }

      const remainsBusy = hasActiveTaskOwner(sessionId);
      runCleanup('busy state', () => deps.setSessionBusy?.(sessionId, remainsBusy));
      runCleanup('send availability', () => deps.updateSendAvailability?.());
      if (focusPrompt) runCleanup('prompt focus', () => deps.getPrompt?.()?.focus?.());
      return true;
    }

    return Object.freeze({ getTaskState, getTaskControls, dispatchTaskEvent, finishSessionTask });
  }

  const api = Object.freeze({ createTaskLifecycle });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppTaskLifecycle = api;
  if (root?.window) root.window.ChatUIAppTaskLifecycle = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
