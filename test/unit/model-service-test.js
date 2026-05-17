#!/usr/bin/env node
const assert = require('assert');
const { requestModels } = require('../../client/services/model-service');

(async () => {
  await assert.rejects(() => requestModels({ baseUrl: '', parseResponseJson: async () => null, normalizeError: () => 'x' }), /请先配置/);

  let captured;
  const payload = await requestModels({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response('{"data":[{"id":"gpt-4.1"}]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    parseResponseJson: async res => res.json(),
    normalizeError: (_err, body) => body?.error?.message || 'bad',
  });
  assert.deepStrictEqual(payload, { data: [{ id: 'gpt-4.1' }] });
  assert.strictEqual(captured.url, '/api/models');
  assert.strictEqual(JSON.parse(captured.options.body).method, 'GET');

  await assert.rejects(() => requestModels({
    baseUrl: 'https://api.example.com/v1',
    fetchImpl: async () => new Response('{"error":{"message":"no"}}', { status: 400 }),
    parseResponseJson: async res => res.json(),
    normalizeError: (_err, body) => body.error.message,
  }), /no/);

  console.log('model service ok');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
