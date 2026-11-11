#!/usr/bin/env node
/**
 * 桌面优先接入 · 真实浏览器截图/检查工具（CDP，无第三方依赖）。
 *
 * 与 probe/phase-d-browser-verify.mjs 同套 Chrome 启动参数 + /json/new 新 target，
 * 用 Node 24 的全局 WebSocket 连接 CDP。面向本次桌面专项：
 * - 固定 CSS 视口（1280×720 / 1440×900 / 1366×768），真实 Chrome headless。
 * - 等待 window.__hex.view（真实 STATE），可选执行一段「驱动 JS」再截图。
 * - 收集 console/pageerror，输出关键 DOM 度量与权威状态摘要，便于核对。
 * - 读取走 Runtime.evaluate；DRIVE_JS 仅用于把房间推进到需要展示的界面状态，
 *   不作为「真实玩家操作」的证据（报告里如实标注）。
 *
 * 用法（环境变量）：
 *   URL="http://127.0.0.1:5175/?name=甲&room=desk1" \
 *   OUT="docs/shots/xxx.png" W=1440 H=900 \
 *   DRIVE_JS="..." WAIT_MS=1200 \
 *   node probe/desktop-shot.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT ?? 9412);
const URL_ = process.env.URL ?? 'http://127.0.0.1:5175/';
const OUT = process.env.OUT ?? '/tmp/desktop-shot.png';
const W = Number(process.env.W ?? 1440);
const H = Number(process.env.H ?? 900);
const DRIVE_JS = process.env.DRIVE_JS ?? '';
const WAIT_MS = Number(process.env.WAIT_MS ?? 900);
const NO_WAIT_VIEW = process.env.NO_WAIT_VIEW === '1';
/** 真实 CDP 指针点击：JSON 数组 [{x,y,label}]，按顺序派发 mouseMoved/Pressed/Released。
 *  用于「建造流程」等必须是真实 UI 操作的证据（不是 el.click()）。 */
const DRIVE_CLICKS = process.env.DRIVE_CLICKS ? JSON.parse(process.env.DRIVE_CLICKS) : [];

mkdirSync(path.dirname(OUT), { recursive: true });
const profile = mkdtempSync(path.join(os.tmpdir(), 'hex-desktop-shot-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--disable-extensions', '--no-first-run', '--no-default-browser-check',
  '--no-proxy-server', '--proxy-bypass-list=*', '--remote-allow-origins=*',
  '--disable-background-networking', '--disable-component-update', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - started > timeoutMs) throw new Error(`超时：${label}`);
    await sleep(150);
  }
}

async function cdpHttp(method, pathname) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { method });
  return { status: res.status, body: await res.text() };
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push('pageerror: ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.errors.push('console.error: ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + ' ' + (res.exceptionDetails.exception?.description ?? ''));
    return res.result.value;
  }
}

let ws;
let result;
try {
  await waitFor(async () => (await cdpHttp('GET', '/json/version')).status === 200, 15000, 'Chrome CDP');
  const created = await cdpHttp('PUT', `/json/new?${encodeURIComponent(URL_)}`);
  if (created.status !== 200) throw new Error(`/json/new 返回 ${created.status}`);
  const target = JSON.parse(created.body);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', (e) => reject(new Error(e?.message ?? 'ws error')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Page.navigate', { url: URL_ });
  await waitFor(() => cdp.eval('document.readyState === "complete"'), 15000, '页面加载');

  if (!NO_WAIT_VIEW) {
    await waitFor(
      () => cdp.eval('!!(window.__hex && window.__hex.view && window.__hex.view.tiles && window.__hex.view.tiles.length)'),
      20000,
      '收到权威 STATE 视图',
    );
  }

  if (DRIVE_JS) {
    await cdp.eval(`(async () => { ${DRIVE_JS} })()`);
    await sleep(WAIT_MS);
  }
  for (const click of DRIVE_CLICKS) {
    // 真实指针事件（与 phase-d-browser-verify.mjs 同口径）
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: click.x, y: click.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: click.x, y: click.y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: click.x, y: click.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(Number(click.wait ?? 350));
  }
  if (!DRIVE_JS) await sleep(WAIT_MS);

  const info = await cdp.eval(`(() => {
    const h = window.__hex || {};
    const v = h.view;
    const r = (sel) => { const n = document.querySelector(sel); if (!n) return null; const b = n.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
    return {
      url: location.href,
      viewport: [innerWidth, innerHeight],
      docScroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      phase: v?.phase, turn: v?.turn, current: v?.current, viewer: v?.viewer, hasRolled: v?.hasRolled,
      dice: v?.dice, myHand: v?.me?.resources, handSize: v?.me?.handSize,
      buildings: v ? Object.keys(v.buildings).length : null,
      roads: v ? Object.keys(v.roads).length : null,
      pendingDiscards: v?.pendingDiscards, pendingRobber: v?.pendingRobber,
      conn: h.client?.state,
      dom: {
        players: document.querySelectorAll('#players .player').length,
        handCards: document.querySelectorAll('#hand .card').length,
        tiles: document.querySelectorAll('#board .tile').length,
        chipNumbers: document.querySelectorAll('#board text').length,
        overlayHidden: document.getElementById('overlay')?.classList.contains('hidden'),
        shell: r('.shell'), hdr: r('.hdr'), stageMain: r('.stage-main'),
        boardStage: r('.board-stage'), rail: r('.rail'), shelf: r('#shelf'),
        hand: r('#hand'), shelfHand: r('#shelf-hand'), actions: r('#rail-actions'), drawer: r('#drawer'),
        btnBuild: r('#shelf-btn-build'), btnRoll: r('#shelf-btn-roll'), btnTrade: r('#shelf-btn-trade'),
        btnEnd: r('#shelf-btn-end'), btnBank: r('#shelf-btn-bank'), task: r('#rail-task'),
        buildPanel: r('#build'), confirm: r('#confirm-strip'),
        buildItems: [...document.querySelectorAll('#build .bp-item')].map(n => { const b=n.getBoundingClientRect(); return {mode:n.dataset.mode, x:Math.round(b.left+b.width/2), y:Math.round(b.top+b.height/2)}; }),
        boardHits: [...document.querySelectorAll('#board [data-edge],#board [data-vertex]')].slice(0,8).map(n => { const b=n.getBoundingClientRect(); return {tag:n.tagName, kind:n.hasAttribute('data-edge')?'edge':'vertex', key:n.getAttribute('data-edge')||n.getAttribute('data-vertex'), x:Math.round(b.left+b.width/2), y:Math.round(b.top+b.height/2)}; }),
      },
    };
  })()`);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));

  result = { ok: true, out: OUT, viewport: [W, H], info, consoleErrors: cdp.errors };
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  result = { ok: false, error: String(err) };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { chrome.kill('SIGKILL'); } catch { /* ignore */ }
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
