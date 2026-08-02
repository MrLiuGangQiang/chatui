'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function diagramDocument() {
  return new JSDOM(read('pages/route.html')).window.document;
}

function interactiveDiagram() {
  return new JSDOM(read('pages/route.html'), {
    runScripts: 'dangerously',
    url: 'https://chatui.test/pages/route.html',
  });
}

function publishRouteState(window, detail) {
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'chatui:route-task-state', ...detail },
    origin: window.location.origin,
    source: window.parent,
  }));
}

function cardText(document, step) {
  const card = document.querySelector(`.node[data-step="${step}"]`);
  assert.ok(card, `route diagram step ${step} must exist`);
  return card.textContent.replace(/\s+/g, ' ').trim();
}

function assertSourceOrder(source, tokens, label) {
  let cursor = -1;
  for (const token of tokens) {
    const next = source.indexOf(token, cursor + 1);
    assert.ok(next > cursor, `${label} must place ${token} after the previous source operation`);
    cursor = next;
  }
}

function testRouteDiagramDocumentsCanonicalIntentChain() {
  const html = read('pages/route.html');
  const document = diagramDocument();
  const nodes = [...document.querySelectorAll('.node[data-step]')];
  const steps = nodes.map(node => node.dataset.step);
  const rows = nodes.map(node => node.dataset.row);
  const titles = nodes.map(node => node.querySelector('.node-title')?.textContent.trim());
  const links = [...document.querySelectorAll('.sequence-link')].map(link => `${link.dataset.from}->${link.dataset.to}`);

  assert.deepStrictEqual(steps, ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']);
  assert.deepStrictEqual(rows, ['1', '1', '1', '1', '2', '2', '2', '2', '3', '3', '3', '3']);
  assert.deepStrictEqual(titles, [
    '先确认能不能发送',
    '先保存这次内容',
    '把附件和消息放在一起',
    '确认基本内容没问题',
    '看看是不是接着刚才的问题',
    '把相关资料找齐',
    '弄清楚你想做什么',
    '看看有没有理解错',
    '不清楚时再想一遍',
    '决定先问你，还是直接做',
    '备齐要用的内容',
    '正式开始处理任务',
  ]);
  assert.deepStrictEqual(links, [
    '01->02', '02->03', '03->04', '04->05',
    '05->06', '06->07', '07->08', '08->09',
    '09->10', '10->11', '11->12',
  ]);
  assert.strictEqual(document.querySelectorAll('.phase-card').length, 3);
  assert.deepStrictEqual([...document.querySelectorAll('.phase-index')].map(item => item.textContent.trim()), ['一', '二', '三']);
  const rowLayouts = [...document.querySelectorAll('.node-row')];
  assert.deepStrictEqual(rowLayouts.map(row => row.dataset.visualOrder), ['01 02 03 04', '08 07 06 05', '09 10 11 12']);
  assert.strictEqual(rowLayouts[1]?.dataset.rowLayout, 'reverse');
  assert.deepStrictEqual([...rowLayouts[1].querySelectorAll('.node')].map(node => node.dataset.step), ['05', '06', '07', '08'], 'logical source order must remain accessible while CSS reverses the middle row');
  const guide = document.getElementById('mainRouteGuide');
  assert.strictEqual(guide?.dataset.sequence, '01 02 03 04 05 06 07 08 09 10 11 12');
  assert.strictEqual(document.querySelector('.flow-track')?.dataset.layout, 'serpentine-s');
  assert.match(guide?.getAttribute('d') || '', /Q1658 138 1658 166V325Q1658 353 1630 353H80Q58 353 58 375V546Q58 568 80 568/, 'the runway must be one rounded S-shaped path');
  assert.strictEqual(document.querySelector('.clarification-track')?.dataset.branchFrom, '10');
  assert.strictEqual(document.querySelector('.clarification-exit')?.hasAttribute('data-step'), false, 'clarification must be an unnumbered side exit');

  assert.ok(cardText(document, '01').includes('已有任务 → 先等一等') && cardText(document, '01').includes('先停一下，不开新任务'));
  assert.ok(cardText(document, '02').includes('保存好 → 再继续') && cardText(document, '02').includes('刷新后也能接着处理'));
  assert.ok(cardText(document, '03').includes('文字 + 附件 → 放在一起') && cardText(document, '03').includes('继续往下'));
  assert.ok(cardText(document, '04').includes('附件 · 文字 · 设置') && cardText(document, '04').includes('有问题 → 告诉你'));
  assert.ok(cardText(document, '05').includes('接着上一次 / 新请求') && cardText(document, '05').includes('接着刚才'));
  assert.ok(cardText(document, '06').includes('这次内容 + 相关资料') && cardText(document, '06').includes('资料齐了'));
  assert.ok(cardText(document, '07').includes('理解你的需求') && cardText(document, '07').includes('明确要做什么'));
  assert.ok(cardText(document, '08').includes('整理成清楚的做法') && cardText(document, '08').includes('确认清楚了吗？'));
  assert.ok(cardText(document, '09').includes('先重新整理 → 再换方式') && cardText(document, '09').includes('再试一次'));
  assert.ok(cardText(document, '10').includes('还不清楚') && cardText(document, '10').includes('已清楚'));
  assert.ok(cardText(document, '11').includes('图片、文件、前面内容') && cardText(document, '11').includes('准备好了'));
  assert.ok(cardText(document, '12').includes('开始处理 → 进行中') && cardText(document, '12').includes('收到结果 → 已完成'));
  assert.ok(html.includes('title="pending_continuation.v6"') && html.includes('title="route_decision.v1"') && html.includes('title="JOB_COMPLETED_COMMITTED"'));

  for (const node of nodes) {
    const summary = node.querySelector('.node-summary')?.textContent.trim() || '';
    assert.ok(summary.length <= 78, `step ${node.dataset.step} summary should remain concise`);
  }
  assert.ok(html.includes('按顺序看') && html.includes('下一步：04 → 05') && html.includes('下一步：08 → 09'));
  assert.ok(html.includes('.node-row.reverse { direction: rtl; }') && html.includes('class="sequence-link row-wrap"') && html.includes('Q1658 138') && html.includes('Q58 353'));
  assert.ok(html.includes('.node.is-current') && html.includes('aria-current') && html.includes('data-runtime-session'));
  assert.ok(html.includes('先问你，记住当前进度，补充后再继续。') && html.includes('进行中不等于完成'));
  const visibleCopy = document.getElementById('poster')?.textContent.replace(/\s+/g, ' ') || '';
  for (const technicalTerm of ['模型', '备用模型', '上下文', '路由中', '交接中', '捕获', '持久化', '执行门禁']) {
    assert.ok(!visibleCopy.includes(technicalTerm), `visible route copy should explain ${technicalTerm} in plain language`);
  }
  assert.ok(visibleCopy.includes('你的消息怎样变成任务') && visibleCopy.includes('先收到你的消息，再理解你的需求，最后开始处理。'));
  assert.ok(!html.includes('deliberately bypassed') && !html.includes('05 and 11 are deliberately bypassed'));
  assert.ok(!/\.node\[data-step=[^\]]+\]\s*\{[^}]*grid-column/.test(html), 'numbered nodes must not be visually reordered by per-step CSS');
}

