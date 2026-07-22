'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function testBackgroundSessionsResumeAndShowBusyStateAfterRestore() {
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(__dirname, '../../client/app/bootstrap-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');

  assert.ok(app.includes('function resumeBackgroundSessionJobs()'), 'app should coordinate resume work for non-active sessions after a restore');
  assert.ok(app.includes('if(!s?.id&&!n?.id&&!a)return;setSessionBusy(e.id,!0),e.id!==t&&resumeSessionJobs(e.id)'), 'all recoverable sessions must be marked busy before first render while only background sessions reconnect immediately');
  assert.ok(app.includes('resumeBackgroundSessionJobs();if(!e)return;'), 'returning to the page should also retry background-session recovery');
  assert.ok(app.includes('resumeBackgroundSessionJobs:resumeBackgroundSessionJobs'), 'bootstrap must receive the background-session recovery dependency');
  assert.ok(bootstrap.includes('await loadSessions(),resumeBackgroundSessionJobs(),loadReasoningPreference()'), 'startup should restore all background jobs immediately after sessions load');
  assert.ok(index.includes('bootstrap-workflow.js?v=2.1.2-ime-platform-guard') && index.includes('app.js?v=2.1.49-strict-model-only-continuation'), 'runtime entry assets should receive cache-version updates with the recovery fix');
}

module.exports = [testBackgroundSessionsResumeAndShowBusyStateAfterRestore];
