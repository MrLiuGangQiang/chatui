(function initChatUICoreTaskState(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root?.ChatUICore?.registerModule?.('taskState', api);
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function createChatUICoreTaskState() {
  'use strict';

const TASK_PHASES = Object.freeze({
  IDLE: 'idle',
  ACCEPTED: 'accepted',
  CAPTURING: 'capturing',
  ROUTING: 'routing',
  HANDOFF: 'handoff',
  RUNNING: 'running',
  RECOVERING: 'recovering',
  STOPPING: 'stopping',
  COMPLETED: 'completed',
  FAILED: 'failed',
  STOPPED: 'stopped',
});

const TASK_EVENTS = Object.freeze({
  TASK_ACCEPTED: 'TASK_ACCEPTED',
  ATTACHMENT_CAPTURE_STARTED: 'ATTACHMENT_CAPTURE_STARTED',
  ATTACHMENT_CAPTURED: 'ATTACHMENT_CAPTURED',
  ROUTING_STARTED: 'ROUTING_STARTED',
  HANDOFF_PREPARED: 'HANDOFF_PREPARED',
  HANDOFF_COMMITTED: 'HANDOFF_COMMITTED',
  JOB_STARTED: 'JOB_STARTED',
  JOB_RECOVERY_STARTED: 'JOB_RECOVERY_STARTED',
  JOB_COMPLETED_COMMITTED: 'JOB_COMPLETED_COMMITTED',
  TASK_COMPLETED_COMMITTED: 'TASK_COMPLETED_COMMITTED',
  JOB_FAILED: 'JOB_FAILED',
  TASK_FAILED: 'TASK_FAILED',
  TASK_STOP_REQUESTED: 'TASK_STOP_REQUESTED',
  TASK_STOPPED: 'TASK_STOPPED',
  SESSION_DISPOSED: 'SESSION_DISPOSED',
});

const TASK_OWNERS = Object.freeze({
  NONE: 'none',
  PENDING_SUBMISSION: 'pending_submission',
  MANAGED_JOB: 'managed_job',
  CANONICAL_SESSION: 'canonical_session',
});

const ACTIVE_PHASES = new Set([
  TASK_PHASES.ACCEPTED,
  TASK_PHASES.CAPTURING,
  TASK_PHASES.ROUTING,
  TASK_PHASES.HANDOFF,
  TASK_PHASES.RUNNING,
  TASK_PHASES.RECOVERING,
  TASK_PHASES.STOPPING,
]);

const TERMINAL_PHASES = new Set([
  TASK_PHASES.COMPLETED,
  TASK_PHASES.FAILED,
  TASK_PHASES.STOPPED,
]);

function stringValue(value) {
  return value === undefined || value === null ? '' : String(value);
}

function createTaskState(overrides = {}) {
  return Object.freeze({
    phase: TASK_PHASES.IDLE,
    sessionId: '',
    taskId: '',
    submissionId: '',
    jobId: '',
    jobKind: '',
    owner: TASK_OWNERS.NONE,
    error: null,
    disposed: false,
    revision: 0,
    ...overrides,
  });
}

function isTaskActive(state = {}) {
  return ACTIVE_PHASES.has(state.phase);
}

function isTaskTerminal(state = {}) {
  return TERMINAL_PHASES.has(state.phase);
}

function deriveTaskControls(state = createTaskState()) {
  const active = isTaskActive(state);
  const stopping = state.phase === TASK_PHASES.STOPPING;
  return Object.freeze({
    isBusy: active,
    canSubmit: !active,
    canStop: active && !stopping,
    sendAction: active ? (stopping ? 'wait' : 'stop') : 'submit',
  });
}

function eventIdentity(event = {}) {
  return stringValue(event.taskId || event.submissionId || event.jobId);
}

// Non-bootstrap events must identify the task or managed job. Session identity
// alone cannot protect a newer task from a late completion in the same session.
function hasMatchingIdentity(state, event) {
  const compared = [];
  for (const key of ['sessionId', 'taskId', 'submissionId', 'jobId']) {
    const eventValue = stringValue(event[key]);
    const stateValue = stringValue(state[key]);
    if (!eventValue || !stateValue) continue;
    compared.push(key);
    if (eventValue !== stateValue) return false;
  }
  return compared.some(key => key !== 'sessionId');
}

function canStartNewTask(state) {
  return state.phase === TASK_PHASES.IDLE || isTaskTerminal(state);
}

function sameStateValues(state, patch) {
  return Object.entries(patch).every(([key, value]) => state[key] === value);
}

function transition(state, patch) {
  if (sameStateValues(state, patch)) return state;
  return Object.freeze({ ...state, ...patch, revision: Number(state.revision || 0) + 1 });
}

function acceptTask(state, event) {
  if (!canStartNewTask(state)) return state;
  const identity = stringValue(event.taskId || event.submissionId);
  if (!identity) return state;
  const submissionId = stringValue(event.submissionId || event.taskId);
  return transition(state, {
    phase: TASK_PHASES.ACCEPTED,
    sessionId: stringValue(event.sessionId),
    taskId: stringValue(event.taskId || submissionId),
    submissionId,
    jobId: '',
    jobKind: '',
    owner: TASK_OWNERS.PENDING_SUBMISSION,
    error: null,
    disposed: false,
  });
}

function beginRecovery(state, event) {
  if (state.phase !== TASK_PHASES.IDLE && !hasMatchingIdentity(state, event)) return state;
  const identity = eventIdentity(event);
  const jobId = stringValue(event.jobId);
  if (!identity || !jobId) return state;
  const submissionId = stringValue(event.submissionId || state.submissionId || event.taskId || identity);
  return transition(state, {
    phase: TASK_PHASES.RECOVERING,
    sessionId: stringValue(event.sessionId || state.sessionId),
    taskId: stringValue(event.taskId || state.taskId || submissionId),
    submissionId,
    jobId,
    jobKind: stringValue(event.jobKind || state.jobKind),
    owner: TASK_OWNERS.MANAGED_JOB,
    error: null,
    disposed: false,
  });
}

function reduceTaskState(currentState, event = {}) {
  const state = currentState || createTaskState();
  if (!event || typeof event !== 'object') return state;

  if (event.type === TASK_EVENTS.TASK_ACCEPTED) return acceptTask(state, event);
  if (event.type === TASK_EVENTS.JOB_RECOVERY_STARTED) return beginRecovery(state, event);
  if (event.type === TASK_EVENTS.SESSION_DISPOSED) {
    if (event.sessionId && state.sessionId && String(event.sessionId) !== state.sessionId) return state;
    return transition(state, {
      phase: TASK_PHASES.STOPPED,
      owner: TASK_OWNERS.NONE,
      error: null,
      disposed: true,
    });
  }
  if (!hasMatchingIdentity(state, event)) return state;

  switch (event.type) {
    case TASK_EVENTS.ATTACHMENT_CAPTURE_STARTED:
      if (state.phase !== TASK_PHASES.ACCEPTED) return state;
      return transition(state, { phase: TASK_PHASES.CAPTURING });

    // Captured is a durable pending-submit stage, but not a canonical UI phase.
    // Once capture succeeds, the task is ready for routing.
    case TASK_EVENTS.ATTACHMENT_CAPTURED:
      if (![TASK_PHASES.ACCEPTED, TASK_PHASES.CAPTURING].includes(state.phase)) return state;
      return transition(state, { phase: TASK_PHASES.ROUTING });

    case TASK_EVENTS.ROUTING_STARTED:
      if (![TASK_PHASES.ACCEPTED, TASK_PHASES.CAPTURING, TASK_PHASES.ROUTING].includes(state.phase)) return state;
      return transition(state, { phase: TASK_PHASES.ROUTING });

    case TASK_EVENTS.HANDOFF_PREPARED:
      if (![TASK_PHASES.ROUTING, TASK_PHASES.HANDOFF].includes(state.phase)) return state;
      if (!event.jobId) return state;
      return transition(state, {
        phase: TASK_PHASES.HANDOFF,
        jobId: stringValue(event.jobId),
        jobKind: stringValue(event.jobKind || state.jobKind),
        owner: TASK_OWNERS.PENDING_SUBMISSION,
      });

    case TASK_EVENTS.HANDOFF_COMMITTED:
    case TASK_EVENTS.JOB_STARTED:
      if (![TASK_PHASES.HANDOFF, TASK_PHASES.RECOVERING, TASK_PHASES.RUNNING].includes(state.phase)) return state;
      if (!stringValue(event.jobId || state.jobId)) return state;
      return transition(state, {
        phase: TASK_PHASES.RUNNING,
        jobId: stringValue(event.jobId || state.jobId),
        jobKind: stringValue(event.jobKind || state.jobKind),
        owner: TASK_OWNERS.MANAGED_JOB,
        error: null,
      });

    case TASK_EVENTS.TASK_COMPLETED_COMMITTED:
      if (![TASK_PHASES.ACCEPTED, TASK_PHASES.CAPTURING, TASK_PHASES.ROUTING].includes(state.phase)) return state;
      return transition(state, {
        phase: TASK_PHASES.COMPLETED,
        owner: TASK_OWNERS.CANONICAL_SESSION,
        error: null,
      });

    // This event is emitted only after the assistant result has committed to
    // the canonical session snapshot; the managed job remains owner until then.
    case TASK_EVENTS.JOB_COMPLETED_COMMITTED:
      if (![TASK_PHASES.RUNNING, TASK_PHASES.RECOVERING].includes(state.phase)) return state;
      return transition(state, {
        phase: TASK_PHASES.COMPLETED,
        owner: TASK_OWNERS.CANONICAL_SESSION,
        error: null,
      });

    case TASK_EVENTS.JOB_FAILED:
    case TASK_EVENTS.TASK_FAILED:
      if (!isTaskActive(state) || state.phase === TASK_PHASES.STOPPING) return state;
      return transition(state, {
        phase: TASK_PHASES.FAILED,
        owner: TASK_OWNERS.NONE,
        error: event.error || null,
      });

    case TASK_EVENTS.TASK_STOP_REQUESTED:
      if (!isTaskActive(state) || state.phase === TASK_PHASES.STOPPING) return state;
      return transition(state, { phase: TASK_PHASES.STOPPING });

    case TASK_EVENTS.TASK_STOPPED:
      if (!isTaskActive(state)) return state;
      return transition(state, {
        phase: TASK_PHASES.STOPPED,
        owner: TASK_OWNERS.NONE,
        error: null,
      });

    default:
      return state;
  }
}

return Object.freeze({
  TASK_PHASES,
  TASK_EVENTS,
  TASK_OWNERS,
  createTaskState,
  isTaskActive,
  isTaskTerminal,
  deriveTaskControls,
  reduceTaskState,
});
});
