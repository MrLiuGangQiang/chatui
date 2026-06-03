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
      window.requestIdleCallback = (cb, opts) => 900001; // never fires: fallback timer must render
      window.cancelIdleCallback = () => {};
      await window.ChatUIMarkdownReady;
      const box = document.createElement('div');
      box.className = 'markdown-body';
      box.style.cssText = 'position:absolute; top:5000px; width:900px; padding:24px; background:white; color:black;';
      document.body.replaceChildren(box);
      const sources = ['flowchart TD\\n  A --> B', 'sequenceDiagram\\n  A->>B: hi', 'pie title Pets\\n  "Dogs" : 4\\n  "Cats" : 3', 'erDiagram\\n  USER ||--o{ POST : writes'];
      const md = sources.map(src => '\`\`\`mermaid\\n' + src + '\\n\`\`\`').join('\\n\\n');
      const promise = window.ChatUIMarkdown.renderMarkdownInto(box, md, { mermaidFallbackMs: 80, loadMermaid: async () => ({ initialize() {}, render: async (id, source) => ({ svg: '<svg id="' + id + '"><text>' + source.split('\\n')[0].replace(/[<>&]/g, '') + '</text></svg>' }) }) });
      await new Promise(r => setTimeout(r, 320));
      const result = await promise;
      await window.ChatUIMarkdown.enhanceRenderedMarkdown(box, { deferMermaid: false, loadMermaid: async () => { throw new Error('should not rerender'); } });
      return { resultCount: result.mermaid.length, ok: result.mermaid.filter(x => x && x.ok).length, pending: box.querySelectorAll('.markdown-mermaid-pending').length, holders: box.querySelectorAll('.mermaid-rendered-block').length, svgs: box.querySelectorAll('.mermaid svg').length, errors: box.querySelectorAll('.markdown-error').length, ids: [...box.querySelectorAll('.mermaid')].map(n => n.id) };
    })()`);
    assert.strictEqual(summary.holders, 4, `fallback renders four offscreen diagrams: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.svgs, 4, `four SVGs after idle/visibility fallback: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.pending, 0, `no permanent pending mermaid blocks: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.errors, 0, `no error for valid diagrams: ${JSON.stringify(summary)}`);
    assert.strictEqual(new Set(summary.ids).size, 4, `render IDs unique: ${JSON.stringify(summary)}`);
    console.log('mermaid fallback browser ok');
  } finally {
    cdp?.ws?.close?.();
    await Promise.all([stopChild(browser.child), stopChild(server)]);
    try { fs.rmSync(browser.userDataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(err => { console.error(err); process.exit(1); });
