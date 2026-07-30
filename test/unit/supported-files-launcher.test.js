'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const routeDiagramWorkflow = require('../../client/app/route-diagram-workflow');
const staticHttp = require('../../server/http/static');

function createLauncherDom() {
  return new JSDOM(`<!doctype html><body>
    <button id="supportedFilesFab" aria-expanded="false"></button>
    <button id="routeDiagramFab" aria-expanded="false"></button>
    <div id="routeDiagramModal" aria-hidden="true">
      <button id="closeRouteDiagramBtn" data-route-diagram-close></button>
      <section class="route-diagram-dialog"></section>
      <iframe id="routeDiagramFrame"></iframe>
    </div>
  </body>`, { url: 'http://localhost/' });
}

function testSupportedFilesLauncherReusesDocumentModalLifecycle() {
  const dom = createLauncherDom();
  const { document } = dom.window;
  const filesTrigger = document.getElementById('supportedFilesFab');
  const routeTrigger = document.getElementById('routeDiagramFab');
  const modal = document.getElementById('routeDiagramModal');
  const frame = document.getElementById('routeDiagramFrame');
  const controller = routeDiagramWorkflow.createRouteDiagramWorkflow({ document });
  assert.strictEqual(routeDiagramWorkflow.createRouteDiagramWorkflow, routeDiagramWorkflow.createPageViewerWorkflow, 'both launchers must use the same generic page-viewer controller');
  controller.init();

  filesTrigger.focus();
  filesTrigger.click();
  assert.strictEqual(controller.isOpen(), true);
  assert.strictEqual(modal.getAttribute('aria-hidden'), 'false');
  assert.strictEqual(filesTrigger.getAttribute('aria-expanded'), 'true');
  assert.strictEqual(routeTrigger.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(frame.getAttribute('src'), './pages/files.html?v=1.0.0-aligned-layout');
  assert.strictEqual(frame.getAttribute('title'), '支持的文件格式');
  assert.strictEqual(document.querySelector('.route-diagram-dialog').style.getPropertyValue('--page-viewer-aspect'), '1536 / 1024');

  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.strictEqual(controller.isOpen(), false);
  assert.strictEqual(filesTrigger.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(document.activeElement, filesTrigger);

  routeTrigger.click();
  assert.strictEqual(frame.getAttribute('src'), './pages/route.html?v=1.3.2-stage3-centered');
  assert.strictEqual(frame.getAttribute('title'), '任务路由执行地图');
  assert.strictEqual(document.querySelector('.route-diagram-dialog').style.getPropertyValue('--page-viewer-aspect'), '1672 / 941');
  assert.strictEqual(document.querySelector('.route-diagram-dialog').style.getPropertyValue('--page-viewer-max-width'), '1672px');
  assert.strictEqual(routeTrigger.getAttribute('aria-expanded'), 'true');
  assert.ok(modal.classList.contains('show'), 'the route page must use the same headerless viewer');
}

function testSupportedFilesLauncherShipsItsStaticPage() {
  const root = path.resolve(__dirname, '../..');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'styles/flat-theme.css'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

  assert.ok(index.indexOf('id="supportedFilesFab"') < index.indexOf('id="routeDiagramFab"'), 'the supported-files button must sit before the route-map button');
  assert.ok(index.includes('aria-controls="routeDiagramModal"'), 'both launchers must share the existing document modal');
  assert.ok(index.includes('id="filesFabGradient"') && index.includes('class="fab-files-spark"'), 'the files launcher must use the layered neon file icon');
  assert.ok(index.includes('id="routeFabGradient"') && index.includes('class="fab-route-comet"'), 'the route launcher must use the animated neon route icon');
  assert.ok(!index.includes('id="routeDiagramTitle"') && !index.includes('id="routeDiagramHint"'), 'the shared viewer must not render a title or description bar');
  assert.ok(css.includes('.supported-files-fab{right:74px!important}'));
  assert.ok(css.includes('@keyframes route-fab-comet'));
  assert.ok(css.includes('@media (prefers-reduced-motion:reduce)'));
  assert.ok(css.includes('.route-diagram-head{position:absolute!important'));
  assert.ok(css.includes('border:0!important;border-radius:0!important;background:transparent!important;box-shadow:none!important'));
  assert.ok(css.includes('width:min(var(--page-viewer-max-width,1536px),100%)!important'));
  assert.ok(css.includes('aspect-ratio:var(--page-viewer-aspect,1536 / 1024)!important'));
  assert.strictEqual(staticHttp.isPublicStaticPath('/pages/files.html'), true);
  assert.strictEqual(staticHttp.isPublicStaticPath('/pages/route.html'), true);
  assert.strictEqual(staticHttp.isPublicStaticPath('/files.html'), false, 'the retired root page path must not remain public');
  assert.strictEqual(staticHttp.isPublicStaticPath('/route.html'), false, 'the retired root route path must not remain public');
  assert.ok(dockerfile.includes('COPY pages ./pages'), 'the Docker runtime must package the shared standalone-page directory');
  assert.ok(fs.readFileSync(path.join(root, 'pages/files.html'), 'utf8').includes('<title>支持的文件格式</title>'));
  assert.ok(fs.readFileSync(path.join(root, 'pages/route.html'), 'utf8').includes('12节点执行地图'));
}

module.exports = [testSupportedFilesLauncherReusesDocumentModalLifecycle, testSupportedFilesLauncherShipsItsStaticPage];
