/**
 * 陪玩 bot —— 单人测试 UI / 完整对局体验用。
 *
 * 只走协议命令（join → command），不碰服务端内存，与服务端权威铁律一致；
 * 所有候选位推导只是「提示」，最终合法性由引擎裁决，REJECT 时退避兜底。
 *
 * 用法（在 apps/server 下）：
 *   npx tsx scripts/bot.ts <ws url> [名字] [--host] [--fast] [--players N]
 *
 * 例：
 *   # 4 个 bot 自动对打（文档 23 v3 协议，全员 READY 后 --host 负责开始）
 *   npx tsx scripts/bot.ts "ws://127.0.0.1:8787/ws?sharecode=DEV&room=botfight" 甲 --host --players 4
 *   npx tsx scripts/bot.ts "ws://127.0.0.1:8787/ws?sharecode=DEV&room=botfight" 乙 --players 4
 *   npx tsx scripts/bot.ts "ws://127.0.0.1:8787/ws?sharecode=DEV&room=botfight" 丙 --players 4
 *   npx tsx scripts/bot.ts "ws://127.0.0.1:8787/ws?sharecode=DEV&room=botfight" 丁 --players 4
 *
 * 行为：自动摆位 → 轮到就掷骰 → 掷 7 弃牌/移强盗 → 资源够就建（城>村>路）→ 结束回合。
 * 默认每步随机延迟 0.7-1.6s 模拟思考；--fast 缩短到 0.15-0.4s（自动化冒烟用）。
 *
 * 文档 23 v3 适配：
 * - JOIN 带 players（4–8），创建者设定房间人数；地图按人数推荐标准盘/扩展盘。
 * - 几何按 WELCOME.map.rows 动态重建（随机地图与 30 格扩展盘不再是固定 19 格）。
 * - 全员 READY 后由 --host 带 configVersion 发 START（取消满员自动开局）。
 */

import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '@hexfront/protocol';
import {
  RESOURCES,
  MAP_4P,
  buildBoard,
  buildGeometry,
  type Geometry,
  type PlayerView,
  type ResourceCount,
  type Resource,
} from '@hexfront/engine';

type Msg = Record<string, unknown> & { t: string };

/** 几何随地图变化：初始 19 格，收到 WELCOME/STATE 后按实际 rows 重建 */
let geo: Geometry = buildBoard(MAP_4P).geo;

/** 从地块 key 反推每行格数，再重建与引擎完全一致的几何 */
function geoFromTileKeys(keys: readonly string[]): Geometry {
  const counts = new Map<number, number>();
  let maxRow = -1;
  for (const k of keys) {
    const m = /^(-?\d+),(-?\d+)$/.exec(k);
    if (!m) return geo;
    const row = Number(m[2]);
    counts.set(row, (counts.get(row) ?? 0) + 1);
    if (row > maxRow) maxRow = row;
  }
  const rows: number[] = [];
  for (let r = 0; r <= maxRow; r++) {
    const c = counts.get(r);
    if (!c) return geo;
    rows.push(c);
  }
  return buildGeometry(rows);
}

const rand = (min: number, max: number): number => min + Math.random() * (max - min);
const pick = <T,>(arr: T[]): T | undefined => arr[Math.floor(Math.random() * arr.length)];
const short = (key: string): string => key.replace(/^-?\d+\.?\d*,/, '').slice(0, 6);

// ---------------------------------------------------------------------------
// WS 客户端：与 seed-room.ts 同构（inbox + 谓词等待），独立一份避免脚本互相牵连。
// ---------------------------------------------------------------------------

class Client {
  private ws: WebSocket;
  private inbox: Msg[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void; reject: (e: Error) => void }[] = [];

  onState?: (view: PlayerView, seq: number) => void;
  onReject?: (msg: Msg) => void;
  onClose?: () => void;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Msg;
      if (msg.t === 'STATE') {
        const s = msg as unknown as { view: PlayerView; seq: number };
        this.onState?.(s.view, s.seq);
      } else if (msg.t === 'REJECT') {
        this.onReject?.(msg);
      }
      const idx = this.waiters.findIndex((w) => w.pred(msg));
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        w!.resolve(msg);
      } else {
        this.inbox.push(msg);
      }
    });
    this.ws.on('error', (err) => {
      for (const w of this.waiters.splice(0)) w.reject(err as Error);
    });
    this.ws.on('close', () => this.onClose?.());
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  next(pred: (m: Msg) => boolean, timeoutMs = 6000): Promise<Msg> {
    const hit = this.inbox.findIndex(pred);
    if (hit >= 0) {
      const [msg] = this.inbox.splice(hit, 1);
      return Promise.resolve(msg!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === resolve);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('等待消息超时'));
      }, timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }
}

