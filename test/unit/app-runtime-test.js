#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function loadRuntime() {
  const ctx = {
    window: {},
    console: { warn() {} },
    setTimeout(fn) { return fn(); },
  };
  ctx.window.window = ctx.window;
  ctx.window.ChatUIApp = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../client/app/runtime.js'), 'utf8'), ctx.window);
  return ctx.window.ChatUIApp.runtime;
}

const runtime = loadRuntime();
const labels = [];
const doc = {
  querySelectorAll(sel) { return sel === '[data-app-version]' ? labels : []; },
  getElementById(id) { return id === 'railConfigBtn' ? railBtn : null; },
};
const railBtn = { title: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
labels.push({ textContent: '' }, { textContent: '' });
assert.strictEqual(runtime.setDisplayedVersion('1.2.3', doc), 'v1.2.3');
assert.deepStrictEqual(labels.map(x => x.textContent), ['v1.2.3', 'v1.2.3']);
assert.strictEqual(railBtn.title, '模型配置 · v1.2.3');
assert.strictEqual(railBtn.attrs['aria-label'], '模型配置，当前版本 v1.2.3');

let played = false;
const sound = runtime.createDoneSound({
  AudioContextImpl: class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createOscillator() { return { frequency: { setValueAtTime() {} }, connect() {}, start() { played = true; }, stop() {} }; }
  },
  logger: { warn() {} },
});
(async () => {
  await sound.playDoneSound();
  assert.strictEqual(played, true);
  console.log('app runtime ok');
})().catch(err => { console.error(err); process.exit(1); });
