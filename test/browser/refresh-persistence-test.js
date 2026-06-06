#!/usr/bin/env node
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const root = require('path').resolve(__dirname, '../..');

const appPort = Number(process.env.TEST_BROWSER_REFRESH_PERSISTENCE_PORT || 18918);
const cdpPort = Number(process.env.TEST_BROWSER_REFRESH_PERSISTENCE_CDP_PORT || 18919);
const base = `http://127.0.0.1:${appPort}`;

function startServer() {
  return spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function startBrowser() {
  const userDataDir = fs.mkdtempSync('/tmp/chatui-refresh-persistence-chromium-');
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
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (err) { reject(err); } });
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
    await sleep(120);
  }
  throw new Error('timeout waiting for condition');
}
async function connectCdp() {
  const tabs = await waitFor(async () => getJson(`http://127.0.0.1:${cdpPort}/json`));
  const ws = new WebSocket(tabs[0].webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const callbacks = pending.get(message.id);
      pending.delete(message.id);
      message.error ? callbacks.reject(new Error(JSON.stringify(message.error))) : callbacks.resolve(message.result);
    }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const message = { id: ++id, method, params };
    pending.set(message.id, { resolve, reject });
    ws.send(JSON.stringify(message));
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
    await waitFor(async () => (await fetch(`${base}/api/version`)).ok);
    cdp = await connectCdp();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: `${base}/?refresh-persistence-test=1` });
    await waitFor(async () => cdp.evalJs('!!window.newSession && !!window.addMessage && !!window.saveDisplayHistory && !!window.persistBeforePageLeave'));

    const beforeReload = await cdp.evalJs(`(() => {
      localStorage.clear();
      window.newSession();
      const stamp = 'refresh-persist-' + Date.now();
      const assistant = stamp + '-assistant';
      window.addMessage('user', stamp);
      window.addMessage('assistant', assistant);
      window.saveDisplayHistory({ includeTransient: true });
      window.persistBeforePageLeave();
      const active = localStorage.getItem('openapi-chat-image-active-session-v1');
      const chatKey = 'openapi-chat-image-chat-v1:' + active;
      const uiKey = 'openapi-chat-image-ui-v1:' + active;
      return {
        stamp,
        assistant,
        active,
        dom: [...document.querySelectorAll('.message .content')].map(node => node.innerText.trim()).filter(Boolean),
        chat: JSON.parse(localStorage.getItem(chatKey) || '[]').map(item => ({ role: item.role, content: item.content })),
        ui: JSON.parse(localStorage.getItem(uiKey) || '[]').map(item => ({ role: item.role, rawText: item.rawText })),
      };
    })()`);

    assert.strictEqual(beforeReload.chat.length, 2, JSON.stringify(beforeReload));
    assert.deepStrictEqual(beforeReload.chat.map(item => item.content), [beforeReload.stamp, beforeReload.assistant], JSON.stringify(beforeReload));
    assert.strictEqual(beforeReload.ui.length, 2, JSON.stringify(beforeReload));

    await cdp.send('Page.navigate', { url: `${base}/?refresh-persistence-test=2` });
    await waitFor(async () => cdp.evalJs('document.readyState === "complete" && !!window.renderActiveSession'));
    const afterReload = await waitFor(async () => {
      const result = await cdp.evalJs(`(() => {
        const active = localStorage.getItem('openapi-chat-image-active-session-v1');
        const chatKey = 'openapi-chat-image-chat-v1:' + active;
        return {
          active,
          messages: [...document.querySelectorAll('.message')].map(node => ({
            cls: node.className,
            rawText: node.dataset.rawText || '',
            contentText: node.querySelector('.content')?.innerText.trim() || '',
          })),
          chat: JSON.parse(localStorage.getItem(chatKey) || '[]').map(item => ({ role: item.role, content: item.content })),
        };
      })()`);
      return result.messages.length >= 2 ? result : null;
    });

    assert.strictEqual(afterReload.active, beforeReload.active, JSON.stringify({ beforeReload, afterReload }));
    assert.deepStrictEqual(afterReload.chat.map(item => item.content), [beforeReload.stamp, beforeReload.assistant], JSON.stringify(afterReload));
    assert.deepStrictEqual(afterReload.messages.map(item => item.contentText), [beforeReload.stamp, beforeReload.assistant], JSON.stringify(afterReload));

    const markdownBeforeReload = await cdp.evalJs(`(() => {
      const md = ${JSON.stringify('```js\nconsole.log(123)\n```\n\n```mermaid\nflowchart TD\nA-->B\n```')};
      window.newSession();
      window.addMessage('assistant', md);
      window.saveDisplayHistory({ includeTransient: true });
      window.persistBeforePageLeave();
      const active = localStorage.getItem('openapi-chat-image-active-session-v1');
      const uiKey = 'openapi-chat-image-ui-v1:' + active;
      const saved = JSON.parse(localStorage.getItem(uiKey) || '[]')[0] || {};
      return { active, html: saved.html || '' };
    })()`);
    assert(!markdownBeforeReload.html.includes('data-copy-bound'), JSON.stringify(markdownBeforeReload));
    assert(!markdownBeforeReload.html.includes('data-mermaid-toggle-bound'), JSON.stringify(markdownBeforeReload));

    await cdp.send('Page.navigate', { url: `${base}/?refresh-persistence-test=3` });
    await waitFor(async () => cdp.evalJs('document.readyState === "complete" && !!window.ChatUIMarkdown'));
    const markdownAfterReload = await waitFor(async () => {
      const result = await cdp.evalJs(`(() => ({
        codeCopyCount: document.querySelectorAll('.code-copy-icon').length,
        mermaidToggleCount: document.querySelectorAll('.mermaid-toggle-btn').length,
        codeCopyBoundAttrs: [...document.querySelectorAll('.code-copy-icon')].map(btn => btn.dataset.copyBound || ''),
        mermaidBoundAttrs: [...document.querySelectorAll('.mermaid-toggle-btn')].map(btn => btn.dataset.mermaidToggleBound || ''),
      }))()`);
      return result.codeCopyCount >= 2 && result.mermaidToggleCount >= 1 ? result : null;
    });
    assert(markdownAfterReload.codeCopyBoundAttrs.every(value => value === ''), JSON.stringify(markdownAfterReload));
    assert(markdownAfterReload.mermaidBoundAttrs.every(value => value === ''), JSON.stringify(markdownAfterReload));

    const actionResult = await cdp.evalJs(`(async () => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copiedText = text; } } });
      window.mermaid = {
        initialize() {},
        render: async id => ({ svg: '<svg id="' + id + '" data-test-mermaid="1"><text>ok</text></svg>' }),
      };
      const codeBtn = document.querySelector('.code-block:not(.mermaid-source-view) .code-copy-icon');
      const mermaidBtn = document.querySelector('.mermaid-toggle-btn');
      codeBtn?.click();
      await new Promise(resolve => setTimeout(resolve, 120));
      mermaidBtn?.click();
      await new Promise(resolve => setTimeout(resolve, 500));
      return {
        copiedText: window.__copiedText || '',
        codeCopied: !!codeBtn?.classList.contains('copied'),
        mermaidState: document.querySelector('.mermaid-render-toggle')?.dataset.mermaidState || mermaidBtn?.dataset.mermaidState || '',
        rendered: document.querySelectorAll('.mermaid[data-mermaid-rendered="1"], .mermaid-rendered-block').length,
      };
    })()`);
    assert.strictEqual(actionResult.copiedText, 'console.log(123)\n', JSON.stringify(actionResult));
    assert.strictEqual(actionResult.codeCopied, true, JSON.stringify(actionResult));
    assert(actionResult.rendered >= 1, JSON.stringify(actionResult));
    console.log('refresh persistence browser ok', JSON.stringify({ active: afterReload.active, messages: afterReload.messages, markdownAfterReload, actionResult }));
  } finally {
    cdp?.ws?.close?.();
    await Promise.all([stopChild(browser.child), stopChild(server)]);
    try { fs.rmSync(browser.userDataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(err => { console.error(err); process.exit(1); });
