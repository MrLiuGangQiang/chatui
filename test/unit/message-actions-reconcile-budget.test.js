'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const messageWorkflow = require('../../client/app/message-workflow');

function createWorkflowFixture() {
  const dom = new JSDOM(`
    <main id="messages"></main>
    <template id="messageTemplate">
      <article class="message assistant">
        <div class="avatar"></div>
        <div class="content"></div>
        <div class="msg-actions"><button class="copy-btn"></button><button class="refresh-btn"></button></div>
      </article>
    </template>
  `);
  const document = dom.window.document;
  const node = document.getElementById('messageTemplate').content.firstElementChild.cloneNode(true);
  document.getElementById('messages').appendChild(node);
  const workflow = messageWorkflow.createMessageWorkflow({
    state: { activeSessionId: 'session-a', userScrollLocked: true, activeOutputNode: null },
    document,
    $: id => document.getElementById(id),
    resetMessageActionStates: () => {},
    bindInlineCopyButtons: () => {},
    renderMarkdown: value => String(value || ''),
    cleanupGeneratedImageNumberArtifacts: () => {},
    syncWebPreviews: () => {},
    updateResumeStreamButton: () => {},
  });
  return { dom, node, workflow };
}

function testUnchangedActionStateDoesNotRebindControlsForEveryStreamToken() {
  const fixture = createWorkflowFixture();
  fixture.workflow.reconcileMessageActions(fixture.node, { state: 'pending' });
  assert.strictEqual(fixture.node.dataset.actionsState, 'pending');

  const originalQuerySelector = fixture.node.querySelector.bind(fixture.node);
  let queries = 0;
  fixture.node.querySelector = (...args) => { queries += 1; return originalQuerySelector(...args); };
  const result = fixture.workflow.reconcileMessageActions(fixture.node, { state: 'pending' });

  assert.strictEqual(result, true);
  assert.strictEqual(queries, 0,
    'unchanged pending actions must not rebuild or rebind controls on every token');
  fixture.dom.window.close();
}

module.exports = [testUnchangedActionStateDoesNotRebindControlsForEveryStreamToken];
