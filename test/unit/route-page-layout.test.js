'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '../..');
const routePath = path.join(root, 'pages/route.html');
const filesPath = path.join(root, 'pages/files.html');

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

function testRoutePageUsesFilesStyleSerpentineRunwayForCurrentContract() {
  const html = readRoutePage();
  const filesHtml = fs.readFileSync(filesPath, 'utf8');
  const dom = new JSDOM(html);
  const { document } = dom.window;
  const nodes = [...document.querySelectorAll('.node[data-step]')];
  const copy = visibleCopy(document);

  assert.strictEqual(document.title, 'ChatUI · 一条消息是怎样被处理的');
  assert.ok(document.querySelector('.workflow'), 'the route page must use the historical runway workflow');
  assert.strictEqual(document.querySelectorAll('.journey, [data-phase-panel]').length, 0, 'the three-column explainer must not return');
  assert.strictEqual(document.querySelector('.flow-track')?.dataset.layout, 'serpentine-s');
  assert.ok(document.querySelector('.flow-runner'), 'the runway must keep its moving route runner');
  assert.ok(document.querySelector('.aurora-field'), 'the poster must keep a layered aurora backdrop');
  assert.strictEqual(document.querySelectorAll('.phase-lane').length, 3, 'each processing phase must have its own energy lane');
  assert.ok(document.querySelector('.track-energy'), 'the route must include a gradient energy rail');
  assert.ok(document.querySelector('.track-pulse'), 'the route must include a moving energy pulse');
  assert.ok(document.querySelectorAll('.runner-tail .runner-particle').length >= 5, 'the route runner must render a visible comet tail');
  assert.strictEqual(document.querySelectorAll('.flow-track marker').length, 0, 'the energy runway must not render graphical arrowheads');
  assert.strictEqual(document.querySelectorAll('.sequence-link[marker-end], .branch-track[marker-end]').length, 0, 'neither the main route nor the conditional exit may attach arrow markers');
  assert.ok(html.includes('.sequence-link { stroke: transparent;'), 'semantic sequence links must not paint a second solid rail over the runway');
  assert.ok(!html.includes('route-arrow') && !html.includes('branch-arrow'), 'retired arrow styling must not remain in the page');
  assert.ok(nodes.every(node => node.querySelector('.node-hud-corners')), 'every route card must keep HUD corner details');
  assert.ok(nodes.every(node => node.querySelector('.node-energy-scan')), 'every route card must keep its scanning highlight layer');
  assert.deepStrictEqual(nodes.map(node => node.dataset.step), [
    '01', '02', '03', '04', '05', '06', '07', '08', '09', '10',
  ]);
  assert.deepStrictEqual(nodes.map(node => node.dataset.row), [
    '1', '1', '1', '2', '2', '2', '3', '3', '3', '3',
  ]);
  assert.deepStrictEqual(nodes.map(node => node.querySelector('.node-title')?.textContent.trim()), [
    '确认本轮可以开始',
    '建立本轮身份与恢复状态',
    '捕获资源并写入会话',
    '构造路由上下文与候选',
    '意图模型裁决六项语义',
    '本地映射、验证并编译',
    '选择单任务或多图规划',
    '服务端复核并创建任务',
    '执行、轮询、停止与恢复',
    '持久化并提交最终结果',
  ]);

  const links = [...document.querySelectorAll('.sequence-link')].map(link => `${link.dataset.from}->${link.dataset.to}`);
  assert.deepStrictEqual(links, [
    '01->02', '02->03', '03->04', '04->05', '05->06',
    '06->07', '07->08', '08->09', '09->10',
  ]);
  const rows = [...document.querySelectorAll('.node-row')];
  assert.deepStrictEqual(rows.map(row => row.dataset.visualOrder), ['01 02 03', '06 05 04', '07 08 09 10']);
  assert.strictEqual(rows[1]?.dataset.rowLayout, 'reverse');
  assert.deepStrictEqual([...rows[1].querySelectorAll('.node')].map(node => node.dataset.step), ['04', '05', '06']);
  assert.strictEqual(document.querySelectorAll('.phase-card').length, 3);
  assert.deepStrictEqual([...document.querySelectorAll('.phase-name')].map(node => node.textContent.trim()), ['接收保存', '语义裁决', '计划执行']);

  const guide = document.getElementById('mainRouteGuide');
  assert.strictEqual(guide?.dataset.sequence, '01 02 03 04 05 06 07 08 09 10');
  assert.match(guide?.getAttribute('d') || '', /Q1658 138 1658 166V325Q1658 353 1630 353H80Q58 353 58 375V546Q58 568 80 568/);
  assert.strictEqual(document.querySelector('.clarification-track')?.dataset.branchFrom, '06');
  assert.strictEqual(document.querySelector('.clarification-exit')?.hasAttribute('data-step'), false);
  assert.ok(copy.includes('01 → 10') && !copy.includes('01 → 12'), 'the runway count must come from the current pipeline, not the retired twelve-node poster');

  for (const phrase of [
    '当前会话正忙、内容为空或过长、附件尚未就绪时，不会启动新任务',
    '当前附件、显式引用、历史消息与资源、上次执行资源和会话焦点',
    '操作、前后关系、完整目标、任务继承方式、资源角色和单/多任务形态',
    '不再用关键词或本地猜测覆盖模型语义',
    '模型全部失败就停止，绝不改成普通聊天',
    '多图规划最多生成 5 个独立图片任务',
    '服务端再次校验身份、任务归属、参数和执行约束',
    '规范消息 + 图片持久化 + 界面投影',
    '聊天 / 联网搜索 / 文件与图文问答',
    '单图生成 / 图片编辑',
    '多图规划 / 批量执行',
  ]) assert.ok(copy.includes(phrase), `current runway copy is missing: ${phrase}`);

  for (const stalePhrase of [
    '模型只判断意图和候选',
    '模型只给出处理方向和候选',
    '你点名的序号或文件名优先',
    '判断失败时，会按普通聊天回答',
    '少数新功能可能暂时接不上',
  ]) assert.ok(!copy.includes(stalePhrase), `stale route claim must not return: ${stalePhrase}`);

  for (const technicalPhrase of [
    'dispatch_contract.v1',
    'route_intent.v1',
    'route_intent.v2',
    'route_intent.v3',
    'image_plan.v1',
    '/api/image-batches',
    'candidate_key',
    'principal',
    'isRouteDispatchable',
    'EXECUTION_RESOURCE_PROJECTION_MISSING',
  ]) assert.ok(!copy.includes(technicalPhrase), `technical implementation detail must not be visible: ${technicalPhrase}`);

  const palette = ['white', 'muted', 'blue', 'cyan', 'green', 'red', 'orange', 'purple'];
  for (const name of palette) {
    const match = filesHtml.match(new RegExp(`--${name}:\\s*([^;]+);`));
    assert.ok(match, `files.html must define --${name}`);
    assert.ok(html.includes(`--${name}: ${match[1].trim()};`), `route.html must reuse files.html --${name}`);
  }
  assert.ok(html.includes('linear-gradient(180deg, #02050b 0%, #020817 47%, #020c20 100%)'));
  assert.ok(html.includes('text-rendering: geometricPrecision'));
  assert.ok(html.includes('const BASE_WIDTH = 1672') && html.includes('const BASE_HEIGHT = 941'));
  assert.ok(html.includes('function fitPoster()') && html.includes('window.addEventListener("resize", fitPoster)'));
  assert.ok(html.includes('@keyframes aurora-drift'));
  assert.ok(html.includes('@keyframes energy-flow'));
  assert.ok(html.includes('@keyframes runner-tail-pulse'));
  assert.ok(html.includes('@keyframes node-scan'));
  assert.ok(html.includes('@media (prefers-reduced-motion: reduce)'));
  assert.ok(html.includes('.track-energy, .track-pulse, .runner-particle, .node-energy-scan, .aurora-orb'), 'reduced-motion mode must disable every new ambient animation');
  dom.window.close();
}

