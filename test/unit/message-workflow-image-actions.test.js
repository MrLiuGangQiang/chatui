'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const messageWorkflow = require('../../client/app/message-workflow');
const imageActionsWorkflow = require('../../client/app/image-actions-workflow');

function createFixture() {
  const dom = new JSDOM(`
    <main id="messages"></main>
    <template id="messageTemplate">
      <article class="message">
        <div class="avatar"></div>
        <div class="bubble-wrap">
          <div class="bubble"><div class="content markdown-body"></div></div>
          <div class="msg-actions">
            <button class="mobile-more-btn icon-action-btn"></button>
            <button class="quote-btn icon-action-btn"></button>
            <button class="edit-btn icon-action-btn"></button>
            <button class="force-image-btn icon-action-btn"></button>
            <button class="refresh-btn icon-action-btn" title="重新生成"></button>
            <button class="copy-btn icon-action-btn"></button>
            <button class="download-answer-btn icon-action-btn"></button>
          </div>
        </div>
      </article>
    </template>
  `);
  const document = dom.window.document;
  const noop = () => {};
  let imageActionInvocations = 0;

  const deps = {
    state: { userScrollLocked: true, activeSessionId: 'session-image-actions' },
    document,
    $: id => document.getElementById(id),
    clearEmpty: noop,
    chatuiContentHash: value => `hash:${String(value)}`,
    quoteContextJson: () => '',
    chatuiShouldLazyRender: () => false,
    shouldProgressiveRenderMarkdown: () => false,
    chatuiQueueLazyMessage: noop,
    chatuiRenderLazyMessage: noop,
    chatuiPlainPreview: value => String(value || ''),
    renderUserMessageContent: value => String(value || ''),
    renderMarkdown: value => String(value || ''),
    renderMarkdownProgressively: () => false,
    stripTransientBlobUrlsFromHtml: value => String(value || ''),
    withSentQuotePreview: value => String(value || ''),
    cleanupGeneratedImageNumberArtifacts: noop,
    bindSentQuotePreviews: noop,
    bindMobileMoreActions: noop,
    selectQuotedMessage: noop,
    editUserMessage: noop,
    forceImageFromUserMessage: noop,
    regenerateAssistantMessage: noop,
    copyText: async () => {},
    messageCopyText: value => String(value || ''),
    showCopySuccess: noop,
    downloadAnswerFile: noop,
    bindInlineCopyButtons: noop,
    hydrateMessageMedia: noop,
    moveImageActionsToMessageActions: () => { imageActionInvocations += 1; },
    enhanceRenderedMarkdown: noop,
    syncWebPreviews: noop,
    chatuiRefreshVirtualizer: noop,
    setMessageMetaText: noop,
    revealNodeAboveComposer: noop,
    scrollToBottom: noop,
    saveDisplayHistory: noop,
    shouldFollowScroll: () => false,
    resetMessageActionStates: noop,
    updateResumeStreamButton: noop,
    chatuiPerfNow: () => 0,
    chatuiLogLongTask: noop,
    setActiveOutputForSession: noop,
    armStreamingOutputFocus: noop,
    pinActiveOutputToAnchor: noop,
    commitStreamingOutput: noop,
    preserveMessageViewport: noop,
    preserveMessageBottomAnchor: noop,
    scrollToActiveOutput: noop,
    cancelScrollTimer: noop,
    updateReasoning: noop,
    clearReasoning: noop,
    getActiveOutputForSession: () => null,
    getAssistantImageContext: () => '',
  };

  const workflow = messageWorkflow.createMessageWorkflow(deps);
  return { dom, document, workflow, imageActionInvocations: () => imageActionInvocations };
}

function testLiveImageCompletionHydratesImageActionsSynchronously() {
  const fixture = createFixture();
  try {
    const node = fixture.workflow.addMessage('assistant', '<p>正在生成图片</p>', {
      html: true,
      rawText: '正在生成图片',
      skipSave: true,
    });

    const imageHtml = '<div class="generated-image-grid"><img class="generated-thumb" data-persisted-src="indexeddb://image-1" src="blob:live"></div><div class="image-download-row"><button data-download-all-images="1">下载全部</button></div>';
    const before = fixture.imageActionInvocations();
    fixture.workflow.updateMessage(node, imageHtml, {
      html: true,
      preserveLiveMedia: true,
      rawText: '图片生成完成\n耗时：1s',
      metaText: 'RT 1s',
    });

    assert.ok(
      fixture.imageActionInvocations() > before,
      'live image completion must synchronously move generated-image actions into the message action bar',
    );
  } finally {
    fixture.dom.window.close();
  }
}

