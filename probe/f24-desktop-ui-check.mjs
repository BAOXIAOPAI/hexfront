#!/usr/bin/env node
/**
 * 文档 24 桌面真实 UI 验收（真实 Chrome + CDP，非协议机器人）。
 *
 * 覆盖本轮七项中的可 UI 验证部分：
 *   F1 创建/加入分离、创建者即房主
 *   F2 人数改到 6 人自动扩展盘、改地图不误标手动
 *   F5 银行 4:1 与「我的港口」是两个独立入口；无港口不可兑换
 *   F6 两步交易「我想收到 → 我愿给出 → 摘要发送」
 *   F3 桌面视口不自转、低于 1280×720 出现桌面提示
 *   F4 棋盘数字/装饰不可被文本选中
 *
 * 用法（仓库根目录，先启动本地服务）：
 *   node probe/f24-desktop-ui-check.mjs
 * 输出：结构化 JSON + probe/f24-desktop-ui-report.json + docs/shots/f24-*.png
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.F24_PORT ?? 18999);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'docs', 'shots');
const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Node 内置 WebSocket 与 Chrome CDP 的握手在某些版本会静默挂起；统一用仓库已有的 ws
const require = createRequire(path.join(ROOT, 'apps', 'server', 'index.cjs'));
const WsClient = require('ws');
if (typeof WsClient !== 'function') throw new Error(`ws 模块解析失败: ${typeof WsClient}`);

if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------------------
// 极简 CDP 客户端
// ---------------------------------------------------------------------------
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    const onMessage = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (process.env.F24_DEBUG) console.log('[cdp<-]', JSON.stringify(msg).slice(0, 160));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    };
    // ws 包与内置 WebSocket 的监听 API 不同，两种都挂，谁生效都行
    if (typeof ws.on === 'function') ws.on('message', onMessage);
    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('message', (ev) => onMessage(ev.data ?? ev));
    }
  }
  send(method, params = {}, sessionId = undefined) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      // 每个 CDP 调用都要有超时：否则一次丢包会让整个验收静默挂起
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, 10000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'eval error');
    return r.result?.value;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, 'base64'));
    return file;
  }
}

/**
 * 用固定调试端口 + 轮询 /json/version 判断就绪。
 * 不用 --remote-debugging-port=0：部分沙箱下 Chrome 不打印
 * "DevTools listening on …"，无法从 stderr 解析端口。
 */
async function launchChrome(profile) {
  const port = Number(process.env.F24_CDP_PORT ?? 19331);
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    // 沙箱环境下新 target 会立刻 Inspector.targetCrashed：关掉 GPU/沙箱并给足共享内存
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', '--disable-gpu', '--disable-software-rasterizer',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    // CDP 的 WebSocket 会校验 Origin；不放开会被静默拒绝（表现为消息永不到达）
    '--remote-allow-origins=*',
    '--window-size=1440,900', 'about:blank',
  // 关键：不要继承/管道 Chrome 的 stdout，否则主进程后续 console 输出会被吞掉
  ], { stdio: 'ignore' });
  const logs = [];
  for (let i = 0; i < 40; i++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 1000);
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ac.signal });
      clearTimeout(timer);
      if (res.ok) {
        console.log('[f24] chrome ready on', port);
        return { proc, port, logs };
      }
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error(`Chrome CDP 未就绪：${logs.join('').slice(-500)}`);
}

/**
 * 新建一个独立页面并挂上扁平 CDP 会话。
 *
 * 关键：Chrome 的每个 page target 只允许一个调试器；直接连 /devtools/page/<id>
 * 会被立刻以 1006 关闭。正确做法是连浏览器级 /devtools/browser/<id>，
 * 再用 Target.createTarget + Target.attachToTarget{flatten:true} 拿 sessionId，
 * 之后所有命令都带 sessionId 路由。
 */
async function newPage(browser) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const page = {
    targetId,
    sessionId,
    send: (method, params = {}) => browser.send(method, params, sessionId),
    eval: async (expression) => {
      const r = await browser.send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'eval error');
      return r.result?.value;
    },
    shot: async (file) => {
      const r = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, 'base64'));
      return file;
    },
  };
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  return page;
}

