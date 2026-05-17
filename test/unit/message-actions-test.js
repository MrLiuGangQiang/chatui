#!/usr/bin/env node
const assert = require('assert');
const { copySuccessState, copyText } = require('../../client/ui/message-actions');

(async () => {
  assert.deepStrictEqual(copySuccessState('<ok>', '<old>'), { className: 'copied', html: '<ok>', restoreHtml: '<old>', timeoutMs: 900 });
  let copied = '';
  await copyText('hello', { writeText: async text => { copied = text; } });
  assert.strictEqual(copied, 'hello');
  console.log('message actions ok');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
