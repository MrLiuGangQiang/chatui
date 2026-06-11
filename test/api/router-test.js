#!/usr/bin/env node
const assert = require('assert');
const http = require('http');
const { createApp } = require('../../server/app');

const port = Number(process.env.TEST_ROUTER_PORT || 18766);
const upstreamPort = port + 1;
const base = `http://127.0.0.1:${port}`;
const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

async function listen(server) {
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
}

async function json(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

(async () => {
  const { server } = createApp();
  let upstreamRequest = null;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequest = { url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
    await listen(server);

    let res = await fetch(`${base}/api/version`, { method: 'POST' });
    assert.strictEqual(res.status, 405, 'version rejects POST');
    assert.strictEqual((await json(res)).error.message, 'Method Not Allowed', 'method error payload');

    res = await fetch(`${base}/api/chat-jobs/nope`);
    assert.strictEqual(res.status, 404, 'missing chat job returns 404');

    res = await fetch(`${base}/api/image-jobs/nope`);
    assert.strictEqual(res.status, 404, 'missing image job returns 404');

    res = await fetch(`${base}/api/config/public`);
    assert.strictEqual(res.status, 200, 'public config returns 200');
    const publicConfig = await json(res);
    assert.strictEqual(typeof publicConfig.version, 'string', 'public config includes version');
    assert.deepStrictEqual(publicConfig.config, { ui: {}, features: {} }, 'public config exposes safe defaults');

    res = await fetch(`${base}/api/config/public`, { method: 'POST' });
    assert.strictEqual(res.status, 405, 'public config rejects POST');

    res = await fetch(`${base}/api/extract-file`, { method: 'GET' });
    assert.strictEqual(res.status, 405, 'extract rejects GET');

    res = await fetch(`${base}/api/not-allowed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(res.status, 403, 'unknown api path is still handled by proxy allowlist');
    assert.strictEqual((await json(res)).error.code, 'PROXY_PATH_FORBIDDEN', 'proxy path error code');

    res = await fetch(`${base}/api/models`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(res.status, 400, 'proxy validates missing base url');
    assert.strictEqual((await json(res)).error.code, 'INVALID_BASE_URL', 'base url error code');

    res = await fetch(`${base}/api/images/edits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: upstreamBase,
        payload: { model: 'gpt-image-1', prompt: '改图', files: [{ name: 'payload.png', data: 'bad' }] },
        files: [
          { name: 'outer.png', type: 'image/png', data: Buffer.from('outer').toString('base64') },
          { name: 'second.png', type: 'image/png', data: Buffer.from('second').toString('base64') },
        ],
      }),
    });
    assert.strictEqual(res.status, 200, 'image edit proxy accepts base64 files');
    assert.strictEqual(upstreamRequest.url, '/images/edits', 'image edit proxy target path');
    assert.match(upstreamRequest.headers['content-type'], /^multipart\/form-data; boundary=----chatui-image-edit-/, 'image edit proxy sends multipart body');
    const imageEditBody = upstreamRequest.body.toString('utf8');
    assert.match(imageEditBody, /Content-Disposition: form-data; name="model"\r\n\r\ngpt-image-1/, 'image edit proxy keeps model field');
    assert.match(imageEditBody, /Content-Disposition: form-data; name="prompt"\r\n\r\n改图/, 'image edit proxy keeps prompt field');
    assert.match(imageEditBody, /Content-Disposition: form-data; name="image\[\]"; filename="outer\.png"\r\nContent-Type: image\/png\r\n\r\nouter/, 'image edit proxy forwards first OpenAI-compatible image[] file field');
    assert.match(imageEditBody, /Content-Disposition: form-data; name="image\[\]"; filename="second\.png"\r\nContent-Type: image\/png\r\n\r\nsecond/, 'image edit proxy forwards second OpenAI-compatible image[] file field');
    assert.strictEqual((imageEditBody.match(/name="image\[\]"; filename=/g) || []).length, 2, 'image edit proxy forwards multiple image[] files');
    assert.doesNotMatch(imageEditBody, /Content-Disposition: form-data; name="image"; filename=/, 'image edit proxy does not use singular image file field');
    assert.doesNotMatch(imageEditBody, /payload\.png|name="files"/, 'image edit proxy strips json file fields');

    for (let i = 0; i < 4; i += 1) {
      res = await fetch(`${base}/api/chat-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: `chatjob-not-limited-${i}`, baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-limit', payload: {} }),
      });
      assert.strictEqual(res.status, 202, `normal api key request ${i + 1} is not ranking-limited`);
    }

    for (let i = 0; i < 8; i += 1) {
      res = await fetch(`${base}/api/usage/rankings?range=today`, { headers: { 'X-Forwarded-For': '203.0.113.10' } });
      assert.strictEqual(res.status, 200, `ranking refresh ${i + 1} is allowed`);
      const rankingPayload = await json(res);
      assert.notStrictEqual(rankingPayload.limited, true, `ranking refresh ${i + 1} is not limited`);
    }
    assert.strictEqual(res.headers.get('x-ratelimit-limit'), null, 'ranking rate limit header is not set');

    for (let i = 0; i < 8; i += 1) {
      res = await fetch(`${base}/api/usage/personal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.10' },
        body: JSON.stringify({ api_key: 'sk-limit', range: 'today' }),
      });
      assert.strictEqual(res.status, 200, `personal refresh ${i + 1} is allowed`);
      const personalPayload = await json(res);
      assert.notStrictEqual(personalPayload.limited, true, `personal refresh ${i + 1} is not limited`);
    }

    console.log('router ok');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