function testRouteDiagramHighlightsOnlyLatestSessionProgress() {
  const dom = interactiveDiagram();
  const { window } = dom;
  const { document } = window;
  try {
    publishRouteState(window, {
      syncSequence: 1,
      sessionId: 'session-a',
      sessionTitle: '会话 A',
      phase: 'running',
      activeStep: '12',
    });
    assert.ok(document.querySelector('.node[data-step="12"]')?.classList.contains('is-current'));
    assert.strictEqual(document.querySelector('.node[data-step="12"]')?.getAttribute('aria-current'), 'step');
    assert.ok(document.querySelector('.phase-card.execute')?.classList.contains('is-current'));
    assert.strictEqual(document.querySelector('[data-runtime-state]')?.dataset.sessionId, 'session-a');
    assert.match(document.querySelector('[data-runtime-session]')?.textContent || '', /会话 A/);

    publishRouteState(window, {
      syncSequence: 2,
      sessionId: 'session-b',
      sessionTitle: '会话 B',
      phase: 'routing',
      activeStep: '07',
    });
    assert.ok(document.querySelector('.node[data-step="07"]')?.classList.contains('is-current'));
    assert.ok(!document.querySelector('.node[data-step="12"]')?.classList.contains('is-current'), 'switching sessions must clear the previous session highlight');
    assert.ok(document.querySelector('.phase-card.route')?.classList.contains('is-current'));
    assert.strictEqual(document.getElementById('poster')?.dataset.sessionId, 'session-b');
    assert.match(document.querySelector('[data-runtime-session]')?.textContent || '', /会话 B/);

    publishRouteState(window, {
      syncSequence: 1,
      sessionId: 'session-a',
      sessionTitle: '过期会话 A',
      phase: 'running',
      activeStep: '12',
    });
    assert.strictEqual(document.getElementById('poster')?.dataset.sessionId, 'session-b', 'an older queued update must not overwrite the active session');
    assert.ok(document.querySelector('.node[data-step="07"]')?.classList.contains('is-current'));

    publishRouteState(window, {
      syncSequence: 3,
      sessionId: 'session-b',
      sessionTitle: '会话 B',
      phase: 'completed',
      activeStep: '12',
      pendingClarification: true,
    });
    assert.ok(document.querySelector('.node[data-step="10"]')?.classList.contains('is-current'), 'a preserved clarification must highlight its branch point');
    assert.ok(document.querySelector('.clarification-exit')?.classList.contains('is-current'));
    assert.strictEqual(document.querySelector('[data-runtime-state]')?.dataset.phase, 'clarifying');
    assert.strictEqual(document.querySelector('[data-runtime-label]')?.textContent, '等待你补充');

    publishRouteState(window, {
      syncSequence: 4,
      sessionId: 'session-c',
      sessionTitle: '会话 C',
      phase: 'idle',
      activeStep: '',
    });
    assert.strictEqual(document.querySelectorAll('.node.is-current').length, 0, 'an idle session must not inherit another session task highlight');
    assert.strictEqual(document.querySelectorAll('.phase-card.is-current').length, 0);
    assert.ok(!document.querySelector('.clarification-exit')?.classList.contains('is-current'));
  } finally {
    window.close();
  }
}

