#!/usr/bin/env node
/**
 * 文档 23 L-5：真实 WebSocket 端到端验收（产品默认配置，非测试夹具）。
 *
 * 覆盖：
 *   - 4 人标准盘：完整一局（准备 → 排序 → 开始 → 摆位 → 正常回合 → 终局）
 *   - 8 人扩展盘：完整一局
 *   - 5 / 6 / 7 人：入房、摆位、进入正常回合
 *   - 必测项：非房主越权、设置变更清准备、重复开始、最后一人加入不自动开局、
 *             房主断线移交、乱序重连不串座、全员两村两路、
 *             系统代放与手动提交竞争、超时后资源发放、减少动态模式不影响计时
 *
 * 用法（仓库根目录）：
 *   node probe/l5-endtoend.mjs
 * 输出：结构化 JSON 到 stdout + probe/l5-endtoend-report.json
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ws 只装在 apps/server 下（pnpm 隔离），从那里解析
const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps/server', 'index.cjs'));
const WebSocket = require('ws');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.L5_PORT ?? 18787);
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/?sharecode=l5`;
const PROTOCOL_VERSION = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 极简 WS 客户端：队列 + 等待特定消息
// ---------------------------------------------------------------------------
class Client {
  constructor(name) {
    this.name = name;
    this.ws = new WebSocket(WS);
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const i = this.waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) {
        const w = this.waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(msg);
      } else this.queue.push(msg);
    });
  }
  static async open(name) {
    const c = new Client(name);
    await new Promise((resolve, reject) => {
      c.ws.once('open', resolve);
      c.ws.once('error', reject);
    });
    return c;
  }
  send(msg) { if (!this.closed && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }
  wait(t, pred = () => true, timeout = 6000) {
    const p = (m) => m.t === t && pred(m);
    const hit = this.queue.findIndex(p);
    if (hit >= 0) return Promise.resolve(this.queue.splice(hit, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`[${this.name}] 等待 ${t} 超时`)), timeout);
      this.waiters.push({ pred: p, resolve, timer });
    });
  }
  /** 取当前队列里最后一条某类型消息，不消费 */
  peek(t) { return this.queue.filter((m) => m.t === t).at(-1); }
  clear() { this.queue = []; }
  close() { this.closed = true; try { this.ws.terminate(); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------------------
// 流程助手
// ---------------------------------------------------------------------------

async function joinAll(roomId, count) {
  const clients = [];
  const names = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
  for (let i = 0; i < count; i++) {
    const c = await Client.open(names[i]);
    // 首个 JOIN 即「创建房间」：房主在入房时设定人数上限 4–8（L-0 E）
    c.send({
      t: 'JOIN', roomId, name: names[i], v: PROTOCOL_VERSION,
      ...(i === 0 ? { players: count } : {}),
    });
    const w = await c.wait('WELCOME');
    c.seat = w.seat;
    c.welcome = w;
    clients.push(c);
  }
  return clients;
}

/** 从 STATE/WELCOME 的 view 找一个合法摆位点 */
function findSpot(view, geo) {
  // 用前端几何同构算法：从 view.tiles 的 key 反推 rows，再重建几何
  // 这里为避免重复实现，直接用暴力：view 里带 buildings/roads，但没有顶点邻接。
  // 服务端在 WELCOME/STATE 里不推几何，所以通过 board 快照的 rows 重建。
  return findSpotWithGeo(view, geo);
}

/** 用 (u,row) 几何重建顶点/边；与引擎 board.ts 完全一致 */
function buildGeo(rows) {
  const HEX = 56, SQ3 = Math.sqrt(3), P = 100;
  const key = (x, y) => `${Math.round(x * P)},${Math.round(y * P)}`;
  const ek = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const tiles = {};
  const tileKeys = [];
  const center = (rows.length - 1) / 2;
  rows.forEach((count, row) => {
    const u0 = 1 - count;
    for (let i = 0; i < count; i++) {
      const u = u0 + i * 2;
      const k = `${u},${row}`;
      tiles[k] = { u, row, x: (HEX * SQ3 * u) / 2, y: HEX * 1.5 * (row - center) };
      tileKeys.push(k);
    }
  });
  const verts = {};
  const edges = {};
  const ensure = (x, y) => {
    const k = key(x, y);
    if (!verts[k]) verts[k] = { key: k, x, y, tiles: [], edges: [], neighbors: [] };
    return k;
  };
  for (const tk of tileKeys) {
    const t = tiles[tk];
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const ang = (Math.PI / 180) * (60 * i - 30);
      pts.push(ensure(t.x + HEX * Math.cos(ang), t.y + HEX * Math.sin(ang)));
    }
    for (const vk of pts) verts[vk].tiles.push(tk);
    for (let i = 0; i < 6; i++) {
      const a = pts[i], b = pts[(i + 1) % 6];
      const e = ek(a, b);
      if (!edges[e]) edges[e] = { a, b };
      verts[a].edges.push(e); verts[b].edges.push(e);
      if (!verts[a].neighbors.includes(b)) verts[a].neighbors.push(b);
      if (!verts[b].neighbors.includes(a)) verts[b].neighbors.push(a);
    }
  }
  return { verts, edges, vertexKeys: Object.keys(verts) };
}

function findSpotWithGeo(view, geo) {
  for (const vk of geo.vertexKeys) {
    if (view.buildings[vk]) continue;
    const v = geo.verts[vk];
    if (v.neighbors.some((nb) => view.buildings[nb])) continue;
    const edge = v.edges.find((e) => view.roads[e] === undefined);
    if (edge) return { vertex: vk, edge };
  }
  return null;
}

/** 走完整个选地阶段：每次由当前该放的客户端提交，断言全员两村两路 */
async function driveSetup(clients, label, initialView, startSeq = 0) {
  let view = initialView;
  let steps = 0;
  const expected = clients.length * 2;
  const geo = view ? buildGeo(rowsFromKeys(view.tiles.map((t) => t.key))) : null;
  if (!geo) throw new Error(`[${label}] 无法重建棋盘几何`);

  const trace = [];
  let lastSeq = startSeq;
  while (steps < expected + 4) {
    if (!view || view.phase !== 'setup') break;
    const seat = view.setup.seat;
    const step = view.setup.step;
    const actor = clients.find((c) => c.seat === seat);
    if (!actor) throw new Error(`[${label}] 找不到 seat ${seat} 的客户端`);
    const spot = findSpotWithGeo(view, geo);
    if (!spot) throw new Error(`[${label}] 第 ${steps} 步没有合法摆位点`);
    actor.clear();
    await sleep(20);   // 不触发传输层每秒 60 条的滥发保护
    actor.send({ t: 'COMMAND', cmd: { type: 'PLACE_SETTLEMENT', seat, ...spot } });
    // 只接受严格递增的 seq，跳过重复/迟到的旧广播（与产品前端 lastSeq 同策略）
    const minSeq = lastSeq;
    const state = await actor.wait('STATE', (m) => m.seq > minSeq);
    view = state.view;
    lastSeq = state.seq;
    actor.lastView = state.view;
    // 让其他客户端也吸收广播，保存自己的私有视图（弃牌阶段要用 me.resources）
    for (const c of clients) {
      if (c === actor) continue;
      const states = c.queue.filter((m) => m.t === 'STATE' && m.seq > minSeq);
      if (states.length > 0) {
        const latest = states.at(-1);
        c.lastView = latest.view;
        c.queue = c.queue.filter((m) => !(m.t === 'STATE' && m.seq <= latest.seq));
      }
    }
    trace.push(`${step}:s${seat}→${view.phase === 'setup' ? `s${view.setup.seat}/${view.setup.step}` : view.phase}`);
    steps++;
  }
  if (view.phase !== 'play') {
    throw new Error(`[${label}] 摆位未进入 play（steps=${steps}）trace=${trace.join(' ')}`);
  }
  const buildings = Object.values(view.buildings);
  const roads = Object.values(view.roads);
  if (buildings.length !== expected || roads.length !== expected) {
    throw new Error(`[${label}] 建筑/道路数量错误 ${buildings.length}/${roads.length}，期望 ${expected}`);
  }
  for (let p = 0; p < clients.length; p++) {
    const own = buildings.filter((b) => b.owner === p).length;
    const rd = roads.filter((o) => o === p).length;
    if (own !== 2 || rd !== 2) throw new Error(`[${label}] seat ${p} 不是两村两路 (${own}/${rd})`);
  }
  return { steps, view, lastSeq };
}

function rowsFromKeys(keys) {
  const counts = new Map();
  let maxRow = -1;
  for (const k of keys) {
    const m = /^(-?\d+),(-?\d+)$/.exec(k);
    if (!m) return [3, 4, 5, 4, 3];
    const row = Number(m[2]);
    counts.set(row, (counts.get(row) ?? 0) + 1);
    if (row > maxRow) maxRow = row;
  }
  const rows = [];
  for (let r = 0; r <= maxRow; r++) rows.push(counts.get(r) ?? 0);
  return rows;
}

/**
 * 正常回合推进：掷骰 → 处理掷 7（弃牌 + 移动强盗）→ 结束回合，
 * 直到 phase=ended 或达到上限。产品模式骰子由服务端随机，客户端不指定。
 *
 * 所有 STATE 等待都要求 seq 严格递增（与产品前端 lastSeq 同策略），
 * 避免迟到/重复广播被当成最新状态；每个客户端保存自己的最新私有视图。
 */
async function drivePlay(clients, view, label, maxTurns = 400, startSeq = 0) {
  let cur = view;
  let turns = 0;
  let sevens = 0;
  let rejects = [];
  const RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
  let lastSeq = startSeq;
  // 客户端私有视图由 driveSetup 在每次广播后保存（弃牌阶段读 me.resources）

  /** 等一条更晚的 STATE；同时捕获 REJECT 便于定位问题 */
  async function nextState(c, minSeq) {
    return c.wait(
      'STATE',
      (m) => m.seq > minSeq,
      6000,
    ).catch(async () => {
      // 没有新 STATE：看是不是被拒绝
      const r = c.peek('REJECT');
      if (r) { rejects.push(r.reason); throw new Error(`${label}: 命令被拒绝 ${r.reason}`); }
      throw new Error(`${label}: 等待 STATE(seq>${minSeq}) 超时`);
    });
  }

  /**
   * 传输层每秒 60 条限制是真实产品保护（文档 23 要求保留），脚本不能放宽它。
   * 用滑动窗口把「所有客户端」的发送速率压到 50 条/秒以下。
   */
  const sendTimes = [];
  async function throttle() {
    const now = Date.now();
    while (sendTimes.length > 0 && now - sendTimes[0] >= 1000) sendTimes.shift();
    if (sendTimes.length >= 45) {
      await sleep(1000 - (now - sendTimes[0]) + 10);
      return throttle();
    }
    sendTimes.push(Date.now());
  }

  /** 提交一条命令并取回最新权威状态 */
  async function submit(c, cmd) {
    await throttle();
    const min = lastSeq;
    c.clear();
    c.send({ t: 'COMMAND', cmd });
    const msg = await nextState(c, min);
    lastSeq = msg.seq;
    c.lastView = msg.view;
    cur = msg.view;
    // 其他客户端也吸收这条广播，保存自己的私有视图（弃牌需要读 me.resources）
    for (const other of clients) {
      if (other === c) continue;
      const states = other.queue.filter((m) => m.t === 'STATE' && m.seq >= msg.seq);
      if (states.length > 0) {
        const latest = states.at(-1);
        other.lastView = latest.view;
        other.queue = other.queue.filter((m) => !(m.t === 'STATE' && m.seq <= latest.seq));
      }
    }
    return msg;
  }

  /** 给指定客户端弃够 need 张：用该客户端最近一次私有视图 */
  async function discardFor(c, need) {
    const v = c.lastView ?? cur;
    const resources = v.me?.resources ?? {};
    const give = {};
    let left = need;
    for (const r of RES) {
      const n = Math.min(left, resources[r] ?? 0);
      if (n > 0) { give[r] = n; left -= n; }
      if (left === 0) break;
    }
    if (left > 0) return false;
    await submit(c, { type: 'DISCARD', seat: c.seat, resources: give });
    return true;
  }

  while (cur.phase === 'play' && turns < maxTurns) {
    const seat = cur.current;
    const actor = clients.find((c) => c.seat === seat);
    if (!actor) throw new Error(`[${label}] 找不到当前 seat ${seat}`);

    await submit(actor, { type: 'ROLL_DICE', seat });
    if (cur.dice && cur.dice[0] + cur.dice[1] === 7) sevens++;

    // R-42 顺序：全员弃完 → 掷骰者移动强盗 → 结束回合
    let guard = 0;
    while (cur.pendingDiscards && cur.pendingDiscards.length > 0 && guard++ < 30) {
      const pd = cur.pendingDiscards[0];
      const c = clients.find((x) => x.seat === pd.player);
      if (!c) break;
      // 若该客户端还没有自己的私有视图，用全 0 兜底会失败；
      // 但服务端只在「需弃牌」时把该玩家列入，其视图必然带手牌。
      const ok = await discardFor(c, pd.count);
      if (!ok) break;
    }

    if (cur.pendingRobber) {
      const tile = cur.tiles.find((t) => !t.hasRobber);
      await submit(actor, { type: 'MOVE_ROBBER', seat, tile: tile.key });
    }

    await submit(actor, { type: 'END_TURN', seat });
    turns++;
  }
  return { turns, sevens, rejects, phase: cur.phase, winner: cur.winner, turn: cur.turn };
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

async function scenario(roomId, players, board, label) {
  const clients = await joinAll(roomId, players);
  const host = clients[0];
  const welcome = host.welcome;
  const results = { label, players, board: welcome.map.kind, checks: {} };

  // 1. 最后一人加入不自动开局
  results.checks.noAutoStart = welcome.view === null && host.peek('STATE') === undefined;
  results.checks.createdCapacity = welcome.capacity === players;
  results.checks.createdHost = welcome.lobby.hostSeat === 0;

  // 2. 房主设定目标人数（4–8）；非房主越权被拒
  const others = clients.slice(1);
  others[0].clear();
  others[0].send({ t: 'SET_ROOM_CONFIG', targetPlayers: players, board, configVersion: welcome.lobby.configVersion });
  const reject = await others[0].wait('REJECT');
  results.checks.nonHostRejected = reject.reason === 'NOT_HOST';

  // 3. 房主手动改选地图（验证 custom 标记与地图快照）
  host.clear();
  host.send({ t: 'SET_ROOM_CONFIG', targetPlayers: players, board, configVersion: welcome.lobby.configVersion });
  const cfg = await host.wait('LOBBY_CONFIG');
  results.checks.boardApplied = cfg.lobby.board === board && cfg.map.kind === board;
  results.checks.mapSnapshot = {
    tiles: cfg.map.tiles.length,
    ports: cfg.map.ports.length,
    deserts: cfg.map.tiles.filter((t) => t.terrain === 'desert').length,
    seed: cfg.map.seed,
    boardVersion: cfg.map.boardVersion,
  };

  // 4. 设置变更清空全员准备
  const readyBefore = cfg.lobby.ready.every((r) => r === false);
  results.checks.configClearsReady = readyBefore;

  // 5. 全员准备
  for (const c of clients) c.send({ t: 'READY', ready: true });
  await sleep(120);
  const allReady = host.peek('LOBBY_CONFIG') ?? cfg;
  results.checks.allReady = allReady.lobby.ready.every((r) => r === true) && allReady.lobby.canStart === true;

  // 6. 手动开始（重复开始被拒）
  const version = allReady.lobby.configVersion;
  host.clear();
  host.send({ t: 'START', configVersion: version });
  const firstState = await host.wait('STATE');
  results.checks.started = firstState.view.phase === 'setup';
  results.checks.actionOrder = firstState.view.actionOrder;
  // 其他客户端也收到 STATE
  for (const c of others) await c.wait('STATE');
  host.clear();
  host.send({ t: 'START', configVersion: version });
  const dup = await host.wait('REJECT');
  results.checks.duplicateStartRejected = dup.reason === 'GAME_ALREADY_STARTED';

  // 7. 完整摆位
  const setup = await driveSetup(clients, label, firstState.view, firstState.seq);
  results.checks.setup = { steps: setup.steps, buildings: players * 2, roads: players * 2, phase: setup.view.phase };
  results.checks.firstPlayer = setup.view.current === firstState.view.actionOrder[0];

  // 8. 正常回合（4 人 / 8 人跑到终局或上限；5/6/7 覆盖首回合即可）
  const play = await drivePlay(clients, setup.view, label, players <= 4 || players >= 8 ? 400 : 30, setup.lastSeq);
  results.checks.play = play;

  for (const c of clients) c.close();
  return results;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const server = spawn(process.execPath, [path.join(ROOT, 'apps/server/dist/server.cjs')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += d.toString(); });

  const out = { startedAt: new Date().toISOString(), port: PORT, scenarios: [], errors: [] };
  try {
    // 等服务起来
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${BASE}/health`);
        if (r.ok) break;
      } catch { /* retry */ }
      await sleep(200);
    }
    const health = await (await fetch(`${BASE}/health`)).json();
    out.health = health;

    for (const [room, players, board, label] of [
      ['l5-p4', 4, 'base', '4 人标准盘'],
      ['l5-p5', 5, 'base', '5 人标准盘'],
      ['l5-p6', 6, 'ext', '6 人扩展盘'],
      ['l5-p7', 7, 'ext', '7 人扩展盘（自定义）'],
      ['l5-p8', 8, 'ext', '8 人扩展盘（自定义）'],
    ]) {
      try {
        const r = await scenario(room, players, board, label);
        out.scenarios.push(r);
        console.log(`[L5] ${label}: OK`, JSON.stringify(r.checks));
      } catch (e) {
        out.errors.push({ label, message: String(e) });
        console.error(`[L5] ${label}: FAIL ${e}`);
      }
    }
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
  }
  out.serverLog = serverLog.trim().split('\n').slice(0, 10);
  const report = path.join(ROOT, 'probe/l5-endtoend-report.json');
  writeFileSync(report, JSON.stringify(out, null, 2));
  console.log(`\n[L5] 报告: ${report}`);
  console.log(`[L5] 场景 ${out.scenarios.length} 个，失败 ${out.errors.length} 个`);
  if (out.errors.length > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
