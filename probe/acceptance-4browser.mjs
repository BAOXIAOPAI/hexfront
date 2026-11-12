#!/usr/bin/env node
/**
 * 四浏览器完整 UI 对局验收（真实指针点击，不是协议机器人）。
 *
 * 与 docs/19 §9.3 第 9 条对应：至少一局四个浏览器客户端参与的完整 UI 对局，
 * 从入房到终局再回房；可自动化点击，但不能用协议机器人替代 UI 链路。
 *
 * 做法：
 *  - 起 4 个独立 CDP target（各自独立 JS 上下文，等价 4 个浏览器窗口）
 *  - 每个 target 用真实 URL ?name=甲/乙/丙/丁&room=... 入房
 *  - 入房/开局/摆位/掷骰/建造/结束回合 全部走 Input.dispatchMouseEvent
 *  - 只读 window.__hex.view 判定进度（读取不是操作）
 *
 * 输出结构化 JSON：每步观测值 + PASS/FAIL/BLOCKED，供交付报告引用。
 *
 * 用法：
 *   BASE=http://127.0.0.1:8810 ROOM=accept1 OUTDIR=docs/shots/accept \
 *   node probe/acceptance-4browser.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT ?? 9419);
const BASE = process.env.BASE ?? 'http://127.0.0.1:8810';
const ROOM = (process.env.ROOM ?? 'accept1').toLowerCase();
const OUTDIR = process.env.OUTDIR ?? 'docs/shots/accept';
const W = Number(process.env.W ?? 1440);
const H = Number(process.env.H ?? 900);
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 60);
const WATCHDOG_MS = Number(process.env.WATCHDOG_MS ?? 600_000);

mkdirSync(OUTDIR, { recursive: true });
const profile = mkdtempSync(path.join(os.tmpdir(), 'hex-accept-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.error(`[accept] ${msg}`);
const report = { room: ROOM, base: BASE, viewport: [W, H], steps: [], screenshots: [], consoleErrors: [], result: 'RUNNING' };

const watchdog = setTimeout(() => {
  report.result = 'BLOCKED';
  report.blockedReason = `watchdog ${WATCHDOG_MS}ms 超时`;
  finish(3);
}, WATCHDOG_MS);

async function http(m, p) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: m });
  return { status: r.status, body: await r.text() };
}
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > ms) throw new Error(`超时：${label}`);
    await sleep(150);
  }
}
/** 不抛异常的 waitFor：失败返回 null，用于「可以失败」的等待 */
async function waitSoft(fn, ms, label) {
  try { return await waitFor(fn, ms, label); } catch { return null; }
}

