#!/usr/bin/env node
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appPort = Number(process.env.TEST_MERMAID_PORT || 18768);
const cdpPort = Number(process.env.TEST_MERMAID_CDP_PORT || 18803);
const base = `http://127.0.0.1:${appPort}`;
const artifactDir = path.join(root, 'temp/e2e-artifacts/mermaid-overlap');

function startServer() {
  return spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
}

function startBrowser() {
  const userDataDir = fs.mkdtempSync('/tmp/chatui-md-chromium-mermaid-');
  const child = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { child, userDataDir };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function stopChild(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.signalCode) return resolve();
    const timer = setTimeout(() => { if (child.exitCode === null && !child.killed) child.kill('SIGKILL'); }, 1200);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
async function removeTempDir(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
function getJson(url) {
  return new Promise((resolve, reject) => http.get(url, res => {
    let data = ''; res.on('data', c => { data += c; }); res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
  }).on('error', reject));
}
async function waitFor(fn, ms = 12000) {
  const start = Date.now();
  while (Date.now() - start < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(120); }
  throw new Error('timeout waiting for condition');
}
async function connectCdp() {
  const tabs = await waitFor(async () => getJson(`http://127.0.0.1:${cdpPort}/json`));
  const ws = new WebSocket(tabs[0].webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = ev => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); } };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const msg = { id: ++id, method, params }; pending.set(msg.id, { resolve, reject }); ws.send(JSON.stringify(msg)); });
  const evalJs = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result?.value; };
  return { ws, send, evalJs };
}

(async () => {
  fs.mkdirSync(artifactDir, { recursive: true });
  const server = startServer();
  const browser = startBrowser();
  let cdp;
  try {
    await waitFor(async () => (await fetch(`${base}/api/version`)).ok);
    cdp = await connectCdp();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: base });
    await waitFor(async () => cdp.evalJs('!!window.ChatUIMarkdown && !!window.markdownit && !!document.body'));
    
    const summary = await cdp.evalJs(`(async () => {
      const box = document.createElement('div');
      box.className = 'markdown-body';
      box.style.cssText = 'width: 900px; padding: 24px; background: white; color: black;';
      document.body.appendChild(box);
      const nl = String.fromCharCode(10);
      const fence = String.fromCharCode(96,96,96);
      const sources = ['pie title Pets' + nl + '  \"Dogs\" : 4' + nl + '  \"Cats\" : 3', 'erDiagram' + nl + '  USER ||--o{ POST : writes' + nl + '  POST ||--o{ COMMENT : has', 'flowchart TD' + nl + '  A[Start] --> B{Go?}' + nl + '  B -->|Yes| C[Done]', 'sequenceDiagram' + nl + '  participant U' + nl + '  participant C' + nl + '  U->>C: Hi' + nl + '  C-->>U: OK'];
      const md = sources.map(src => fence + 'mermaid' + nl + src + nl + fence).join(nl + nl);
      if (window.markdownit) window.markdownit().render(md);
      const rendered = await window.ChatUIMarkdown.renderMarkdownInto(box, md, { deferMermaid: false, loadMermaid: async () => { throw new Error('should not auto-render'); } });
      if (!box.querySelectorAll('.mermaid-block').length) {
        box.innerHTML = window.ChatUIMarkdown.renderMarkdownHtml(md);
        await window.ChatUIMarkdown.enhanceRenderedMarkdown(box, { loadMermaid: async () => { throw new Error('should not auto-render'); } });
      }
      const blockCount = box.querySelectorAll('.mermaid-block').length;
      const beforeSvgs = box.querySelectorAll('.mermaid svg').length;
      for (const block of [...box.querySelectorAll('.mermaid-block')]) await window.ChatUIMarkdown.renderMermaidBlockOnDemand(block, async () => ({ initialize() {}, render: async (id, source) => ({ svg: '<svg id="' + id + '"><text>' + source.split(nl)[0].replace(/[<>&]/g, '') + '</text></svg>' }) }));
      await new Promise(r => setTimeout(r, 50));
      const holders = [...box.querySelectorAll('.mermaid-rendered-block')];
      const svgs = [...box.querySelectorAll('.mermaid svg')];
      return { resultCount: rendered.mermaid.length, blockCount, beforeSvgs, toggles: box.querySelectorAll('.mermaid-render-toggle').length, holders: holders.length, svgs: svgs.length, ids: [...box.querySelectorAll('.mermaid')].map(n => n.id), texts: holders.map(n => n.textContent.slice(0, 120)), pending: box.querySelectorAll('.markdown-mermaid-pending').length, errors: box.querySelectorAll('.markdown-error').length };
    })()`);
    assert.strictEqual(summary.resultCount, 0, `no auto mermaid render result: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.beforeSvgs, 0, `no SVG before explicit render: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.toggles, 4, `rendered diagrams keep source toggle: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.holders, 4, `four independent mermaid holders: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.svgs, 4, `four mermaid SVGs rendered: ${JSON.stringify(summary)}`);
    assert.strictEqual(new Set(summary.ids).size, 4, `render IDs unique in browser: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.pending, 0, `no pending mermaid blocks after manual render: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.errors, 0, `no mermaid errors for user fixture: ${JSON.stringify(summary)}`);
    assert(summary.texts[0].includes('Dogs') || summary.texts[0].includes('Pets'), `pie text remains in first holder: ${JSON.stringify(summary)}`);
    assert(summary.texts[1].includes('erDiagram'), `ER text remains in second holder: ${JSON.stringify(summary)}`);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const screenshot = path.join(artifactDir, 'pie-er-flow-sequence.png');
    fs.writeFileSync(screenshot, Buffer.from(shot.data, 'base64'));
    console.log(`mermaid overlap browser ok: ${screenshot}`);
  } finally {
    cdp?.ws?.close?.();
    await Promise.all([stopChild(browser.child), stopChild(server)]);
    await removeTempDir(browser.userDataDir);
  }
})().catch(err => { console.error(err); process.exit(1); });
