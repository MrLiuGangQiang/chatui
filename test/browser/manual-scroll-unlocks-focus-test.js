#!/usr/bin/env node
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const appPort = Number(process.env.TEST_BROWSER_MANUAL_SCROLL_PORT || 18786);
const cdpPort = Number(process.env.TEST_BROWSER_MANUAL_SCROLL_CDP_PORT || 18826);
const base = `http://127.0.0.1:${appPort}`;
function startServer(){return spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(appPort),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});}
function startBrowser(){const userDataDir=fs.mkdtempSync('/tmp/chatui-manual-scroll-chromium-');const child=spawn('/usr/bin/chromium',['--headless=new','--no-sandbox',`--remote-debugging-port=${cdpPort}`,`--user-data-dir=${userDataDir}`,'about:blank'],{stdio:['ignore','pipe','pipe']});return{child,userDataDir};}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function stopChild(child){return new Promise(resolve=>{if(!child||child.exitCode!==null||child.signalCode)return resolve();const timer=setTimeout(()=>{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');},1200);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}
function getJson(url){return new Promise((resolve,reject)=>{http.get(url,res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});}).on('error',reject);});}
async function waitFor(fn,ms=8000){const start=Date.now();while(Date.now()-start<ms){try{const result=await fn();if(result)return result;}catch{}await sleep(120);}throw new Error('timeout waiting for condition');}
async function connectCdp(){const tabs=await waitFor(async()=>getJson(`http://127.0.0.1:${cdpPort}/json`));const ws=new WebSocket(tabs[0].webSocketDebuggerUrl);let id=0;const pending=new Map();ws.onmessage=ev=>{const msg=JSON.parse(ev.data);if(msg.id&&pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result);}};await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});const send=(method,params={})=>new Promise((resolve,reject)=>{const msg={id:++id,method,params};pending.set(msg.id,{resolve,reject});ws.send(JSON.stringify(msg));});const evalJs=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result?.value;};return{ws,send,evalJs};}
(async()=>{const server=startServer();const browser=startBrowser();let cdp;try{await waitFor(async()=>(await fetch(`${base}/api/version`)).ok);cdp=await connectCdp();await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:`${base}/?manual-scroll-unlocks-focus-test=1`});await waitFor(async()=>cdp.evalJs('!!window.ChatUIScrollDebug && !!document.getElementById("messages") && !document.body.classList.contains("app-booting")'));
await sleep(180);
const result=await cdp.evalJs(`(()=>{const m=document.getElementById('messages');const btn=document.getElementById('resumeStreamBtn');m.innerHTML='';m.style.height='620px';m.style.overflowY='auto';for(let i=0;i<28;i++){const node=document.createElement('div');node.className='message assistant';node.style.minHeight='150px';node.style.padding='8px';node.textContent='history '+i;m.appendChild(node);}const active=document.createElement('div');active.className='message assistant';active.dataset.streaming='1';active.dataset.sessionId=window.ChatUIScrollDebug.metrics().activeSessionId||'';active.style.minHeight='180px';active.textContent='streaming';m.appendChild(active);window.ChatUIScrollDebug.scrollToActiveOutput(active,{force:true,active:true,margin:72});const locked=window.ChatUIScrollDebug.metrics();m.dispatchEvent(new WheelEvent('wheel',{deltaY:120,bubbles:true,cancelable:true}));m.scrollTop=Math.max(0,m.scrollTop-120);m.dispatchEvent(new Event('scroll',{bubbles:true}));return new Promise(resolve=>setTimeout(()=>resolve({locked,after:window.ChatUIScrollDebug.metrics()}),180));})()`);
assert.strictEqual(result.locked.streamFocusLocked,true,JSON.stringify(result));
assert.strictEqual(result.after.streamFocusLocked,false,JSON.stringify(result));
assert.strictEqual(result.after.userScrollLocked,true,JSON.stringify(result));
console.log('manual scroll unlocks focus browser ok');
}finally{cdp?.ws?.close?.();await Promise.all([stopChild(browser.child),stopChild(server)]);try{fs.rmSync(browser.userDataDir,{recursive:true,force:true});}catch{}}})().catch(err=>{console.error(err);process.exit(1);});
