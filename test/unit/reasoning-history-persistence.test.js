const assert = require('assert');
const fs = require('fs');
const path = require('path');
const chatWorkflow = require('../../client/app/chat-workflow');
const { makeDispatchContract } = require('../helpers/dispatch-contract-fixture');

function createPersistentReasoningWorkflow(options = {}) {
  const session = options.session || {
    id: 'reasoning-persistent',
    title: 'Session',
    messages: [],
    display: [],
    reasoningMode: true,
    reasoningType: 'high',
  };
  const state = {
    sessions: [session],
    activeSessionId: session.id,
    messages: session.messages,
    reasoningMode: true,
    reasoningType: 'high',
    pageUnloading: false,
    disposedSessionIds: new Set(),
  };
  const run = { token: 'run-transient', stopped: false, abortController: new AbortController() };
  const liveItem = { id: 'display-transient', role: 'assistant', pending: '1', responseIndex: '1' };
  const displayUpdates = [];
  const reasoningCalls = [];
  const streamChunks = [];

  const workflow = chatWorkflow.createChatWorkflow({
    state,
    loadPublicContext: async () => {},
    getConfig: () => ({ baseUrl: 'https://api.example.test/v1', apiKey: 'secret' }),
    getSessionChatModel: () => 'gpt-5-mini',
    ensureActiveRun: () => run,
    getActiveSession: () => session,
    ensureChatAttachmentImageDataUrls: async items => items,
    buildChatMessagesWithAttachments: (prompt, attachments, base, systemPrompt) => [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      ...base,
      { role: 'user', content: prompt },
    ],
    saveChatHistory: async () => {},
    saveSessionMessages: async (sessionId, messages) => { session.messages = messages; },
    addMessage: () => ({ isConnected: true, dataset: {} }),
    pendingFeedbackHtml: text => text,
    appendSessionDisplayMessage: () => liveItem,
    persistSessionDisplay: () => Promise.resolve(),
    armStreamingOutputFocus: () => {},
    buildChatPayload: (model, messages, buildOptions) => ({ model, messages, ...buildOptions }),
    shouldUseResponsesReasoning: () => false,
    makeClientChatJobId: () => '',
    addActiveRunJob: () => {},
    createRealtimeRenderer: callback => ({ set: callback, final: callback }),
    shouldSuppressRunUi: () => false,
    updateLiveDisplay: (sessionId, item, role, content, updateOptions = {}) => {
      displayUpdates.push({ ...updateOptions });
      if (updateOptions.pending !== undefined) item.pending = updateOptions.pending ? '1' : '';
      if (updateOptions.reasoning !== undefined) {
        item.reasoningText = updateOptions.reasoning || '';
        item.keepReasoning = !!updateOptions.keepReasoning && !!item.reasoningText;
      }
    },
    shouldFollowScroll: () => false,
    streamManagedChatCompletions: async (payload, config, jobId, onChunk, streamOptions) => {
      streamChunks.push({ payload, config, jobId, streamOptions });
      onChunk({ reasoning: 'thinking **bold**', content: 'final answer', firstTokenMs: 8 });
      return { reasoning: 'thinking **bold**', content: 'final answer', firstTokenMs: 8, durationMs: 20 };
    },
    normalizeReasoningText: value => String(value || ''),
    normalizeContentText: value => String(value || ''),
    compactAdjacentDuplicateMessages: items => items,
    cloneMessageList: items => items.map(item => ({ ...item })),
    clearPendingFeedback: () => {},
    clearReasoning: () => {},
    updateReasoning: (node, content, updateOptions = {}) => reasoningCalls.push({ content, ...updateOptions }),
    showReasoningUnavailable: () => reasoningCalls.push({ unavailable: true }),
    setPendingFeedback: () => {},
    updateMessageContentLight: () => {},
    updateMessage: () => {},
    settleActiveOutput: () => {},
    finishReasoning: (node, content, finishOptions = {}) => reasoningCalls.push({ content, ...finishOptions, finished: true }),
    firstTokenTimeText: () => '',
    setMessageMetaText: () => {},
    playDoneSound: () => {},
    clearChatJob: () => {},
    isRunStopped: () => false,
    isAbortLikeError: () => false,
    formatElapsed: value => String(value),
    ...options.overrides,
  });

  return { workflow, session, state, liveItem, displayUpdates, reasoningCalls, streamChunks };
}

async function testCompletedReasoningPersistsInCanonicalHistory() {
  const { workflow, session, displayUpdates, reasoningCalls } = createPersistentReasoningWorkflow();

  await workflow.sendChat('Question', [], null, {
    sessionId: session.id,
    requestPurpose: 'final_execution',
    dispatchContract: makeDispatchContract({ operation: 'plain_chat', prompt: 'Question' }),
    bindingEvidence: [],
  });
  await Promise.resolve();

  assert.strictEqual(session.messages.at(-1).content, 'final answer');
  assert.strictEqual(
    session.messages.at(-1).reasoning_content,
    'thinking **bold**',
    'completed reasoning must be written beside the canonical assistant response'
  );
  assert.strictEqual(
    Object.hasOwn(session.messages.at(-1), 'reasoning_content'),
    true,
    'the canonical assistant message must carry its persisted thought trace'
  );

  const completionUpdate = displayUpdates.find(update => update.pending === false);
  assert.ok(completionUpdate, 'the completed answer must still finalize its pending display item');
  assert.strictEqual(completionUpdate.reasoning, 'thinking **bold**', 'the completed display projection must retain reasoning until canonical persistence completes');
  assert.strictEqual(completionUpdate.keepReasoning, true, 'the completed display projection must mark its reasoning as recoverable');

  assert.ok(reasoningCalls.some(call => call.content === 'thinking **bold**' && call.done === false), 'reasoning must be streamed to the live DeepSeek-style panel before the answer starts');
  assert.ok(reasoningCalls.some(call => call.content === 'thinking **bold**' && call.done === true), 'the completed panel must be finalized instead of removed');
}

