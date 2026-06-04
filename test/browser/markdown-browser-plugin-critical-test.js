#!/usr/bin/env node
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const appPort = Number(process.env.TEST_BROWSER_MD_PLUGIN_PORT || 18790);
const cdpPort = Number(process.env.TEST_BROWSER_MD_PLUGIN_CDP_PORT || 18830);
const base = `http://127.0.0.1:${appPort}`;
function startServer(){return spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(appPort),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});}
function startBrowser(){const userDataDir=fs.mkdtempSync('/tmp/chatui-md-plugin-chromium-');const child=spawn('/usr/bin/chromium',['--headless=new','--no-sandbox',`--remote-debugging-port=${cdpPort}`,`--user-data-dir=${userDataDir}`,'about:blank'],{stdio:['ignore','pipe','pipe']});return{child,userDataDir};}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function stopChild(child){return new Promise(resolve=>{if(!child||child.exitCode!==null||child.signalCode)return resolve();const timer=setTimeout(()=>{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');},1200);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}
function getJson(url){return new Promise((resolve,reject)=>{http.get(url,res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});}).on('error',reject);});}
async function waitFor(fn,ms=10000){const start=Date.now();while(Date.now()-start<ms){try{const result=await fn();if(result)return result;}catch{}await sleep(120);}throw new Error('timeout waiting for condition');}
async function connectCdp(){const tabs=await waitFor(async()=>getJson(`http://127.0.0.1:${cdpPort}/json`));const ws=new WebSocket(tabs[0].webSocketDebuggerUrl);let id=0;const pending=new Map();ws.onmessage=ev=>{const msg=JSON.parse(ev.data);if(msg.id&&pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result);}};await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});const send=(method,params={})=>new Promise((resolve,reject)=>{const msg={id:++id,method,params};pending.set(msg.id,{resolve,reject});ws.send(JSON.stringify(msg));});const evalJs=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result?.value;};return{ws,send,evalJs};}
(async()=>{const server=startServer();const browser=startBrowser();let cdp;try{await waitFor(async()=>(await fetch(`${base}/api/version`)).ok);cdp=await connectCdp();await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:`${base}/?markdown-browser-plugin-critical-test=1`});await waitFor(async()=>cdp.evalJs('!!window.ChatUIMarkdown && !!window.markdownitMultimdTable && !!window.markdownItTexmath'));
const result=await cdp.evalJs(`(()=>{window.ChatUIMarkdown.resetMarkdownEngine?.();const html=window.ChatUIMarkdown.renderMarkdown('| 项目 | 内容 |\\n|---|:---:|\\n| 加粗 | **bold** |\\n| 链接 | https:\\\\/\\\\/openai.com |\\n| 语法链接 | [OpenAI](https:\\\\/\\\\/openai.com) |\\n\\n行内 $a^2+b^2=c^2$');const tpl=document.createElement('template');tpl.innerHTML=html;return {ready:window.ChatUIMarkdown.hasCriticalMarkdownPlugins?.(),html,links:[...tpl.content.querySelectorAll('a')].map(a=>({text:a.textContent,href:a.getAttribute('href')})),strong:tpl.content.querySelector('strong')?.textContent||'',katex:!!tpl.content.querySelector('.katex'),table:!!tpl.content.querySelector('table')};})()`);
assert.strictEqual(result.ready,true,JSON.stringify(result));
assert.strictEqual(result.table,true,JSON.stringify(result));
assert.strictEqual(result.strong,'bold',JSON.stringify(result));
assert(result.links.some(a=>a.text==='https://openai.com' && a.href==='https://openai.com'),JSON.stringify(result));
assert(result.links.some(a=>a.text==='OpenAI' && a.href==='https://openai.com'),JSON.stringify(result));
assert.strictEqual(result.katex,true,JSON.stringify(result));
console.log('markdown browser plugin critical ok');
}finally{cdp?.ws?.close?.();await Promise.all([stopChild(browser.child),stopChild(server)]);try{fs.rmSync(browser.userDataDir,{recursive:true,force:true});}catch{}}})().catch(err=>{console.error(err);process.exit(1);});