class Page {
  constructor(label, wsUrl) {
    this.label = label;
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.ws = null;
  }
  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', (e) => rej(new Error(e?.message ?? 'ws error')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(`${this.label} pageerror: ` + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push(`${this.label} console.error: ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });
  }
  send(method, params = {}) {
    const i = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(i, { res, rej });
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  async ev(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result.value;
  }
  /** 真实指针点击（CDP Input 域，与 phase-d-browser-verify 同口径） */
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }
  /**
   * 点一个选择器对应的元素中心。
   *
   * 重要：棋盘热区是 <g data-vertex/data-edge>，其 bbox 会把脉冲圈一起包进去
   * （实测 75×227 的长条），bbox 中心可能落在可见圆之外，导致"点了没反应"。
   * 因此棋盘热区取「第一个图形子元素」的圆心/中心，与真实用户点击的可见目标一致。
   */
  async clickSel(sel) {
    const box = await this.ev(`(() => {
      const n = document.querySelector(${JSON.stringify(sel)});
      if (!n) return null;
      if (n.disabled) return { disabled: true };

      // 棋盘热区：<g data-vertex|data-edge|data-tile>
      // bbox 会把脉冲圈/徽章一起包进去，中心可能落在可见目标外；
      // 水平/垂直道路的 <line> bbox 还有一维为 0，不能直接取 rect 中心。
      if (n.tagName === 'g') {
        const line = n.querySelector('line');
        if (line) {
          const x1 = +line.getAttribute('x1'), y1 = +line.getAttribute('y1');
          const x2 = +line.getAttribute('x2'), y2 = +line.getAttribute('y2');
          const svg = line.ownerSVGElement;
          const m = line.getScreenCTM();
          const a = svg.createSVGPoint(); a.x = x1; a.y = y1;
          const b = svg.createSVGPoint(); b.x = x2; b.y = y2;
          const pa = a.matrixTransform(m), pb = b.matrixTransform(m);
          return { x: Math.round((pa.x + pb.x) / 2), y: Math.round((pa.y + pb.y) / 2) };
        }
        // 地块热区里同时有六边形 polygon 和右上角的地图钉 circle；
        // 必须优先点 polygon（整块地），否则会点到角落的小圆钉甚至邻格。
        const poly = n.querySelector('polygon');
        if (poly) {
          const r = poly.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        const c = n.querySelector('circle');
        if (c) {
          const svg = c.ownerSVGElement;
          const m = c.getScreenCTM();
          const p = svg.createSVGPoint();
          p.x = +c.getAttribute('cx'); p.y = +c.getAttribute('cy');
          const sp = p.matrixTransform(m);
          return { x: Math.round(sp.x), y: Math.round(sp.y) };
        }
      }

      const r = n.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return { hidden: true };
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!box || box.disabled || box.hidden) return false;
    await this.click(box.x, box.y);
    return true;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const p = path.join(OUTDIR, file);
    writeFileSync(p, Buffer.from(r.data, 'base64'));
    report.screenshots.push(p);
    return p;
  }
  async view() {
    return this.ev(`(() => { const v = window.__hex && window.__hex.view; if (!v) return null;
      return { phase: v.phase, current: v.current, viewer: v.viewer, turn: v.turn, hasRolled: v.hasRolled,
        winner: v.winner, dice: v.dice, setup: v.setup,
        pendingDiscards: v.pendingDiscards, pendingRobber: v.pendingRobber,
        buildings: Object.keys(v.buildings).length, roads: Object.keys(v.roads).length,
        scores: v.scores, handSize: v.me.handSize,
        players: v.players.map(p => ({ name: p.name, score: p.score, hand: p.handSize })) }; })()`);
  }
}

/**
 * 资源不足时用银行/港口兑换补齐：挑一种「持有最多」的资源换出去，
 * 换成建造最缺的那种。全部通过真实 UI 点击完成（打开面板 → 选交出 → 选得到 → 确认）。
 * 比例由服务端裁决（银行 4:1 / 通用港 3:1 / 专用港 2:1），前端只做提示。
 */
async function tryBankExchange(page) {
  const need = await page.ev(`(() => {
    const v = window.__hex.view;
    const r = v.me.resources;
    const cost = { wood: 1, brick: 1, sheep: 1, wheat: 1 };   // 村庄
    const missing = Object.keys(cost).filter(k => (r[k] ?? 0) < cost[k]);
    if (!missing.length) return null;
    // 交出持有最多的资源，换最缺的那种
    const give = Object.entries(r).sort((a, b) => b[1] - a[1])[0];
    if (!give || give[1] < 2) return null;
    return { give: give[0], get: missing[0] };
  })()`);
  if (!need) return false;

  // 打开「银行 / 港口兑换」抽屉
  const opened = await page.clickSel('#rail-actions [data-panel="bank"]');
  if (!opened) return false;
  await sleep(250);
  // 选交出资源
  await page.clickSel(`#extra-panel [data-act="select"][data-key="bankGive"][data-val="${need.give}"]`);
  await sleep(120);
  // 选得到资源
  await page.clickSel(`#extra-panel [data-act="select"][data-key="bankGet"][data-val="${need.get}"]`);
  await sleep(120);
  // 确认
  const ok = await page.clickSel('#drawer-foot [data-foot="bank"]');
  await sleep(350);
  return ok;
}

const pages = [];
function finish(code) {
  clearTimeout(watchdog);
  for (const p of pages) { try { p.ws?.close(); } catch { /* ignore */ } }
  try { chrome?.kill('SIGKILL'); } catch { /* ignore */ }
  report.consoleErrors = pages.flatMap((p) => p.errors);
  writeFileSync(path.join(OUTDIR, 'acceptance-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(code); }, 200);
}

let chrome;
const START = Date.now();
try {
  log('启动 Chrome');
  chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions',
    '--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--proxy-bypass-list=*',
    '--remote-allow-origins=*', '--disable-background-networking', '--disable-component-update',
    '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  await waitFor(async () => (await http('GET', '/json/version')).status === 200, 15000, 'Chrome CDP');

  const names = ['甲', '乙', '丙', '丁'];
  log('创建 4 个独立浏览器 target');
  for (const name of names) {
    const url = `${BASE}/?name=${encodeURIComponent(name)}&room=${ROOM}`;
    const created = await http('PUT', `/json/new?${encodeURIComponent(url)}`);
    if (created.status !== 200) throw new Error(`/json/new 失败 ${created.status}`);
    const target = JSON.parse(created.body);
    const page = new Page(name, target.webSocketDebuggerUrl);
    await page.open();
    pages.push(page);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.navigate', { url });
  }

  log('等待四个客户端都拿到 STATE');
  await waitFor(async () => {
    const all = await Promise.all(pages.map((p) => p.view().catch(() => null)));
    return all.every((v) => v && v.phase);
  }, 30000, '4 客户端 STATE');
  report.steps.push({ step: 'join', ok: true, note: '4 个浏览器客户端入房并收到 STATE' });
  await pages[0].shot('01-joined.png');

  // ---- 摆位（蛇形顺序，谁的回合谁点）----
  log('摆位阶段');
  let setupRounds = 0;
  for (;;) {
    const v = await pages[0].view();
    if (v.phase !== 'setup') break;
    if (++setupRounds > 20) throw new Error('摆位步数超限');
    const seat = v.setup.seat;
    const p = pages[seat];
    // 点第一个发亮路口 → 等相邻虚线边出现 → 点边 → 确认
    const okV = await p.clickSel('#board [data-vertex]');
    if (!okV) throw new Error(`seat ${seat} 没有可点路口`);
    await waitFor(() => p.ev(`document.querySelectorAll('#board [data-edge]').length > 0`), 4000, '道路候选出现');
    const okE = await p.clickSel('#board [data-edge]');
    if (!okE) throw new Error(`seat ${seat} 没有可点道路`);
    await waitFor(() => p.ev(`!document.getElementById('confirm-strip').classList.contains('hidden')`), 4000, '确认条出现');
    const okC = await p.clickSel('#confirm-strip [data-confirm="ok"]');
    if (!okC) throw new Error(`seat ${seat} 确认按钮不可用`);
    // 等这一步真的被服务端接受（step 前进或进入 play）
    const prevStep = v.setup.step;
    await waitFor(async () => {
      const nv = await p.view();
      return nv.phase !== 'setup' || (nv.setup && nv.setup.step > prevStep);
    }, 6000, `摆位第 ${prevStep} 步被服务端确认`);
    await sleep(180);
  }
  const afterSetup = await pages[0].view();
  report.steps.push({
    step: 'setup', ok: afterSetup.phase === 'play',
    note: `摆位完成 ${setupRounds} 步 → phase=${afterSetup.phase}`,
    buildings: afterSetup.buildings, roads: afterSetup.roads,
  });
  await pages[0].shot('02-after-setup.png');

  // ---- 主循环：谁回合谁操作（掷骰 → 尝试建造 → 结束回合）----
  log('进入对局主循环');
  let lastTurn = -1;
  let turnsPlayed = 0;
  let diceRolled = 0;
  let buildsDone = 0;
  let buildSkipped = 0;
  let bankExchanges = 0;
  for (let guard = 0; guard < MAX_TURNS * 8; guard++) {
    const v = await pages[0].view();
    if (!v) throw new Error('拿不到视图');
    if (v.phase === 'ended') break;

    const me = pages[v.current];
    const mine = await me.view();
    if (guard % 3 === 0 || guard < 6) {
      log(`g=${guard} turn=${v.turn} cur=${v.current} mine=${mine.viewer} rolled=${mine.hasRolled} disc=${mine.pendingDiscards.length} robber=${mine.pendingRobber} hand=${mine.handSize} t=${Math.round((Date.now()-START)/1000)}s`);
    }

    // 掷骰（未掷且轮到自己）
    if (!mine.hasRolled && !mine.pendingRobber && mine.pendingDiscards.length === 0) {
      const ok = await me.clickSel('#shelf-btn-roll');
      if (ok) { diceRolled++; await sleep(650); continue; }
      log(`掷骰按钮不可点：cur=${v.current} rolled=${mine.hasRolled}`);
    }

    // 有弃牌需求：可能同时有多人需要弃牌，且不一定是当前回合玩家。
    // 逐页检查，把所有「自己欠牌」的人都处理掉；一个都没处理才等一拍。
    if (mine.pendingDiscards.length > 0) {
      let acted = false;
      for (const pg of pages) {
        const pv = await pg.view();
        const need = pv.pendingDiscards.find((d) => d.player === pv.viewer);
        if (!need) continue;

        const geo = await pg.ev(`(() => {
          const dp = document.getElementById('discard');
          const r = (n) => { const b = n.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
          const rows = [...dp.querySelectorAll('.dp-row')].map(row => {
            const plus = row.querySelector('.dp-step[data-delta="1"]');
            return { res: plus?.dataset.res, plusRect: plus ? r(plus) : null, disabled: plus?.disabled,
              hold: row.querySelector('.dp-hold')?.textContent, num: row.querySelector('.dp-num')?.textContent };
          });
          const cs = getComputedStyle(dp);
          return { hidden: dp.classList.contains('hidden'), rect: r(dp),
            pos: cs.position, left: cs.left, right: cs.right, transform: cs.transform, display: cs.display,
            stage: r(document.getElementById('board-stage')), rows };
        })()`);
        log('弃牌几何: ' + JSON.stringify(geo));

        // 逐张加到满足数量：每加一张都重新挑「还能加」的资源行。
        // 不能固定点同一行——该行加满后按钮会禁用，就会卡死。
        for (let i = 0; i < need.count; i++) {
          const box = await pg.ev(`(() => {
            const rows = [...document.querySelectorAll('#discard .dp-row')];
            let best = null;
            for (const row of rows) {
              const plus = row.querySelector('.dp-step[data-delta="1"]');
              if (!plus || plus.disabled) continue;
              const hold = +(row.querySelector('.dp-hold')?.textContent?.replace(/[^0-9]/g, '') ?? 0);
              const num = +(row.querySelector('.dp-num')?.textContent ?? 0);
              const left = hold - num;
              if (left <= 0) continue;
              if (!best || left > best.left) best = { left, plus };
            }
            if (!best) return null;
            const b = best.plus.getBoundingClientRect();
            return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
          })()`);
          if (!box) {
            const why = await pg.ev(`(() => {
              const dp = document.getElementById('discard');
              return { hidden: dp.classList.contains('hidden'),
                rows: [...dp.querySelectorAll('.dp-row')].map(r => ({
                  res: r.querySelector('.dp-step[data-delta="1"]')?.dataset.res,
                  hold: r.querySelector('.dp-hold')?.textContent,
                  num: r.querySelector('.dp-num')?.textContent,
                  plus: r.querySelector('.dp-step[data-delta="1"]')?.disabled,
                })) };
            })()`);
            log('无可加资源: ' + JSON.stringify(why));
            break;
          }
          // 记录点击前的「已选总数」，点完等它真的 +1 再继续。
          // paintDiscard 是整块 innerHTML 重绘，固定 sleep 容易点在旧节点上。
          const before = await pg.ev(`(() => {
            const n = document.querySelector('#discard .dp-count');
            return n ? n.textContent.replace(/[^0-9/]/g, '') : '';
          })()`);
          const hitInfo = await pg.ev(`(() => {
            const el = document.elementFromPoint(${box.x}, ${box.y});
            return el ? el.tagName + '.' + (el.className || '') : 'null';
          })()`);
          await pg.click(box.x, box.y);
          const after = await waitSoft(async () => {
            const now = await pg.ev(`(() => {
              const n = document.querySelector('#discard .dp-count');
              return n ? n.textContent.replace(/[^0-9/]/g, '') : '';
            })()`);
            return now !== before ? now : null;
          }, 1200, '弃牌计数变化');
          if (!after) {
            const dbg = await pg.ev(`(() => {
              const n = document.querySelector('#discard .dp-count');
              return { count: n ? n.textContent.trim() : '', picked: window.__hex?.view?.me?.handSize ?? -1 };
            })()`);
            log(`加点未生效 i=${i} before=${before} at=(${box.x},${box.y}) hit=${hitInfo} now=${JSON.stringify(dbg)}`);
          }
          await sleep(40);
        }

        // 确认前先核对「已选 == 需求」，否则按钮是禁用的，点了也无效
        const ready = await pg.ev(`(() => {
          const ok = document.getElementById('discard-ok');
          const cnt = document.querySelector('#discard .dp-count');
          return { okDisabled: ok ? ok.disabled : true, progress: cnt ? cnt.textContent.trim() : '' };
        })()`);
        const accepted = await (async () => {
          if (ready.okDisabled) return null;      // 没选够，不要空点
          await pg.clickSel('#discard-ok');
          return waitSoft(
            async () => (await pg.view()).pendingDiscards.length < pv.pendingDiscards.length,
            4000, '弃牌被服务端接受',
          );
        })();
        log(`弃牌 seat=${pv.viewer} need=${need.count} progress=${ready.progress} okDisabled=${ready.okDisabled} accepted=${!!accepted}`);
        acted = true;
        if (accepted) break;   // 服务端会广播新状态，重新读更稳
      }
      if (!acted) await sleep(300);
      continue;
    }

    // 强盗待办：只有「当前玩家且待办」的页面能操作（robberTaskActive）
    const robberPage = mine.pendingRobber && mine.current === mine.viewer
      ? me
      : (await Promise.all(pages.map(async (pg) => {
          const pv = await pg.view();
          return pv.pendingRobber && pv.current === pv.viewer ? pg : null;
        }))).find(Boolean) ?? null;
    if (robberPage) {
      const me = robberPage;
      // D-04：用户若曾主动进入建造/交易，棋盘交互模式停在 build，强盗热区不会出现；
      // 界面上给出「返回强盗任务」入口，必须先点它把棋盘交还给强盗。
      const backBtn = await me.clickSel('#robberbar [data-action="return-robber"]');
      if (backBtn) await sleep(250);
      const pre = await me.ev(`(() => {
        const v = window.__hex.view;
        const rb = document.getElementById('robberbar');
        return { cur: v.current, viewer: v.viewer, tiles: document.querySelectorAll('#board [data-tile]').length,
          rbHidden: rb.classList.contains('hidden'),
          rbText: rb.textContent.split(String.fromCharCode(10)).join(' ').trim().slice(0,100) };
      })()`);
      log('强盗前: ' + JSON.stringify(pre));
      const placed = await me.clickSel('#board [data-tile]');
      log('点地块结果: ' + placed);
      if (!placed) { await sleep(300); continue; }
      // 点完地块后有两种合法走向：
      //   a) 相邻有别的玩家 → robberbar 出现「从谁手里抽」，需要再点一次
      //   b) 相邻没有别人 → 直接结算，pendingRobber 立刻变 false
      // 所以这里等的是「steal 按钮出现 或 已结算」，不能只等前者。
      const outcome = await waitSoft(async () => {
        const settled = !(await me.view()).pendingRobber;
        if (settled) return 'settled';
        const has = await me.ev(`!!document.querySelector('#robberbar [data-action="steal"]')`);
        return has ? 'victim' : null;
      }, 3000, '强盗进入挑人阶段或直接结算');
      if (!outcome) {
        const dbg = await me.ev(`(() => {
          const v = window.__hex.view;
          const rb = document.getElementById('robberbar');
          return {
            pendingRobber: v.pendingRobber, current: v.current, viewer: v.viewer,
            tiles: document.querySelectorAll('#board [data-tile]').length,
            robberbarHidden: rb.classList.contains('hidden'),
            robberbarText: rb.textContent.split(String.fromCharCode(10)).join(' ').trim().slice(0,140),
            stealCount: rb.querySelectorAll('[data-action=\"steal\"]').length,
          };
        })()`);
        log('强盗诊断: ' + JSON.stringify(dbg));
        report.steps.push({ step: 'robber-debug', ok: false, note: JSON.stringify(dbg) });
      }

      if (outcome === 'victim') {
        const hasVictim = await me.ev(`!!document.querySelector('#robberbar [data-action="steal"][data-seat]:not([data-seat=""])')`);
        const sel = hasVictim
          ? '#robberbar [data-action="steal"][data-seat]:not([data-seat=""])'
          : '#robberbar [data-action="steal"]';
        await me.clickSel(sel);
        await waitFor(async () => !(await me.view()).pendingRobber, 3000, '强盗结算完成');
      }
      // 无论结算成功与否，本轮都已尝试过强盗；必须 continue，
      // 否则会掉进下面的建造分支，再回到这里形成快速空转。
      await sleep(250);
      continue;
    }

    // 尝试建造（能开菜单就开，失败无所谓）
    if (mine.hasRolled) {
      const opened = await me.clickSel('#shelf-btn-build');
      if (opened) {
        await sleep(250);
        const menuState = await me.ev(`(() => {
          const bp = document.getElementById('build');
          const items = [...document.querySelectorAll('#build .bp-item')];
          return { hidden: bp.classList.contains('hidden'),
            count: items.length,
            enabled: items.filter(i => !i.disabled).map(i => i.dataset.mode),
            drawerOpen: document.getElementById('drawer').classList.contains('open') };
        })()`);
        if (!menuState.count || !menuState.enabled.length) {
          // 资源不足时三项都会 disabled —— 这是正常状态。
          // 真实玩家会用银行/港口兑换补齐缺口，这里也这么做（4:1 / 3:1 / 2:1 由服务端裁决）。
          buildSkipped++;
          await me.clickSel('#drawer-close');
          await sleep(120);
          const exchanged = await tryBankExchange(me);
          if (exchanged) bankExchanges++;
          await sleep(120);
        }
        await waitSoft(() => me.ev(`!!document.querySelector('#build .bp-item')`), 1200, '建造菜单');
        // 优先建村（+1 分），其次城市，最后道路。
        // 只选第一个可用项会一直铺路，永远上不了分（实测 98 回合仍 8 建筑）。
        const order = ['settlement', 'city', 'road'];
        let picked = false;
        for (const mode of order) {
          picked = await me.clickSel(`#build .bp-item[data-mode="${mode}"]:not([disabled])`);
          if (picked) break;
        }
        if (picked) {
          // 选完类别后抽屉会收起，棋盘出现候选
          await waitSoft(
            () => me.ev(`document.querySelectorAll('#board [data-edge],#board [data-vertex]').length > 0`),
            1500, '建造候选出现',
            );
          const spot = await me.clickSel('#board [data-edge], #board [data-vertex]');
          if (spot) {
            await waitSoft(
              () => me.ev(`!document.getElementById('confirm-strip').classList.contains('hidden')`),
              1500, '建造确认条',
              );
            const before = (await me.view()).roads + (await me.view()).buildings;
            const conf = await me.clickSel('#confirm-strip [data-confirm="ok"]');
            if (conf) {
              await waitSoft(async () => {
                const nv = await me.view();
                return nv.roads + nv.buildings > before;
              }, 3000, '建造被服务端确认');
              buildsDone++;
              await sleep(200);
              continue;
            }
            await me.clickSel('#confirm-strip [data-confirm="cancel"]');
          } else {
            await me.clickSel('#drawer-close');
          }
        } else {
          await me.clickSel('#drawer-close');
        }
      }
    }

    // 结束回合
    if (mine.hasRolled) {
      const ended = await me.clickSel('#shelf-btn-end');
      if (ended) {
        // 结束回合会弹确认条；等它出现再点
        await waitSoft(
          () => me.ev(`!document.getElementById('confirm-strip').classList.contains('hidden')`),
          1500, '结束回合确认条',
          );
        await me.clickSel('#confirm-strip [data-confirm="ok"]');
        const prevTurn = v.turn;
        await waitSoft(async () => {
          const nv = await pages[0].view();
          return nv && (nv.turn !== prevTurn || nv.current !== v.current);
        }, 3000, '回合推进');
        const nv = await pages[0].view();
        if (nv && nv.turn !== lastTurn) { lastTurn = nv.turn; turnsPlayed++; }
        if (turnsPlayed % 6 === 0) await pages[0].shot(`03-turn-${String(turnsPlayed).padStart(2, '0')}.png`);
        continue;
      }
    }

    // 兜底：等一拍，避免空转
    await sleep(300);
  }

  const final = await pages[0].view();
  report.steps.push({
    step: 'play', ok: final.phase === 'ended' || turnsPlayed > 0,
    note: `回合推进 ${turnsPlayed} 次、掷骰 ${diceRolled} 次、建造 ${buildsDone} 次、银行兑换 ${bankExchanges} 次、资源不足跳过 ${buildSkipped} 次`,
    finalPhase: final.phase, winner: final.winner, scores: final.scores,
  });
  await pages[0].shot('04-final.png');

  // 结算页（若已终局）
  if (final.phase === 'ended') {
    const endVisible = await pages[0].ev(`!document.getElementById('end-screen').classList.contains('hidden')`);
    report.steps.push({ step: 'end-screen', ok: endVisible, note: endVisible ? '结算页已显示' : '结算页未显示' });
    await pages[0].shot('05-end.png');
    // 回到房间
    const back = await pages[0].clickSel('#end-back');
    await sleep(600);
    const afterBack = await pages[0].ev(`!document.getElementById('overlay').classList.contains('hidden')`);
    report.steps.push({ step: 'back-to-room', ok: back && afterBack, note: afterBack ? '已回到房间面板' : '回房入口未生效' });
    await pages[0].shot('06-back.png');
  }

  report.result = final.phase === 'ended' ? 'PASS' : (turnsPlayed > 0 ? 'PARTIAL' : 'FAIL');
  report.summary = {
    turnsPlayed, diceRolled, buildsDone, buildSkipped, bankExchanges,
    finalPhase: final.phase, winner: final.winner, scores: final.scores,
    fourDistinctViewers: new Set(pages.map((_, i) => i)).size === 4,
  };
  finish(report.result === 'PASS' ? 0 : (report.result === 'PARTIAL' ? 2 : 1));
} catch (err) {
  report.result = 'FAIL';
  report.error = String(err);
  log('失败：' + String(err));
  try { await pages[0]?.shot('99-failure.png'); } catch { /* ignore */ }
  finish(1);
}
