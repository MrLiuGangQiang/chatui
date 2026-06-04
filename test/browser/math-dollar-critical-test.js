#!/usr/bin/env node
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appPort = Number(process.env.TEST_BROWSER_MATH_PORT || 18779);
const cdpPort = Number(process.env.TEST_BROWSER_MATH_CDP_PORT || 18819);
const base = `http://127.0.0.1:${appPort}`;

function startServer() {
  return spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function startBrowser() {
  const userDataDir = fs.mkdtempSync('/tmp/chatui-md-chromium-math-dollar-');
  const child = spawn('/usr/bin/chromium', [
    '--headless=new',
    '--no-sandbox',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { child, userDataDir };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function stopChild(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.signalCode) return resolve();
    const timer = setTimeout(() => { if (child.exitCode === null && !child.killed) child.kill('SIGKILL'); }, 1200);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
async function removeTempDir(dir) {
  for (let i = 0; i < 5; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (err) { if (err?.code !== 'ENOTEMPTY' || i === 4) throw err; await sleep(150); }
  }
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
async function waitFor(fn, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { const result = await fn(); if (result) return result; } catch {}
    await sleep(120);
  }
  throw new Error('timeout waiting for condition');
}
async function waitHttpReady(url) {
  await waitFor(async () => {
    const res = await fetch(url);
    return res.ok;
  });
}
async function connectCdp() {
  const tabs = await waitFor(async () => getJson(`http://127.0.0.1:${cdpPort}/json`));
  const tab = tabs[0];
  assert.ok(tab?.webSocketDebuggerUrl, 'browser cdp tab');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msg = { id: ++id, method, params };
    pending.set(msg.id, { resolve, reject });
    ws.send(JSON.stringify(msg));
  });
  const evalJs = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  return { ws, send, evalJs };
}

(async () => {
  const server = startServer();
  const browser = startBrowser();
  let cdp;
  try {
    await waitHttpReady(`${base}/api/version`);
    cdp = await connectCdp();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*/*', requestStage: 'Request' }] });
    cdp.ws.addEventListener('message', async ev => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.method !== 'Fetch.requestPaused') return;
        await cdp.send('Fetch.fulfillRequest', {
          requestId: msg.params.requestId,
          responseCode: 503,
          responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }, { name: 'Cache-Control', value: 'no-store' }],
          body: Buffer.from('blocked external dependency in test').toString('base64'),
        });
      } catch {}
    });
    await cdp.send('Page.navigate', { url: `${base}/?math-dollar-critical-test=1` });
    await waitFor(async () => cdp.evalJs('!!window.ChatUIMarkdown && !!window.markdownit && !!window.katex && !!document.body'));
    const markdown = JSON.stringify('行内公式：$E = mc^2$\n\n块级公式：\n$$ a^2 + b^2 = c^2 $$\n\n代码：\n```txt\n$E = mc^2$\n```');
    const result = await cdp.evalJs(`(() => {
      const texmathPlugin = window.markdownItTexmath || window.texmath;
      const engine = window.ChatUIMarkdown.createMarkdownEngine();
      const box = document.createElement('div');
      box.innerHTML = engine.render(${markdown});
      const clone = box.cloneNode(true);
      clone.querySelectorAll('pre,code').forEach(node => node.remove());
      return {
        hasKatex: !!window.katex?.renderToString,
        hasPluginDuringRender: !!texmathPlugin,
        katexCount: box.querySelectorAll('.katex').length,
        fallbackCount: box.querySelectorAll('.math-fallback').length,
        rawInlineVisibleOutsideCode: clone.textContent.includes('$E = mc^2$'),
        rawBlockVisibleOutsideCode: clone.textContent.includes('$$ a^2 + b^2 = c^2 $$'),
        codeText: box.querySelector('code')?.textContent || '',
      };
    })()`);
    assert.strictEqual(result.hasKatex, true, JSON.stringify(result));
    assert(result.katexCount >= 2, JSON.stringify(result));
    assert.strictEqual(result.fallbackCount, 0, JSON.stringify(result));
    assert.strictEqual(result.rawInlineVisibleOutsideCode, false, JSON.stringify(result));
    assert.strictEqual(result.rawBlockVisibleOutsideCode, false, JSON.stringify(result));
    assert.strictEqual(result.codeText, '$E = mc^2$\n', JSON.stringify(result));
    console.log('math dollar critical browser ok');
  } finally {
    cdp?.ws?.close?.();
    await Promise.all([stopChild(browser.child), stopChild(server)]);
    await removeTempDir(browser.userDataDir);
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
