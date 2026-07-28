'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const appContext = require('../../client/app/app-context');
const historyAnchorNav = require('../../client/features/history-anchor-nav');
const webPreview = require('../../client/ui/web-preview');
const messageModel = require('../../client/features/messages/message-model');
const messageDomain = require('../../client/features/messages/message-domain');
const quotePreview = require('../../client/features/messages/quote-preview');
const markdownLiveStream = require('../../client/features/messages/markdown-live-stream');
const markdownPreview = require('../../client/features/messages/markdown-preview');
const markdownFinalRenderer = require('../../client/features/messages/markdown-final-renderer');
const routeDiagram = require('../../client/app/route-diagram-workflow');

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

function testRouteDiagramUsesApplicationRegistryInsteadOfBrowserGlobal() {
  assert.strictEqual(appContext.getWorkflowModule('routeDiagram'), routeDiagram);
  assert.strictEqual(globalThis.ChatUIRouteDiagramWorkflow, undefined);
}

module.exports = [
  testWorkflowRegistryLazilyCreatesOneExplicitDependency,
  testHistoryAnchorNavigationUsesApplicationRegistryInsteadOfBrowserGlobal,
  testWebPreviewUsesApplicationRegistryInsteadOfBrowserGlobal,
  testMessageFeaturesUseApplicationRegistryInsteadOfBrowserGlobals,
  testRouteDiagramUsesApplicationRegistryInsteadOfBrowserGlobal,
];
