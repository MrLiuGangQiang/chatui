'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');

const displayItems = require('../../client/app/display-items');
const messageWorkflow = require('../../client/app/message-workflow');
const persistence = require('../../client/app/persistence');
const imageRouteContext = require('../../client/core/image-route-context');
const contextBudget = require('../../shared/config/context-budget');
const jobService = require('../../client/services/job-service');
const usageStatsAuth = require('../../client/ui/usage-stats-auth');

function testDisplayCompactionUsesUnambiguousStructuredIdentity() {
  const first = { role: 'assistant', rawText: 'a', html: 'bc', reasoningText: 'first' };
  const second = { role: 'assistant', rawText: 'ab', html: 'c', reasoningText: 'second' };
  const compacted = displayItems.compactDisplayItems([first, second]);
  assert.strictEqual(compacted.length, 2, 'field-boundary collisions must not merge distinct messages');
  assert.strictEqual(compacted[0], first);
  assert.strictEqual(compacted[1], second);
}

function testMalformedAttachmentContextFailsClosedDuringPersistence() {
  const payload = 'data:image/png;base64,' + 'A'.repeat(4096);
  const malformed = `{"attachments":[{"src":"${payload}"}]`;
  const display = persistence.sanitizeStoredDisplayItem({ imageContext: malformed });
  const message = persistence.sanitizeStoredMessage({ imageContext: malformed });
  assert.strictEqual(display.imageContext, '');
  assert.strictEqual(message.imageContext, '');
  assert.doesNotMatch(JSON.stringify({ display, message }), /data:image\/png;base64/);
}

function testStoredDisplayHtmlIsSanitizedAtTheRenderBoundary() {
  const dom = new JSDOM('<main id="messages"><article class="message assistant"><div class="content"></div><div class="msg-actions"></div></article></main>');
  const document = dom.window.document;
  const node = document.querySelector('.message');
  const state = { activeSessionId: 'session-1', activeOutputNode: null, userScrollLocked: false, scrollVersion: 0 };
  const workflow = messageWorkflow.createMessageWorkflow({
    state,
    document,
    $: id => id === 'messages' ? document.querySelector('#messages') : null,
    chatuiContentHash: value => String(value || ''),
    chatuiShouldLazyRender: () => false,
    chatuiPerfNow: () => 0,
    chatuiLogLongTask() {},
    stripTransientBlobUrlsFromHtml: value => String(value || ''),
    resetMessageActionStates() {},
    bindInlineCopyButtons() {},
    enhanceRenderedMarkdown() {},
    hydrateMessageMedia() {},
    scrollToBottom() {},
  });
  workflow.updateMessage(node, [
    '<script>window.__storedXss = true</script>',
    '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" onerror="window.__storedXss=true">',
    '<a href="javascript:window.__storedXss=true">bad link</a>',
    '<button class="image-download-btn" onclick="window.__storedXss=true">download</button>',
  ].join(''), { html: true, rawText: 'stored rich display', skipSave: true });

  const content = node.querySelector('.content');
  assert.strictEqual(content.querySelector('script'), null);
  assert.strictEqual(content.querySelector('img').hasAttribute('src'), false);
  assert.strictEqual(content.querySelector('img').hasAttribute('onerror'), false);
  assert.strictEqual(content.querySelector('a').hasAttribute('href'), false);
  assert.ok(content.querySelector('button.image-download-btn'), 'trusted internal action structure must survive sanitization');
  assert.strictEqual(content.querySelector('button').hasAttribute('onclick'), false);
}

function testRouteContextSizeTrimmerHonorsItsHardLimit() {
  const oversized = {
    recent_messages: [],
    image_candidates: [],
    file_candidates: [{
      index: 1,
      source: 'history',
      file_id: 'file-1',
      name: 'x'.repeat(20_000),
      type: 'text/plain',
      unsupported_reason: 'y'.repeat(20_000),
    }],
    recent_image_references: [],
    recent_uploaded_image_references: [],
    latest_uploaded_image: { prompt: 'z'.repeat(20_000) },
  };
  const trimmed = imageRouteContext.trimRouteContextToSize(oversized, 480);
  assert.ok(imageRouteContext.routeContextSize(trimmed) <= 480, 'the returned context must satisfy the advertised byte-character ceiling');
}

