/**
 * 陪玩 bot —— 单人测试 UI / 完整对局体验用。
 *
 * 只走协议命令（join → command），不碰服务端内存，与服务端权威铁律一致；
 * 所有候选位推导只是「提示」，最终合法性由引擎裁决，REJECT 时退避兜底。
 *
 * 用法（在 apps/server 下）：
 *   npx tsx scripts/bot.ts <ws url> [名字] [--host] [--fast]
 *
 * 例：
 *   # 陪你在已完成对局的线上房间打（你先进房，bot 后进）
 *   npx tsx scripts/bot.ts "wss://hexfront.app.workbuddy.host/ws?sharecode=XXX&room=abc" 机器人
 *
 *   # 两个 bot 自动对打（本机冒烟，--host 的那个负责开局）
 *   npx tsx scripts/bot.ts "ws://127.0.0.1:8787/ws?sharecode=DEV&room=botfight" 甲 --host
 *   npx tsx scripts/bot.ts "ws://127.0.0.1:8787/ws?sharecode=DEV&room=botfight" 乙
 *
 * 行为：自动摆位 → 轮到就掷骰 → 掷 7 弃牌/移强盗 → 资源够就建（城>村>路）→ 结束回合。
 * 默认每步随机延迟 0.7-1.6s 模拟思考；--fast 缩短到 0.15-0.4s（自动化冒烟用）。
 */

import WebSocket from 'ws';
import {
  RESOURCES,
  MAP_4P,
  buildBoard,
  type PlayerView,
  type ResourceCount,
  type Resource,
} from '@hexfront/engine';

type Msg = Record<string, unknown> & { t: string };

const geo = buildBoard(MAP_4P).geo;

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
  const thinkDelay = () => (fast ? rand(150, 400) : rand(700, 1600));

  if (!url) {
    console.error('用法: npx tsx scripts/bot.ts <ws url> [名字] [--host] [--fast]');
    process.exit(1);
  }

  const client = new Client(url);
  await client.open();
  client.send({ t: 'JOIN', roomId: roomIdFromUrl(url), name });

  const welcome = await client.next((m) => m.t === 'WELCOME' || m.t === 'JOIN_FAILED');
  if (welcome.t === 'JOIN_FAILED') {
    console.error(`[bot] 进房失败: ${welcome.reason}`);
    process.exit(1);
  }
  const seat = welcome.seat as number;
  console.log(`[bot] 「${name}」入座 ${seat}，等待开局…`);

  if (host) {
    // LOBBY 在每次有人入座时广播；第一条往往是自己刚入座的 1 人房，循环等到 ≥2 人
    for (;;) {
      const lobby = await client.next((m) => m.t === 'LOBBY', 15000);
      if ((lobby.players as unknown[]).length >= 2) break;
    }
    client.send({ t: 'START' });
    console.log('[bot] 2 人在座，已发 START');
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
    if (canAfford(res, { wood: 1, brick: 1 })) {
      const ek = pick(candidateRoads(view));
      if (ek) {
        command({ type: 'BUILD_ROAD', edge: ek });
        say(`铺路 @${short(ek)}`);
        return;
      }
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
