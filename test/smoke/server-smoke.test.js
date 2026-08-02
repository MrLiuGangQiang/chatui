const assert = require('assert');

const { createApp } = require('../../server/app');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  });
}

async function request(baseUrl, path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, { redirect: 'manual', ...options });
  const text = await res.text();
  return { res, text };
}

async function withSmokeServer(run) {
  const { server } = createApp();
  const baseUrl = await listen(server);
  try {
    await run(baseUrl);
  } finally {
    await close(server);
  }
}

async function testServerSmokeCoreEndpoints() {
  await withSmokeServer(async baseUrl => {
    const home = await request(baseUrl, '/');
    assert.strictEqual(home.res.status, 200);
    assert.match(home.res.headers.get('content-type') || '', /text\/html/);
    assert.ok(home.text.includes('<title>ChatUI</title>'));
    const jsMatch = home.text.match(/\.\/assets\/chatui\.bundle\.js\?v=([a-f0-9]{32})/);
    const cssMatch = home.text.match(/\.\/assets\/chatui\.bundle\.css\?v=([a-f0-9]{32})/);
    assert.ok(jsMatch && cssMatch, 'index must expose content-addressed bundle URLs');

    const js = await request(baseUrl, `/assets/chatui.bundle.js?v=${jsMatch[1]}`);
    const css = await request(baseUrl, `/assets/chatui.bundle.css?v=${cssMatch[1]}`);
    assert.strictEqual(js.res.headers.get('etag')?.replace(/"/g, ''), jsMatch[1], 'the JS URL revision must match its bundle ETag');
    assert.strictEqual(css.res.headers.get('etag')?.replace(/"/g, ''), cssMatch[1], 'the CSS URL revision must match its bundle ETag');

    const version = await request(baseUrl, '/api/version');
    assert.strictEqual(version.res.status, 200);
    assert.match(version.res.headers.get('content-type') || '', /application\/json/);
    const versionIdentity = JSON.parse(version.text);
    assert.ok(versionIdentity.version, 'version endpoint should expose app version');
    assert.ok(versionIdentity.gitSha, 'version endpoint should expose the exact source commit');
    assert.match(versionIdentity.sourceRevision, /^sha256:[a-f0-9]{64}$/, 'version endpoint should expose the exact runtime source fingerprint');

    const publicConfig = await request(baseUrl, '/api/config/public');
    assert.strictEqual(publicConfig.res.status, 200);
    assert.match(publicConfig.res.headers.get('content-type') || '', /application\/json/);
    const config = JSON.parse(publicConfig.text);
    assert.ok(config.version, 'public config should expose app version');
    assert.ok(config.config && typeof config.config === 'object', 'public config should expose config object');

    const supportedFiles = await request(baseUrl, '/pages/files.html');
    assert.strictEqual(supportedFiles.res.status, 200);
    assert.match(supportedFiles.res.headers.get('content-type') || '', /text\/html/);
    assert.ok(supportedFiles.text.includes('<title>支持的文件格式</title>'));

    const routeMap = await request(baseUrl, '/pages/route.html');
    assert.strictEqual(routeMap.res.status, 200);
    assert.match(routeMap.res.headers.get('content-type') || '', /text\/html/);
    assert.ok(routeMap.text.includes('你的消息怎样变成任务'));

  });
}

async function testServerSmokeBundledAssets() {
  await withSmokeServer(async baseUrl => {
    const js = await request(baseUrl, '/assets/chatui.bundle.js');
    assert.strictEqual(js.res.status, 200);
    assert.match(js.res.headers.get('content-type') || '', /javascript/);
    assert.ok(js.text.includes('ChatUI'), 'JS bundle should include ChatUI code');

    const css = await request(baseUrl, '/assets/chatui.bundle.css');
    assert.strictEqual(css.res.status, 200);
    assert.match(css.res.headers.get('content-type') || '', /text\/css/);
    assert.ok(css.text.includes('session-sidebar') || css.text.includes('composer'), 'CSS bundle should include app styles');
  });
}

module.exports = [
  testServerSmokeCoreEndpoints,
  testServerSmokeBundledAssets,
];
