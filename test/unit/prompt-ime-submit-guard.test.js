const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  createPromptEnterSubmitController,
  bindPromptEnterSubmitGuard,
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

function testPromptEnterIsSuppressedImmediatelyAfterCompositionEnds() {
  let now = 1000;
  let submits = 0;
  const controller = createPromptEnterSubmitController({
    now: () => now,
    compositionEndGraceMs: 120,
    submit: () => { submits += 1; },
  });

  controller.onCompositionStart();
  controller.onCompositionEnd();

  const safariTrailingEnter = createKeyEvent();
  assert.strictEqual(controller.onKeyDown(safariTrailingEnter), false);
  assert.strictEqual(safariTrailingEnter.prevented, false);
  assert.strictEqual(submits, 0);

  now += 121;
  const laterEnter = createKeyEvent();
  assert.strictEqual(controller.onKeyDown(laterEnter), true);
  assert.strictEqual(laterEnter.prevented, true);
  assert.strictEqual(submits, 1);
}

function testBootstrapUsesImeAwarePromptEnterGuard() {
  const bootstrap = fs.readFileSync(path.join(__dirname, '../../client/app/bootstrap-workflow.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');

  assert.ok(bootstrap.includes('bindPromptInputGuards(),bindPromptEnterSubmitGuard($("prompt"),$("composer"))'));
  assert.ok(!bootstrap.includes('$("prompt").addEventListener("keydown",e=>{"Enter"!==e.key'));
  assert.ok(index.includes('bootstrap-workflow.js?v=2.1.1-ime-enter-guard'));
  assert.ok(index.includes('chatui.bundle.js?v=1.3.129-ime-enter-guard'));
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
  testPromptEnterIsSuppressedImmediatelyAfterCompositionEnds,
  testBootstrapUsesImeAwarePromptEnterGuard,
  testPromptEnterGuardBindsOnceAndUsesComposerSubmit,
];
