'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const displayItems = require('../../client/app/display-items');
const messageWorkflow = require('../../client/app/message-workflow');
const reasoningWorkflow = require('../../client/app/reasoning-workflow');

function withBrowserGlobals(dom, callback) {
  const previous = {
    ChatUIApp: global.ChatUIApp,
    ChatUIAppDisplayItems: global.ChatUIAppDisplayItems,
    window: global.window,
    document: global.document,
  };
  global.ChatUIAppDisplayItems = displayItems;
  global.window = dom.window;
  global.document = dom.window.document;
  global.ChatUIApp = {
    markdown: {
      createStreamingRenderer() {
        return {
          set(rawValue, contentNode) {
            contentNode.textContent = rawValue;
            return true;
          },
        };
      },
    },
    appContext: { getWorkflowModule: () => null },
  };
  dom.window.ChatUIApp = global.ChatUIApp;
  try {
    return callback();
  } finally {
    if (previous.ChatUIApp === undefined) delete global.ChatUIApp;
    else global.ChatUIApp = previous.ChatUIApp;
    if (previous.ChatUIAppDisplayItems === undefined) delete global.ChatUIAppDisplayItems;
    else global.ChatUIAppDisplayItems = previous.ChatUIAppDisplayItems;
    if (previous.window === undefined) delete global.window;
    else global.window = previous.window;
    if (previous.document === undefined) delete global.document;
    else global.document = previous.document;
    dom.window.close();
  }
}

function createWorkflowFixture(html) {
  const dom = new JSDOM(html);
  const { document } = dom.window;
  const messages = document.getElementById('messages');
  const output = document.getElementById('live-output');
  const state = {
    activeSessionId: 'session-a',
    activeOutputNode: output,
    activeOutputSessions: new Map([['session-a', output]]),
    userScrollLocked: false,
    streamFocusLocked: false,
  };
  const sequence = [];
  const workflow = messageWorkflow.createMessageWorkflow({
    state,
    document,
    window: dom.window,
    $: id => id === 'messages' ? messages : null,
    shouldSuppressRunUi: () => false,
    setActiveOutputForSession: (sessionId, node) => {
      sequence.push('activate');
      state.activeOutputNode = node;
      state.activeOutputSessions.set(sessionId, node);
    },
    armStreamingOutputFocus: (_sessionId, node, options) => {
      sequence.push({ type: 'arm', skipPin: options.skipPin });
      state.streamFocusLocked = true;
      state.activeOutputNode = node;
    },
    commitStreamingOutput: () => sequence.push('commit'),
    pinActiveOutputToAnchor: () => sequence.push('final-pin'),
    scrollToActiveOutput: () => sequence.push('queued-scroll'),
    shouldFollowScroll: () => true,
    updateResumeStreamButton: () => {},
    renderMarkdown: value => String(value || ''),
    bindInlineCopyButtons: () => {},
    enhanceRenderedMarkdown: () => {},
    hydrateMessageMedia: () => {},
    resetMessageActionStates: () => {},
    cleanupGeneratedImageNumberArtifacts: () => {},
    syncWebPreviews: () => {},
  });
  return { dom, document, messages, output, state, sequence, workflow };
}

function testStreamingRenderAndOutputPinCommitInOneTask() {
  const fixture = createWorkflowFixture(`
    <section id="messages">
      <article id="live-output" class="message assistant" data-session-id="session-a" data-streaming="1" data-response-index="1">
        <div class="content"></div>
      </article>
    </section>
  `);

  withBrowserGlobals(fixture.dom, () => {
    fixture.workflow.updateMessageContentLight(fixture.output, 'streamed content', {
      streamKind: 'chat',
      sessionId: 'session-a',
      chunk: true,
      tailLock: false,
    });

    assert.deepStrictEqual(fixture.sequence, [
      { type: 'arm', skipPin: true },
      'commit',
    ],
      'stream output must acquire focus, render, and commit the new message end synchronously; it must not queue a second scroll writer');
  });
}

