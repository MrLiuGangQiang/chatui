'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const problemFeedbackCore = require('../../client/core/problem-feedback');
const { createProblemFeedbackWorkflow, EVENT_NAME, FEEDBACK_DELAY_MS } = require('../../client/app/problem-feedback-workflow');

function sampleSession() {
  return {
    id: 'session-1',
    title: '异常反馈测试',
    messages: [
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮答复' },
      { role: 'user', content: '第二轮问题 sk-secret12345678' },
      { role: 'assistant', content: '第二轮答复' },
      { role: 'user', content: [{ type: 'text', text: '第三轮问题' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: '第三轮答复' },
      { role: 'user', content: '第四轮触发异常' },
    ],
  };
}

function createFakeBrowser(fetchImpl) {
  const listeners = new Map();
  class FakeCustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  const timers = [];
  return {
    location: { href: 'http://localhost:8765/' },
    CustomEvent: FakeCustomEvent,
    fetch: fetchImpl,
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    runTimers() {
      const queued = timers.splice(0, timers.length);
      queued.forEach(timer => timer.callback());
      return queued;
    },
    addEventListener(type, listener) {
      const list = listeners.get(type) || [];
      list.push(listener);
      listeners.set(type, list);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
    emit(type, event) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
  };
}

function flushAsyncWork() {
  return new Promise(resolve => setImmediate(resolve));
}

function testProblemFeedbackBuildsRecentConversationExcerptAndRedactsSecrets() {
  const rounds = problemFeedbackCore.collectConversationRounds(sampleSession(), { maxRounds: 3, messageMaxChars: 200 });
  assert.strictEqual(rounds.length, 3);
  assert.strictEqual(rounds[0].user.includes('第二轮问题'), true);
  assert.strictEqual(rounds[0].user.includes('sk-secret'), false);
  assert.strictEqual(rounds[1].user.includes('第三轮问题'), true);
  assert.strictEqual(rounds[1].user.includes('AAAA'), false);
  assert.deepStrictEqual(rounds[2], { user: '第四轮触发异常', assistants: [] });

  const excerpt = problemFeedbackCore.buildConversationExcerpt(sampleSession(), { maxRounds: 3, maxChars: 900 });
  assert.ok(!excerpt.includes('自动填写') && !excerpt.includes('最近 3 轮') && !excerpt.includes('第 1 轮'));
  assert.ok(excerpt.includes('用户：第四轮触发异常'));
  assert.ok(excerpt.includes('助手：[未产生正常答复]'));
  assert.ok(!excerpt.includes('第一轮问题'));
}

function testProblemFeedbackDraftIncludesIncidentAndFitsFeedbackField() {
  const draft = problemFeedbackCore.buildIncidentDraft({
    kind: 'http',
    source: 'fetch',
    method: 'POST',
    url: 'https://example.test/v1/chat/completions?api_key=secret',
    status: 502,
    statusText: 'Bad Gateway',
    responseText: JSON.stringify({ error: { message: '上游服务异常' } }),
    occurredAt: Date.parse('2026-08-04T05:00:00.000Z'),
  }, sampleSession());

  assert.ok(draft.problem.includes('HTTP 502'));
  assert.ok(draft.problem.includes('上游服务异常'));
  assert.ok(draft.reproduction.includes('POST https://example.test/v1/chat/completions · HTTP 502 Bad Gateway'));
  assert.ok(!draft.reproduction.includes('api_key=secret'));
  assert.ok(draft.reproduction.includes('助手：第三轮答复'));
  assert.ok(draft.reproduction.includes('第四轮触发异常'));
  assert.ok(!draft.reproduction.includes('自动填写') && !draft.reproduction.includes('最近 3 轮') && !draft.reproduction.includes('第 2 轮'));
  assert.ok(draft.reproduction.length <= problemFeedbackCore.DEFAULT_REPRODUCTION_MAX);
  assert.strictEqual(draft.expected, '');
}

async function testProblemFeedbackWorkflowReportsNonOkResponsesAndBuildsDraft() {
  const browser = createFakeBrowser(async () => ({
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
    clone() {
      return { text: async () => JSON.stringify({ error: { message: '模型服务暂时不可用' } }) };
    },
  }));
  const events = [];
  browser.addEventListener(EVENT_NAME, event => events.push(event.detail));
  const workflow = createProblemFeedbackWorkflow({ root: browser, now: () => Date.parse('2026-08-04T06:00:00.000Z') });
  workflow.configure({ getActiveSession: sampleSession }).install();

  const response = await browser.fetch('/api/chat/completions?token=secret', { method: 'POST' });
  assert.strictEqual(response.status, 503);
  await flushAsyncWork();
  assert.strictEqual(events.length, 0, 'the feedback panel must not open immediately');
  const timers = browser.runTimers();
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(timers[0].delay, FEEDBACK_DELAY_MS);
  assert.strictEqual(events.length, 1, 'the feedback panel should be notified after the five-second delay');
  assert.strictEqual(events[0].status, 503);
  assert.strictEqual(events[0].url, '/api/chat/completions');

  const draft = workflow.createDraft(events[0]);
  assert.ok(draft.reproduction.includes('用户：第二轮问题'));
  assert.ok(draft.reproduction.includes('模型服务暂时不可用'));
  assert.strictEqual(workflow.consumePending().length, 1);
}

async function testProblemFeedbackWorkflowIgnoresFeedbackRecursionAndAbort() {
  let mode = 'feedback';
  const browser = createFakeBrowser(async () => {
    if (mode === 'abort') {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    }
    return {
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      clone() { return { text: async () => 'feedback failed' }; },
    };
  });
  const events = [];
  browser.addEventListener(EVENT_NAME, event => events.push(event.detail));
  const workflow = createProblemFeedbackWorkflow({ root: browser }).install();

  await browser.fetch('/api/usage/feedback', { method: 'POST' });
  await flushAsyncWork();
  browser.runTimers();
  assert.strictEqual(events.length, 0, 'feedback submission failures must not recursively reopen the feedback form');

  mode = 'abort';
  await assert.rejects(browser.fetch('/api/chat/completions'), error => error?.name === 'AbortError');
  assert.strictEqual(events.length, 0, 'normal request cancellation must not be reported as an incident');
}

function testProblemFeedbackManualDraftUsesRecentConversationWithoutFakeError() {
  const browser = createFakeBrowser(async () => ({ ok: true, status: 200 }));
  const workflow = createProblemFeedbackWorkflow({ root: browser });
  workflow.configure({ getActiveSession: sampleSession });
  const draft = workflow.createManualDraft();
  assert.strictEqual(draft.problem, '');
  assert.strictEqual(draft.expected, '');
  assert.ok(draft.reproduction.includes('用户：第二轮问题'));
  assert.ok(draft.reproduction.includes('第四轮触发异常'));
  assert.ok(!draft.reproduction.includes('第一轮问题'));
  assert.ok(!draft.reproduction.includes('异常：') && !draft.reproduction.includes('自动捕获'), 'manual feedback must not invent an error or explanatory headings');
}

async function testProblemFeedbackWorkflowIgnoresResourceNoiseAndMonitorsApiFailures() {
  const browser = createFakeBrowser(async () => ({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    clone() { return { text: async () => 'missing' }; },
  }));
  const events = [];
  browser.addEventListener(EVENT_NAME, event => events.push(event.detail));
  const workflow = createProblemFeedbackWorkflow({ root: browser }).install();

  await browser.fetch('/optional-image.png', { method: 'GET' });
  await flushAsyncWork();
  assert.strictEqual(browser.runTimers().length, 0, 'ordinary resource GET failures must not schedule feedback');
  browser.emit('error', {
    target: {
      tagName: 'IMG',
      currentSrc: '',
      src: 'http://localhost:8765/',
      getAttribute: name => name === 'src' ? '' : null,
    },
  });
  assert.strictEqual(events.length, 0, 'element resource errors must not open functional feedback');
  assert.strictEqual(workflow.report({ kind: 'resource', message: '资源未能加载：/' }), null);

  await browser.fetch('/api/models', { method: 'GET' });
  await flushAsyncWork();
  const timers = browser.runTimers();
  assert.strictEqual(timers.length, 1, 'API failures remain functional incidents');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].url, '/api/models');
}

function testProblemFeedbackDraftSurvivesCloseAndReopenStorageCycle() {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const modulePath = require.resolve('../../client/ui/usage-stats');
  delete require.cache[modulePath];
  const fields = new Map([
    ['usageFeedbackProblem', { value: '', maxLength: 1400, dataset: {}, classList: { remove() {} } }],
    ['usageFeedbackReproduction', { value: '', maxLength: 1400, dataset: {}, classList: { remove() {} } }],
    ['usageFeedbackExpected', { value: '', maxLength: 900, dataset: {}, classList: { remove() {} } }],
  ]);
  const stored = new Map();
  try {
    delete global.window;
    delete global.document;
    const usageStatsUi = require('../../client/ui/usage-stats');
    global.window = {
      sessionStorage: {
        getItem: key => stored.get(key) || null,
        setItem: (key, value) => stored.set(key, String(value)),
        removeItem: key => stored.delete(key),
      },
    };
    global.document = { getElementById: id => fields.get(id) || null };
    fields.get('usageFeedbackProblem').value = '请求失败';
    fields.get('usageFeedbackReproduction').value = '最近三轮会话和异常信息';
    fields.get('usageFeedbackExpected').value = '请求应正常完成';
    fields.get('usageFeedbackReproduction').dataset.autoPrefilled = '1';
    assert.strictEqual(usageStatsUi.saveFeedbackFormDraft(), true);

    for (const field of fields.values()) {
      field.value = '';
      delete field.dataset.autoPrefilled;
    }
    assert.strictEqual(usageStatsUi.restoreFeedbackFormDraft(), true);
    assert.strictEqual(fields.get('usageFeedbackProblem').value, '请求失败');
    assert.strictEqual(fields.get('usageFeedbackReproduction').value, '最近三轮会话和异常信息');
    assert.strictEqual(fields.get('usageFeedbackExpected').value, '请求应正常完成');
    assert.strictEqual(fields.get('usageFeedbackReproduction').dataset.autoPrefilled, '1');

    usageStatsUi.clearFeedbackFormDraft();
    assert.strictEqual(stored.has('chatui-problem-feedback-draft-v1'), false);
  } finally {
    delete require.cache[modulePath];
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  }
}

function testProblemFeedbackRuntimeHooksAndAppIntegrationArePresent() {
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '../../client/ui/usage-stats.js'), 'utf8');
  const coreIndex = index.indexOf('client/core/problem-feedback.js');
  const workflowIndex = index.indexOf('client/app/problem-feedback-workflow.js');
  const serviceIndex = index.indexOf('client/services/model-service.js');
  const uiIndex = index.indexOf('client/ui/usage-stats.js');
  const appIndex = index.search(/<script src="\.\/app\.js\?v=[^"]+"><\/script>/);

  assert.ok(index.includes('client/core/problem-feedback.js?v=1.1.1-expected-result-manual'));
  assert.ok(index.includes('problem-feedback-workflow.js?v=1.2.1-clean-format'));
  assert.ok(index.includes('usage-stats.js?v=1.3.3-utility-actions'));
  assert.ok(coreIndex > -1 && workflowIndex > coreIndex && workflowIndex < serviceIndex, 'fetch monitoring must install before application services issue requests');
  assert.ok(uiIndex > workflowIndex && appIndex > uiIndex, 'feedback UI and session provider must load after the incident workflow');
  assert.ok(app.includes('reportProblem(t,{source:"run",sessionId:e})'), 'final run errors must reach the incident reporter');
  assert.ok(app.includes('configure?.({getActiveSession})'), 'the incident workflow must receive the active session provider');
  assert.ok(ui.includes('最近几轮会话自动填入复现描述'));
  assert.ok(ui.includes("openFeedbackPanel({ incident })"));
  assert.ok(ui.includes('saveFeedbackFormDraft') && ui.includes('restoreFeedbackFormDraft') && ui.includes('sessionStorage'));
  assert.ok(ui.includes('applyManualConversationDraft') && ui.includes('createManualDraft'));
  assert.ok(ui.includes('consumeReadyPending'));
  const feedbackWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/problem-feedback-workflow.js'), 'utf8');
  const imagePreviewWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/image-preview-workflow.js'), 'utf8');
  assert.ok(feedbackWorkflow.includes('FEEDBACK_DELAY_MS = 5000'));
  assert.ok(feedbackWorkflow.includes("input.kind === 'resource'") && feedbackWorkflow.includes('isFunctionalRequest'));
  assert.ok(imagePreviewWorkflow.includes('removeAttribute("src")') && !imagePreviewWorkflow.includes('e.src=""'));
}

