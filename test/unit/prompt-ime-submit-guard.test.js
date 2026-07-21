const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  createPromptEnterSubmitController,
  bindPromptEnterSubmitGuard,
  isAppleCompositionPlatform,
} = require('../../client/app/bootstrap-workflow');

function createKeyEvent(overrides = {}) {
  return {
    key: 'Enter',
    shiftKey: false,
    isComposing: false,
    keyCode: 13,
    which: 13,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    ...overrides,
  };
}

function testPromptEnterSubmitsOutsideImeComposition() {
  let submits = 0;
  const controller = createPromptEnterSubmitController({ submit: () => { submits += 1; } });
  const event = createKeyEvent();

  assert.strictEqual(controller.onKeyDown(event), true);
  assert.strictEqual(event.prevented, true);
  assert.strictEqual(submits, 1);

  const shifted = createKeyEvent({ shiftKey: true });
  assert.strictEqual(controller.onKeyDown(shifted), false);
  assert.strictEqual(shifted.prevented, false);
  assert.strictEqual(submits, 1);
}

function testPromptEnterDoesNotSubmitWhileImeIsComposing() {
  let submits = 0;
  const controller = createPromptEnterSubmitController({ submit: () => { submits += 1; } });

  controller.onCompositionStart();
  const trackedComposition = createKeyEvent();
  assert.strictEqual(controller.onKeyDown(trackedComposition), false);

  const nativeComposition = createKeyEvent({ isComposing: true });
  assert.strictEqual(controller.onKeyDown(nativeComposition), false);

  const legacyIme = createKeyEvent({ keyCode: 229, which: 229 });
  assert.strictEqual(controller.onKeyDown(legacyIme), false);

  assert.strictEqual(trackedComposition.prevented, false);
  assert.strictEqual(nativeComposition.prevented, false);
  assert.strictEqual(legacyIme.prevented, false);
  assert.strictEqual(submits, 0);
}

function testWindowsEnterSubmitsImmediatelyAfterCompositionEnds() {
  let now = 1000;
  let submits = 0;
  const controller = createPromptEnterSubmitController({
    now: () => now,
    compositionEndGraceMs: 120,
    guardAfterCompositionEnd: false,
    submit: () => { submits += 1; },
  });

  controller.onCompositionStart();
  controller.onCompositionEnd();

  const windowsSendEnter = createKeyEvent();
  assert.strictEqual(controller.onKeyDown(windowsSendEnter), true);
  assert.strictEqual(windowsSendEnter.prevented, true, 'Windows Enter must prevent the textarea newline');
  assert.strictEqual(submits, 1, 'Windows Enter immediately after IME completion must submit');
}

function testAppleTrailingCompositionEnterIsSuppressedOnce() {
  let now = 1000;
  let submits = 0;
  const controller = createPromptEnterSubmitController({
    now: () => now,
    compositionEndGraceMs: 120,
    guardAfterCompositionEnd: true,
    submit: () => { submits += 1; },
  });

  controller.onCompositionStart();
  controller.onCompositionEnd();

  const safariTrailingEnter = createKeyEvent();
  assert.strictEqual(controller.onKeyDown(safariTrailingEnter), false);
  assert.strictEqual(safariTrailingEnter.prevented, true, 'the Safari trailing Enter must not insert a newline');
  assert.strictEqual(submits, 0);

  const nextIntentionalEnter = createKeyEvent();
  assert.strictEqual(controller.onKeyDown(nextIntentionalEnter), true, 'only one trailing Apple Enter should be consumed');
  assert.strictEqual(nextIntentionalEnter.prevented, true);
  assert.strictEqual(submits, 1);
}

function testAppleCompositionPlatformDetection() {
  assert.strictEqual(isAppleCompositionPlatform({ platform: 'MacIntel' }), true);
  assert.strictEqual(isAppleCompositionPlatform({ userAgentData: { platform: 'macOS' } }), true);
  assert.strictEqual(isAppleCompositionPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), true);
  assert.strictEqual(isAppleCompositionPlatform({ platform: 'Win32' }), false);
  assert.strictEqual(isAppleCompositionPlatform({ userAgentData: { platform: 'Windows' } }), false);
}

function testBootstrapUsesImeAwarePromptEnterGuard() {
  const bootstrap = fs.readFileSync(path.join(__dirname, '../../client/app/bootstrap-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');

  assert.ok(bootstrap.includes('bindPromptInputGuards(),bindPromptEnterSubmitGuard($("prompt"),$("composer"))'));
  assert.ok(!bootstrap.includes('$("prompt").addEventListener("keydown",e=>{"Enter"!==e.key'));
  assert.ok(index.includes('bootstrap-workflow.js?v=2.1.2-ime-platform-guard'));
  assert.ok(index.includes('chatui.bundle.js?v=1.3.145-resilient-snapshot-store'));
}

function testBoundGuardUsesPlatformSpecificCompositionEndPolicy() {
  const makePrompt = () => {
    const listeners = {};
    return {
      listeners,
      dataset: {},
      addEventListener(type, handler) { listeners[type] = handler; },
    };
  };

  const windowsPrompt = makePrompt();
  let windowsSubmits = 0;
  bindPromptEnterSubmitGuard(windowsPrompt, { requestSubmit() { windowsSubmits += 1; } }, {
    navigator: { platform: 'Win32' },
  });
  windowsPrompt.listeners.compositionstart();
  windowsPrompt.listeners.compositionend();
  const windowsEnter = createKeyEvent();
  windowsPrompt.listeners.keydown(windowsEnter);
  assert.strictEqual(windowsSubmits, 1);
  assert.strictEqual(windowsEnter.prevented, true);

  const applePrompt = makePrompt();
  let appleSubmits = 0;
  bindPromptEnterSubmitGuard(applePrompt, { requestSubmit() { appleSubmits += 1; } }, {
    navigator: { platform: 'MacIntel' },
  });
  applePrompt.listeners.compositionstart();
  applePrompt.listeners.compositionend();
  const appleTrailingEnter = createKeyEvent();
  applePrompt.listeners.keydown(appleTrailingEnter);
  assert.strictEqual(appleSubmits, 0);
  assert.strictEqual(appleTrailingEnter.prevented, true);
}

function testPromptEnterGuardBindsOnceAndUsesComposerSubmit() {
  const listeners = {};
  const prompt = {
    dataset: {},
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
  };
  let submits = 0;
  const composer = { requestSubmit() { submits += 1; } };

  const first = bindPromptEnterSubmitGuard(prompt, composer, { compositionEndGraceMs: 0 });
  const second = bindPromptEnterSubmitGuard(prompt, composer, { compositionEndGraceMs: 0 });

  assert.ok(first);
  assert.strictEqual(second, null);
  assert.deepStrictEqual(Object.keys(listeners).sort(), ['blur', 'compositionend', 'compositionstart', 'keydown']);

  const event = createKeyEvent();
  listeners.keydown(event);
  assert.strictEqual(event.prevented, true);
  assert.strictEqual(submits, 1);
}

module.exports = [
  testPromptEnterSubmitsOutsideImeComposition,
  testPromptEnterDoesNotSubmitWhileImeIsComposing,
  testWindowsEnterSubmitsImmediatelyAfterCompositionEnds,
  testAppleTrailingCompositionEnterIsSuppressedOnce,
  testAppleCompositionPlatformDetection,
  testBootstrapUsesImeAwarePromptEnterGuard,
  testBoundGuardUsesPlatformSpecificCompositionEndPolicy,
  testPromptEnterGuardBindsOnceAndUsesComposerSubmit,
];
