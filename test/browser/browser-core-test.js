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
  const userDataDir = fs.mkdtempSync('/tmp/chatui-md-chromium-core-');
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
    const timer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    }, 1200);
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
    await cdp.send('Network.enable');
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://cdn.jsdelivr.net/*', requestStage: 'Request' }] });
    cdp.ws.addEventListener('message', async ev => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.method !== 'Fetch.requestPaused') return;
        await cdp.send('Fetch.fulfillRequest', {
          requestId: msg.params.requestId,
          responseCode: 204,
          responseHeaders: [
            { name: 'Access-Control-Allow-Origin', value: '*' },
            { name: 'Cache-Control', value: 'no-store' },
            { name: 'Content-Type', value: 'text/plain' },
          ],
          body: '',
        });
      } catch {}
    });
    await cdp.send('Page.navigate', { url: base });
    await waitFor(async () => cdp.evalJs(`!!window.ChatUICore && !!window.ChatUIServices && !!window.ChatUI && !!window.ChatUIApp && !!document.querySelector('#prompt')`));
    const result = await cdp.evalJs(`(() => ({
      core: !!window.ChatUICore,
      http: window.ChatUICore?.http?.normalizeError(null, { error: { code: 'X' } }),
      reasoning: window.ChatUICore?.reasoning?.extractStreamDelta({ choices: [{ delta: { content: 'hi', reasoning_content: 'why' } }] }).reasoning,
      modelType: window.ChatUICore?.models?.normalizeModelType('gpt-image'),
      imageFile: window.ChatUICore?.attachments?.isImageFile({ name: 'a.png', type: '' }),
      imageReferenceId: window.ChatUICore?.imageReferences?.makeImageReferenceId('display 1'),
      routeReferenceCount: window.ChatUICore?.imageRouteContext?.collectRecentImageReferences({ display: [{ id: 'd1', role: 'assistant', html: '<img data-persisted-src=\"indexeddb://x\" data-filename=\"x.png\" />' }] }).length,
      routeContextLimited: window.ChatUICore?.imageRouteContext?.routeContextSize(window.ChatUICore.imageRouteContext.buildRouteContext({ messages: Array.from({ length: 200 }, (_, i) => ({ role: 'user', content: 'x'.repeat(2000) + i })), maxChars: 262144 })) <= 262144,
      services: !!window.ChatUIServices?.models?.requestModels,
      jobs: !!window.ChatUIServices?.jobs?.startChatJob && /^chatjob-/.test(window.ChatUIServices.jobs.makeClientChatJobId()),
      chat: window.ChatUIServices?.chat?.extractChatJobText({ output_text: 'ok' }).content,
      route: window.ChatUIServices?.route?.parseRouteResult('image')?.target,
      image: window.ChatUIServices?.images?.extractImageResult({ data: [{ b64_json: 'abc' }, { url: 'https://x/b.png' }] }).images?.length,
      imagePrompt: window.ChatUIServices?.images?.buildImagePromptWithStylePrompt('猫', '水彩'),
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
    assert.deepStrictEqual(result, { core: true, http: 'X', reasoning: 'why', modelType: 'image', imageFile: true, imageReferenceId: 'imgref_display_1', routeReferenceCount: 1, routeContextLimited: true, services: true, jobs: true, chat: 'ok', route: 'new', image: 2, imagePrompt: '猫\n\n图片样式要求：\n水彩', ui: 'a b', realtime: true, scroll: 476, messageSummary: '\n\n📎 a.txt', actions: 2000, imageActions: true, appState: true, appRuns: true, appSessions: 'hello', displayItems: true, appReady: true });
    console.log('browser core ok');
  } finally {
    cdp?.ws?.close?.();
    await Promise.all([stopChild(browser.child), stopChild(server)]);
    await removeTempDir(browser.userDataDir);
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
