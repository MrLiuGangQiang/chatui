'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function testBackgroundSessionsResumeAndShowBusyStateAfterRestore() {
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(__dirname, '../../client/app/bootstrap-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');

  assert.ok(app.includes('function resumeBackgroundSessionJobs()'), 'app should coordinate resume work for non-active sessions after a restore');
  assert.ok(app.includes('a=getSubmitWorkflow().loadPendingSubmit?.(e.id),i=loadImageBatch(e.id);if(!s?.id&&!n?.id&&!a&&!i)return;setSessionBusy(e.id,!0),e.id!==t&&resumeSessionJobs(e.id),e.id===t&&resumeSessionJobs(e.id)'),
    'startup recovery must treat a durable multi-image batch as first-class work and resume the active session too');
  assert.ok(app.includes('resumeBackgroundSessionJobs();if(!e)return;'), 'returning to the page should also retry background-session recovery');
  assert.ok(app.includes('resumeBackgroundSessionJobs:resumeBackgroundSessionJobs'), 'bootstrap must receive the background-session recovery dependency');
  assert.ok(bootstrap.includes('await loadSessions(),resumeBackgroundSessionJobs(),loadReasoningPreference()'), 'startup should restore all background jobs immediately after sessions load');
  const jobResume = fs.readFileSync(path.join(__dirname, '../../client/app/job-resume-workflow.js'), 'utf8');
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const batchWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/image-batch-workflow.js'), 'utf8');
  const regenerate = fs.readFileSync(path.join(__dirname, '../../client/app/regenerate-workflow.js'), 'utf8');
  assert.ok(app.includes('resumePendingSubmit:e=>getSubmitWorkflow().resumePendingSubmit?.(e),loadPendingSubmit:e=>getSubmitWorkflow().loadPendingSubmit?.(e)'),
    'the app must wire batch resume back to pending-submit recovery for the pre-snapshot refresh window');
  assert.ok(jobResume.includes('missingDurableChild') && jobResume.includes('return await resumePendingSubmit(e)'),
    'an incomplete child durable set must delegate to pending-submit recovery instead of querying an unowned child');
  assert.ok(batchWorkflow.includes('storageCore.safeSetJsonStorage?.(root.localStorage, key, child.durableJob)')
    && batchWorkflow.includes('onDurableHandoff?.(batchJobId'),
    'batch ownership must be released only after every child snapshot is durable and the single server batch has been accepted');
  assert.ok(regenerate.includes('onInterfaceCompleted:completion=>task.interfaceCompleted(completion)'),
    'regenerated batches must complete through the single parent batch identity');
  assert.ok(index.includes('bootstrap-workflow.js?v=2.1.2-ime-platform-guard')
    && index.includes('job-resume-workflow.js?v=1.3.3-terminal-batch-cleanup')
    && index.includes('image-batch-workflow.js?v=1.0.2-serialized-terminal-updates')
    && index.includes('image-task-preparation.js?v=1.0.0-shared-image-prep')
    && index.includes('app.js?v=2.3.10-image-batch-terminal-cleanup'),
  'runtime entry assets should receive cache-version updates with the recovery fix');
}

module.exports = [testBackgroundSessionsResumeAndShowBusyStateAfterRestore];
