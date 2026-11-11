#!/usr/bin/env node
/**
 * 桌面接入 · 报价计时「沿用服务端」验证（有界、可退出）。
 *
 * 前置：用 apps/server/scripts/desktop-seed-rich.ts 造一个「甲为当前玩家」的真实房间。
 * 步骤：
 *  1. 浏览器以 甲 身份 JOIN（viewer=current=0，收到 WELCOME/STATE）。
 *  2. 另一个 WS 客户端以 乙 身份 JOIN（非当前玩家 → 只能向当前玩家 甲 报价，符合规则）。
 *  3. 乙 发 OFFER 给 甲；服务端分配 id/createdAt/expiresAt 并广播 OFFERS 快照。
 *  4. 浏览器打开报价抽屉，读 [data-cd] 倒计时（panels.tick 用 expiresAt - serverNow() 渲染）。
 *  5. 2 秒后再读 → 应递减；等超过 OFFER_TTL_MS(10s) → 卡片原地失效、不自动续期。
 *
 * 硬约束：25s watchdog 强制 process.exit，finally 关闭所有 WS/Chrome。
 * 用法：ROOM=... node probe/desktop-offer-timing.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os'; import path from 'node:path';
import WebSocket from '../apps/server/node_modules/ws/wrapper.mjs';

const ROOM = process.env.ROOM ?? 'offerdemo';
const WS_URL = process.env.WS_URL ?? 'ws://127.0.0.1:8792/';
const PAGE_URL = process.env.URL ?? `http://127.0.0.1:5176/?name=%E7%94%B2&room=${ROOM}`;
const OUT = process.env.OUT ?? '/tmp/desktop-offer-timing.png';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT ?? 9416);
const W = 1440, H = 900;
mkdirSync(path.dirname(OUT), { recursive: true });
const profile = mkdtempSync(path.join(os.tmpdir(), 'hex-offer-timing-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.log(JSON.stringify({ ok: false, error: 'watchdog 25s 超时' })); process.exit(2); }, 25_000);
async function waitFor(fn, ms, label) { const t=Date.now(); for(;;){try{const v=await fn();if(v)return v;}catch{} if(Date.now()-t>ms)throw new Error(`超时：${label}`); await sleep(100);} }
async function http(m,p){const r=await fetch(`http://127.0.0.1:${PORT}${p}`,{method:m});return{s:r.status,b:await r.text()};}

class Cdp {
  constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.errors=[];ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&this.pending.has(m.id)){const{res,rej}=this.pending.get(m.id);this.pending.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}if(m.method==='Runtime.exceptionThrown')this.errors.push('pageerror: '+(m.params.exceptionDetails.exception?.description??m.params.exceptionDetails.text));if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')this.errors.push('console.error: '+m.params.args.map(a=>a.value??a.description??'').join(' '));});}
  send(method,params={}){const i=++this.id;return new Promise((res,rej)=>{this.pending.set(i,{res,rej});this.ws.send(JSON.stringify({id:i,method,params}));});}
  async ev(e){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;}
  async shot(){const r=await this.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});return Buffer.from(r.data,'base64');}
}

let cdp, chrome, pageWs, peer;
const done = (obj) => { clearTimeout(watchdog); console.log(JSON.stringify(obj, null, 2)); };
try {
  chrome = spawn(CHROME, ['--headless=new','--no-sandbox','--disable-gpu','--no-proxy-server','--remote-allow-origins=*',
    `--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'about:blank'], {stdio:'ignore'});
  await waitFor(async()=>(await http('GET','/json/version')).s===200,12000,'Chrome CDP');
  const t=JSON.parse((await http('PUT',`/json/new?${encodeURIComponent(PAGE_URL)}`)).b);
  pageWs=new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{pageWs.addEventListener('open',res,{once:true});pageWs.addEventListener('error',rej,{once:true});});
  cdp=new Cdp(pageWs);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:W,height:H,deviceScaleFactor:1,mobile:false});
  await cdp.send('Page.navigate',{url:PAGE_URL});
  await waitFor(()=>cdp.ev('!!(window.__hex&&window.__hex.view&&window.__hex.view.tiles&&window.__hex.view.tiles.length)'),15000,'STATE');
  await sleep(400);
  const view = await cdp.ev(`(() => { const v=window.__hex.view; return {viewer:v.viewer,current:v.current,phase:v.phase,seat:window.__hex.seat}; })()`);

  // 乙 用同名 JOIN 回到座位 1（重连语义），向当前玩家（甲）报价
  peer = new WebSocket(WS_URL);
  await new Promise((res,rej)=>{peer.once('open',res);peer.once('error',rej);});
  peer.send(JSON.stringify({t:'JOIN',roomId:ROOM,name:'乙',v:2}));
  await sleep(350);
  const offerSentAt = Date.now();
  peer.send(JSON.stringify({t:'OFFER',to:view.viewer,give:{wood:1},get:{wheat:1}}));
  await sleep(450);

  await cdp.ev(`document.querySelector('#rail-actions [data-panel="offers"]')?.click()`);
  await sleep(450);
  const early = await cdp.ev(`(() => {
    const cd=[...document.querySelectorAll('#drawer-body [data-cd]')].map(n=>({id:n.dataset.cd,text:n.textContent}));
    const cards=[...document.querySelectorAll('#drawer-body [data-offer]')].map(n=>({id:n.dataset.offer,ended:n.dataset.offerEnded||'0'}));
    return {cd,cards,offerBarVisible:!document.getElementById('offer').classList.contains('hidden'),railCount:document.getElementById('rail-offer-count').textContent};
  })()`);
  await sleep(2100);
  const later = await cdp.ev(`(() => [...document.querySelectorAll('#drawer-body [data-cd]')].map(n=>({id:n.dataset.cd,text:n.textContent})))()`);
  writeFileSync(OUT, await cdp.shot());
  // 等超过 10s TTL（从发报价算起）
  const remain = Math.max(0, 10_400 - (Date.now() - offerSentAt));
  if (remain > 0) await sleep(remain);
  await sleep(500);
  const expired = await cdp.ev(`(() => {
    const cards=[...document.querySelectorAll('#drawer-body [data-offer]')].map(n=>({id:n.dataset.offer,ended:n.dataset.offerEnded||'0',expiredCls:n.classList.contains('expired'),btnsDisabled:[...n.querySelectorAll('button')].every(b=>b.disabled)}));
    return {cards,railCount:document.getElementById('rail-offer-count').textContent};
  })()`);

  done({ ok:true, out:OUT, room:ROOM, view, offerSentAt, ttlMs:10_000, early, later, expired,
    countdownDecreased: early.cd.length>0 && later.length>0 && early.cd[0].text!==later[0].text,
    noAutoRenew: expired.cards.length>0 ? expired.cards.every(c=>c.ended==='1'||c.expiredCls) : true,
    consoleErrors:cdp.errors });
} catch(err){ done({ ok:false, error:String(err) }); process.exitCode=1; }
finally {
  clearTimeout(watchdog);
  try{pageWs?.close();}catch{} try{peer?.close();}catch{} try{chrome?.kill('SIGKILL');}catch{}
  await sleep(150); try{rmSync(profile,{recursive:true,force:true});}catch{}
  process.exit(process.exitCode ?? 0);
}
