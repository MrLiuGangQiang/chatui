#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const browserAppPath = path.join(root, 'client/app/browser.js');
const browserApp = fs.readFileSync(browserAppPath, 'utf8');

const context = { window: {}, AbortController };
vm.createContext(context);
vm.runInContext(browserApp, context, { filename: browserAppPath });

assert.ok(context.window.ChatUIApp, 'browser app namespace exists');
assert.ok(context.window.ChatUIApp.state?.createSession, 'state module is exported');
assert.ok(context.window.ChatUIApp.sessionConfig?.getSessionChatModel, 'session config module is exported');
assert.ok(context.window.ChatUIApp.headerParams?.normalizeHeaderParamConfig, 'header params module is exported');
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
assert.strictEqual(
  JSON.stringify(context.window.ChatUIApp.headerParams.normalizeHeaderParamConfig([{ name: ' X-Trace ', mode: 'bad', value: 123 }])),
  '[{"name":"X-Trace","mode":"manual","value":"123"}]',
);
assert.strictEqual(
  JSON.stringify(context.window.ChatUIApp.headerParams.buildRequestHeadersFromParams({ params: [{ name: 'X-Msg', mode: 'message_short_uuid' }], messageUuid: () => 'm1' }).headers),
  '{"X-Msg":"m1"}',
);
assert.strictEqual(context.window.ChatUIApp.formatting.formatElapsed(65000), '1m 5s');
assert.strictEqual(context.window.ChatUIApp.formatting.escapeHtml('<x>'), '&lt;x&gt;');
assert.strictEqual(context.window.ChatUIApp.markdownUtils.replaceGfmEmojiShortcodes(':rocket:'), '🚀');
assert.strictEqual(context.window.ChatUIApp.markdownUtils.normalizeExtendedMarkdown('==xy=='), '<mark>xy</mark>');
assert.strictEqual(context.window.ChatUIApp.markdownUtils.prepareMarkdownSource('a｜b'), 'a｜b');
assert.strictEqual(context.window.ChatUIApp.markdownUtils.renderLists('- a'), '<ul>\n<li>a</li>\n</ul>');
assert.ok(context.window.ChatUIApp.markdownUtils.renderMarkdownLegacy('**b**').includes('<strong>b</strong>'));
assert.strictEqual(context.window.ChatUIApp.markdownUtils.extractLegacyCodeBlocks('```js\nx\n```').blocks.length, 1);
assert.strictEqual(context.window.ChatUIApp.markdownUtils.slugifyHeading('Hello, ChatUI!'), 'hello-chatui');
assert.strictEqual(
  JSON.stringify(context.window.ChatUIApp.markdownUtils.splitTableRow('| a | b |')),
  '["a","b"]',
);
assert.strictEqual(
  JSON.stringify(context.window.ChatUIApp.markdownUtils.extractMathSegments('$x$').math),
  '[{"raw":"x","displayMode":false}]',
);

console.log('browser app bundle ok');
