'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createBootstrapWorkflow } = require('../../client/app/bootstrap-workflow');

function createClassList() {
  const values = new Set();
  return {
    add: value => values.add(value),
    remove: value => values.delete(value),
    contains: value => values.has(value),
  };
}

function createElement() {
  return {
    dataset: {},
    classList: createClassList(),
    addEventListener() {},
    click() {},
    contains: () => false,
    focus() {},
    setAttribute() {},
  };
}

function createBootstrapDependencies() {
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, createElement());
    return elements.get(id);
  };
  const body = { classList: createClassList() };
  const timerReceivers = [];
  const browserWindow = {
    Event: class Event { constructor(type, options) { this.type = type; this.options = options; } },
    addEventListener() {},
    clearTimeout() {},
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame(callback) { callback(); },
    setTimeout(_callback, _delay) { timerReceivers.push(this); return 1; },
  };
  const asyncNoop = async () => {};
  return {
    deps: {
      $: getElement,
      addFiles: asyncNoop,
      clearAllSessions: asyncNoop,
      clearSessionImageStyleInput() {}, clearSessionPromptInput() {}, closeAllCustomSelects() {}, closeImagePreview() {}, closeReasoningMenu() {}, closeSessionDrawer() {}, closeSessionImageStylePanel() {}, closeSessionModelPanel() {}, closeSessionPromptPanel() {},
      closeConfigModal() {}, copyConfigField() {}, copyImageActionElement() {}, downloadImageActionElement() {}, enhanceConfigSelects() {}, ensureHistoryAnchorNode() {}, historyAnchorItemsFromState: () => [], isSessionBusy: () => false,
      document: { body, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], visibilityState: 'visible' },
      loadAppVersion: asyncNoop, loadConfig() {}, loadGlobalImageStyleToSessionInput() {}, loadGlobalPromptToSessionInput() {}, loadLastGeneratedImage: asyncNoop, loadModels: asyncNoop, loadReasoningPreference() {}, loadSessionSidebarCollapsed() {}, loadSessions: asyncNoop,
      markManualMessageScroll() {}, newSession() {}, onSubmit: asyncNoop, openImagePreview() {}, openConfigModal() {}, openSessionDrawer() {}, openSessionImageStylePanel() {}, openSessionModelPanel() {}, openSessionPromptPanel() {}, persistBeforePageLeave() {}, refreshActiveSessionOnReturn() {}, renderActiveSession() {}, requestAnimationFrame: callback => callback(), rerenderVisibleMarkdownMessages() {}, resumeActiveOutputFocus() {}, resumeBackgroundSessionJobs() {}, revealNodeAboveComposer() {},
      saveConfig() {}, saveSessionsMeta() {}, saveSessionImageStyle() {}, saveSessionModel() {}, saveSessionPrompt() {}, scheduleAutoResize() {}, scrollPromptByWheel() {}, scrollToBottom() {}, setReasoningMode() {}, setReasoningType() {}, setSessionSidebarCollapsed() {}, state: { activeSessionId: '', autoMode: true, reasoningMode: false }, stopActiveRun: asyncNoop, toast() {}, toggleApiKeyVisibility() {}, toggleReasoningMenu() {}, updateModeUi() {}, updateSendAvailability() {}, waitForMarkdownReady: asyncNoop, window: browserWindow,
    },
    body,
    timerReceivers,
    browserWindow,
  };
}

async function testBootstrapWorkflowUsesExplicitDependenciesAndStartsWithBrowserTimers() {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'app', 'bootstrap-workflow.js'), 'utf8');
  assert.ok(!/\bwith\s*\(/.test(source), 'bootstrap workflow should not use a dynamic with-scope');

  const { deps, body, timerReceivers, browserWindow } = createBootstrapDependencies();
  const previousApp = globalThis.ChatUIApp;
  globalThis.ChatUIApp = { appContext: { getWorkflowModule: () => null } };
  try {
    const workflow = createBootstrapWorkflow(deps);
    await workflow.start();
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    if (previousApp === undefined) delete globalThis.ChatUIApp;
    else globalThis.ChatUIApp = previousApp;
  }

  assert.ok(timerReceivers.length >= 1, 'startup should schedule its boot-release timer');
  assert.ok(timerReceivers.every(receiver => receiver === browserWindow), 'startup timers must retain the browser window receiver');
  assert.strictEqual(body.classList.contains('app-booting'), false);
}


async function testBootstrapBindsClarificationChoiceWorkflowFromModuleRegistry() {
  const { deps } = createBootstrapDependencies();
  const registrySymbol = Symbol.for('chatui.module-registry.v1');
  const previousRegistry = globalThis[registrySymbol];
  const registry = previousRegistry instanceof Map ? previousRegistry : new Map();
  const hadChoice = registry.has('clarificationChoiceWorkflow');
  const previousChoice = registry.get('clarificationChoiceWorkflow');
  const previousApp = globalThis.ChatUIApp;
  let bindCount = 0;
  let received = null;

  if (!(previousRegistry instanceof Map)) globalThis[registrySymbol] = registry;
  registry.set('clarificationChoiceWorkflow', {
    createClarificationChoiceWorkflow(options) {
      received = options;
      return { bind() { bindCount += 1; } };
    },
  });
  globalThis.ChatUIApp = { appContext: { getWorkflowModule: () => null } };

  try {
    await createBootstrapWorkflow(deps).start();
    await Promise.resolve();
  } finally {
    if (hadChoice) registry.set('clarificationChoiceWorkflow', previousChoice);
    else registry.delete('clarificationChoiceWorkflow');
    if (!(previousRegistry instanceof Map)) delete globalThis[registrySymbol];
    if (previousApp === undefined) delete globalThis.ChatUIApp;
    else globalThis.ChatUIApp = previousApp;
  }

  assert.strictEqual(bindCount, 1, 'bootstrap must bind the registry-backed clarification choice workflow');
  assert.strictEqual(received?.state, deps.state);
  assert.strictEqual(received?.document, deps.document);
  assert.strictEqual(received?.messages, deps.$('messages'));
  assert.strictEqual(received?.saveSessionsMeta, deps.saveSessionsMeta);
  assert.strictEqual(received?.onSubmit, deps.onSubmit);
  assert.strictEqual(received?.toast, deps.toast);
  assert.strictEqual(received?.openImagePreview, deps.openImagePreview);
}

module.exports = [
  testBootstrapWorkflowUsesExplicitDependenciesAndStartsWithBrowserTimers,
  testBootstrapBindsClarificationChoiceWorkflowFromModuleRegistry,
];