async function testProblemFeedbackSuppressForStopClearsPendingAndBlocksReports() {
  let clock = Date.parse('2026-08-04T07:00:00.000Z');
  const browser = createFakeBrowser(async () => ({
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
    clone() { return { text: async () => 'boom' }; },
  }));
  const events = [];
  browser.addEventListener(EVENT_NAME, event => events.push(event.detail));
  const workflow = createProblemFeedbackWorkflow({ root: browser, now: () => clock }).install();

  // 人为停止前：一次失败的 API 调用已排队等待延迟派发
  await browser.fetch('/api/chat/completions', { method: 'POST' });
  await flushAsyncWork();
  assert.strictEqual(events.length, 0, 'feedback must wait for the delay before opening');

  // 人为停止：清空 pending 并进入抑制窗口
  workflow.suppressForStop(3000);
  browser.runTimers();
  assert.strictEqual(events.length, 0, 'queued incidents must not dispatch after a manual stop');

  // 抑制窗口内的新错误也不得触发自动反馈
  await browser.fetch('/api/chat/completions', { method: 'POST' });
  await flushAsyncWork();
  browser.runTimers();
  assert.strictEqual(events.length, 0, 'reports inside the suppression window must be ignored');

  // 抑制窗口过期后恢复自动反馈
  clock += 4000;
  await browser.fetch('/api/chat/completions', { method: 'POST' });
  await flushAsyncWork();
  assert.strictEqual(events.length, 0);
  browser.runTimers();
  assert.strictEqual(events.length, 1, 'reports after the suppression window must be dispatched again');
}

