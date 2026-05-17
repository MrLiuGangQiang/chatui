#!/usr/bin/env node
const assert = require('assert');
const { normalizeError, toProxyUrl, parseResponseJson } = require('../../client/core/http');

(async () => {
  assert.strictEqual(normalizeError(null, { error: { message: '上游错误', code: 'UPSTREAM' } }), '上游错误');
  assert.strictEqual(normalizeError(null, { error: { code: 'ONLY_CODE' } }), 'ONLY_CODE');
  assert.strictEqual(normalizeError(new Error('fallback'), null), 'fallback');
  assert.strictEqual(toProxyUrl('https://api.example.com/v1/models', 'https://api.example.com/v1'), '/api/models');
  assert.strictEqual(toProxyUrl('https://other.example.com/v1/models', 'https://api.example.com/v1'), 'https://other.example.com/v1/models');

  const ok = await parseResponseJson(new Response('{"ok":true}'));
  assert.deepStrictEqual(ok, { ok: true });
  const raw = await parseResponseJson(new Response('not json'));
  assert.deepStrictEqual(raw, { raw: 'not json' });
  console.log('client core ok');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
