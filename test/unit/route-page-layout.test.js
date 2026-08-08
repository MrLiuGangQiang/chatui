'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '../..');
const routePath = path.join(root, 'pages/route.html');

function readRoutePage() {
  return fs.readFileSync(routePath, 'utf8');
}

function createInteractiveRoutePage() {
  return new JSDOM(readRoutePage(), {
    runScripts: 'dangerously',
    url: 'https://chatui.test/pages/route.html',
  });
}

function visibleCopy(document) {
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll('script, style').forEach(node => node.remove());
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

function publishRouteState(window, detail) {
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'chatui:route-task-state', ...detail },
    origin: window.location.origin,
    source: window.parent,
  }));
}

function testRoutePageUsesPlainLanguageForTheRealThreePartFlow() {
  const html = readRoutePage();
  const dom = new JSDOM(html);
  const { document } = dom.window;
  const phases = [...document.querySelectorAll('[data-phase-panel]')];
  const copy = visibleCopy(document);

  assert.strictEqual(document.title, 'ChatUI · 一条消息是怎样被处理的');
  assert.deepStrictEqual(phases.map(phase => phase.dataset.phasePanel), ['submit', 'route', 'execute']);
  assert.deepStrictEqual(phases.map(phase => phase.querySelector('.phase-title')?.textContent.trim()), [
    '先把你的消息收好',
    '判断你想做什么',
    '交给任务处理',
  ]);
  assert.ok(document.querySelector('.journey'), 'the page should present one continuous journey instead of three unrelated panels');
  assert.ok(!html.includes('.journey::before'), 'a global connector line must not cross the 02 and 03 stage headers');
  assert.ok(!html.includes('.stage-marker-row::after'), 'stage labels must not draw decorative connector lines');
  assert.strictEqual(document.querySelectorAll('.journey > .stage').length, 3);
  assert.deepStrictEqual([...document.querySelectorAll('.stage-number')].map(node => node.textContent.trim()), ['01', '02', '03']);
  const continueCard = [...document.querySelectorAll('.story-item')].find(node => node.querySelector('h3')?.textContent.trim() === '确认可以继续');
  assert.strictEqual(continueCard?.querySelector('.story-dot')?.textContent.trim(), '确', 'the execution gate must use a single-character confirmation icon, not a completion checkmark');
  assert.strictEqual(document.querySelectorAll('[data-step]').length, 0, 'the page must not expose an invented numbered-step model');
  for (const retiredLayoutClass of ['.protocol', '.big-node', '.route-mainline', '.branch-card', '.choice-card']) {
    assert.strictEqual(document.querySelectorAll(retiredLayoutClass).length, 0, `the old dashboard layout must not return: ${retiredLayoutClass}`);
  }

  for (const phrase of [
    '检查并记住这次发送',
    '准备图片和文件',
    '整理消息和线索',
    '判断你的需求',
    '没判断出来',
    '出现多个可能',
    '少数新功能可能暂时接不上',
    '普通聊天：可以继续',
    '图片和文件：少数新功能可能暂时接不上',
    '判断失败时，会按普通聊天回答',
    '处理完成，结果回到会话',
  ]) assert.ok(copy.includes(phrase), `plain-language copy is missing: ${phrase}`);

  for (const technicalPhrase of [
    'dispatch_contract.v1',
    'route_intent.v1',
    'execution_resources.v1',
    'isRouteDispatchable',
    'EXECUTION_RESOURCE_PROJECTION_MISSING',
    'requestPurpose',
    'bindingEvidence',
  ]) assert.ok(!copy.includes(technicalPhrase), `technical implementation detail must not be visible: ${technicalPhrase}`);

  assert.ok(html.includes('const BASE_WIDTH=1672') && html.includes('BASE_HEIGHT=941'));
  assert.ok(html.includes('function fitPoster()') && html.includes('window.addEventListener("resize",fitPoster)'));
  assert.ok(html.includes('@media(prefers-reduced-motion:reduce)'));
  dom.window.close();
}

function testRoutePageFitsViewportAndTracksFriendlyRuntimeStages() {
  const dom = createInteractiveRoutePage();
  const { window } = dom;
  const { document } = window;
  try {
    assert.match(document.getElementById('poster').style.transform, /scale\(/, 'the fixed canvas must fit the iframe viewport');
    assert.strictEqual(document.querySelector('[data-runtime-label]').textContent, '等你发送消息');

    publishRouteState(window, {
      phase: 'routing',
      pendingStage: 'routing',
      pendingClarification: false,
      routeStage: 'routing',
      sessionId: 'session-a',
      sessionTitle: '产品图修改',
      syncSequence: 1,
    });
    assert.ok(document.querySelector('[data-live-stage="routing"]').classList.contains('is-current'));
    assert.ok(document.querySelector('[data-phase-panel="route"]').classList.contains('is-current'));
    assert.strictEqual(document.querySelector('[data-runtime-label]').textContent, '正在判断怎么处理');
    assert.strictEqual(document.querySelector('[data-runtime-session]').textContent, '产品图修改');

    publishRouteState(window, {
      phase: 'completed',
      pendingClarification: true,
      routeStage: 'clarification',
      sessionId: 'session-a',
      sessionTitle: '产品图修改',
      syncSequence: 2,
    });
    assert.ok(document.querySelector('[data-live-stage="clarification"]').classList.contains('is-current'));
    assert.strictEqual(document.querySelector('[data-runtime-label]').textContent, '需要你补充一点');

    publishRouteState(window, {
      phase: 'accepted',
      pendingClarification: false,
      routeStage: 'accepted',
      sessionId: 'session-a',
      syncSequence: 1,
    });
    assert.ok(document.querySelector('[data-live-stage="clarification"]').classList.contains('is-current'), 'older state updates must be ignored');

    publishRouteState(window, {
      phase: 'handoff',
      pendingClarification: false,
      routeStage: 'handoff',
      sessionId: 'session-a',
      syncSequence: 3,
    });
    assert.ok(document.querySelector('[data-live-stage="handoff"]').classList.contains('is-current'));
    assert.ok(document.querySelector('[data-phase-panel="execute"]').classList.contains('is-current'));

    publishRouteState(window, {
      phase: 'recovering',
      pendingClarification: false,
      routeStage: 'recovering',
      sessionId: 'session-a',
      syncSequence: 4,
    });
    assert.ok(document.querySelector('[data-live-stages~="recovering"]').classList.contains('is-current'));
    assert.ok(document.querySelector('[data-lifecycle-stage="running"]').classList.contains('current'));
    assert.strictEqual(document.querySelector('[data-runtime-label]').textContent, '正在恢复');

    publishRouteState(window, {
      phase: 'failed',
      pendingClarification: false,
      routeStage: 'failed',
      sessionId: 'session-a',
      syncSequence: 5,
    });
    assert.ok(document.querySelector('[data-lifecycle-stage="completed"]').classList.contains('error'));
    assert.strictEqual(document.querySelector('[data-runtime-label]').textContent, '这次没有完成');
  } finally {
    dom.window.close();
  }
}

module.exports = [
  testRoutePageUsesPlainLanguageForTheRealThreePartFlow,
  testRoutePageFitsViewportAndTracksFriendlyRuntimeStages,
];
