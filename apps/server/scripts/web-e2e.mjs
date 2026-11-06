/**
 * 端到端验收：真浏览器 + 真 WebSocket + 真服务端。
 *
 * 做三件事：
 * 1. 打开页面，等 window.__hex.view 出现（说明 STATE 真的到了）
 * 2. 断言棋盘/建筑/手牌都按视图渲染出来了
 * 3. 点「掷骰子」，等 dice 回填，再截一张图
 *
 * 用法（apps/server 下，服务端已带一局 e2e 房间时）：
 *   node scripts/web-e2e.mjs http://127.0.0.1:4173/?name=甲&room=e2e /tmp/shot.png
 */

import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import WebSocket from 'ws';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/?name=%E7%94%B2&room=e2e';
const shotPath = process.argv[3] ?? '/tmp/hex-web.png';
const width = Number(process.env.E2E_WIDTH ?? 1440);
const height = Number(process.env.E2E_HEIGHT ?? 900);
/** 只截图、不点掷骰：用于移动端窄屏走查 */
const shotOnly = process.env.E2E_SHOT_ONLY === '1';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const profile = '/tmp/hex-e2e-profile';

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
    await sleep(200);
  }
}

async function getTarget() {
  return waitFor(
    async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        const list = await res.json();
        const page = list.find((t) => t.type === 'page');
        return page?.webSocketDebuggerUrl ?? null;
      } catch {
        return null;
      }
    },
    15000,
    'Chrome 调试端口',
  );
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
        this.errors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description ?? ''));
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
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
    return res.result.value;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(`断言失败：${message}`);
}

