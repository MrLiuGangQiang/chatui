#!/usr/bin/env node
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '../..');
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
    assert.ok(html.includes('./client/app/markdown/dependency-loader.js'), 'loads markdown dependency loader');
    assert.ok(html.includes('./client/app/markdown/browser.js'), 'loads markdown browser renderer');
    const dependencyLoader = await (await fetch(`${base}/client/app/markdown/dependency-loader.js`)).text();
    assert.ok(dependencyLoader.includes('registry.npmmirror.com/markdown-it/14.2.0'), 'uses controlled domestic markdown-it CDN');
    assert.ok(dependencyLoader.includes("local: './vendor/markdown-it.min.js'"), 'markdown CDN has local fallback');
    assert.ok(html.includes('./client/core/browser.js'), 'loads browser core adapter before app');
    assert.ok(html.includes('./client/services/fallback.js'), 'loads browser services fallback before adapter');
    assert.ok(html.includes('./client/services/browser.js'), 'loads browser services adapter before app');
    assert.ok(html.includes('./client/ui/browser.js'), 'loads browser ui adapter before app');
    assert.ok(html.includes('./client/app/browser.js'), 'loads browser app adapter before app');
    assert.ok(html.includes('./styles.css'), 'loads root stylesheet');
    assert.ok(html.includes('./styles/composer.css'), 'loads scoped composer CSS override after base stylesheet');
    assert.ok(html.includes('./styles/messages.css'), 'loads scoped message CSS override after base stylesheet');
    assert.ok(dependencyLoader.includes('registry.npmmirror.com/katex/0.16.47'), 'uses controlled domestic katex CDN');
    assert.ok(dependencyLoader.includes('registry.npmmirror.com/mermaid/11.15.0'), 'uses controlled domestic mermaid CDN');
    assert.ok(dependencyLoader.includes("local: './vendor/katex.min.js'"), 'katex CDN has local fallback');
    assert.ok(dependencyLoader.includes("local: './vendor/mermaid.min.js'"), 'mermaid CDN has local fallback');

    res = await fetch(`${base}/app.js`);
    assert.strictEqual(res.status, 200, 'app js status');
    const appJs = await res.text();
    res = await fetch(`${base}/client/core/browser.js`);
    assert.strictEqual(res.status, 200, 'browser core status');
    const browserCore = await res.text();
    assert.ok(browserCore.includes('window.ChatUICore'), 'browser core exposes stable namespace');

    res = await fetch(`${base}/client/services/fallback.js`);
    assert.strictEqual(res.status, 200, 'browser services fallback status');
    const browserServicesFallback = await res.text();
    assert.ok(browserServicesFallback.includes('window.ChatUIServicesFallback'), 'browser services fallback exposes internal namespace');

    res = await fetch(`${base}/client/services/browser.js`);
    assert.strictEqual(res.status, 200, 'browser services status');
    const browserServices = await res.text();
    assert.ok(browserServices.includes('window.ChatUIServices'), 'browser services exposes stable namespace');
    assert.ok(!browserServices.includes('ROUTE_SYSTEM_PROMPT ='), 'browser services adapter does not duplicate route prompt');

    res = await fetch(`${base}/client/ui/browser.js`);
    assert.strictEqual(res.status, 200, 'browser ui status');
    const browserUi = await res.text();
    assert.ok(browserUi.includes('window.ChatUI'), 'browser ui exposes stable namespace');

    res = await fetch(`${base}/client/app/browser.js`);
    assert.strictEqual(res.status, 200, 'browser app status');
    const browserApp = await res.text();
    assert.ok(browserApp.includes('window.ChatUIApp'), 'browser app exposes stable namespace');

    res = await fetch(`${base}/client/app/scroll-focus-workflow.js`);
    assert.strictEqual(res.status, 200, 'scroll focus workflow status');
    const scrollFocusWorkflow = await res.text();

    assert.ok(dependencyLoader.includes('id: \'mermaid\'') || dependencyLoader.includes('id: "mermaid"'), 'mermaid is loaded through markdown dependency loader');
    assert.ok(dependencyLoader.includes('registry.npmmirror.com/mermaid/11.15.0'), 'lazy mermaid uses npmmirror CDN');
    assert.ok(dependencyLoader.includes('./vendor/mermaid.min.js'), 'lazy mermaid keeps local fallback');
    assert.ok(appJs.includes('function beginRenameSession'), 'inline session rename function exists');
    assert.ok(appJs.includes('customTitle'), 'custom session title is persisted');
    assert.ok(appJs.includes('session-rename-btn'), 'session rename button is rendered');
    assert.ok(appJs.includes('isNodeAwayFromOutputFocus'), 'resume stream visibility adapter exists');
    assert.ok(scrollFocusWorkflow.includes('ChatUI?.scroll?.isNodeAwayFromOutputFocus') || scrollFocusWorkflow.includes('t.bottom>o+40'), 'resume button appears when output is away from focus');
    assert.ok(scrollFocusWorkflow.includes('resumeButtonSuppressUntil'), 'resume button is suppressed briefly after click');
    assert.ok(appJs.includes('lockToStreamingOutput'), 'resume locks to active streaming output adapter exists');
    assert.ok(scrollFocusWorkflow.includes('streamFocusLocked'), 'stream focus lock state exists');
    assert.ok(scrollFocusWorkflow.includes('state.streamFocusLocked=!1'), 'manual scrolling unlocks stream focus');
    assert.ok(scrollFocusWorkflow.includes('document.querySelectorAll(\'.message[data-streaming="1"]\')'), 'resume button can recover active streaming node');
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

    res = await fetch(`${base}/styles/composer.css`);
    assert.strictEqual(res.status, 200, 'composer styles status');
    const composerCss = await res.text();
    assert.ok(composerCss.includes('Composer layout contract overrides'), 'composer styles include contract comment');
    assert.ok(composerCss.includes('.composer-actions'), 'composer styles include action row rules');
    assert.ok(composerCss.includes('env(safe-area-inset-bottom)'), 'composer styles include mobile safe area handling');
    assert.ok(!composerCss.includes('#configModal'), 'composer styles do not touch config modal');
    assert.ok(!composerCss.includes('.prompt-config-layout'), 'composer styles do not touch prompt config layout');
    assert.ok(!composerCss.includes('.markdown-body'), 'composer styles do not touch markdown content');

    res = await fetch(`${base}/styles/messages.css`);
    assert.strictEqual(res.status, 200, 'message styles status');
    const messageCss = await res.text();
    assert.ok(messageCss.includes('Message layout contract overrides'), 'message styles include contract comment');
    assert.ok(messageCss.includes('.message-meta'), 'message styles include timing meta rules');
    assert.ok(messageCss.includes('padding-bottom:0!important'), 'message styles keep timing meta out of normal layout');

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