function testProblemFeedbackSuppressForStopExportedAndWiredInAppStop() {
  const app = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const feedbackWorkflow = fs.readFileSync(path.join(__dirname, '../../client/app/problem-feedback-workflow.js'), 'utf8');
  assert.ok(feedbackWorkflow.includes('suppressForStop'), 'the workflow API must export suppressForStop');
  assert.ok(feedbackWorkflow.includes('suppressUntil = now() + Math.max(0, Number(durationMs) || 0)'), 'suppressForStop must set a time-bounded suppression window');
  assert.ok(app.includes('getProblemFeedbackWorkflow()?.suppressForStop?.()'), 'stopActiveRun must call suppressForStop before stopping the task');
}

module.exports = [
  testProblemFeedbackBuildsRecentConversationExcerptAndRedactsSecrets,
  testProblemFeedbackDraftIncludesIncidentAndFitsFeedbackField,
  testProblemFeedbackWorkflowReportsNonOkResponsesAndBuildsDraft,
  testProblemFeedbackWorkflowIgnoresFeedbackRecursionAndAbort,
  testProblemFeedbackManualDraftUsesRecentConversationWithoutFakeError,
  testProblemFeedbackWorkflowIgnoresResourceNoiseAndMonitorsApiFailures,
  testProblemFeedbackSuppressForStopClearsPendingAndBlocksReports,
  testProblemFeedbackSuppressForStopExportedAndWiredInAppStop,
  testProblemFeedbackDraftSurvivesCloseAndReopenStorageCycle,
  testProblemFeedbackRuntimeHooksAndAppIntegrationArePresent,
];