function testRouteDiagramClaimsStayAnchoredToRuntimeSource() {
  const routeService = read('client/services/route-service.js');
  const routeWorkflow = read('client/app/route-decision-workflow.js');
  const clarificationService = read('client/services/clarification-service.js');
  const submitWorkflow = read('client/app/submit-workflow.js');
  const taskState = read('client/core/task-state.js');
  const taskLifecycle = read('client/app/task-lifecycle.js');

  assertSourceOrder(submitWorkflow, [
    'stage:"accepted"',
    'taskEvents.TASK_ACCEPTED',
    'taskEvents.ATTACHMENT_CAPTURE_STARTED',
    'stage:"captured"',
    'taskEvents.ATTACHMENT_CAPTURED',
    'stage:"routing"',
    'taskEvents.ROUTING_STARTED',
    'const rawStoredPending=',
    'buildContinuationClassifierPayload',
    'getEffectiveRouteWithSlowNotice',
    'if(routeInfo.needClarification)',
    'isRouteDispatchable?.(routeInfo)',
    'buildExecutionResourcePools',
    'stage:"handoff"',
    'taskEvents.HANDOFF_PREPARED',
  ], 'submit workflow');

  const effectiveRoute = routeWorkflow.slice(routeWorkflow.indexOf('async function getEffectiveRoute'));
  assertSourceOrder(effectiveRoute, [
    'loadPublicContext?.()',
    'buildRouteAttachmentMetadata(attachments)',
    'routeSvc.buildRoutePayload',
    'requestRouteDecision(firstPayload',
    'parseOrRepairRoute(routeSvc',
    'sessionChatModel !== primaryModel',
    'routeSvc.buildRoutePayload({ model: sessionChatModel',
    'requestRouteDecision(fallbackPayload',
    'parseOrRepairRoute(routeSvc',
  ], 'effective route workflow');

  const repairRoute = routeWorkflow.slice(routeWorkflow.indexOf('async function parseOrRepairRoute'), routeWorkflow.indexOf('function createRouteCancelledError'));
  assertSourceOrder(repairRoute, [
    'const initial = inspectRoute',
    'buildIntentRepairPayload',
    'requestRouteDecision(repairPayload',
    'const repaired = inspectRoute',
    'repairPreservesInvariants',
  ], 'route repair workflow');

  const inspectDecision = routeService.slice(routeService.indexOf('function inspectRouteDecision'), routeService.indexOf('function declaredClarificationQuestion'));
  assertSourceOrder(inspectDecision, [
    'compileRouteDecision(decision, options)',
    'inspectTaskContract(taskContract, options)',
  ], 'route decision inspection');
  const inspectContract = routeService.slice(routeService.indexOf('function inspectTaskContract'), routeService.indexOf('function inspectRouteDecision'));
  assert.ok(inspectContract.includes('taskContractToExecutionPlan'));

  assert.ok(routeService.includes("const ROUTE_DECISION_VERSION = 'route_decision.v1'"));
  assert.ok(routeService.includes("schema_version: 'task_contract.v5'"));
  assert.ok(routeService.includes("const EXECUTION_RESOURCES_VERSION = 'execution_resources.v1'"));
  assert.ok(routeWorkflow.includes("response_format: { type: 'json_object' }") && routeWorkflow.includes('sessionChatModel !== primaryModel'));
  assert.ok(clarificationService.includes("const CONTINUATION_SCHEMA_VERSION = 'pending_continuation.v6'"));
  assert.ok(submitWorkflow.includes('const INTENT_PIPELINE_DEADLINE_MS = 60000'));
  assert.ok(taskState.includes("RUNNING: 'running'") && taskState.includes('JOB_COMPLETED_COMMITTED'));
  assert.ok(taskLifecycle.includes('TASK_EVENTS?.JOB_COMPLETED_COMMITTED'));
}

