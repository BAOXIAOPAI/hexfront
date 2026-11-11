#!/usr/bin/env node
/**
 * 桌面接入 · 建造流程真实 UI 链路验证（CDP 真实指针事件）。
 *
 * 步骤（全部真实点击，非 el.click()）：
 *   1. 打开页面等 window.__hex.view
 *   2. 点底栏「建造」→ 点抽屉「道路」
 *   3. 读棋盘上合法边 [data-edge] 的屏幕坐标 → 真实点其中一条
 *   4. 等 #confirm-strip 出现 → 真实点「确认」
 *   5. 等服务端 STATE 回写，比对 view.roads 数量 +1，截图
 *
 * 输出结构化 JSON 到 stdout（含每一步观测值），供交付报告引用。
 * 用法：
 *   URL=... OUT=... W=1440 H=900 node probe/desktop-build-flow.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT ?? 9413);
const URL_ = process.env.URL ?? 'http://127.0.0.1:5176/?name=%E7%94%B2&room=rich8';
const OUT = process.env.OUT ?? '/tmp/desktop-build-flow.png';
const W = Number(process.env.W ?? 1440);
const H = Number(process.env.H ?? 900);

mkdirSync(path.dirname(OUT), { recursive: true });
const profile = mkdtempSync(path.join(os.tmpdir(), 'hex-build-flow-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--disable-extensions', '--no-first-run', '--no-default-browser-check',
  '--no-proxy-server', '--proxy-bypass-list=*', '--remote-allow-origins=*',
  '--disable-background-networking', '--disable-component-update', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > ms) throw new Error(`超时：${label}`); await sleep(150); }
}
async function http(method, p) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method });
  return { s: r.status, b: await r.text() };
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push('pageerror: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') this.errors.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    });
  }
  send(method, params = {}) {
    const i = ++this.id;
    return new Promise((res, rej) => { this.pending.set(i, { res, rej }); this.ws.send(JSON.stringify({ id: i, method, params })); });
  }
  async ev(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }
  async shot() { const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); return Buffer.from(r.data, 'base64'); }
}

let ws; let out;
try {
  await waitFor(async () => (await http('GET', '/json/version')).s === 200, 15000, 'Chrome CDP');
  const created = await http('PUT', `/json/new?${encodeURIComponent(URL_)}`);
  const target = JSON.parse(created.b);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: URL_ });
  await waitFor(() => cdp.ev('document.readyState === "complete"'), 15000, '页面加载');
  await waitFor(() => cdp.ev('!!(window.__hex && window.__hex.view && window.__hex.view.tiles && window.__hex.view.tiles.length)'), 20000, 'STATE 视图');
  await sleep(700);

  const before = await cdp.ev(`(() => { const v=window.__hex.view; return { turn:v.turn, current:v.current, viewer:v.viewer, roads:Object.keys(v.roads).length, hand:{...v.me.resources}, phase:v.phase, pendingRobber:v.pendingRobber }; })()`);

  // 1) 「建造」按钮中心（真实点击）
  const buildBtn = await cdp.ev(`(() => { const n=document.getElementById('shelf-btn-build'); const r=n.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),disabled:n.disabled}; })()`);
  await cdp.click(buildBtn.x, buildBtn.y);
  await sleep(450);
  const menu = await cdp.ev(`(() => [...document.querySelectorAll('#build .bp-item')].map(n=>({mode:n.dataset.mode,disabled:n.disabled,text:n.textContent.trim()})))()`);

  // 2) 点「道路」
  const roadItem = await cdp.ev(`(() => { const n=document.querySelector('#build .bp-item[data-mode="road"]'); const r=n.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),disabled:n.disabled}; })()`);
  await cdp.click(roadItem.x, roadItem.y);
  await sleep(650);
  const highlights = await cdp.ev(`(() => [...document.querySelectorAll('#board [data-edge]')].map(n=>{const r=n.getBoundingClientRect();return {key:n.getAttribute('data-edge'),x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}))()`);

  // 3) 真实点一条合法边（取第一个，避开屏幕边缘）
  const edge = highlights.find((h) => h.x > 60 && h.x < W - 60 && h.y > 100 && h.y < H - 170) ?? highlights[0];
  await cdp.click(edge.x, edge.y);
  await sleep(500);
  const confirm = await cdp.ev(`(() => { const n=document.getElementById('confirm-strip'); const r=n.getBoundingClientRect(); const ok=n.querySelector('[data-confirm="ok"]'); const or=ok?.getBoundingClientRect(); return {visible:!n.classList.contains('hidden'),title:n.dataset.title??'',detail:n.textContent.replace(/\\s+/g,' ').trim().slice(0,120),okRect:or?{x:Math.round(or.left+or.width/2),y:Math.round(or.top+or.height/2),disabled:ok.disabled}:null}; })()`);

  // 4) 真实点「确认」
  if (confirm.visible && confirm.okRect && !confirm.okRect.disabled) {
    await cdp.click(confirm.okRect.x, confirm.okRect.y);
  }
  // 5) 等服务端 STATE：roads +1
  const after = await waitFor(
    () => cdp.ev(`(() => { const v=window.__hex.view; return {roads:Object.keys(v.roads).length,hand:{...v.me.resources},turn:v.turn,current:v.current,phase:v.phase,dice:v.dice}; })()`).then((x) => (x.roads > before.roads ? x : null)),
    12000, '服务端确认建造',
  );
  await sleep(600);
  writeFileSync(OUT, await cdp.shot());

  out = {
    ok: true, out: OUT, viewport: [W, H],
    before, buildBtn, menu, roadItem, highlightCount: highlights.length, pickedEdge: edge,
    confirm, after,
    roadsDelta: after.roads - before.roads,
    consoleErrors: cdp.errors,
  };
  console.log(JSON.stringify(out, null, 2));
} catch (err) {
  out = { ok: false, error: String(err) };
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { chrome.kill('SIGKILL'); } catch { /* ignore */ }
  await sleep(250);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
