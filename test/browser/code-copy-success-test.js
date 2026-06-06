#!/usr/bin/env node
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appPort = Number(process.env.TEST_COPY_SUCCESS_PORT || 18771);
const cdpPort = Number(process.env.TEST_COPY_SUCCESS_CDP_PORT || 18806);
const base = `http://127.0.0.1:${appPort}`;
const screenshotPath = path.join(root, 'temp/mermaid-toggle-release/copy-success-restored.png');

function startServer() { return spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] }); }
function startBrowser() { const userDataDir = fs.mkdtempSync('/tmp/chatui-copy-success-chromium-'); const child = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] }); return { child, userDataDir }; }
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await cdp.send('Page.navigate', { url: base });
    await waitFor(async () => cdp.evalJs('!!window.ChatUIMarkdown && !!document.body'));
    const summary = await cdp.evalJs(`(async () => {
      await window.ChatUIMarkdownReady;
      navigator.clipboard.writeText = async (text) => { window.__copiedText = text; };
      const box = document.createElement('div');
      box.className = 'markdown-body';
      box.style.cssText = 'width: 760px; margin: 40px auto; padding: 24px; background: white; color: black;';
      document.body.replaceChildren(box);
      const nl = String.fromCharCode(10);
      const fence = String.fromCharCode(96,96,96);
      const md = fence + 'js' + nl + 'console.log(1)' + nl + fence + nl + nl + fence + 'mermaid' + nl + 'flowchart TD' + nl + '  A[Start] --> B[Done]' + nl + fence;
      await window.ChatUIMarkdown.renderMarkdownInto(box, md, { copyText: async (text) => { window.__copiedText = text; } });
      await new Promise(r => setTimeout(r, 80));
      const pick = (el) => { const cs = getComputedStyle(el); const svg = el.querySelector('svg'); const ss = svg ? getComputedStyle(svg) : null; return { className: el.className, innerHTML: el.innerHTML, text: el.textContent.trim(), title: el.title, aria: el.getAttribute('aria-label'), width: cs.width, height: cs.height, minWidth: cs.minWidth, minHeight: cs.minHeight, maxWidth: cs.maxWidth, maxHeight: cs.maxHeight, display: cs.display, placeItems: cs.placeItems, alignItems: cs.alignItems, justifyContent: cs.justifyContent, backgroundColor: cs.backgroundColor, color: cs.color, borderTopColor: cs.borderTopColor, boxShadow: cs.boxShadow, lineHeight: cs.lineHeight, fontSize: cs.fontSize, svgClass: svg?.className?.baseVal || '', svgWidth: ss?.width || '', svgHeight: ss?.height || '', hasSuccessIcon: !!el.querySelector('.copy-success-icon'), hasCopySvg: !!el.querySelector('svg:not(.copy-success-icon)') }; };
      const normalCopy = box.querySelector('.code-block:not(.mermaid-source-view) > .code-copy-icon');
      const mermaidCopy = box.querySelector('.mermaid-source-view > .code-copy-icon');
      const mermaidToggle = box.querySelector('.mermaid-source-view > .mermaid-toggle-btn');
      mermaidToggle.click();
      await new Promise(r => setTimeout(r, 80));
      const toggleAfterClick = pick(mermaidToggle);
      normalCopy.click();
      await new Promise(r => setTimeout(r, 80));
      const normalCopied = pick(normalCopy);
      await new Promise(r => setTimeout(r, 2100));
      const normalReset = pick(normalCopy);
      mermaidCopy.click();
      await new Promise(r => setTimeout(r, 80));
      const mermaidCopied = pick(mermaidCopy);
      await new Promise(r => setTimeout(r, 2100));
      const mermaidReset = pick(mermaidCopy);
      return { toggleAfterClick, normalCopied, normalReset, mermaidCopied, mermaidReset, copiedText: window.__copiedText };
    })()`);

    assert.strictEqual(summary.toggleAfterClick.className.includes('copied'), false, 'mermaid toggle must not enter copied state');
    assert.strictEqual(summary.toggleAfterClick.hasSuccessIcon, false, 'mermaid toggle must not receive success icon');
    for (const state of [summary.normalCopied, summary.mermaidCopied]) {
      assert(state.className.includes('code-copy-icon'), `copy button keeps semantic class: ${JSON.stringify(state)}`);
      assert(state.className.includes('copied'), `copy button enters copied state: ${JSON.stringify(state)}`);
      assert.strictEqual(state.hasSuccessIcon, true, `success SVG is used: ${JSON.stringify(state)}`);
      assert.strictEqual(state.text, '', `success state is icon-only: ${JSON.stringify(state)}`);
      assert.strictEqual(state.title, '已复制');
      assert.strictEqual(state.aria, '已复制');
      assert.strictEqual(state.width, '28px');
      assert.strictEqual(state.height, '24px');
      assert(/rgba?\(16, 185, 129|rgb\(16, 185, 129|rgba?\(5, 150, 105|rgb\(5, 150, 105/.test(state.backgroundColor + state.borderTopColor + state.boxShadow), `green success feedback: ${JSON.stringify(state)}`);
    }
    for (const state of [summary.normalReset, summary.mermaidReset]) {
      assert(!state.className.includes('copied'), `copied state resets: ${JSON.stringify(state)}`);
      assert.strictEqual(state.hasSuccessIcon, false, `success icon removed after reset: ${JSON.stringify(state)}`);
      assert.strictEqual(state.hasCopySvg, true, `copy icon restored after reset: ${JSON.stringify(state)}`);
      assert.strictEqual(state.title, '复制代码');
      assert.strictEqual(state.aria, '复制代码');
    }
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
    console.log('code copy success browser ok');
    console.log(JSON.stringify({ screenshotPath, normalCopied: summary.normalCopied, mermaidCopied: summary.mermaidCopied, toggleAfterClick: summary.toggleAfterClick }, null, 2));
  } finally {
    cdp?.ws?.close?.();
    await Promise.all([stopChild(browser.child), stopChild(server)]);
    try { fs.rmSync(browser.userDataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(err => { console.error(err); process.exit(1); });
