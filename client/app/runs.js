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

module.exports = { makeRun, getActiveRun, ensureActiveRun, addActiveRunJob, isRunStopped, bindFollowingRun };
