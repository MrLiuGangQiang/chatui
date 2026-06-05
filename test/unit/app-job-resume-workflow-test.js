const assert = require('assert');
const workflow = require('../../client/app/job-resume-workflow');

(async function run() {
  const state = { activeSessionId: 's1', resumingJobs: new Set(), sessions: [], followingImageJobs: new Set(), followingChatJobs: new Set() };
  const resume = workflow.createJobResumeWorkflow({
    state,
    loadImageJob: () => null,
    loadLatestChatJob: () => null,
  });
  assert.strictEqual(typeof resume.resumeImageJob, 'function');
  assert.strictEqual(typeof resume.resumeChatJob, 'function');
  await resume.resumeImageJob('s1');
  await resume.resumeChatJob('s1');
  assert.strictEqual(state.resumingJobs.size, 0);
  console.log('app job resume workflow ok');
})();
