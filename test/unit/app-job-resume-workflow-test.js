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

  let rebuilt = false;
  let registeredPayload = null;
  let cleared = false;
  const pendingItem = { id: 'display-1', role: 'assistant', rawText: '正在恢复聊天任务…', pending: '1', responseIndex: '1' };
  const resumeState = {
    activeSessionId: 's2',
    resumingJobs: new Set(),
    sessions: [{ id: 's2', messages: [{ role: 'user', content: '继续写' }], display: [pendingItem] }],
    followingImageJobs: new Set(),
    followingChatJobs: new Set(),
    reasoningMode: false,
  };
  const resumeMissing = workflow.createJobResumeWorkflow({
    state: resumeState,
    loadLatestChatJob: () => ({ id: 'chatjob-missing', payload: null, displayItemId: 'display-1', responseIndex: '1', startedAt: Date.now() }),
    loadImageJob: () => null,
    clearChatJob: () => { cleared = true; },
    sessionHasCompletedAssistantForResponse: () => false,
    takeChatJobLiveItem: () => pendingItem,
    persistSessionDisplay() {},
    setSessionBusy() {},
    findMessageNodeByDisplayItem: () => null,
    setActiveOutputForSession() {},
    updateResumeStreamButton() {},
    shouldFollowScroll: () => false,
    updateLiveDisplay() {},
    getConfig: () => ({ baseUrl: 'https://example.test/v1' }),
    getChatJob: async () => { throw new Error('任务不存在或服务已重启'); },
    isMissingJobError: err => String(err?.message || err).includes('任务不存在或服务已重启'),
    buildResumeChatPayload: () => { rebuilt = true; return { model: 'm', messages: [{ role: 'user', content: '继续写' }], stream: true }; },
    restoreJobPayloadMedia: async payload => payload,
    registerChatStreamJob: async payload => {
      registeredPayload = payload;
      return { status: 'done', data: { choices: [{ message: { content: '恢复完成', reasoning_content: '' } }] }, metrics: {} };
    },
    waitChatJob: async () => { throw new Error('should not wait old missing job'); },
    extractChatJobText: data => ({ content: data?.choices?.[0]?.message?.content || '', reasoning: data?.choices?.[0]?.message?.reasoning_content || '', firstTokenMs: null }),
    updateSessionDisplayItem: (_sid, item, role, text, options) => Object.assign(item, { role, rawText: text, pending: options?.pending ? '1' : '' }),
    firstTokenTimeText: () => '',
    replaceAssistantMessageAt() {},
    compactAdjacentDuplicateMessages: items => items,
    cloneMessageList: items => JSON.parse(JSON.stringify(items || [])),
    saveSessionMessages() {},
    forceRenderCanonicalMessages() {},
    trimAssistantTailDuplicate: items => items,
    playDoneSound() {},
    isChatStatusText: text => /正在|已收到/.test(String(text || '')),
    finishReasoning() {},
    updateMessage() {},
    cleanupStalePendingDisplay() {},
    showRunError() {},
    addMessage() {},
  });
  await resumeMissing.resumeChatJob('s2');
  assert.strictEqual(rebuilt, true);
  assert.deepStrictEqual(registeredPayload, { model: 'm', messages: [{ role: 'user', content: '继续写' }], stream: true });
  assert.strictEqual(pendingItem.rawText, '恢复完成');
  assert.strictEqual(cleared, true);
  assert.strictEqual(resumeState.resumingJobs.size, 0);

  console.log('app job resume workflow ok');
})();
