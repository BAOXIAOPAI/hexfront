/**
 * T3 摆位交互验收：两个真浏览器标签页 + 真 WebSocket + 真服务端。
 *
 * 局面由 `npx tsx scripts/seed-room.ts <room> 2 --setup` 造好（停在摆位第 0 步）。
 * 两个标签页分别以「甲」「乙」入座，甲就是 0 号位。
 *
 * 断言链路：
 *   1. 两边都看到摆位条 0/4，甲看到可点路口，乙没有热区
 *   2. 甲点路口 → 出线（虚线的边），再点边 → 服务端结算
 *   3. 两个标签页同步看到 step 1、建筑 +1，且轮到乙
 *   4. 交替摆完 4 次 → phase 变成 play，摆位条收起，轮到甲掷骰
 *
 * 用法（apps/server 下）：
 *   node scripts/web-setup-e2e.mjs "http://127.0.0.1:4173/?room=e2e" /tmp/shot.png
 */

import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const base = process.argv[2] ?? 'http://127.0.0.1:4173/?room=e2e';
const shotPath = process.argv[3] ?? '/tmp/hex-setup.png';
const width = 1440;
const height = 900;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9334;
const profile = '/tmp/hex-setup-profile';

rmSync(profile, { recursive: true, force: true });

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`超时：${label}`);
    await sleep(150);
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails.text);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
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
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
    return res.result.value;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(`断言失败：${message}`);
}

/** 新开一个标签页并接上调试会话 */
async function openPage(url) {
  const target = await waitFor(
    async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
        if (!res.ok) return null;
        const json = await res.json();
        return json.webSocketDebuggerUrl ?? null;
      } catch {
        return null;
      }
    },
    15000,
    'Chrome 调试端口',
  );

  const ws = new WebSocket(target, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  return cdp;
}

const snapshot = `(() => {
  const h = window.__hex;
  const v = h && h.view;
  const bar = document.getElementById('setupbar');
  return {
    ready: !!v,
    seat: h && h.seat,
    phase: v && v.phase,
    step: v && v.setup ? v.setup.step : null,
    setupSeat: v && v.setup ? v.setup.seat : null,
    current: v && v.current,
    buildings: v ? Object.keys(v.buildings).length : 0,
    roads: v ? Object.keys(v.roads).length : 0,
    hits: document.querySelectorAll('#board [data-vertex]').length,
    hitEdges: document.querySelectorAll('#board [data-edge]').length,
    barHidden: !bar || bar.classList.contains('hidden'),
    barText: bar ? bar.textContent.replace(/\\s+/g, ' ').trim() : '',
    barMine: !!document.querySelector('#setupbar .sb-hint.mine'),
    dots: document.querySelectorAll('#setupbar .sb-dots i').length,
    dotsDone: document.querySelectorAll('#setupbar .sb-dots i.done').length,
    feed: document.getElementById('feed-text').textContent,
    log: [...document.querySelectorAll('#log .logitem')].slice(0, 2).map((n) => n.textContent),
    rollEnabled: !document.getElementById('btn-roll').disabled,
  };
})()`;

async function waitReady(cdp) {
  await waitFor(() => cdp.eval('document.readyState === "complete"').catch(() => false), 20000, '页面加载');
  await waitFor(() => cdp.eval('!!(window.__hex && window.__hex.view)').catch(() => false), 20000, '收到视图');
  return cdp.eval(snapshot);
}

async function waitStep(cdp, step, label) {
  return waitFor(
    () =>
      cdp
        .eval(snapshot)
        .then((s) => (s.step === step ? s : null))
        .catch(() => null),
    15000,
    label,
  );
}

/** 点第一个热区路口，再点第一条虚线边 */
async function clickVertexThenEdge(cdp) {
  const picked = await cdp.eval(`(() => {
    const el = document.querySelector('#board [data-vertex]');
    if (!el) return null;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return el.getAttribute('data-vertex');
  })()`);
  assert(picked, '本回合应至少有一个可点路口');

  const edge = await cdp.eval(`(() => {
    const el = document.querySelector('#board [data-edge]');
    if (!el) return null;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return el.getAttribute('data-edge');
  })()`);
  assert(edge, '选好村庄后应出现可点的边');
  return { vertex: picked, edge };
}

