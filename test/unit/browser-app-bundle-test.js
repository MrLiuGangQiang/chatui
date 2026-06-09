#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const statePath = path.join(root, 'client/app/state.js');
const sessionsPath = path.join(root, 'client/app/sessions.js');
const sessionConfigPath = path.join(root, 'client/app/session-config.js');
const formattingPath = path.join(root, 'client/app/formatting.js');
const markdownUtilsPath = path.join(root, 'client/app/markdown-utils.js');
const displayItemsPath = path.join(root, 'client/app/display-items.js');
const persistencePath = path.join(root, 'client/app/persistence.js');
const runsPath = path.join(root, 'client/app/runs.js');
const browserAppPath = path.join(root, 'client/app/browser.js');
const stateModule = fs.readFileSync(statePath, 'utf8');
const sessionsModule = fs.readFileSync(sessionsPath, 'utf8');
const sessionConfig = fs.readFileSync(sessionConfigPath, 'utf8');
const formatting = fs.readFileSync(formattingPath, 'utf8');
const markdownUtils = fs.readFileSync(markdownUtilsPath, 'utf8');
const displayItems = fs.readFileSync(displayItemsPath, 'utf8');
const persistence = fs.readFileSync(persistencePath, 'utf8');
const runs = fs.readFileSync(runsPath, 'utf8');
const browserApp = fs.readFileSync(browserAppPath, 'utf8');

const context = { window: {}, AbortController };
vm.createContext(context);
vm.runInContext(stateModule, context, { filename: statePath });
vm.runInContext(sessionsModule, context, { filename: sessionsPath });
vm.runInContext(sessionConfig, context, { filename: sessionConfigPath });
vm.runInContext(formatting, context, { filename: formattingPath });
vm.runInContext(markdownUtils, context, { filename: markdownUtilsPath });
vm.runInContext(displayItems, context, { filename: displayItemsPath });
vm.runInContext(persistence, context, { filename: persistencePath });
vm.runInContext(runs, context, { filename: runsPath });
vm.runInContext(browserApp, context, { filename: browserAppPath });

assert.ok(context.window.ChatUIApp, 'browser app namespace exists');
assert.ok(context.window.ChatUIApp.state?.createSession, 'state module is exported');
assert.ok(context.window.ChatUIApp.sessionConfig?.getSessionChatModel, 'session config module is exported');
assert.ok(context.window.ChatUIApp.formatting?.formatElapsed, 'formatting module is exported');
assert.ok(context.window.ChatUIApp.markdownUtils?.slugifyHeading, 'markdown utils module is exported');
assert.ok(context.window.ChatUIApp.runs?.ensureActiveRun, 'runs module is exported');
assert.ok(context.window.ChatUIApp.sessions?.deriveSessionTitle, 'sessions module is exported');
assert.ok(context.window.ChatUIApp.persistence?.sanitizeStoredMessage, 'persistence module is exported');
assert.ok(context.window.ChatUIApp.displayItems?.displayItemHasRichMedia, 'display items module is exported');

const session = context.window.ChatUIApp.state.createSession('T');
assert.strictEqual(session.title, 'T');
assert.strictEqual(session.systemPrompt, '');
assert.strictEqual(session.hasSystemPromptOverride, false);
assert.strictEqual(session.imageStylePrompt, '');
assert.strictEqual(session.hasImageStylePromptOverride, false);
assert.strictEqual(session.chatModel, '');
assert.strictEqual(JSON.stringify(session.headerValues), '{}');

const appState = { sessions: [{ id: 's1', messages: null, display: null }], activeSessionId: 's1', activeRuns: new Map() };
const active = context.window.ChatUIApp.state.ensureActiveSession(appState);
assert.strictEqual(active.id, 's1');
assert.strictEqual(JSON.stringify(active.messages), '[]');
assert.strictEqual(JSON.stringify(active.display), '[]');
assert.strictEqual(JSON.stringify(active.headerValues), '{}');
assert.strictEqual(active.systemPrompt, '');
assert.strictEqual(active.imageStylePrompt, '');
assert.strictEqual(active.chatModel, '');
assert.strictEqual(active.hasSystemPromptOverride, false);
assert.strictEqual(active.hasImageStylePromptOverride, false);
assert.strictEqual(
  context.window.ChatUIApp.sessionConfig.getEffectiveImageStylePrompt({ session: { hasImageStylePromptOverride: true, imageStylePrompt: ' 水彩 ' }, config: { imageStylePrompt: '默认' } }),
  '水彩',
);
assert.strictEqual(
  context.window.ChatUIApp.sessionConfig.getSessionChatModel({ session: { chatModel: 'local' }, config: { chatModel: 'global' }, models: ['local'] }),
  'local',
);
assert.strictEqual(context.window.ChatUIApp.formatting.formatElapsed(65000), '1m 5s');
assert.strictEqual(context.window.ChatUIApp.formatting.escapeHtml('<x>'), '&lt;x&gt;');
assert.strictEqual(context.window.ChatUIApp.markdownUtils.slugifyHeading('Hello, ChatUI!'), 'hello-chatui');
assert.strictEqual(context.window.ChatUIApp.markdownUtils.renderLists, undefined);
assert.strictEqual(context.window.ChatUIApp.markdownUtils.renderMarkdownLegacy, undefined);
assert.strictEqual(context.window.ChatUIApp.markdownUtils.extractLegacyCodeBlocks, undefined);
assert.strictEqual(context.window.ChatUIApp.markdownUtils.replaceGfmEmojiShortcodes, undefined);
assert.strictEqual(context.window.ChatUIApp.markdownUtils.normalizeExtendedMarkdown, undefined);
assert.strictEqual(context.window.ChatUIApp.markdownUtils.prepareMarkdownSource, undefined);
assert.strictEqual(context.window.ChatUIApp.markdownUtils.extractMathSegments, undefined);
assert.strictEqual(context.window.ChatUIApp.markdownUtils.splitTableRow, undefined);

console.log('browser app bundle ok');
