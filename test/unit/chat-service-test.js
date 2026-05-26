#!/usr/bin/env node
const assert = require('assert');
const { extractChatJobText, requestJson, parseSseLine } = require('../../client/services/chat-service');

(async () => {
  assert.deepStrictEqual(extractChatJobText({ choices: [{ message: { content: 'hi', reasoning_content: 'why' } }] }), { content: 'hi', reasoning: 'why', firstTokenMs: null });
  assert.deepStrictEqual(extractChatJobText({ output_text: 'out', reasoning: 'r' }), { content: 'out', reasoning: 'r', firstTokenMs: null });
  assert.deepStrictEqual(extractChatJobText({ choices: [{ message: { content: 'hi' } }], metrics: { firstTokenMs: 321 } }), { content: 'hi', reasoning: '', firstTokenMs: 321 });
  assert.deepStrictEqual(extractChatJobText({ choices: [{ message: { content: [{ type: 'text', text: 'hi' }] } }] }), { content: 'hi', reasoning: '', firstTokenMs: null });
  assert.deepStrictEqual(extractChatJobText({ choices: [{ message: { text: 'hi' } }] }), { content: 'hi', reasoning: '', firstTokenMs: null });
  assert.deepStrictEqual(extractChatJobText({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] }), { content: 'hi', reasoning: '', firstTokenMs: null });
  assert.deepStrictEqual(extractChatJobText({ message: { content: [{ text: 'hi' }] } }), { content: 'hi', reasoning: '', firstTokenMs: null });
  assert.deepStrictEqual(extractChatJobText({ response: { text: 'hi' } }), { content: 'hi', reasoning: '', firstTokenMs: null });

  let call;
  const payload = await requestJson({
    url: 'https://api.example.com/v1/chat/completions',
    payload: { model: 'x' },
    apiKey: 'sk',
    baseUrl: 'https://api.example.com/v1',
    directMode: false,
    headers: { 'x-id': '1' },
    fetchImpl: async (url, options) => {
      call = { url, options };
      return new Response('{"ok":true}', { status: 200 });
    },
    toProxyUrl: (url, baseUrl) => `/api${url.slice(baseUrl.length)}`,
    parseResponseJson: async res => res.json(),
    normalizeError: (_err, body) => body?.error?.message || 'bad',
  });
  assert.deepStrictEqual(payload, { ok: true });
  assert.strictEqual(call.url, '/api/chat/completions');
  assert.deepStrictEqual(JSON.parse(call.options.body).headers, { 'x-id': '1' });

  await assert.rejects(() => requestJson({
    url: '/x', payload: {}, baseUrl: '', directMode: true,
    fetchImpl: async () => new Response('{"error":{"message":"bad"}}', { status: 400 }),
    toProxyUrl: x => x,
    parseResponseJson: async res => res.json(),
    normalizeError: (_err, body) => body.error.message,
  }), /bad/);

  assert.deepStrictEqual(parseSseLine('data: {"choices":[{"delta":{"content":"a"}}]}', event => event.choices[0].delta), { done: false, delta: { content: 'a' } });
  assert.deepStrictEqual(parseSseLine('data: [DONE]', () => ({})), { done: true });
  assert.strictEqual(parseSseLine(': keepalive', () => ({})), null);

  console.log('chat service ok');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
