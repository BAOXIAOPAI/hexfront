#!/usr/bin/env node
/**
 * 阶段 D 放行后「18 §4 缺口」独立复验（2026-11-09）。
 *
 * 目标：补 18 §4.1 / §5 点名的核心缺口 ——
 *   「浏览器完整多人对局未走到 phase=ended」「结束页 → 回到房间退出自转」
 *   「UL-UX07 带 view 的 WELCOME 恢复路径」。
 *
 * 方法（全部走真实协议 + 真实浏览器，绝不伪造状态）：
 *   1. 起独立单端口服务（127.0.0.1，端口与既有全错开），静态托管 dist/public；
 *   2. spawn 4 个 apps/server/scripts/bot.ts（--fast，1 个 --host）在同一独立房间
 *      跑一局完整对局；从 bot stdout 捕获「对局结束：胜者 X，比分 A:B:C:D」；
 *   3. bot 因 ended 退出后座位保留（room.leave 只标记 connected=false）；
 *   4. 用 CDP 真实 Chrome 页面以第 1 个 bot 的**同名**连回该房间：
 *      服务端 JOIN 视为重连 → WELCOME 带 phase=ended 的 view（UL-UX07 恢复路径）；
 *   5. 浏览器读 __hex.view / #end-screen DOM，验证胜者、分数、回房间入口；
 *      真实指针点「回到房间」，验证退出自转（data-landscape-mode=off）。
 *
 * 诚信约束：
 *   - 历史 FAIL / CONCERNS 快照一律不改写，本报告独立落盘；
 *   - 本脚本是「协议推进 + 浏览器验证」的组合证据，**不冒充 4 个浏览器页面全 UI 打完一局**
 *     （phase-d-browser-verify.mjs 方法 A 的 FLOW-09 仍保持 NOT_RUN，不在本脚本改判）；
 *   - 真机 / iOS Safari / 微信内置 / 国产自带浏览器仍 BLOCKED，不在本脚本判定。
 *
 * 用法：node probe/phase-d-closure-check.mjs [--shots] [--keep]
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = path.join(ROOT, 'probe');
const REPORT = path.join(PROBE, 'phase-d-closure-report.json');
const SHOTS = path.join(PROBE, 'phase-d-closure-shots');
const argv = process.argv.slice(2);
const CFG = {
  backendPort: 8801,
  cdpPort: 9421,
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  room: `qa-close-${Date.now().toString(36)}`,
  shots: argv.includes('--shots'),
  keep: argv.includes('--keep'),
  botTimeoutMs: 300000,
};
const NAMES = ['甲', '乙', '丙', '丁'];
const WS = `ws://127.0.0.1:${CFG.backendPort}/ws?sharecode=DEV&room=${CFG.room}`;

const rep = {
  schema: 'phase-d-closure/v1',
  generatedAt: new Date().toISOString(),
  scope: '阶段 D 放行后 18 §4 缺口的独立复验：完整对局终局 + WELCOME(带 view) 恢复 + 结束页→回到房间',
  honesty: [
    '协议级 bot 推进 + 真实 Chrome 页面验证；不冒充「4 个浏览器页面全 UI 打完一局」',
    'phase-d-browser-verify.mjs 的 FLOW-09 / EXIT-05 仍为 NOT_RUN，本脚本不改判',
    '历史 FAIL(2026-11-07) / CONCERNS(2026-11-08) 快照原样保留，未覆盖',
    '真机 / iOS Safari / 微信内置 / 国产自带浏览器仍 BLOCKED',
  ],
  run: { backendPort: CFG.backendPort, cdpPort: CFG.cdpPort, room: CFG.room,
    players: 4, names: NAMES, ws: WS },
  checks: [],
  botStdout: [],
  serverLogs: [],
  browser: {},
  cleanup: {},
};
function check(id, status, observed, expected, notes) {
  rep.checks.push({ id, status, observed, expected: expected ?? null, notes: notes ?? '', at: new Date().toISOString() });
}
const now = () => new Date().toISOString();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}
function localHttp(port, pathname, timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* 继续 */ }
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}`);
    await sleep(150);
  }
}

// ---------------------------------------------------------------- CDP 极简客户端
class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.events = []; }
  async connect() {
    // ws 是 apps/server 的依赖，从 probe/ 无法按包名解析；用 createRequire 锚定到 apps/server
    const { createRequire } = await import('node:module');
    const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
    const WebSocket = require('ws');
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) this.events.push(m);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  async clickSelector(sel) {
    const box = await this.eval(`(() => { const e=document.querySelector(${JSON.stringify(sel)});
      if(!e) return null; const r=e.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}; })()`);
    if (!box || box.w === 0 || box.h === 0) throw new Error(`不可点击: ${sel}`);
    await this.click(Math.round(box.x), Math.round(box.y));
    return box;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}
async function cdpHttp(method, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: CFG.cdpPort, path: pathname, method, timeout: 4000 }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject); req.end();
  });
}

let server = null, chrome = null, profile = null, bots = [];
async function cleanup() {
  for (const b of bots) { try { b.kill('SIGTERM'); } catch { /* ignore */ } }
  if (chrome) { try { chrome.kill('SIGTERM'); } catch { /* ignore */ } }
  if (server) { try { server.kill('SIGTERM'); } catch { /* ignore */ } }
  if (profile && !CFG.keep) { try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }
  rep.cleanup = { at: now(), botsKilled: bots.length, chromeKilled: !!chrome,
    serverKilled: !!server, profileRemoved: !!profile && !CFG.keep };
}

async function main() {
  // 前置：端口空闲、Chrome 存在、构建产物存在
  for (const [label, p] of [['backend', CFG.backendPort], ['cdp', CFG.cdpPort]]) {
    if (!(await portFree(p))) throw new Error(`端口被占用: ${label}:${p}`);
  }
  if (!existsSync(CFG.chrome)) throw new Error(`Chrome 不存在: ${CFG.chrome}`);
  if (!existsSync(path.join(ROOT, 'apps/server/dist/server.cjs'))) throw new Error('缺少 dist/server.cjs，先 pnpm build');
  if (CFG.shots) mkdirSync(SHOTS, { recursive: true });

  // 1) 起单端口服务
  server = spawn('node', ['apps/server/dist/server.cjs'], {
    cwd: ROOT, env: { ...process.env, PORT: String(CFG.backendPort), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => rep.serverLogs.push(String(d).trim()));
  server.stderr.on('data', (d) => rep.serverLogs.push(`[stderr] ${String(d).trim()}`));
  await waitFor(async () => {
    const r = await localHttp(CFG.backendPort, '/health');
    return r.status === 200 ? r : null;
  }, 15000, '服务端 /health');
  check('CL-01', 'PASS', { backendPort: CFG.backendPort, health: (await localHttp(CFG.backendPort, '/health')).body.slice(0, 200) },
    '独立端口 127.0.0.1 起单端口服务、/health 200', '静态托管 dist/public；不碰 8787/5173 与线上房间');

  // 2) 4 个 bot 跑完整对局到 ended
  const ended = { seen: false, winner: null, scores: null, line: null, by: null };
  // 4 人满员会自动开局（room.join:234），**不能加 --host**：
  // host 会一直等下一条 LOBBY(players>=2)，开局后不再广播 LOBBY → 15s 超时退出，
  // 它占的座位从此无人行动，对局卡死。改为串行入座 + 无 host，4 个 bot 自行轮流推进。
  for (let i = 0; i < NAMES.length; i += 1) {
    const name = NAMES[i];
    const args = ['scripts/bot.ts', WS, name, '--fast'];
    const b = spawn('npx', ['tsx', ...args], { cwd: path.join(ROOT, 'apps/server'),
      env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    b.stdout.on('data', (d) => {
      const s = String(d);
      rep.botStdout.push({ name, at: now(), text: s.trim().slice(0, 400) });
      const m = /对局结束：胜者 (\d+) 号「([^」]*)」，比分 ([\d:]+)/.exec(s);
      if (m && !ended.seen) {
        ended.seen = true; ended.winner = Number(m[1]); ended.winnerName = m[2];
        ended.scores = m[3].split(':').map(Number); ended.line = s.trim(); ended.by = name;
      }
    });
    b.stderr.on('data', (d) => rep.botStdout.push({ name, at: now(), stderr: String(d).trim().slice(0, 400) }));
    bots.push(b);
    await sleep(300);   // 串行入座，避免 JOIN 竞态导致座位与名字错位
  }
  try {
    await waitFor(async () => ended.seen, CFG.botTimeoutMs, 'bot 对局到 ended');
  } catch (e) {
    check('CL-02', 'FAIL', { error: e.message, stdoutTail: rep.botStdout.slice(-12) },
      '4 个 bot 协议推进到 phase=ended', '超时未观察到对局结束');
    throw e;
  }
  check('CL-02', 'PASS', { winner: ended.winner, winnerName: ended.winnerName,
    scores: ended.scores, line: ended.line, reportedBy: ended.by, room: CFG.room },
    '4 个真实 WS 玩家完整对局到 phase=ended，有胜者与分数',
    '协议级 bot 推进；不是 4 个浏览器页面全 UI 打完一局（FLOW-09 仍 NOT_RUN）');

  // 等 bot 全部退出释放 socket（同名重连才不会被 SEAT_TAKEN 挡）
  await sleep(1200);
  for (const b of bots) { try { b.kill('SIGTERM'); } catch { /* ignore */ } }
  await sleep(600);

  // 3) CDP 真实 Chrome：同名重连 → WELCOME 带 view(phase=ended)
  profile = mkdtempSync(path.join(os.tmpdir(), 'hexfront-close-'));
  chrome = spawn(CFG.chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--proxy-bypass-list=*', '--remote-allow-origins=*',
    `--remote-debugging-port=${CFG.cdpPort}`, `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stderr.on('data', (d) => rep.serverLogs.push(`[chrome] ${String(d).trim().slice(0, 200)}`));
  await waitFor(async () => {
    const r = await cdpHttp('GET', '/json/version').catch(() => null);
    return r && r.status === 200 ? r : null;
  }, 15000, 'CDP /json/version');
  const ver = JSON.parse((await cdpHttp('GET', '/json/version')).body);
  rep.browser.chromeVersion = ver.Browser;
  const target = await cdpHttp('PUT', `/json/new?${encodeURIComponent('about:blank')}`);
  const tab = JSON.parse(target.body);
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });

  const url = `http://127.0.0.1:${CFG.backendPort}/?name=${encodeURIComponent(NAMES[0])}&room=${CFG.room}`;
  await cdp.send('Page.navigate', { url });
  const view = await waitFor(async () => {
    const v = await cdp.eval(`(() => { const h=window.__hex; return h && h.view ? {
      phase:h.view.phase, current:h.view.current, viewer:h.view.viewer, turn:h.view.turn,
      winner:h.view.winner, scores:h.view.scores, seat:h.seat, roomId:h.roomId } : null; })()`).catch(() => null);
    return v && v.phase === 'ended' ? v : null;
  }, 20000, '浏览器收到 ended 视图');
  rep.browser.endedView = view;
  check('CL-03', 'PASS', { view, url, via: '同名重连 → WELCOME.view (phase=ended)' },
    '重连玩家通过带 view 的 WELCOME 直接进入已结束对局（UL-UX07 恢复路径）',
    '服务端 JOIN 同名重连，room.join 返回 viewOf(seat)，room.ts:222 / server.ts:248');

  // 4) 结束页 DOM：胜者 / 分数 / 回房间入口
  const endUi = await cdp.eval(`(() => { const e=document.getElementById('end-screen');
    return { exists:!!e, hidden:e?e.classList.contains('hidden'):null,
      text:e?e.textContent.replace(/\\s+/g,' ').trim().slice(0,400):null,
      back:!!document.getElementById('end-back'),
      mode:document.getElementById('shell')?.dataset.landscapeMode ?? null,
      hudHidden:document.getElementById('landscape-hud')?.classList.contains('hidden') ?? null }; })()`);
  rep.browser.endUi = endUi;
  const endOk = endUi.exists && !endUi.hidden && endUi.back
    && endUi.text.includes(String(ended.winnerName));
  check('CL-04', endOk ? 'PASS' : 'FAIL', { endUi, expectWinnerName: ended.winnerName },
    '结束页可见、含胜者/分数、「回到房间」入口存在', '真实浏览器 DOM 读取');
  if (CFG.shots) await cdp.shot(path.join(SHOTS, '01-game-ended.png'));

  // 5) 真实指针点「回到房间」→ 退出自转（UL-UX07 / E6）
  let backClick = null;
  try { backClick = await cdp.clickSelector('#end-back'); } catch (e) {
    check('CL-05', 'FAIL', { error: e.message }, '「回到房间」真实可点', '按钮不可见');
  }
  await sleep(350);
  const afterBack = await cdp.eval(`(() => ({ mode:document.getElementById('shell')?.dataset.landscapeMode ?? null,
    endHidden:document.getElementById('end-screen')?.classList.contains('hidden') ?? null,
    overlayHidden:document.getElementById('overlay')?.classList.contains('hidden') ?? null }))()`);
  const backOk = !!backClick && afterBack.mode === 'off' && afterBack.endHidden === true;
  check('CL-05', backOk ? 'PASS' : 'FAIL', { backClick, afterBack },
    '点「回到房间」退出自转（mode=off）、结束页收起、回到 S0 竖屏入房',
    'CDP 真实指针 + 真实 DOM');
  if (CFG.shots) await cdp.shot(path.join(SHOTS, '02-back-to-room.png'));

  // 6) /health 对账：房间仍是同一局、已开局
  const health = JSON.parse((await localHttp(CFG.backendPort, '/health')).body);
  const roomState = health.rooms.find((r) => r.id === CFG.room) ?? null;
  rep.browser.healthRoom = roomState;
  check('CL-06', roomState && roomState.started ? 'PASS' : 'FAIL', { roomState },
    '服务端内存中仍是同一已开局房间（未重开、未丢状态）', '/health 只读');

  cdp.close();
}

main()
  .then(() => {
    const tally = {};
    for (const c of rep.checks) tally[c.status] = (tally[c.status] || 0) + 1;
    rep.summary = { ...tally, total: rep.checks.length,
      gate: rep.checks.some((c) => c.status === 'FAIL') ? 'FAIL' : 'PASS(NARROW_SCOPE)' };
    rep.cleanup = { ...rep.cleanup, at: now() };
    writeFileSync(REPORT, JSON.stringify(rep, null, 2) + '\n', 'utf8');
    console.log(`[phase-d-closure] ${JSON.stringify(rep.summary)} 报告: ${path.relative(ROOT, REPORT)}`);
  })
  .catch((e) => {
    rep.error = { message: e.message, stack: String(e.stack || '').slice(0, 1200), at: now() };
    rep.summary = { gate: 'ERROR', error: e.message };
    writeFileSync(REPORT, JSON.stringify(rep, null, 2) + '\n', 'utf8');
    console.error(`[phase-d-closure] ERROR: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(cleanup);
