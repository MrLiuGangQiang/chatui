'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadFindMessageNodeFromApp() {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf-8');
  const start = source.indexOf('const displayItemNodeCache=new WeakMap;');
  const end = source.indexOf('function insertMessageNodeAtDisplayPosition', start);
  assert.ok(start >= 0 && end > start, 'the display-item node cache lookup must remain in app.js');
  const sandbox = {};
  vm.runInNewContext(`${source.slice(start, end)};findMessageNodeByDisplayItem`, sandbox);
  assert.strictEqual(typeof sandbox.findMessageNodeByDisplayItem, 'function');
  return $ => item => {
    sandbox.$ = $;
    return sandbox.findMessageNodeByDisplayItem(item);
  };
}

function testDisplayItemNodeCacheHasNoDirectDomPointerAssignments() {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf-8');
  assert.doesNotMatch(source, /__chatuiNode\s*=/,
    'all display-item node caches must live outside serializable display data');
  assert.ok((source.match(/displayItemNodeCache\.set\(/g) || []).length >= 2,
    'both lookup and node creation must populate the external WeakMap cache');
}

function testDisplayItemNodeCacheDoesNotCreateASerializableDomCycle() {
  const dom = new JSDOM('<main id="messages"><article class="message assistant"></article></main>');
  try {
    const messages = dom.window.document.getElementById('messages');
    const node = messages.querySelector('.message');
    const item = { id: 'display-cycle', role: 'assistant', responseIndex: '1', pending: '1' };
    node.dataset.displayItemId = item.id;
    node.__displayItem = item;

    const find = loadFindMessageNodeFromApp();
    const resolved = find(() => messages)(item);
    assert.strictEqual(resolved, node, 'the first lookup must resolve the display node');

    assert.strictEqual(item.__chatuiNode, undefined,
      'the cache must not attach an enumerable DOM node to persisted display data');
    assert.doesNotThrow(() => JSON.stringify(item),
      'a DOM-to-display-item cycle must not break snapshot JSON cloning');
    assert.ok(!JSON.stringify(item).includes('HTMLElement'));

    const originalQuerySelectorAll = messages.querySelectorAll.bind(messages);
    let scans = 0;
    messages.querySelectorAll = (...args) => {
      scans += 1;
      return originalQuerySelectorAll(...args);
    };
    assert.strictEqual(find(() => messages)(item), node);
    assert.strictEqual(scans, 0, 'a connected cache hit must not rescan the message list');
  } finally {
    dom.window.close();
  }
}

module.exports = [
  testDisplayItemNodeCacheDoesNotCreateASerializableDomCycle,
  testDisplayItemNodeCacheHasNoDirectDomPointerAssignments,
];
