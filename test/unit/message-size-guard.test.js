const assert = require('assert');
const fs = require('fs');
const path = require('path');
const guards = require('../../client/core/preflight-guards');
const composerLayout = require('../../client/app/composer-layout-workflow');

function testMessageSizeGuardAcceptsNormalMessages() {
  const result = guards.validateMessageSize('正常消息');
  assert.strictEqual(result.ok, true);
}

function testMessageSizeGuardRejectsHugeCharacterPayload() {
  const text = 'a'.repeat(guards.MAX_USER_MESSAGE_CHARS + 1);
  const result = guards.validateMessageSize(text);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'message_too_many_characters');
  assert.ok(result.message.includes('上传文本文件或分段发送'));
}

function testInsertionGuardRejectsOversizedPasteWithoutBuildingTextareaValue() {
  const result = guards.validateMessageInsertion({
    current: 'prefix',
    inserted: 'x'.repeat(guards.MAX_USER_MESSAGE_CHARS),
    selectionStart: 6,
    selectionEnd: 6,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'message_too_many_characters');
}

function testInsertionGuardAccountsForSelectedReplacement() {
  const current = 'a'.repeat(guards.MAX_USER_MESSAGE_CHARS);
  const result = guards.validateMessageInsertion({ current, inserted: 'xyz', selectionStart: 0, selectionEnd: 3 });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.length, guards.MAX_USER_MESSAGE_CHARS);
}

function testMessageLimitTruncationDoesNotLeaveHalfSurrogate() {
  const result = guards.truncateMessageToLimit(`ab😀cd`, { maxChars: 3 });
  assert.strictEqual(result, 'ab');
}

function testPreflightRejectsOversizedInputBeforeConfigurationChecks() {
  const result = guards.buildPreflightDecision({ input: 'a'.repeat(guards.MAX_USER_MESSAGE_CHARS + 1), config: {} });
  assert.strictEqual(result.action, 'reply');
  assert.strictEqual(result.code, 'message_too_many_characters');
  assert.strictEqual(result.metaText, '消息过大，未发送');
}

function testLargePromptResizeSkipsSynchronousScrollHeightMeasurement() {
  let scrollHeightReads = 0;
  const styleValues = new Map();
  const prompt = {
    value: 'x'.repeat(composerLayout.LARGE_PROMPT_LAYOUT_THRESHOLD + 1),
    style: {
      overflowY: '',
      getPropertyValue: key => styleValues.get(key) || '',
      setProperty: (key, value) => styleValues.set(key, value),
    },
    get scrollHeight() { scrollHeightReads += 1; throw new Error('large prompt must not force scrollHeight layout'); },
  };
  const composer = { getBoundingClientRect: () => ({ top: 700 }) };
  const messages = { style: {} };
  const workflow = composerLayout.createComposerLayoutWorkflow({
    getElement: id => ({ prompt, composer, messages }[id]),
    window: { innerHeight: 1000, matchMedia: () => ({ matches: false }) },
    document: { documentElement: { clientHeight: 1000, style: { setProperty() {} } } },
    requestAnimationFrame: callback => { callback(); return 1; },
  });
  workflow.autoResize();
  assert.strictEqual(scrollHeightReads, 0);
  assert.strictEqual(prompt.style.overflowY, 'auto');
}

function testPromptInputGuardRunsBeforeTextareaMutationAndRemovesLegacyResizeListeners() {
  const bootstrap = fs.readFileSync(path.join(__dirname, '../../client/app/bootstrap-workflow.js'), 'utf8');
  const submit = fs.readFileSync(path.join(__dirname, '../../client/app/submit-workflow.js'), 'utf8');
  const rootApp = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.ok(bootstrap.includes("prompt.addEventListener('paste'") && bootstrap.includes("prompt.addEventListener('beforeinput'"));
  assert.ok(bootstrap.includes('validateMessageInsertion'));
  assert.ok(!bootstrap.includes('addEventListener("keyup",scheduleAutoResize)'));
  assert.ok(!bootstrap.includes('addEventListener("paste",scheduleAutoResize)'));
  assert.ok(!bootstrap.includes('addEventListener("compositionend",scheduleAutoResize)'));
  const submitGuard = 'validateMessageSize?.(rawPromptValue)';
  assert.ok(submit.includes(submitGuard), 'submit workflow must retain a recovery/programmatic-input safety boundary');
  assert.ok(rootApp.includes(submitGuard), 'root static entry must keep the same submit safety boundary');
}

module.exports = [
  testMessageSizeGuardAcceptsNormalMessages,
  testMessageSizeGuardRejectsHugeCharacterPayload,
  testInsertionGuardRejectsOversizedPasteWithoutBuildingTextareaValue,
  testInsertionGuardAccountsForSelectedReplacement,
  testMessageLimitTruncationDoesNotLeaveHalfSurrogate,
  testPreflightRejectsOversizedInputBeforeConfigurationChecks,
  testLargePromptResizeSkipsSynchronousScrollHeightMeasurement,
  testPromptInputGuardRunsBeforeTextareaMutationAndRemovesLegacyResizeListeners,
];