function testRouteContextTokenTrimmerHonorsItsHardLimitWithoutMessages() {
  const oversized = {
    recent_messages: [],
    image_candidates: [],
    file_candidates: [{
      index: 1,
      source: 'current',
      file_id: 'file-1',
      name: '\u6587'.repeat(20_000),
      type: 'text/plain',
      unsupported_reason: '\u4ef6'.repeat(20_000),
    }],
    recent_image_references: [],
    recent_uploaded_image_references: [],
  };
  const contextWindowTokens = 100;
  const trimmed = imageRouteContext.trimRouteContextToTokenWindow(oversized, contextWindowTokens);
  const tokens = contextBudget.estimateTextTokens(JSON.stringify(trimmed));
  assert.ok(tokens <= contextBudget.inputBudgetForContextWindow(contextWindowTokens), 'non-message route fields must also satisfy the advertised token ceiling');
}

function createUsageStatsHarness(service) {
  const dom = new JSDOM(`<!doctype html><body>
    <input id="apiKey" value="key">
    <input id="baseUrl" value="https://api.example.com/v1">
    <select id="chatModel"><option value="model" selected>model</option></select>
  </body>`, { url: 'https://chatui.example/', pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.window.document;
  dom.window.ChatUIUsageStatsFormat = require('../../client/ui/usage-stats-format');
  dom.window.ChatUIUsageStatsAuth = usageStatsAuth;
  dom.window.ChatUIUsageStatsViewHelpers = require('../../client/features/usage-stats/view-helpers');
  dom.window.ChatUIServices = { usageStats: service };
  usageStatsAuth.clearDepartmentPassword(dom.window.sessionStorage, dom.window.localStorage);
  const modulePath = require.resolve('../../client/ui/usage-stats');
  delete require.cache[modulePath];
  require(modulePath);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return {
    dom,
    restore() {
      delete require.cache[modulePath];
      global.window = previousWindow;
      global.document = previousDocument;
      dom.window.close();
    },
  };
}

function flushUsageStatsTasks(turns = 2) {
  return new Promise(resolve => {
    const step = remaining => remaining > 0 ? setTimeout(() => step(remaining - 1), 0) : resolve();
    step(turns);
  });
}

async function testUsageStatsIgnoresOutOfOrderRangeResponsesAndCacheWrites() {
  const pending = [];
  const service = {
    async requestOverview() {
      return { available: true, ranking: [{ username: 'initial-ranking', total_tokens: 1 }], personal: { username: 'initial-personal', total_tokens: 1 } };
    },
    requestPersonal(_apiKey, _model, range) {
      return new Promise(resolve => pending.push({ range, resolve }));
    },
    async requestRanking() {
      return { available: true, ranking: [] };
    },
  };
  const harness = createUsageStatsHarness(service);
  try {
    harness.dom.window.document.getElementById('usageStatsButton').click();
    await flushUsageStatsTasks();
    harness.dom.window.document.querySelector('[data-personal-range="yesterday"]').click();
    harness.dom.window.document.querySelector('[data-personal-range="week"]').click();
    assert.deepStrictEqual(pending.map(item => item.range), ['yesterday', 'week']);

    pending.find(item => item.range === 'week').resolve({ personal: { username: 'week-result', total_tokens: 2 } });
    await flushUsageStatsTasks();
    assert.match(harness.dom.window.document.getElementById('usagePersonal').textContent, /week-result/);

    pending.find(item => item.range === 'yesterday').resolve({ personal: { username: 'stale-yesterday-result', total_tokens: 3 } });
    await flushUsageStatsTasks();
    const currentPersonalText = harness.dom.window.document.getElementById('usagePersonal').textContent;
    assert.doesNotMatch(currentPersonalText, /stale-yesterday-result/);
    assert.match(currentPersonalText, /week-result/);

    harness.dom.window.document.querySelector('[data-personal-range="yesterday"]').click();
    await flushUsageStatsTasks(1);
    assert.strictEqual(pending.length, 3, 'a stale response must not populate the cache for a later range selection');
  } finally {
    pending.at(-1)?.resolve({ personal: null });
    await flushUsageStatsTasks(1);
    harness.restore();
  }
}

async function testUsageStatsCacheSeparatesExactCredentialContexts() {
  // These two values collide under the legacy 32-bit FNV cache fingerprint.
  const firstApiKey = '656pEJqTq7cB';
  const secondApiKey = 'KpS9GJCLox6d';
  const rankingCalls = [];
  const service = {
    async requestOverview(apiKey) {
      return {
        available: true,
        ranking: [{ username: `overview-${apiKey}`, total_tokens: 1 }],
        personal: { username: `personal-${apiKey}`, total_tokens: 1 },
      };
    },
    async requestRanking(apiKey) {
      rankingCalls.push(apiKey);
      return { available: true, ranking: [{ username: `ranking-${apiKey}`, total_tokens: 2 }] };
    },
  };
  const harness = createUsageStatsHarness(service);
  try {
    const document = harness.dom.window.document;
    document.getElementById('apiKey').value = firstApiKey;
    document.getElementById('usageStatsButton').click();
    await flushUsageStatsTasks();
    assert.match(document.getElementById('usageRanking').textContent, new RegExp(`overview-${firstApiKey}`));

    document.getElementById('apiKey').value = secondApiKey;
    document.querySelector('[data-usage-tab="today"]').click();
    await flushUsageStatsTasks();

    assert.deepStrictEqual(rankingCalls, [secondApiKey], 'a distinct credential context must not reuse another API key cache entry');
    const rankingText = document.getElementById('usageRanking').textContent;
    assert.match(rankingText, new RegExp(`ranking-${secondApiKey}`));
    assert.doesNotMatch(rankingText, new RegExp(`overview-${firstApiKey}`));
  } finally {
    harness.restore();
  }
}

async function testUsageStatsIgnoresPersonalResponsesAfterModeSwitch() {
  let staleRankingResolve;
  let departmentCalls = 0;
  const service = {
    async requestOverview() {
      return { available: true, ranking: [{ username: 'initial-ranking', total_tokens: 1 }], personal: { username: 'initial-personal', total_tokens: 1 } };
    },
    requestRanking(_apiKey, _model, range) {
      if (range !== 'week') return Promise.resolve({ available: true, ranking: [] });
      return new Promise(resolve => { staleRankingResolve = resolve; });
    },
    async verifyDepartmentPassword() {
      return { available: true, authorized: true };
    },
    async requestDepartmentSummary() {
      departmentCalls += 1;
      return { available: true, ranking: [{ department_name: 'department-result', department_id: 'dept-1', total_tokens: 4 }] };
    },
  };
  const harness = createUsageStatsHarness(service);
  try {
    harness.dom.window.prompt = () => 'department-password';
    harness.dom.window.document.getElementById('usageStatsButton').click();
    await flushUsageStatsTasks();
    harness.dom.window.document.querySelector('[data-usage-tab="week"]').click();
    assert.strictEqual(typeof staleRankingResolve, 'function');

    harness.dom.window.document.getElementById('usageStatsModeToggle').click();
    await flushUsageStatsTasks(3);
    assert.ok(departmentCalls >= 1, 'the new department mode request should complete');
    assert.match(harness.dom.window.document.getElementById('usageStatsTitle').textContent, /部门/);

    staleRankingResolve({ available: true, ranking: [{ username: 'stale-personal-result', total_tokens: 99 }] });
    await flushUsageStatsTasks();
    const rankingText = harness.dom.window.document.getElementById('usageRanking').textContent;
    assert.doesNotMatch(rankingText, /stale-personal-result/);
    assert.match(rankingText, /department-result/);
  } finally {
    staleRankingResolve?.({ available: true, ranking: [] });
    harness.restore();
  }
}

async function testUsageStatsDepartmentRefreshStaysScopedAndRestoresItsControl() {
  let departmentCalls = 0;
  let staleRefreshResolve;
  const service = {
    async requestOverview() {
      return {
        available: true,
        ranking: [{ username: 'personal-ranking', total_tokens: 1 }],
        personal: { username: 'personal-result', total_tokens: 1 },
      };
    },
    async verifyDepartmentPassword() {
      return { available: true, authorized: true };
    },
    requestDepartmentSummary(_password, _apiKey, _model, range) {
      departmentCalls += 1;
      if (departmentCalls === 2) {
        return new Promise(resolve => { staleRefreshResolve = resolve; });
      }
      return Promise.resolve({
        available: true,
        ranking: [{
          department_name: range === 'week' ? 'week-department' : 'today-department',
          department_id: 'dept-1',
          total_tokens: departmentCalls,
        }],
      });
    },
  };
  const harness = createUsageStatsHarness(service);
  try {
    const document = harness.dom.window.document;
    harness.dom.window.prompt = () => 'department-password';
    document.getElementById('usageStatsButton').click();
    await flushUsageStatsTasks();
    document.getElementById('usageStatsModeToggle').click();
    await flushUsageStatsTasks(3);
    assert.match(document.getElementById('usageRanking').textContent, /today-department/);

    const refresh = document.getElementById('usageStatsRefresh');
    refresh.click();
    assert.strictEqual(typeof staleRefreshResolve, 'function');
    assert.strictEqual(refresh.disabled, true);
    document.querySelector('[data-usage-tab="week"]').click();
    await flushUsageStatsTasks();
    assert.match(document.getElementById('usageRanking').textContent, /week-department/);

    staleRefreshResolve({
      available: true,
      ranking: [{ department_name: 'stale-refresh-result', department_id: 'dept-2', total_tokens: 99 }],
    });
    await flushUsageStatsTasks();
    const rankingText = document.getElementById('usageRanking').textContent;
    assert.doesNotMatch(rankingText, /stale-refresh-result/);
    assert.match(rankingText, /week-department/);
    assert.strictEqual(refresh.disabled, false, 'a stale refresh must release the control it owns');
    assert.strictEqual(refresh.classList.contains('is-spinning'), false);

    document.getElementById('usageStatsModeToggle').click();
    await flushUsageStatsTasks(3);
    assert.match(document.getElementById('usageStatsTitle').textContent, /使用统计/);
    assert.match(document.getElementById('usagePersonal').textContent, /personal-result/);
  } finally {
    staleRefreshResolve?.({ available: true, ranking: [] });
    harness.restore();
  }
}

function streamResponse(chunks) {
  let index = 0;
  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: new TextEncoder().encode(chunks[index++]) };
          },
          async cancel() {},
        };
      },
    },
  };
}

