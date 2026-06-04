#!/usr/bin/env node
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appPort = Number(process.env.TEST_MERMAID_BETA_PORT || 18795);
const cdpPort = Number(process.env.TEST_MERMAID_BETA_CDP_PORT || 18895);
const base = `http://127.0.0.1:${appPort}`;
function startServer() { return spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] }); }
function startBrowser() { const userDataDir = fs.mkdtempSync('/tmp/chatui-md-chromium-mermaid-beta-'); const child = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] }); return { child, userDataDir }; }
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
      const sankey = 'sankey-beta' + nl + '    用户访问,首页,100' + nl + '    首页,详情页,60' + nl + '    首页,搜索页,30' + nl + '    首页,离开,10' + nl + '    详情页,下单页,35' + nl + '    详情页,离开,25' + nl + '    搜索页,详情页,20' + nl + '    搜索页,离开,10';
      const radar = 'radar-beta' + nl + '    title 技能雷达图' + nl + '    axis HTML, CSS, JavaScript, Vue, Node.js' + nl + '    "张三" : 90, 85, 80, 75, 70' + nl + '    "李四" : 70, 80, 88, 90, 60';
      const md = '## 56. Mermaid 桑基图' + nl + fence + 'mermaid' + nl + sankey + nl + fence + nl + nl + '## 57. Mermaid 雷达图' + nl + fence + 'mermaid' + nl + radar + nl + fence;
      await window.ChatUIMarkdown.renderMarkdownInto(box, md);
      const blocks = [...box.querySelectorAll('.mermaid-block')];
      for (const block of blocks) await window.ChatUIMarkdown.renderMermaidBlockOnDemand(block);
      await new Promise(r => setTimeout(r, 1500));
      return {
        count: blocks.length,
        rendered: blocks.map(b => b.dataset.mermaidRendered),
        svgs: box.querySelectorAll('.mermaid svg').length,
        errors: box.querySelectorAll('.markdown-error').length,
        fallback: box.querySelectorAll('.mermaid-fallback').length,
        codeTexts: blocks.map(b => b.querySelector('code.language-mermaid')?.textContent || ''),
        normalizedRadar: window.ChatUIMarkdown.normalizeBetaMermaidSource?.(radar) || ''
      };
    })()`);
    assert.strictEqual(summary.count, 2, `two beta mermaid blocks: ${JSON.stringify(summary)}`);
    assert.deepStrictEqual(summary.rendered, ['1', '1'], `both beta mermaid blocks rendered: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.svgs, 2, `two SVGs rendered: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.errors, 0, `no markdown error: ${JSON.stringify(summary)}`);
    assert.strictEqual(summary.fallback, 0, `no fallback: ${JSON.stringify(summary)}`);
    assert(summary.codeTexts[0].includes('    用户访问,首页,100'), `sankey source display remains original: ${JSON.stringify(summary)}`);
    assert(summary.codeTexts[1].includes('axis HTML, CSS, JavaScript, Vue, Node.js'), `radar source display remains original: ${JSON.stringify(summary)}`);
    assert(summary.normalizedRadar.includes('axis html["HTML"]') && summary.normalizedRadar.includes('node_js["Node.js"]') && summary.normalizedRadar.includes('curve curve1["张三"]'), `radar normalized to official syntax: ${JSON.stringify(summary)}`);
    console.log('mermaid beta normalize browser ok', JSON.stringify({ rendered: summary.rendered, svgs: summary.svgs, errors: summary.errors }));
  } finally {
    cdp?.ws?.close?.();
    await Promise.all([stopChild(browser.child), stopChild(server)]);
    try { fs.rmSync(browser.userDataDir, { recursive: true, force: true }); } catch {}
  }
})().catch(err => { console.error(err); process.exit(1); });
