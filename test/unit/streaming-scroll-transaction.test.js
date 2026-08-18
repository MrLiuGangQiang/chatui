'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const messageWorkflow = require('../../client/app/message-workflow');

function testStreamingRenderAndOutputPinCommitInOneTask() {
  const dom = new JSDOM(`
    <section id="messages">
      <article class="message assistant" data-session-id="session-a" data-streaming="1">
        <div class="content"></div>
      </article>
    </section>
  `);
  const document = dom.window.document;
  const output = document.querySelector('.message');
  const sequence = [];
  const state = {
    activeSessionId: "session-a",
    activeOutputNode: output,
    activeOutputSessions: new Map(),
    userScrollLocked: false,
    streamFocusLocked: false,
  };
  const previousChatUIApp = global.ChatUIApp;
  global.ChatUIApp = {
    markdown: {
      createStreamingRenderer() {
        return {
          set(rawValue, contentNode) {
            sequence.push('render');
            contentNode.textContent = rawValue;
            return true;
          },
        };
      },
    },
    appContext: { getWorkflowModule: () => null },
  };
  dom.window.ChatUIApp = global.ChatUIApp;

  const workflow = messageWorkflow.createMessageWorkflow({
    state,
    document,
    window: dom.window,
    $: id => id === "messages" ? document.getElementById(id) : null,
    shouldSuppressRunUi: () => false,
    setActiveOutputForSession: (sessionId, node) => {
      sequence.push('activate');
      state.activeOutputNode = node;
      state.activeOutputSessions.set(sessionId, node);
    },
    armStreamingOutputFocus: (sessionId, node, options) => {
      sequence.push({ type: 'arm', skipPin: options.skipPin });
      state.streamFocusLocked = true;
      state.activeOutputNode = node;
    },
    pinActiveOutputToAnchor: () => sequence.push('pin'),
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

  try {
    workflow.updateMessageContentLight(output, "streamed content", {
      streamKind: "chat",
      sessionId: "session-a",
      chunk: true,
      tailLock: false,
    });

    assert.deepStrictEqual(sequence, [
      { type: 'arm', skipPin: true },
      'render',
      'pin',
    ],
      "stream output must acquire focus, render, and pin the new message end synchronously; it must not queue a second scroll writer");
  } finally {
    if (previousChatUIApp === undefined) delete global.ChatUIApp;
    else global.ChatUIApp = previousChatUIApp;
    dom.window.close();
  }
}

module.exports = [testStreamingRenderAndOutputPinCommitInOneTask];
