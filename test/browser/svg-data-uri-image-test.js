#!/usr/bin/env node
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const appPort = Number(process.env.TEST_SVG_DATA_URI_PORT || 18792);
const cdpPort = Number(process.env.TEST_SVG_DATA_URI_CDP_PORT || 18832);
const base = `http://127.0.0.1:${appPort}`;
function startServer(){return spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(appPort),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});}
function startBrowser(){const userDataDir=fs.mkdtempSync('/tmp/chatui-svg-data-uri-chromium-');const child=spawn('/usr/bin/chromium',['--headless=new','--no-sandbox',`--remote-debugging-port=${cdpPort}`,`--user-data-dir=${userDataDir}`,'about:blank'],{stdio:['ignore','pipe','pipe']});return{child,userDataDir};}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function stopChild(child){return new Promise(resolve=>{if(!child||child.exitCode!==null||child.signalCode)return resolve();const timer=setTimeout(()=>{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');},1200);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}
function getJson(url){return new Promise((resolve,reject)=>http.get(url,res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});}).on('error',reject));}
async function waitFor(fn,ms=12000){const start=Date.now();while(Date.now()-start<ms){try{const v=await fn();if(v)return v;}catch{}await sleep(120);}throw new Error('timeout waiting for condition');}
async function connectCdp(){const tabs=await waitFor(async()=>getJson(`http://127.0.0.1:${cdpPort}/json`));const ws=new WebSocket(tabs[0].webSocketDebuggerUrl);let id=0;const pending=new Map();ws.onmessage=ev=>{const msg=JSON.parse(ev.data);if(msg.id&&pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result);}};await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});const send=(method,params={})=>new Promise((resolve,reject)=>{const msg={id:++id,method,params};pending.set(msg.id,{resolve,reject});ws.send(JSON.stringify(msg));});const evalJs=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result?.value;};return{ws,send,evalJs};}
(async()=>{const server=startServer();const browser=startBrowser();let cdp;try{await waitFor(async()=>(await fetch(`${base}/api/version`)).ok);cdp=await connectCdp();await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:base});await waitFor(async()=>cdp.evalJs('!!window.ChatUIMarkdown && !document.body.classList.contains("app-booting")'));
const result=await cdp.evalJs(`(()=>{const svg='<svg xmlns="http://www.w3.org/2000/svg" width="600" height="120"><rect width="100%" height="100%" fill="black"/><text x="50%" y="50%" fill="white" text-anchor="middle" dominant-baseline="middle">Markdown Image Test</text></svg>';const b64=btoa(unescape(encodeURIComponent(svg)));const md='## 10.2 内嵌 SVG 图片\\n\\n![内嵌SVG图片]\\n(data:image/svg+xml;base64,'+b64+')\\n\\n公式：$a^2+b^2=c^2$';const html=window.ChatUIMarkdown.renderMarkdown(md);const tpl=document.createElement('template');tpl.innerHTML=html;const img=tpl.content.querySelector('img');return {html,imgSrc:img?.getAttribute('src')||'',imgAlt:img?.getAttribute('alt')||'',leaksSource:/!\\[内嵌SVG图片\\]|data:image\\/svg\\+xml;utf8|<svg/i.test(tpl.content.textContent||''),katex:!!tpl.content.querySelector('.katex')};})()`);
assert(result.imgSrc.startsWith('data:image/svg+xml;base64,'), JSON.stringify(result));
assert.strictEqual(result.imgAlt,'内嵌SVG图片',JSON.stringify(result));
assert.strictEqual(result.leaksSource,false,JSON.stringify(result));
assert.strictEqual(result.katex,true,JSON.stringify(result));
console.log('svg data uri image browser ok', JSON.stringify({imgSrcPrefix:result.imgSrc.slice(0,40), imgAlt: result.imgAlt, katex: result.katex}));
}finally{cdp?.ws?.close?.();await Promise.all([stopChild(browser.child),stopChild(server)]);try{fs.rmSync(browser.userDataDir,{recursive:true,force:true});}catch{}}})().catch(err=>{console.error(err);process.exit(1);});