async function main() {
  const targetUrl = await getTarget();
  const ws = new WebSocket(targetUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const cdp = new Cdp(ws);

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 700,
  });

  await cdp.send('Page.navigate', { url });
  await waitFor(() => cdp.eval('document.readyState === "complete"').catch(() => false), 15000, '页面加载');

  const hasView = await waitFor(
    () => cdp.eval('!!(window.__hex && window.__hex.view && window.__hex.view.tiles)').catch(() => false),
    15000,
    '收到 STATE 视图',
  ).catch(async (err) => {
    const diag = await cdp
      .eval(`(() => ({
        hasHex: !!window.__hex,
        conn: window.__hex && window.__hex.client && window.__hex.client.state,
        wsUrl: window.__hex && window.__hex.wsUrl,
        origin: location.href,
        overlayText: document.getElementById('sheet') && document.getElementById('sheet').textContent.slice(0, 120),
        feed: document.getElementById('feed-text').textContent,
      }))()`)
      .catch((e) => ({ evalError: String(e) }));
    throw new Error(`${err.message} · 诊断 ${JSON.stringify(diag)} · 控制台 ${JSON.stringify(cdp.errors.slice(0, 5))}`);
  });
  assert(hasView, '没有拿到视图，说明 WS 没连上或没收到 STATE');

  const info = await cdp.eval(`(() => {
    const h = window.__hex;
    const v = h.view;
    return {
      seat: h.seat,
      roomId: h.roomId,
      conn: h.client && h.client.state,
      wsUrl: h.wsUrl,
      phase: v.phase,
      current: v.current,
      viewer: v.viewer,
      turn: v.turn,
      tiles: v.tiles.length,
      ports: v.ports.length,
      buildings: Object.keys(v.buildings).length,
      roads: Object.keys(v.roads).length,
      players: v.players.map(p => ({ name: p.name, hand: p.handSize, score: p.score, hasResources: 'resources' in p })),
      myResources: v.me.resources,
      dom: {
        tileNodes: document.querySelectorAll('#board .tile').length,
        buildingNodes: document.querySelectorAll('#board [data-layer="buildings"] > g').length,
        roadNodes: document.querySelectorAll('#board [data-layer="roads"] > g').length,
        numberChips: document.querySelectorAll('#board text').length,
        handCards: document.querySelectorAll('#hand .card').length,
        playerRows: document.querySelectorAll('#players .player').length,
        overlayHidden: document.getElementById('overlay').classList.contains('hidden'),
      },
      rollEnabled: !document.getElementById('btn-roll').disabled,
    };
  })()`);

  assert(info.dom.tileNodes === info.tiles, `棋盘地块数 ${info.dom.tileNodes} ≠ 视图 ${info.tiles}`);
  assert(info.dom.buildingNodes === info.buildings, `建筑数 ${info.dom.buildingNodes} ≠ 视图 ${info.buildings}`);
  assert(info.dom.roadNodes === info.roads, `道路数 ${info.dom.roadNodes} ≠ 视图 ${info.roads}`);
  assert(info.dom.handCards === 5, '手牌应有 5 张');
  assert(info.dom.playerRows === info.players.length, '玩家栏行数应与人头一致');
  assert(info.dom.overlayHidden, '入座成功后浮层应当收起');
  assert(info.players.every((p) => p.hasResources === false), '别人的手牌内容不得出现在视图里');
  if (shotOnly) {
    const shot0 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shotPath, Buffer.from(shot0.data, 'base64'));
    const metrics = await cdp.eval(`(() => {
      const r = (sel) => { const n = document.querySelector(sel); if (!n) return null; const b = n.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; };
      return { innerH: innerHeight, innerW: innerWidth, app: r('.app'), footer: r('.bottombar'), opbar: r('.opbar'), handrow: r('.handrow'), card: r('.card'), scrollH: document.documentElement.scrollHeight };
    })()`);
    return { ok: true, url, screenshot: shotPath, viewport: [width, height], dom: info.dom, metrics, consoleErrors: cdp.errors };
  }

  assert(info.rollEnabled, '轮到本家且未掷骰时，掷骰按钮应可用');

  const before = await cdp.eval('JSON.stringify(window.__hex.view.dice)');
  await cdp.eval(`document.getElementById('btn-roll').click()`);
  const after = await waitFor(() => cdp.eval('JSON.stringify(window.__hex.view.dice)').then((v) => (v !== 'null' ? v : null)), 12000, '掷骰结果');

  // 骰子有点数滚动动画（约 0.7s），等它落定再断言
  await waitFor(
    () =>
      cdp
        .eval(
          `(() => { const v = window.__hex.view; if (!v.dice) return false;
             return document.getElementById('die1').textContent === String(v.dice[0])
                 && document.getElementById('die2').textContent === String(v.dice[1]); })()`,
        )
        .catch(() => false),
    6000,
    '骰子动画落定',
  );

  const postRoll = await cdp.eval(`(() => {
    const v = window.__hex.view;
    return {
      dice: v.dice,
      hasRolled: v.hasRolled,
      hand: v.me.handSize,
      diceText: [document.getElementById('die1').textContent, document.getElementById('die2').textContent],
      feed: document.getElementById('feed-text').textContent,
      log: [...document.querySelectorAll('#log .logitem')].slice(0, 3).map(n => n.textContent),
      rollEnabled: !document.getElementById('btn-roll').disabled,
      endEnabled: !document.getElementById('btn-end').disabled,
    };
  })()`);

  assert(postRoll.dice !== null, '掷骰后应当有骰子点数');
  assert(postRoll.diceText[0] === String(postRoll.dice[0]) && postRoll.diceText[1] === String(postRoll.dice[1]), '骰子显示应与视图一致');
  assert(postRoll.rollEnabled === false, '掷过之后掷骰按钮应禁用（本回合已掷）');
  assert(postRoll.endEnabled === true, '掷过之后结束回合应可用');

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

  return {
    ok: true,
    url,
    screenshot: shotPath,
    view: {
      seat: info.seat,
      room: info.roomId,
      phase: info.phase,
      tiles: info.tiles,
      ports: info.ports,
      buildings: info.buildings,
      roads: info.roads,
      players: info.players,
    },
    dom: info.dom,
    roll: { before, dice: postRoll.dice, diceText: postRoll.diceText, feed: postRoll.feed, log: postRoll.log },
    consoleErrors: cdp.errors,
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
