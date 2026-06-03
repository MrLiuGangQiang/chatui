#!/usr/bin/env node
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appPort = Number(process.env.TEST_MERMAID_ICON_PORT || 18770);
const cdpPort = Number(process.env.TEST_MERMAID_ICON_CDP_PORT || 18805);
const base = `http://127.0.0.1:${appPort}`;

function startServer() { return spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] }); }
function startBrowser() { const userDataDir = fs.mkdtempSync('/tmp/chatui-md-chromium-mermaid-icon-'); const child = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] }); return { child, userDataDir }; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function stopChild(child) { return new Promise(resolve => { if (!child || child.exitCode !== null || child.signalCode) return resolve(); const timer = setTimeout(() => { if (child.exitCode === null && !child.killed) child.kill('SIGKILL'); }, 1200); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); }); }
function getJson(url) { return new Promise((resolve, reject) => http.get(url, res => { let data = ''; res.on('data', c => { data += c; }); res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } }); }).on('error', reject)); }
async function waitFor(fn, ms = 12000) { const start = Date.now(); while (Date.now() - start < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(120); } throw new Error('timeout waiting for condition'); }
async function connectCdp() { const tabs = await waitFor(async () => getJson(`http://127.0.0.1:${cdpPort}/json`)); const ws = new WebSocket(tabs[0].webSocketDebuggerUrl); let id = 0; const pending = new Map(); ws.onmessage = ev => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); } }; await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }); const send = (method, params = {}) => new Promise((resolve, reject) => { const msg = { id: ++id, method, params }; pending.set(msg.id, { resolve, reject }); ws.send(JSON.stringify(msg)); }); const evalJs = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result?.value; }; return { ws, send, evalJs }; }

