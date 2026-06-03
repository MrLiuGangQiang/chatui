const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('app.js', 'utf8');
const match = source.match(/function escapeHtml\([^]*?\}\[e\]\)\)\}/);
assert(match, 'escapeHtml implementation should be present');

const context = {};
vm.runInNewContext(`${match[0]}; this.escapeHtml = escapeHtml; this.escapeAttr = escapeHtml;`, context);
const { escapeHtml, escapeAttr } = context;

const input = '&<>"\'`';
const expected = '&amp;&lt;&gt;&quot;&#39;&#96;';
assert.strictEqual(escapeHtml(input), expected);
assert.strictEqual(escapeAttr(input), expected);
assert(!escapeHtml(input).includes('`'), 'backtick should be escaped');
console.log('escapeHtml/escapeAttr escaped & < > " \' `');
