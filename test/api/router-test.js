#!/usr/bin/env node
const assert = require('assert');
const { createApp } = require('../../server/app');

const port = Number(process.env.TEST_ROUTER_PORT || 18766);
const base = `http://127.0.0.1:${port}`;

async function listen(server) {
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
}

async function json(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

(async () => {
  const { server } = createApp();
  try {
    await listen(server);

    let res = await fetch(`${base}/api/version`, { method: 'POST' });
    assert.strictEqual(res.status, 405, 'version rejects POST');
    assert.strictEqual((await json(res)).error.message, 'Method Not Allowed', 'method error payload');

    res = await fetch(`${base}/api/chat-jobs/nope`);
    assert.strictEqual(res.status, 404, 'missing chat job returns 404');

    res = await fetch(`${base}/api/image-jobs/nope`);
    assert.strictEqual(res.status, 404, 'missing image job returns 404');

    res = await fetch(`${base}/api/extract-file`, { method: 'GET' });
    assert.strictEqual(res.status, 405, 'extract rejects GET');

    res = await fetch(`${base}/api/not-allowed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(res.status, 403, 'unknown api path is still handled by proxy allowlist');
    assert.strictEqual((await json(res)).error.code, 'PROXY_PATH_FORBIDDEN', 'proxy path error code');

    res = await fetch(`${base}/api/models`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(res.status, 400, 'proxy validates missing base url');
    assert.strictEqual((await json(res)).error.code, 'INVALID_BASE_URL', 'base url error code');

    console.log('router ok');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
