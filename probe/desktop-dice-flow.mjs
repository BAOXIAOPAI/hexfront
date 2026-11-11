#!/usr/bin/env node
/**
 * 桌面接入 · 掷骰「结果来自服务端、动画不延迟状态更新」验证（真实 UI 点击）。
 *
 * 观测：
 *  - 点击底栏「掷骰子」后立刻（<250ms）读 window.__hex.view.dice 是否已由服务端 STATE 更新；
 *  - 再读 #die1/#die2 文本是否与 view.dice 一致（spinDice 表演落定后回到权威值）；
 *  - 记录动画期间与落定后的 DOM 文本变化，证明动画不阻塞状态、不伪造最终点数。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os'; import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT ?? 9414);
const URL_ = process.env.URL ?? 'http://127.0.0.1:5176/?name=%E7%94%B2&room=rich9';
const OUT = process.env.OUT ?? '/tmp/desktop-dice.png';
const W = Number(process.env.W ?? 1440), H = Number(process.env.H ?? 900);
mkdirSync(path.dirname(OUT), { recursive: true });
const profile = mkdtempSync(path.join(os.tmpdir(), 'hex-dice-flow-'));
const chrome = spawn(CHROME, [
  '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-extensions',
  '--no-first-run','--no-default-browser-check','--no-proxy-server','--proxy-bypass-list=*',
  '--remote-allow-origins=*','--disable-background-networking','--disable-component-update','--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, label) { const t=Date.now(); for(;;){ try{const v=await fn(); if(v) return v;}catch{} if(Date.now()-t>ms) throw new Error(`超时：${label}`); await sleep(100);} }
async function http(m,p){const r=await fetch(`http://127.0.0.1:${PORT}${p}`,{method:m});return{s:r.status,b:await r.text()};}
class Cdp {
  constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.errors=[];ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&this.pending.has(m.id)){const{res,rej}=this.pending.get(m.id);this.pending.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}if(m.method==='Runtime.exceptionThrown')this.errors.push('pageerror: '+(m.params.exceptionDetails.exception?.description??m.params.exceptionDetails.text));if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')this.errors.push('console.error: '+m.params.args.map(a=>a.value??a.description??'').join(' '));});}
  send(method,params={}){const i=++this.id;return new Promise((res,rej)=>{this.pending.set(i,{res,rej});this.ws.send(JSON.stringify({id:i,method,params}));});}
  async ev(e){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;}
  async click(x,y){await this.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});await this.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});await this.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});}
  async shot(){const r=await this.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});return Buffer.from(r.data,'base64');}
}
let ws, out;
try {
  await waitFor(async()=>(await http('GET','/json/version')).s===200,15000,'Chrome CDP');
  const t=JSON.parse((await http('PUT',`/json/new?${encodeURIComponent(URL_)}`)).b);
  ws=new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true});});
  const cdp=new Cdp(ws);
  await cdp.send('Runtime.enable');await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:W,height:H,deviceScaleFactor:1,mobile:false});
  await cdp.send('Page.navigate',{url:URL_});
  await waitFor(()=>cdp.ev('document.readyState === "complete"'),15000,'页面加载');
  await waitFor(()=>cdp.ev('!!(window.__hex&&window.__hex.view&&window.__hex.view.tiles&&window.__hex.view.tiles.length)'),20000,'STATE');
  await sleep(600);
  const btn=await cdp.ev(`(()=>{const n=document.getElementById('shelf-btn-roll');const r=n.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),disabled:n.disabled};})()`);
  const read=()=>cdp.ev(`(()=>{const v=window.__hex.view;return{dice:v.dice,hasRolled:v.hasRolled,die1:document.getElementById('die1').textContent,die2:document.getElementById('die2').textContent,feed:document.getElementById('feed-text').textContent};})()`);
  const before=await read();
  await cdp.click(btn.x,btn.y);
  // 立刻（动画期间）读：状态更新不应被动画延迟
  await sleep(150); const during=await read();
  // 动画落定后（spinDice 约 650ms + STATE 往返）读
  const settled=await waitFor(()=>read().then(x=>x.dice&&x.die1===String(x.dice[0])&&x.die2===String(x.dice[1])?x:null),12000,'骰面落定到服务端值');
  await sleep(300);
  writeFileSync(OUT,await cdp.shot());
  out={ok:true,out:OUT,viewport:[W,H],btn,before,during,settled,
    stateUpdatedDuringAnimation:JSON.stringify(during.dice)!=='null',
    finalMatchesServer: settled.dice && settled.die1===String(settled.dice[0]) && settled.die2===String(settled.dice[1]),
    consoleErrors:cdp.errors};
  console.log(JSON.stringify(out,null,2));
} catch(err){out={ok:false,error:String(err)};console.log(JSON.stringify(out,null,2));process.exitCode=1;}
finally{try{ws?.close();}catch{}try{chrome.kill('SIGKILL');}catch{}await sleep(200);try{rmSync(profile,{recursive:true,force:true});}catch{}}
