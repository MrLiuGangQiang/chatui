#!/usr/bin/env node
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appPort = Number(process.env.TEST_MERMAID_ARCH_PORT || 18793);
const cdpPort = Number(process.env.TEST_MERMAID_ARCH_CDP_PORT || 18893);
const base = `http://127.0.0.1:${appPort}`;

function startServer() { return spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] }); }
function startBrowser() { const userDataDir = fs.mkdtempSync('/tmp/chatui-md-chromium-mermaid-arch-'); const child = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] }); return { child, userDataDir }; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function stopChild(child) { return new Promise(resolve => { if (!child || child.exitCode !== null || child.signalCode) return resolve(); const timer = setTimeout(() => { if (child.exitCode === null && !child.killed) child.kill('SIGKILL'); }, 1200); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); }); }
function getJson(url) { return new Promise((resolve, reject) => http.get(url, res => { let data = ''; res.on('data', c => { data += c; }); res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } }); }).on('error', reject)); }
async function waitFor(fn, ms = 15000) { const start = Date.now(); while (Date.now() - start < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(120); } throw new Error('timeout waiting for condition'); }
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
      await window.ChatUIMarkdownReady;
      const box = document.createElement('div');
      box.className = 'markdown-body';
      box.style.cssText = 'width: 900px; margin: 40px auto; padding: 24px; background: white; color: black;';
      document.body.replaceChildren(box);
      const nl = String.fromCharCode(10);
      const fence = String.fromCharCode(96,96,96);
      const src = 'architecture-beta' + nl + '    group api(cloud)[API服务]' + nl + nl + '    service db(database)[数据库] in api' + nl + '    service server(server)[后端服务] in api' + nl + '    service web(internet)[前端页面] in api' + nl + nl + '    web:R --> L:server' + nl + '    server:R --> L:db';
      const md = '## 58. Mermaid 架构图' + nl + nl + fence + 'mermaid' + nl + src + nl + fence;
      await window.ChatUIMarkdown.renderMarkdownInto(box, md);
      await new Promise(r => setTimeout(r, 120));
      const block = box.querySelector('.mermaid-block');
      await window.ChatUIMarkdown.renderMermaidBlockOnDemand(block);
      await new Promise(r => setTimeout(r, 1200));
      const mermaid = box.querySelector('.mermaid');
      return {
        rendered: block?.dataset.mermaidRendered,
        hasSvg: !!box.querySelector('.mermaid svg'),
        errors: box.querySelectorAll('.markdown-error').length,
        fallback: !!box.querySelector('.mermaid-fallback'),
        sourceVisible: block?.querySelector('.code-block')?.hidden === false,
        svgText: mermaid?.textContent || '',
        codeText: block?.querySelector('code.language-mermaid')?.textContent || ''
      };
    })()`);
    assert.strictEqual(summary.rendered, '1', `architecture block rendered: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.hasSvg, true, `architecture has svg: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.errors, 0, `architecture has no markdown error: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.fallback, false, `architecture not fallback: ${JSON.stringify(summary)}`);
    assert(summary.codeText.includes('[API服务]'), `source remains original Chinese label: ${JSON.stringify(summary)}`);
    console.log('mermaid architecture label browser ok', JSON.stringify({ rendered: summary.rendered, hasSvg: summary.hasSvg, errors: summary.errors }));
  } finally {
    cdp?.ws?.close?.();
    await Promise.all([stopChild(browser.child), stopChild(server)]);
    try { fs.rmSync(browser.userDataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(err => { console.error(err); process.exit(1); });