function testCompletedImageActionsReuseMessageCompletionLifecycle() {
  const fixture = createFixture();
  try {
    const node = fixture.workflow.addMessage('assistant', '<p>正在生成图片</p>', {
      html: true, rawText: '正在生成图片', responseIndex: 1, skipSave: true,
    });
    node.querySelector('.content').innerHTML = '<div class="generated-image-grid"><img class="generated-thumb" data-persisted-src="indexeddb://image-1" data-filename="image-1.png" src="blob:live" /></div>';
    const actions = node.querySelector('.msg-actions');
    actions.querySelectorAll('.quote-btn,.copy-btn,.download-answer-btn,[data-image-action-clone]').forEach(button => button.remove());
    assert.strictEqual(node.dataset.persist, '0', 'the live placeholder starts in the transient lifecycle');

    const actionsWorkflow = imageActionsWorkflow.createImageActionsWorkflow({
      document: fixture.document,
      window: fixture.dom.window,
      navigator: fixture.dom.window.navigator,
      File: fixture.dom.window.File,
      Image: fixture.dom.window.Image,
      URL: fixture.dom.window.URL,
      fetch: async () => { throw new Error('unexpected fetch'); },
      getImageBlob: async () => null,
      toast: () => {},
      resetActionButtonState: () => {},
      markActionButtonBusy: () => {},
      restoreActionButtonSoon: () => {},
      openImagePreview: () => {},
      escapeAttr: value => String(value),
      getImageEditor: () => ({ open: async () => null }),
      applyImageEdit: async () => {},
      reconcileMessageActions: completedNode => fixture.workflow.reconcileMessageActions(completedNode, { state: 'ready' }),
    });

    actionsWorkflow.moveImageActionsToMessageActions(node, { complete: true });

    assert.strictEqual(node.dataset.persist, undefined,
      'multi-image completion must leave the transient placeholder lifecycle');
    assert.strictEqual(node.dataset.actionsState, 'ready',
      'multi-image completion must enter the shared terminal action state');
    assert.ok(actions.querySelector('.quote-btn'), 'quote must be restored through the shared message action binding');
    assert.ok(actions.querySelector('[data-download-all-images]'), 'download-all must be added for the completed multi-image result');
    assert.ok(actions.querySelector('.refresh-btn'), 'regenerate must stay in the same completed action row');

    actionsWorkflow.moveImageActionsToMessageActions(node, { complete: true });
    assert.strictEqual(actions.querySelectorAll('.quote-btn').length, 1, 'completion action reconciliation must stay idempotent');
    assert.strictEqual(actions.querySelectorAll('[data-download-all-images]').length, 1, 'download-all must not duplicate on repeated completion');
  } finally {
    fixture.dom.window.close();
  }
}
function testCompletedImageActionsDropTheLegacyInlineDownloadRow() {
  const fixture = createFixture();
  try {
    const node = fixture.workflow.addMessage('assistant', '<p>正在生成图片</p>', {
      html: true, rawText: '正在生成图片', responseIndex: 1, skipSave: true,
    });
    node.querySelector('.content').innerHTML = '<div class="generated-image-grid"><div class="generated-image-item"><img class="generated-thumb" data-persisted-src="indexeddb://image-1" data-filename="image-1.png" src="blob:live" /></div></div><div class="image-download-row"><button class="image-icon-btn" data-download-all-images="1" title="下载全部图片"></button></div>';

    const actionsWorkflow = imageActionsWorkflow.createImageActionsWorkflow({
      document: fixture.document,
      window: fixture.dom.window,
      navigator: fixture.dom.window.navigator,
      File: fixture.dom.window.File,
      Image: fixture.dom.window.Image,
      URL: fixture.dom.window.URL,
      fetch: async () => { throw new Error('unexpected fetch'); },
      getImageBlob: async () => null,
      toast: () => {},
      resetActionButtonState: () => {},
      markActionButtonBusy: () => {},
      restoreActionButtonSoon: () => {},
      openImagePreview: () => {},
      escapeAttr: value => String(value),
      getImageEditor: () => ({ open: async () => null }),
      applyImageEdit: async () => {},
      reconcileMessageActions: completedNode => fixture.workflow.reconcileMessageActions(completedNode, { state: 'ready' }),
    });

    actionsWorkflow.moveImageActionsToMessageActions(node, { complete: true });

    assert.strictEqual(node.querySelectorAll('.content .image-download-row').length, 0,
      'the legacy in-bubble download row must be removed once the action moves into the message bar');
    assert.strictEqual(node.querySelectorAll('[data-download-all-images]').length, 1,
      'an image message must expose exactly one download-all entry');
    assert.ok(node.querySelector('.msg-actions [data-download-all-images]'),
      'the remaining download entry must live in the message action bar');
  } finally {
    fixture.dom.window.close();
  }
}