async function testStreamingReasoningCheckpointsForRefreshRecovery() {
  const { workflow, session, liveItem, reasoningCalls } = createPersistentReasoningWorkflow();

  await workflow.sendChat('Question', [], null, {
    sessionId: session.id,
    requestPurpose: 'final_execution',
    dispatchContract: makeDispatchContract({ operation: 'plain_chat', prompt: 'Question' }),
    bindingEvidence: [],
  });
  await Promise.resolve();

  assert.strictEqual(liveItem.reasoningText, 'thinking **bold**', 'streaming reasoning must be checkpointed for refresh recovery');
  assert.strictEqual(liveItem.keepReasoning, true, 'streaming reasoning must mark the pending display item as recoverable');
  assert.ok(reasoningCalls.some(call => call.content === 'thinking **bold**'), 'reasoning content must still be pushed to the live renderer');
}

function testReasoningRendererPersistsAndRestoresMarkdown() {
  const reasoningSource = fs.readFileSync(path.join(__dirname, '../../client/app/reasoning-workflow.js'), 'utf8');
  const chatSource = fs.readFileSync(path.join(__dirname, '../../client/app/chat-workflow.js'), 'utf8');
  const resumeSource = fs.readFileSync(path.join(__dirname, '../../client/app/job-resume-workflow.js'), 'utf8');
  const historySource = fs.readFileSync(path.join(__dirname, '../../client/app/display-history-workflow.js'), 'utf8');

  assert.ok(reasoningSource.includes('createStreamingRenderer'), 'reasoning must render through the incremental markdown streaming renderer');
  assert.ok(reasoningSource.includes('className="reasoning-panel reasoning-live-panel"'), 'reasoning must use the DeepSeek-style thought panel');
  assert.ok(reasoningSource.includes('<span class="reasoning-label">正在思考</span><span class="reasoning-dots"'), 'live thinking must show animated dots immediately after the label');
  assert.ok(reasoningSource.includes('label.textContent=completed?"思考完成":"正在思考"'), 'completed thinking must change the panel label');
  assert.ok(reasoningSource.includes('dots.hidden=completed'), 'completed thinking must stop and remove the animated dots');
  assert.ok(reasoningSource.includes('<span class="reasoning-chevron"'), 'the collapse arrow must remain after the thinking label and dots');
  assert.ok(reasoningSource.includes('panelHost.prepend(panel)'), 'the thought panel must remain above the answer content when Markdown output updates');
  assert.ok(reasoningSource.includes('function finishReasoning') && reasoningSource.includes('updateReasoning(e,reasoning,{done:!0,restoreHistory:!0'), 'completed thought panels must remain renderable rather than being removed');
  assert.ok(chatSource.includes('reasoning_content:R'), 'chat completion must persist reasoning in canonical assistant messages');
  assert.ok(chatSource.includes('reasoning:a,keepReasoning:!!a'), 'live reasoning updates must checkpoint pending display state for refresh recovery');
  assert.ok(chatSource.includes('R&&updateReasoning(g,R,{done:!0,restoreHistory:!0'), 'the completed live message must preserve its thought panel');
  assert.ok(historySource.includes("normalized?.reasoning_content || normalized?.reasoning"), 'canonical-history rendering must restore persisted reasoning after refresh');
  assert.ok(resumeSource.includes('reasoning: s.reasoning || ""'), 'resumed live chat jobs must checkpoint received reasoning');
  assert.ok(resumeSource.includes('updateReasoning(node, s.reasoning, { done: false'), 'the active resumed message must restore its live thought panel after the response projection updates');
  assert.ok(resumeSource.includes('reasoning_content: u'), 'resumed chat completion must persist its reasoning into canonical history');
}

function testCanonicalHistoryRestoresPersistedReasoning() {
  const displayHistorySource = fs.readFileSync(path.join(__dirname, '../../client/app/display-history-workflow.js'), 'utf8');
  assert.ok(
    displayHistorySource.includes("normalized?.reasoning_content || normalized?.reasoning"),
    'canonical history rendering must restore a persisted reasoning trace into the DeepSeek-style panel'
  );
}

module.exports = [
  testCompletedReasoningPersistsInCanonicalHistory,
  testStreamingReasoningCheckpointsForRefreshRecovery,
  testReasoningRendererPersistsAndRestoresMarkdown,
  testCanonicalHistoryRestoresPersistedReasoning,
];
