#!/usr/bin/env node
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const appPort = Number(process.env.TEST_BROWSER_TEXMATH_PORT || 18782);
const cdpPort = Number(process.env.TEST_BROWSER_TEXMATH_CDP_PORT || 18822);
const base = `http://127.0.0.1:${appPort}`;
function startServer(){return spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(appPort),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});}
function startBrowser(){const userDataDir=fs.mkdtempSync('/tmp/chatui-texmath-chromium-');const child=spawn('/usr/bin/chromium',['--headless=new','--no-sandbox',`--remote-debugging-port=${cdpPort}`,`--user-data-dir=${userDataDir}`,'about:blank'],{stdio:['ignore','pipe','pipe']});return{child,userDataDir};}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function stopChild(child){return new Promise(resolve=>{if(!child||child.exitCode!==null||child.signalCode)return resolve();const timer=setTimeout(()=>{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');},1200);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}
function getJson(url){return new Promise((resolve,reject)=>{http.get(url,res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});}).on('error',reject);});}
async function waitFor(fn,ms=8000){const start=Date.now();while(Date.now()-start<ms){try{const result=await fn();if(result)return result;}catch{}await sleep(120);}throw new Error('timeout waiting for condition');}
async function connectCdp(){const tabs=await waitFor(async()=>getJson(`http://127.0.0.1:${cdpPort}/json`));const ws=new WebSocket(tabs[0].webSocketDebuggerUrl);let id=0;const pending=new Map();ws.onmessage=ev=>{const msg=JSON.parse(ev.data);if(msg.id&&pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result);}};await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});const send=(method,params={})=>new Promise((resolve,reject)=>{const msg={id:++id,method,params};pending.set(msg.id,{resolve,reject});ws.send(JSON.stringify(msg));});const evalJs=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result?.value;};return{ws,send,evalJs};}
(async()=>{const server=startServer();const browser=startBrowser();let cdp;try{await waitFor(async()=>(await fetch(`${base}/api/version`)).ok);cdp=await connectCdp();await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:`${base}/?texmath-delimiters-test=1`});await waitFor(async()=>cdp.evalJs('!!window.ChatUIMarkdown && !!window.markdownit && !!window.katex && !!(window.markdownItTexmath || window.texmath)'));
const md=String.raw`inline $P(A)$

block:
$$ |x| $$

brackets: \( \alpha+\beta \)

\[ \sum_i x_i = 1 \]

bare should stay: \vec{a}`;
const result=await cdp.evalJs(`(()=>{const box=document.createElement('div');box.className='markdown-body';box.innerHTML=window.ChatUIMarkdown.renderMarkdownHtml(${JSON.stringify(md)});document.body.replaceChildren(box);return{hasTexmath:!!(window.markdownItTexmath||window.texmath),katexCount:box.querySelectorAll('.katex').length,fallbackCount:box.querySelectorAll('.math-fallback').length,text:box.textContent};})()`);
assert.strictEqual(result.hasTexmath,true,JSON.stringify(result));assert(result.katexCount>=4,JSON.stringify(result));assert.strictEqual(result.fallbackCount,0,JSON.stringify(result));assert(result.text.includes('bare should stay: \\vec{a}'),JSON.stringify(result));console.log('texmath delimiters browser ok');
}finally{cdp?.ws?.close?.();await Promise.all([stopChild(browser.child),stopChild(server)]);try{fs.rmSync(browser.userDataDir,{recursive:true,force:true});}catch{}}})().catch(err=>{console.error(err);process.exit(1);});
