#!/usr/bin/env node
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appPort = Number(process.env.TEST_LONG_HISTORY_PORT || 18769);
const cdpPort = Number(process.env.TEST_LONG_HISTORY_CDP_PORT || 18804);
const base = `http://127.0.0.1:${appPort}`;

function startServer() { return spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] }); }
function startBrowser() { const userDataDir = fs.mkdtempSync('/tmp/chatui-md-chromium-long-history-'); const child = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] }); return { child, userDataDir }; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function stopChild(child) { return new Promise(resolve => { if (!child || child.exitCode !== null || child.signalCode) return resolve(); const timer = setTimeout(() => { if (child.exitCode === null && !child.killed) child.kill('SIGKILL'); }, 1200); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); }); }
function getJson(url) { return new Promise((resolve, reject) => http.get(url, res => { let data = ''; res.on('data', c => { data += c; }); res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } }); }).on('error', reject)); }
async function waitFor(fn, ms = 12000) { const start = Date.now(); while (Date.now() - start < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(120); } throw new Error('timeout waiting for condition'); }
async function connectCdp() { const tabs = await waitFor(async () => getJson(`http://127.0.0.1:${cdpPort}/json`)); const ws = new WebSocket(tabs[0].webSocketDebuggerUrl); let id = 0; const pending = new Map(); ws.onmessage = ev => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); } }; await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }); const send = (method, params = {}) => new Promise((resolve, reject) => { const msg = { id: ++id, method, params }; pending.set(msg.id, { resolve, reject }); ws.send(JSON.stringify(msg)); }); const evalJs = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result?.value; }; return { ws, send, evalJs }; }

(async () => {
  const server = startServer();
  const browser = startBrowser();
  let cdp;
  try {
    await waitFor(async () => (await fetch(`${base}/api/version`)).ok);
    cdp = await connectCdp();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: base });
    await waitFor(async () => cdp.evalJs('!!window.ChatUIMarkdown && !!document.getElementById("messages")'));
    const browserScript = String.raw`(async () => {
      const fence = String.fromCharCode(96).repeat(3);
      const longMd = (i) => '# Report ' + i + '\n\n' + Array.from({length: 16}, (_, n) => 'Paragraph ' + n + ' with **bold** and $a_' + n + '+b_' + n + '$.').join('\n\n') + '\n\n| A | B | C |\n| - | -: | :-: |\n| 1 | 2 | 3 |\n\n' + fence + 'js\nconsole.log("row", ' + i + ');\n' + fence + '\n\n' + fence + 'mermaid\ngraph TD; A' + i + '-->B' + i + ';\n' + fence + '\n';
      const messagesEl = document.getElementById('messages');
      messagesEl.style.height = '520px';
      messagesEl.style.maxHeight = '520px';
      messagesEl.style.overflowY = 'auto';
      messagesEl.innerHTML = '';
      const t0 = performance.now();
      for (let i = 0; i < 100; i += 1) window.addMessage(i % 2 ? 'user' : 'assistant', longMd(i), { rawText: longMd(i), lazy: true, deferSave: true, noScroll: i < 99 });
      const syncMs = performance.now() - t0;
      await new Promise(r => setTimeout(r, 250));
      const messages = [...document.querySelectorAll('#messages .message')];
      window.ChatUI?.performance?.renderCache?.render?.(longMd(0), window.ChatUIApp.markdown.renderMarkdown);
      const before = { syncMs: Math.round(syncMs), count: messages.length, lazy: messages.filter(n => n.dataset.lazyMarkdown === '1').length, virtualized: messages.filter(n => n.dataset.virtualized === '1').length, rendered: messages.filter(n => n.dataset.renderedHash).length, mermaidRendered: document.querySelectorAll('.mermaid-rendered-block').length, pendingMermaid: document.querySelectorAll('.markdown-mermaid-pending').length, domNodes: document.querySelectorAll('#messages *').length, stats: window.ChatUI?.performance?.renderCache?.stats?.(), perf: window.ChatUIPerf?.getStats?.(), flags: window.ChatUIPerformanceFlags, perfLog: window.__chatuiPerfLog || [] };
      messagesEl.scrollTop = 0;
      messages[0].scrollIntoView({ block: 'center' });
      window.chatuiRenderLazyMessage?.(messages[0], { force: true });
      await new Promise(r => setTimeout(r, 900));
      const afterScroll = { renderedFirst: messages[0].dataset.renderedHash || '', lazyFirst: messages[0].dataset.lazyMarkdown || '', virtualizedNow: [...document.querySelectorAll('#messages .message')].filter(n => n.dataset.virtualized === '1').length, domNodes: document.querySelectorAll('#messages *').length };
      messagesEl.scrollTop = messagesEl.scrollHeight;
      await new Promise(r => setTimeout(r, 500));
      return { ...before, afterScroll };
    })()`;
    const summary = await cdp.evalJs(browserScript);
    assert.strictEqual(summary.count, 100, `100 messages rendered as windowed nodes/placeholders: ${JSON.stringify(summary)}`);
    assert(summary.perf?.modules?.cache && summary.perf?.modules?.scheduler && summary.perf?.modules?.virtualizer, `performance layer should initialize on real app: ${JSON.stringify(summary)}`);
    assert(summary.perf?.container?.selector === '#messages' && summary.perf?.container?.overflowY === 'auto', `real messages scroll container should be detected: ${JSON.stringify(summary)}`);
    assert(summary.stats?.hits >= 1, `repeated markdown render should hit cache: ${JSON.stringify(summary)}`);
    assert(summary.lazy >= 20 || summary.virtualized >= 20, `long history should leave many messages lazy/virtualized: ${JSON.stringify(summary)}`);
    assert(summary.mermaidRendered < 50, `should not synchronously render all mermaid diagrams: ${JSON.stringify(summary)}`);
    assert(summary.syncMs < 3500, `history render should return promptly: ${JSON.stringify(summary)}`);
    assert(summary.afterScroll.renderedFirst || summary.afterScroll.lazyFirst === '0', `scrolling to history should hydrate first message: ${JSON.stringify(summary)}`);
    console.log(`long history browser ok: ${JSON.stringify(summary)}`);
  } finally {
    cdp?.ws?.close?.();
    await Promise.all([stopChild(browser.child), stopChild(server)]);
    try { fs.rmSync(browser.userDataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(err => { console.error(err); process.exit(1); });
