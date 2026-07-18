'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadRuntime() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/runtime.js'), 'utf8');
  const window = { navigator: {} };
  const context = {
    window,
    document: { querySelectorAll: () => [], getElementById: () => null },
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  vm.runInNewContext(source, context, { filename: 'client/app/runtime.js' });
  return window.ChatUIApp.runtime;
}

async function testDoneSoundOnlyStartsFromAnActiveUserGesture() {
  const runtime = loadRuntime();
  const activation = { isActive: false };
  const warnings = [];
  let constructed = 0;
  let resumeCalls = 0;
  let oscillatorCalls = 0;

  class FakeAudioContext {
    constructor() {
      constructed += 1;
      this.state = 'suspended';
      this.currentTime = 10;
      this.destination = {};
    }
    async resume() {
      resumeCalls += 1;
      this.state = 'running';
    }
    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        disconnect() {},
      };
    }
    createOscillator() {
      oscillatorCalls += 1;
      return {
        type: '',
        frequency: { setValueAtTime() {} },
        connect() {},
        start() {},
        stop() {},
      };
    }
  }

  const sound = runtime.createDoneSound({
    AudioContextImpl: FakeAudioContext,
    userActivation: activation,
    logger: { warn: (...args) => warnings.push(args) },
  });

  assert.strictEqual(await sound.unlockDoneSound({ userGesture: false }), null);
  assert.strictEqual(await sound.unlockDoneSound({ userGesture: true }), null, 'inactive browser activation must not create or resume audio');
  await sound.playDoneSound();
  assert.strictEqual(constructed, 0);
  assert.strictEqual(resumeCalls, 0);

  activation.isActive = true;
  const context = await sound.unlockDoneSound({ userGesture: true });
  assert.ok(context);
  assert.strictEqual(constructed, 1);
  assert.strictEqual(resumeCalls, 1);

  activation.isActive = false;
  await sound.playDoneSound();
  assert.strictEqual(oscillatorCalls, 2, 'an already unlocked context should still play after transient activation ends');

  context.state = 'suspended';
  await sound.playDoneSound();
  assert.strictEqual(resumeCalls, 1, 'background completion must not resume a suspended context without a gesture');
  assert.deepStrictEqual(warnings, []);
}

module.exports = [testDoneSoundOnlyStartsFromAnActiveUserGesture];