function testRouteRunwayFitsViewportAndTracksFriendlyRuntimeStages() {
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
    assert.ok(document.querySelector('.node[data-step="05"]').classList.contains('is-current'));
    assert.ok(document.querySelector('.phase-card.route').classList.contains('is-current'));
    assert.strictEqual(document.querySelector('[data-runtime-label]').textContent, '正在进行意图裁决');
    assert.strictEqual(document.querySelector('[data-runtime-session]').textContent, '会话 · 产品图修改');

    publishRouteState(window, {
      phase: 'completed',
      pendingClarification: true,
      routeStage: 'clarification',
      sessionId: 'session-a',
      sessionTitle: '产品图修改',
      syncSequence: 2,
    });
    assert.ok(document.querySelector('.node[data-step="06"]').classList.contains('is-current'));
    assert.ok(document.querySelector('.clarification-exit').classList.contains('is-current'));
    assert.strictEqual(document.querySelector('[data-runtime-label]').textContent, '需要你补充一点');

    publishRouteState(window, {
      phase: 'accepted',
      pendingClarification: false,
      routeStage: 'accepted',
      sessionId: 'session-a',
      syncSequence: 1,
    });
    assert.ok(document.querySelector('.node[data-step="06"]').classList.contains('is-current'), 'older state updates must be ignored');

    publishRouteState(window, {
      phase: 'handoff',
      pendingClarification: false,
      routeStage: 'handoff',
      sessionId: 'session-a',
      syncSequence: 3,
    });
    assert.ok(document.querySelector('.node[data-step="08"]').classList.contains('is-current'));
    assert.ok(document.querySelector('.phase-card.execute').classList.contains('is-current'));

    publishRouteState(window, {
      phase: 'recovering',
      pendingClarification: false,
      routeStage: 'recovering',
      sessionId: 'session-a',
      syncSequence: 4,
    });
    assert.ok(document.querySelector('.node[data-step="09"]').classList.contains('is-current'));
    assert.ok(document.querySelector('[data-lifecycle-stage="running"]').classList.contains('current'));
    assert.strictEqual(document.querySelector('[data-runtime-label]').textContent, '正在恢复任务');

    publishRouteState(window, {
      phase: 'failed',
      pendingClarification: false,
      routeStage: 'failed',
      sessionId: 'session-a',
      syncSequence: 5,
    });
    assert.ok(document.querySelector('.node[data-step="10"]').classList.contains('is-error-current'));
    assert.ok(document.querySelector('[data-lifecycle-stage="completed"]').classList.contains('error'));
    assert.strictEqual(document.querySelector('[data-runtime-label]').textContent, '这次任务没有完成');
  } finally {
    dom.window.close();
  }
}

module.exports = [
  testRoutePageUsesFilesStyleSerpentineRunwayForCurrentContract,
  testRouteRunwayFitsViewportAndTracksFriendlyRuntimeStages,
];