const styleFields = ['width','height','minWidth','minHeight','paddingTop','paddingRight','paddingBottom','paddingLeft','display','alignItems','justifyContent','borderRadius','backgroundColor','borderTopColor','borderTopStyle','borderTopWidth','color','opacity','transitionProperty','transitionDuration','lineHeight','fontSize','boxShadow','transform'];

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
    await cdp.send('Page.navigate', { url: base });
    await waitFor(async () => cdp.evalJs('!!window.ChatUIMarkdown && !!document.body'));
    const summary = await cdp.evalJs(`(async () => {
      await window.ChatUIMarkdownReady;
      const box = document.createElement('div');
      box.className = 'markdown-body';
      box.style.cssText = 'width: 760px; margin: 40px auto; padding: 24px; background: white; color: black;';
      document.body.replaceChildren(box);
      const nl = String.fromCharCode(10);
      const fence = String.fromCharCode(96,96,96);
      const md = fence + 'js' + nl + 'console.log(1)' + nl + fence + nl + nl + fence + 'mermaid' + nl + 'flowchart TD' + nl + '  A[Start] --> B{Go?}' + nl + '  B -->|Yes| C[Done]' + nl + fence;
      const fakeMermaid = { initialize() {}, render: async (id, source) => ({ svg: '<svg id="' + id + '" viewBox="0 0 220 80"><text x="16" y="42">' + source.split(nl)[0].replace(/[<>&]/g, '') + '</text></svg>' }) };
      await window.ChatUIMarkdown.renderMarkdownInto(box, md, { loadMermaid: async () => fakeMermaid });
      await new Promise(r => setTimeout(r, 100));
      const fields = ${JSON.stringify(styleFields)};
      const pick = el => { const cs = getComputedStyle(el); const svg = el.querySelector('svg'); const ss = svg ? getComputedStyle(svg) : null; const out = {}; fields.forEach(f => { out[f] = cs[f]; }); out.svgWidth = ss?.width || ''; out.svgHeight = ss?.height || ''; return out; };
      const rect = el => { const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, top:r.top, right:r.right, bottom:r.bottom, left:r.left }; };
      const hoverProbe = async el => { const before = rect(el); el.dispatchEvent(new MouseEvent('mouseover', { bubbles:true })); el.dispatchEvent(new MouseEvent('mouseenter', { bubbles:true })); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); const hover = pick(el); const after = rect(el); return { before, hover, after }; };
      const sourceBlock = box.querySelector('.mermaid-block');
      const sourceToggle = sourceBlock.querySelector('.code-block > .mermaid-toggle-btn');
      const sourceCopy = sourceBlock.querySelector('.code-block > .code-copy-icon');
      const normalCopy = box.querySelector('.code-block:not(.mermaid-source-view) > .code-copy-icon');
      const regularToggleCount = box.querySelectorAll('.code-block:not(.mermaid-source-view) .mermaid-toggle-btn').length;
      const source = { copyStyle: pick(sourceCopy), toggleStyle: pick(sourceToggle), copyHover: await hoverProbe(sourceCopy), toggleHover: await hoverProbe(sourceToggle), copyRect: rect(sourceCopy), toggleRect: rect(sourceToggle), sameDomBase: sourceCopy.classList.contains('inline-copy') && sourceCopy.classList.contains('code-action-icon') && sourceToggle.classList.contains('inline-copy') && sourceToggle.classList.contains('code-action-icon') && !sourceToggle.classList.contains('code-copy-icon'), copyExists: !!sourceCopy, normalCopyExists: !!normalCopy, regularToggleCount, hasSvg: !!sourceToggle.querySelector('svg'), text: sourceToggle.textContent.trim(), aria: sourceToggle.getAttribute('aria-label'), title: sourceToggle.title };
      sourceToggle.click();
      await new Promise(r => setTimeout(r, 900));
      const renderedToggle = sourceBlock.querySelector('.mermaid-render-toggle');
      const rendered = { toggleStyle: pick(renderedToggle), toggleHover: await hoverProbe(renderedToggle), toggleRect: rect(renderedToggle), mermaidRect: rect(sourceBlock.querySelector('.mermaid')), hasDiagramSvg: !!sourceBlock.querySelector('.mermaid svg'), hasSvg: !!renderedToggle?.querySelector('svg'), text: renderedToggle?.textContent.trim(), aria: renderedToggle?.getAttribute('aria-label'), title: renderedToggle?.title, sourceHidden: sourceBlock.querySelector('.mermaid-source-view')?.hidden === true };
      renderedToggle.click();
      await new Promise(r => setTimeout(r, 80));
      const restored = { hasSource: !!sourceBlock.querySelector('.mermaid-source-view:not([hidden])'), hasDiagramSvg: !!sourceBlock.querySelector('.mermaid svg'), copyExists: !!sourceBlock.querySelector('.code-copy-icon'), toggleHasSvg: !!sourceBlock.querySelector('.code-block > .mermaid-toggle-btn svg'), toggleText: sourceBlock.querySelector('.code-block > .mermaid-toggle-btn')?.textContent.trim() };
      return { source, rendered, restored };
    })()`);
    const sourceComparable = { ...summary.source.copyStyle };
    const toggleComparable = { ...summary.source.toggleStyle };
    assert.deepStrictEqual(toggleComparable, sourceComparable, `source computed style differs: ${JSON.stringify(summary.source, null, 2)}`);
    assert.deepStrictEqual(summary.source.toggleHover.hover, summary.source.copyHover.hover, `source hover computed style differs: ${JSON.stringify(summary.source, null, 2)}`);
    assert.strictEqual(summary.rendered.toggleStyle.width, summary.source.copyStyle.width, 'rendered width matches copy');
    assert.strictEqual(summary.rendered.toggleStyle.height, summary.source.copyStyle.height, 'rendered height matches copy');
    styleFields.concat(['svgWidth','svgHeight']).forEach(field => assert.strictEqual(summary.rendered.toggleStyle[field], summary.source.copyStyle[field], `rendered ${field} matches copy`));
    for (const probe of [summary.source.copyHover, summary.source.toggleHover, summary.rendered.toggleHover]) {
      assert.strictEqual(probe.before.width, probe.after.width, `hover width stable: ${JSON.stringify(probe)}`);
      assert.strictEqual(probe.before.height, probe.after.height, `hover height stable: ${JSON.stringify(probe)}`);
    }
    assert.strictEqual(summary.source.regularToggleCount, 0, `ordinary code has no mermaid toggle: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.source.copyExists, true);
    assert.strictEqual(summary.source.normalCopyExists, true);
    assert.strictEqual(summary.source.sameDomBase, true, 'copy and mermaid share base classes, toggle does not reuse copy marker');
    assert.strictEqual(summary.source.hasSvg, true);
    assert.strictEqual(summary.source.text, '');
    assert.strictEqual(summary.source.aria, '渲染 Mermaid 图表');
    assert(Math.abs(summary.source.toggleRect.right - summary.source.copyRect.left) <= 8, `toggle beside copy: ${JSON.stringify(summary.source)}`);
    assert.strictEqual(summary.rendered.hasDiagramSvg, true);
    assert.strictEqual(summary.rendered.hasSvg, true);
    assert.strictEqual(summary.rendered.text, '');
    assert.strictEqual(summary.rendered.aria, '查看 Mermaid 源码');
    assert(summary.rendered.toggleRect.x >= summary.rendered.mermaidRect.x + summary.rendered.mermaidRect.width - 50, `rendered toggle top-right: ${JSON.stringify(summary.rendered)}`);
    assert.strictEqual(summary.restored.hasSource, true);
    assert.strictEqual(summary.restored.hasDiagramSvg, false);
    assert.strictEqual(summary.restored.copyExists, true);
    assert.strictEqual(summary.restored.toggleHasSvg, true);
    assert.strictEqual(summary.restored.toggleText, '');
    console.log('mermaid icon toggle browser ok');
    console.log(JSON.stringify({ sourceStyle: summary.source.copyStyle, renderedStyle: summary.rendered.toggleStyle }, null, 2));
  } finally {
    cdp?.ws?.close?.();
    await Promise.all([stopChild(browser.child), stopChild(server)]);
    try { fs.rmSync(browser.userDataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(err => { console.error(err); process.exit(1); });
