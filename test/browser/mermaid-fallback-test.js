#!/usr/bin/env node
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appPort = Number(process.env.TEST_MERMAID_FALLBACK_PORT || 18769);
const cdpPort = Number(process.env.TEST_MERMAID_FALLBACK_CDP_PORT || 18804);
const base = `http://127.0.0.1:${appPort}`;

function startServer() { return spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] }); }
function startBrowser() { const userDataDir = fs.mkdtempSync('/tmp/chatui-md-chromium-mermaid-fallback-'); const child = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] }); return { child, userDataDir }; }
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
    await waitFor(async () => cdp.evalJs('!!window.ChatUIMarkdown && !!document.body'));
    const summary = await cdp.evalJs(`(async () => {
      window.requestIdleCallback = (cb, opts) => 900001;
      window.cancelIdleCallback = () => {};
      await window.ChatUIMarkdownReady;
      const box = document.createElement('div');
      box.className = 'markdown-body';
      box.style.cssText = 'position:absolute; top:5000px; width:900px; padding:24px; background:white; color:black;';
      document.body.replaceChildren(box);
      const nl = String.fromCharCode(10);
      const sources = ['flowchart TD' + nl + '  A --> B', 'sequenceDiagram' + nl + '  A->>B: hi', 'pie title Pets' + nl + '  "Dogs" : 4' + nl + '  "Cats" : 3', 'erDiagram' + nl + '  USER ||--o{ POST : writes'];
      const fence = String.fromCharCode(96,96,96);
      const md = sources.map(src => fence + 'mermaid' + nl + src + nl + fence).join(nl + nl);
      const rendered = await window.ChatUIMarkdown.renderMarkdownInto(box, md, { mermaidFallbackMs: 80, loadMermaid: async () => { throw new Error('should not auto-load'); } });
      await new Promise(r => setTimeout(r, 320));
      const before = { resultCount: rendered.mermaid.length, pending: box.querySelectorAll('.markdown-mermaid-pending').length, toggles: box.querySelectorAll('.mermaid-toggle-btn').length, codeCopies: box.querySelectorAll('.mermaid-block .code-copy-icon').length, holders: box.querySelectorAll('.mermaid-rendered-block').length, svgs: box.querySelectorAll('.mermaid svg').length };
      let loads = 0;
      for (const block of [...box.querySelectorAll('.mermaid-block')]) {
        await window.ChatUIMarkdown.renderMermaidBlockOnDemand(block, async () => { loads += 1; return { initialize() {}, render: async (id, source) => ({ svg: '<svg id="' + id + '"><text>' + source.split(nl)[0].replace(/[<>&]/g, '') + '</text></svg>' }) }; });
      }
      const after = { loads, holders: box.querySelectorAll('.mermaid-rendered-block').length, svgs: box.querySelectorAll('.mermaid svg').length, errors: box.querySelectorAll('.markdown-error').length, ids: [...box.querySelectorAll('.mermaid')].map(n => n.id) };
      return { before, after };
    })()`);
    assert.strictEqual(summary.before.resultCount, 0, `renderMarkdownInto does not auto-render mermaid: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.before.holders, 0, `no auto-rendered holders before click: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.before.svgs, 0, `no SVGs before click: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.before.toggles, 4, `toggle exists beside source code: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.before.codeCopies, 4, `copy buttons kept on Mermaid source: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.after.holders, 4, `manual render creates four holders: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.after.svgs, 4, `four SVGs after explicit render: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.after.errors, 0, `no error for valid diagrams: ${JSON.stringify(summary)}`);
    assert.strictEqual(new Set(summary.after.ids).size, 4, `render IDs unique: ${JSON.stringify(summary)}`);
    console.log('mermaid fallback browser ok');
  } finally {
    cdp?.ws?.close?.();
    await Promise.all([stopChild(browser.child), stopChild(server)]);
    try { fs.rmSync(browser.userDataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(err => { console.error(err); process.exit(1); });
