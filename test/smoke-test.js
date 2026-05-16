#!/usr/bin/env node
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.TEST_PORT || 18765);
const base = `http://127.0.0.1:${port}`;

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', d => { output += d.toString(); });
  child.stderr.on('data', d => { output += d.toString(); });
  return { child, getOutput: () => output };
}

async function waitReady(child, ms = 8000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (child.exitCode !== null) throw new Error(`server exited: ${child.exitCode}`);
    try {
      const res = await fetch(`${base}/api/version`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error('server not ready');
}

async function json(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

(async () => {
  const server = startServer();
  try {
    await waitReady(server.child);

    let res = await fetch(`${base}/api/version`);
    assert.strictEqual(res.status, 200, 'version status');
    assert.ok((await json(res)).version, 'version payload');
    assert.ok(res.headers.get('x-content-type-options'), 'security header exists');
    const csp = res.headers.get('content-security-policy') || '';
    assert.ok(csp, 'csp header exists');
    assert.ok(csp.includes('connect-src') && csp.includes('data:') && csp.includes('blob:'), 'csp allows image data/blob processing');

    res = await fetch(`${base}/`);
    assert.strictEqual(res.status, 200, 'index status');
    const html = await res.text();
    assert.ok(html.includes('./vendor/markdown-it.min.js'), 'uses local markdown vendor');
    assert.ok(!html.includes('registry.npmmirror.com'), 'no CDN in index');

    res = await fetch(`${base}/app.js`);
    assert.strictEqual(res.status, 200, 'app js status');
    const appJs = await res.text();
    assert.ok(appJs.includes('function beginRenameSession'), 'inline session rename function exists');
    assert.ok(appJs.includes('customTitle'), 'custom session title is persisted');
    assert.ok(appJs.includes('session-rename-btn'), 'session rename button is rendered');
    assert.ok(appJs.includes('isNodeAwayFromOutputFocus'), 'resume stream visibility check exists');
    assert.ok(appJs.includes('t.bottom>o+40'), 'resume button appears when output is away from focus');
    assert.ok(appJs.includes('resumeButtonSuppressUntil'), 'resume button is suppressed briefly after click');
    assert.ok(appJs.includes('outputPinSuppressUntil'), 'output pinning is suppressed briefly after resume click');
    assert.ok(appJs.includes('isNearMessagesBottom(12)'), 'manual scroll has strict bottom threshold');
    assert.ok(appJs.includes('Date.now()+1500'), 'manual scrolling suppresses output pinning');
    assert.ok(appJs.includes('document.querySelectorAll(\'.message[data-streaming="1"]\')'), 'resume button can recover active streaming node');
    assert.ok(appJs.includes('session-title-input'), 'session rename uses inline input');
    assert.ok(appJs.includes('保存会话名称'), 'rename button becomes save button');
    assert.ok(!appJs.includes('会话名称已保存'), 'rename save does not show toast');
    assert.ok(!appJs.includes('prompt("重命名会话"'), 'session rename does not use prompt dialog');

    res = await fetch(`${base}/styles.css`);
    assert.strictEqual(res.status, 200, 'styles status');
    const css = await res.text();
    assert.ok(css.includes('.session-rename-btn'), 'session rename button styles exist');
    assert.ok(css.includes('.session-title-input'), 'inline session rename input styles exist');
    assert.ok(css.includes('.session-rename-btn.saving'), 'save-state rename button styles exist');

    for (const file of ['markdown-it.min.js', 'katex.min.js', 'katex.min.css', 'mermaid.min.js', 'fonts/KaTeX_Main-Regular.woff2', 'fonts/KaTeX_Math-Italic.woff2', 'fonts/KaTeX_Size2-Regular.woff2']) {
      res = await fetch(`${base}/vendor/${file}`);
      assert.strictEqual(res.status, 200, `vendor ${file}`);
    }


    res = await fetch(`${base}/api/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:1/image.png' }),
    });
    assert.strictEqual(res.status, 400, 'image proxy missing baseUrl returns 400, not server error');

    res = await fetch(`${base}/api/not-allowed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(res.status, 403, 'proxy allowlist rejects unknown path');

    res = await fetch(`${base}/api/models`, { method: 'GET' });
    assert.strictEqual(res.status, 405, 'proxy method rejects GET');

    res = await fetch(`${base}/api/chat-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'http://127.0.0.1:1/v1', payload: {} }),
    });
    assert.strictEqual(res.status, 202, 'chat job can be registered against local upstream by default');
    const job = await json(res);
    assert.ok(job.id?.startsWith('chatjob-'), 'chat job id');

    res = await fetch(`${base}/api/chat-jobs/${encodeURIComponent(job.id)}/abort`, { method: 'POST' });
    assert.strictEqual(res.status, 200, 'chat job abort status');
    assert.strictEqual((await json(res)).status, 'error', 'chat job abort payload');

    res = await fetch(`${base}/api/image-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'http://127.0.0.1:1/v1', payload: { prompt: 'x' } }),
    });
    assert.strictEqual(res.status, 202, 'image job can be registered');
    const imageJob = await json(res);
    assert.ok(imageJob.id?.startsWith('imgjob-'), 'image job id');

    res = await fetch(`${base}/api/image-jobs/${encodeURIComponent(imageJob.id)}/abort`, { method: 'POST' });
    assert.strictEqual(res.status, 200, 'image job abort status');

    console.log('smoke ok');
  } finally {
    server.child.kill('SIGTERM');
    setTimeout(() => server.child.kill('SIGKILL'), 1000).unref?.();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
