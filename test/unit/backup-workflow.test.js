'use strict';

const assert = require('assert');
const appContext = require('../../client/app/app-context');
const backup = require('../../client/app/backup-workflow');
const configWorkflow = require('../../client/app/config-workflow');

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
  return {
    values,
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function sampleSession(id = 'session-1') {
  return {
    id,
    title: '备份测试',
    customTitle: '',
    systemPrompt: '请简洁回答',
    hasSystemPromptOverride: true,
    imageStylePrompt: '',
    hasImageStylePromptOverride: false,
    chatModel: 'gpt-test',
    promptDraft: '未发送草稿',
    reasoningMode: true,
    reasoningType: 'high',
    pendingClarification: null,
    createdAt: 10,
    updatedAt: 20,
    messages: [
      { role: 'user', content: '你好', messageIndex: '0' },
      { role: 'assistant', content: '你好，有什么可以帮你？', responseIndex: '1', reasoning_content: '简短推理' },
    ],
    display: [{ id: 'pending', pending: '1', role: 'assistant' }],
    lastGeneratedImage: { src: 'https://example.test/image.png' },
    busy: true,
  };
}

function testArchiveContainsOnlyConversationAndMedia() {
  const archive = backup.createBackupArchive({
    config: {
      baseUrl: 'https://example.test/v1',
      apiKey: 'secret-key',
      context: { tenant: 'server-only' },
      models: ['gpt-test'],
    },
    sessions: [sampleSession()],
    activeSessionId: 'session-1',
    exportedAt: '2026-07-28T00:00:00.000Z',
  });

  assert.strictEqual(archive.format, 'chatui-backup');
  assert.strictEqual(archive.version, 5);
  assert.strictEqual(Object.hasOwn(archive, 'configuration'), false);
  assert.strictEqual(Object.hasOwn(archive, 'includesSecrets'), false);
  assert.strictEqual(Object.hasOwn(archive.sessions[0], 'chatModel'), false);
  const serialized = JSON.stringify(archive);
  assert.ok(!serialized.includes('secret-key'));
  assert.ok(!serialized.includes('header-secret'));
  assert.ok(!serialized.includes('gpt-test'));
  assert.ok(!serialized.includes('baseUrl'));
  assert.ok(!serialized.includes('"X-Session":"abc"'));
  assert.deepStrictEqual(archive.sessions[0].messages.map(message => message.content), ['你好', '你好，有什么可以帮你？']);
  assert.deepStrictEqual(archive.sessions[0].display, [], 'in-progress display jobs must not be exported as resumable work');
  assert.strictEqual(archive.sessions[0].busy, false);
  assert.deepStrictEqual(archive.media, []);
}

function testArchiveIgnoresConfigurationEvenWhenCallerProvidesIt() {
  const archive = backup.createBackupArchive({
    config: {
      baseUrl: 'https://example.test/v1',
      apiKey: 'secret-key',
    },
    sessions: [sampleSession()],
    activeSessionId: 'session-1',
    includeSecrets: true,
  });

  assert.strictEqual(Object.hasOwn(archive, 'configuration'), false);
  assert.strictEqual(Object.hasOwn(archive, 'includesSecrets'), false);
  assert.ok(!JSON.stringify(archive).includes('secret-key'));
}

function testParseRejectsUnsupportedAndDuplicateSessions() {
  assert.throws(() => backup.parseBackupText('{"format":"other"}'), /支持/);
  const archive = backup.createBackupArchive({ sessions: [sampleSession()], activeSessionId: 'session-1' });
  archive.sessions.push({ ...sampleSession('session-1') });
  assert.throws(() => backup.parseBackupText(JSON.stringify(archive)), /重复/);
}

function testParseAcceptsLegacyUnmarkedBackupBodyAndScrubsSecrets() {
  const legacy = {
    config: {
      baseUrl: 'https://example.test/v1',
      apiKey: 'legacy-key',
    },
    sessions: [sampleSession()],
    activeSessionId: 'session-1',
  };
  const parsed = backup.parseBackupText(JSON.stringify(legacy));
  assert.strictEqual(Object.hasOwn(parsed, 'configuration'), false);
  assert.strictEqual(Object.hasOwn(parsed.sessions[0], 'chatModel'), false);
  assert.strictEqual(parsed.activeSessionId, 'session-1');
}

function testParseAcceptsSessionOnlyAndWrappedBackupBodies() {
  const archive = backup.createBackupArchive({ sessions: [sampleSession()], activeSessionId: 'session-1' });
  const sessionOnly = { sessions: archive.sessions, activeSessionId: archive.activeSessionId };
  const parsedSessionOnly = backup.parseBackupText(`\uFEFF${JSON.stringify(sessionOnly)}`);
  assert.strictEqual(parsedSessionOnly.sessions[0].messages.length, 2);

  const wrapped = backup.parseBackupText(JSON.stringify({ archive: { ...archive, version: 'v5' } }));
  assert.strictEqual(wrapped.sessions[0].id, 'session-1');
}

function testParseAcceptsVersionOneBackupWithoutPortableMedia() {
  const archive = backup.createBackupArchive({ sessions: [sampleSession()], activeSessionId: 'session-1' });
  archive.version = 1;
  delete archive.media;
  const parsed = backup.parseBackupText(JSON.stringify(archive));
  assert.strictEqual(parsed.activeSessionId, 'session-1');
  assert.deepStrictEqual(parsed.media, []);
}

function testParseRejectsPortableBackupMissingReferencedMedia() {
  const session = sampleSession();
  session.messages = [{
    role: 'assistant',
    content: '[图片生成完成] 测试',
    imageContext: JSON.stringify({ attachments: [{ src: 'indexeddb://missing-image', name: 'missing.png', type: 'image/png' }] }),
  }];
  const archive = backup.createBackupArchive({ sessions: [session], activeSessionId: session.id });
  assert.throws(() => backup.parseBackupText(JSON.stringify(archive)), /缺少 1 个附件或图片/);
}

async function blobToDataUrl(blob) {
  const data = Buffer.from(await blob.arrayBuffer()).toString('base64');
  return `data:${blob.type || 'application/octet-stream'};base64,${data}`;
}

async function dataUrlToBlob(value) {
  const match = String(value).match(/^data:([^,]*);base64,([a-z0-9+/]*={0,2})$/i);
  if (!match) throw new Error('invalid data URL');
  return new Blob([Buffer.from(match[2], 'base64')], { type: match[1] || 'application/octet-stream' });
}

async function testPortableMediaBackupRestoresAttachmentAndImageBlobs() {
  const session = sampleSession();
  session.messages = [
    {
      role: 'user',
      content: '请分析附件和图片',
      messageIndex: '0',
      attachmentContext: JSON.stringify({ attachments: [
        { id: 'report', name: 'report.pdf', type: 'application/pdf', src: 'indexeddb://attachment-report' },
        { id: 'photo', name: 'photo.png', type: 'image/png', src: 'indexeddb://attachment-photo' },
      ] }),
    },
    {
      role: 'assistant',
      content: '[图片生成完成] 一只猫',
      responseIndex: '1',
      html: '<img class=\\"generated-thumb\\" data-persisted-src=\\"indexeddb://generated-cat\\" />',
      imageContext: JSON.stringify({ attachments: [
        { id: 'cat', name: 'cat.png', type: 'image/png', src: 'indexeddb://generated-cat' },
      ] }),
    },
  ];
  session.lastGeneratedImage = { src: 'indexeddb://generated-cat', images: [{ src: 'indexeddb://generated-cat', filename: 'cat.png' }] };
  const sourceMedia = new Map([
    ['attachment-report', new Blob(['PDF data'], { type: 'application/pdf' })],
    ['attachment-photo', new Blob(['PNG attachment'], { type: 'image/png' })],
    ['generated-cat', new Blob(['PNG result'], { type: 'image/png' })],
  ]);
  const sourceState = { sessions: [session], activeSessionId: session.id };
  const sourceWorkflow = backup.createBackupWorkflow({
    state: sourceState,
    localStorage: createStorage(),
    CONFIG_KEY: 'config',
    getImageBlob: async key => sourceMedia.get(key) || null,
    blobToDataUrl,
  });

  const archive = await sourceWorkflow.buildBackup();
  assert.strictEqual(archive.version, 5);
  assert.deepStrictEqual(archive.media.map(item => item.key).sort(), ['attachment-photo', 'attachment-report', 'generated-cat']);
  assert.ok(archive.media.every(item => /^data:[^,]*;base64,/i.test(item.dataUrl)));

  const restoredMedia = new Map();
  const events = [];
  const destinationState = { sessions: [sampleSession('old')], activeSessionId: 'old', messages: [], attachments: [] };
  const destinationWorkflow = backup.createBackupWorkflow({
    state: destinationState,
    localStorage: createStorage(),
    CONFIG_KEY: 'config',
    clearSessionSnapshots: async () => { events.push('clear-snapshots'); },
    clearImageDb: async () => { events.push('clear-media'); restoredMedia.clear(); },
    putImageBlob: async (key, blob) => { events.push(`put:${key}`); restoredMedia.set(key, blob); },
    getImageBlob: async key => { events.push(`get:${key}`); return restoredMedia.get(key) || null; },
    dataUrlToBlob,
    commitSession: async () => { events.push('commit-session'); },
  });

  await destinationWorkflow.restoreBackup(archive);

  assert.strictEqual(destinationState.sessions[0].messages[0].attachmentContext, session.messages[0].attachmentContext);
  assert.strictEqual(destinationState.sessions[0].messages[1].imageContext, session.messages[1].imageContext);
  assert.strictEqual(destinationState.sessions[0].messages[1].html, '<img class="generated-thumb" data-persisted-src="indexeddb://generated-cat" />');
  assert.deepStrictEqual([...restoredMedia.keys()].sort(), ['attachment-photo', 'attachment-report', 'generated-cat']);
  assert.strictEqual(await restoredMedia.get('attachment-report').text(), 'PDF data');
  assert.strictEqual(await restoredMedia.get('generated-cat').text(), 'PNG result');
  assert.ok(events.indexOf('clear-media') < events.indexOf('put:attachment-report'));
  assert.ok(events.findIndex(event => event.startsWith('put:')) < events.indexOf('commit-session'), 'media must be restored before the session snapshot is committed');
  assert.ok(events.findIndex(event => event.startsWith('get:')) < events.indexOf('commit-session'), 'the renderer-visible media store must be verified before the session snapshot is committed');
}

async function testFileImportKeepsMediaAfterReadNormalization() {
  const session = sampleSession('file-import-media');
  session.messages[1].imageContext = JSON.stringify({ attachments: [{ src: 'indexeddb://file-import-image', name: 'image.png', type: 'image/png' }] });
  const archive = backup.createBackupArchive({
    sessions: [session],
    activeSessionId: session.id,
    media: [{ key: 'file-import-image', dataUrl: 'data:image/png;base64,UE5H' }],
  });
  const restoredMedia = new Map();
  const workflow = backup.createBackupWorkflow({
    state: { sessions: [], activeSessionId: '', disposedSessionIds: new Set() },
    clearImageDb: async () => restoredMedia.clear(),
    putImageBlob: async (key, blob) => restoredMedia.set(key, blob),
    getImageBlob: async key => restoredMedia.get(key) || null,
    dataUrlToBlob: async value => new Blob([Buffer.from(value.split(',')[1], 'base64')], { type: 'image/png' }),
    commitSession: async () => ({}),
    window: { confirm: () => true, location: { reload: () => {} } },
  });
  await workflow.importBackupFile({ size: JSON.stringify(archive).length, text: async () => JSON.stringify(archive) });
  assert.strictEqual(restoredMedia.size, 1, 'file import must restore media after read normalization');
}

async function testRestoreReplacesSnapshotsAndActiveSessionWithoutChangingConfig() {
  const storage = createStorage({
    config: {
      baseUrl: 'https://old.test/v1',
    },
    'config:api-key': 'old-key',
  });
  const oldSession = sampleSession('old-session');
  const state = {
    sessions: [oldSession],
    activeSessionId: oldSession.id,
    messages: oldSession.messages,
    lastGeneratedImage: null,
    attachments: [{ name: 'stale.txt' }],
    disposedSessionIds: new Set(['session-1']),
  };
  const committed = [];
  let clearCalls = 0;
  let flushCalls = 0;
  let metaCalls = 0;
  const workflow = backup.createBackupWorkflow({
    state,
    localStorage: storage,
    CONFIG_KEY: 'config',
    clearSessionSnapshots: async () => { clearCalls += 1; },
    commitSession: async session => { committed.push(session.id); },
    flushSessionSnapshots: async () => { flushCalls += 1; },
    saveSessionsMeta: () => { metaCalls += 1; },
  });
  const archive = backup.createBackupArchive({
    config: {
      baseUrl: 'https://new.test/v1',
      apiKey: 'new-key',
      models: ['gpt-test'],
    },
    sessions: [sampleSession('session-1')],
    activeSessionId: 'session-1',
    includeSecrets: true,
  });

  await workflow.restoreBackup(archive);

  assert.strictEqual(clearCalls, 1);
  assert.deepStrictEqual(committed, ['session-1']);
  assert.ok(flushCalls >= 2, 'restore must wait for old writes and the imported snapshots');
  assert.strictEqual(metaCalls, 1);
  assert.strictEqual(state.activeSessionId, 'session-1');
  assert.deepStrictEqual(state.messages.map(message => message.content), ['你好', '你好，有什么可以帮你？']);
  assert.deepStrictEqual(state.attachments, []);
  assert.strictEqual(state.disposedSessionIds.size, 0, 'restored IDs must not remain blocked by old deletion markers');
  assert.deepStrictEqual(JSON.parse(storage.values.get('config')), {
    baseUrl: 'https://old.test/v1',
  });
  assert.strictEqual(storage.values.get('config:api-key'), 'old-key');
}

async function testImportRequiresConfirmationAndRejectsBusyState() {
  const session = sampleSession();
  const archive = backup.createBackupArchive({ sessions: [session], activeSessionId: session.id });
  let commits = 0;
  let reloads = 0;
  const workflow = backup.createBackupWorkflow({
    state: { sessions: [session], activeSessionId: session.id, messages: session.messages },
    localStorage: createStorage(),
    CONFIG_KEY: 'config',
    window: { confirm: () => false },
    commitSession: async () => { commits += 1; },
    reload: () => { reloads += 1; },
  });
  const imported = await workflow.importBackupFile({ size: 10, text: async () => JSON.stringify(archive) });
  assert.strictEqual(imported, false);
  assert.strictEqual(commits, 0);
  assert.strictEqual(reloads, 0);

  const busyWorkflow = backup.createBackupWorkflow({
    state: { sessions: [session] },
    localStorage: createStorage(),
    isSessionBusy: () => true,
  });
  await assert.rejects(() => busyWorkflow.restoreBackup(archive), /正在生成内容/);
}

async function testImportExplainsThatLocalConfigurationIsPreserved() {
  const session = sampleSession();
  const prompts = [];
  const workflow = backup.createBackupWorkflow({
    window: { confirm: prompt => { prompts.push(prompt); return false; } },
  });
  const importArchive = archive => workflow.importBackupFile({
    size: 10,
    text: async () => JSON.stringify(archive),
  });

  await importArchive(backup.createBackupArchive({ sessions: [session], activeSessionId: session.id }));
  assert.strictEqual(prompts[0].includes('模型配置'), true);
  await importArchive(backup.createBackupArchive({
    config: { apiKey: 'secret-key' },
    sessions: [session],
    activeSessionId: session.id,
    includeSecrets: true,
  }));
  assert.strictEqual(prompts[1].includes('模型配置'), true);
}

function testBackupWorkflowUsesApplicationRegistryInsteadOfBrowserGlobal() {
  assert.strictEqual(appContext.getWorkflowModule('backup'), backup);
  assert.strictEqual(globalThis.ChatUIAppBackupWorkflow, undefined);
}

async function testReadImportFileFallsBackToFileReader() {
  const session = sampleSession();
  const archive = backup.createBackupArchive({ sessions: [session], activeSessionId: session.id });
  class FakeFileReader {
    readAsText() {
      this.result = JSON.stringify(archive);
      queueMicrotask(() => this.onload());
    }
  }
  const workflow = backup.createBackupWorkflow({ FileReader: FakeFileReader });
  const imported = await workflow.readImportFile({ size: 99 });
  assert.strictEqual(imported.activeSessionId, session.id);
}

async function testSettingsWorkflowBindsBackupControlsToSessionPersistence() {
  const originalGlobals = new Map(['ChatUIApp', 'getSessionDisplayWorkflow', 'clearSessionSnapshots', 'flushSessionSnapshots', 'collectIndexedDbKeys', 'getImageBlob', 'putImageBlob', 'clearImageDb', 'dataUrlToBlob']
    .map(key => [key, { exists: Object.prototype.hasOwnProperty.call(globalThis, key), value: globalThis[key] }]));
  const listeners = new Map();
  const createElement = id => ({
    addEventListener: (name, handler) => listeners.set(`${id}:${name}`, handler),
    click() { this.clicked = true; },
    dataset: {},
    textContent: '',
  });
  const elements = new Map();
  ['exportBackupBtn', 'importBackupFile', 'backupTransferStatus'].forEach(id => {
    elements.set(id, createElement(id));
  });
  const exportOptions = [];
  let imported = null;
  let committed = null;
  let receivedDeps = null;
  try {
    const commitSession = async session => { committed = session; };
    globalThis.getSessionDisplayWorkflow = () => ({ commitSession });
    globalThis.clearSessionSnapshots = async () => {};
    globalThis.flushSessionSnapshots = async () => {};
    globalThis.collectIndexedDbKeys = () => new Set();
    globalThis.getImageBlob = async () => null;
    globalThis.putImageBlob = async () => {};
    globalThis.clearImageDb = async () => {};
    globalThis.dataUrlToBlob = async () => new Blob();
    const fakeBackupApi = {
      createBackupWorkflow: deps => {
        receivedDeps = deps;
        return {
          downloadBackup: async options => { exportOptions.push(options); },
          importBackupFile: async file => { imported = file; },
        };
      },
    };
    globalThis.ChatUIApp = {
      appContext: {
        getWorkflowModule: name => name === 'backup' ? fakeBackupApi : null,
      },
    };
    const workflow = configWorkflow.createConfigWorkflow({
      state: { sessions: [{ id: 'session-1' }] },
      getElement: id => elements.get(id),
      localStorage: createStorage(),
      document: {},
      window: {},
      crypto: { getRandomValues() {} },
      setTimeout: callback => callback(),
      CONFIG_KEY: 'config',
      renderModelOptions() {},
      updateCustomSelect() {},
      saveSessionsMeta() {},
      toast() {},
    });
    assert.ok(workflow);
    await receivedDeps.commitSession({ id: 'session-1' });
    assert.deepStrictEqual(committed, { id: 'session-1' });
    assert.strictEqual(receivedDeps.clearSessionSnapshots, globalThis.clearSessionSnapshots);
    assert.strictEqual(receivedDeps.flushSessionSnapshots, globalThis.flushSessionSnapshots);
    assert.strictEqual(receivedDeps.getImageBlob, globalThis.getImageBlob);
    assert.strictEqual(receivedDeps.putImageBlob, globalThis.putImageBlob);
    assert.strictEqual(receivedDeps.clearImageDb, globalThis.clearImageDb);
    await listeners.get('exportBackupBtn:click')();
    assert.deepStrictEqual(exportOptions, [undefined]);
    assert.strictEqual(elements.get('backupTransferStatus').dataset.status, 'success');
    const file = { name: 'backup.json' };
    await listeners.get('importBackupFile:change')({ target: { files: [file], value: 'chosen' } });
    assert.strictEqual(imported, file);
    assert.strictEqual(elements.get('backupTransferStatus').textContent, '已取消导入');
  } finally {
    originalGlobals.forEach((original, key) => {
      if (original.exists) globalThis[key] = original.value;
      else delete globalThis[key];
    });
  }
}

module.exports = [
  testArchiveContainsOnlyConversationAndMedia,
  testArchiveIgnoresConfigurationEvenWhenCallerProvidesIt,
  testParseRejectsUnsupportedAndDuplicateSessions,
  testParseAcceptsLegacyUnmarkedBackupBodyAndScrubsSecrets,
  testParseAcceptsSessionOnlyAndWrappedBackupBodies,
  testParseAcceptsVersionOneBackupWithoutPortableMedia,
  testParseRejectsPortableBackupMissingReferencedMedia,
  testPortableMediaBackupRestoresAttachmentAndImageBlobs,
  testFileImportKeepsMediaAfterReadNormalization,
  testRestoreReplacesSnapshotsAndActiveSessionWithoutChangingConfig,
  testImportRequiresConfirmationAndRejectsBusyState,
  testImportExplainsThatLocalConfigurationIsPreserved,
  testBackupWorkflowUsesApplicationRegistryInsteadOfBrowserGlobal,
  testReadImportFileFallsBackToFileReader,
  testSettingsWorkflowBindsBackupControlsToSessionPersistence,
];
