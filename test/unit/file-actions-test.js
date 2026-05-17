#!/usr/bin/env node
const assert = require('assert');
const { safeFilenamePart, answerFilename } = require('../../client/ui/file-actions');

assert.strictEqual(safeFilenamePart('a/b:c* d'), 'a b c d');
assert.strictEqual(safeFilenamePart('   '), 'assistant-answer');
assert.strictEqual(safeFilenamePart('x'.repeat(40)), 'x'.repeat(32));
assert.strictEqual(answerFilename({ text: '第一行\n第二行', date: new Date('2026-05-16T15:04:05Z') }), '2026-05-16-15-04-05-第一行.md');
console.log('file actions ok');
