#!/usr/bin/env node
const assert = require('assert');
const { normalizeModelType, inferModelType, normalizeModelMeta, isModelAllowedFor, extractModels } = require('../../client/core/models');

assert.strictEqual(normalizeModelType('images'), 'image');
assert.strictEqual(normalizeModelType('LLM'), 'chat');
assert.strictEqual(inferModelType({ id: 'text-embedding-3-small' }), 'embedding');
assert.strictEqual(inferModelType({ id: 'gpt-image-1' }), 'image');
assert.strictEqual(inferModelType({ id: 'gpt-4.1' }), 'chat');
assert.deepStrictEqual(normalizeModelMeta(['gpt-4.1', 'gpt-image-1'], { 'gpt-4.1': { type: 'llm' } }), {
  'gpt-4.1': { id: 'gpt-4.1', type: 'chat', unrecognized: false },
  'gpt-image-1': { id: 'gpt-image-1', type: 'image', unrecognized: false },
});
assert.strictEqual(isModelAllowedFor('gpt-image-1', 'chat', { 'gpt-image-1': { type: 'image' } }), false);
assert.strictEqual(isModelAllowedFor('unknown', 'chat', {}), true);
assert.deepStrictEqual(extractModels({ data: [{ id: 'gpt-4.1' }, { id: 'dall-e-3' }] }), [
  { id: 'gpt-4.1', type: 'chat' },
  { id: 'dall-e-3', type: 'image' },
]);
console.log('models ok');