async function testStreamingTokenOnlyMutatesTheLiveMessage() {
  const fixture = createWorkflowFixture(`
    <section id="messages">
      <article class="message user" data-message-index="0"><div class="content">question</div></article>
      <article id="live-output" class="message assistant" data-session-id="session-a" data-streaming="1" data-response-index="1"><div class="content"></div></article>
      <article id="later-message" class="message user" data-message-index="2"><div class="content">later history</div></article>
    </section>
  `);

  await withBrowserGlobals(fixture.dom, async () => {
    const later = fixture.document.getElementById('later-message');
    const laterContent = later.querySelector('.content');
    const records = [];
    const observer = new fixture.dom.window.MutationObserver(entries => records.push(...entries));
    observer.observe(fixture.messages, { childList: true, subtree: true, attributes: true });

    fixture.workflow.updateMessageContentLight(fixture.output, 'first', {
      streamKind: 'chat', sessionId: 'session-a', rawText: 'first', chunk: true, tailLock: false,
    });
    fixture.workflow.updateMessageContentLight(fixture.output, ' second', {
      streamKind: 'chat', sessionId: 'session-a', rawText: 'first second', chunk: true, tailLock: false,
    });
    await Promise.resolve();
    observer.disconnect();

    assert.strictEqual(fixture.messages.querySelector('#later-message'), later,
      'the message after a streaming response must retain its DOM identity');
    assert.strictEqual(later.querySelector('.content'), laterContent,
      'a streaming token must never rebuild the following message content');
    assert.strictEqual(laterContent.textContent, 'later history');
    assert.strictEqual(records.some(record => record.type === 'childList' && record.target === fixture.messages), false,
      'once a live response is placed, later tokens must not remove/reinsert it in #messages');
    assert.strictEqual(records.every(record => fixture.output === record.target || fixture.output.contains(record.target)), true,
      'all DOM mutations from a stream token must be contained inside the live message');
  });
}

function testReasoningStreamingUsesTheSameLiveOutputCommitPath() {
  const fixture = createWorkflowFixture(`
    <section id="messages">
      <article id="live-output" class="message assistant" data-session-id="session-a" data-streaming="1">
        <div class="bubble"><div class="content"></div></div>
      </article>
    </section>
  `);

  withBrowserGlobals(fixture.dom, () => {
    fixture.state.reasoningMode = true;
    const commits = [];
    const reasoning = reasoningWorkflow.createReasoningWorkflow({
      state: fixture.state,
      $: id => id === 'messages' ? fixture.messages : null,
      document: fixture.document,
      renderMarkdown: value => String(value || ''),
      bindInlineCopyButtons: () => {},
      commitStreamingOutput: (node, options) => commits.push({ node, options }),
      scrollToActiveOutput: () => { throw new Error('reasoning stream must not use the legacy scroll writer'); },
      forceRemoveReasoning: () => {},
    });

    reasoning.updateReasoning(fixture.output, 'draft reasoning', { followActive: false });

    assert.strictEqual(commits.length, 1,
      'reasoning growth must commit through the same live-message-end anchor as answer tokens');
    assert.strictEqual(commits[0].node, fixture.output);
    assert.strictEqual(commits[0].options.sessionId, 'session-a');
  });
}

function testAllChatStreamingEntryPointsConvergeOnOneCommitPath() {
  const fs = require('fs');
  const path = require('path');
  const read = name => fs.readFileSync(path.join(__dirname, '../..', name), 'utf8');
  const chat = read('client/app/chat-workflow.js');
  const regenerate = read('client/app/regenerate-workflow.js');
  const submit = read('client/app/submit-workflow.js');
  const app = read('app.js');

  assert.match(chat, /updateMessageContentLight\(g,z,\{[\s\S]{0,500}streamKind:"chat"[\s\S]{0,500}tailLock:streamTailLock/,
    'the chat sender must route every text token through the shared live-message renderer');
    assert.ok(regenerate.includes('submitWorkflow.onSubmit({preventDefault(){}},{promptOverride:s})'),
    'regeneration must delegate to the same sendChat stream owned by submit');  assert.match(submit, /await sendChat\(chatPrompt,[\s\S]{0,700}replaceAssistantIndex:replacementResponseIndex/,
    'edit/resend must enter the same sendChat stream rather than write a separate token renderer');
  assert.strictEqual(app.includes('setTimeout(()=>{armStreamingOutputFocus'), false,
    'preparation paths must not schedule a second stream-focus lifecycle after sendChat owns the stream');
}

module.exports = [
  testStreamingRenderAndOutputPinCommitInOneTask,
  testStreamingTokenOnlyMutatesTheLiveMessage,
  testReasoningStreamingUsesTheSameLiveOutputCommitPath,
  testAllChatStreamingEntryPointsConvergeOnOneCommitPath,
];
