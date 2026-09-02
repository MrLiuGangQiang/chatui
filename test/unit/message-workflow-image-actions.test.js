'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const messageWorkflow = require('../../client/app/message-workflow');

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

module.exports = [
  testLiveImageCompletionHydratesImageActionsSynchronously,
];