function testRouteDiagramUsesSupportedFilesColorStandard() {
  const route = read('pages/route.html');
  const files = read('pages/files.html');
  const palette = {
    white: '#f5f7ff',
    muted: '#e4e9f3',
    blue: '#00aaff',
    cyan: '#65dcff',
    green: '#10ed8b',
    red: '#ff3137',
    orange: '#ff8a09',
    purple: '#b265ff',
  };

  for (const [name, value] of Object.entries(palette)) {
    const declaration = `--${name}: ${value};`;
    assert.ok(files.includes(declaration), `files.html must define ${declaration}`);
    assert.ok(route.includes(declaration), `route.html must reuse ${declaration}`);
  }

  assert.ok(route.includes('width: 1672px;') && route.includes('height: 941px;'));
  assert.ok(route.includes('const BASE_WIDTH = 1672;') && route.includes('const BASE_HEIGHT = 941;'));
  assert.ok(route.includes('grid-template-columns: repeat(4, 350px);') && route.includes('grid-template-rows: repeat(3, 172px);'));
  assert.ok(route.includes('text-rendering: optimizeLegibility;') && route.includes('font-size: 20px;') && route.includes('font-size: 13px;') && route.includes('font-size: 12px;'));
  assert.ok(route.includes('class="flow-track"') && route.includes('class="flow-runner"') && route.includes('<animateMotion'));
  assert.ok(route.includes('id="mainRouteGuide"') && route.includes('class="sequence-link row-wrap"'));
  assert.ok(route.includes('@media (prefers-reduced-motion: reduce)'));
  assert.ok(route.includes('linear-gradient(180deg, #02050b 0%, #020817 47%, #020c20 100%)'));
}

module.exports = [
  testRouteDiagramDocumentsCanonicalIntentChain,
  testRouteDiagramHighlightsOnlyLatestSessionProgress,
  testRouteDiagramClaimsStayAnchoredToRuntimeSource,
  testRouteDiagramUsesSupportedFilesColorStandard,
];
