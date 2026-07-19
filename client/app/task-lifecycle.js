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

    function taskEventDetails(task) {
      return {
        taskId: task?.taskId || '',
        submissionId: task?.submissionId || '',
        jobId: task?.jobId || '',
        jobKind: task?.jobKind || '',
      };
    }

    function readStopJob(label, callback) {
      if (typeof callback !== 'function') return null;
      try {
        return callback() || null;
      } catch (error) {
        logger.warn?.(`session task stop lookup failed: ${label}`, error);
        return null;
      }
    }

    function addStopJob(run, kind, job) {
      const jobId = String(job?.id || '').trim();
      if (!run || !jobId) return '';
      run.jobIds ||= new Set();
      run.jobIds.add(`${kind}:${jobId}`);
      return jobId;
    }

    async function stopSessionTask(sessionId) {
      if (!sessionId) return false;
      const stop = deps.stop || {};
      const task = getTaskState(sessionId);
      const identity = taskEventDetails(task);
      const stopRequestedEvent = taskStateApi?.TASK_EVENTS?.TASK_STOP_REQUESTED;
      const stoppedEvent = taskStateApi?.TASK_EVENTS?.TASK_STOPPED;
      const stoppedPhase = taskStateApi?.TASK_PHASES?.STOPPED;
      const hasCanonicalTask = Boolean(
        task
        && stopRequestedEvent
        && stoppedEvent
        && stoppedPhase
        && typeof taskStateApi?.reduceTaskState === 'function'
      );
      const run = stop.getActiveRun?.(sessionId) || stop.ensureActiveRun?.(sessionId) || null;

      if (hasCanonicalTask) dispatchTaskEvent(sessionId, { type: stopRequestedEvent, ...identity });
      if (run) {
        run.stopped = true;
        state.stoppedSessions ||= new Map();
        state.stoppedSessions.set(sessionId, run.token);
        runCleanup('run abort', () => run.abortController?.abort?.());
      }

      // Pending ownership must be cleared synchronously before the first await so
      // a stopped capture/routing continuation cannot resurrect the submission.
      runCleanup('pending submission', () => stop.clearPendingSubmit?.(sessionId));
      const chatJob = readStopJob('chat job', () => stop.loadChatJob?.(sessionId));
      const imageJob = readStopJob('image job', () => stop.loadImageJob?.(sessionId));
      const chatJobId = addStopJob(run, 'chat', chatJob);
      const imageJobId = addStopJob(run, 'image', imageJob);
      runCleanup('stopping projection', () => stop.markStopping?.(sessionId));
      if (!hasCanonicalTask) runCleanup('legacy busy state', () => deps.setSessionBusy?.(sessionId, false));

      const aborts = [...(run?.jobIds || [])].map(value => {
        const [kind, ...parts] = String(value).split(':');
        return Promise.resolve().then(() => stop.abortManagedJob?.(kind, parts.join(':')));
      });

      try {
        await Promise.allSettled(aborts);
      } finally {
        runCleanup('chat job', () => chatJobId && stop.clearChatJob?.(sessionId, chatJobId));
        runCleanup('image job', () => imageJobId && stop.clearImageJob?.(sessionId, imageJobId));
        const stoppedTask = hasCanonicalTask
          ? dispatchTaskEvent(sessionId, { type: stoppedEvent, ...identity })
          : null;
        const ownsStoppedProjection = !hasCanonicalTask || (
          stoppedTask?.phase === stoppedPhase
          && stoppedTask?.submissionId === task.submissionId
        );
        if (ownsStoppedProjection) runCleanup('stopped projection', () => stop.finalizeStopped?.(sessionId));
        finishSessionTask(sessionId, { run });
      }
      return true;
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

    function settleSessionTask(sessionId, options = {}) {
      if (!sessionId) return false;
      const {
        outcome = 'completed',
        error = null,
        submissionId = '',
        jobId = '',
        jobKind = '',
      } = options;
      const task = getTaskState(sessionId);
      const identity = {
        ...taskEventDetails(task),
        ...(submissionId ? { submissionId } : {}),
        ...(jobId ? { jobId } : {}),
        ...(jobKind ? { jobKind } : {}),
      };
      let eventType = '';
      if (outcome === 'completed') {
        eventType = String(identity.jobId || task?.jobId || '')
          ? taskStateApi?.TASK_EVENTS?.JOB_COMPLETED_COMMITTED
          : taskStateApi?.TASK_EVENTS?.TASK_COMPLETED_COMMITTED;
      } else if (outcome === 'failed') {
        eventType = String(identity.jobId || task?.jobId || '')
          ? taskStateApi?.TASK_EVENTS?.JOB_FAILED
          : taskStateApi?.TASK_EVENTS?.TASK_FAILED;
      } else if (outcome === 'stopped') {
        eventType = taskStateApi?.TASK_EVENTS?.TASK_STOPPED;
      }
      if (eventType) dispatchTaskEvent(sessionId, { type: eventType, ...identity, error });
      const settledJobId = String(identity.jobId || task?.jobId || '');
      const settledJobKind = String(identity.jobKind || task?.jobKind || '');
      const cleanupOptions = {
        ...options,
        ...(!options.resumeKey && settledJobKind ? { resumeKey: `${settledJobKind}:${sessionId}` } : {}),
        ...(!options.followingKind && settledJobKind ? { followingKind: settledJobKind } : {}),
        ...(!options.jobId && settledJobId ? { jobId: settledJobId } : {}),
      };
      return finishSessionTask(sessionId, cleanupOptions);
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

    return Object.freeze({ getTaskState, getTaskControls, dispatchTaskEvent, stopSessionTask, settleSessionTask, finishSessionTask });
  }

  const api = Object.freeze({ createTaskLifecycle });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ChatUIAppTaskLifecycle = api;
  if (root?.window) root.window.ChatUIAppTaskLifecycle = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