async function main() {
  const a = await openPage(`${base}&name=${encodeURIComponent('甲')}`);
  const b = await openPage(`${base}&name=${encodeURIComponent('乙')}`);

  const sa = await waitReady(a);
  const sb = await waitReady(b);

  assert(sa.seat === 0 && sb.seat === 1, `座位应为 0/1，实际 ${sa.seat}/${sb.seat}`);
  assert(sa.phase === 'setup' && sb.phase === 'setup', '此时应处于摆位阶段');
  assert(sa.step === 0 && sb.step === 0, '摆位进度应同为 0');
  assert(!sa.barHidden && !sb.barHidden, '摆位条应显示');
  assert(sa.dots === 4 && sb.dots === 4, '两人局摆位点数应为 4');
  assert(sa.barText.includes('0 / 4'), `摆位条应显示 0 / 4，实际「${sa.barText}」`);
  assert(sa.barMine === true, '甲的摆位提示应为「轮到我」');
  assert(sb.barMine === false, '乙此时不该看到自己摆位的提示');
  assert(sa.hits > 0, '该甲摆位时应有可点路口');
  assert(sb.hits === 0, '乙不该看到任何热区（避免点半天全是拒绝）');
  assert(sa.rollEnabled === false && sb.rollEnabled === false, '摆位阶段掷骰按钮应禁用');

  // 只截图：用来肉眼检查热区/摆位条的观感，不往下点
  // E2E_SHOT_ONLY=2 会先点下一个路口，好检查「已选村庄 + 虚线边」的样子
  if (process.env.E2E_SHOT_ONLY) {
    let picked = null;
    if (process.env.E2E_SHOT_ONLY === '2') {
      picked = await a.eval(`(() => {
        const el = document.querySelector('#board [data-vertex]');
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return el.getAttribute('data-vertex');
      })()`);
      await sleep(260);
    }
    const shot0 = await a.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shotPath, Buffer.from(shot0.data, 'base64'));
    const metrics = await a.eval(`(() => {
      const box = (sel) => { const n = document.querySelector(sel); if (!n) return null; const b = n.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
      return {
        bar: box('#setupbar'),
        dots: [...document.querySelectorAll('#setupbar .sb-dots i')].map((n) => {
          const b = n.getBoundingClientRect();
          return { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height), bg: getComputedStyle(n).backgroundColor, op: getComputedStyle(n).opacity };
        }),
        table: box('.table'),
        hitEdges: document.querySelectorAll('#board [data-edge]').length,
        pickedRings: document.querySelectorAll('#board .hit-vertex.picked').length,
      };
    })()`);
    const state = await a.eval(snapshot);
    return { ok: true, mode: 'shot-only', picked, screenshot: shotPath, setup: state, other: sb, metrics, consoleErrors: [...a.errors, ...b.errors] };
  }

  const first = await clickVertexThenEdge(a);
  const afterFirstA = await waitStep(a, 1, '甲摆位后 step=1');
  const afterFirstB = await waitStep(b, 1, '乙同步看到 step=1');

  assert(afterFirstA.buildings === 1 && afterFirstB.buildings === 1, '两个标签页都应看到 1 座村庄');
  assert(afterFirstA.roads === 1 && afterFirstB.roads === 1, '两个标签页都应看到 1 条路');
  assert(afterFirstA.setupSeat === 1 && afterFirstB.setupSeat === 1, '下一步应轮到乙');
  assert(afterFirstA.dotsDone === 1 && afterFirstB.dotsDone === 1, '进度条应点亮 1 格');
  assert(afterFirstB.barMine === true && afterFirstA.barMine === false, '「轮到我」的提示应换到乙');

  // 乙摆第二手，进入第 2 轮
  await clickVertexThenEdge(b);
  const round2A = await waitStep(a, 2, '乙摆位后 step=2');
  const round2B = await waitStep(b, 2, '乙自己也看到 step=2');
  assert(round2A.buildings === 2 && round2B.buildings === 2, '应共有 2 座村庄');
  assert(round2A.barText.includes('第 2 轮'), `第 3 手应进入第 2 轮，实际「${round2A.barText}」`);
  assert(round2A.setupSeat === 1, '第 2 轮从最后一个人开始（乙）');

  // 第 2 轮：乙 → 甲，摆完就进 play
  await clickVertexThenEdge(b);
  const thirdA = await waitStep(a, 3, '乙第二手后 step=3');
  assert(thirdA.setupSeat === 0, '最后一步应轮到甲');

  const lastPlace = await clickVertexThenEdge(a);
  const play = await waitFor(
    () =>
      a
        .eval(snapshot)
        .then((s) => (s.phase === 'play' ? s : null))
        .catch(() => null),
    15000,
    '摆位结束进入 play',
  );
  const playB = await waitFor(
    () =>
      b
        .eval(snapshot)
        .then((s) => (s.phase === 'play' ? s : null))
        .catch(() => null),
    15000,
    '乙也进入 play',
  );

  assert(play.buildings === 4 && play.roads === 4, `摆完应有 4 村 4 路，实际 ${play.buildings}/${play.roads}`);
  assert(playB.buildings === 4, '乙应看到同样的 4 座村庄');
  assert(play.barHidden === true && playB.barHidden === true, '进入正式回合后摆位条应收起');
  assert(play.hits === 0 && play.hitEdges === 0, '进入正式回合后不该留热区');
  assert(play.current === 0, '首回合应由 0 号位开始');
  assert(play.rollEnabled === true, '轮到甲时掷骰按钮应可用');
  assert(playB.rollEnabled === false, '不是乙的回合，乙的掷骰按钮应禁用');
  assert(play.log.length > 0, '最近动作里应有摆位记录');

  const shot = await a.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

  return {
    ok: true,
    base,
    screenshot: shotPath,
    firstPlace: first,
    lastPlace,
    first: { step: afterFirstA.step, buildings: afterFirstA.buildings, setupSeat: afterFirstA.setupSeat, dotsDone: afterFirstA.dotsDone },
    round2: { step: round2A.step, barText: round2A.barText, setupSeat: round2A.setupSeat },
    play: { phase: play.phase, current: play.current, buildings: play.buildings, roads: play.roads, rollEnabled: play.rollEnabled, feed: play.feed, log: play.log },
    consoleErrors: [...a.errors, ...b.errors],
  };
}

main()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    chrome.kill();
    process.exit(0);
  })
  .catch((err) => {
    console.error(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }, null, 2));
    chrome.kill();
    process.exit(1);
  });
