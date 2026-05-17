#!/usr/bin/env node
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appPort = Number(process.env.TEST_BROWSER_CORE_PORT || 18767);
const cdpPort = Number(process.env.TEST_BROWSER_CORE_CDP_PORT || 18802);
const base = `http://127.0.0.1:${appPort}`;

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

function startBrowser() {
  const userDataDir = fs.mkdtempSync('/tmp/chatui-core-browser-');
  const child = spawn('/usr/bin/chromium', [
    '--headless=new',
    '--no-sandbox',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { child, userDataDir };
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function waitFor(fn, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {}
    await new Promise(r => setTimeout(r, 120));
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
    await cdp.send('Page.navigate', { url: base });
    await new Promise(r => setTimeout(r, 1000));
    const result = await cdp.evalJs(`(() => ({
      core: !!window.ChatUICore,
      http: window.ChatUICore?.http?.normalizeError(null, { error: { code: 'X' } }),
      reasoning: window.ChatUICore?.reasoning?.extractStreamDelta({ choices: [{ delta: { content: 'hi', reasoning_content: 'why' } }] }).reasoning,
      modelType: window.ChatUICore?.models?.normalizeModelType('gpt-image'),
      imageFile: window.ChatUICore?.attachments?.isImageFile({ name: 'a.png', type: '' }),
      services: !!window.ChatUIServices?.models?.requestModels,
      jobs: !!window.ChatUIServices?.jobs?.startChatJob && /^chatjob-/.test(window.ChatUIServices.jobs.makeClientChatJobId()),
      chat: window.ChatUIServices?.chat?.extractChatJobText({ output_text: 'ok' }).content,
      image: window.ChatUIServices?.images?.extractImageResult({ data: [{ b64_json: 'abc' }] }).src,
      ui: window.ChatUI?.fileActions?.safeFilenamePart('a/b'),
      realtime: !!window.ChatUI?.realtime?.createRealtimeRenderer,
      scroll: window.ChatUI?.scroll?.activeOutputBottomTarget({ composerTop: 500, viewportHeight: 800, margin: 24 }),
      messageSummary: window.ChatUI?.messages?.attachmentsSummaryMarkdown([{ name: 'a.txt' }]),
      actions: window.ChatUI?.actions?.copySuccessState('ok', 'old').timeoutMs,
      imageActions: window.ChatUI?.imageActions?.imageActionButtonsHtml('x','a.png').includes('data-share-image'),
      appState: !!window.ChatUIApp?.state?.createSession,
      appRuns: !!window.ChatUIApp?.runs?.ensureActiveRun,
      appSessions: window.ChatUIApp?.sessions?.deriveSessionTitle({ messages: [{ role: 'user', content: 'hello' }] }),
      displayItems: window.ChatUIApp?.displayItems?.displayItemHasRichMedia({ html: '<img class="generated-thumb" />' }),
      appReady: !!document.querySelector('#prompt')
    }))()`);
    assert.deepStrictEqual(result, { core: true, http: 'X', reasoning: 'why', modelType: 'image', imageFile: true, services: true, jobs: true, chat: 'ok', image: 'data:image/png;base64,abc', ui: 'a b', realtime: true, scroll: 476, messageSummary: '\n\n📎 a.txt', actions: 900, imageActions: true, appState: true, appRuns: true, appSessions: 'hello', displayItems: true, appReady: true });
    console.log('browser core ok');
  } finally {
    cdp?.ws?.close?.();
    browser.child.kill('SIGTERM');
    server.kill('SIGTERM');
    setTimeout(() => browser.child.kill('SIGKILL'), 1000).unref?.();
    setTimeout(() => server.kill('SIGKILL'), 1000).unref?.();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