async function testJobEventParserHandlesStandardCrLfAndCallbackFailure() {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const result = await jobService.waitJobEvent({
      url: '/api/jobs/job-1/events',
      fetchImpl: async () => streamResponse([
        'event:update\r\ndata: {"status":"done",\r\n',
        'data:"data":{"answer":"ok"}}\r\n\r\n',
      ]),
      onUpdate() { throw new Error('consumer failed'); },
    });
    assert.deepStrictEqual(result, { answer: 'ok', metrics: {} });
    assert.strictEqual(warnings.length, 1, 'callback failures should be isolated and observable without losing the terminal event');
  } finally {
    console.warn = originalWarn;
  }
}

async function testUploadJsonParseFailureRejectsInsteadOfHanging() {
  const original = globalThis.XMLHttpRequest;
  class FakeXMLHttpRequest {
    constructor() {
      this.upload = {};
      this.status = 200;
      this.responseText = '{not-json';
    }
    open() {}
    setRequestHeader() {}
    send() { queueMicrotask(() => this.onload?.()); }
    abort() { this.onabort?.(); }
  }
  globalThis.XMLHttpRequest = FakeXMLHttpRequest;
  try {
    await assert.rejects(jobService.startImageGenerationJob({
      payload: { prompt: 'test' },
      config: { baseUrl: 'https://api.example.com/v1', apiKey: 'key' },
      jobId: 'imgjob-1',
      onUploadProgress() {},
      parseResponseJson: async () => { throw new SyntaxError('invalid response JSON'); },
      normalizeError: () => 'request failed',
    }), /invalid response JSON/);
  } finally {
    if (original === undefined) delete globalThis.XMLHttpRequest;
    else globalThis.XMLHttpRequest = original;
  }
}

module.exports = [
  testDisplayCompactionUsesUnambiguousStructuredIdentity,
  testMalformedAttachmentContextFailsClosedDuringPersistence,
  testStoredDisplayHtmlIsSanitizedAtTheRenderBoundary,
  testRouteContextSizeTrimmerHonorsItsHardLimit,
  testRouteContextTokenTrimmerHonorsItsHardLimitWithoutMessages,
  testUsageStatsIgnoresOutOfOrderRangeResponsesAndCacheWrites,
  testUsageStatsCacheSeparatesExactCredentialContexts,
  testUsageStatsIgnoresPersonalResponsesAfterModeSwitch,
  testUsageStatsDepartmentRefreshStaysScopedAndRestoresItsControl,
  testJobEventParserHandlesStandardCrLfAndCallbackFailure,
  testUploadJsonParseFailureRejectsInsteadOfHanging,
];
