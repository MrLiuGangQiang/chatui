'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const staticHttp = require('../../server/http/static');
const appContext = require('../../client/app/app-context');
const historyAnchorNav = require('../../client/features/history-anchor-nav');
const webPreview = require('../../client/ui/web-preview');
const messageModel = require('../../client/features/messages/message-model');
const messageDomain = require('../../client/features/messages/message-domain');
const quotePreview = require('../../client/features/messages/quote-preview');
const markdownLiveStream = require('../../client/features/messages/markdown-live-stream');
const markdownPreview = require('../../client/features/messages/markdown-preview');
const markdownFinalRenderer = require('../../client/features/messages/markdown-final-renderer');

function testWorkflowRegistryLazilyCreatesOneExplicitDependency() {
  let calls = 0;
  const registry = appContext.createWorkflowRegistry({
    sample: () => ({ instance: ++calls }),
  });

  assert.strictEqual(registry.has('sample'), true);
  assert.strictEqual(registry.has('missing'), false);
  assert.strictEqual(registry.get('sample'), registry.get('sample'));
  assert.strictEqual(calls, 1);
  assert.throws(() => registry.get('missing'), /not registered/);
}

function testHistoryAnchorNavigationUsesApplicationRegistryInsteadOfBrowserGlobal() {
  assert.strictEqual(appContext.getWorkflowModule('historyAnchorNav'), historyAnchorNav);
  assert.strictEqual(globalThis.ChatUIHistoryAnchorNav, undefined);
}

function testWebPreviewUsesApplicationRegistryInsteadOfBrowserGlobal() {
  assert.strictEqual(appContext.getWorkflowModule('webPreview'), webPreview);
  assert.strictEqual(globalThis.ChatUIWebPreview, undefined);
}

function testMessageFeaturesUseApplicationRegistryInsteadOfBrowserGlobals() {
  const features = [
    ['messageModel', messageModel, 'ChatUIFeaturesMessagesModel'],
    ['messageDomain', messageDomain, 'ChatUIFeaturesMessagesDomain'],
    ['quotePreview', quotePreview, 'ChatUIFeaturesMessagesQuotePreview'],
    ['markdownLiveStream', markdownLiveStream, 'ChatUIFeaturesMessagesMarkdownLiveStream'],
    ['markdownPreview', markdownPreview, 'ChatUIFeaturesMessagesMarkdownPreview'],
    ['markdownFinalRenderer', markdownFinalRenderer, 'ChatUIFeaturesMessagesMarkdownFinalRenderer'],
  ];
  for (const [name, feature, globalName] of features) {
    assert.strictEqual(appContext.getWorkflowModule(name), feature);
    assert.strictEqual(globalThis[globalName], undefined);
  }

  const index = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  const appContextOffset = index.indexOf('client/app/app-context.js');
  for (const name of ['message-model.js', 'message-domain.js', 'quote-preview.js', 'markdown-live-stream.js', 'markdown-preview.js', 'markdown-final-renderer.js']) {
    assert.ok(appContextOffset < index.indexOf(`client/features/messages/${name}`), `${name} must load after the application registry`);
  }
}


function testRetiredRouteIntroductionLeavesNoRuntimeOrStaticSurface() {
  const root = path.join(__dirname, '..', '..');
  const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
  for (const relativePath of [
    'client/app/route-diagram-workflow.js',
    'pages',
    'pages/route.html',
    'pages/files.html',
  ]) {
    assert.strictEqual(fs.existsSync(path.join(root, relativePath)), false, `${relativePath} must be removed`);
  }

  const index = read('index.html');
  for (const marker of [
    'id="supportedFilesFab"',
    'id="routeDiagramFab"',
    'id="routeDiagramModal"',
    'id="routeDiagramFrame"',
    'route-diagram-workflow.js',
    './pages/route.html',
    './pages/files.html',
  ]) {
    assert.ok(!index.includes(marker), `index.html must not retain ${marker}`);
  }

  for (const asset of ['styles.css', 'styles/flat-theme.css', 'styles/calm-theme.css']) {
    const css = read(asset);
    assert.ok(!/route-diagram|routeDiagram|supported-files-fab|supportedFilesFab|route-map-fab|fab-files|fab-route|page-viewer/.test(css), `${asset} must not retain retired route-introduction styles`);
  }

  assert.ok(!read('app.js').includes('empty-route-diagram'), 'root cleanup must not retain a removed route-introduction selector');
  assert.strictEqual(staticHttp.isPublicStaticPath('/pages/route.html'), false, 'retired route page must not remain publicly served');
  assert.strictEqual(staticHttp.isPublicStaticPath('/pages/files.html'), false, 'retired files page must not remain publicly served');
  assert.ok(!read('server/http/static.js').includes("'/pages/'"), 'static server must not retain the retired pages prefix');
  assert.ok(!read('Dockerfile').includes('COPY pages'), 'Docker image must not package the retired pages directory');
  assert.ok(!read('scripts/check-project.js').includes('pages/route.html'), 'project checks must not require retired pages');
  assert.ok(!/'pages'/.test(read('server/build-identity.js')), 'runtime identity must not hash the retired pages directory');
  assert.ok(index.includes('./client/app/route-intent-workflow.js'), 'real route intent workflow must remain bundled');
  assert.ok(index.includes('./client/services/route-service.js'), 'real route service must remain bundled');
}

module.exports = [
  testWorkflowRegistryLazilyCreatesOneExplicitDependency,
  testHistoryAnchorNavigationUsesApplicationRegistryInsteadOfBrowserGlobal,
  testWebPreviewUsesApplicationRegistryInsteadOfBrowserGlobal,
  testMessageFeaturesUseApplicationRegistryInsteadOfBrowserGlobals,
  testRetiredRouteIntroductionLeavesNoRuntimeOrStaticSurface,
];