function testEnsureMessageActionsRestoresDroppedImageMessageActions() {
  const fixture = createFixture();
  try {
    const node = fixture.workflow.addMessage('assistant', '<p>图片生成完成</p>', {
      html: true, rawText: '图片生成完成', skipSave: true,
    });
    node.querySelector('.content').innerHTML = '<div class="generated-image-grid"><img class="generated-thumb" data-persisted-src="indexeddb://image-1" src="blob:live" /></div>';
    const actions = node.querySelector('.msg-actions');
    actions.querySelectorAll('.quote-btn,.copy-btn,.download-answer-btn').forEach(button => button.remove());
    assert.strictEqual(actions.querySelector('.quote-btn'), null);

    assert.strictEqual(fixture.workflow.ensureMessageActions(node), true);
    assert.ok(actions.querySelector('.quote-btn'), 'quote action must be restored from the shared template');
    assert.ok(actions.querySelector('.copy-btn'), 'copy action must be restored through the shared binding');
    assert.strictEqual(actions.querySelector('.download-answer-btn'), null,
      'a generated-image message must not restore the text-answer download action');
    assert.ok(actions.querySelector('.refresh-btn'), 'refresh action must stay');
    assert.deepStrictEqual(
      [...actions.querySelectorAll('.quote-btn,.copy-btn,.refresh-btn')].map(button => button.dataset.messageActionBound),
      ['1', '1', '1'],
      'restored buttons must be bound through the shared message-action path',
    );
    fixture.workflow.ensureMessageActions(node);
    assert.strictEqual(actions.querySelectorAll('.quote-btn').length, 1, 'ensureMessageActions must stay idempotent');
  } finally {
    fixture.dom.window.close();
  }
}

function testMessageActionLifecycleCoversUserPendingTerminalErrorAndClarification() {
  const fixture = createFixture();
  try {
    const user = fixture.workflow.addMessage('user', 'hello', { rawText: 'hello', skipSave: true });
    assert.strictEqual(user.dataset.actionsState, 'ready', 'a sent user message must expose actions immediately');
    assert.strictEqual(user.dataset.persist, undefined, 'user visibility must not depend on the transient persist guard');
    assert.deepStrictEqual([...user.querySelectorAll('.quote-btn,.edit-btn,.force-image-btn,.copy-btn')].map(button => button.className.split(' ')[0]), ['quote-btn', 'edit-btn', 'force-image-btn', 'copy-btn'], 'a sent user message must expose every applicable action');

    const pending = fixture.workflow.addMessage('assistant', '正在生成', { html: true, rawText: '正在生成', skipSave: true });
    assert.strictEqual(pending.dataset.actionsState, 'pending', 'an unfinished assistant message must hide its actions');
    assert.strictEqual(pending.querySelector('.msg-actions').getAttribute('aria-hidden'), 'true');

    fixture.workflow.reconcileMessageActions(pending, { state: 'ready' });
    assert.strictEqual(pending.dataset.actionsState, 'ready', 'successful completion must expose all applicable actions');
    assert.strictEqual(pending.dataset.persist, undefined, 'terminal completion must clear the transient persist guard');
    assert.strictEqual(pending.querySelector('.msg-actions').hasAttribute('aria-hidden'), false);

    const failed = fixture.workflow.addMessage('error', '失败', { html: true, rawText: '失败', skipSave: true });
    assert.strictEqual(failed.dataset.actionsState, 'ready', 'an error response is terminal and must expose its actions');
    assert.deepStrictEqual([...failed.querySelectorAll('.quote-btn,.refresh-btn,.copy-btn,.download-answer-btn')].map(button => button.className.split(' ')[0]), ['quote-btn', 'refresh-btn', 'copy-btn', 'download-answer-btn'], 'an error response must expose every applicable action');

    const clarification = fixture.workflow.addMessage('assistant', '请补充信息', { html: true, rawText: '请补充信息' });
    clarification.dataset.clarificationId = 'clarification-1';
    fixture.workflow.reconcileMessageActions(clarification, { state: 'pending' });
    assert.strictEqual(clarification.dataset.actionsState, 'ready', 'clarification is a successful terminal response and must expose actions');
    assert.deepStrictEqual([...clarification.querySelectorAll('.quote-btn,.refresh-btn,.copy-btn,.download-answer-btn')].map(button => button.className.split(' ')[0]), ['quote-btn', 'refresh-btn', 'copy-btn', 'download-answer-btn'], 'a clarification must expose every applicable action');
  } finally {
    fixture.dom.window.close();
  }
}
module.exports = [
  testLiveImageCompletionHydratesImageActionsSynchronously,
  testEnsureMessageActionsRestoresDroppedImageMessageActions,
  testCompletedImageActionsReuseMessageCompletionLifecycle,
  testCompletedImageActionsDropTheLegacyInlineDownloadRow,
  testMessageActionLifecycleCoversUserPendingTerminalErrorAndClarification,
];
