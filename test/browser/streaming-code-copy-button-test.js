#!/usr/bin/env node
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const appPort = Number(process.env.TEST_STREAM_COPY_PORT || 18791);
const cdpPort = Number(process.env.TEST_STREAM_COPY_CDP_PORT || 18831);
const base = `http://127.0.0.1:${appPort}`;
function startServer(){return spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(appPort),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});}
function startBrowser(){const userDataDir=fs.mkdtempSync('/tmp/chatui-stream-copy-chromium-');const child=spawn('/usr/bin/chromium',['--headless=new','--no-sandbox',`--remote-debugging-port=${cdpPort}`,`--user-data-dir=${userDataDir}`,'about:blank'],{stdio:['ignore','pipe','pipe']});return{child,userDataDir};}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function stopChild(child){return new Promise(resolve=>{if(!child||child.exitCode!==null||child.signalCode)return resolve();const timer=setTimeout(()=>{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');},1200);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}
function getJson(url){return new Promise((resolve,reject)=>http.get(url,res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});}).on('error',reject));}
async function waitFor(fn,ms=12000){const start=Date.now();while(Date.now()-start<ms){try{const v=await fn();if(v)return v;}catch{}await sleep(120);}throw new Error('timeout waiting for condition');}
async function connectCdp(){const tabs=await waitFor(async()=>getJson(`http://127.0.0.1:${cdpPort}/json`));const ws=new WebSocket(tabs[0].webSocketDebuggerUrl);let id=0;const pending=new Map();ws.onmessage=ev=>{const msg=JSON.parse(ev.data);if(msg.id&&pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result);}};await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});const send=(method,params={})=>new Promise((resolve,reject)=>{const msg={id:++id,method,params};pending.set(msg.id,{resolve,reject});ws.send(JSON.stringify(msg));});const evalJs=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result?.value;};return{ws,send,evalJs};}
(async()=>{const server=startServer();const browser=startBrowser();let cdp;try{await waitFor(async()=>(await fetch(`${base}/api/version`)).ok);cdp=await connectCdp();await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Emulation.setDeviceMetricsOverride',{width:1100,height:760,deviceScaleFactor:1,mobile:false});await cdp.send('Page.navigate',{url:base});await waitFor(async()=>cdp.evalJs('!!window.ChatUIMarkdown && !document.body.classList.contains("app-booting")'));
const result=await cdp.evalJs(`(async()=>{await window.ChatUIMarkdownReady;const box=document.createElement('div');box.className='markdown-body';box.style.cssText='width:760px;margin:40px auto;padding:24px;background:#fff;color:#111';document.body.replaceChildren(box);let copied='';const renderer=window.ChatUIMarkdown.createStreamingRenderer({renderMarkdown:window.ChatUIMarkdown.renderMarkdown,enhance:(root,phase={})=>{if(phase.streaming)window.ChatUIMarkdown.enhanceCodeCopy(root,async text=>{copied=text});window.ChatUIMarkdown.enhanceRenderedMarkdown(root,{copyText:async text=>{copied=text},skipMermaid:!phase.final,streaming:!!phase.streaming});}});const nl=String.fromCharCode(10);const fence=String.fromCharCode(96,96,96);renderer.append('先看代码'+nl+nl+fence+'js'+nl,box);const before=!!box.querySelector('.code-copy-icon');renderer.append('console.log(1)'+nl+fence+nl+nl+'然后继续输出，不等 final。'+nl+nl,box);await new Promise(r=>setTimeout(r,80));const copy=box.querySelector('.code-block > .code-copy-icon');const mermaidHost=document.createElement('div');mermaidHost.innerHTML=window.ChatUIMarkdown.renderMarkdown(fence+'mermaid'+nl+'flowchart TD'+nl+'  A-->B'+nl+fence);box.appendChild(mermaidHost);window.ChatUIMarkdown.initMermaidToggleUI(mermaidHost,{copyText:async text=>{copied=text}});await new Promise(r=>setTimeout(r,80));const toggle=box.querySelector('.mermaid-source-view > .mermaid-toggle-btn');const pick=el=>{const cs=getComputedStyle(el);const svg=el.querySelector('svg');const ss=svg?getComputedStyle(svg):null;return {exists:!!el,className:el.className,width:cs.width,height:cs.height,minWidth:cs.minWidth,minHeight:cs.minHeight,maxWidth:cs.maxWidth,maxHeight:cs.maxHeight,display:cs.display,placeItems:cs.placeItems,alignItems:cs.alignItems,justifyContent:cs.justifyContent,background:cs.backgroundColor,color:cs.color,borderTopColor:cs.borderTopColor,lineHeight:cs.lineHeight,fontSize:cs.fontSize,svgWidth:ss?.width||'',svgHeight:ss?.height||'',title:el.title,aria:el.getAttribute('aria-label')};};copy.click();await new Promise(r=>setTimeout(r,80));const mathHtml=window.ChatUIMarkdown.renderMarkdown('公式：$a^2+b^2=c^2$\\n\\n$$\\\\frac{1}{2}$$');const tpl=document.createElement('template');tpl.innerHTML=mathHtml;return {before,copy:pick(copy),toggle:pick(toggle),copied,copiedState:copy.classList.contains('copied'),mathInline:!!tpl.content.querySelector('.katex'),mathDisplay:!!tpl.content.querySelector('.katex-display .katex')};})()`);
assert.strictEqual(result.before,false,JSON.stringify(result));
assert.strictEqual(result.copy.exists,true,JSON.stringify(result));
assert.strictEqual(result.copy.width,result.toggle.width,JSON.stringify(result));
assert.strictEqual(result.copy.height,result.toggle.height,JSON.stringify(result));
assert.strictEqual(result.copy.minWidth,result.toggle.minWidth,JSON.stringify(result));
assert.strictEqual(result.copy.minHeight,result.toggle.minHeight,JSON.stringify(result));
assert.strictEqual(result.copy.svgWidth,result.toggle.svgWidth,JSON.stringify(result));
assert.strictEqual(result.copy.svgHeight,result.toggle.svgHeight,JSON.stringify(result));
assert.strictEqual(result.copy.width,'26px',JSON.stringify(result));
assert.strictEqual(result.copy.height,'22px',JSON.stringify(result));
assert.strictEqual(result.copiedState,true,JSON.stringify(result));
assert(result.copied.includes('console.log(1)'),JSON.stringify(result));
assert.strictEqual(result.mathInline,true,JSON.stringify(result));
assert.strictEqual(result.mathDisplay,true,JSON.stringify(result));
console.log('streaming code copy button browser ok', JSON.stringify(result));
}finally{cdp?.ws?.close?.();await Promise.all([stopChild(browser.child),stopChild(server)]);try{fs.rmSync(browser.userDataDir,{recursive:true,force:true});}catch{}}})().catch(err=>{console.error(err);process.exit(1);});