// ---------------------------------------------------------------------------
// 候选位推导（与前端 placement.ts / build.ts 同构；一致性由两边的单测钉死）
// ---------------------------------------------------------------------------

/** 掷骰组合数权重（sum=2..12），6/8 最肥 */
const PIPS: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

/** 顶点的产出期望：邻接地块的数字权重求和 */
function spotScore(view: PlayerView, vk: string): number {
  return geo.vertices[vk]!.tiles.reduce((sum, tk) => {
    const t = view.tiles.find((x) => x.key === tk);
    return sum + (t && t.number ? PIPS[t.number] ?? 0 : 0);
  }, 0);
}

/**
 * 摆位候选：距离规则内合法的村点 + 空邻边。
 * 村点按产出期望降序（带小随机扰动避免每局一模一样），
 * 路选「另一端产出期望最高」的空边 —— 朝好地方扩张。
 */
function candidateSetupSpots(view: PlayerView): { vertex: string; edge: string; score: number }[] {
  const out: { vertex: string; edge: string; score: number }[] = [];
  for (const vk of geo.vertexKeys) {
    if (view.buildings[vk]) continue;
    if (geo.vertices[vk]!.neighbors.some((n) => view.buildings[n])) continue;
    let bestEdge: string | null = null;
    let bestEdgeScore = -1;
    for (const ek of geo.vertices[vk]!.edges) {
      if (view.roads[ek] !== undefined) continue;
      const e = geo.edges[ek]!;
      const other = e.a === vk ? e.b : e.a;
      const score = spotScore(view, other) + Math.random() * 0.5;
      if (score > bestEdgeScore) {
        bestEdgeScore = score;
        bestEdge = ek;
      }
    }
    if (bestEdge === null) continue;
    out.push({ vertex: vk, edge: bestEdge, score: spotScore(view, vk) + Math.random() * 0.5 });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** play 阶段建村：空顶点 + 距离规则 + 挨着自己的路，按产出期望降序 */
function candidateVillages(view: PlayerView): string[] {
  const roadEnds = new Set<string>();
  for (const [ek, owner] of Object.entries(view.roads)) {
    if (owner !== view.me.index) continue;
    const e = geo.edges[ek]!;
    roadEnds.add(e.a);
    roadEnds.add(e.b);
  }
  const out: string[] = [];
  for (const vk of roadEnds) {
    if (view.buildings[vk]) continue;
    if (geo.vertices[vk]!.neighbors.some((n) => view.buildings[n])) continue;
    out.push(vk);
  }
  return out.sort((a, b) => spotScore(view, b) - spotScore(view, a));
}

/** 自己的未升级村庄 */
function candidateCity(view: PlayerView): string | null {
  for (const [vk, b] of Object.entries(view.buildings)) {
    if (b.owner === view.me.index && !b.city) return vk;
  }
  return null;
}

/** 铺路候选：空边且至少一端连着我方建筑/道路，朝高产出端优先 */
function candidateRoads(view: PlayerView): string[] {
  const mine = new Set<string>();
  for (const [vk, b] of Object.entries(view.buildings)) {
    if (b.owner === view.me.index) mine.add(vk);
  }
  for (const [ek, owner] of Object.entries(view.roads)) {
    if (owner !== view.me.index) continue;
    const e = geo.edges[ek]!;
    mine.add(e.a);
    mine.add(e.b);
  }
  const out: string[] = [];
  for (const ek of geo.edgeKeys) {
    if (view.roads[ek] !== undefined) continue;
    const e = geo.edges[ek]!;
    if (mine.has(e.a) || mine.has(e.b)) out.push(ek);
  }
  return out.sort((a, b) => {
    const end = (ek: string): number => {
      const e = geo.edges[ek]!;
      return Math.max(mine.has(e.a) ? -1 : spotScore(view, e.a), mine.has(e.b) ? -1 : spotScore(view, e.b));
    };
    return end(b) - end(a);
  });
}

/** 弃牌：把手牌按持有量降序贪心凑齐（V-9 向上取整后的张数由服务端给定） */
function chooseDiscard(res: ResourceCount, count: number): Partial<ResourceCount> {
  const flat = RESOURCES.map((r) => ({ r, n: res[r] })).sort((a, b) => b.n - a.n);
  const out: Partial<ResourceCount> = {};
  let left = count;
  for (const { r, n } of flat) {
    if (left <= 0) break;
    const take = Math.min(n, left);
    if (take > 0) {
      out[r] = take;
      left -= take;
    }
  }
  return out;
}

/** 掷 7 挪强盗：随机挑一块非当前强盗地块，上面有对手建筑就顺手偷 */
function pickRobberTarget(view: PlayerView): { tile: string; stealFrom?: number } {
  const options = view.tiles.filter((t) => !t.hasRobber);
  const tile = pick(options) ?? options[0]!;
  const victims = new Set<number>();
  for (const [vk, b] of Object.entries(view.buildings)) {
    if (b.owner !== view.me.index && geo.vertices[vk]!.tiles.includes(tile.key)) victims.add(b.owner);
  }
  const arr = [...victims];
  return { tile: tile.key, stealFrom: arr.length > 0 ? pick(arr) : undefined };
}

const canAfford = (res: ResourceCount, need: Partial<ResourceCount>): boolean =>
  RESOURCES.every((r) => res[r] >= (need[r] ?? 0));

// ---------------------------------------------------------------------------
// bot 主逻辑
// ---------------------------------------------------------------------------

function roomIdFromUrl(url: string): string {
  try {
    return new URL(url).searchParams.get('room') ?? 'main';
  } catch {
    return 'main';
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const url = args[0];
  const name = args.find((a, i) => i > 0 && !a.startsWith('--')) ?? '机器人';
  const host = args.includes('--host');
  const fast = args.includes('--fast');
  const turbo = args.includes('--turbo');
  const playersArg = args.find((a) => a.startsWith('--players='));
  const players = playersArg ? Math.max(4, Math.min(8, Number(playersArg.split('=')[1]) || 4)) : 4;
  // --turbo：验收脚本用，去掉思考延迟以在有限时间内真正打到 10 分终局
  const thinkDelay = () => (turbo ? 0 : fast ? rand(150, 400) : rand(700, 1600));

  if (!url) {
    console.error('用法: npx tsx scripts/bot.ts <ws url> [名字] [--host] [--fast] [--turbo] [--players N]');
    process.exit(1);
  }

  const client = new Client(url);
  await client.open();
  // 文档 23 L-0 E：创建者（--host）在 JOIN 时设定人数上限 4–8
  client.send({
    t: 'JOIN', roomId: roomIdFromUrl(url), name, v: PROTOCOL_VERSION,
    ...(host ? { players } : {}),
  });

  const welcome = await client.next((m) => m.t === 'WELCOME' || m.t === 'JOIN_FAILED');
  if (welcome.t === 'JOIN_FAILED') {
    console.error(`[bot] 进房失败: ${welcome.reason}`);
    process.exit(1);
  }
  const seat = welcome.seat as number;
  // 动态几何：地图是服务端受约束随机生成的，可能是 19 格标准盘或 30 格扩展盘
  const map = welcome.map as { rows?: number[]; tiles?: { key: string }[] } | null | undefined;
  if (map?.rows) geo = buildGeometry(map.rows);
  else if (map?.tiles) geo = geoFromTileKeys(map.tiles.map((t) => t.key));
  console.log(`[bot] 「${name}」入座 ${seat}，地图 ${geo.tileKeys.length} 格，等待开局…`);

  // 文档 23 L-1：全员准备后由房主手动开始，取消满员自动开局
  client.send({ t: 'READY', ready: true });

  if (host) {
    // 等所有人都入座且准备完成（LOBBY_CONFIG 带 canStart / configVersion）
    for (;;) {
      const cfg = await client.next(
        (m) => m.t === 'LOBBY_CONFIG' || m.t === 'LOBBY',
        30000,
      );
      const lobbyCfg = cfg.lobby as { canStart?: boolean; configVersion?: number; targetPlayers?: number } | undefined;
      if (lobbyCfg?.canStart) {
        client.send({ t: 'START', configVersion: lobbyCfg.configVersion });
        console.log(`[bot] 全员准备（目标 ${lobbyCfg.targetPlayers} 人），已发 START v${lobbyCfg.configVersion}`);
        break;
      }
    }
  }

  let latest: PlayerView | null = null;
  let lastSeq = -1;
  let thinkTimer: ReturnType<typeof setTimeout> | null = null;
  let rejectStreak = 0;
  let robberMovedTurn = -1;

  const say = (action: string): void => {
    const turn = latest ? `回合 ${latest.turn}` : '';
    console.log(`[bot] ${turn} ${action}`);
  };

  const scheduleThink = (): void => {
    if (thinkTimer) clearTimeout(thinkTimer);
    thinkTimer = setTimeout(think, thinkDelay());
  };

  const command = (cmd: Record<string, unknown>): void => {
    client.send({ t: 'COMMAND', cmd: { seat, ...cmd } });
  };

  /** 按当前视图推导并执行下一个动作。每帧最多一个动作，服务端广播后进入下一帧。 */
  function think(): void {
    const view = latest;
    if (!view) return;

    if (view.phase === 'ended') {
      const place = view.scores.indexOf(Math.max(...view.scores));
      console.log(
        `[bot] 对局结束：胜者 ${place} 号「${view.players[place]?.name ?? '?'}」，比分 ${view.scores.join(':')}。我 ${view.me.index} 号。`,
      );
      process.exit(0);
    }

    // 弃牌锁：我欠牌先弃；别人欠牌全场等待
    const owing = view.pendingDiscards.find((p) => p.player === view.me.index);
    if (owing) {
      const handSize = RESOURCES.reduce((s, r) => s + view.me.resources[r], 0);
      if (handSize === 0) return; // 理论不该发生，防呆
      command({ type: 'DISCARD', resources: chooseDiscard(view.me.resources, owing.count) });
      say(`弃牌 ${owing.count} 张`);
      return;
    }
    if (view.pendingDiscards.length > 0) return;

    if (view.phase === 'setup') {
      if (!view.setup || view.setup.seat !== seat) return; // 等别人摆
      const spot = candidateSetupSpots(view)[0]; // 已按产出期望降序
      if (!spot) {
        console.error('[bot] 找不到合法摆位点（推导与服务端不一致）');
        process.exit(1);
      }
      command({ type: 'PLACE_SETTLEMENT', vertex: spot.vertex, edge: spot.edge });
      say(`摆位 ${view.setup.step + 1}: 村+路`);
      return;
    }

    if (view.phase !== 'play' || view.current !== seat) return;

    if (!view.hasRolled) {
      command({ type: 'ROLL_DICE' });
      say('掷骰子');
      return;
    }

    // 掷 7：全场弃牌清空后挪强盗（每回合最多一次）
    if (view.dice && view.dice[0] + view.dice[1] === 7 && robberMovedTurn !== view.turn) {
      const target = pickRobberTarget(view);
      robberMovedTurn = view.turn;
      command({ type: 'MOVE_ROBBER', tile: target.tile, ...(target.stealFrom !== undefined ? { stealFrom: target.stealFrom } : {}) });
      say(`掷出 7，强盗 → ${short(target.tile)}${target.stealFrom !== undefined ? `，偷 ${target.stealFrom} 号` : ''}`);
      return;
    }

    // 建造优先级：城 > 村 > 路（资源够就建，测试覆盖更全）
    const res = view.me.resources;
    if (process.argv.includes('--debug')) {
      const hand = RESOURCES.map((r) => `${r}=${res[r]}`).join(' ');
      console.log(`[bot:debug] 回合 ${view.turn} 手牌: ${hand} | 候选 村${candidateVillages(view).length} 路${candidateRoads(view).length}`);
    }

    // 文档 23 §3：验收脚本常「先花木砖修路、迟迟凑不齐村庄成本」，这是脚本策略问题，
    // 不是资源发放 bug。这里补银行 4:1 兑换：把过剩资源换成当前最缺的关键资源，
    // 让 bot 能稳定凑齐村庄/城市成本，真正把一局打到 10 分终局。
    // 港口 2:1 由服务端按视图裁决，bot 不自行推断比例，统一走 4:1 银行。
    const bankExchange = (): boolean => {
      // 目标成本：优先城市（2 分），其次村庄（1 分 + 扩张）
      const goals: Partial<ResourceCount>[] = [
        { wood: 1, brick: 1, sheep: 1, wheat: 1 },  // 村庄优先（扩张）
        { ore: 3, wheat: 2 },                        // 其次城市（2 分）
      ];
      for (const goal of goals) {
        const missing = RESOURCES.filter((r) => (res[r] ?? 0) < (goal[r] ?? 0));
        if (missing.length === 0) continue;
        const want = missing[0]!;
        // 找一种持有 ≥4 的资源做 4:1 兑换；不要求换出后仍满足目标，
        // 因为下一轮还能继续攒（bot 每回合只做一个动作，天然限速）。
        const spare = RESOURCES.find((r) => r !== want && (res[r] ?? 0) >= 4);
        if (spare) {
          command({ type: 'TRADE_BANK', give: spare, get: want });
          say(`银行兑换 ${spare}×4 → ${want}`);
          return true;
        }
      }
      return false;
    };

    if (canAfford(res, { ore: 3, wheat: 2 })) {
      const vk = candidateCity(view);
      if (vk) {
        command({ type: 'BUILD_CITY', vertex: vk });
        say(`升级城市 @${short(vk)}`);
        return;
      }
    }
    if (canAfford(res, { wood: 1, brick: 1, sheep: 1, wheat: 1 })) {
      const vk = pick(candidateVillages(view));
      if (vk) {
        command({ type: 'BUILD_SETTLEMENT', vertex: vk });
        say(`建村庄 @${short(vk)}`);
        return;
      }
    }
    // 凑不齐建筑成本时先尝试银行兑换（4:1），把过剩资源换成缺的关键资源。
    // 放在铺路之前，避免「先花木砖修路、迟迟凑不齐村庄成本」的脚本策略缺陷
    // （文档 23 §3 明确指出这不能判定为资源发放 bug）。
    if (bankExchange()) return;

    // 铺路扩张：为将来的村庄创造候选顶点。不加「当前已有村庄目标」的限制，
    // 否则初始 2 条路用完后 candidateVillages 永远为空，对局会死锁。
    if (canAfford(res, { wood: 1, brick: 1 })) {
      const ek = pick(candidateRoads(view));
      if (ek) {
        command({ type: 'BUILD_ROAD', edge: ek });
        say(`铺路 @${short(ek)}`);
        return;
      }
    }

    // 发展卡：胜利点也是得分途径；牌堆非空且买得起就买
    if (view.devDeckCount > 0 && canAfford(res, { sheep: 1, wheat: 1, ore: 1 })) {
      command({ type: 'BUY_DEV_CARD' });
      say('买发展卡');
      return;
    }

    command({ type: 'END_TURN' });
    say('结束回合');
  }

  /** 连续被拒的兜底：强制推进，绝不让对局卡死在 bot 手里 */
  function forceFallback(): void {
    const view = latest;
    rejectStreak = 0;
    if (!view) return;
    if (view.phase === 'play' && view.current === seat) {
      if (!view.hasRolled) command({ type: 'ROLL_DICE' });
      else command({ type: 'END_TURN' });
      say('连续被拒，走保底流程');
    }
  }

  client.onState = (view, seq) => {
    if (seq <= lastSeq) return; // 广播有先后，严格按 seq 递增处理（T4 教训）
    lastSeq = seq;
    latest = view;
    rejectStreak = 0;
    scheduleThink();
  };

  client.onReject = (msg) => {
    rejectStreak += 1;
    say(`REJECT: ${msg.reason}${msg.detail ? ` (${msg.detail})` : ''}`);
    if (rejectStreak >= 3) forceFallback();
    else scheduleThink();
  };

  client.onClose = () => {
    console.log('[bot] 连接已关闭，退出');
    process.exit(0);
  };
}

main().catch((err: unknown) => {
  console.error('[bot] 异常退出:', err instanceof Error ? err.message : err);
  process.exit(1);
});