async function goto(cdp, url) {
  await cdp.send('Page.navigate', { url });
  for (let i = 0; i < 40; i++) {
    const ready = await cdp.eval('!!window.__hex || !!document.getElementById("join-form")');
    if (ready) break;
    await sleep(150);
  }
  await sleep(350);
}

async function setViewport(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  // 只改指标不会触发 resize：显式派发一次，页面才会重算桌面门槛提示
  await cdp.eval('window.dispatchEvent(new Event("resize"))');
  await sleep(150);
}

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

const roomId = `f24-${Date.now().toString(36)}`;

async function main() {
  const profile = `/tmp/hexfront-f24-profile-${Date.now()}`;
  const { proc, port } = await launchChrome(profile);
  const report = { roomId, checks: results, shots: [], startedAt: new Date().toISOString() };

  // 连浏览器级 endpoint（每个 page target 只允许一个调试器，页面级直连会被 1006 拒绝）
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browserWs = new WsClient(version.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('浏览器级 CDP 连接超时')), 8000);
    browserWs.once('open', () => { clearTimeout(t); resolve(); });
    browserWs.once('error', (e) => { clearTimeout(t); reject(e); });
  });
  const browser = new Cdp(browserWs);
  console.log('[f24] browser cdp ready');

  try {
    // ---------------- F1 创建 / 加入分离 ----------------
    const host = await newPage(browser);
    await setViewport(host, 1440, 900);
    await goto(host, `${BASE}/?room=${roomId}`);

    const joinForm = await host.eval(`(() => {
      const sheet = document.getElementById('sheet');
      return {
        hasJoin: !!document.querySelector('button[name="intent"][value="join"]'),
        hasCreate: !!document.querySelector('button[name="intent"][value="create"]'),
        text: sheet ? sheet.textContent : '',
      };
    })()`);
    check('F1-01 入房表单同时有「加入房间」与「创建房间」两个显式按钮',
      joinForm.hasJoin && joinForm.hasCreate, JSON.stringify(joinForm));

    // 先尝试加入不存在的房间 → 应停在错误页（ROOM_NOT_FOUND），且不创建房间
    await host.eval(`(() => {
      const name = document.getElementById('f-name');
      name.value = '房主甲';
      const join = document.querySelector('button[name="intent"][value="join"]');
      join.click();
      return true;
    })()`);
    await sleep(900);
    const notFound = await host.eval(`(() => {
      const sheet = document.getElementById('sheet');
      return { text: sheet ? sheet.textContent : '', overlayHidden: document.getElementById('overlay').classList.contains('hidden') };
    })()`);
    const healthAfterJoin = await (await fetch(`${BASE}/health`)).json();
    check('F1-02 加入不存在房间被明确拒绝（ROOM_NOT_FOUND），且服务端没有产生房间',
      /还不存在|ROOM_NOT_FOUND/.test(notFound.text)
        && !healthAfterJoin.rooms.some((r) => r.id === roomId),
      notFound.text.slice(0, 80));

    // 回到首页，改为创建
    await goto(host, `${BASE}/?room=${roomId}`);
    await host.eval(`(() => {
      document.getElementById('f-name').value = '房主甲';
      document.getElementById('f-players').value = '4';
      document.querySelector('button[name="intent"][value="create"]').click();
      return true;
    })()`);
    await sleep(1200);
    const created = await host.eval(`(() => {
      const h = window.__hex;
      return {
        roomId: h?.roomId, seat: h?.seat, capacity: h?.capacity,
        lobbyText: document.getElementById('sheet')?.textContent ?? '',
        overlayHidden: document.getElementById('overlay').classList.contains('hidden'),
      };
    })()`);
    const healthCreated = await (await fetch(`${BASE}/health`)).json();
    const roomInfo = healthCreated.rooms.find((r) => r.id === roomId);
    check('F1-03 创建成功后房间存在、创建者入座（seat 0）且成为房主',
      !!roomInfo && created.seat === 0 && /房主/.test(created.lobbyText),
      JSON.stringify({ roomInfo, seat: created.seat }));
    report.shots.push(await host.shot('f24-01-host-lobby-1440.png'));

    // 第二人加入：不抢房主
    const guest = await newPage(browser);
    await setViewport(guest, 1440, 900);
    await goto(guest, `${BASE}/?room=${roomId}`);
    await guest.eval(`(() => {
      document.getElementById('f-name').value = '客人乙';
      document.querySelector('button[name="intent"][value="join"]').click();
      return true;
    })()`);
    await sleep(1200);
    const guestState = await guest.eval(`(() => {
      const h = window.__hex;
      return { seat: h?.seat, text: document.getElementById('sheet')?.textContent ?? '' };
    })()`);
    const hostLobbyText = await host.eval(`document.getElementById('sheet')?.textContent ?? ''`);
    check('F1-04 加入者入座 seat 1，房主仍是创建者（不抢房主）',
      guestState.seat === 1 && /房主/.test(hostLobbyText) && /房主甲/.test(hostLobbyText),
      `guest.seat=${guestState.seat}`);

    // ---------------- F2 人数 × 棋盘联动 ----------------
    const beforeMap = await host.eval(`(() => {
      const t = document.querySelector('.lb-map-meta')?.textContent ?? '';
      return t;
    })()`);
    await host.eval(`(() => {
      const sel = document.getElementById('lb-players');
      sel.value = '6';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(1200);
    const afterCount = await host.eval(`(() => ({
      meta: document.querySelector('.lb-map-meta')?.textContent ?? '',
      hexCount: document.querySelectorAll('.lb-hex').length,
      boardSelect: document.getElementById('lb-board')?.value,
      playersSelect: document.getElementById('lb-players')?.value,
      manualTag: !!document.querySelector('.lb-tag'),
    }))()`);
    check('F2-01 人数改到 6 人自动切换 30 格扩展盘（不是把当前盘误标手动）',
      afterCount.hexCount === 30 && afterCount.boardSelect === 'ext' && !afterCount.manualTag,
      JSON.stringify(afterCount));
    check('F2-02 地图预览与人数同步广播（快照摘要变化）',
      afterCount.meta !== beforeMap, `${beforeMap} → ${afterCount.meta}`);
    report.shots.push(await host.shot('f24-02-ext-30hex-6p-1440.png'));

    // 手动改回标准盘 → 标记自定义
    await host.eval(`(() => {
      const sel = document.getElementById('lb-board');
      sel.value = 'base';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(1000);
    const manual = await host.eval(`(() => ({
      hexCount: document.querySelectorAll('.lb-hex').length,
      manualTag: !!document.querySelector('.lb-tag'),
      warn: !!document.querySelector('.lb-warn'),
    }))()`);
    check('F2-03 明确手选地图标记「自定义地图」并给出拥挤提示',
      manual.hexCount === 19 && manual.manualTag, JSON.stringify(manual));

    // 人数改回 4（应用推荐 base，清 manual）
    await host.eval(`(() => {
      const sel = document.getElementById('lb-players');
      sel.value = '4';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(1000);
    const back4 = await host.eval(`(() => ({
      hexCount: document.querySelectorAll('.lb-hex').length,
      manualTag: !!document.querySelector('.lb-tag'),
    }))()`);
    check('F2-04 人数改回 4 人重新应用推荐标准盘并清除自定义标记',
      back4.hexCount === 19 && !back4.manualTag, JSON.stringify(back4));

    // ---------------- F3 桌面视口不自转 + 低视口提示 ----------------
    const landscapeState = await host.eval(`(() => ({
      mode: document.getElementById('shell').dataset.landscapeMode,
      hudHidden: document.getElementById('landscape-hud').classList.contains('hidden'),
      desktopGateHidden: document.getElementById('desktop-gate')?.classList.contains('hidden'),
    }))()`);
    check('F3-01 1440×900 桌面视口不自转、不显示手机转向提示',
      landscapeState.mode === 'off' && landscapeState.hudHidden, JSON.stringify(landscapeState));

    await setViewport(host, 1100, 700);
    await sleep(600);
    const smallVp = await host.eval(`(() => ({
      gateHidden: document.getElementById('desktop-gate')?.classList.contains('hidden'),
      gateText: document.getElementById('desktop-gate')?.textContent?.trim() ?? '',
      mode: document.getElementById('shell').dataset.landscapeMode,
    }))()`);
    check('F3-02 低于 1280×720 出现桌面提示且仍不自转',
      smallVp.gateHidden === false && /1280/.test(smallVp.gateText) && smallVp.mode === 'off',
      JSON.stringify(smallVp));
    report.shots.push(await host.shot('f24-03-desktop-gate-1100.png'));
    await setViewport(host, 1440, 900);
    await sleep(400);

    // ---------------- 开局进入对局，验证 F4/F5/F6 ----------------
    // 房主 + 客人各点准备，然后房主开始
    await host.eval(`(() => { document.querySelector('[data-act="ready"]')?.click(); return true; })()`);
    await guest.eval(`(() => { document.querySelector('[data-act="ready"]')?.click(); return true; })()`);
    await sleep(800);
    const canStart = await host.eval(`(() => {
      const b = document.querySelector('[data-act="start"]');
      return { exists: !!b, disabled: b?.disabled ?? true, block: document.querySelector('.hint')?.textContent ?? '' };
    })()`);
    check('F2-05 4 人房只有 2 人时不能开始（人数未达标）',
      canStart.exists && canStart.disabled === true, JSON.stringify(canStart));

    // 补两个协议级玩家入座，凑满 4 人（不冒充 UI 对局，仅为本轮 UI 验收准备座位）
    const { createRequire } = await import('node:module');
    const require = createRequire(path.join(ROOT, 'apps/server/index.cjs'));
    const WebSocket = require('ws');
    const fillers = [];
    for (const name of ['丙', '丁']) {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?sharecode=f24`);
      await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
      ws.send(JSON.stringify({ t: 'JOIN', roomId, name, v: 4 }));
      await new Promise((res) => { ws.once('message', res); });
      ws.send(JSON.stringify({ t: 'READY', ready: true }));
      fillers.push(ws);
    }
    await sleep(900);
    // 配置/入座广播会清空准备态：等座位稳定后，按当前真实状态逐个补齐（不盲点两次）
    const readyAll = async () => {
      for (const page of [host, guest]) {
        const st = await page.eval(`(() => {
          const b = document.querySelector('[data-act="ready"]');
          return { exists: !!b, text: b?.textContent ?? '' };
        })()`);
        if (st.exists && st.text.includes('我准备好了')) {
          await page.eval(`(() => { document.querySelector('[data-act="ready"]').click(); return true; })()`);
          await sleep(400);
        }
      }
    };
    await readyAll();
    await sleep(700);
    await readyAll();   // 第二次兜底：期间若有广播清准备，这里补回
    await sleep(700);
    const startable = await host.eval(`(() => {
      const b = document.querySelector('[data-act="start"]');
      return { disabled: b?.disabled ?? true };
    })()`);
    check('F2-06 满 4 人且全员准备后房主可开始', startable.disabled === false, JSON.stringify(startable));

    await host.eval(`(() => { document.querySelector('[data-act="start"]')?.click(); return true; })()`);
    await sleep(1500);
    const inGame = await host.eval(`(() => ({
      phase: window.__hex?.view?.phase ?? null,
      overlayHidden: document.getElementById('overlay').classList.contains('hidden'),
      mode: document.getElementById('shell').dataset.landscapeMode,
    }))()`);
    check('F3-03 开局后桌面视口仍不自转（保持桌面专用流程）',
      inGame.phase === 'setup' && inGame.overlayHidden && inGame.mode === 'off',
      JSON.stringify(inGame));
    report.shots.push(await host.shot('f24-04-setup-board-1440.png'));

    // ---------------- F4 棋盘不可选中文字 ----------------
    const selectable = await host.eval(`(() => {
      const board = document.getElementById('board');
      const cs = getComputedStyle(board);
      const text = board.querySelector('text');
      const textCs = text ? getComputedStyle(text) : null;
      return {
        boardUserSelect: cs.userSelect || cs.webkitUserSelect,
        textUserSelect: textCs ? (textCs.userSelect || textCs.webkitUserSelect) : null,
        textCount: board.querySelectorAll('text').length,
      };
    })()`);
    check('F4-01 棋盘 SVG 与其中文字禁止文本选择（user-select: none）',
      selectable.boardUserSelect === 'none' && selectable.textUserSelect === 'none',
      JSON.stringify(selectable));

    // 数字圆片几何：主圆/内圈/数字/6-8 红环必须同心，纸雕阴影独立下移 3px
    const geometry = await host.eval(`(() => {
      const tiles = [...document.querySelectorAll('#board .tile')];
      const withNumber = tiles.filter((t) => {
        const g = t.querySelector('g[pointer-events="none"]');
        return g && [...g.querySelectorAll('text')].some((x) => /^\\d+$/.test((x.textContent || '').trim()));
      });
      const pick = withNumber[0];
      if (!pick) return null;
      const g = pick.querySelector('g[pointer-events="none"]');
      const circles = [...g.querySelectorAll('circle')].map((c) => ({
        cy: Number(c.getAttribute('cy')), r: Number(c.getAttribute('r')),
        // 阴影圆包在 <g filter="url(#soft)"> 里；其余是主圆/内圈/红环/pips
        shadow: !!c.closest('g[filter]'),
      }));
      const numText = [...g.querySelectorAll('text')].find((x) => /^\\d+$/.test((x.textContent || '').trim()));
      return {
        tileKey: pick.getAttribute('data-key'),
        number: numText ? numText.textContent.trim() : null,
        textY: numText ? Number(numText.getAttribute('y')) : null,
        textAnchor: numText ? numText.getAttribute('text-anchor') : null,
        baseline: numText ? numText.getAttribute('dominant-baseline') : null,
        textPointerEvents: numText ? getComputedStyle(numText).pointerEvents : null,
        circles,
        discCount: withNumber.length,
      };
    })()`);
    report.geometry = geometry;
    // 主圆/内圈/红环/数字必须同一 cy；阴影是独立的、下移 3px 的圆（包在 filter 组里）
    const discs = (geometry?.circles ?? []).filter((c) => c.r >= 15 && !c.shadow);
    const shadows = (geometry?.circles ?? []).filter((c) => c.shadow);
    const mainCy = new Set(discs.filter((c) => c.r >= 18).map((c) => c.cy));
    const innerCy = new Set(discs.filter((c) => c.r < 18).map((c) => c.cy));
    const shadowOk = shadows.length === 1 && [...mainCy].length === 1
      && shadows[0].cy === [...mainCy][0] + 3;
    check('F4-02 数字圆片：主圆/内圈/数字同心，纸雕阴影独立下移，文字不可选中',
      !!geometry && mainCy.size === 1 && innerCy.size === 1
        && geometry.textY === [...mainCy][0] && geometry.textAnchor === 'middle'
        && geometry.baseline === 'central' && geometry.textPointerEvents === 'none'
        && shadowOk,
      JSON.stringify({ key: geometry?.tileKey, num: geometry?.number,
        mainCy: [...mainCy], innerCy: [...innerCy], shadowCy: shadows.map((c) => c.cy),
        textY: geometry?.textY }));

    // 昵称输入仍可选中（可复制信息不被误伤）
    await host.eval(`(() => {
      const input = document.createElement('input');
      input.id = 'f24-probe-input';
      document.body.appendChild(input);
      return true;
    })()`);
    const inputSelect = await host.eval(`(() => {
      const cs = getComputedStyle(document.getElementById('f24-probe-input'));
      return cs.userSelect || cs.webkitUserSelect;
    })()`);
    check('F4-03 普通输入框仍可选中文字（未被全局规则误伤）',
      inputSelect !== 'none', String(inputSelect));

    // ---------------- F5 银行 / 港口入口分离 ----------------
    // 让房主成为当前玩家并结束摆位：用协议层驱动其余座位代放更快，
    // 这里只验证入口存在与禁用原因，不伪造对局结果。
    const railText = await host.eval(`(() => {
      const rail = document.getElementById('rail-actions');
      return { html: rail?.innerHTML ?? '', text: rail?.textContent ?? '' };
    })()`);
    check('F5-01 行动区出现「银行兑换」与「我的港口兑换」两个独立入口，且无「借港代换」',
      /银行兑换/.test(railText.text) && /我的港口兑换/.test(railText.text) && !/借港代换/.test(railText.text),
      railText.text.replace(/\s+/g, ' ').slice(0, 120));

    // ---------------- F6 两步交易面板 ----------------
    const offerPanel = await host.eval(`(() => {
      const btn = document.querySelector('#rail-actions [data-panel="offers"]');
      if (!btn) return { found: false };
      btn.click();
      return { found: true };
    })()`);
    await sleep(600);
    const offerUi = await host.eval(`(() => {
      const body = document.getElementById('extra-panel')?.textContent ?? '';
      const foot = document.getElementById('drawer-foot')?.textContent ?? '';
      return { body, foot };
    })()`);
    check('F6-01 报价面板是两步流程：第一步「我想收到」+「下一步：我愿给出」',
      /我想收到/.test(offerUi.body) && /下一步/.test(offerUi.foot),
      `${offerUi.body.slice(0, 60)} | ${offerUi.foot.slice(0, 60)}`);
    report.shots.push(await host.shot('f24-05-offer-step1-1440.png'));

    await host.eval(`(() => {
      const next = [...document.querySelectorAll('#drawer-foot [data-foot]')].find(b => b.dataset.foot === 'offer-next');
      next?.click();
      return true;
    })()`);
    await sleep(500);
    const step2 = await host.eval(`(() => ({
      body: document.getElementById('extra-panel')?.textContent ?? '',
      foot: document.getElementById('drawer-foot')?.textContent ?? '',
      hasRange: document.querySelectorAll('#extra-panel input[type="range"]').length,
    }))()`);
    // 摆位阶段「发送」被 offerSendGate 正确禁用并给出原因，这是产品预期行为；
    // 这里验证两步结构与滑条存在，且发送按钮给出「当前阶段不能报价」的明确原因。
    check('F6-02 第二步「我愿给出」有滑条与完整条件摘要，发送按钮按阶段给出禁用原因',
      /我愿给出/.test(step2.body) && /完整条件/.test(step2.body)
        && step2.hasRange === 5 && /当前阶段不能报价/.test(step2.foot),
      JSON.stringify({ ranges: step2.hasRange, foot: step2.foot.replace(/\s+/g, ' ').slice(0, 80) }));
    report.shots.push(await host.shot('f24-06-offer-step2-1440.png'));

    // ---------------- 1280×720 最低尺寸复验 ----------------
    await setViewport(host, 1280, 720);
    await sleep(600);
    const minVp = await host.eval(`(() => ({
      mode: document.getElementById('shell').dataset.landscapeMode,
      gateHidden: document.getElementById('desktop-gate')?.classList.contains('hidden'),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    }))()`);
    check('F3-04 1280×720 下不自转、不显示门槛提示、无横向溢出',
      minVp.mode === 'off' && minVp.gateHidden === true && minVp.overflowX === false,
      JSON.stringify(minVp));
    report.shots.push(await host.shot('f24-07-min-1280x720.png'));

    for (const ws of fillers) ws.terminate();
  } catch (err) {
    report.error = String(err);
    console.error('ERROR', err);
  } finally {
    proc.kill('SIGTERM');
    report.finishedAt = new Date().toISOString();
    report.passed = results.filter((r) => r.ok).length;
    report.failed = results.filter((r) => !r.ok).length;
    writeFileSync(path.join(ROOT, 'probe', 'f24-desktop-ui-report.json'),
      `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\n${report.passed} passed, ${report.failed} failed`);
    // 不用 process.exit：它会丢掉尚未 flush 的 stdout，导致验收脚本「静默成功」
    process.exitCode = report.failed === 0 && !report.error ? 0 : 1;
  }
}

console.log('[f24] script start');
main().catch((err) => {
  console.error('F24 验收脚本异常：', err);
  process.exitCode = 1;
});
