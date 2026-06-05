const assert = require('assert');
const workflow = require('../../client/app/submit-workflow');

(async function run() {
  let prevented = false;
  const state = { activeSessionId: 's1', suppressNextSubmitStop: false, attachments: [], mode: 'chat' };
  const submit = workflow.createSubmitWorkflow({
    state,
    isSessionBusy: () => false,
    hasPendingUploads: () => false,
    $: id => id === 'prompt' ? { value: '', focus() {} } : null,
  });
  assert.strictEqual(typeof submit.onSubmit, 'function');
  await submit.onSubmit({ preventDefault: () => { prevented = true; } });
  assert.strictEqual(prevented, true);
  console.log('app submit workflow ok');
})();
